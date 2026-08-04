import { CellRect, Grid } from "./types";
import { contentBounds, detectBackground } from "./ops";
import { relLuminance } from "./colour";

/**
 * Heuristic head-selection seed.
 *
 * The eye is a small dark cluster (1-2 cells) in the upper half of the
 * content, whose colour differs from the background and from the large body
 * components, surrounded by body colour. We pick the candidate with the
 * lowest relative luminance and seed a 12-cell square with the eye at
 * roughly the upper-third intersection, biased 1 cell toward the facing
 * direction (the side where background is nearer), clamped to the grid, then
 * expanded upward to include connected horn/mane cells above the seed.
 *
 * If no eye is found, falls back to the top-centre third of the content
 * bounds with confidence 'low'.
 */
export function detectHeadSeed(g: Grid): {
  rect: CellRect;
  eye: { x: number; y: number } | null;
  confidence: "high" | "low";
} {
  const bg = detectBackground(g);
  const box = contentBounds(g, bg);
  const SIDE = Math.min(12, g.w, g.h);

  const isContent = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= g.w || y >= g.h) return false;
    const c = g.cells[y][x];
    return c !== null && c !== bg;
  };

  // Connected components (4-connectivity) of same-coloured non-bg cells.
  const compId: number[][] = g.cells.map((row) => row.map(() => -1));
  type Comp = { colour: string; cells: [number, number][] };
  const comps: Comp[] = [];
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (!isContent(x, y) || compId[y][x] !== -1) continue;
      const colour = g.cells[y][x]!;
      const id = comps.length;
      const cells: [number, number][] = [];
      const stack: [number, number][] = [[x, y]];
      compId[y][x] = id;
      while (stack.length > 0) {
        const [px, py] = stack.pop()!;
        cells.push([px, py]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = px + dx;
          const ny = py + dy;
          if (isContent(nx, ny) && compId[ny][nx] === -1 && g.cells[ny][nx] === colour) {
            compId[ny][nx] = id;
            stack.push([nx, ny]);
          }
        }
      }
      comps.push({ colour, cells });
    }
  }

  // Eye candidates: 1-2 cell components in the upper half of the content,
  // mostly surrounded by other (body) content.
  const upperLimit = box.y + box.h / 2;
  let eye: { x: number; y: number } | null = null;
  let eyeLum = Infinity;
  for (const comp of comps) {
    if (comp.cells.length > 2) continue;
    const [cx, cy] = comp.cells[0];
    if (cy >= upperLimit) continue;
    let contentNeighbours = 0;
    let totalNeighbours = 0;
    for (const [px, py] of comp.cells) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = px + dx;
        const ny = py + dy;
        if (compId[ny]?.[nx] !== undefined && compId[ny][nx] === compId[py][px]) continue;
        totalNeighbours++;
        if (isContent(nx, ny)) contentNeighbours++;
      }
    }
    if (totalNeighbours === 0 || contentNeighbours / totalNeighbours < 0.5) continue;
    const lum = relLuminance(comp.colour);
    if (lum < eyeLum) {
      eyeLum = lum;
      eye = { x: cx, y: cy };
    }
  }

  const clampRect = (r: CellRect): CellRect => ({
    x: Math.max(0, Math.min(r.x, g.w - r.w)),
    y: Math.max(0, Math.min(r.y, g.h - r.h)),
    w: r.w,
    h: r.h,
  });

  let rect: CellRect;
  let confidence: "high" | "low";
  if (eye !== null) {
    // Facing direction: the side where the background is nearer to the eye.
    let distLeft = 0;
    for (let x = eye.x - 1; x >= 0 && isContent(x, eye.y); x--) distLeft++;
    let distRight = 0;
    for (let x = eye.x + 1; x < g.w && isContent(x, eye.y); x++) distRight++;
    const bias = distRight <= distLeft ? 1 : -1;

    rect = clampRect({
      x: eye.x - Math.floor(SIDE / 2) + bias,
      y: eye.y - Math.floor(SIDE / 3),
      w: SIDE,
      h: SIDE,
    });
    confidence = "high";
  } else {
    // Fallback: top-centre third of the content bounds.
    const cx = box.x + Math.floor(box.w / 2);
    rect = clampRect({ x: cx - Math.floor(SIDE / 2), y: box.y, w: SIDE, h: SIDE });
    confidence = "low";
  }

  // Expand upward to pull in connected horn/mane cells above the seed: keep
  // absorbing the row above while it holds content vertically adjacent to
  // content in the rect's current top row.
  while (rect.y > 0) {
    const above = rect.y - 1;
    let connected = false;
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (isContent(x, above) && isContent(x, rect.y)) {
        connected = true;
        break;
      }
    }
    if (!connected) break;
    rect = { x: rect.x, y: above, w: rect.w, h: rect.h + 1 };
  }

  return { rect, eye, confidence };
}
