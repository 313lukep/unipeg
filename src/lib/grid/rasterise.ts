import { Grid, GridValidationError } from "./types";

/**
 * Final rasterise step — the ONE place cell coordinates become device pixels.
 * Browser-only entry points are runtime-guarded so importing this module in
 * node never throws.
 */

/**
 * Draw the grid onto a 2d context at integer `cellSize`, offset by (dx, dy)
 * device pixels. Disables image smoothing, batches fillRect calls by colour.
 */
export function rasterise(
  g: Grid,
  cellSize: number,
  ctx: CanvasRenderingContext2D,
  dx = 0,
  dy = 0,
): void {
  if (!Number.isInteger(cellSize) || cellSize < 1) {
    throw new GridValidationError(`rasterise: cellSize must be a positive integer, got ${cellSize}`);
  }
  ctx.imageSmoothingEnabled = false;

  const byColour = new Map<string, [number, number][]>();
  for (let y = 0; y < g.h; y++) {
    const row = g.cells[y];
    for (let x = 0; x < g.w; x++) {
      const c = row[x];
      if (c === null) continue;
      let list = byColour.get(c);
      if (!list) {
        list = [];
        byColour.set(c, list);
      }
      list.push([x, y]);
    }
  }
  for (const [colour, positions] of byColour) {
    ctx.fillStyle = colour;
    for (const [x, y] of positions) {
      ctx.fillRect(dx + x * cellSize, dy + y * cellSize, cellSize, cellSize);
    }
  }
}

/**
 * Rasterise into a fresh canvas sized g.w*cellSize x g.h*cellSize. Prefers
 * OffscreenCanvas when available; falls back to a DOM canvas. Throws in
 * plain node where neither exists.
 */
export function rasteriseToCanvas(g: Grid, cellSize: number): HTMLCanvasElement | OffscreenCanvas {
  if (!Number.isInteger(cellSize) || cellSize < 1) {
    throw new GridValidationError(
      `rasteriseToCanvas: cellSize must be a positive integer, got ${cellSize}`,
    );
  }
  const w = g.w * cellSize;
  const h = g.h * cellSize;

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(w, h);
  } else if (typeof document !== "undefined") {
    const el = document.createElement("canvas");
    el.width = w;
    el.height = h;
    canvas = el;
  } else {
    throw new GridValidationError(
      "rasteriseToCanvas requires a browser environment (no OffscreenCanvas or document)",
    );
  }
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new GridValidationError("could not acquire a 2d context");
  ctx.imageSmoothingEnabled = false;
  rasterise(g, cellSize, ctx);
  return canvas;
}

/**
 * Largest integer cellSize with g.w * cellSize <= target, minimum 1 — so
 * exports land at or just under the target dimension (e.g. 1000x1000).
 */
export function pickCellSize(g: Grid, target: number): number {
  return Math.max(1, Math.floor(target / g.w));
}
