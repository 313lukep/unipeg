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
 *  2. fit a 1-D lattice (period + phase) to those edge positions per axis,
 *     RANSAC-style over candidate periods derived from edge spacings, then
 *     refine by least squares — handles margins around the art (off-lattice
 *     boundaries become outliers) and consistent non-integer cell sizes
 *     (e.g. a 437px image of 24 cells);
 *  3. sample each cell near its centre (per-channel median of 5 taps);
 *  4. snap colours to the dominant palette by clustering near-identical
 *     colours.
 */

export type ImageDataLike = { width: number; height: number; data: Uint8ClampedArray }; // RGBA

const EDGE_CHANNEL_THRESHOLD = 40; // max per-channel difference that still counts as "same colour"
const MIN_PERIOD = 3; // px — anything finer is not a plausible upscale
const MAX_CELLS = 128;
const MIN_CELLS = 4;
const CLUSTER_DISTANCE = 32; // Euclidean RGB distance for palette snapping

type Lattice = { p: number; phase: number; kMin: number; kMax: number };

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
 * Fit period + phase to a set of 1-D edge positions. The image boundaries
 * (0, size) are included as candidate lattice points so a margin-free crop
 * still anchors the art extent; when the image has margins those boundaries
 * simply become outliers.
 */
function fitLattice(edges: number[], size: number): Lattice | null {
  const pts = [...new Set([0, ...edges, size])].sort((a, b) => a - b);
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

  // Score candidates by inlier count weighted by precision (inliers over
  // lattice positions the period predicts across the point span). Raw inlier
  // count alone would favour integer subdivisions of the true period (p/2,
  // p/3, ...) because a finer lattice can also absorb off-lattice margin
  // boundaries; precision weighting penalises the mostly-empty finer lattice.
  const span = pts[pts.length - 1] - pts[0];
  let best: { score: number; count: number; p: number; anchor: number; inliers: number[] } | null =
    null;
  for (const c of deduped) {
    const tol = Math.max(1.5, 0.06 * c);
    const predicted = Math.floor(span / c) + 1;
    for (const anchor of pts) {
      const inliers = pts.filter((e) => {
        const k = Math.round((e - anchor) / c);
        return Math.abs(e - anchor - k * c) <= tol;
      });
      const score = (inliers.length * inliers.length) / predicted;
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

  // Re-assign every point against the refined lattice to get the art extent.
  const tol = Math.max(1.5, 0.06 * p);
  let kMin = Infinity;
  let kMax = -Infinity;
  for (const e of pts) {
    const k = Math.round((e - phase) / p);
    if (Math.abs(e - (phase + k * p)) <= tol) {
      if (k < kMin) kMin = k;
      if (k > kMax) kMax = k;
    }
  }
  const cells = kMax - kMin;
  if (!Number.isFinite(cells) || cells < MIN_CELLS || cells > MAX_CELLS) return null;
  return { p, phase, kMin, kMax };
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

  const grid = recomputePalette({ w: gw, h: gh, cells, palette: [] });
  return {
    grid,
    recovered: true,
    cellSizePx: (latX.p + latY.p) / 2,
    origin: { x: originX, y: originY },
  };
}
