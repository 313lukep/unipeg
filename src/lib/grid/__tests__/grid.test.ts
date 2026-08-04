import { describe, expect, it } from "vitest";
import { cloneGrid, gridsEqual, makeGrid, recomputePalette } from "../grid";
import { GridValidationError } from "../types";

describe("makeGrid", () => {
  it("creates a filled grid with the fill in the palette", () => {
    const g = makeGrid(3, 2, "#FFAA00");
    expect(g.w).toBe(3);
    expect(g.h).toBe(2);
    expect(g.cells).toEqual([
      ["#ffaa00", "#ffaa00", "#ffaa00"],
      ["#ffaa00", "#ffaa00", "#ffaa00"],
    ]);
    expect(g.palette).toEqual(["#ffaa00"]);
  });

  it("creates a transparent grid by default", () => {
    const g = makeGrid(2, 2);
    expect(g.cells).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(g.palette).toEqual([]);
  });

  it("rejects non-positive or non-integer dimensions", () => {
    expect(() => makeGrid(0, 4)).toThrow(GridValidationError);
    expect(() => makeGrid(4, 2.5)).toThrow(GridValidationError);
  });
});

describe("cloneGrid / gridsEqual", () => {
  it("clones deeply and compares structurally", () => {
    const a = makeGrid(2, 2, "#112233");
    const b = cloneGrid(a);
    expect(gridsEqual(a, b)).toBe(true);
    b.cells[0][0] = "#ffffff";
    expect(a.cells[0][0]).toBe("#112233"); // deep copy
    expect(gridsEqual(a, b)).toBe(false);
  });

  it("differing dimensions are not equal", () => {
    expect(gridsEqual(makeGrid(2, 2, "#000000"), makeGrid(2, 3, "#000000"))).toBe(false);
  });
});

describe("recomputePalette", () => {
  it("collects distinct colours sorted, ignoring nulls", () => {
    const g = makeGrid(2, 2);
    g.cells[0][0] = "#ff0000";
    g.cells[0][1] = "#00ff00";
    g.cells[1][0] = "#ff0000";
    const out = recomputePalette(g);
    expect(out.palette).toEqual(["#00ff00", "#ff0000"]);
  });
});
