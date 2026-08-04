import { Grid, GridValidationError } from "./types";
import { recomputePalette } from "./grid";
import { rgbToHex } from "./colour";

/**
 * Recovery path: rebuild the cell grid from an uploaded screenshot or
 * upscaled PNG. This is the ONE place in the engine allowed to use colour
 * distance — everything upstream of it stays exact.
 *
 * Strategy:
 *  1. find columns/rows where adjacent pixels differ sharply (edge signal);
 *  2. fit a 1-D lattice (period + phase) to those REAL edge positions per
 *     axis, RANSAC-style over candidate periods derived from edge spacings,
 *     then refine by least squares — handles margins around the art and
 *     consistent non-integer cell sizes (e.g. a 437px image of 24 cells).
 *     The span of real edges gives a guaranteed "core" art extent; the image
 *     boundaries are only *candidate* extensions (for margin-free crops,
 *     where the art/image edge produces no colour transition);
 *  3. sample each cell near its centre (per-channel median of 5 taps);
 *  4. snap colours to the dominant palette by clustering near-identical
 *     colours;
 *  5. verify the boundary-extension cells by colour: a candidate border
 *     row/column whose colours never occur inside the core extent is margin
 *     (a margin width that happens to be a multiple of the cell period is
 *     geometrically indistinguishable from extra art cells — colour
 *     membership is the tie-breaker, and this is the recovery path where
 *     colour heuristics are explicitly allowed) and is trimmed off.
 */

export type ImageDataLike = { width: number; height: number; data: Uint8ClampedArray }; // RGBA

const EDGE_CHANNEL_THRESHOLD = 40; // max per-channel difference that still counts as "same colour"
const MIN_PERIOD = 3; // px — anything finer is not a plausible upscale
const MAX_CELLS = 128;
const MIN_CELLS = 4;
const CLUSTER_DISTANCE = 32; // Euclidean RGB distance for palette snapping

type Lattice = {
  p: number;
  phase: number;
  /** Extent including image-boundary extension candidates (verified later by colour). */
  kMin: number;
  kMax: number;
  /** Extent certain from real edge signal alone — cells in here are art. */
  kMinCore: number;
  kMaxCore: number;
};

/**
 * Inlier window around a lattice position. Capped well below half the period
 * so k-rounding stays unambiguous even at MIN_PERIOD (a flat 1.5px floor at
 * p=3 equals p/2 and lets the fit lock onto a wrong coarser period).
 */
function latticeTolerance(p: number): number {
  return Math.min(0.35 * p, Math.max(1.5, 0.06 * p));
}

function pixelsDiffer(data: Uint8ClampedArray, i: number, j: number): boolean {
  return (
    Math.abs(data[i] - data[j]) > EDGE_CHANNEL_THRESHOLD ||
    Math.abs(data[i + 1] - data[j + 1]) > EDGE_CHANNEL_THRESHOLD ||
    Math.abs(data[i + 2] - data[j + 2]) > EDGE_CHANNEL_THRESHOLD ||
    Math.abs(data[i + 3] - data[j + 3]) > EDGE_CHANNEL_THRESHOLD
  );
}

/** Positions along `axis` where many pixel pairs change colour. */
function significantEdges(img: ImageDataLike, axis: "x" | "y"): number[] {
  const { width, height, data } = img;
  const size = axis === "x" ? width : height;
  const cross = axis === "x" ? height : width;
  const minCount = Math.max(2, Math.round(cross * 0.02));
  const edges: number[] = [];
  for (let s = 1; s < size; s++) {
    let count = 0;
    for (let t = 0; t < cross; t++) {
      const [x, y] = axis === "x" ? [s, t] : [t, s];
      const i = (y * width + x) * 4;
      const j = axis === "x" ? i - 4 : i - width * 4;
      if (pixelsDiffer(data, i, j)) count++;
    }
    if (count >= minCount) edges.push(s);
  }
  return edges;
}

