/**
 * Head Sticker export pipeline.
 *
 * Order is sacred and matches the build spec exactly:
 *
 *   crop -> keyOut(bg) -> dilate(outlineWidth, outlineColour)
 *        [-> optional second dilate(1, darker tone)]
 *        -> rasterise to offscreen at final scale, smoothing OFF
 *        -> THEN rotate (rotation AFTER upscale) via a manual nearest-
 *           neighbour inverse mapping — NOT ctx.rotate()+drawImage, which
 *           antialiases the rotated edge geometry in Chromium regardless of
 *           imageSmoothingEnabled=false
 *        -> composite onto background
 *        -> optional drop shadow from the rotated sticker's alpha.
 *
 * All geometry stays in integer grid cells until the single rasterise step.
 * NOTE: grid-lib `dilate` EXPANDS the grid by `radius` per side — every
 * scale/centring computation below therefore uses the *dilated* grid's w/h,
 * never the selection's.
 */

import type { CellRect, Grid } from "@/lib/grid";
import {
  GridValidationError,
  complementTint,
  crop,
  darken,
  detectBackground,
  dilate,
  dominantBodyColour,
  hexToRgb,
  keyOut,
  rasteriseToCanvas,
} from "@/lib/grid";

export type StickerOpts = {
  /** outline thickness in cells around the keyed-out head */
  outlineWidth: 0 | 1 | 2 | 3;
  /** hex colour of the outline (white default in the UI) */
  outlineColour: string;
  /** adds a second 1-cell dilate in a darker tone outside the outline */
  twoTone: boolean;
  /** tilt in degrees, applied after upscale on the destination canvas */
  rotationDeg: number;
  /**
   * 'tint'     -> complementTint(dominantBodyColour of the cropped head)
   * 'piece-bg' -> the piece's detected background colour
   * 'solid'    -> the given colour (defaults to white if missing)
   */
  background: { mode: "tint" | "piece-bg" | "solid"; colour?: string };
  /** drop shadow drawn from the rotated sticker's alpha; opacity 0..1 */
  shadow: { on: boolean; opacity: number };
  /** fraction of the frame the rotated sticker's larger extent fills (~0.5–1) */
  scale: number;
  /** horizontal nudge as percent of the frame; positive = right */
  nudgeX: number;
  /** vertical nudge as percent of the frame; positive = down */
  nudgeY: number;
  /** export edge length in device pixels */
  size: 400 | 1000 | 2000;
};

/** darken() amount for the optional second (two-tone) outline ring */
export const TWO_TONE_DARKEN = 0.4;
/** darken() amount for the shadow colour, per spec: darken(bgColour, 0.4) */
const SHADOW_DARKEN = 0.4;

/**
 * Steps 1–3 of the pipeline, entirely in cell space:
 * crop -> keyOut(detected bg) -> dilate(s).
 * The result grid is larger than `sel` by (outlineWidth + twoTone?1:0) cells
 * per side whenever an outline is applied.
 */
export function buildStickerGrid(grid: Grid, sel: CellRect, opts: StickerOpts): Grid {
  const bg = detectBackground(grid);
  let g = keyOut(crop(grid, sel), bg);
  if (opts.outlineWidth > 0) {
    g = dilate(g, opts.outlineWidth, opts.outlineColour);
    if (opts.twoTone) {
      g = dilate(g, 1, darken(opts.outlineColour, TWO_TONE_DARKEN));
    }
  }
  return g;
}

/**
 * The background colour the sticker will be composited onto, resolved
 * deterministically from the options. Exposed so the panel can show it.
 */
export function resolveStickerBackground(grid: Grid, sel: CellRect, opts: StickerOpts): string {
  const mode = opts.background.mode;
  if (mode === "solid") return (opts.background.colour ?? "#ffffff").toLowerCase();
  const bg = detectBackground(grid);
  if (mode === "piece-bg") return bg;
  // 'tint' — complement of the head's dominant body colour; fall back to the
  // whole grid, then to the background itself, if the crop is empty.
  try {
    return complementTint(dominantBodyColour(crop(grid, sel), bg));
  } catch {
    try {
      return complementTint(dominantBodyColour(grid, bg));
    } catch {
      return complementTint(bg);
    }
  }
}

/**
 * Rotate an RGBA pixel buffer by `rad` around its own centre and place it in
 * a destW x destH destination so the source centre lands at (cx, cy), using
 * pure nearest-neighbour inverse mapping. Every destination pixel is either
 * fully transparent (outside the rotated source) or an EXACT copy of one
 * source pixel — no colour can be invented, so rotated edges never blend.
 *
 * Equivalent placement maths to the old ctx.translate(cx, cy) -> rotate(rad)
 * -> drawImage(src, -srcW/2, -srcH/2), minus the edge antialiasing Chromium
 * applies to rotated drawImage geometry even with smoothing disabled.
 *
 * Pure function (no DOM) so the no-blend guarantee is unit-testable in node.
 */
