/**
 * Full-Body Fit exporter — compose the piece inside the inscribed circle of a
 * square canvas (so the whole unicorn survives X's circular avatar crop) and
 * rasterise it to PNG.
 *
 * All composition maths lives in src/lib/grid (fullBodyCompose, pickCellSize,
 * rasterise); this module only wires those into canvases and blobs. Geometry
 * stays in integer cells until the single rasterise step.
 */

import {
  fullBodyCompose,
  pickCellSize,
  rasterise,
  GridValidationError,
} from "@/lib/grid";
import type { Grid, CellRect } from "@/lib/grid";

export type FullBodySize = 400 | 1000 | 2000;

export type FullBodyExportOpts = {
  /** Fraction of the content diagonal kept as margin, e.g. 0.12 for 12%. */
  breathingRoom: number;
  /** Background colour; omitted = detectBackground(grid). */
  bg?: string;
  /** Final square PNG dimension in device pixels. */
  size: FullBodySize;
};

export type FullBodyPreviewOpts = {
  breathingRoom: number;
  bg?: string;
  /** Rasterise target in device pixels (cellSize picked to land at/under it). */
  targetPx?: number;
};

export type FullBodyPreview = {
  /** Square canvas, N*cellSize px, background filled, smoothing off. */
  canvas: HTMLCanvasElement;
  /** Composed grid side length in cells. */
  N: number;
  /** The background colour actually used (lowercase #rrggbb). */
  bg: string;
  /** Content bounding box in the SOURCE grid's cell coordinates. */
  contentBox: CellRect;
};

const DEFAULT_PREVIEW_TARGET_PX = 480;

function assertBrowser(fn: string): void {
  if (typeof document === "undefined") {
    throw new GridValidationError(`${fn} requires a browser environment`);
  }
}

/**
 * Compose the full-body grid and rasterise it onto a fresh square canvas for
 * panel previews. Browser only. The canvas is exactly N*cellSize px on a side
 * (no letterboxing) — display it with CSS `image-rendering: pixelated`.
 */
export function composeFullBodyPreview(
  grid: Grid,
  opts: FullBodyPreviewOpts,
): FullBodyPreview {
  assertBrowser("composeFullBodyPreview");
  const { grid: composed, N, bg, contentBox } = fullBodyCompose(grid, {
    breathingRoom: opts.breathingRoom,
    bg: opts.bg,
  });
  const cellSize = pickCellSize(composed, opts.targetPx ?? DEFAULT_PREVIEW_TARGET_PX);
  const px = N * cellSize;

  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new GridValidationError("composeFullBodyPreview: no 2d context");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, px, px);
  rasterise(composed, cellSize, ctx);
  return { canvas, N, bg, contentBox };
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new GridValidationError("exportFullBody: PNG encoding failed"));
    }, "image/png");
  });
}

/**
 * Export the full-body fit as a size x size PNG blob: fullBodyCompose,
 * rasterise at pickCellSize, centred on a `size` square filled with the
 * background colour. Browser only.
 */
export async function exportFullBody(
  grid: Grid,
  opts: FullBodyExportOpts,
): Promise<Blob> {
  assertBrowser("exportFullBody");
  const { grid: composed, N, bg } = fullBodyCompose(grid, {
    breathingRoom: opts.breathingRoom,
    bg: opts.bg,
  });
  const cellSize = pickCellSize(composed, opts.size);
  const content = N * cellSize; // <= opts.size by pickCellSize's contract
  const offset = Math.floor((opts.size - content) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = opts.size;
  canvas.height = opts.size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new GridValidationError("exportFullBody: no 2d context");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, opts.size, opts.size);
  rasterise(composed, cellSize, ctx, offset, offset);
  return canvasToPngBlob(canvas);
}