/**
 * Fit period + phase to a set of 1-D edge positions. Only REAL edges take
 * part in the fit and in the core extent — the image boundaries (0, size)
 * are never fit inputs (a margin boundary that happens to land near the
 * lattice would otherwise silently extend the art extent into the margin);
 * they are recorded as extension candidates for margin-free crops, and the
 * caller verifies those cells by colour before keeping them.
 */
function fitLattice(edges: number[], size: number): Lattice | null {
  const pts = [...new Set(edges)].sort((a, b) => a - b);
  if (pts.length < 3) return null;

  // Candidate periods from consecutive spacings and their integer fractions.
  const candidates: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i] - pts[i - 1];
    for (let m = 1; m <= 6; m++) {
      const c = d / m;
      if (c >= MIN_PERIOD && c <= size / MIN_CELLS) candidates.push(c);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b - a); // largest first: on a tie, prefer the coarser period
  const deduped: number[] = [];
  for (const c of candidates) {
    if (deduped.length === 0 || Math.abs(deduped[deduped.length - 1] - c) > 0.05) {
      deduped.push(c);
    }
  }

  // Score candidates by residual-weighted inlier mass, normalised by the
  // lattice positions the period predicts across the point span. Raw inlier
  // count alone would favour integer subdivisions of the true period (p/2,
  // p/3, ...) because a finer lattice can also absorb stray points;
  // precision weighting penalises the mostly-empty finer lattice. Weighting
  // each inlier by 1 - (d/tol)^2 additionally penalises coarser periods
  // that only graze the true edges near the tolerance boundary — an exact
  // fit scores full weight per point, a sloppy alias does not.
  const span = pts[pts.length - 1] - pts[0];
  let best: { score: number; count: number; p: number; anchor: number; inliers: number[] } | null =
    null;
  for (const c of deduped) {
    const tol = latticeTolerance(c);
    const predicted = Math.floor(span / c) + 1;
    for (const anchor of pts) {
      const inliers: number[] = [];
      let mass = 0;
      for (const e of pts) {
        const k = Math.round((e - anchor) / c);
        const d = Math.abs(e - anchor - k * c);
        if (d <= tol) {
          inliers.push(e);
          mass += 1 - (d / tol) ** 2;
        }
      }
      const score = (mass * mass) / predicted;
      if (best === null || score > best.score) {
        best = { score, count: inliers.length, p: c, anchor, inliers };
      }
    }
  }
  if (best === null || best.count < 3) return null;

  // Least-squares refine: e ~= phase + k * p over the inlier set.
  const ks = best.inliers.map((e) => Math.round((e - best!.anchor) / best!.p));
  const n = ks.length;
  const meanK = ks.reduce((a, b) => a + b, 0) / n;
  const meanE = best.inliers.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varK = 0;
  for (let i = 0; i < n; i++) {
    cov += (ks[i] - meanK) * (best.inliers[i] - meanE);
    varK += (ks[i] - meanK) ** 2;
  }
  if (varK === 0) return null;
  const p = cov / varK;
  if (p < MIN_PERIOD - 1) return null;
  const phase = meanE - p * meanK;

  // Re-assign the real edges against the refined lattice: their span is the
  // guaranteed core art extent (margins are solid colour, so real edges only
  // ever occur inside the art or exactly at its boundary).
  const tol = latticeTolerance(p);
  let kMinCore = Infinity;
  let kMaxCore = -Infinity;
  for (const e of pts) {
    const k = Math.round((e - phase) / p);
    if (Math.abs(e - (phase + k * p)) <= tol) {
      if (k < kMinCore) kMinCore = k;
      if (k > kMaxCore) kMaxCore = k;
    }
  }
  const coreCells = kMaxCore - kMinCore;
  if (!Number.isFinite(coreCells) || coreCells < 1 || coreCells > MAX_CELLS) return null;

  // Image boundaries as extension candidates only: a margin-free crop has its
  // art edge exactly at the image edge (on-lattice, no colour transition), so
  // extend the extent there — but the caller must colour-verify these cells,
  // because a margin whose width is a near-multiple of the period lands
  // on-lattice too. Each side's extension is capped to keep sampling bounded.
  let kMin = kMinCore;
  let kMax = kMaxCore;
  for (const b of [0, size]) {
    const k = Math.round((b - phase) / p);
    if (Math.abs(b - (phase + k * p)) <= tol) {
      if (k < kMin && kMin - k <= MAX_CELLS) kMin = k;
      if (k > kMax && k - kMax <= MAX_CELLS) kMax = k;
    }
  }
  return { p, phase, kMin, kMax, kMinCore, kMaxCore };
}

