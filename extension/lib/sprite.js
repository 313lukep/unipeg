/**
 * upegRUN extension — sprite building.
 *
 * Turns a 24x24 Unipeg grid into the run-cycle frames the offline/new-tab game
 * animates. Everything is integer cell maths; the only floating point in the
 * file would be a bug. Canvases are drawn with smoothing off, at an integer
 * scale, so the art stays exactly as the chain drew it.
 */

import { GRID_SIZE, UPEG_COLORS, decodeSeed, gridFromMetadata, gridFromSeed } from "./upeg.js";

const clampInt = (v, lo, hi) => Math.min(Math.max(Math.round(v), lo), hi);

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
 * THE CROUCH — A NECK PIVOT, NOT A SHRINK.
 *
 * The unicorn ducks the way a horse ducks: it drops its head and hunches its
 * shoulders. Everything above the back line — head, horn, mane, wing tips — is
 * translated DOWN by whole cells, and the head leans forward with it wherever
 * the art leaves room; the torso and all four legs are left exactly where they
 * are, so the feet never leave the ground line. Nothing is scaled, nothing is rotated
 * by a fractional angle, no cell is resampled: the crouched unicorn is drawn at
 * the SAME integer scale as the standing one, from the same 24x24 cells.
 *
 * (The old crouch re-rendered the run frames at 3/4 scale. It was crisp, but a
 * unicorn that shrinks is not a unicorn that ducks — the owner rejected it.)
 */

/**
 * Whole cells the front end folds down by. The whole crouch is this number.
 *
 * FIVE, NOT FOUR — and the reason is the low flyer. The lowest a flyer may ever
 * be flown is "just clear of the crouched runner", so the crouch's own height is
 * what decides how close to the ground the low lane can come (game.js
 * `flyerLanes` clamps the lane to the crouch, whatever the tuning asks for).
 * At four cells the crouch was 81% of the stand and the low lane could not come
 * below 0.79 H; at five it is 76% and the lane reaches 0.72 H. Verified against
 * all 6,913 pieces: every one still folds to exactly `DUCK_DROP` cells shorter
 * with its feet on the same row, and the shortest crouch in the collection is
 * still 72% of its stand (at six cells that falls to 67%, which is a squat).
 */
export const DUCK_DROP = 5;

/**
 * Whole cells the head juts forward by, on top of the drop — when it can.
 *
 * Measured across all 6,913 pieces: every one of them already puts its muzzle
 * on the right-hand edge of its own content box, so leaning would make the
 * crouch a WIDER target than the stand, and `safeLean` declines it every time.
 * The parameter stays because the fold is written as geometry rather than as a
 * special case, and a piece that ever left room would use it.
 */
export const DUCK_LEAN = 1;

/**
 * The layers switched off to leave the bare body silhouette behind.
 *
 * The body layer is the one that carries the horse's own topline: torso, neck
 * and skull, with no horn, mane, wings or tail piled on top of it. Re-rendering
 * the piece with everything else off is how the back line is *derived* rather
 * than guessed — it works for every piece and every accessory variant because
 * it asks the contract's own art where the animal's back is.
 */
const BODY_ONLY = {
  horn: 0,
  accessories: 0,
  wings: 0,
  hair: 0,
  tail: 0,
  legsFront: 0,
  legsBack: 0,
  ground: 0,
  eyes: 0,
};

/** Deepest row of the back line the shear is allowed to cut at, as a fraction
 *  of the content box: below this we would be shearing legs, not shoulders. */
const BACK_LINE_LIMIT = 0.7;

/** Topmost painted row of each column, or -1 for an empty column. */
export function topLine(keyed) {
  const width = keyed[0] ? keyed[0].length : 0;
  const out = new Array(width).fill(-1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < keyed.length; y++) {
      if (keyed[y][x] !== null && keyed[y][x] !== undefined) {
        out[x] = y;
        break;
      }
    }
  }
  return out;
}

/**
 * Where the neck meets the shoulders, and which columns the head owns.
 *
 * `backLine`  — the row the shear cuts at. Everything strictly above it folds.
 *               It is the LOWEST high point of the bare body's topline: the
 *               withers/back plateau, with the head and neck rising off it.
 * `split`     — the first column (walking in from the facing side) that still
 *               sits above the back line: the base of the neck.
 * `facing`    — +1 when the piece faces right, -1 when it faces left. Derived
 *               from which half of the box the topline peaks in, so a mirrored
 *               piece would lean the right way without a second code path.
 *
 * With no metadata to re-render (a bare grid handed straight in) it reads the
 * same numbers off the full silhouette instead. That puts the cut a little
 * lower — a wing tip counts as topline — which folds more of the piece than it
 * strictly needs to, and is still a crouch.
 */
