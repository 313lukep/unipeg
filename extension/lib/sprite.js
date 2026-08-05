/**
 * unipegPFP extension — sprite building.
 *
 * Turns a 24x24 Unipeg grid into the run-cycle frames the offline/new-tab game
 * animates. Everything is integer cell maths; the only floating point in the
 * file would be a bug. Canvases are drawn with smoothing off, at an integer
 * scale, so the art stays exactly as the chain drew it.
 */

import { GRID_SIZE, UPEG_COLORS, decodeSeed, gridFromMetadata, gridFromSeed } from "./upeg.js";

/**
 * THE RUN CYCLE.
 *
 * The contract ships 15 legsFront and 15 legsBack variants. They are alternate
 * *art styles*, not animation frames, so most pairings read as a glitch rather
 * than a gallop. These two were picked by rendering all 15x2 variants and
 * looking at them: both pairs plant their feet on the same row (grid y=22), so
 * the silhouette never bobs, and they differ exactly the way a galloping horse
 * differs — gathered under the body, then extended fore and aft.
 *
 *   frame 0 — legsFront 11 / legsBack 1  : legs gathered, near-vertical
 *   frame 1 — legsFront 13 / legsBack 10 : legs extended, feet spread
 *
 * Every other layer (body, horn, hair, tail, wings, eyes) is re-rendered
 * identically, and the legs are painted in the piece's own bodyColor, so the
 * gallop still belongs to the user's unicorn.
 */
export const RUN_CYCLE = [
  { legsFront: 11, legsBack: 1 },
  { legsFront: 13, legsBack: 10 },
];

/** Default integer upscale: 24 cells x 4 = 96px tall before trimming. */
export const DEFAULT_SCALE = 4;

/**
 * THE CROUCH.
 *
 * Ducking re-renders the same run cycle at a SMALLER INTEGER SCALE, not a
 * squashed blit: 4x becomes 3x, 8x becomes 6x. Every cell is still a whole
 * number of device pixels, so the crouched unicorn is exactly as crisp as the
 * standing one — a fractional squash would smear it, which is the one thing
 * this codebase does not do.
 *
 * Three quarters is the only ratio that stays integral at both of the scales
 * the page actually uses (4 and 8), and it leaves the duck comfortably under
 * the low flyer while still being a big enough target to be hit by everything
 * else.
 */
export const DUCK_RATIO = 3 / 4;

/**
 * Run scale -> duck scale. Rounds DOWN, so the ratio is never above 3/4 at any
 * scale: an odd scale that rounded up would give the game a crouch barely
 * smaller than the stand, and the flyer lanes are built on this bound.
 */
export function duckScaleFor(scale) {
  return Math.max(1, Math.floor(Math.max(1, scale) * DUCK_RATIO));
}

/* ------------------------------------------------------------- the flyer */

/**
 * THE FLYER — an all-black winged Unipeg, this game's pterodactyl.
 *
 * Built from a REAL alive piece: #39, which ships wings variant 6 and horn 5.
 * Its seed is a verbatim copy of `data/upeg-alive.json`'s entry for id 39 (the
 * test asserts the two never drift apart), so the creature is a genuine piece
 * rather than invented art.
 *
 * Every painted cell is forced to one near-black, which turns the piece into a
 * silhouette: a shadow of a unicorn rather than a second unicorn. The eyes are
 * the single exception — left light so the creature reads as alive and aimed at
 * you. Punching the eye out to transparent would have been invisible instead:
 * the page's own paper is the same near-black.
 *
 * FLAP: wings 6 (raised) alternating with wings 12 (extended), body, horn,
 * tail and legs identical between the two frames. Verified by rendering both
 * frames and looking at them.
 */
export const FLYER_PIECE_ID = 39;
export const FLYER_SEED = 1927359419702180163628542380460131660334337n;
export const FLYER_WING_CYCLE = [6, 12];
export const FLYER_INK = "#0b0b0d";
export const FLYER_EYE = "#f7f7f8";
/** Flyer scale relative to the runner's. Integer at both page scales (4, 8). */
export const FLYER_RATIO = 3 / 4;

/** Rounds down for the same reason duckScaleFor does. */
export function flyerScaleFor(scale) {
  return Math.max(1, Math.floor(Math.max(1, scale) * FLYER_RATIO));
}

/**
 * Two palette slots used purely as tags: every layer is painted with
 * SENTINEL_INK and only the eyes with SENTINEL_EYE, so the two can be told
 * apart afterwards without guessing at colours. They must be distinct, and
 * distinct from the piece's background (the test pins all three).
 */
const SENTINEL_INK = 32; // #1e1e26
const SENTINEL_EYE = 35; // #00ffd0