export function rotatePixelsNearest(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  rad: number,
  destW: number,
  destH: number,
  cx: number,
  cy: number,
): Uint8ClampedArray {
  if (src.length !== srcW * srcH * 4) {
    throw new GridValidationError(
      `rotatePixelsNearest: src length ${src.length} does not match ${srcW}x${srcH} RGBA`,
    );
  }
  const out = new Uint8ClampedArray(destW * destH * 4);
  // Inverse rotation: dest = R(rad)·(srcPt - centre) + (cx, cy)
  //               =>  srcPt = R(-rad)·(dest - (cx, cy)) + centre.
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const halfW = srcW / 2;
  const halfH = srcH / 2;
  for (let y = 0; y < destH; y++) {
    const dy = y + 0.5 - cy; // sample at the destination pixel centre
    for (let x = 0; x < destW; x++) {
      const dx = x + 0.5 - cx;
      const sx = Math.floor(dx * cos + dy * sin + halfW);
      const sy = Math.floor(-dx * sin + dy * cos + halfH);
      if (sx < 0 || sy < 0 || sx >= srcW || sy >= srcH) continue;
      const si = (sy * srcW + sx) * 4;
      const di = (y * destW + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return out;
}

function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Full compose to an HTMLCanvasElement of targetPx x targetPx. Browser only.
 * Used at low targetPx for live previews and at opts.size for export.
 */
export function composeStickerCanvas(
  grid: Grid,
  sel: CellRect,
  opts: StickerOpts,
  targetPx: number,
): HTMLCanvasElement {
  if (typeof document === "undefined") {
    throw new GridValidationError("composeStickerCanvas requires a browser environment");
  }
  if (!Number.isInteger(targetPx) || targetPx < 1) {
    throw new GridValidationError(
      `composeStickerCanvas: targetPx must be a positive integer, got ${targetPx}`,
    );
  }

  // Cell-space steps (crop -> keyOut -> dilates). Dilate expanded the grid,
  // so sticker.w/h — not sel.w/h — drive all pixel maths from here on.
  const sticker = buildStickerGrid(grid, sel, opts);

  // Fit the ROTATED bounding box at `scale` of the frame, then rasterise at
  // an integer cell size (the one and only cells -> device pixels step).
  const rad = (opts.rotationDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const rotW = sticker.w * cos + sticker.h * sin;
  const rotH = sticker.w * sin + sticker.h * cos;
  const scale = Math.max(0.05, Math.min(1, opts.scale));
  const cellPx = Math.max(1, Math.floor((scale * targetPx) / Math.max(rotW, rotH)));

  // Rasterise upscaled FIRST, smoothing off (rotation must come after).
  const offscreen = rasteriseToCanvas(sticker, cellPx);
  const offW = sticker.w * cellPx;
  const offH = sticker.h * cellPx;

  const canvas = document.createElement("canvas");
  canvas.width = targetPx;
  canvas.height = targetPx;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new GridValidationError("composeStickerCanvas: could not acquire 2d context");
  // Canvas was just (re)sized — context state is fresh; kill smoothing NOW.
  ctx.imageSmoothingEnabled = false;

  // Background first.
  const bgColour = resolveStickerBackground(grid, sel, opts);
  ctx.fillStyle = bgColour;
  ctx.fillRect(0, 0, targetPx, targetPx);

  // Rotate on the destination, centred + nudged. Shadow (when on) rides the
  // same drawImage — the browser derives it from the rotated sticker's alpha.
  // shadowOffset* are specified in device space (untouched by the CTM).
  const cx = targetPx / 2 + (opts.nudgeX / 100) * targetPx;
  const cy = targetPx / 2 + (opts.nudgeY / 100) * targetPx;

  ctx.save();
  if (opts.shadow.on && opts.shadow.opacity > 0) {
    ctx.shadowColor = withAlpha(darken(bgColour, SHADOW_DARKEN), opts.shadow.opacity);
    ctx.shadowOffsetX = Math.max(1, Math.round(targetPx * 0.015));
    ctx.shadowOffsetY = Math.max(1, Math.round(targetPx * 0.02));
    ctx.shadowBlur = Math.max(1, Math.round(targetPx * 0.02));
  }
  ctx.translate(cx, cy);
  ctx.rotate(rad);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(offscreen, -offW / 2, -offH / 2);
  ctx.restore();

  return canvas;
}

/** Full pipeline to a PNG blob at opts.size x opts.size. */
export function exportSticker(grid: Grid, sel: CellRect, opts: StickerOpts): Promise<Blob> {
  const canvas = composeStickerCanvas(grid, sel, opts, opts.size);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new GridValidationError("exportSticker: canvas.toBlob returned null"));
    }, "image/png");
  });
}
