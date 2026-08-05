/**
 * Pure cell maths for the highlight brush — kept out of the component so the
 * stroke behaviour is unit-testable in node (no DOM anywhere in here).
 *
 * A mask is a ReadonlySet of `${x},${y}` keys in WHOLE-GRID cell coordinates
 * (integers, 0..gridW-1 / 0..gridH-1). `null` elsewhere means box mode; this
 * module only ever deals with a real, non-null mask.
 *
 * Every function is integer-only by construction: pointer positions are
 * floored into cells exactly once (cellAt), stroke paths are walked with
 * Bresenham so a fast swipe cannot skip cells, and bounds are enforced at the
 * single place cells enter a mask (applyStrokeInto).
 */

import type { CellRect } from "@/lib/grid";

export type Cell = { x: number; y: number };

/** The one key format, shared with the exporter half of this feature. */
export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Inverse of cellKey; null for anything that is not two integers. */
export function parseCellKey(key: string): Cell | null {
  const parts = key.split(",");
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return { x, y };
}

export function inBounds(c: Cell, gridW: number, gridH: number): boolean {
  return c.x >= 0 && c.y >= 0 && c.x < gridW && c.y < gridH;
}

/**
 * Device-independent pixel offset (relative to the brush layer's top-left)
 * -> the cell under it. Floored, so the result is always integral; it may be
 * out of bounds (the pointer can leave the plate mid-drag) — applyStrokeInto
 * is the one place that filters. Returns null when the layer has no measured
 * size yet or the input is not finite.
 */
export function cellAt(px: number, py: number, cellPx: number): Cell | null {
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  if (!Number.isFinite(cellPx) || cellPx <= 0) return null;
  return { x: Math.floor(px / cellPx), y: Math.floor(py / cellPx) };
}

/**
 * Every cell on the straight path from a to b, inclusive of both ends
 * (integer Bresenham). This is what stops a fast swipe from leaving gaps
 * between successive pointermove samples.
 */
export function lineCells(a: Cell, b: Cell): Cell[] {
  const out: Cell[] = [];
  let x = Math.trunc(a.x);
  let y = Math.trunc(a.y);
  const x1 = Math.trunc(b.x);
  const y1 = Math.trunc(b.y);
  const dx = Math.abs(x1 - x);
  const dy = -Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let err = dx + dy;
  // Bounded by the Chebyshev distance + 1; the guard is belt and braces.
  const limit = Math.max(dx, -dy) + 1;
  for (let i = 0; i <= limit; i++) {
    out.push({ x, y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

export type StrokeAction = "paint" | "erase";

/**
 * Apply a stroke action to a MUTABLE working set, skipping out-of-bounds
 * cells. Returns true when the set actually changed (so the caller can avoid
 * pointless re-renders mid-drag).
 */
export function applyStrokeInto(
  set: Set<string>,
  cells: Iterable<Cell>,
  action: StrokeAction,
  gridW: number,
  gridH: number,
): boolean {
  let changed = false;
  for (const c of cells) {
    if (!Number.isInteger(c.x) || !Number.isInteger(c.y)) continue;
    if (!inBounds(c, gridW, gridH)) continue;
    const k = cellKey(c.x, c.y);
    if (action === "paint") {
      if (!set.has(k)) {
        set.add(k);
        changed = true;
      }
    } else if (set.delete(k)) {
      changed = true;
    }
  }
  return changed;
}

/**
 * The seed: every cell inside the box selection, clipped to the grid. This is
 * what HIGHLIGHT starts from, so the user refines the auto-detected head
 * instead of painting from an empty canvas.
 */
export function rectMask(rect: CellRect, gridW: number, gridH: number): Set<string> {
  const out = new Set<string>();
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(gridW, Math.floor(rect.x) + Math.floor(rect.w));
  const y1 = Math.min(gridH, Math.floor(rect.y) + Math.floor(rect.h));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) out.add(cellKey(x, y));
  }
  return out;
}

export type EdgeSide = "top" | "right" | "bottom" | "left";
export type MaskEdge = { x: number; y: number; side: EdgeSide };

/**
 * The OUTER BOUNDARY of the masked region as per-cell edge segments: an edge
 * is emitted only where the neighbour across it is unmasked or out of bounds.
 * Interior cell borders produce nothing, so the region reads as one silhouette
 * rather than a grid of outlined squares.
 */
export function maskEdges(
  mask: ReadonlySet<string>,
  gridW: number,
  gridH: number,
): MaskEdge[] {
  const out: MaskEdge[] = [];
  for (const key of mask) {
    const c = parseCellKey(key);
    if (c === null || !inBounds(c, gridW, gridH)) continue;
    if (!mask.has(cellKey(c.x, c.y - 1))) out.push({ x: c.x, y: c.y, side: "top" });
    if (!mask.has(cellKey(c.x, c.y + 1))) out.push({ x: c.x, y: c.y, side: "bottom" });
    if (!mask.has(cellKey(c.x - 1, c.y))) out.push({ x: c.x, y: c.y, side: "left" });
    if (!mask.has(cellKey(c.x + 1, c.y))) out.push({ x: c.x, y: c.y, side: "right" });
  }
  return out;
}
