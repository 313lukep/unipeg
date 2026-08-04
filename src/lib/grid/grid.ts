import { Grid, GridValidationError } from "./types";

/** Create a w x h grid filled with `fill` (default null = transparent). */
export function makeGrid(w: number, h: number, fill: string | null = null): Grid {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new GridValidationError(
      `makeGrid requires positive integer dimensions, got ${w}x${h}`,
    );
  }
  const colour = fill === null ? null : fill.toLowerCase();
  const cells: (string | null)[][] = [];
  for (let y = 0; y < h; y++) {
    cells.push(new Array<string | null>(w).fill(colour));
  }
  return { w, h, cells, palette: colour === null ? [] : [colour] };
}

/** Deep copy of a grid. */
export function cloneGrid(g: Grid): Grid {
  return {
    w: g.w,
    h: g.h,
    cells: g.cells.map((row) => row.slice()),
    palette: g.palette.slice(),
  };
}

/**
 * Structural equality on dimensions and cells. The palette is derived data
 * and deliberately not compared.
 */
export function gridsEqual(a: Grid, b: Grid): boolean {
  if (a.w !== b.w || a.h !== b.h) return false;
  for (let y = 0; y < a.h; y++) {
    const ra = a.cells[y];
    const rb = b.cells[y];
    for (let x = 0; x < a.w; x++) {
      if (ra[x] !== rb[x]) return false;
    }
  }
  return true;
}

/**
 * Return a grid whose palette is the sorted list of distinct colours actually
 * present in the cells. Cell arrays are shared with the input (treat grids as
 * immutable).
 */
export function recomputePalette(g: Grid): Grid {
  const seen = new Set<string>();
  for (let y = 0; y < g.h; y++) {
    const row = g.cells[y];
    for (let x = 0; x < g.w; x++) {
      const c = row[x];
      if (c !== null) seen.add(c);
    }
  }
  return { w: g.w, h: g.h, cells: g.cells, palette: [...seen].sort() };
}
