import { describe, expect, it } from "vitest";

import { makeGrid, recomputePalette, type Grid } from "@/lib/grid";
import {
  RESTING_CHROMA,
  RESTING_HUE,
  accentContrast,
  extractPieceTheme,
  hexToOklch,
} from "@/lib/retint";

/** Paint a rectangle of cells on a grid (mutates), returns the grid. */
function paint(
  g: Grid,
  x: number,
  y: number,
  w: number,
  h: number,
  colour: string,
): Grid {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      g.cells[yy][xx] = colour.toLowerCase();
    }
  }
  return recomputePalette(g);
}

describe("hexToOklch", () => {
  it("converts pure sRGB red to the known OKLCH value", () => {
    // Reference (Ottosson / culori): oklch(0.6280 0.2577 29.23).
    // (Some cheat-sheets quote c≈0.226 — that is the Oklab a-component,
    // not the chroma.)
    const { l, c, h } = hexToOklch("#ff0000");
    expect(l).toBeCloseTo(0.628, 2);
    expect(c).toBeCloseTo(0.2577, 2);
    expect(h).toBeCloseTo(29.23, 0);
  });

  it("converts pure sRGB blue to the known OKLCH value", () => {
    const { l, c, h } = hexToOklch("#0000ff");
    expect(l).toBeCloseTo(0.452, 2);
    expect(c).toBeCloseTo(0.3132, 2);
    expect(h).toBeCloseTo(264.05, 0);
  });

  it("reports ~zero chroma for grayscale", () => {
    for (const hex of ["#000000", "#808080", "#ffffff", "#333333"]) {
      expect(hexToOklch(hex).c).toBeLessThan(0.001);
    }
    expect(hexToOklch("#ffffff").l).toBeCloseTo(1, 3);
    expect(hexToOklch("#000000").l).toBeCloseTo(0, 3);
  });

  it("accepts #rgb shorthand and uppercase", () => {
    const a = hexToOklch("#F00");
    const b = hexToOklch("#ff0000");
    expect(a.l).toBeCloseTo(b.l, 6);
    expect(a.c).toBeCloseTo(b.c, 6);
    expect(a.h).toBeCloseTo(b.h, 6);
  });

  it("throws on invalid input", () => {
    expect(() => hexToOklch("not-a-colour")).toThrow();
    expect(() => hexToOklch("#12345")).toThrow();
  });
});