/** The two flap grids: identical but for the wing variant. */
export function buildFlyerGrids() {
  const meta = decodeSeed(FLYER_SEED);
  const base = {
    ...meta,
    // A creature in flight carries no ground strip.
    ground: 0,
    bodyColor: SENTINEL_INK,
    hairColor: SENTINEL_INK,
    hornColor: SENTINEL_INK,
    groundColor: SENTINEL_INK,
    accessoriesColor: SENTINEL_INK,
    tailColor: SENTINEL_INK,
    eyesColor: SENTINEL_EYE,
  };
  return FLYER_WING_CYCLE.map((wings) => gridFromMetadata({ ...base, wings }));
}

/** Background -> transparent, every painted cell -> black, eyes -> light. */
export function shadowCells(grid) {
  const eye = UPEG_COLORS[SENTINEL_EYE % UPEG_COLORS.length];
  return grid.cells.map((row) =>
    row.map((c) => (c === grid.bg ? null : c === eye ? FLYER_EYE : FLYER_INK)),
  );
}

/** Mirror a cell grid left-to-right. Exact: pixel art, reversed rows. */
export function mirrorCells(cells) {
  return cells.map((row) => row.slice().reverse());
}

/**
 * Build the flyer's two flap frames, mirrored so it faces the runner it is
 * flying at. Same-size canvases sharing one box, so the wingbeat never shifts
 * the body. Returns an array carrying `.cellPx` and `.box`.
 */
export function buildFlyerFrames(options = {}) {
  const scale = Math.max(1, Math.round(options.scale || DEFAULT_SCALE));
  const keyed = buildFlyerGrids().map((g) => mirrorCells(shadowCells(g)));
  const box = runCycleBounds(keyed);
  const frames = !box
    ? []
    : keyed.map((cells) => {
        const canvas = createCanvas(box.w * scale, box.h * scale);
        drawKeyedCells(pixelContext(canvas), cells, box, scale, 0, 0, 0);
        return canvas;
      });
  frames.cellPx = scale;
  frames.box = box;
  frames.style = "wing-flap";
  return frames;
}

/**
 * Grids for the run cycle. Needs `grid.meta` (gridFromSeed supplies it); given
 * a bare grid there is no way to re-render the legs, so the caller gets a
 * single-frame cycle and buildRunFrames falls back to a body bob.
 */
export function buildRunCycleGrids(grid) {
  if (!grid || !grid.meta) return [grid];
  // A piece whose legs the contract does not draw (variant 0 or an id with no
  // art) has nothing to animate — leave it alone rather than growing legs.
  if (grid.meta.legsFront === 0 && grid.meta.legsBack === 0) return [grid];
  const seed = metadataSeed(grid.meta);
  return RUN_CYCLE.map((legs) => gridFromSeed(seed, legs));
}

/** Re-encode metadata to a seed so gridFromSeed can re-render with overrides. */
function metadataSeed(m) {
  return (
    (BigInt(m.backGroundColor) << 0n) |
    (BigInt(m.horn) << 8n) |
    (BigInt(m.accessories) << 16n) |
    (BigInt(m.hair) << 24n) |
    (BigInt(m.wings) << 32n) |
    (BigInt(m.tail) << 40n) |
    (BigInt(m.legsFront) << 48n) |
    (BigInt(m.legsBack) << 56n) |
    (BigInt(m.eyes) << 64n) |
    (BigInt(m.body) << 72n) |
    (BigInt(m.ground) << 80n) |
    (BigInt(m.bodyColor) << 88n) |
    (BigInt(m.eyesColor) << 96n) |
    (BigInt(m.hairColor) << 104n) |
    (BigInt(m.hornColor) << 112n) |
    (BigInt(m.groundColor) << 120n) |
    (BigInt(m.accessoriesColor) << 128n) |
    (BigInt(m.tailColor) << 136n)
  );
}

/**
 * Key the piece's own background out to transparent.
 * Returns cells where a background cell is `null`.
 *
 * This is exact, never fuzzy: the 6 background colours and the 36 layer colours
 * are disjoint sets in the contract, so no unicorn pixel can ever be mistaken
 * for backdrop.
 */
export function keyOutBackground(grid) {
  return grid.cells.map((row) => row.map((c) => (c === grid.bg ? null : c)));
}

/**
 * Tight bounding box of the non-null cells, as integer cell coordinates.
 * Returns `{ x, y, w, h }`, or null when nothing is painted.
 */
