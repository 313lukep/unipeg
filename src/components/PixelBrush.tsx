"use client";

/**
 * PixelBrush — the per-pixel highlight overlay. The other half of the sticker
 * selection: where CropBox drags a rectangle, this paints the exact 24×24
 * cells that belong in the sticker (rescue a stray tail pixel, keep a horn
 * accessory the box cannot isolate).
 *
 * Contract: the mask is a ReadonlySet of `${x},${y}` keys in WHOLE-GRID cell
 * coordinates. All maths lives in pixelBrushMath.ts and is integer-only —
 * pointer offsets are floored into cells exactly once, and out-of-bounds
 * cells are dropped rather than clamped onto the border row.
 *
 * Painting rule (standard and forgiving): the stroke's action is decided by
 * the cell the pointer went DOWN on — started on an unselected cell and the
 * whole drag paints; started on a selected cell and the whole drag erases.
 * Successive pointer samples are joined with Bresenham, so a fast swipe never
 * leaves gaps. `touch-action: none` on the layer means painting can never
 * scroll or pan the page.
 *
 * Visuals are one canvas, drawn from the mask (smoothing off after every
 * resize, all rects on rounded device-pixel boundaries — zero antialiasing):
 *   - a --ink scrim at 55% over every UNMASKED cell, so the kept silhouette
 *     reads instantly and the masked art stays fully clear,
 *   - a crisp 2px --accent outline along the OUTER BOUNDARY of the masked
 *     region (per-cell edge segments; interior borders draw nothing), laid
 *     on the scrim side of the boundary so it never covers the art,
 *   - a paper/ink keyboard cursor ring, visible only while focused.
 *
 * Keyboard parity with CropBox: arrows move the cell cursor, Space/Enter
 * toggles it, Escape blurs; the selected-cell count is announced politely.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyStrokeInto,
  cellAt,
  cellKey,
  inBounds,
  lineCells,
  maskEdges,
  type Cell,
  type StrokeAction,
} from "@/components/pixelBrushMath";

export type PixelBrushProps = {
  mask: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  /** device-independent pixels per cell at current render size */
  cellPx: number;
  gridW: number;
  gridH: number;
  /**
   * Forced stroke action from the panel's BRUSH / ERASER buttons. When set,
   * every stroke does this regardless of the cell it started on (owner:
   * an explicit eraser is clearer on touch than the start-cell heuristic).
   */
  forceAction?: "paint" | "erase";
};

/** --ink scrim strength over unmasked cells. */
const SCRIM_ALPHA = 0.55;
/** outline thickness in device-independent pixels */
const OUTLINE_PX = 2;

/**
 * Read a CSS custom property off the live layer and hand back something
 * canvas can definitely paint. --accent is an oklch() expression; every
 * engine we target parses it, but if an assignment is rejected the canvas
 * silently keeps its old fillStyle — so probe with a sentinel and fall back.
 */
function paintable(
  ctx: CanvasRenderingContext2D,
  colour: string,
  fallback: string,
): string {
  const c = colour.trim();
  if (c === "") return fallback;
  const sentinel = "#123456";
  ctx.fillStyle = sentinel;
  ctx.fillStyle = c;
  const applied = ctx.fillStyle;
  return typeof applied === "string" && applied.toLowerCase() === sentinel
    ? fallback
    : c;
}

/**
 * Place a band of thickness t against a cell boundary, on the OUTSIDE of the
 * masked region, nudged inward when the outside would fall off the canvas
 * (grid-border edges stay fully visible instead of half-clipping).
 */
function band(edge: number, t: number, limit: number, outsideIsBefore: boolean): number {
  let a = outsideIsBefore ? edge - t : edge;
  if (a < 0) a = 0;
  if (a + t > limit) a = Math.max(0, limit - t);
  return a;
}

