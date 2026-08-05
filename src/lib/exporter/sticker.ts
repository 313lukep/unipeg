/**
 * Head Sticker export pipeline.
 *
 * TWO SELECTION MODES feed the same pipeline:
 *
 *   - BOX mode (mask null/undefined) — the rectangular `sel` is cropped, exactly
 *     as it always was. Nothing about this path has changed.
 *   - HIGHLIGHT mode (a non-null CellMask) — the user painted individual whole-
 *     grid cells. `sel` is then IGNORED: the cutout is the mask's bounding box,
 *     with every unpainted cell inside that box forced transparent. The mask only
 *     decides WHICH CELLS ENTER the pipeline; every downstream step (sizing,
 *     outline, tilt, shadow, background) behaves identically in both modes. The
 *     outline is a raster dilation of the alpha mask, so it hugs whatever
 *     silhouette was painted, holes and concavities included.
 *
 * Order is sacred and matches the build spec exactly:
 *
 *   crop [-> mask cells out] -> keyOut(bg)   (grid cells, integers)
 *        -> rasterise at integer cellPx, smoothing OFF
 *        -> OUTLINE AT RASTER LEVEL: binary-alpha square-kernel dilation of
 *           radius round(outlineWidth * cellPx) device pixels, filled with
 *           outlineColour, drawn UNDER the sticker pixels. The raster is
 *           padded by the dilation radius per side first so nothing clips.
 *           Implemented as a separable two-pass over the binary alpha mask —
 *           hard-edged, zero blur, zero antialiasing by construction.
 *        [-> optional second opposite-colour band (two-tone) at outer radius
 *            round(outlineWidth * cellPx) + round(0.25 * cellPx)]
 *        -> THEN rotate (rotation AFTER upscale) via a manual nearest-
 *           neighbour inverse mapping — NOT ctx.rotate()+drawImage, which
 *           antialiases the rotated edge geometry in Chromium regardless of
 *           imageSmoothingEnabled=false
 *        -> composite onto background
 *        -> optional drop shadow from the rotated sticker's alpha (soft OK).
 *
 * Sizing: cellPx derives from the UNROTATED outlined sticker dimensions, so
 * "size in frame" means the same at every tilt — rotating never shrinks the
 * sticker. The rotated layer itself is composed in the full frame; corners
 * that poke past the frame at high tilt+scale simply crop at the frame edge
 * (standard sticker behaviour).
 */

import type { CellRect, Grid } from "@/lib/grid";
import {
  GridValidationError,
  complementTint,
  crop,
  darken,
  detectBackground,
  dominantBodyColour,
  hexToRgb,
  keyOut,
  recomputePalette,
} from "@/lib/grid";

/**
 * A per-pixel highlight selection: whole-grid cell keys `` `${x},${y}` `` with
 * INTEGER coordinates in 0..grid.w-1 / 0..grid.h-1.
 *
 * `null` (or omitted) everywhere in this module means BOX mode — the
 * rectangular `sel` is used and behaviour is exactly what it always was. A
 * non-null mask switches the cutout to HIGHLIGHT mode and `sel` is ignored.
 */
export type CellMask = ReadonlySet<string>;

/** Canonical mask key shape; anything else in the set is silently ignored. */
const MASK_KEY_RE = /^-?\d+,-?\d+$/;

/** Thrown reason when a highlight selection resolves to no usable cells. */
export const EMPTY_MASK_REASON = "highlight at least one pixel";

/**
 * Bounding box (in whole-grid cell coordinates) of the mask's cells that
 * actually land inside the grid. Malformed keys and keys outside the grid are
 * silently ignored; if nothing usable remains this throws GridValidationError
 * with reason `"highlight at least one pixel"` so the panel can show it
 * verbatim.
 */