export function contentBounds(keyed) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < keyed.length; y++) {
    for (let x = 0; x < keyed[y].length; x++) {
      if (keyed[y][x] === null) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Smallest box containing every given box. */
export function unionBounds(boxes) {
  const real = boxes.filter(Boolean);
  if (!real.length) return null;
  const x = Math.min(...real.map((b) => b.x));
  const y = Math.min(...real.map((b) => b.y));
  const x2 = Math.max(...real.map((b) => b.x + b.w));
  const y2 = Math.max(...real.map((b) => b.y + b.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

/** Every frame shares one box, so the sprite never jitters between frames. */
export function runCycleBounds(keyedFrames) {
  return unionBounds(keyedFrames.map(contentBounds));
}

function createCanvas(width, height) {
  if (typeof document !== "undefined" && document.createElement) {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  }
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  throw new Error("no canvas implementation available");
}

function pixelContext(canvas) {
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/**
 * Draw a full 24x24 grid (background included) at `cellPx` per cell,
 * top-left at (dx, dy). Integer geometry only, smoothing off.
 */
export function drawGrid(ctx, grid, cellPx, dx = 0, dy = 0) {
  ctx.imageSmoothingEnabled = false;
  const size = cellPx | 0;
  const ox = dx | 0;
  const oy = dy | 0;
  for (let y = 0; y < GRID_SIZE; y++) {
    const row = grid.cells[y];
    for (let x = 0; x < GRID_SIZE; x++) {
      // Run the row out as far as the colour holds, so we issue one fillRect
      // per run instead of one per cell.
      const colour = row[x];
      let end = x + 1;
      while (end < GRID_SIZE && row[end] === colour) end++;
      ctx.fillStyle = colour;
      ctx.fillRect(ox + x * size, oy + y * size, (end - x) * size, size);
      x = end - 1;
    }
  }
}

/** Paint keyed cells (nulls skipped) cropped to `box`, at `cellPx` per cell. */
export function drawKeyedCells(ctx, keyed, box, cellPx, dx = 0, dy = 0, cellOffsetY = 0) {
  ctx.imageSmoothingEnabled = false;
  const size = cellPx | 0;
  for (let y = box.y; y < box.y + box.h; y++) {
    const row = keyed[y];
    if (!row) continue;
    for (let x = box.x; x < box.x + box.w; x++) {
      const colour = row[x];
      if (colour === null || colour === undefined) continue;
      let end = x + 1;
      while (end < box.x + box.w && row[end] === colour) end++;
      ctx.fillStyle = colour;
      ctx.fillRect(
        (dx | 0) + (x - box.x) * size,
        (dy | 0) + (y - box.y + cellOffsetY) * size,
        (end - x) * size,
        size,
      );
      x = end - 1;
    }
  }
}

/**
 * Build the animated run frames for a piece.
 *
 * - background keyed out to transparent, so the unicorn stands on the game's
 *   ground rather than in a coloured box
 * - trimmed to the union content box across the cycle (no inter-frame jitter)
 * - integer scale, smoothing off
 *
 * Returns an array of canvases, all the same size. The array carries
 * `.cellPx`, `.box` and `.style` for the game to read.
 */
export function buildRunFrames(grid, options = {}) {
  const scale = Math.max(1, Math.round(options.scale || DEFAULT_SCALE));
  const cycle = buildRunCycleGrids(grid);
  const keyedFrames = cycle.map(keyOutBackground);

  // Fallback cycle: with no leg variants to swap we animate a 1-cell body bob,
  // which still reads as a run and keeps the feet planted.
  const bobbing = keyedFrames.length < 2;
  const bobFrames = bobbing ? [0, -1] : keyedFrames.map(() => 0);

  const box = runCycleBounds(keyedFrames);
  if (!box) return withMeta([], scale, null, bobbing);

  const frames = renderCycle(keyedFrames, bobFrames, box, scale, bobbing);
  withMeta(frames, scale, box, bobbing);

  // The game needs three sprite sets and only ever receives one array, so the
  // other two ride along on it. Both are built here rather than in the game so
  // every scale decision stays in one file, next to the integer-scale rule.
  const duckScale = duckScaleFor(scale);
  frames.duck = withMeta(
    renderCycle(keyedFrames, bobFrames, box, duckScale, bobbing),
    duckScale,
    box,
    bobbing,
  );
  frames.flyer = buildFlyerFrames({ scale: flyerScaleFor(scale) });
  return frames;
}

/** Paint one cycle's keyed frames into same-size canvases at `scale`. */
function renderCycle(keyedFrames, bobFrames, box, scale, bobbing) {
  const width = box.w * scale;
  const height = (box.h + (bobbing ? 1 : 0)) * scale;
  return bobFrames.map((bob, i) => {
    const canvas = createCanvas(width, height);
    const ctx = pixelContext(canvas);
    const keyed = keyedFrames[Math.min(i, keyedFrames.length - 1)];
    // The bob lifts the whole piece by one cell on alternate frames; the extra
    // row at the bottom of the canvas is the headroom that lift needs.
    drawKeyedCells(ctx, keyed, box, scale, 0, 0, bobbing ? bob + 1 : 0);
    return canvas;
  });
}

function withMeta(frames, cellPx, box, bobbing) {
  frames.cellPx = cellPx;
  frames.box = box;
  frames.style = bobbing ? "body-bob" : "leg-swap";
  return frames;
}
