"use client";

/**
 * CropBox — draggable + resizable selection rectangle SNAPPED to whole cells.
 * There is no sub-cell position, ever: pointer deltas are divided by cellPx
 * and rounded, so the box clicks from cell to cell like a physical detent.
 *
 * - Pointer events (mouse + touch unified) with setPointerCapture.
 * - 8 handles (4 corners + 4 edges), each with a >= 44px hit area; the
 *   visible marker is smaller.
 * - Keyboard: arrows move 1 cell, shift+arrows resize 1 cell, Escape blurs.
 * - Accent 2px border, dim scrim outside the selection (paper fade, so it
 *   works in both themes).
 *
 * The component renders absolutely positioned inside a relatively positioned
 * parent that is exactly gridW*cellPx by gridH*cellPx.
 */

import { useCallback, useEffect, useRef } from "react";
import type { CellRect } from "@/lib/grid";

export type CropBoxProps = {
  rect: CellRect;
  onChange: (r: CellRect) => void;
  /** device-independent pixels per cell at current render size */
  cellPx: number;
  gridW: number;
  gridH: number;
  /** minimum selection width/height in cells (default 3) */
  minSize?: number;
};

type DragMode = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const HIT = 44; // px hit-slop per handle, mouse and thumb alike

const HANDLE_CURSOR: Record<Exclude<DragMode, "move">, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

function sameRect(a: CellRect, b: CellRect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Apply an integer cell delta for a drag mode, then clamp to grid + minSize
 *  while keeping the anchored (non-dragged) edges fixed. */
function applyDrag(
  mode: DragMode,
  r0: CellRect,
  dx: number,
  dy: number,
  gridW: number,
  gridH: number,
  minSize: number,
): CellRect {
  if (mode === "move") {
    return {
      x: Math.max(0, Math.min(r0.x + dx, gridW - r0.w)),
      y: Math.max(0, Math.min(r0.y + dy, gridH - r0.h)),
      w: r0.w,
      h: r0.h,
    };
  }
  let { x, y, w, h } = r0;
  if (mode.includes("w")) {
    const right = r0.x + r0.w;
    x = Math.max(0, Math.min(r0.x + dx, right - minSize));
    w = right - x;
  } else if (mode.includes("e")) {
    w = Math.max(minSize, Math.min(r0.w + dx, gridW - r0.x));
  }
  if (mode.includes("n")) {
    const bottom = r0.y + r0.h;
    y = Math.max(0, Math.min(r0.y + dy, bottom - minSize));
    h = bottom - y;
  } else if (mode.includes("s")) {
    h = Math.max(minSize, Math.min(r0.h + dy, gridH - r0.y));
  }
  return { x, y, w, h };
}

export default function CropBox({
  rect,
  onChange,
  cellPx,
  gridW,
  gridH,
  minSize = 3,
}: CropBoxProps) {
  const dragRef = useRef<{
    mode: DragMode;
    pointerId: number;
    startX: number;
    startY: number;
    startRect: CellRect;
  } | null>(null);
  // Latest rect without re-binding handlers mid-drag.
  const rectRef = useRef(rect);
  useEffect(() => {
    rectRef.current = rect;
  }, [rect]);

  const beginDrag = useCallback(
    (e: React.PointerEvent, mode: DragMode) => {
      // Primary button / touch / pen only.
      if (e.pointerType === "mouse" && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        mode,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startRect: rectRef.current,
      };
    },
    [],
  );

  const moveDrag = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId || cellPx <= 0) return;
      e.preventDefault();
      // The snap: device delta -> whole cells, rounded. Nothing sub-cell.
      const dx = Math.round((e.clientX - drag.startX) / cellPx);
      const dy = Math.round((e.clientY - drag.startY) / cellPx);
      const next = applyDrag(drag.mode, drag.startRect, dx, dy, gridW, gridH, minSize);
      if (!sameRect(next, rectRef.current)) onChange(next);
    },
    [cellPx, gridW, gridH, minSize, onChange],
  );

  const endDrag = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        (e.currentTarget as HTMLElement).blur();
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
      // Arrows move; shift+arrows resize (east/south edges) by 1 cell.
      const mode: DragMode = e.shiftKey ? (dx !== 0 ? "e" : "s") : "move";
      const next = applyDrag(mode, rectRef.current, dx, dy, gridW, gridH, minSize);
      if (!sameRect(next, rectRef.current)) onChange(next);
    },
    [gridW, gridH, minSize, onChange],
  );

  const px = (cells: number) => cells * cellPx;

  const handleProps = (mode: DragMode) => ({
    onPointerDown: (e: React.PointerEvent) => beginDrag(e, mode),
    onPointerMove: moveDrag,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  });

  const handles: { mode: Exclude<DragMode, "move">; left: number; top: number }[] = [
    { mode: "n", left: px(rect.w) / 2, top: 0 },
    { mode: "s", left: px(rect.w) / 2, top: px(rect.h) },
    { mode: "w", left: 0, top: px(rect.h) / 2 },
    { mode: "e", left: px(rect.w), top: px(rect.h) / 2 },
    { mode: "nw", left: 0, top: 0 },
    { mode: "ne", left: px(rect.w), top: 0 },
    { mode: "sw", left: 0, top: px(rect.h) },
    { mode: "se", left: px(rect.w), top: px(rect.h) },
  ];

  return (
    <div
      aria-hidden={false}
      className="absolute left-0 top-0 overflow-hidden"
      style={{ width: px(gridW), height: px(gridH), touchAction: "none" }}
    >
      {/* the selection: focusable, movable, keyboard-operable */}
      <div
        role="group"
        tabIndex={0}
        aria-label={`Crop selection: ${rect.w} by ${rect.h} cells at column ${rect.x}, row ${rect.y}. Arrow keys move, shift plus arrows resize, escape leaves.`}
        onKeyDown={onKeyDown}
        {...handleProps("move")}
        className="absolute cursor-move"
        style={{
          left: px(rect.x),
          top: px(rect.y),
          width: px(rect.w),
          height: px(rect.h),
        }}
      >
        {/* accent 2px border + dim scrim outside the selection (the huge
            spread shadow is clipped by the overflow-hidden container) */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute border-2 border-accent"
          style={{
            inset: -2,
            boxShadow: "0 0 0 100000px color-mix(in srgb, var(--paper) 55%, transparent)",
          }}
        />

        {/* 8 handles; hit area >= 44px, visible marker much smaller.
            Corners render after edges so they win overlaps. */}
        {handles.map(({ mode, left, top }) => (
          <div
            key={mode}
            {...handleProps(mode)}
            aria-hidden="true"
            className="absolute flex items-center justify-center"
            style={{
              left: left - HIT / 2,
              top: top - HIT / 2,
              width: HIT,
              height: HIT,
              cursor: HANDLE_CURSOR[mode],
              touchAction: "none",
            }}
          >
            <span
              className="block bg-accent"
              style={{
                width: mode.length === 2 ? 10 : 8,
                height: mode.length === 2 ? 10 : 8,
                boxShadow: "0 0 0 2px var(--paper)",
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
