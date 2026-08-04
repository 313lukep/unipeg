import { describe, expect, it } from "vitest";
import { renderToImageData, unipegGrid, PALETTE } from "./helpers";
import { imageToGrid } from "../imageToGrid";
import { gridsEqual, recomputePalette } from "../grid";
import { hexToRgb } from "../colour";
import { GridValidationError } from "../types";

describe("imageToGrid", () => {
  it("exactly recovers a 17px/cell upscale with an 11px margin", () => {
    const src = unipegGrid();
    // 24 * 17 = 408 art px; margins: left 11, top 11, right 13, bottom 15.
    const img = renderToImageData(src, 17, {
      outW: 11 + 408 + 13,
      outH: 11 + 408 + 15,
      marginLeft: 11,
      marginTop: 11,
      marginColour: "#404040",
    });
    const { grid, recovered, cellSizePx, origin } = imageToGrid(img);
    expect(recovered).toBe(true);
    expect(grid.w).toBe(24);
    expect(grid.h).toBe(24);
    expect(cellSizePx).toBeCloseTo(17, 0);
    expect(origin.x).toBeCloseTo(11, 0);
    expect(origin.y).toBeCloseTo(11, 0);
    expect(gridsEqual(grid, src)).toBe(true);
  });

  it("recovers from a non-integer-but-consistent cell size (437px of 24 cells)", () => {
    const src = unipegGrid();
    const cellPx = 437 / 24; // ~18.208 px per cell
    const img = renderToImageData(src, cellPx, { outW: 437, outH: 437 });
    const { grid, cellSizePx } = imageToGrid(img);
    expect(grid.w).toBe(24);
    expect(grid.h).toBe(24);
    expect(cellSizePx).toBeGreaterThan(17.5);
    expect(cellSizePx).toBeLessThan(19);
    expect(gridsEqual(grid, src)).toBe(true);
  });

  it("snaps a scaled + slightly-noisy upscale back to a clean palette", () => {
    const src = unipegGrid();
    const noise = (x: number, y: number, ch: number) => ((x * 7 + y * 13 + ch * 5) % 5) - 2;
    const img = renderToImageData(src, 19, {
      outW: 7 + 24 * 19 + 9,
      outH: 7 + 24 * 19 + 9,
      marginLeft: 7,
      marginTop: 7,
      marginColour: "#404040",
      noise,
    });
    const { grid } = imageToGrid(img);
    expect(grid.w).toBe(24);
    expect(grid.h).toBe(24);

    // Palette snap: every recovered colour sits within a few units of an
    // original palette colour, and the cell structure matches exactly once
    // each recovered colour is mapped to its nearest original.
    const originals = Object.values(PALETTE).map((hex) => ({ hex, rgb: hexToRgb(hex) }));
    const nearest = new Map<string, string>();
    for (const c of grid.palette) {
      const rgb = hexToRgb(c);
      let bestHex = "";
      let bestDist = Infinity;
      for (const o of originals) {
        const d = Math.hypot(rgb.r - o.rgb.r, rgb.g - o.rgb.g, rgb.b - o.rgb.b);
        if (d < bestDist) {
          bestDist = d;
          bestHex = o.hex;
        }
      }
      expect(bestDist).toBeLessThanOrEqual(6);
      nearest.set(c, bestHex);
    }
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        expect(nearest.get(grid.cells[y][x]!)).toBe(src.cells[y][x]);
      }
    }
  });

  it("round-trips: grid -> simulated integer-scale rasterise -> imageToGrid", () => {
    const src = unipegGrid();
    const img = renderToImageData(src, 12, { outW: 24 * 12, outH: 24 * 12 });
    const { grid, cellSizePx, origin } = imageToGrid(img);
    expect(cellSizePx).toBeCloseTo(12, 0);
    expect(origin.x).toBeCloseTo(0, 0);
    expect(origin.y).toBeCloseTo(0, 0);
    expect(gridsEqual(grid, src)).toBe(true);
  });

  it("recovers 24x24 at every cell size 4..22 with margins near multiples of the period", () => {
    // Regression: margins whose widths land within tolerance of a multiple of
    // the cell period used to become lattice inliers via the injected image
    // boundary points, silently extending the grid with margin rows/cols.
    const src = unipegGrid();
    for (let cellPx = 4; cellPx <= 22; cellPx++) {
      const img = renderToImageData(src, cellPx, {
        outW: 11 + 24 * cellPx + 13,
        outH: 11 + 24 * cellPx + 15,
        marginLeft: 11,
        marginTop: 11,
        marginColour: "#404040",
      });
      const { grid, cellSizePx, origin } = imageToGrid(img);
      expect(grid.w, `cellPx=${cellPx} width`).toBe(24);
      expect(grid.h, `cellPx=${cellPx} height`).toBe(24);
      expect(grid.palette, `cellPx=${cellPx} palette`).not.toContain("#404040");
      expect(gridsEqual(grid, src), `cellPx=${cellPx} cells`).toBe(true);
      expect(cellSizePx).toBeCloseTo(cellPx, 0);
      expect(origin.x).toBeCloseTo(11, 0);
      expect(origin.y).toBeCloseTo(11, 0);
    }
  });

  it("recovers when the margin width is an exact multiple of the cell period", () => {
    // Regression: 13px margins at 13px/cell — the image boundary sits exactly
    // one period outside the art, so it is an exact lattice inlier; only the
    // colour check can tell the margin cells from art cells.
    const src = unipegGrid();
    const img = renderToImageData(src, 13, {
      outW: 13 + 24 * 13 + 13,
      outH: 13 + 24 * 13 + 13,
      marginLeft: 13,
      marginTop: 13,
      marginColour: "#404040",
    });
    const { grid, origin } = imageToGrid(img);
    expect(grid.w).toBe(24);
    expect(grid.h).toBe(24);
    expect(grid.palette).not.toContain("#404040");
    expect(gridsEqual(grid, src)).toBe(true);
    expect(origin.x).toBeCloseTo(13, 0);
    expect(origin.y).toBeCloseTo(13, 0);
  });

  it("recovers a non-integer cell size with asymmetric margins", () => {
    // Regression: 437px of 24 cells (~18.208px/cell) with 17/11 margins used
    // to come back with the wrong number of columns.
    const src = unipegGrid();
    const cellPx = 437 / 24;
    const img = renderToImageData(src, cellPx, {
      outW: 17 + 437 + 16,
      outH: 11 + 437 + 12,
      marginLeft: 17,
      marginTop: 11,
      marginColour: "#404040",
    });
    const { grid, cellSizePx } = imageToGrid(img);
    expect(grid.w).toBe(24);
    expect(grid.h).toBe(24);
    expect(grid.palette).not.toContain("#404040");
    expect(cellSizePx).toBeGreaterThan(17.5);
    expect(cellSizePx).toBeLessThan(19);
    expect(gridsEqual(grid, src)).toBe(true);
  });

  it("recovers an exact 3px/cell render (minimum plausible period)", () => {
    // Regression: at p=3 the old flat 1.5px inlier tolerance equalled half
    // the period, and the fit silently locked onto a wrong coarser period on
    // one axis (72x72 input came back as 24x6).
    const src = unipegGrid();
    const img = renderToImageData(src, 3, { outW: 72, outH: 72 });
    const { grid, cellSizePx } = imageToGrid(img);
    expect(grid.w).toBe(24);
    expect(grid.h).toBe(24);
    expect(cellSizePx).toBeCloseTo(3, 0);
    expect(gridsEqual(grid, src)).toBe(true);
  });

  it("recovers the full 24x24 through a low-contrast white margin (7px at 5px/cell)", () => {
    // Regression (finding 1): #ffffff differs from the #e6e1f2 art background
    // by at most 30 per channel — under EDGE_CHANNEL_THRESHOLD — so the
    // margin/art boundary produced no strong edge signal. With an off-lattice
    // margin width the fit then spanned only the non-background content and
    // imageToGrid silently returned a content-only crop (16x21, not 24x24).
    const src = unipegGrid();
    const img = renderToImageData(src, 5, {
      outW: 7 + 24 * 5 + 8,
      outH: 7 + 24 * 5 + 8,
      marginLeft: 7,
      marginTop: 7,
      marginColour: "#ffffff",
    });
    const { grid, cellSizePx, origin } = imageToGrid(img);
    expect(grid.w).toBe(24);
    expect(grid.h).toBe(24);
    expect(grid.palette).not.toContain("#ffffff");
    expect(gridsEqual(grid, src)).toBe(true);
    expect(cellSizePx).toBeCloseTo(5, 0);
    expect(origin.x).toBeCloseTo(7, 0);
    expect(origin.y).toBeCloseTo(7, 0);
  });

  it("recovers the full 24x24 through a low-contrast white margin (11px at 17px/cell)", () => {
    // Regression (finding 1), second geometry: same as the #404040-margin
    // recovery test above but with a white margin over the pastel background.
    const src = unipegGrid();
    const img = renderToImageData(src, 17, {
      outW: 11 + 24 * 17 + 13,
      outH: 11 + 24 * 17 + 15,
      marginLeft: 11,
      marginTop: 11,
      marginColour: "#ffffff",
    });
    const { grid, cellSizePx, origin } = imageToGrid(img);
    expect(grid.w).toBe(24);
    expect(grid.h).toBe(24);
    expect(grid.palette).not.toContain("#ffffff");
    expect(gridsEqual(grid, src)).toBe(true);
    expect(cellSizePx).toBeCloseTo(17, 0);
    expect(origin.x).toBeCloseTo(11, 0);
    expect(origin.y).toBeCloseTo(11, 0);
  });

  it("keeps genuinely distinct close shades separate when sampling is exact", () => {
    // Regression (finding 2): greedy clustering with a flat 32 RGB merge
    // distance folded a #ffb0e0 patch (Euclidean distance 24.6 from the
    // #ff9ad5 body) into the body colour even though every cell sample was
    // exact. With zero measured sampling noise, distinct colours must
    // survive.
    const src = unipegGrid();
    for (let y = 12; y < 15; y++) {
      for (let x = 6; x < 9; x++) src.cells[y][x] = "#ffb0e0";
    }
    const patched = recomputePalette(src);
    const img = renderToImageData(patched, 12, { outW: 24 * 12, outH: 24 * 12 });
    const { grid } = imageToGrid(img);
    expect(grid.w).toBe(24);
    expect(grid.h).toBe(24);
    expect(grid.palette).toContain("#ff9ad5");
    expect(grid.palette).toContain("#ffb0e0");
    expect(gridsEqual(grid, patched)).toBe(true);
  });

  it("keeps a background-coloured margin of on-lattice width as canvas (documented ambiguity)", () => {
    // A margin painted in exactly the art's background colour whose width is
    // a whole number of cells is indistinguishable from a larger canvas — no
    // geometric or colour signal can tell them apart — so it is kept as
    // extra background cells (see the module doc of imageToGrid).
    const src = unipegGrid();
    const img = renderToImageData(src, 10, {
      outW: 20 + 24 * 10 + 20,
      outH: 20 + 24 * 10 + 20,
      marginLeft: 20,
      marginTop: 20,
      marginColour: PALETTE.bg,
    });
    const { grid } = imageToGrid(img);
    expect(grid.w).toBe(28);
    expect(grid.h).toBe(28);
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        expect(grid.cells[y + 2][x + 2]).toBe(src.cells[y][x]);
      }
    }
    for (let i = 0; i < 28; i++) {
      expect(grid.cells[0][i]).toBe(PALETTE.bg);
      expect(grid.cells[27][i]).toBe(PALETTE.bg);
      expect(grid.cells[i][0]).toBe(PALETTE.bg);
      expect(grid.cells[i][27]).toBe(PALETTE.bg);
    }
  });

  it("throws a helpful GridValidationError when no period exists (flat image)", () => {
    const data = new Uint8ClampedArray(64 * 64 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 200;
      data[i + 1] = 200;
      data[i + 2] = 200;
      data[i + 3] = 255;
    }
    expect(() => imageToGrid({ width: 64, height: 64, data })).toThrow(GridValidationError);
    expect(() => imageToGrid({ width: 64, height: 64, data })).toThrow(/no plausible/);
  });

  it("throws on absurdly small input", () => {
    const data = new Uint8ClampedArray(8 * 8 * 4);
    expect(() => imageToGrid({ width: 8, height: 8, data })).toThrow(GridValidationError);
  });
});