export function maskBounds(grid: Grid, mask: CellMask): CellRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const key of mask) {
    if (!MASK_KEY_RE.test(key)) continue;
    const comma = key.indexOf(",");
    const x = Number(key.slice(0, comma));
    const y = Number(key.slice(comma + 1));
    if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) throw new GridValidationError(EMPTY_MASK_REASON);
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export type StickerOpts = {
  /**
   * Outline thickness in CELLS around the keyed-out head. Fractional values
   * are supported: the outline is applied at raster level as a binary-alpha
   * square-kernel dilation of round(outlineWidth * cellPx) device pixels.
   * Valid range 0..1.5 in 0.25 steps (default 0.5); out-of-range or off-step
   * values are defensively clamped/snapped, non-finite input falls back to
   * the default.
   */
  outlineWidth: number;
  /**
   * outline colour — WHITE (#ffffff) or BLACK (#000000) only; anything else
   * is defensively normalised to white
   */
  outlineColour: string;
  /**
   * adds a second band in the OPPOSITE colour outside the outline (white
   * outline -> black band, black outline -> white band), outer radius
   * round(outlineWidth * cellPx) + round(0.25 * cellPx) device pixels
   */
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
  /**
   * fraction of the frame the UNROTATED outlined sticker's larger extent
   * fills (~0.5–1); tilt does not change the rendered size
   */
  scale: number;
  /** horizontal nudge as percent of the frame; positive = right */
  nudgeX: number;
  /** vertical nudge as percent of the frame; positive = down */
  nudgeY: number;
  /** export edge length in device pixels */
  size: 400 | 1000 | 2000;
};

/** the only two legal outline colours (owner rule) */
export const OUTLINE_WHITE = "#ffffff";
export const OUTLINE_BLACK = "#000000";

/**
 * Defensive normalisation of StickerOpts.outlineColour: outlines are WHITE
 * (#ffffff) or BLACK (#000000) only; anything else falls back to white.
 */
export function normaliseOutlineColour(colour: string): string {
  const c = typeof colour === "string" ? colour.trim().toLowerCase() : "";
  return c === OUTLINE_BLACK || c === "#000" ? OUTLINE_BLACK : OUTLINE_WHITE;
}

/**
 * Two-tone outer band colour: exactly the OPPOSITE of the (normalised)
 * outline colour — white outline gets a black band, black gets white.
 */
export function twoToneBandColour(outlineColour: string): string {
  return normaliseOutlineColour(outlineColour) === OUTLINE_WHITE ? OUTLINE_BLACK : OUTLINE_WHITE;
}

/** darken() amount for the shadow colour, per spec: darken(bgColour, 0.4) */
const SHADOW_DARKEN = 0.4;

/** outlineWidth validity: 0..1.5 cells in 0.25 steps, default 0.5 */
export const OUTLINE_WIDTH_MIN = 0;
export const OUTLINE_WIDTH_MAX = 1.5;
export const OUTLINE_WIDTH_STEP = 0.25;
export const OUTLINE_WIDTH_DEFAULT = 0.5;

/**
 * Defensive normalisation of StickerOpts.outlineWidth: snap to the nearest
 * 0.25-cell step, clamp to [0, 1.5]; non-finite input falls back to 0.5.
 */
export function normaliseOutlineWidth(w: number): number {
  if (!Number.isFinite(w)) return OUTLINE_WIDTH_DEFAULT;
  const snapped = Math.round(w / OUTLINE_WIDTH_STEP) * OUTLINE_WIDTH_STEP;
  return Math.min(OUTLINE_WIDTH_MAX, Math.max(OUTLINE_WIDTH_MIN, snapped));
}

/**
 * Cell-space steps of the pipeline: crop -> [mask] -> keyOut(detected bg).
 * The outline is no longer a cell-space dilate; it happens at raster level in
 * renderStickerLayer (sub-cell widths).
 *
 * BOX mode (`mask` null/undefined): result is exactly sel.w x sel.h.
 *
 * HIGHLIGHT mode (non-null `mask`): `sel` is IGNORED. The result is the mask's
 * bounding box (clamped to the grid; malformed / out-of-bounds keys ignored)
 * with every cell NOT in the mask set to null, then keyed out against the
 * piece's detected background — so a highlighted cell that happens to BE the
 * background colour still drops out, consistent with box mode. A mask with no
 * usable cells throws GridValidationError("highlight at least one pixel").
 */
export function buildStickerGrid(grid: Grid, sel: CellRect, mask?: CellMask | null): Grid {
  const bg = detectBackground(grid);
  if (mask === null || mask === undefined) return keyOut(crop(grid, sel), bg);
  const box = maskBounds(grid, mask);
  const cropped = crop(grid, box);
  const cells = cropped.cells.map((row, y) =>
    row.map((c, x) => (mask.has(`${x + box.x},${y + box.y}`) ? c : null)),
  );
  return keyOut(recomputePalette({ w: box.w, h: box.h, cells, palette: [] }), bg);
}

