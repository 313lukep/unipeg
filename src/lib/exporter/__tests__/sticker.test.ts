import { describe, expect, it } from "vitest";
import { makeGrid, recomputePalette } from "@/lib/grid/grid";
import type { Grid } from "@/lib/grid/types";
import {
  buildStickerGrid,
  normaliseOutlineWidth,
  outlinePixels,
  renderStickerLayer,
  resolveStickerBackground,
  rotatePixelsNearest,
  type StickerOpts,
} from "@/lib/exporter/sticker";

function pieceGrid(): Grid {
  // 24x24, bg #ffecf5 ring, body blob #aa3355, head 4x4 at (10,4)
  const g = makeGrid(24, 24, "#ffecf5");
  for (let y = 4; y < 8; y++) for (let x = 10; x < 14; x++) g.cells[y][x] = "#aa3355";
  g.cells[5][11] = "#111111"; // eye
  return recomputePalette(g);
}

const baseOpts: StickerOpts = {
  outlineWidth: 0.5,
  outlineColour: "#ffffff",
  twoTone: false,
  rotationDeg: -22,
  background: { mode: "tint" },
  shadow: { on: true, opacity: 0.35 },
  scale: 0.78,
  nudgeX: 0,
  nudgeY: 0,
  size: 1000,
};

const SEL = { x: 9, y: 3, w: 6, h: 6 };
const BODY = [170, 51, 85, 255]; // #aa3355
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

function pixelAt(buf: Uint8ClampedArray, w: number, x: number, y: number): number[] {
  const i = (y * w + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

function countColour(buf: Uint8ClampedArray, rgba: number[]): number {
  let n = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i] === rgba[0] && buf[i + 1] === rgba[1] && buf[i + 2] === rgba[2] && buf[i + 3] === rgba[3]) n++;
  }
  return n;
}

describe("normaliseOutlineWidth", () => {
  it("keeps valid quarter-step values", () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5]) expect(normaliseOutlineWidth(v)).toBe(v);
  });
  it("snaps off-step values to the nearest quarter cell", () => {
    expect(normaliseOutlineWidth(0.3)).toBe(0.25);
    expect(normaliseOutlineWidth(0.6)).toBe(0.5);
    expect(normaliseOutlineWidth(1.1)).toBe(1);
  });
  it("clamps out-of-range values to [0, 1.5]", () => {
    expect(normaliseOutlineWidth(-1)).toBe(0);
    expect(normaliseOutlineWidth(3)).toBe(1.5);
  });
  it("non-finite input falls back to the 0.5 default", () => {
    expect(normaliseOutlineWidth(Number.NaN)).toBe(0.5);
    expect(normaliseOutlineWidth(Number.POSITIVE_INFINITY)).toBe(0.5);
  });
});

describe("buildStickerGrid", () => {
  it("crops to the selection and keys out the bg — no cell-space dilation", () => {
    const out = buildStickerGrid(pieceGrid(), SEL);
    expect(out.w).toBe(6);
    expect(out.h).toBe(6);
    // bg keyed out: no #ffecf5 anywhere
    expect(out.palette).not.toContain("#ffecf5");
    expect(out.palette).toContain("#aa3355");
    expect(out.palette).toContain("#111111");
    // outline is no longer added in cell space
    expect(out.palette).not.toContain("#ffffff");
  });
});

