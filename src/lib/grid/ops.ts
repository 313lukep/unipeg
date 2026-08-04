import { CellRect, Grid, GridValidationError } from "./types";
import { cloneGrid, makeGrid, recomputePalette } from "./grid";

/**
 * Most frequent colour on the outer ring of cells. Nulls on the ring are
 * ignored; ties break by first appearance in ring scan order (top row, then
 * remaining rows left/right edges, then bottom row).
 */
export function detectBackground(g: Grid): string {
  const counts = new Map<string, number>();
  const order = new Map<string, number>();
  let i = 0;
  const visit = (c: string | null) => {
    if (c === null) return;
    counts.set(c, (counts.get(c) ?? 0) + 1);
    if (!order.has(c)) order.set(c, i);
    i++;
  };
  for (let x = 0; x < g.w; x++) visit(g.cells[0][x]);
  for (let y = 1; y < g.h - 1; y++) {
    visit(g.cells[y][0]);
    if (g.w > 1) visit(g.cells[y][g.w - 1]);
  }
  if (g.h > 1) for (let x = 0; x < g.w; x++) visit(g.cells[g.h - 1][x]);

  let best: string | null = null;
  let bestCount = -1;
  for (const [c, n] of counts) {
    if (n > bestCount || (n === bestCount && order.get(c)! < order.get(best!)!)) {
      best = c;
      bestCount = n;
    }
  }
  if (best === null) {
    throw new GridValidationError("detectBackground: outer ring is fully transparent");
  }
  return best;
}

/** Bounding box of cells that are neither null nor the background colour. */
export function contentBounds(g: Grid, bg: string): CellRect {
  const bgLower = bg.toLowerCase();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < g.h; y++) {
    const row = g.cells[y];
    for (let x = 0; x < g.w; x++) {
      const c = row[x];
      if (c === null || c === bgLower) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) {
    throw new GridValidationError("contentBounds: grid has no non-background content");
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Background cells become null (transparent). */
export function keyOut(g: Grid, bg: string): Grid {
  const bgLower = bg.toLowerCase();
  const cells = g.cells.map((row) => row.map((c) => (c === bgLower ? null : c)));
  return recomputePalette({ w: g.w, h: g.h, cells, palette: [] });
}

/** Extract a sub-grid. The rect must lie fully inside the grid. */
export function crop(g: Grid, r: CellRect): Grid {
  if (
    !Number.isInteger(r.x) ||
    !Number.isInteger(r.y) ||
    !Number.isInteger(r.w) ||
    !Number.isInteger(r.h)
  ) {
    throw new GridValidationError("crop: rect must have integer cell coordinates");
  }
  if (r.w <= 0 || r.h <= 0 || r.x < 0 || r.y < 0 || r.x + r.w > g.w || r.y + r.h > g.h) {
    throw new GridValidationError(
      `crop: rect ${r.x},${r.y} ${r.w}x${r.h} outside grid ${g.w}x${g.h}`,
    );
  }
  const cells: (string | null)[][] = [];
  for (let y = 0; y < r.h; y++) {
    cells.push(g.cells[r.y + y].slice(r.x, r.x + r.w));
  }
  return recomputePalette({ w: r.w, h: r.h, cells, palette: [] });
}

/** Expand the grid by `cells` on every side, new cells filled with `fill`. */
export function pad(g: Grid, cells: number, fill: string | null): Grid {
  if (!Number.isInteger(cells) || cells < 0) {
    throw new GridValidationError(`pad: cells must be a non-negative integer, got ${cells}`);
  }
  if (cells === 0) return cloneGrid(g);
  const fillColour = fill === null ? null : fill.toLowerCase();
  const out = makeGrid(g.w + 2 * cells, g.h + 2 * cells, fillColour);
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      out.cells[y + cells][x + cells] = g.cells[y][x];
    }
  }
  return recomputePalette(out);
}

/**
 * Grow the alpha mask (non-null cells) outward by `radius` cells using a
 * square kernel (Chebyshev distance), realised as a separable two-pass
 * dilation: horizontal run, then vertical run over the horizontal result.
 * New cells are filled with `colour`; existing cells are untouched.
 *
 * NOTE: the result grid is EXPANDED by `radius` on all four sides
 * (w + 2*radius, h + 2*radius) so the outline can never clip at the grid
 * boundary. Original content sits at offset (radius, radius).
 *
 * radius 0 returns an equal (cloned) grid, same size.
 */
export function dilate(g: Grid, radius: number, colour: string): Grid {
  if (!Number.isInteger(radius) || radius < 0) {
    throw new GridValidationError(`dilate: radius must be a non-negative integer, got ${radius}`);
  }
  if (radius === 0) return cloneGrid(g);
  const outlineColour = colour.toLowerCase();
  const w = g.w + 2 * radius;
  const h = g.h + 2 * radius;

  const origOccupied = (x: number, y: number): boolean => {
    const ox = x - radius;
    const oy = y - radius;
    return ox >= 0 && oy >= 0 && ox < g.w && oy < g.h && g.cells[oy][ox] !== null;
  };

  // Pass 1: horizontal dilation of the occupancy mask.
  const pass1: boolean[][] = [];
  for (let y = 0; y < h; y++) {
    const row = new Array<boolean>(w).fill(false);
    for (let x = 0; x < w; x++) {
      for (let dx = -radius; dx <= radius && !row[x]; dx++) {
        if (origOccupied(x + dx, y)) row[x] = true;
      }
    }
    pass1.push(row);
  }

  // Pass 2: vertical dilation of the horizontal result.
  const cells: (string | null)[][] = [];
  for (let y = 0; y < h; y++) {
    const row = new Array<string | null>(w).fill(null);
    for (let x = 0; x < w; x++) {
      if (origOccupied(x, y)) {
        row[x] = g.cells[y - radius][x - radius];
        continue;
      }
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < h && pass1[yy][x]) {
          row[x] = outlineColour;
          break;
        }
      }
    }
    cells.push(row);
  }
  return recomputePalette({ w, h, cells, palette: [] });
}

/** Transparent (null) cells become the background colour. */
export function flattenOnto(g: Grid, bg: string): Grid {
  const bgLower = bg.toLowerCase();
  const cells = g.cells.map((row) => row.map((c) => c ?? bgLower));
  return recomputePalette({ w: g.w, h: g.h, cells, palette: [] });
}
