import { Grid, GridValidationError } from "./types";

const HEX6 = /^#([0-9a-f]{6})$/i;
const HEX3 = /^#([0-9a-f]{3})$/i;

/** Parse "#rrggbb" (or "#rgb") into channel values 0..255. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.trim().toLowerCase();
  const m6 = HEX6.exec(h);
  if (m6) {
    const v = parseInt(m6[1], 16);
    return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
  }
  const m3 = HEX3.exec(h);
  if (m3) {
    const [r, g, b] = m3[1].split("").map((c) => parseInt(c + c, 16));
    return { r, g, b };
  }
  throw new GridValidationError(`invalid hex colour "${hex}"`);
}

/** Channels 0..255 (clamped/rounded) -> lowercase "#rrggbb". */
export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function relLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio, 1..21 (order of arguments does not matter). */
export function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Darken by scaling all channels toward black; amount 0 (no-op) .. 1 (black). */
export function darken(hex: string, amount: number): string {
  const a = Math.max(0, Math.min(1, amount));
  const { r, g, b } = hexToRgb(hex);
  const k = 1 - a;
  return rgbToHex(r * k, g * k, b * k);
}

/** Most frequent non-null, non-bg colour; ties broken by first appearance (row-major). */
export function dominantBodyColour(g: Grid, bg: string): string {
  const bgLower = bg.toLowerCase();
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let i = 0;
  for (let y = 0; y < g.h; y++) {
    const row = g.cells[y];
    for (let x = 0; x < g.w; x++, i++) {
      const c = row[x];
      if (c === null || c === bgLower) continue;
      counts.set(c, (counts.get(c) ?? 0) + 1);
      if (!firstSeen.has(c)) firstSeen.set(c, i);
    }
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const [c, n] of counts) {
    if (
      n > bestCount ||
      (n === bestCount && firstSeen.get(c)! < firstSeen.get(best!)!)
    ) {
      best = c;
      bestCount = n;
    }
  }
  if (best === null) {
    throw new GridValidationError("dominantBodyColour: grid has no non-background cells");
  }
  return best;
}

// ---------------------------------------------------------------------------
// HSL helpers (internal)
// ---------------------------------------------------------------------------

export function rgbToHsl(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = 60 * (((gn - bn) / d + 6) % 6);
  else if (max === gn) h = 60 * ((bn - rn) / d + 2);
  else h = 60 * ((rn - gn) / d + 4);
  return { h, s, l };
}

export function hslToRgb(
  h: number,
  s: number,
  l: number,
): { r: number; g: number; b: number } {
  const hn = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hn / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hn < 60) [rp, gp, bp] = [c, x, 0];
  else if (hn < 120) [rp, gp, bp] = [x, c, 0];
  else if (hn < 180) [rp, gp, bp] = [0, c, x];
  else if (hn < 240) [rp, gp, bp] = [0, x, c];
  else if (hn < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return {
    r: Math.round((rp + m) * 255),
    g: Math.round((gp + m) * 255),
    b: Math.round((bp + m) * 255),
  };
}

/**
 * Push a colour toward a pale, desaturated complement (sticker-background
 * tint). Deterministic.
 *
 * Mechanism: hue is rotated 180deg (HSL complement) plus a constant 60deg
 * "cool drift", then saturation is pinned to 30% and lightness to 87%. The
 * drift exists because the product requirement is that a pink body colour
 * lands on a pale periwinkle (hue ~200-260); the mathematically exact HSL
 * complement of pink is mint green, so all complements are drifted 60deg
 * toward blue. Still a fixed, deterministic mapping.
 */
export function complementTint(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const { h } = rgbToHsl(r, g, b);
  const h2 = (h + 180 + 60) % 360;
  const out = hslToRgb(h2, 0.3, 0.87);
  return rgbToHex(out.r, out.g, out.b);
}
