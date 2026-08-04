import { describe, expect, it } from "vitest";
import { unipegGrid, PALETTE } from "./helpers";
import { contentInsideInscribedCircle, fullBodyCompose } from "../circleFit";
import { contentBounds } from "../ops";
import { makeGrid } from "../grid";
import { GridValidationError } from "../types";

describe("fullBodyCompose", () => {
  it("centres an off-centre subject by its CONTENT box, not the source frame", () => {
    // Subject crammed into the top-left of a 24x24 frame.
    const g = makeGrid(24, 24, PALETTE.bg);
    for (let y = 1; y <= 6; y++)
      for (let x = 1; x <= 8; x++) g.cells[y][x] = PALETTE.body;

    const { grid, N, bg, contentBox } = fullBodyCompose(g);
    expect(bg).toBe(PALETTE.bg);
    expect(contentBox).toEqual({ x: 1, y: 1, w: 8, h: 6 });
    expect(grid.w).toBe(N);
    expect(grid.h).toBe(N);

    // Content centre must sit within 1 cell of the canvas centre.
    const outBox = contentBounds(grid, bg);
    expect(outBox.w).toBe(contentBox.w);
    expect(outBox.h).toBe(contentBox.h);
    const centreX = outBox.x + outBox.w / 2;
    const centreY = outBox.y + outBox.h / 2;
    expect(Math.abs(centreX - N / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(centreY - N / 2)).toBeLessThanOrEqual(1);
  });

  it.each([0, 0.12, 0.3])(
    "keeps all content inside the inscribed circle (breathingRoom %s)",
    (breathingRoom) => {
      const g = unipegGrid();
      const { grid, N, bg } = fullBodyCompose(g, { breathingRoom });
      expect(grid.w).toBe(N);
      expect(contentInsideInscribedCircle(grid, bg)).toBe(true);

      // N is at least the diagonal-derived minimum.
      const box = contentBounds(g, bg);
      const minN = Math.ceil(Math.hypot(box.w, box.h) * (1 + breathingRoom));
      expect(N).toBeGreaterThanOrEqual(minN);

      // Every cell painted (bg fill, no nulls).
      for (const row of grid.cells) for (const c of row) expect(c).not.toBeNull();
    },
  );

  it("respects an explicit bg override", () => {
    const g = unipegGrid();
    // Treat the body colour as "background": everything else is content.
    const { bg } = fullBodyCompose(g, { bg: PALETTE.body });
    expect(bg).toBe(PALETTE.body);
  });

  it("throws GridValidationError for a single-colour grid (no content)", () => {
    // Documented behaviour: contentBounds finds no non-bg cells and throws.
    const flat = makeGrid(24, 24, "#ffffff");
    expect(() => fullBodyCompose(flat)).toThrow(GridValidationError);
  });
});

describe("contentInsideInscribedCircle", () => {
  it("rejects content in the square's corners", () => {
    const g = makeGrid(10, 10, "#ffffff");
    g.cells[0][0] = "#000000"; // corner cell is outside the inscribed circle
    expect(contentInsideInscribedCircle(g, "#ffffff")).toBe(false);
  });

  it("accepts content hugging the centre", () => {
    const g = makeGrid(10, 10, "#ffffff");
    g.cells[4][4] = "#000000";
    g.cells[5][5] = "#000000";
    expect(contentInsideInscribedCircle(g, "#ffffff")).toBe(true);
  });

  it("accepts a cell whose corners land exactly on the circle", () => {
    // In a 2x2 grid every cell corner is at distance exactly N/2 * sqrt(2)...
    // use a 4x4: centre cells (1,1)-(2,2) have corners at max distance
    // sqrt(2) * 1 from centre (2,2), radius 2 — inside.
    const g = makeGrid(4, 4, "#ffffff");
    g.cells[1][1] = "#000000";
    g.cells[2][2] = "#000000";
    expect(contentInsideInscribedCircle(g, "#ffffff")).toBe(true);
  });
});
