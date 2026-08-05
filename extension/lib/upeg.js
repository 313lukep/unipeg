/**
 * unipegPFP extension — offline Unipeg renderer.
 *
 * A plain browser ES module (no build step, no npm, no network). It is a direct
 * port of the repo's fixture-verified TypeScript renderer
 * (src/lib/upeg/{palette,seed,renderer}.ts), except that it builds the 24x24
 * colour grid DIRECTLY from the layer rects instead of emitting SVG and
 * rasterising it. Correctness is anchored by extension/lib/__tests__/upeg.test.ts,
 * which compares this grid against the grid parsed out of real on-chain SVG
 * fixtures.
 *
 * Nothing here ever touches the network: layer geometry is a static import and
 * the id->seed snapshot is read from the extension's own bundle.
 */

import LAYER_DATA from "../data/layers.js";

/** Main colour palette — layer colour indices are modulo 36. */
export const UPEG_COLORS = [
  "#a9b6d2", "#cbdbfc", "#eae1b5", "#d9a066", "#9dcde4", "#8f563b",
  "#524b24", "#ac3232", "#d77bba", "#847e87", "#626979", "#306082",
  "#323c39", "#306082", "#6e3e54", "#cb67d2", "#37946e", "#df7126",
  "#d95763", "#5fcde4", "#d2ac8d", "#cbdbfc", "#696a6a", "#e7d632",
  "#e76232", "#cee6f3", "#e79090", "#fcf893", "#edb187", "#b3dcf7",
  "#4b8b3b", "#7fc97f", "#1e1e26", "#2d1b1b", "#a0a0a0", "#00ffd0",
];

/** Background palette — background colour index is modulo 6. */
export const UPEG_BACKGROUND_COLORS = [
  "#1a1c2c", "#3a3f58", "#cbbba0", "#7a8ca8", "#394b3f", "#2e243f",
];

/** The art is a 24x24 grid. This is the one fact the whole codebase rests on. */
export const GRID_SIZE = 24;

/** Paint order, verbatim from SvgGenerator.generateSvg. */
const PAINT_ORDER = [
  ["body", "bodyColor"],
  ["horn", "hornColor"],
  ["accessories", "accessoriesColor"],
  ["wings", "bodyColor"], // wings reuse the body colour
  ["hair", "hairColor"],
  ["tail", "tailColor"],
  ["legsFront", "bodyColor"], // both leg layers reuse the body colour
  ["legsBack", "bodyColor"],
  ["ground", "groundColor"],
  ["eyes", "eyesColor"],
];

const LAYERS = LAYER_DATA.layers;

/** variant -> rects lookup, built once per layer. */
const VARIANT_INDEX = (() => {
  const index = {};
  for (const name of Object.keys(LAYERS)) {
    const byVariant = new Map();
    for (const layer of LAYERS[name]) byVariant.set(layer.variant, layer.rects);
    index[name] = byVariant;
  }
  return index;
})();

/** How many variants each layer ships (used by the run-cycle builder). */
export function layerVariants(name) {
  const byVariant = VARIANT_INDEX[name];
  return byVariant ? [...byVariant.keys()] : [];
}

/**
 * Seed byte layout, ported from the verified UpegMetadataLibrary.
 * Trait value 0 = layer absent; colour value 0 = real palette index 0.
 */
export function decodeSeed(seed) {
  const s = typeof seed === "bigint" ? seed : BigInt(seed);
  const byte = (shift) => Number((s >> shift) & 0xffn);
  return {
    backGroundColor: byte(0n),
    horn: byte(8n),
    accessories: byte(16n),
    hair: byte(24n),
    wings: byte(32n),
    tail: byte(40n),
    legsFront: byte(48n),
    legsBack: byte(56n),
    eyes: byte(64n),
    body: byte(72n),
    ground: byte(80n),
    bodyColor: byte(88n),
    eyesColor: byte(96n),
    hairColor: byte(104n),
    hornColor: byte(112n),
    groundColor: byte(120n),
    accessoriesColor: byte(128n),
    tailColor: byte(136n),
  };
}