describe("extractPieceTheme", () => {
  it("discards the background and lets the dominant chromatic colour win", () => {
    const g = makeGrid(24, 24, "#ffffff");
    paint(g, 4, 4, 6, 6, "#ff0000"); // 36 cells, c≈0.258
    paint(g, 12, 12, 2, 2, "#00ff00"); // 4 cells, c≈0.295
    const theme = extractPieceTheme(g);

    expect(theme.mono).toBe(false);
    // red: 0.2577 × sqrt(36/40) ≈ 0.244  >  green: 0.2949 × sqrt(4/40) ≈ 0.093
    expect(theme.swatches[0]).toBe("#ff0000");
    expect(theme.swatches).toContain("#00ff00");
    expect(theme.h).toBeCloseTo(29.23, 0);
    // chroma clamped into [0.05, 0.19]
    expect(theme.c).toBe(0.19);
  });

  it("keeps at most 4 swatches, ranked by chroma × sqrt(coverage)", () => {
    const g = makeGrid(24, 24, "#ffffff");
    // scores (chroma × sqrt coverage): red .178 > blue .137 > green .129
    // > magenta .070 > yellow .065 — yellow falls off the 4-swatch cut
    paint(g, 0, 4, 24, 5, "#ff0000");
    paint(g, 0, 9, 24, 2, "#0000ff");
    paint(g, 0, 11, 24, 2, "#00ff00");
    paint(g, 0, 13, 24, 1, "#ffff00");
    paint(g, 0, 14, 12, 1, "#ff00ff");
    const theme = extractPieceTheme(g);

    expect(theme.swatches).toHaveLength(4);
    expect(theme.swatches[0]).toBe("#ff0000");
    expect(theme.mono).toBe(false);
  });

  it("flags an all-grey piece as mono and rests on pink", () => {
    const g = makeGrid(24, 24, "#ffffff");
    paint(g, 4, 4, 8, 8, "#777777");
    paint(g, 14, 4, 4, 4, "#333333");
    const theme = extractPieceTheme(g);

    expect(theme.mono).toBe(true);
    expect(theme.h).toBe(RESTING_HUE);
    expect(theme.c).toBe(RESTING_CHROMA);
    expect(theme.swatches.length).toBeGreaterThan(0);
  });

  it("clamps a low-chroma (but not mono) winner up to 0.05", () => {
    const g = makeGrid(24, 24, "#ffffff");
    // a muted brick — chromatic enough to pass the mono gate (c ≈ 0.07)
    paint(g, 4, 4, 8, 8, "#966060");
    const theme = extractPieceTheme(g);

    expect(theme.mono).toBe(false);
    expect(theme.c).toBeGreaterThanOrEqual(0.05);
    expect(theme.c).toBeLessThanOrEqual(0.19);
  });

  it("returns a resting mono theme for a grid with no foreground", () => {
    const g = makeGrid(24, 24, "#ffffff"); // background only
    const theme = extractPieceTheme(g);

    expect(theme.mono).toBe(true);
    expect(theme.swatches).toEqual([]);
    expect(theme.h).toBe(RESTING_HUE);
    expect(theme.c).toBe(RESTING_CHROMA);
  });

  it("handles a fully transparent grid without throwing", () => {
    const g = makeGrid(24, 24, null);
    const theme = extractPieceTheme(g);
    expect(theme.mono).toBe(true);
    expect(theme.swatches).toEqual([]);
  });
});

describe("accentContrast (dev-mode contrast belt)", () => {
  it("stays at or above AA 4.5:1 across all 360 hues at max chroma, both modes", () => {
    // DESIGN.md's verified worst cases: 5.83:1 light / 8.76:1 dark — the
    // lightness pin makes this structural. Assert the AA floor with margin.
    for (let h = 0; h < 360; h++) {
      const theme = { h, c: 0.19 };
      expect(accentContrast(theme, "light")).toBeGreaterThanOrEqual(4.5);
      expect(accentContrast(theme, "dark")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("matches DESIGN.md's verified worst cases within tolerance", () => {
    let worstLight = Infinity;
    let worstDark = Infinity;
    for (let h = 0; h < 360; h++) {
      worstLight = Math.min(worstLight, accentContrast({ h, c: 0.19 }, "light"));
      worstDark = Math.min(worstDark, accentContrast({ h, c: 0.19 }, "dark"));
    }
    expect(worstLight).toBeCloseTo(5.83, 0);
    expect(worstDark).toBeCloseTo(8.76, 0);
  });

  it("passes for the resting pink theme", () => {
    const resting = { h: RESTING_HUE, c: RESTING_CHROMA };
    expect(accentContrast(resting, "light")).toBeGreaterThanOrEqual(4.5);
    expect(accentContrast(resting, "dark")).toBeGreaterThanOrEqual(4.5);
  });

  it("caps dark-mode chroma at 0.17 like the CSS formula", () => {
    // Chroma beyond the cap must not change the dark-mode result.
    const a = accentContrast({ h: 200, c: 0.17 }, "dark");
    const b = accentContrast({ h: 200, c: 0.3 }, "dark");
    expect(b).toBeCloseTo(a, 10);
  });

  it("returns a sane WCAG ratio (1..21)", () => {
    for (const mode of ["light", "dark"] as const) {
      const r = accentContrast({ h: 120, c: 0.1 }, mode);
      expect(r).toBeGreaterThan(1);
      expect(r).toBeLessThanOrEqual(21);
    }
  });
});
