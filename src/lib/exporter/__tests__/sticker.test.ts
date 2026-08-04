import { describe, expect, it } from "vitest";
import { makeGrid, recomputePalette } from "@/lib/grid/grid";
import type { Grid } from "@/lib/grid/types";
import {
  buildStickerGrid,
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
  outlineWidth: 1,
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

describe("buildStickerGrid", () => {
  it("expands by outlineWidth per side and keys out the bg", () => {
    const g = pieceGrid();
    const sel = { x: 9, y: 3, w: 6, h: 6 };
    const out = buildStickerGrid(g, sel, baseOpts);
    expect(out.w).toBe(6 + 2);
    expect(out.h).toBe(6 + 2);
    // bg keyed out: no #ffecf5 anywhere
    expect(out.palette).not.toContain("#ffecf5");
    expect(out.palette).toContain("#ffffff");
    expect(out.palette).toContain("#aa3355");
  });

  it("two-tone adds one more cell per side and a darker ring colour", () => {
    const g = pieceGrid();
    const sel = { x: 9, y: 3, w: 6, h: 6 };
    const out = buildStickerGrid(g, sel, { ...baseOpts, twoTone: true, outlineWidth: 2 });
    expect(out.w).toBe(6 + 2 * 2 + 2);
    expect(out.palette).toContain("#999999"); // darken(#ffffff, 0.4)
  });

  it("outlineWidth 0 keeps selection size", () => {
    const g = pieceGrid();
    const out = buildStickerGrid(g, { x: 9, y: 3, w: 6, h: 6 }, { ...baseOpts, outlineWidth: 0 });
    expect(out.w).toBe(6);
    expect(out.h).toBe(6);
  });
});

describe("resolveStickerBackground", () => {
  it("piece-bg returns the detected background", () => {
    expect(
      resolveStickerBackground(pieceGrid(), { x: 9, y: 3, w: 6, h: 6 }, {
        ...baseOpts,
        background: { mode: "piece-bg" },
      }),
    ).toBe("#ffecf5");
  });
  it("solid returns the given colour", () => {
    expect(
      resolveStickerBackground(pieceGrid(), { x: 9, y: 3, w: 6, h: 6 }, {
        ...baseOpts,
        background: { mode: "solid", colour: "#123456" },
      }),
    ).toBe("#123456");
  });
  it("tint is deterministic and not the body colour", () => {
    const t = resolveStickerBackground(pieceGrid(), { x: 9, y: 3, w: 6, h: 6 }, baseOpts);
    expect(t).toMatch(/^#[0-9a-f]{6}$/);
    expect(t).not.toBe("#aa3355");
  });
  it("empty crop falls back without throwing", () => {
    const t = resolveStickerBackground(pieceGrid(), { x: 0, y: 16, w: 4, h: 4 }, baseOpts);
    expect(t).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("rotatePixelsNearest", () => {
  const RED = [220, 40, 60, 255];
  const WHITE = [255, 255, 255, 255];
  const CLEAR = [0, 0, 0, 0];

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

  function pixelAt(buf: Uint8ClampedArray, w: number, x: number, y: number): number[] {
    const i = (y * w + x) * 4;
    return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
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