/**
 * The background colour the sticker will be composited onto, resolved
 * deterministically from the options. Exposed so the panel can show it.
 *
 * With a non-null `mask` the 'tint' path reads the masked cutout instead of
 * the rectangular crop; the 'solid' and 'piece-bg' paths are mask-independent.
 */
export function resolveStickerBackground(
  grid: Grid,
  sel: CellRect,
  opts: StickerOpts,
  mask?: CellMask | null,
): string {
  const mode = opts.background.mode;
  if (mode === "solid") return (opts.background.colour ?? "#ffffff").toLowerCase();
  const bg = detectBackground(grid);
  if (mode === "piece-bg") return bg;
  // 'tint' — complement of the head's dominant body colour; fall back to the
  // whole grid, then to the background itself, if the cutout is empty.
  try {
    const cutout =
      mask === null || mask === undefined ? crop(grid, sel) : buildStickerGrid(grid, sel, mask);
    return complementTint(dominantBodyColour(cutout, bg));
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
): Uint8ClampedArray<ArrayBuffer> {
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

/**
 * Pure raster of a grid at integer cellPx: each cell becomes a cellPx x
 * cellPx block of its exact colour (alpha 255), null cells stay fully
 * transparent. No canvas involved, so it is exact by construction and
 * node-testable — the sticker path's one cells -> device pixels step.
 */
function rasteriseGridPixels(g: Grid, cellPx: number): Uint8ClampedArray<ArrayBuffer> {
  const w = g.w * cellPx;
  const out = new Uint8ClampedArray(w * g.h * cellPx * 4);
  for (let cy = 0; cy < g.h; cy++) {
    for (let cx = 0; cx < g.w; cx++) {
      const c = g.cells[cy][cx];
      if (c === null) continue;
      const { r, g: gr, b } = hexToRgb(c);
      for (let y = cy * cellPx; y < (cy + 1) * cellPx; y++) {
        let i = (y * w + cx * cellPx) * 4;
        for (let x = 0; x < cellPx; x++) {
          out[i] = r;
          out[i + 1] = gr;
          out[i + 2] = b;
          out[i + 3] = 255;
          i += 4;
        }
      }
    }
  }
  return out;
}

/**
 * Binary dilation of a w x h occupancy mask with a square (Chebyshev)
 * kernel of radius r, realised as a separable two-pass: 1-D horizontal
 * dilation via left/right distance sweeps, then the same vertically over
 * the horizontal result. O(w*h) regardless of r. Output is binary — no
 * partial coverage exists, so no antialiasing can exist.
 */
function dilateMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const far = w + h;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let dist = far;
    for (let x = 0; x < w; x++) {
      dist = mask[row + x] ? 0 : dist + 1;
      if (dist <= r) tmp[row + x] = 1;
    }
    dist = far;
    for (let x = w - 1; x >= 0; x--) {
      dist = mask[row + x] ? 0 : dist + 1;
      if (dist <= r) tmp[row + x] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let dist = far;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      dist = tmp[i] ? 0 : dist + 1;
      if (dist <= r) out[i] = 1;
    }
    dist = far;
    for (let y = h - 1; y >= 0; y--) {
      const i = y * w + x;
      dist = tmp[i] ? 0 : dist + 1;
      if (dist <= r) out[i] = 1;
    }
  }
  return out;
}

/**
 * Raster-level sticker outline. Pads the source RGBA buffer by
 * (outlinePx + bandPx) on each side so nothing can clip, then draws:
 *
 *   - outlineColour under every pixel within Chebyshev distance outlinePx
 *     of the binary alpha mask (alpha > 0),
 *   - optionally bandColour (two-tone) in the ring between outlinePx and
 *     outlinePx + bandPx,
 *   - the source pixels themselves, untouched, on top.
 *
 * Everything is decided per-pixel from binary masks: output alpha is 0 or
 * 255 only, zero blur, zero antialiasing by construction. Pure function.
 */