describe("resolveStickerBackground", () => {
  it("piece-bg returns the detected background", () => {
    expect(
      resolveStickerBackground(pieceGrid(), SEL, {
        ...baseOpts,
        background: { mode: "piece-bg" },
      }),
    ).toBe("#ffecf5");
  });
  it("solid returns the given colour", () => {
    expect(
      resolveStickerBackground(pieceGrid(), SEL, {
        ...baseOpts,
        background: { mode: "solid", colour: "#123456" },
      }),
    ).toBe("#123456");
  });
  it("tint is deterministic and not the body colour", () => {
    const t = resolveStickerBackground(pieceGrid(), SEL, baseOpts);
    expect(t).toMatch(/^#[0-9a-f]{6}$/);
    expect(t).not.toBe("#aa3355");
  });
  it("empty crop falls back without throwing", () => {
    const t = resolveStickerBackground(pieceGrid(), { x: 0, y: 16, w: 4, h: 4 }, baseOpts);
    expect(t).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("outlinePixels", () => {
  /** srcW x srcH fully opaque BODY-coloured block */
  function solidSrc(srcW: number, srcH: number): Uint8ClampedArray {
    const buf = new Uint8ClampedArray(srcW * srcH * 4);
    for (let i = 0; i < srcW * srcH; i++) buf.set(BODY, i * 4);
    return buf;
  }

  it("draws an exactly r-px hard band around the alpha mask", () => {
    const r = 4; // e.g. 0.5 cells at cellPx 8
    const { data, w, h } = outlinePixels(solidSrc(8, 8), 8, 8, r, "#ffffff");
    expect(w).toBe(8 + 2 * r);
    expect(h).toBe(8 + 2 * r);
    const mid = Math.floor(h / 2);
    // scanline: r px white, 8 px body, r px white — nothing else
    for (let x = 0; x < w; x++) {
      const expected = x < r || x >= r + 8 ? WHITE : BODY;
      expect(pixelAt(data, w, x, mid), `x=${x}`).toEqual(expected);
    }
    // corners are within Chebyshev distance r of the block -> filled (square kernel)
    expect(pixelAt(data, w, 0, 0)).toEqual(WHITE);
    // every pixel is binary alpha: 0 or 255, and only the two exact colours
    const seen = new Set<string>();
    for (let i = 0; i < data.length; i += 4)
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
    expect([...seen].sort()).toEqual([BODY.join(","), WHITE.join(",")].sort());
  });

  it("two-tone adds an exactly bandPx-wide darker outer ring", () => {
    const r = 4;
    const band = 2;
    const DARK = [153, 153, 153, 255]; // #999999
    const { data, w } = outlinePixels(solidSrc(8, 8), 8, 8, r, "#ffffff", band, "#999999");
    expect(w).toBe(8 + 2 * (r + band));
    const mid = Math.floor(w / 2);
    // scanline: band px dark, r px white, 8 px body, r px white, band px dark
    const runs: [number, number[]][] = [
      [band, DARK],
      [r, WHITE],
      [8, BODY],
      [r, WHITE],
      [band, DARK],
    ];
    let x = 0;
    for (const [len, colour] of runs) {
      for (let k = 0; k < len; k++, x++) {
        expect(pixelAt(data, w, x, mid), `x=${x}`).toEqual(colour);
      }
    }
    expect(x).toBe(w);
  });

  it("radius 0 with no band is a pure copy", () => {
    const src = solidSrc(3, 3);
    const { data, w, h } = outlinePixels(src, 3, 3, 0, "#ffffff");
    expect(w).toBe(3);
    expect(h).toBe(3);
    expect([...data]).toEqual([...src]);
  });

  it("keeps interior transparent holes hard-edged (outline only fills within r)", () => {
    // 7x7 block with a 3x3 transparent hole in the middle; r=1 fills the
    // hole's 1px inner ring, leaving the centre pixel transparent.
    const srcW = 7;
    const src = solidSrc(srcW, srcW);
    for (let y = 2; y < 5; y++)
      for (let x = 2; x < 5; x++) src.set(CLEAR, (y * srcW + x) * 4);
    const { data, w } = outlinePixels(src, srcW, srcW, 1, "#ffffff");
    expect(pixelAt(data, w, 1 + 3, 1 + 3)).toEqual(CLEAR); // centre stays open
    expect(pixelAt(data, w, 1 + 2, 1 + 3)).toEqual(WHITE); // ring filled
  });

  it("rejects mismatched buffers and negative radii", () => {
    expect(() => outlinePixels(new Uint8ClampedArray(8), 4, 4, 1, "#fff")).toThrow();
    expect(() => outlinePixels(solidSrc(4, 4), 4, 4, -1, "#ffffff")).toThrow();
  });
});

describe("renderStickerLayer", () => {
  /**
   * Find the widest horizontal run of `rgba` anywhere in the layer.
   */
  function maxRun(buf: Uint8ClampedArray, w: number, h: number, rgba: number[]): number {
    let best = 0;
    for (let y = 0; y < h; y++) {
      let run = 0;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const hit =
          buf[i] === rgba[0] && buf[i + 1] === rgba[1] && buf[i + 2] === rgba[2] && buf[i + 3] === rgba[3];
        run = hit ? run + 1 : 0;
        if (run > best) best = run;
      }
    }
    return best;
  }

  it("outline band measures round(outlineWidth * cellPx) px at tilt 0 (0.5-cell case)", () => {
    const target = 200;
    const { data, cellPx, outlinePx } = renderStickerLayer(pieceGrid(), SEL, {
      ...baseOpts,
      outlineWidth: 0.5,
      rotationDeg: 0,
    }, target);
    expect(outlinePx).toBe(Math.round(0.5 * cellPx));
    expect(outlinePx).toBeGreaterThan(0);
    // walk a scanline through a pure-body row (no eye): find the first body
    // pixel and count the outline pixels immediately to its left.
    let measured = -1;
    for (let y = 0; y < target && measured < 0; y++) {
      for (let x = 0; x < target; x++) {
        if (pixelAt(data, target, x, y).join() === BODY.join()) {
          // require a full-width body row so we are mid-body, not at the eye
          let runLen = 0;
          for (let k = x; k < target && pixelAt(data, target, k, y).join() === BODY.join(); k++) runLen++;
          if (runLen !== 4 * cellPx) break; // eye row or edge row — skip
          let white = 0;
          for (let k = x - 1; k >= 0 && pixelAt(data, target, k, y).join() === WHITE.join(); k--) white++;
          measured = white;
          break;
        }
      }
    }
    expect(measured).toBe(outlinePx);
  });

  it("outline band measures cellPx px for a whole-cell width of 1", () => {
    const target = 200;
    const { cellPx, outlinePx } = renderStickerLayer(pieceGrid(), SEL, {
      ...baseOpts,
      outlineWidth: 1,
      rotationDeg: 0,
    }, target);
    expect(outlinePx).toBe(cellPx);
  });

  it("outlineWidth 0 renders no outline at all", () => {
    const target = 200;
    const { data, outlinePx } = renderStickerLayer(pieceGrid(), SEL, {
      ...baseOpts,
      outlineWidth: 0,
      rotationDeg: 0,
    }, target);
    expect(outlinePx).toBe(0);
    expect(countColour(data, WHITE)).toBe(0);
  });

  it("tilt does not change size: identical cellPx and ~identical body pixel count at 0 / -22 / 45", () => {
    const target = 1000;
    const layers = [0, -22, 45].map((deg) =>
      renderStickerLayer(pieceGrid(), SEL, { ...baseOpts, rotationDeg: deg }, target),
    );
    const [r0, r22, r45] = layers;
    // cellPx derives from the UNROTATED outlined extent -> equal at every tilt
    expect(r22.cellPx).toBe(r0.cellPx);
    expect(r45.cellPx).toBe(r0.cellPx);
    // body-colour pixel count (excludes outline and background by colour):
    // NN rotation resamples the boundary, so allow 2% drift — under the old
    // rotated-bbox fit, 45deg was ~25%+ smaller.
    const c0 = countColour(r0.data, BODY);
    expect(c0).toBeGreaterThan(0);
    for (const [deg, layer] of [[-22, r22], [45, r45]] as const) {
      const c = countColour(layer.data, BODY);
      expect(Math.abs(c - c0) / c0, `deg=${deg}`).toBeLessThan(0.02);
    }
    // and the unrotated body run length is exactly 4 cells of the body blob
    expect(maxRun(r0.data, target, target, BODY)).toBe(4 * r0.cellPx);
  });

  it("rotated output stays blend-free: only sticker colours, outline and transparent", () => {
    const target = 240;
    const { data } = renderStickerLayer(pieceGrid(), SEL, {
      ...baseOpts,
      twoTone: true,
      rotationDeg: -22,
    }, target);
    const allowed = new Set([
      BODY.join(","),
      "17,17,17,255", // eye #111111
      WHITE.join(","),
      "153,153,153,255", // two-tone band: darken(#ffffff, 0.4)
      CLEAR.join(","),
    ]);
    for (let i = 0; i < data.length; i += 4) {
      const key = `${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`;
      if (!allowed.has(key)) throw new Error(`unexpected colour ${key}`);
    }
  });

  it("two-tone band radius is round(0.25 * cellPx) beyond the outline", () => {
    const { cellPx, outlinePx, bandPx, outW } = renderStickerLayer(pieceGrid(), SEL, {
      ...baseOpts,
      twoTone: true,
      rotationDeg: 0,
    }, 400);
    expect(bandPx).toBe(Math.round(0.25 * cellPx));
    expect(outW).toBe(6 * cellPx + 2 * (outlinePx + bandPx));
  });

  it("the outlined sticker fits the scale budget on its unrotated extent", () => {
    const target = 1000;
    const { cellPx, outW, outH } = renderStickerLayer(pieceGrid(), SEL, {
      ...baseOpts,
      rotationDeg: 45,
    }, target);
    expect(Math.max(outW, outH)).toBeLessThanOrEqual(Math.ceil(baseOpts.scale * target));
    expect(cellPx).toBeGreaterThan(0);
  });
});

describe("rotatePixelsNearest", () => {
  const RED = [220, 40, 60, 255];

  /** src: srcW x srcH RGBA, WHITE 1px border, RED interior — mimics outline. */
  function outlinedSrc(srcW: number, srcH: number): Uint8ClampedArray {
    const buf = new Uint8ClampedArray(srcW * srcH * 4);
    for (let y = 0; y < srcH; y++)
      for (let x = 0; x < srcW; x++) {
        const edge = x === 0 || y === 0 || x === srcW - 1 || y === srcH - 1;
        buf.set(edge ? WHITE : RED, (y * srcW + x) * 4);
      }
    return buf;
  }

  it("regression: rotated output contains ONLY exact source colours or transparent (no AA blends)", () => {
    // The old ctx.rotate()+drawImage path produced dozens of greyscale blend
    // colours along rotated outline edges. NN mapping must produce none.
    const srcW = 16;
    const srcH = 12;
    const src = outlinedSrc(srcW, srcH);
    for (const deg of [-22, 7, 33, 45, 90, 137, 180]) {
      const out = rotatePixelsNearest(src, srcW, srcH, (deg * Math.PI) / 180, 48, 48, 24, 24);
      const seen = new Set<string>();
      for (let i = 0; i < out.length; i += 4) {
        seen.add(`${out[i]},${out[i + 1]},${out[i + 2]},${out[i + 3]}`);
      }
      for (const c of seen) {
        expect([RED.join(","), WHITE.join(","), CLEAR.join(",")], `deg=${deg}`).toContain(c);
      }
      // both source colours survive the rotation
      expect(seen.has(RED.join(",")), `deg=${deg} keeps interior`).toBe(true);
      expect(seen.has(WHITE.join(",")), `deg=${deg} keeps outline`).toBe(true);
    }
  });

  it("rotation 0 is an exact integer-offset copy (placement matches old drawImage maths)", () => {
    const srcW = 4;
    const srcH = 4;
    const src = new Uint8ClampedArray(srcW * srcH * 4);
    for (let i = 0; i < srcW * srcH; i++) src.set([i * 10, 255 - i * 10, i, 255], i * 4);
    // centre at (4, 4) in an 8x8 dest -> top-left of src lands at (2, 2)
    const out = rotatePixelsNearest(src, srcW, srcH, 0, 8, 8, 4, 4);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const inside = x >= 2 && x < 6 && y >= 2 && y < 6;
        const expected = inside ? pixelAt(src, srcW, x - 2, y - 2) : CLEAR;
        expect(pixelAt(out, 8, x, y), `dest (${x},${y})`).toEqual(expected);
      }
  });

  it("rotation 180 flips the source exactly", () => {
    const srcW = 4;
    const srcH = 4;
    const src = new Uint8ClampedArray(srcW * srcH * 4);
    for (let i = 0; i < srcW * srcH; i++) src.set([i, i * 2, i * 3, 255], i * 4);
    const out = rotatePixelsNearest(src, srcW, srcH, Math.PI, 4, 4, 2, 2);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        expect(pixelAt(out, 4, x, y), `dest (${x},${y})`).toEqual(
          pixelAt(src, srcW, 3 - x, 3 - y),
        );
      }
  });

  it("destination pixels outside the source stay fully transparent", () => {
    const src = outlinedSrc(4, 4);
    const out = rotatePixelsNearest(src, 4, 4, (-22 * Math.PI) / 180, 12, 12, 6, 6);
    expect(pixelAt(out, 12, 0, 0)).toEqual(CLEAR);
    expect(pixelAt(out, 12, 11, 11)).toEqual(CLEAR);
  });

  it("rejects a src buffer that does not match the given dimensions", () => {
    expect(() => rotatePixelsNearest(new Uint8ClampedArray(10), 4, 4, 0, 8, 8, 4, 4)).toThrow();
  });
});
