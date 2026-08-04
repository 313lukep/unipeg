import { Grid } from "../types";
import { recomputePalette } from "../grid";
import { hexToRgb } from "../colour";
import { ImageDataLike } from "../imageToGrid";

/** Build a grid from ASCII art rows and a char -> colour map. */
export function gridFrom(rows: string[], map: Record<string, string | null>): Grid {
  const h = rows.length;
  const w = rows[0].length;
  const cells = rows.map((row) => {
    if (row.length !== w) throw new Error("ragged rows in fixture");
    return row.split("").map((ch) => {
      if (!(ch in map)) throw new Error(`no colour mapped for "${ch}"`);
      return map[ch];
    });
  });
  return recomputePalette({ w, h, cells, palette: [] });
}

export const PALETTE = {
  bg: "#e6e1f2",
  body: "#ff9ad5",
  mane: "#7a2ea0",
  horn: "#ffd166",
  dark: "#1a1a1a",
};

/**
 * A 24x24 unipeg-ish fixture: lavender background, pink body + head + legs,
 * purple mane, yellow horn, single dark eye cell at (17, 7). 5 colours.
 */
export function unipegGrid(): Grid {
  const { bg, body, mane, horn, dark } = PALETTE;
  const g = gridFrom(
    Array.from({ length: 24 }, () => ".".repeat(24)),
    { ".": bg },
  );
  const fill = (x: number, y: number, w: number, h: number, c: string) => {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) g.cells[yy][xx] = c;
  };
  fill(4, 10, 12, 8, body); // body
  fill(14, 5, 6, 6, body); // head
  fill(12, 4, 2, 7, mane); // mane
  fill(16, 1, 1, 4, horn); // horn
  fill(17, 7, 1, 1, dark); // eye
  fill(5, 18, 2, 4, body); // rear leg
  fill(11, 18, 2, 4, body); // front leg
  return recomputePalette(g);
}

/**
 * Nearest-neighbour "screenshot" renderer: paints `g` at `cellPx` pixels per
 * cell (float allowed) with the art's top-left at (marginLeft, marginTop),
 * into an outW x outH RGBA buffer. Pixels outside the art get `marginColour`
 * (null = transparent). `noise` may perturb every channel deterministically.
 */
export function renderToImageData(
  g: Grid,
  cellPx: number,
  opts: {
    outW: number;
    outH: number;
    marginLeft?: number;
    marginTop?: number;
    marginColour?: string | null;
    noise?: (x: number, y: number, channel: number) => number;
  },
): ImageDataLike {
  const { outW, outH } = opts;
  const marginLeft = opts.marginLeft ?? 0;
  const marginTop = opts.marginTop ?? 0;
  const marginColour = opts.marginColour ?? null;
  const data = new Uint8ClampedArray(outW * outH * 4);
  const marginRgb = marginColour === null ? null : hexToRgb(marginColour);

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const cx = Math.floor((x - marginLeft) / cellPx);
      const cy = Math.floor((y - marginTop) / cellPx);
      let rgba: [number, number, number, number];
      if (cx >= 0 && cy >= 0 && cx < g.w && cy < g.h && x >= marginLeft && y >= marginTop) {
        const cell = g.cells[cy][cx];
        if (cell === null) rgba = [0, 0, 0, 0];
        else {
          const { r, g: gg, b } = hexToRgb(cell);
          rgba = [r, gg, b, 255];
        }
      } else if (marginRgb) {
        rgba = [marginRgb.r, marginRgb.g, marginRgb.b, 255];
      } else {
        rgba = [0, 0, 0, 0];
      }
      const i = (y * outW + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        let v = rgba[ch];
        if (opts.noise && ch < 3 && rgba[3] !== 0) v += opts.noise(x, y, ch);
        data[i + ch] = Math.max(0, Math.min(255, v));
      }
    }
  }
  return { width: outW, height: outH, data };
}