export function outlinePixels(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  outlinePx: number,
  outlineColour: string,
  bandPx = 0,
  bandColour?: string,
): { data: Uint8ClampedArray<ArrayBuffer>; w: number; h: number } {
  if (src.length !== srcW * srcH * 4) {
    throw new GridValidationError(
      `outlinePixels: src length ${src.length} does not match ${srcW}x${srcH} RGBA`,
    );
  }
  if (!Number.isInteger(outlinePx) || outlinePx < 0 || !Number.isInteger(bandPx) || bandPx < 0) {
    throw new GridValidationError(
      `outlinePixels: radii must be non-negative integers, got ${outlinePx}/${bandPx}`,
    );
  }
  const band = bandColour !== undefined ? bandPx : 0;
  const pad = outlinePx + band;
  const w = srcW + 2 * pad;
  const h = srcH + 2 * pad;
  const out = new Uint8ClampedArray(w * h * 4);
  if (pad === 0) {
    out.set(src);
    return { data: out, w, h };
  }

  // Binary occupancy of the padded source (alpha > 0 — the raster is
  // hard-edged, alpha is only ever 0 or 255).
  const occ = new Uint8Array(w * h);
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      if (src[(y * srcW + x) * 4 + 3] !== 0) occ[(y + pad) * w + (x + pad)] = 1;
    }
  }
  const inner = dilateMask(occ, w, h, outlinePx);
  const outer = band > 0 ? dilateMask(occ, w, h, outlinePx + band) : null;
  const oc = hexToRgb(outlineColour);
  const bc = bandColour !== undefined ? hexToRgb(bandColour) : oc;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const di = i * 4;
      const sx = x - pad;
      const sy = y - pad;
      if (sx >= 0 && sy >= 0 && sx < srcW && sy < srcH) {
        const si = (sy * srcW + sx) * 4;
        if (src[si + 3] !== 0) {
          out[di] = src[si];
          out[di + 1] = src[si + 1];
          out[di + 2] = src[si + 2];
          out[di + 3] = src[si + 3];
          continue;
        }
      }
      if (inner[i]) {
        out[di] = oc.r;
        out[di + 1] = oc.g;
        out[di + 2] = oc.b;
        out[di + 3] = 255;
      } else if (outer !== null && outer[i]) {
        out[di] = bc.r;
        out[di + 1] = bc.g;
        out[di + 2] = bc.b;
        out[di + 3] = 255;
      }
    }
  }
  return { data: out, w, h };
}

/**
 * The pure part of the compose: keyed grid -> cellPx (from the UNROTATED
 * outlined dimensions, so tilt never changes size) -> raster -> raster-level
 * outline (+ optional two-tone band) -> nearest-neighbour rotation into a
 * targetPx x targetPx transparent layer, centred + nudged.
 *
 * Returns the rotated layer's RGBA plus the resolved metrics so callers
 * (and tests) can reason about exact pixel geometry.
 *
 * A non-null `mask` only changes which cells enter at the first step (see
 * buildStickerGrid); sizing stays tilt-invariant and the raster outline hugs
 * the painted silhouette because it dilates that cutout's alpha mask.
 */
export function renderStickerLayer(
  grid: Grid,
  sel: CellRect,
  opts: StickerOpts,
  targetPx: number,
  mask?: CellMask | null,
): {
  data: Uint8ClampedArray<ArrayBuffer>;
  cellPx: number;
  outlinePx: number;
  bandPx: number;
  outW: number;
  outH: number;
} {
  if (!Number.isInteger(targetPx) || targetPx < 1) {
    throw new GridValidationError(
      `renderStickerLayer: targetPx must be a positive integer, got ${targetPx}`,
    );
  }
  const sticker = buildStickerGrid(grid, sel, mask);
  const ow = normaliseOutlineWidth(opts.outlineWidth);
  const outlineColour = normaliseOutlineColour(opts.outlineColour);
  const twoTone = opts.twoTone && ow > 0;

  // cellPx from the UNROTATED outlined extent: largest integer cell size
  // whose outlined sticker (content + outline padding) fits scale*targetPx.
  // Deliberately NOT the rotated bounding box — tilt must not change size.
  const scale = Math.max(0.05, Math.min(1, opts.scale));
  const budget = scale * targetPx;
  const maxCells = Math.max(sticker.w, sticker.h);
  const dimAt = (c: number) =>
    maxCells * c + 2 * (Math.round(ow * c) + (twoTone ? Math.round(0.25 * c) : 0));
  let cellPx = Math.max(
    1,
    Math.floor(budget / (maxCells + 2 * (ow + (twoTone ? 0.25 : 0)))),
  );
  while (cellPx > 1 && dimAt(cellPx) > budget) cellPx--;

  const outlinePx = ow > 0 ? Math.round(ow * cellPx) : 0;
  const bandPx = twoTone ? Math.round(0.25 * cellPx) : 0;

  // Rasterise upscaled FIRST, then outline at raster level, then rotate.
  const rasterW = sticker.w * cellPx;
  const rasterH = sticker.h * cellPx;
  const raster = rasteriseGridPixels(sticker, cellPx);
  const outlined =
    outlinePx > 0 || bandPx > 0
      ? outlinePixels(
          raster,
          rasterW,
          rasterH,
          outlinePx,
          outlineColour,
          bandPx,
          twoTone ? twoToneBandColour(outlineColour) : undefined,
        )
      : { data: raster, w: rasterW, h: rasterH };

  // Rotate manually with nearest-neighbour inverse mapping, centred + nudged.
  // The layer is the full frame, so the rotated bounding box is never clipped
  // by the layer itself; at extreme tilt+scale corners crop at the frame edge.
  const rad = (opts.rotationDeg * Math.PI) / 180;
  const cx = targetPx / 2 + (opts.nudgeX / 100) * targetPx;
  const cy = targetPx / 2 + (opts.nudgeY / 100) * targetPx;
  const data = rotatePixelsNearest(
    outlined.data,
    outlined.w,
    outlined.h,
    rad,
    targetPx,
    targetPx,
    cx,
    cy,
  );
  return { data, cellPx, outlinePx, bandPx, outW: outlined.w, outH: outlined.h };
}

