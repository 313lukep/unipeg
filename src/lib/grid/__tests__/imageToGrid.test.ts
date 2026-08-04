import { describe, expect, it } from "vitest";
import { renderToImageData, unipegGrid, PALETTE } from "./helpers";
import { imageToGrid } from "../imageToGrid";
import { gridsEqual } from "../grid";
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
