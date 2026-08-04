import { describe, expect, it } from "vitest";
import { gridFrom } from "./helpers";
import {
  contentBounds,
  crop,
  detectBackground,
  dilate,
  flattenOnto,
  keyOut,
  pad,
} from "../ops";
import { gridsEqual, makeGrid } from "../grid";
import { GridValidationError } from "../types";

const BG = "#e6e1f2";
const BODY = "#ff9ad5";
const DARK = "#1a1a1a";

describe("detectBackground", () => {
  it("finds the background with an off-centre subject", () => {
    const g = gridFrom(
      [
        "........",
        ".XX.....",
        ".XX.....",
        "........",
        "........",
        "........",
      ],
      { ".": BG, X: BODY },
    );
    expect(detectBackground(g)).toBe(BG);
  });

  it("still detects bg when the bg colour also appears inside the subject", () => {
    // The subject has an "eye" painted in the background colour — outer ring
    // frequency is what decides, not global frequency.
    const g = gridFrom(
      [
        "........",
        ".XXXXXX.",
        ".XX.XXX.", // bg-coloured cell inside the subject
        ".XXXXXX.",
        ".XXXXXX.",
        "........",
      ],
      { ".": BG, X: BODY },
    );
    expect(detectBackground(g)).toBe(BG);
  });

  it("subject touching the ring does not win while bg dominates the ring", () => {
    const g = gridFrom(
      [
        "XX......",
        "XX......",
        "........",
        "........",
      ],
      { ".": BG, X: BODY },
    );
    expect(detectBackground(g)).toBe(BG);
  });

  it("throws on an all-transparent ring", () => {
    expect(() => detectBackground(makeGrid(4, 4, null))).toThrow(GridValidationError);
  });
});

describe("contentBounds", () => {
  it("returns the bbox of non-bg cells", () => {
    const g = gridFrom(
      [
        "......",
        "..XX..",
        "..XX..",
        "......",
      ],
      { ".": BG, X: BODY },
    );
    expect(contentBounds(g, BG)).toEqual({ x: 2, y: 1, w: 2, h: 2 });
  });

  it("handles content touching a grid edge", () => {
    const g = gridFrom(
      [
        "X.....",
        "XX....",
        "......",
        ".....X",
      ],
      { ".": BG, X: BODY },
    );
    expect(contentBounds(g, BG)).toEqual({ x: 0, y: 0, w: 6, h: 4 });
  });

  it("throws when there is no content (single-colour grid)", () => {
    expect(() => contentBounds(makeGrid(5, 5, BG), BG)).toThrow(GridValidationError);
  });

  it("ignores null cells as content", () => {
    const g = makeGrid(4, 4, BG);
    g.cells[1][1] = null;
    expect(() => contentBounds(g, BG)).toThrow(GridValidationError);
  });
});

describe("keyOut / flattenOnto", () => {
  it("keyOut nulls background cells and flattenOnto restores them", () => {
    const g = gridFrom(
      [
        "....",
        ".XX.",
        "....",
      ],
      { ".": BG, X: BODY },
    );
    const keyed = keyOut(g, BG);
    expect(keyed.cells[0][0]).toBeNull();
    expect(keyed.cells[1][1]).toBe(BODY);
    expect(keyed.palette).toEqual([BODY]);
    const flat = flattenOnto(keyed, BG);
    expect(gridsEqual(flat, g)).toBe(true);
  });
});

describe("crop / pad", () => {
  it("crop extracts a sub-grid", () => {
    const g = gridFrom(
      [
        "....",
        ".XX.",
        ".XD.",
      ],
      { ".": BG, X: BODY, D: DARK },
    );
    const c = crop(g, { x: 1, y: 1, w: 2, h: 2 });
    expect(c.w).toBe(2);
    expect(c.h).toBe(2);
    expect(c.cells).toEqual([
      [BODY, BODY],
      [BODY, DARK],
    ]);
    expect(c.palette).toEqual([DARK, BODY].sort());
  });

  it("crop throws on out-of-bounds rects", () => {
    const g = makeGrid(4, 4, BG);
    expect(() => crop(g, { x: 2, y: 2, w: 3, h: 1 })).toThrow(GridValidationError);
    expect(() => crop(g, { x: 0, y: 0, w: 0, h: 1 })).toThrow(GridValidationError);
  });

  it("pad expands on all sides", () => {
    const g = makeGrid(2, 2, BODY);
    const p = pad(g, 2, BG);
    expect(p.w).toBe(6);
    expect(p.h).toBe(6);
    expect(p.cells[0][0]).toBe(BG);
    expect(p.cells[2][2]).toBe(BODY);
    expect(p.cells[3][3]).toBe(BODY);
    expect(p.cells[5][5]).toBe(BG);
  });
});