function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/**
 * Full compose to an HTMLCanvasElement of targetPx x targetPx. Browser only.
 * Used at low targetPx for live previews and at opts.size for export.
 *
 * Pass a non-null `mask` for HIGHLIGHT mode (per-pixel painted selection);
 * omit it (or pass null) for the unchanged rectangular BOX mode.
 */
export function composeStickerCanvas(
  grid: Grid,
  sel: CellRect,
  opts: StickerOpts,
  targetPx: number,
  mask?: CellMask | null,
): HTMLCanvasElement {
  if (typeof document === "undefined") {
    throw new GridValidationError("composeStickerCanvas requires a browser environment");
  }
  // Pure pipeline: crop/[mask]/keyOut -> raster -> raster outline -> NN rotation.
  const { data } = renderStickerLayer(grid, sel, opts, targetPx, mask);

  const canvas = document.createElement("canvas");
  canvas.width = targetPx;
  canvas.height = targetPx;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new GridValidationError("composeStickerCanvas: could not acquire 2d context");
  // Canvas was just (re)sized — context state is fresh; kill smoothing NOW.
  ctx.imageSmoothingEnabled = false;

  // Background first.
  const bgColour = resolveStickerBackground(grid, sel, opts, mask);
  ctx.fillStyle = bgColour;
  ctx.fillRect(0, 0, targetPx, targetPx);

  // Stage the rotated sticker on its own transparent layer so the shadow can
  // be derived from its alpha and so drawing over the background is a pure
  // axis-aligned integer drawImage (which adds no edge antialiasing).
  const layer = document.createElement("canvas");
  layer.width = targetPx;
  layer.height = targetPx;
  const layerCtx = layer.getContext("2d");
  if (!layerCtx) throw new GridValidationError("composeStickerCanvas: no layer 2d context");
  layerCtx.imageSmoothingEnabled = false;
  layerCtx.putImageData(new ImageData(data, targetPx, targetPx), 0, 0);

  if (opts.shadow.on && opts.shadow.opacity > 0) {
    // Shadow pass: the browser derives the (intentionally soft) shadow from
    // the rotated sticker's alpha. shadowOffset* are in device space.
    ctx.save();
    ctx.shadowColor = withAlpha(darken(bgColour, SHADOW_DARKEN), opts.shadow.opacity);
    ctx.shadowOffsetX = Math.max(1, Math.round(targetPx * 0.015));
    ctx.shadowOffsetY = Math.max(1, Math.round(targetPx * 0.02));
    ctx.shadowBlur = Math.max(1, Math.round(targetPx * 0.02));
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }
  // Sticker pass on top, shadow-free: fully opaque pixels replace exactly,
  // fully transparent pixels leave background/shadow untouched.
  ctx.drawImage(layer, 0, 0);

  return canvas;
}

/**
 * Full pipeline to a PNG blob at opts.size x opts.size. Pass a non-null `mask`
 * to export the painted highlight selection instead of the rectangle.
 */
export function exportSticker(
  grid: Grid,
  sel: CellRect,
  opts: StickerOpts,
  mask?: CellMask | null,
): Promise<Blob> {
  const canvas = composeStickerCanvas(grid, sel, opts, opts.size, mask);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new GridValidationError("exportSticker: canvas.toBlob returned null"));
    }, "image/png");
  });
}