function median5(v: number[]): number {
  return v.slice().sort((a, b) => a - b)[v.length >> 1];
}

/**
 * Rebuild a Grid from RGBA image data. Throws GridValidationError with a
 * helpful reason when no plausible pixel period can be found.
 */
export function imageToGrid(img: ImageDataLike): {
  grid: Grid;
  recovered: true;
  cellSizePx: number;
  origin: { x: number; y: number };
} {
  const { width, height, data } = img;
  if (width < 24 || height < 24 || data.length < width * height * 4) {
    throw new GridValidationError(
      `image too small or malformed (${width}x${height}) — need at least 24x24 RGBA pixels`,
    );
  }

  const latX = fitLattice(significantEdges(img, "x"), width);
  const latY = fitLattice(significantEdges(img, "y"), height);
  if (!latX || !latY) {
    throw new GridValidationError(
      "no plausible pixel-grid period found — the image does not look like upscaled " +
        "pixel art (try a cleaner screenshot without heavy compression or blur)",
    );
  }

  const gw = latX.kMax - latX.kMin;
  const gh = latY.kMax - latY.kMin;
  const originX = latX.phase + latX.kMin * latX.p;
  const originY = latY.phase + latY.kMin * latY.p;

  // Sample each cell: per-channel median of 5 taps around the cell centre.
  const sampleCell = (cx: number, cy: number): [number, number, number, number] => {
    const cxPx = originX + (cx + 0.5) * latX.p;
    const cyPx = originY + (cy + 0.5) * latY.p;
    const offX = Math.max(1, Math.round(latX.p / 4));
    const offY = Math.max(1, Math.round(latY.p / 4));
    const taps: [number, number][] = [
      [cxPx, cyPx],
      [cxPx - offX, cyPx],
      [cxPx + offX, cyPx],
      [cxPx, cyPx - offY],
      [cxPx, cyPx + offY],
    ];
    const r: number[] = [];
    const g: number[] = [];
    const b: number[] = [];
    const a: number[] = [];
    for (const [tx, ty] of taps) {
      const x = Math.min(width - 1, Math.max(0, Math.floor(tx)));
      const y = Math.min(height - 1, Math.max(0, Math.floor(ty)));
      const i = (y * width + x) * 4;
      r.push(data[i]);
      g.push(data[i + 1]);
      b.push(data[i + 2]);
      a.push(data[i + 3]);
    }
    return [median5(r), median5(g), median5(b), median5(a)];
  };

  type Sample = { r: number; g: number; b: number } | null;
  const samples: Sample[][] = [];
  for (let cy = 0; cy < gh; cy++) {
    const row: Sample[] = [];
    for (let cx = 0; cx < gw; cx++) {
      const [r, g, b, a] = sampleCell(cx, cy);
      row.push(a < 128 ? null : { r, g, b });
    }
    samples.push(row);
  }

  // Snap to the dominant palette: cluster near-identical colours (this is the
  // recovery path — colour distance is explicitly allowed here).
  type Cluster = { rs: number[]; gs: number[]; bs: number[]; cr: number; cg: number; cb: number };
  const clusters: Cluster[] = [];
  const assign = (s: { r: number; g: number; b: number }): Cluster => {
    for (const c of clusters) {
      const d = Math.hypot(s.r - c.cr, s.g - c.cg, s.b - c.cb);
      if (d <= CLUSTER_DISTANCE) {
        c.rs.push(s.r);
        c.gs.push(s.g);
        c.bs.push(s.b);
        const n = c.rs.length;
        c.cr += (s.r - c.cr) / n;
        c.cg += (s.g - c.cg) / n;
        c.cb += (s.b - c.cb) / n;
        return c;
      }
    }
    const fresh: Cluster = { rs: [s.r], gs: [s.g], bs: [s.b], cr: s.r, cg: s.g, cb: s.b };
    clusters.push(fresh);
    return fresh;
  };

  const cellClusters: (Cluster | null)[][] = samples.map((row) =>
    row.map((s) => (s === null ? null : assign(s))),
  );

  const medianOf = (v: number[]): number => {
    const s = v.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  const repHex = new Map<Cluster, string>();
  for (const c of clusters) {
    repHex.set(c, rgbToHex(medianOf(c.rs), medianOf(c.gs), medianOf(c.bs)));
  }

  const cells: (string | null)[][] = cellClusters.map((row) =>
    row.map((c) => (c === null ? null : repHex.get(c)!)),
  );

  // Verify the boundary-extension cells by colour and trim margin rows/cols.
  // Cells between the outermost real edges (the core) are guaranteed art; a
  // candidate border row/column added from an on-lattice image boundary is
  // kept only if some of its colours also occur inside the core. A solid
  // margin strip (whose colour, by definition of the boundary edge, differs
  // from the art it touches and — heuristically — from the rest of the
  // palette) never does, so it is trimmed; a margin-free crop's uniform
  // background rows share the art's background colour and are kept.
  const coreX0 = latX.kMinCore - latX.kMin;
  const coreX1 = latX.kMaxCore - latX.kMin;
  const coreY0 = latY.kMinCore - latY.kMin;
  const coreY1 = latY.kMaxCore - latY.kMin;
  const coreColours = new Set<string>();
  let coreHasNull = false;
  for (let cy = coreY0; cy < coreY1; cy++) {
    for (let cx = coreX0; cx < coreX1; cx++) {
      const c = cells[cy][cx];
      if (c === null) coreHasNull = true;
      else coreColours.add(c);
    }
  }
  const isArtColour = (c: string | null): boolean =>
    c === null ? coreHasNull : coreColours.has(c);

  let top = 0;
  let bottom = gh;
  let left = 0;
  let right = gw;
  const rowForeign = (y: number): boolean => {
    for (let cx = left; cx < right; cx++) if (isArtColour(cells[y][cx])) return false;
    return true;
  };
  const colForeign = (x: number): boolean => {
    for (let cy = top; cy < bottom; cy++) if (isArtColour(cells[cy][x])) return false;
    return true;
  };
  let changed = true;
  while (changed) {
    changed = false;
    while (top < coreY0 && rowForeign(top)) {
      top++;
      changed = true;
    }
    while (bottom > coreY1 && rowForeign(bottom - 1)) {
      bottom--;
      changed = true;
    }
    while (left < coreX0 && colForeign(left)) {
      left++;
      changed = true;
    }
    while (right > coreX1 && colForeign(right - 1)) {
      right--;
      changed = true;
    }
  }

  const w = right - left;
  const h = bottom - top;
  if (w < MIN_CELLS || h < MIN_CELLS || w > MAX_CELLS || h > MAX_CELLS) {
    throw new GridValidationError(
      `recovered grid is ${w}x${h} cells — outside the plausible ` +
        `${MIN_CELLS}..${MAX_CELLS} range (is this really upscaled pixel art?)`,
    );
  }
  const trimmed = cells.slice(top, bottom).map((row) => row.slice(left, right));

  const grid = recomputePalette({ w, h, cells: trimmed, palette: [] });
  return {
    grid,
    recovered: true,
    cellSizePx: (latX.p + latY.p) / 2,
    origin: {
      x: latX.phase + (latX.kMin + left) * latX.p,
      y: latY.phase + (latY.kMin + top) * latY.p,
    },
  };
}
