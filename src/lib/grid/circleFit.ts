import { CellRect, Grid } from "./types";
import { makeGrid, recomputePalette } from "./grid";
import { contentBounds, detectBackground } from "./ops";

/**
 * True when every non-background cell lies (all 4 corners) strictly inside or
 * on the inscribed circle of the grid square (centre N/2, radius N/2).
 *
 * Uses exact integer arithmetic: corner (cx, cy) is inside iff
 * (2*cx - N)^2 + (2*cy - N)^2 <= N^2. For non-square grids the inscribed
 * circle of the shorter side, centred on the grid, is used.
 */
export function contentInsideInscribedCircle(grid: Grid, bg: string): boolean {
  const bgLower = bg.toLowerCase();
  const r2 = Math.min(grid.w, grid.h) ** 2; // (2 * (N/2))^2
  for (let y = 0; y < grid.h; y++) {
    const row = grid.cells[y];
    for (let x = 0; x < grid.w; x++) {
      const c = row[x];
      if (c === null || c === bgLower) continue;
      for (const cx of [x, x + 1]) {
        for (const cy of [y, y + 1]) {
          const dx = 2 * cx - grid.w;
          const dy = 2 * cy - grid.h;
          if (dx * dx + dy * dy > r2) return false;
        }
      }
    }
  }
  return true;
}

/**
 * Compose an N x N canvas, filled with the background colour, with the
 * CONTENT bounding box (the cropped content, not the original frame) centred
 * in it — so the unicorn itself is centred, whatever its position in the
 * source 24x24 frame.
 *
 * N starts at ceil(diagonal * (1 + breathingRoom)) where diagonal is the
 * content box diagonal; if the inscribed-circle check fails for that N
 * (possible for tiny breathingRoom because of the centring remainder), N is
 * bumped by +1 until it passes. Centring distributes any remainder with
 * floor on the left/top side.
 *
 * Throws GridValidationError (via contentBounds) when the grid has no
 * non-background content (e.g. a single-colour grid).
 */
export function fullBodyCompose(
  g: Grid,
  opts?: { breathingRoom?: number; bg?: string },
): { grid: Grid; N: number; bg: string; contentBox: CellRect } {
  const bg = (opts?.bg ?? detectBackground(g)).toLowerCase();
  const breathingRoom = opts?.breathingRoom ?? 0.12;
  const box = contentBounds(g, bg);
  const diagonal = Math.hypot(box.w, box.h);

  let N = Math.max(Math.ceil(diagonal * (1 + breathingRoom)), box.w, box.h);

  const compose = (n: number): Grid => {
    const out = makeGrid(n, n, bg);
    const left = Math.floor((n - box.w) / 2);
    const top = Math.floor((n - box.h) / 2);
    for (let y = 0; y < box.h; y++) {
      for (let x = 0; x < box.w; x++) {
        out.cells[top + y][left + x] = g.cells[box.y + y][box.x + x] ?? bg;
      }
    }
    return recomputePalette(out);
  };

  let grid = compose(N);
  while (!contentInsideInscribedCircle(grid, bg)) {
    N += 1;
    grid = compose(N);
  }
  return { grid, N, bg, contentBox: box };
}