export function neckPivot(grid, keyed, box, drop = DUCK_DROP) {
  const silhouette = topLine(keyed);
  let bare = null;
  if (grid && grid.meta && grid.meta.body > 0) {
    const g = gridFromMetadata({ ...grid.meta, ...BODY_ONLY });
    bare = topLine(g.cells.map((row) => row.map((c) => (c === g.bg ? null : c))));
  }
  const line = bare && bare.some((v) => v >= 0) ? bare : silhouette;
  const rows = line.filter((v) => v >= 0);

  // The back line: the deepest point of the topline, i.e. the plateau the head
  // and the wings rise above. Clamped so the fold is always a real fold (at
  // least `drop` cells of art above it) and never reaches down into the legs.
  const deepest = rows.length ? Math.max(...rows) : box.y + drop;
  const backLine = clampInt(
    deepest,
    box.y + drop,
    box.y + Math.floor(box.h * BACK_LINE_LIMIT),
  );

  // Facing: the column the topline peaks in, relative to the box's centre.
  let peak = box.x;
  let peakRow = Infinity;
  for (let x = 0; x < line.length; x++) {
    if (line[x] >= 0 && line[x] < peakRow) {
      peakRow = line[x];
      peak = x;
    }
  }
  const facing = peak >= box.x + box.w / 2 ? 1 : -1;

  // The neck's base: walk in from the facing edge while the topline is still
  // above the back line. Those columns are head, crest and neck. Columns the
  // bare body does not reach (a horn tip hanging over the edge) are stepped
  // over rather than treated as the end of the neck.
  let split = facing > 0 ? GRID_SIZE : -1; // "no head columns" until one is found
  for (let i = 0; i < box.w; i++) {
    const x = facing > 0 ? box.x + box.w - 1 - i : box.x + i;
    if (line[x] < 0) continue;
    if (line[x] >= backLine) break;
    split = x;
  }
  return { backLine, split, facing };
}

/** True for the columns the head and neck occupy, given a pivot. */
function isHeadColumn(pivot, x) {
  return pivot.facing > 0 ? x >= pivot.split : x <= pivot.split;
}

/**
 * Fold one keyed frame into its crouch.
 *
 * Every painted cell above `backLine` moves down `drop` cells; the head columns
 * also move `lean` cells forward. Cells that land on the torso simply overwrite
 * it — this is a silhouette, not a stack of sprites. Integer cells throughout;
 * the result is another 24x24 keyed grid.
 *
 * Because the whole of the art above the back line moves down by the same whole
 * number, the crouch is exactly `drop` cells shorter than the stand: the tallest
 * thing left is either the moved topline (box.y + drop) or the back line itself,
 * and the clamp in `neckPivot` guarantees the first of those wins.
 */
export function duckCells(keyed, pivot, options = {}) {
  const drop = Math.max(0, Math.round(options.drop ?? DUCK_DROP));
  const lean = Math.max(0, Math.round(options.lean ?? DUCK_LEAN)) * pivot.facing;
  const out = keyed.map((row) => row.slice());
  for (let y = 0; y < pivot.backLine; y++) {
    for (let x = 0; x < out[y].length; x++) out[y][x] = null;
  }
  for (let y = 0; y < pivot.backLine; y++) {
    const row = keyed[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      const colour = row[x];
      if (colour === null || colour === undefined) continue;
      const nx = x + (isHeadColumn(pivot, x) ? lean : 0);
      const ny = y + drop;
      if (nx < 0 || nx >= GRID_SIZE || ny < 0 || ny >= GRID_SIZE) continue;
      out[ny][nx] = colour;
    }
  }
  return out;
}

/**
 * The lean, but only when the head has somewhere to lean *into*.
 *
 * A crouch must never be a bigger target than a stand, so the forward shift is
 * dropped whenever it would push a painted cell past the standing silhouette's
 * own edge (or off the grid). Most pieces already reach the edge of the box
 * with their muzzle, so this quietly resolves to a straight-down fold — which
 * still reads as head-down, and keeps the hitbox honest.
 */
