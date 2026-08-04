import { describe, expect, it } from "vitest";
import { pickCellSize, rasterise } from "../rasterise";
import { makeGrid } from "../grid";
import { gridFrom } from "./helpers";
import { GridValidationError } from "../types";

type Call = { fillStyle: string; x: number; y: number; w: number; h: number };

function mockCtx() {
  const calls: Call[] = [];
  let fillStyle = "";
  const ctx = {
    imageSmoothingEnabled: true,
    set fillStyle(v: string) {
      fillStyle = v;
    },
    get fillStyle() {
      return fillStyle;
    },
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ fillStyle, x, y, w, h });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("rasterise", () => {
  it("draws each non-null cell as an integer fillRect, smoothing disabled", () => {
    const g = gridFrom(
      [
        "A.",
        ".B",
      ],
      { ".": null, A: "#ff0000", B: "#00ff00" },
    );
    const { ctx, calls } = mockCtx();
    rasterise(g, 10, ctx, 3, 5);
    expect((ctx as unknown as { imageSmoothingEnabled: boolean }).imageSmoothingEnabled).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls).toContainEqual({ fillStyle: "#ff0000", x: 3, y: 5, w: 10, h: 10 });
    expect(calls).toContainEqual({ fillStyle: "#00ff00", x: 13, y: 15, w: 10, h: 10 });
  });

  it("batches by colour (one fillStyle assignment per colour)", () => {
    const g = makeGrid(3, 1, "#123456");
    const { ctx, calls } = mockCtx();
    rasterise(g, 4, ctx);
    expect(calls.map((c) => c.fillStyle)).toEqual(["#123456", "#123456", "#123456"]);
    expect(calls.map((c) => c.x)).toEqual([0, 4, 8]);
  });

  it("rejects non-integer cell sizes", () => {
    const g = makeGrid(2, 2, "#000000");
    const { ctx } = mockCtx();
    expect(() => rasterise(g, 2.5, ctx)).toThrow(GridValidationError);
    expect(() => rasterise(g, 0, ctx)).toThrow(GridValidationError);
  });
});

describe("pickCellSize", () => {
  it("picks the largest integer cell size fitting the target", () => {
    expect(pickCellSize(makeGrid(24, 24, "#000000"), 1000)).toBe(41); // 24*41 = 984
    expect(pickCellSize(makeGrid(34, 34, "#000000"), 1000)).toBe(29); // 34*29 = 986
    expect(pickCellSize(makeGrid(24, 24, "#000000"), 400)).toBe(16);
  });

  it("never returns less than 1", () => {
    expect(pickCellSize(makeGrid(48, 48, "#000000"), 10)).toBe(1);
  });

  it("fits BOTH axes of a non-square grid under the target", () => {
    // Regression: only g.w was consulted, so a 24x30 grid at target 1000
    // rendered 1230px tall.
    expect(pickCellSize(makeGrid(24, 30, "#000000"), 1000)).toBe(33); // 30*33 = 990
    expect(pickCellSize(makeGrid(30, 24, "#000000"), 1000)).toBe(33);
    expect(pickCellSize(makeGrid(24, 30, "#000000"), 10)).toBe(1);
  });
});
