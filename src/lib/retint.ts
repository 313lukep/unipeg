/**
 * Retint — "the piece signs the studio".
 *
 * Pure OKLCH maths (sRGB -> linear -> LMS -> Oklab -> LCh, no dependency) plus
 * the theme application that pushes --piece-h / --piece-c onto <html> so the
 * derived --accent / --wash tokens flush to the loaded piece's palette.
 *
 * Only hue and chroma ever travel; lightness is pinned per mode in the CSS
 * formulas, which is what makes contrast structural (see docs/DESIGN.md).
 */

import type { Grid } from "@/lib/grid";
import { detectBackground } from "@/lib/grid";

export type Oklch = { l: number; c: number; h: number };

export type PieceTheme = {
  /** OKLCH hue 0–360 of the winning swatch (resting pink hue when mono). */
  h: number;
  /** OKLCH chroma, clamped to [0.05, 0.19] (resting chroma when mono). */
  c: number;
  /** ≤4 hex swatches ranked by chroma × sqrt(coverage), background discarded. */
  swatches: string[];
  /** true when every extracted colour is effectively grayscale — stay pink. */
  mono: boolean;
};

/** Resting pink hue — matches the @property initial-value in globals.css. */
export const RESTING_HUE = 340;
/** Resting pink chroma — matches the @property initial-value in globals.css. */
export const RESTING_CHROMA = 0.16;

const MONO_CHROMA_THRESHOLD = 0.05;
const CHROMA_MIN = 0.05;
const CHROMA_MAX = 0.19;
const MAX_SWATCHES = 4;

/* ------------------------------------------------------------------ */
/* OKLCH conversion                                                    */
/* ------------------------------------------------------------------ */

function srgbToLinear(u: number): number {
  return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`hexToOklch: invalid hex colour "${hex}"`);
  let s = m[1];
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  return {
    r: parseInt(s.slice(0, 2), 16) / 255,
    g: parseInt(s.slice(2, 4), 16) / 255,
    b: parseInt(s.slice(4, 6), 16) / 255,
  };
}

/**
 * Hex colour -> OKLCH. Real maths: sRGB -> linear -> LMS (cube-rooted) ->
 * Oklab -> LCh, using Björn Ottosson's published matrices.
 * h is degrees in [0, 360); for achromatic colours (c ≈ 0) h is 0.
 */
