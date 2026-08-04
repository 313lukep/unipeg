import { describe, expect, it } from "vitest";

import {
  clampToRange,
  resolveSliderValue,
  type SliderRange,
} from "@/components/ui/cellSliderMath";

/** The sticker Tilt slider's configuration (5-degree lattice, -22 default). */
const TILT: SliderRange = { min: -45, max: 45, step: 5, detents: [0, -20] };

describe("clampToRange", () => {
  it("clamps into [min, max]", () => {
    expect(clampToRange(-60, TILT)).toBe(-45);
    expect(clampToRange(60, TILT)).toBe(45);
    expect(clampToRange(10, TILT)).toBe(10);
  });
});

describe("resolveSliderValue", () => {
  it("keyboard input is exempt from the detent magnet — -20 stays selectable", () => {
    // Regression: with a detent at -22, pointer-style magnets remapped every
    // raw -20 to -22, trapping keyboard users off the 5-degree lattice.
    const trap: SliderRange = { min: -45, max: 45, step: 5, detents: [0, -22] };
    expect(resolveSliderValue(-20, trap, "keyboard")).toBe(-20);
    expect(resolveSliderValue(-25, trap, "keyboard")).toBe(-25);
    expect(resolveSliderValue(0, trap, "keyboard")).toBe(0);
  });

  it("keyboard steps reach every native lattice value with the shipped detents", () => {
    for (let v = TILT.min; v <= TILT.max; v += TILT.step) {
      expect(resolveSliderValue(v, TILT, "keyboard")).toBe(v);
    }
  });

  it("pointer input snaps onto a detent within half a step", () => {
    const off: SliderRange = { min: -45, max: 45, step: 5, detents: [-22] };
    expect(resolveSliderValue(-20, off, "pointer")).toBe(-22); // |−20−(−22)| = 2 < 2.5
    expect(resolveSliderValue(-25, off, "pointer")).toBe(-25); // 3 > 2.5, out of reach
    expect(resolveSliderValue(-30, off, "pointer")).toBe(-30); // out of magnet reach
  });

  it("pointer input passes on-lattice detents through unchanged", () => {
    expect(resolveSliderValue(-20, TILT, "pointer")).toBe(-20);
    expect(resolveSliderValue(0, TILT, "pointer")).toBe(0);
    expect(resolveSliderValue(15, TILT, "pointer")).toBe(15);
  });

  it("ignores detents outside [min, max] and clamps first", () => {
    const r: SliderRange = { min: 0, max: 30, step: 1, detents: [-5, 12, 99] };
    expect(resolveSliderValue(-3, r, "pointer")).toBe(0); // clamped, no -5 magnet
    expect(resolveSliderValue(12, r, "pointer")).toBe(12);
    expect(resolveSliderValue(31, r, "pointer")).toBe(30);
  });

  it("works without detents for both sources", () => {
    const r: SliderRange = { min: 0, max: 100, step: 5 };
    expect(resolveSliderValue(35, r, "pointer")).toBe(35);
    expect(resolveSliderValue(35, r, "keyboard")).toBe(35);
  });
});