function colourAt(i) {
  return UPEG_COLORS[i % UPEG_COLORS.length];
}

function backgroundAt(i) {
  return UPEG_BACKGROUND_COLORS[i % UPEG_BACKGROUND_COLORS.length];
}

function paintLayer(cells, name, variant, fill) {
  const rects = VARIANT_INDEX[name] && VARIANT_INDEX[name].get(variant);
  // The contract renders nothing for an unknown variant id (empty storage array).
  if (!rects) return;
  for (const [x, y, w, h] of rects) {
    const y1 = Math.min(y + h, GRID_SIZE);
    const x1 = Math.min(x + w, GRID_SIZE);
    for (let row = Math.max(y, 0); row < y1; row++) {
      const line = cells[row];
      for (let col = Math.max(x, 0); col < x1; col++) line[col] = fill;
    }
  }
}

/**
 * Build the 24x24 colour grid for decoded metadata.
 * Returns `{ cells, bg, meta }` — `cells[y][x]` is a lowercase hex string.
 */
export function gridFromMetadata(meta) {
  const bg = backgroundAt(meta.backGroundColor);
  const cells = [];
  for (let y = 0; y < GRID_SIZE; y++) cells.push(new Array(GRID_SIZE).fill(bg));
  for (const [name, colourKey] of PAINT_ORDER) {
    const variant = meta[name];
    if (variant > 0) paintLayer(cells, name, variant, colourAt(meta[colourKey]));
  }
  return { cells, bg, meta };
}

/**
 * Build the 24x24 colour grid straight from a seed.
 * `overrides` lets callers swap individual traits (the run cycle swaps leg
 * variants) while keeping every other layer identical.
 */
export function gridFromSeed(seed, overrides) {
  const meta = decodeSeed(seed);
  return gridFromMetadata(overrides ? { ...meta, ...overrides } : meta);
}

/**
 * Distinct non-background colours in the grid, most-used first.
 * The game paints obstacles from this so every user's run looks like their piece.
 */
export function paletteFromGrid(grid) {
  const counts = new Map();
  for (const row of grid.cells) {
    for (const colour of row) {
      if (colour === grid.bg) continue;
      counts.set(colour, (counts.get(colour) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

/* --------------------------------------------------------------------------
 * Bundled alive snapshot (id -> seed), loaded lazily and cached forever.
 * fetch() against a chrome-extension:// URL is served from the local bundle,
 * so this works with the network fully off.
 * ------------------------------------------------------------------------ */

const SNAPSHOT_PATH = "data/upeg-alive.json";

let snapshotPromise = null;

function snapshotUrl() {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(SNAPSHOT_PATH);
  }
  // Plain-page / test fallback: resolve relative to this module.
  return new URL("../" + SNAPSHOT_PATH, import.meta.url).href;
}

/** Load (once) the bundled id -> seed snapshot. Resolves to a plain object. */
export function loadAliveSnapshot() {
  if (!snapshotPromise) {
    snapshotPromise = fetch(snapshotUrl())
      .then((res) => {
        if (!res.ok) throw new Error("upeg snapshot HTTP " + res.status);
        return res.json();
      })
      .catch((err) => {
        snapshotPromise = null; // allow a later retry
        throw err;
      });
  }
  return snapshotPromise;
}

/** Seed for an alive piece id, or null if that id is not in the snapshot. */
export async function seedForId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) return null;
  const snapshot = await loadAliveSnapshot();
  const raw = snapshot[String(n)];
  return raw === undefined ? null : BigInt(raw);
}

/** How many pieces the bundled snapshot knows about. */
export async function aliveCount() {
  const snapshot = await loadAliveSnapshot();
  return Object.keys(snapshot).length;
}

/** Every id in the snapshot, ascending. Handy for "random piece". */
export async function aliveIds() {
  const snapshot = await loadAliveSnapshot();
  return Object.keys(snapshot).map(Number).sort((a, b) => a - b);
}

/** A random alive id — the new tab's fallback when nothing is saved yet. */
export async function randomAliveId() {
  const ids = await aliveIds();
  if (!ids.length) return null;
  return ids[Math.floor(Math.random() * ids.length)];
}