export default function PixelBrush({
  mask,
  onChange,
  cellPx,
  gridW,
  gridH,
  forceAction,
}: PixelBrushProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // dpr only feeds effect-driven canvas sizing — lazy init is SSR-safe.
  const [dpr] = useState(() =>
    typeof window === "undefined"
      ? 1
      : Math.max(1, Math.min(3, window.devicePixelRatio || 1)),
  );

  const [focused, setFocused] = useState(false);
  const [cursor, setCursor] = useState<Cell>(() => ({
    x: Math.floor(gridW / 2),
    y: Math.floor(gridH / 2),
  }));

  // Latest mask / cursor without re-binding handlers mid-drag (and so the
  // keyboard toggle never runs inside a state updater, which StrictMode
  // would double-invoke).
  const maskRef = useRef(mask);
  useEffect(() => {
    maskRef.current = mask;
  }, [mask]);
  const cursorRef = useRef(cursor);
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  // Theme + piece retint change --ink/--accent on <html>; redraw when they do.
  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const mo = new MutationObserver(() => setThemeTick((n) => n + 1));
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style", "class"],
    });
    return () => mo.disconnect();
  }, []);

  // ---- the canvas ---------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const layer = layerRef.current;
    if (!canvas || !layer || cellPx <= 0) return;

    const w = Math.max(1, Math.round(gridW * cellPx * dpr));
    const h = Math.max(1, Math.round(gridH * cellPx * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Resizing resets context state — smoothing off before any draw, always.
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, w, h);

    const cs = getComputedStyle(layer);
    const ink = paintable(ctx, cs.getPropertyValue("--ink"), "#0b0b0d");
    const paper = paintable(ctx, cs.getPropertyValue("--paper"), "#ffffff");
    const accent = paintable(
      ctx,
      cs.getPropertyValue("--accent"),
      paintable(ctx, cs.getPropertyValue("--pink"), "#d8006e"),
    );

    // Cell boundaries rounded to whole device pixels: every rect below lands
    // on an integer edge, so nothing can antialias.
    const bx = (i: number) => Math.round(i * cellPx * dpr);

    // 1. scrim over everything NOT kept
    ctx.globalAlpha = SCRIM_ALPHA;
    ctx.fillStyle = ink;
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        if (mask.has(cellKey(x, y))) continue;
        ctx.fillRect(bx(x), bx(y), bx(x + 1) - bx(x), bx(y + 1) - bx(y));
      }
    }
    ctx.globalAlpha = 1;

    // 2. outer boundary of the kept region, per-cell edge segments
    const t = Math.max(1, Math.round(OUTLINE_PX * dpr));
    ctx.fillStyle = accent;
    for (const e of maskEdges(mask, gridW, gridH)) {
      const x0 = bx(e.x);
      const x1 = bx(e.x + 1);
      const y0 = bx(e.y);
      const y1 = bx(e.y + 1);
      if (e.side === "top") {
        ctx.fillRect(x0, band(y0, t, h, true), x1 - x0, t);
      } else if (e.side === "bottom") {
        ctx.fillRect(x0, band(y1, t, h, false), x1 - x0, t);
      } else if (e.side === "left") {
        ctx.fillRect(band(x0, t, w, true), y0, t, y1 - y0);
      } else {
        ctx.fillRect(band(x1, t, w, false), y0, t, y1 - y0);
      }
    }

    // 3. keyboard cursor: paper ring outside, ink ring inside — legible on
    //    the scrim and on bare art, in both themes.
    if (focused && inBounds(cursor, gridW, gridH)) {
      const x0 = bx(cursor.x);
      const y0 = bx(cursor.y);
      const cw = bx(cursor.x + 1) - x0;
      const ch = bx(cursor.y + 1) - y0;
      const ring = (colour: string, inset: number, thick: number) => {
        ctx.fillStyle = colour;
        ctx.fillRect(x0 + inset, y0 + inset, cw - 2 * inset, thick);
        ctx.fillRect(x0 + inset, y0 + ch - inset - thick, cw - 2 * inset, thick);
        ctx.fillRect(x0 + inset, y0 + inset, thick, ch - 2 * inset);
        ctx.fillRect(x0 + cw - inset - thick, y0 + inset, thick, ch - 2 * inset);
      };
      ring(paper, 0, t);
      ring(ink, t, t);
    }
  }, [mask, cellPx, gridW, gridH, dpr, focused, cursor, themeTick]);

  // ---- painting -----------------------------------------------------------
  const dragRef = useRef<{
    pointerId: number;
    action: StrokeAction;
    last: Cell;
    work: Set<string>;
  } | null>(null);

  const cellFromEvent = useCallback(
    (e: React.PointerEvent): Cell | null => {
      const el = layerRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return cellAt(e.clientX - r.left, e.clientY - r.top, cellPx);
    },
    [cellPx],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const cell = cellFromEvent(e);
      if (cell === null || !inBounds(cell, gridW, gridH)) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      // Explicit BRUSH/ERASER wins; otherwise the stroke's action comes
      // from the cell it STARTED on.
      const action: StrokeAction =
        forceAction ??
        (maskRef.current.has(cellKey(cell.x, cell.y)) ? "erase" : "paint");
      const work = new Set(maskRef.current);
      const changed = applyStrokeInto(work, [cell], action, gridW, gridH);
      dragRef.current = { pointerId: e.pointerId, action, last: cell, work };
      setCursor(cell);
      if (changed) onChange(new Set(work));
    },
    [cellFromEvent, gridW, gridH, onChange, forceAction],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const cell = cellFromEvent(e);
      if (cell === null) return;
      if (cell.x === drag.last.x && cell.y === drag.last.y) return;
      e.preventDefault();
      // Interpolate: a fast swipe must not skip the cells between samples.
      const changed = applyStrokeInto(
        drag.work,
        lineCells(drag.last, cell),
        drag.action,
        gridW,
        gridH,
      );
      drag.last = cell;
      if (inBounds(cell, gridW, gridH)) setCursor(cell);
      if (changed) onChange(new Set(drag.work));
    },
    [cellFromEvent, gridW, gridH, onChange],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    const el = e.currentTarget;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }, []);

  // ---- keyboard -----------------------------------------------------------
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.currentTarget.blur();
        return;
      }
      if (e.key === " " || e.key === "Enter" || e.key === "Spacebar") {
        e.preventDefault();
        const c = cursorRef.current;
        if (!inBounds(c, gridW, gridH)) return;
        const next = new Set(maskRef.current);
        const k = cellKey(c.x, c.y);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        onChange(next);
        return;
      }
      let dx = 0;
      let dy = 0;
      if (e.key === "ArrowLeft") dx = -1;
      else if (e.key === "ArrowRight") dx = 1;
      else if (e.key === "ArrowUp") dy = -1;
      else if (e.key === "ArrowDown") dy = 1;
      else return;
      e.preventDefault();
      setCursor((c) => ({
        x: Math.max(0, Math.min(gridW - 1, c.x + dx)),
        y: Math.max(0, Math.min(gridH - 1, c.y + dy)),
      }));
    },
    [gridW, gridH, onChange],
  );

  const px = (cells: number) => cells * cellPx;
  const count = mask.size;

  return (
    <div
      ref={layerRef}
      role="group"
      tabIndex={0}
      aria-label={
        "Highlight brush: paint the pixels kept in the sticker. " +
        "Drag from an unselected pixel to paint, from a selected pixel to erase. " +
        "Arrow keys move the cell cursor, space toggles it, escape leaves."
      }
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      className="u-brush-layer absolute left-0 top-0"
      style={{ width: px(gridW), height: px(gridH) }}
      data-testid="pixel-brush"
      data-mask-count={count}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full [image-rendering:pixelated]"
      />
      <span className="u-sr-only" aria-live="polite">
        {count} {count === 1 ? "pixel" : "pixels"} selected
      </span>
    </div>
  );
}
