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
 *     where the art/image edge produces no colour transition). If the fitted
 *     extent leaves an image-boundary strip unexplained AND a low-contrast
 *     colour transition hides inside that strip (a margin colour within the
 *     strong edge threshold of the art background — e.g. a white margin
 *     around pastel art), edge extraction is re-run at a lower threshold and
 *     the fit that explains more of the image wins;
 *  3. sample each cell near its centre (per-channel median of 5 taps),
 *     measuring the sampling noise actually present inside cells while
 *     doing so;
 *  4. snap colours to the dominant palette by clustering, with a merge
 *     radius scaled by the measured sampling noise: exact samples keep exact
 *     colours (genuinely distinct close shades survive), noisy samples merge
 *     within a radius proportional to the noise; a tiny stray cluster
 *     hugging a far larger one is additionally absorbed as noise;
 *  5. verify the boundary-extension cells by colour: a candidate border
 *     row/column whose colours never occur inside the core extent is margin
 *     (a margin width that happens to be a multiple of the cell period is
 *     geometrically indistinguishable from extra art cells — colour
 *     membership is the tie-breaker, and this is the recovery path where
 *     colour heuristics are explicitly allowed) and is trimmed off.
 *
 * ACCEPTED AMBIGUITY (documented behaviour, not a defect): a margin painted
 * in exactly the art's background colour whose width is a whole number of
 * cells is indistinguishable from a larger canvas. It produces no edge
 * signal, its boundary sits on the lattice, and its colour legitimately
 * occurs inside the art, so no geometric or colour signal can tell the two
 * apart — such a margin is KEPT as extra background cells. A 24x24 art
 * surrounded by a 2-cell background-coloured margin recovers as 28x28.
 */

export type ImageDataLike = { width: number; height: number; data: Uint8ClampedArray }; // RGBA

/** Max per-channel difference that still counts as "same colour" for edges. */
const EDGE_CHANNEL_THRESHOLD = 40;
/**
 * Fallback edge threshold used only when the strong-threshold fit leaves an
 * image-boundary strip unexplained that provably hides a lower-contrast
 * transition (see fitAxis). Kept above typical sampling noise so noisy but
 * healthy inputs never take this path.
 */
const LOW_EDGE_CHANNEL_THRESHOLD = 12;
const MIN_PERIOD = 3; // px — anything finer is not a plausible upscale
const MAX_CELLS = 128;
const MIN_CELLS = 4;

// Palette snapping (step 4). The merge radius adapts to measured sampling
// noise instead of using a flat distance: flat 32 used to fold genuinely
// distinct close shades (e.g. #ffb0e0 vs #ff9ad5, distance 24.6) into one
// colour even when sampling was exact.
const CLUSTER_DISTANCE_MAX = 32; // radius ceiling for very noisy input (the old flat value)
const CLUSTER_DISTANCE_MIN = 2; // exact samples: fold only near-identical colours
const CLUSTER_NOISE_FACTOR = 3; // merge radius per unit of measured per-channel noise
const STRAY_MERGE_DISTANCE = 8; // a cluster this close to a dominant one may be noise...
const STRAY_COUNT_RATIO = 8; // ...but only when the dominant one is >= 8x larger

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

function pixelsDiffer(
  data: Uint8ClampedArray,
  i: number,
  j: number,
  threshold: number,
): boolean {
  return (
    Math.abs(data[i] - data[j]) > threshold ||
    Math.abs(data[i + 1] - data[j + 1]) > threshold ||
    Math.abs(data[i + 2] - data[j + 2]) > threshold ||
    Math.abs(data[i + 3] - data[j + 3]) > threshold
  );
}

