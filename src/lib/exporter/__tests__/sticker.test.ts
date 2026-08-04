import { describe, expect, it } from "vitest";
import { makeGrid, recomputePalette } from "@/lib/grid/grid";
import type { Grid } from "@/lib/grid/types";
import {
  buildStickerGrid,
  resolveStickerBackground,
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