export function safeLean(keyed, box, pivot, lean = DUCK_LEAN) {
  if (lean <= 0) return 0;
  const edge = pivot.facing > 0 ? box.x + box.w - 1 : box.x;
  for (let y = 0; y < pivot.backLine; y++) {
    const row = keyed[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      if (row[x] === null || row[x] === undefined) continue;
      if (!isHeadColumn(pivot, x)) continue;
      const nx = x + lean * pivot.facing;
      if (nx < 0 || nx >= GRID_SIZE) return 0;
      if (pivot.facing > 0 ? nx > edge : nx < edge) return 0;
    }
  }
  return lean;
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
 * FLAP: the same piece rendered with two wing variants, body, horn, tail and
 * legs identical between the two frames. Verified by rendering both frames and
 * looking at them.
 *
 * LEVELLING THE POSE. Nothing rotates the flyer; the tilt the owner saw was the
 * piece's own stance. #39 stands like every Unipeg does — forelegs gathered
 * under the chest, hind legs planted and trailing — and once it is in the air
 * with nothing to stand on, "front end up, back end down" reads as a horse
 * rearing rather than a creature flying. The fix is which layers it is built
 * from, not a transform:
 *
 *   - `legsBack` is switched off. The trailing hind legs were the whole of the
 *     downward slope at the back; without them the belly is a straight line and
 *     the rump is level with the chest. The gathered forelegs stay, so the
 *     creature still reads as a horse with its legs tucked up — the pegasus
 *     pose — rather than as a wing with a head on it.
 *   - The wing cycle leads with variant 2, the flatter of the owner's two
 *     swept wings, so the resting frame is the level one.
 *
 * Measured on the mirrored silhouette (regression of each column's centre of
 * mass against x, i.e. how far the shape falls from nose to tail):
 *
 *   full piece, wings 1 / 2      slope 0.319 / 0.297   nose-to-tail drop 4.7 / 4.3 cells
 *   legsBack off, wings 2 / 1    slope 0.196 / 0.219   nose-to-tail drop 2.5 / 2.9 cells
 *
 * Rejected after rendering them: dropping BOTH leg layers (a flat-bottomed
 * slab; the metric gets worse, 0.414, because the tail is then the only thing
 * below the belly), dropping only `legsFront` (worse still, 0.515 — the hind
 * legs alone read as a dive), and dropping the tail as well (a rectangle with
 * a horn). None of the other 14 hind-leg variants tuck; they all plant.
 */
export const FLYER_PIECE_ID = 39;
export const FLYER_SEED = 1927359419702180163628542380460131660334337n;
// Owner's pick: the broad, sharp swept wing. Variants 1 and 2 are the same
// large triangular wing with a hard leading edge (pterodactyl-like); the tip
// position differs just enough between them to read as one wing beating
// rather than two different creatures. Variant 2 leads because it sits flatter.
export const FLYER_WING_CYCLE = [2, 1];
/**
 * Layers overridden on the flyer, on top of the piece's own traits.
 * `ground` because a creature in flight carries no ground strip; `legsBack`
 * because trailing hind legs are what made it read as a rearing horse.
 */
export const FLYER_LAYERS = { ground: 0, legsBack: 0 };
export const FLYER_INK = "#0b0b0d";
/**
 * The eye. Red, at the owner's request — and one specific red, because it is
 * the only cell of the flyer that is not the silhouette and it has two very
 * different neighbours: the near-black body it sits inside, and the near-white
 * board that shows through around the creature.
 *
 *   #e5484d  vs FLYER_INK #0b0b0d  5.02:1     vs a white board  3.91:1
 *   #d92b2b  vs FLYER_INK          4.06:1     vs white          4.85:1
 *   #ff4d4d  vs FLYER_INK          6.01:1     vs white          3.27:1
 *
 * #e5484d is the one that clears 3.5:1 in BOTH directions — a darker red
 * disappears into the head, a brighter one washes out against the board.
 */
export const FLYER_EYE = "#e5484d";
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
    ...FLYER_LAYERS,
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
  //
  // The crouch keeps the run cycle's frame count — the legs go on galloping
  // while the head is down — and keeps the run cycle's scale. Only the cells
  // move. Its own box is measured from the folded cells, so the game's hitbox
  // is exactly the picture: shorter by `drop` cells, feet on the same row.
  const drop = Math.max(0, Math.round(options.duckDrop ?? DUCK_DROP));
  const pivot = neckPivot(grid, keyedFrames[0], box, drop);
  const lean = safeLean(keyedFrames[0], box, pivot, options.duckLean ?? DUCK_LEAN);
  const ducked = keyedFrames.map((keyed) => duckCells(keyed, pivot, { drop, lean }));
  const duckBox = runCycleBounds(ducked) || box;
  frames.duck = withMeta(
    renderCycle(ducked, bobFrames, duckBox, scale, bobbing),
    scale,
    duckBox,
    bobbing,
  );
  frames.duck.pivot = { ...pivot, drop, lean };
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
