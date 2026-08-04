import { describe, expect, it } from "vitest";
import { unipegGrid, PALETTE } from "./helpers";
import { detectHeadSeed } from "../headDetect";

describe("detectHeadSeed", () => {
  it("finds the eye and seeds a head rect that includes horn cells above", () => {
    const g = unipegGrid();
    const { rect, eye, confidence } = detectHeadSeed(g);
    expect(confidence).toBe("high");
    expect(eye).toEqual({ x: 17, y: 7 }); // the single dark cell
    // Rect stays inside the grid.
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(g.w);
    expect(rect.y + rect.h).toBeLessThanOrEqual(g.h);
    // Rect contains the eye, is 11-13 cells wide.
    expect(rect.w).toBeGreaterThanOrEqual(11);
    expect(rect.w).toBeLessThanOrEqual(13);
    expect(eye!.x).toBeGreaterThanOrEqual(rect.x);
    expect(eye!.x).toBeLessThan(rect.x + rect.w);
    expect(eye!.y).toBeGreaterThanOrEqual(rect.y);
    expect(eye!.y).toBeLessThan(rect.y + rect.h);
    // Upward expansion pulled in the horn (top at y=1).
    expect(rect.y).toBeLessThanOrEqual(1);
  });

  it("falls back to the top-centre of the content bounds with low confidence", () => {
    const g = unipegGrid();
    // Paint the eye out with body colour: no small dark cluster remains.
    g.cells[7][17] = PALETTE.body;
    const { rect, eye, confidence } = detectHeadSeed(g);
    expect(confidence).toBe("low");
    expect(eye).toBeNull();
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(g.w);
    expect(rect.y + rect.h).toBeLessThanOrEqual(g.h);
  });
});