export function hexToOklch(hex: string): Oklch {
  const { r, g, b } = parseHex(hex);
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const c = Math.sqrt(a * a + bb * bb);
  let h = c < 1e-7 ? 0 : (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;

  return { l: L, c, h };
}

/* ------------------------------------------------------------------ */
/* Contrast belt (dev-mode assert per DESIGN.md)                       */
/* ------------------------------------------------------------------ */

/** Paper per mode — must match the --paper tokens in globals.css. */
const PAPER_HEX = { light: "#ffffff", dark: "#0b0b0d" } as const;
/** Dark-mode accent chroma cap — matches `min(var(--piece-c), 0.17)`. */
const DARK_ACCENT_CHROMA_CAP = 0.17;
/** AA floor for normal text. */
const CONTRAST_FLOOR = 4.5;

/** OKLCH -> linear sRGB (inverse Ottosson matrices), channels clamped to [0,1]. */
function oklchToLinearRgb({ l, c, h }: Oklch): { r: number; g: number; b: number } {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const lm = l_ * l_ * l_;
  const mm = m_ * m_ * m_;
  const sm = s_ * s_ * s_;

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  return {
    r: clamp01(4.0767416621 * lm - 3.3077115913 * mm + 0.2309699292 * sm),
    g: clamp01(-1.2684380046 * lm + 2.6097574011 * mm - 0.3413193965 * sm),
    b: clamp01(-0.0041960863 * lm - 0.7034186147 * mm + 1.707614701 * sm),
  };
}

/** WCAG relative luminance from linear-light sRGB channels. */
function wcagLuminance(rgb: { r: number; g: number; b: number }): number {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

function hexLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return wcagLuminance({
    r: srgbToLinear(r),
    g: srgbToLinear(g),
    b: srgbToLinear(b),
  });
}

/**
 * WCAG contrast ratio of the accent the CSS formulas would actually apply
 * (`oklch(0.45 c h)` light, `oklch(0.80 min(c, 0.17) h)` dark) against that
 * mode's paper. Pure — safe to unit-test; used by the dev-mode belt below.
 */
export function accentContrast(
  theme: Pick<PieceTheme, "h" | "c">,
  mode: "light" | "dark",
): number {
  const accent: Oklch =
    mode === "light"
      ? { l: 0.45, c: theme.c, h: theme.h }
      : { l: 0.8, c: Math.min(theme.c, DARK_ACCENT_CHROMA_CAP), h: theme.h };
  const a = wcagLuminance(oklchToLinearRgb(accent));
  const p = hexLuminance(PAPER_HEX[mode]);
  const hi = Math.max(a, p);
  const lo = Math.min(a, p);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------ */
/* Theme extraction                                                    */
/* ------------------------------------------------------------------ */

const RESTING_THEME_BASE = { h: RESTING_HUE, c: RESTING_CHROMA } as const;

/**
 * Extract the piece theme from a loaded 24×24 grid: discard the detected
 * background colour, rank the remaining colours (≤4 kept) by
 * chroma × sqrt(coverage); the winner sets h/c (c clamped to [0.05, 0.19]).
 * mono=true (grayscale guard) if the max extracted chroma < 0.05.
 */
export function extractPieceTheme(grid: Grid): PieceTheme {
  let bg: string | null = null;
  try {
    bg = detectBackground(grid).toLowerCase();
  } catch {
    bg = null; // fully transparent ring — nothing to discard
  }

  const counts = new Map<string, number>();
  let total = 0;
  for (let y = 0; y < grid.h; y++) {
    const row = grid.cells[y];
    for (let x = 0; x < grid.w; x++) {
      const cell = row[x];
      if (cell === null) continue;
      const colour = cell.toLowerCase();
      if (colour === bg) continue;
      counts.set(colour, (counts.get(colour) ?? 0) + 1);
      total++;
    }
  }

  if (total === 0) {
    return { ...RESTING_THEME_BASE, swatches: [], mono: true };
  }

  const ranked = [...counts.entries()]
    .map(([hex, count]) => {
      const lch = hexToOklch(hex);
      return { hex, lch, score: lch.c * Math.sqrt(count / total) };
    })
    .sort((p, q) => q.score - p.score)
    .slice(0, MAX_SWATCHES);

  const swatches = ranked.map((r) => r.hex);
  const maxChroma = Math.max(...ranked.map((r) => r.lch.c));

  if (maxChroma < MONO_CHROMA_THRESHOLD) {
    return { ...RESTING_THEME_BASE, swatches, mono: true };
  }

  const winner = ranked[0].lch;
  return {
    h: winner.h,
    c: Math.min(CHROMA_MAX, Math.max(CHROMA_MIN, winner.c)),
    swatches,
    mono: false,
  };
}

/* ------------------------------------------------------------------ */
/* Theme application (browser only — SSR-safe no-ops)                  */
/* ------------------------------------------------------------------ */

/**
 * Apply a piece theme by setting --piece-h/--piece-c on <html>. The
 * properties are registered via @property so the change animates wherever
 * .u-transition-piece is in effect. Mono themes reset to resting pink.
 */
export function applyPieceTheme(theme: PieceTheme): void {
  if (typeof document === "undefined") return;
  if (theme.mono) {
    clearPieceTheme();
    return;
  }
  const style = document.documentElement.style;
  style.setProperty("--piece-h", String(theme.h));
  style.setProperty("--piece-c", String(theme.c));

  // Dev-mode belt (DESIGN.md accessibility): the lightness pin makes contrast
  // structural, but re-check the computed accent-vs-paper ratio anyway.
  if (process.env.NODE_ENV !== "production") {
    for (const mode of ["light", "dark"] as const) {
      const ratio = accentContrast(theme, mode);
      if (ratio < CONTRAST_FLOOR) {
        console.warn(
          `retint: accent vs paper contrast ${ratio.toFixed(2)}:1 (${mode}) ` +
            `is below ${CONTRAST_FLOOR}:1 for h=${theme.h} c=${theme.c}`,
        );
      }
    }
  }
}

/** Remove the overrides so the registered initial values (resting pink) win. */
export function clearPieceTheme(): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  style.removeProperty("--piece-h");
  style.removeProperty("--piece-c");
}