describe("dilate", () => {
  it("radius 0 is a no-op returning an equal grid of the same size", () => {
    const g = gridFrom(
      [
        "..",
        ".X",
      ],
      { ".": null, X: BODY },
    );
    const d = dilate(g, 0, "#ffffff");
    expect(d.w).toBe(g.w);
    expect(d.h).toBe(g.h);
    expect(gridsEqual(d, g)).toBe(true);
  });

  it("expands the grid so outlines never clip at the boundary", () => {
    // 2x2 fully occupied grid; radius-1 dilation must produce a 4x4 grid
    // whose entire border is outline colour — nothing clipped.
    const g = makeGrid(2, 2, BODY);
    const d = dilate(g, 1, "#ffffff");
    expect(d.w).toBe(4);
    expect(d.h).toBe(4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const inCentre = x >= 1 && x <= 2 && y >= 1 && y <= 2;
        expect(d.cells[y][x]).toBe(inCentre ? BODY : "#ffffff");
      }
    }
  });

  it("uses a square (Chebyshev) kernel via the separable two-pass", () => {
    // A single cell dilated by 1 fills the full 3x3 square including corners.
    const g = makeGrid(1, 1, DARK);
    const d = dilate(g, 1, "#ffffff");
    expect(d.w).toBe(3);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        expect(d.cells[y][x]).toBe(x === 1 && y === 1 ? DARK : "#ffffff");
      }
    }
  });

  it("radius 2 equals composing two radius-1 passes; two-tone rings stack", () => {
    const g = makeGrid(1, 1, DARK);

    // Same-colour composition: dilate(g, 2, white) == dilate(dilate(g, 1, white), 1, white)
    const oneShot = dilate(g, 2, "#ffffff");
    const twoPass = dilate(dilate(g, 1, "#ffffff"), 1, "#ffffff");
    expect(gridsEqual(oneShot, twoPass)).toBe(true);
    expect(oneShot.w).toBe(5);
    expect(oneShot.h).toBe(5);

    // Two-tone: inner white ring, outer pink ring — the sticker outline recipe.
    const twoTone = dilate(dilate(g, 1, "#ffffff"), 1, "#ff9ad5");
    expect(twoTone.w).toBe(5);
    expect(twoTone.cells[2][2]).toBe(DARK);
    // Inner ring (Chebyshev distance 1 from centre) is white...
    for (const [x, y] of [[1, 1], [2, 1], [3, 1], [1, 2], [3, 2], [1, 3], [2, 3], [3, 3]]) {
      expect(twoTone.cells[y][x]).toBe("#ffffff");
    }
    // ...outer ring (distance 2) is pink, corners included (no clipping).
    for (const [x, y] of [[0, 0], [4, 0], [0, 4], [4, 4], [2, 0], [0, 2], [4, 2], [2, 4]]) {
      expect(twoTone.cells[y][x]).toBe("#ff9ad5");
    }
  });

  it("existing cells are untouched and nulls outside the mask stay null", () => {
    const g = gridFrom(
      [
        "X....",
        ".....",
        ".....",
      ],
      { ".": null, X: BODY },
    );
    const d = dilate(g, 1, "#ffffff");
    expect(d.w).toBe(7);
    expect(d.h).toBe(5);
    expect(d.cells[1][1]).toBe(BODY); // original content at offset (r, r)
    expect(d.cells[0][0]).toBe("#ffffff");
    expect(d.cells[4][6]).toBeNull(); // far corner untouched
  });
});
