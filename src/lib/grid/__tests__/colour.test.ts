import { describe, expect, it } from "vitest";
import {
  complementTint,
  contrastRatio,
  darken,
  dominantBodyColour,
  hexToRgb,
  relLuminance,
  rgbToHex,
  rgbToHsl,
} from "../colour";
import { unipegGrid, PALETTE } from "./helpers";
import { GridValidationError } from "../types";

describe("hex <-> rgb", () => {
  it("round-trips", () => {
    expect(hexToRgb("#ff9ad5")).toEqual({ r: 255, g: 154, b: 213 });
    expect(rgbToHex(255, 154, 213)).toBe("#ff9ad5");
  });

  it("expands #rgb shorthand and normalises case", () => {
    expect(hexToRgb("#F0A")).toEqual({ r: 255, g: 0, b: 170 });
    expect(hexToRgb("#ABCDEF")).toEqual(hexToRgb("#abcdef"));
  });

  it("clamps and rounds when composing hex", () => {
    expect(rgbToHex(-4, 300, 127.6)).toBe("#00ff80");
  });

  it("rejects garbage", () => {
    expect(() => hexToRgb("magenta")).toThrow(GridValidationError);
    expect(() => hexToRgb("#12345")).toThrow(GridValidationError);
  });
});

describe("WCAG luminance / contrast", () => {
  it("black is 0, white is 1", () => {
    expect(relLuminance("#000000")).toBe(0);
    expect(relLuminance("#ffffff")).toBeCloseTo(1, 10);
  });

  it("contrastRatio(#000, #fff) is exactly 21", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 10);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 10); // symmetric
  });

  it("identical colours have ratio 1", () => {
    expect(contrastRatio("#ff9ad5", "#ff9ad5")).toBeCloseTo(1, 10);
  });
});

describe("darken", () => {
  it("moves toward black monotonically", () => {
    const l0 = relLuminance(darken("#ff9ad5", 0));
    const l1 = relLuminance(darken("#ff9ad5", 0.3));
    const l2 = relLuminance(darken("#ff9ad5", 0.7));
    expect(l0).toBeGreaterThan(l1);
    expect(l1).toBeGreaterThan(l2);
    expect(darken("#ff9ad5", 1)).toBe("#000000");
    expect(darken("#ff9ad5", 0)).toBe("#ff9ad5");
  });
});

describe("dominantBodyColour", () => {
  it("returns the most frequent non-bg colour", () => {
    expect(dominantBodyColour(unipegGrid(), PALETTE.bg)).toBe(PALETTE.body);
  });
});

describe("complementTint", () => {
  it("is deterministic", () => {
    expect(complementTint("#ff9ad5")).toBe(complementTint("#ff9ad5"));
    expect(complementTint("#1a1a1a")).toBe(complementTint("#1a1a1a"));
  });

  it("maps a pink body colour to a pale periwinkle", () => {
    for (const pink of ["#ffb6c1", "#ff9ad5"]) {
      const tint = complementTint(pink);
      const { r, g, b } = hexToRgb(tint);
      const { h, s, l } = rgbToHsl(r, g, b);
      expect(h).toBeGreaterThanOrEqual(200); // periwinkle-ish hue band
      expect(h).toBeLessThanOrEqual(260);
      expect(l).toBeGreaterThanOrEqual(0.8); // pale
      expect(s).toBeGreaterThanOrEqual(0.15); // desaturated but not grey
      expect(s).toBeLessThanOrEqual(0.45);
    }
  });

  it("always lands pale and desaturated regardless of input", () => {
    for (const hex of ["#000000", "#ffffff", "#12ff00", "#0a0aff"]) {
      const { r, g, b } = hexToRgb(complementTint(hex));
      const { s, l } = rgbToHsl(r, g, b);
      expect(l).toBeGreaterThanOrEqual(0.8);
      expect(l).toBeLessThanOrEqual(0.95);
      expect(s).toBeLessThanOrEqual(0.45);
    }
  });
});
