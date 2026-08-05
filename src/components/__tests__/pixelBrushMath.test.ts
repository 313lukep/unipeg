import { describe, expect, it } from "vitest";
import {
  applyStrokeInto,
  cellAt,
  cellKey,
  inBounds,
  lineCells,
  maskEdges,
  parseCellKey,
  rectMask,
} from "@/components/pixelBrushMath";

const keys = (s: ReadonlySet<string>) => [...s].sort();

describe("cellKey / parseCellKey", () => {
  it("round-trips integer cells", () => {
    expect(cellKey(3, 17)).toBe("3,17");
    expect(parseCellKey("3,17")).toEqual({ x: 3, y: 17 });
  });

  it("rejects non-integer and malformed keys", () => {
    expect(parseCellKey("3.5,2")).toBeNull();
    expect(parseCellKey("3")).toBeNull();
    expect(parseCellKey("a,b")).toBeNull();
    expect(parseCellKey("1,2,3")).toBeNull();
  });
});

describe("cellAt", () => {
  it("floors a pointer offset into a whole cell", () => {
    expect(cellAt(0, 0, 10)).toEqual({ x: 0, y: 0 });
    expect(cellAt(9.9, 10.1, 10)).toEqual({ x: 0, y: 1 });
    expect(cellAt(23.4, 47.9, 12)).toEqual({ x: 1, y: 3 });
  });

  it("returns integers even for fractional cellPx", () => {
    const c = cellAt(100.7, 3.2, 390 / 24)!;
    expect(Number.isInteger(c.x)).toBe(true);
    expect(Number.isInteger(c.y)).toBe(true);
  });

  it("is null when unmeasured or non-finite", () => {
    expect(cellAt(5, 5, 0)).toBeNull();
    expect(cellAt(5, 5, Number.NaN)).toBeNull();
    expect(cellAt(Number.NaN, 5, 10)).toBeNull();
  });

  it("may report out-of-bounds cells (the pointer can leave the plate)", () => {
    expect(cellAt(-1, -1, 10)).toEqual({ x: -1, y: -1 });
  });
});

describe("lineCells", () => {
  it("returns the single cell when both ends match", () => {
    expect(lineCells({ x: 4, y: 4 }, { x: 4, y: 4 })).toEqual([{ x: 4, y: 4 }]);
  });

  it("fills every cell of a horizontal swipe (no gaps)", () => {
    expect(lineCells({ x: 2, y: 7 }, { x: 6, y: 7 })).toEqual([
      { x: 2, y: 7 },
      { x: 3, y: 7 },
      { x: 4, y: 7 },
      { x: 5, y: 7 },
      { x: 6, y: 7 },
    ]);
  });

  it("is contiguous in Chebyshev distance for a long diagonal-ish swipe", () => {
    const path = lineCells({ x: 0, y: 0 }, { x: 23, y: 9 });
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 23, y: 9 });
    for (let i = 1; i < path.length; i++) {
      const step = Math.max(
        Math.abs(path[i].x - path[i - 1].x),
        Math.abs(path[i].y - path[i - 1].y),
      );
      expect(step).toBe(1);
    }
    expect(path).toHaveLength(24);
  });

  it("walks backwards too", () => {
    const path = lineCells({ x: 9, y: 9 }, { x: 5, y: 5 });
    expect(path).toHaveLength(5);
    expect(path[4]).toEqual({ x: 5, y: 5 });
  });
});

describe("applyStrokeInto", () => {
  it("paints in-bounds cells and reports the change", () => {
    const set = new Set<string>();
    const changed = applyStrokeInto(
      set,
      lineCells({ x: 1, y: 1 }, { x: 3, y: 1 }),
      "paint",
      24,
      24,
    );
    expect(changed).toBe(true);
    expect(keys(set)).toEqual(["1,1", "2,1", "3,1"]);
  });

  it("drops out-of-bounds cells instead of clamping them onto the border", () => {
    const set = new Set<string>();
    applyStrokeInto(
      set,
      [
        { x: -3, y: 4 },
        { x: 0, y: 4 },
        { x: 24, y: 4 },
        { x: 4, y: -1 },
        { x: 4, y: 24 },
      ],
      "paint",
      24,
      24,
    );
    expect(keys(set)).toEqual(["0,4"]);
  });

  it("erases only what is there and reports no-ops", () => {
    const set = new Set(["5,5", "6,5"]);
    expect(applyStrokeInto(set, [{ x: 5, y: 5 }], "erase", 24, 24)).toBe(true);
    expect(applyStrokeInto(set, [{ x: 5, y: 5 }], "erase", 24, 24)).toBe(false);
    expect(keys(set)).toEqual(["6,5"]);
  });

  it("re-painting an existing cell is not a change", () => {
    const set = new Set(["2,2"]);
    expect(applyStrokeInto(set, [{ x: 2, y: 2 }], "paint", 24, 24)).toBe(false);
  });
});

describe("rectMask", () => {
  it("seeds every cell inside the box rectangle", () => {
    const m = rectMask({ x: 2, y: 3, w: 3, h: 2 }, 24, 24);
    expect(m.size).toBe(6);
    expect(keys(m)).toEqual(["2,3", "2,4", "3,3", "3,4", "4,3", "4,4"]);
  });

  it("clips to the grid", () => {
    const m = rectMask({ x: 22, y: 22, w: 8, h: 8 }, 24, 24);
    expect(keys(m)).toEqual(["22,22", "22,23", "23,22", "23,23"]);
  });

  it("a full-grid rect seeds w*h cells", () => {
    expect(rectMask({ x: 0, y: 0, w: 24, h: 24 }, 24, 24).size).toBe(576);
  });
});

describe("maskEdges", () => {
  it("outlines a single cell on all four sides", () => {
    const e = maskEdges(new Set(["4,4"]), 24, 24);
    expect(e).toHaveLength(4);
    expect(e.map((s) => s.side).sort()).toEqual([
      "bottom",
      "left",
      "right",
      "top",
    ]);
  });

  it("emits no edge between two masked neighbours", () => {
    const e = maskEdges(new Set(["4,4", "5,4"]), 24, 24);
    expect(e).toHaveLength(6);
    expect(e.some((s) => s.x === 4 && s.side === "right")).toBe(false);
    expect(e.some((s) => s.x === 5 && s.side === "left")).toBe(false);
  });

  it("outlines the perimeter of a block, not every cell", () => {
    const e = maskEdges(rectMask({ x: 2, y: 2, w: 4, h: 4 }, 24, 24), 24, 24);
    // perimeter of a 4x4 block = 16 unit edges (4 cells x 4 sides = 64 naive)
    expect(e).toHaveLength(16);
  });

  it("treats out-of-bounds neighbours as unmasked (grid border is an edge)", () => {
    const e = maskEdges(new Set(["0,0"]), 24, 24);
    expect(e.some((s) => s.side === "top")).toBe(true);
    expect(e.some((s) => s.side === "left")).toBe(true);
  });

  it("ignores junk keys", () => {
    expect(maskEdges(new Set(["nope", "99,99"]), 24, 24)).toEqual([]);
  });
});

describe("inBounds", () => {
  it("is exclusive at the far edge", () => {
    expect(inBounds({ x: 23, y: 23 }, 24, 24)).toBe(true);
    expect(inBounds({ x: 24, y: 0 }, 24, 24)).toBe(false);
  });
});