/** Positions along `axis` where many pixel pairs change colour. */
function significantEdges(img: ImageDataLike, axis: "x" | "y", threshold: number): number[] {
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
      if (pixelsDiffer(data, i, j, threshold)) count++;
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

/**
 * Fit one axis, then validate that the fit explains the full image extent.
 *
 * A margin colour within EDGE_CHANNEL_THRESHOLD of the art's background
 * (e.g. a white margin around pastel art) yields no strong edge at the
 * margin/art boundary; with an off-lattice margin width the strong-edge fit
 * then spans only the non-background content, silently cropping the art. So:
 * when the fitted extent leaves an image-boundary strip unexplained AND
 * low-threshold edge extraction finds a transition hiding inside that strip,
 * refit from the low-threshold edges and keep whichever fit explains more of
 * the image. A genuinely solid margin strip has no transition at any
 * threshold and never triggers the refit (the colour-verification step trims
 * it instead), and sampling noise stays below LOW_EDGE_CHANNEL_THRESHOLD.
 */
function fitAxis(img: ImageDataLike, axis: "x" | "y"): Lattice | null {
  const size = axis === "x" ? img.width : img.height;
  const fit = fitLattice(significantEdges(img, axis, EDGE_CHANNEL_THRESHOLD), size);
  if (fit === null) return null;

  const tol = latticeTolerance(fit.p);
  const start = fit.phase + fit.kMin * fit.p;
  const end = fit.phase + fit.kMax * fit.p;
  if (start <= tol && end >= size - tol) return fit; // extent reaches both image edges

  const lowEdges = significantEdges(img, axis, LOW_EDGE_CHANNEL_THRESHOLD);
  const hidden = lowEdges.some((e) => e < start - tol || e > end + tol);
  if (!hidden) return fit; // the strips are solid margin — nothing unexplained

  const lowFit = fitLattice(lowEdges, size);
  if (lowFit === null) return fit;
  const fitSpan = (fit.kMax - fit.kMin) * fit.p;
  const lowSpan = (lowFit.kMax - lowFit.kMin) * lowFit.p;
  return lowSpan > fitSpan + tol ? lowFit : fit;
}

/** Upper median; 0 for an empty list. */
function median(v: number[]): number {
  if (v.length === 0) return 0;
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

  const latX = fitAxis(img, "x");
  const latY = fitAxis(img, "y");
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
    return [median(r), median(g), median(b), median(a)];
  };

  // Sampling-noise probe at a cell centre: the centre pixel and its immediate
  // right/down neighbours sit inside the same art cell (any period >=
  // MIN_PERIOD keeps them at least a pixel from the cell border), so a
  // channel difference between them is sampling noise, not pixel-art
  // structure. The median over all cells is robust to the occasional
  // neighbour that crosses a boundary on a non-integer lattice.
  const probeNoise = (cx: number, cy: number): number => {
    const x = Math.min(width - 1, Math.max(0, Math.floor(originX + (cx + 0.5) * latX.p)));
    const y = Math.min(height - 1, Math.max(0, Math.floor(originY + (cy + 0.5) * latY.p)));
    const i = (y * width + x) * 4;
    let worst = 0;
    const neighbours = [
      (y * width + Math.min(width - 1, x + 1)) * 4,
      (Math.min(height - 1, y + 1) * width + x) * 4,
    ];
    for (const j of neighbours) {
      for (let ch = 0; ch < 3; ch++) {
        const d = Math.abs(data[i + ch] - data[j + ch]);
        if (d > worst) worst = d;
      }
    }
    return worst;
  };

  type Sample = { r: number; g: number; b: number } | null;
  const samples: Sample[][] = [];
  const noiseProbes: number[] = [];
  for (let cy = 0; cy < gh; cy++) {
    const row: Sample[] = [];
    for (let cx = 0; cx < gw; cx++) {
      const [r, g, b, a] = sampleCell(cx, cy);
      if (a < 128) {
        row.push(null);
      } else {
        row.push({ r, g, b });
        noiseProbes.push(probeNoise(cx, cy));
      }
    }
    samples.push(row);
  }

  // Snap to the dominant palette (this is the recovery path — colour distance
  // is explicitly allowed here). The merge radius scales with the sampling
  // noise measured above: exact samples cluster (near-)exactly, so genuinely
  // distinct close shades are preserved; noisy samples merge within a radius
  // proportional to the noise, capped at the old flat distance.
  const noise = median(noiseProbes);
  const mergeDistance = Math.min(
    CLUSTER_DISTANCE_MAX,
    Math.max(CLUSTER_DISTANCE_MIN, CLUSTER_NOISE_FACTOR * noise),
  );

  type Member = { r: number; g: number; b: number; count: number };
  type Cluster = { members: Member[]; count: number; cr: number; cg: number; cb: number };

  // Exact-colour histogram, clustered in descending-count order so dominant
  // colours seed the clusters (stable, order-independent of raster position).
  const hist = new Map<number, Member>();
  for (const row of samples) {
    for (const s of row) {
      if (s === null) continue;
      const key = (s.r << 16) | (s.g << 8) | s.b;
      const m = hist.get(key);
      if (m) m.count++;
      else hist.set(key, { r: s.r, g: s.g, b: s.b, count: 1 });
    }
  }
  const distinct = [...hist.entries()].sort((a, b) => b[1].count - a[1].count || a[0] - b[0]);

  const clusters: Cluster[] = [];
  const clusterByKey = new Map<number, Cluster>();
  const absorb = (into: Cluster, m: Member): void => {
    const n = into.count + m.count;
    into.cr = (into.cr * into.count + m.r * m.count) / n;
    into.cg = (into.cg * into.count + m.g * m.count) / n;
    into.cb = (into.cb * into.count + m.b * m.count) / n;
    into.members.push(m);
    into.count = n;
  };
  for (const [key, m] of distinct) {
    let best: Cluster | null = null;
    let bestD = Infinity;
    for (const c of clusters) {
      const d = Math.hypot(m.r - c.cr, m.g - c.cg, m.b - c.cb);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best !== null && bestD <= mergeDistance) {
      absorb(best, m);
      clusterByKey.set(key, best);
    } else {
      const fresh: Cluster = { members: [m], count: m.count, cr: m.r, cg: m.g, cb: m.b };
      clusters.push(fresh);
      clusterByKey.set(key, fresh);
    }
  }

  // Stray absorption: a cluster that is BOTH very close to another AND tiny
  // relative to it is sampling noise (a stray blended cell), not a deliberate
  // second shade — genuinely distinct colours stay distinct however close
  // their counts, and a small-but-distant cluster is never folded.
  const absorbedInto = new Map<Cluster, Cluster>();
  const resolve = (c: Cluster): Cluster => {
    let r = c;
    while (absorbedInto.has(r)) r = absorbedInto.get(r)!;
    return r;
  };
  for (const small of clusters.slice().sort((a, b) => a.count - b.count)) {
    if (absorbedInto.has(small)) continue;
    let best: Cluster | null = null;
    let bestD = Infinity;
    for (const other of clusters) {
      if (other === small || absorbedInto.has(other)) continue;
      const d = Math.hypot(small.cr - other.cr, small.cg - other.cg, small.cb - other.cb);
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    if (
      best !== null &&
      bestD <= STRAY_MERGE_DISTANCE &&
      small.count * STRAY_COUNT_RATIO <= best.count
    ) {
      for (const m of small.members) absorb(best, m);
      absorbedInto.set(small, best);
    }
  }

  // Representative colour: weighted per-channel median over cluster members
  // (equivalent to the median over all samples in the cluster).
  const weightedMedian = (members: Member[], pick: (m: Member) => number): number => {
    const vals = members.map((m) => ({ v: pick(m), n: m.count })).sort((a, b) => a.v - b.v);
    const total = vals.reduce((acc, x) => acc + x.n, 0);
    const target = total >> 1;
    let cum = 0;
    for (const x of vals) {
      cum += x.n;
      if (cum > target) return x.v;
    }
    return vals[vals.length - 1].v;
  };
  const repHex = new Map<Cluster, string>();
  for (const c of clusters) {
    if (absorbedInto.has(c)) continue;
    repHex.set(
      c,
      rgbToHex(
        weightedMedian(c.members, (m) => m.r),
        weightedMedian(c.members, (m) => m.g),
        weightedMedian(c.members, (m) => m.b),
      ),
    );
  }

  const cells: (string | null)[][] = samples.map((row) =>
    row.map((s) => {
      if (s === null) return null;
      const key = (s.r << 16) | (s.g << 8) | s.b;
      return repHex.get(resolve(clusterByKey.get(key)!))!;
    }),
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
