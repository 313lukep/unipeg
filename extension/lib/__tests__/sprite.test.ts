import { beforeAll, describe, expect, it } from "vitest";

import { UPEG_BACKGROUND_COLORS, UPEG_COLORS, gridFromSeed } from "../upeg.js";
import {
  DEFAULT_SCALE,
  DUCK_RATIO,
  FLYER_EYE,
  FLYER_INK,
  FLYER_PIECE_ID,
  FLYER_SEED,
  FLYER_WING_CYCLE,
  RUN_CYCLE,
  buildFlyerFrames,
  buildFlyerGrids,
  buildRunCycleGrids,
  buildRunFrames,
  contentBounds,
  drawGrid,
  duckScaleFor,
  flyerScaleFor,
  keyOutBackground,
  mirrorCells,
  runCycleBounds,
  shadowCells,
  unionBounds,
} from "../sprite.js";
import fixtures from "../../../src/lib/upeg/__tests__/fixtures.json";
import alive from "../../data/upeg-alive.json";

type FixturePair = { id: string; seed: string; svg?: string };
const pairs = (fixtures as { pairs: FixturePair[] }).pairs.filter((p) => p.svg);
const SEED = BigInt(pairs[0].seed);

/* A canvas just real enough for the drawing code: it records every fillRect
 * into a pixel buffer and refuses non-integer geometry, which is exactly the
 * property we care about for pixel art. */
type FakeCanvas = {
  width: number;
  height: number;
  pixels: (string | null)[];
  smoothing: boolean;
  getContext(): FakeCtx;
};
type FakeCtx = {
  fillStyle: string;
  imageSmoothingEnabled: boolean;
  fillRect(x: number, y: number, w: number, h: number): void;
};

function makeFakeCanvas(): FakeCanvas {
  const canvas: FakeCanvas = {
    width: 0,
    height: 0,
    pixels: [],
    smoothing: true,
    getContext() {
      const ctx: FakeCtx = {
        fillStyle: "#000000",
        imageSmoothingEnabled: true,
        fillRect(x, y, w, h) {
          for (const v of [x, y, w, h]) {
            if (!Number.isInteger(v)) throw new Error(`non-integer fillRect: ${x},${y},${w},${h}`);
          }
          canvas.smoothing = ctx.imageSmoothingEnabled;
          for (let py = y; py < y + h; py++) {
            for (let px = x; px < x + w; px++) {
              if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
              canvas.pixels[py * canvas.width + px] = ctx.fillStyle;
            }
          }
        },
      };
      return ctx;
    },
  };
  return canvas;
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement(tag: string) {
      if (tag !== "canvas") throw new Error("unexpected element " + tag);
      const c = makeFakeCanvas();
      let w = 0;
      let h = 0;
      Object.defineProperty(c, "width", {
        get: () => w,
        set: (v) => {
          w = v;
          c.pixels = new Array(w * h).fill(null);
        },
      });
      Object.defineProperty(c, "height", {
        get: () => h,
        set: (v) => {
          h = v;
          c.pixels = new Array(w * h).fill(null);
        },
      });
      return c;
    },
  };
});

describe("sprite.js — background keying", () => {
  it("turns exactly the background cells transparent", () => {
    const grid = gridFromSeed(SEED);
    const keyed = keyOutBackground(grid);
    let nulls = 0;
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const isBg = grid.cells[y][x] === grid.bg;
        expect(keyed[y][x] === null).toBe(isBg);
        if (isBg) nulls++;
      }
    }
    expect(nulls).toBeGreaterThan(0);
    expect(nulls).toBeLessThan(24 * 24);
  });

  it("never keys out a unicorn pixel: the two palettes are disjoint", async () => {
    const { UPEG_COLORS, UPEG_BACKGROUND_COLORS } = await import("../upeg.js");
    const bg = new Set(UPEG_BACKGROUND_COLORS);
    for (const c of UPEG_COLORS) expect(bg.has(c)).toBe(false);
  });
});

describe("sprite.js — bounds", () => {
  it("finds the tight box of painted cells", () => {
    const cells: (string | null)[][] = Array.from({ length: 24 }, () => new Array(24).fill(null));
    cells[5][3] = "#ffffff";
    cells[9][8] = "#ffffff";
    expect(contentBounds(cells)).toEqual({ x: 3, y: 5, w: 6, h: 5 });
  });

  it("returns null for an empty grid", () => {
    const cells: (string | null)[][] = Array.from({ length: 24 }, () => new Array(24).fill(null));
    expect(contentBounds(cells)).toBeNull();
  });

  it("unions boxes and ignores nulls", () => {
    expect(unionBounds([{ x: 2, y: 2, w: 2, h: 2 }, null, { x: 6, y: 1, w: 1, h: 1 }])).toEqual({
      x: 2,
      y: 1,
      w: 5,
      h: 3,
    });
    expect(unionBounds([null])).toBeNull();
  });

  it("gives every run frame the same box so the sprite cannot jitter", () => {
    const grid = gridFromSeed(SEED);
    const keyed = buildRunCycleGrids(grid).map(keyOutBackground);
    const shared = runCycleBounds(keyed)!;
    for (const frame of keyed) {
      const own = contentBounds(frame)!;
      expect(own.x).toBeGreaterThanOrEqual(shared.x);
      expect(own.y).toBeGreaterThanOrEqual(shared.y);
      expect(own.x + own.w).toBeLessThanOrEqual(shared.x + shared.w);
      expect(own.y + own.h).toBeLessThanOrEqual(shared.y + shared.h);
    }
  });
});

describe("sprite.js — run cycle", () => {
  it("re-renders the piece with different leg variants only", () => {
    const grid = gridFromSeed(SEED);
    const cycle = buildRunCycleGrids(grid);
    expect(cycle).toHaveLength(RUN_CYCLE.length);
    for (let i = 0; i < cycle.length; i++) {
      expect(cycle[i].meta.legsFront).toBe(RUN_CYCLE[i].legsFront);
      expect(cycle[i].meta.legsBack).toBe(RUN_CYCLE[i].legsBack);
      // every other trait is untouched
      const { legsFront: _lf, legsBack: _lb, ...rest } = cycle[i].meta;
      const { legsFront: _olf, legsBack: _olb, ...original } = grid.meta;
      expect(rest).toEqual(original);
      expect(cycle[i].bg).toBe(grid.bg);
    }
  });

  it("actually changes pixels between the two frames", () => {
    const cycle = buildRunCycleGrids(gridFromSeed(SEED));
    expect(JSON.stringify(cycle[0].cells)).not.toBe(JSON.stringify(cycle[1].cells));
  });

  it("keeps both frames' feet on the same row", () => {
    const keyed = buildRunCycleGrids(gridFromSeed(SEED)).map(keyOutBackground);
    const bottoms = keyed.map((f) => contentBounds(f)!.y + contentBounds(f)!.h);
    expect(new Set(bottoms).size).toBe(1);
  });

  it("falls back to a single-grid cycle when there is no metadata to re-render", () => {
    const grid = gridFromSeed(SEED);
    const bare = { cells: grid.cells, bg: grid.bg };
    expect(buildRunCycleGrids(bare as never)).toHaveLength(1);
  });
});

describe("sprite.js — frame canvases", () => {
  it("builds same-size, smoothing-off frames at an integer scale", () => {
    const frames = buildRunFrames(gridFromSeed(SEED), { scale: 4 }) as unknown as FakeCanvas[] & {
      style: string;
      box: { w: number; h: number };
      cellPx: number;
    };
    expect(frames).toHaveLength(2);
    expect(frames.style).toBe("leg-swap");
    expect(frames.cellPx).toBe(4);
    const [a, b] = frames;
    expect(a.width).toBe(frames.box.w * 4);
    expect(a.height).toBe(frames.box.h * 4);
    expect(b.width).toBe(a.width);
    expect(b.height).toBe(a.height);
    expect(a.smoothing).toBe(false);
    // Transparent outside the piece, opaque where the piece is.
    expect(a.pixels.some((p) => p === null)).toBe(true);
    expect(a.pixels.some((p) => p !== null)).toBe(true);
    // The keyed background colour must not survive anywhere.
    const bg = gridFromSeed(SEED).bg;
    expect(a.pixels.includes(bg)).toBe(false);
  });

  it("defaults to a 4x scale", () => {
    const frames = buildRunFrames(gridFromSeed(SEED)) as unknown as { cellPx: number };
    expect(frames.cellPx).toBe(DEFAULT_SCALE);
  });

  it("uses the body-bob fallback when the legs cannot be swapped", () => {
    const grid = gridFromSeed(SEED);
    const bare = { cells: grid.cells, bg: grid.bg };
    const frames = buildRunFrames(bare as never, { scale: 3 }) as unknown as FakeCanvas[] & {
      style: string;
      box: { h: number };
    };
    expect(frames.style).toBe("body-bob");
    expect(frames).toHaveLength(2);
    // One extra cell of headroom for the lift, and the two frames differ.
    expect(frames[0].height).toBe((frames.box.h + 1) * 3);
    expect(JSON.stringify(frames[0].pixels)).not.toBe(JSON.stringify(frames[1].pixels));
  });

  it("survives a piece with nothing painted", () => {
    const empty = { cells: Array.from({ length: 24 }, () => new Array(24).fill("#1a1c2c")), bg: "#1a1c2c" };
    expect(buildRunFrames(empty as never)).toHaveLength(0);
  });
});

describe("sprite.js — the crouch", () => {
  it("only ever picks a smaller INTEGER scale", () => {
    for (let s = 1; s <= 16; s++) {
      const d = duckScaleFor(s);
      expect(Number.isInteger(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(s);
    }
    // The two scales the page actually ships (dpr 1 and dpr >= 2).
    expect(duckScaleFor(4)).toBe(3);
    expect(duckScaleFor(8)).toBe(6);
    expect(DUCK_RATIO).toBe(3 / 4);
  });

  it("rides along on the run frames, three quarters the height, same box", () => {
    const frames = buildRunFrames(gridFromSeed(SEED), { scale: 8 }) as unknown as FakeCanvas[] & {
      box: { w: number; h: number };
      duck: FakeCanvas[] & { cellPx: number; box: { w: number; h: number } };
    };
    const duck = frames.duck;
    expect(duck).toHaveLength(frames.length);
    expect(duck.cellPx).toBe(6);
    expect(duck.box).toEqual(frames.box);
    // Exactly 3/4 the standing size — no fractional squash anywhere.
    expect(duck[0].height).toBe(frames[0].height * 0.75);
    expect(duck[0].width).toBe(frames[0].width * 0.75);
    expect(duck[0].height).toBe(frames.box.h * 6);
    expect(duck[0].smoothing).toBe(false);
    // Still the piece, still animated.
    expect(duck[0].pixels.some((p) => p !== null)).toBe(true);
    expect(JSON.stringify(duck[0].pixels)).not.toBe(JSON.stringify(duck[1].pixels));
  });
});

describe("sprite.js — the flyer", () => {
  it("is built from real alive piece #39, wings 6 and horn 5", () => {
    expect(String(FLYER_SEED)).toBe(String((alive as Record<string, string>)[String(FLYER_PIECE_ID)]));
    const [raised] = buildFlyerGrids();
    expect(raised.meta.wings).toBe(6);
    expect(raised.meta.horn).toBe(5);
    expect(FLYER_WING_CYCLE).toEqual([6, 12]);
  });

  it("flaps between wings 6 and wings 12 and changes nothing else", () => {
    const [a, b] = buildFlyerGrids();
    expect(a.meta.wings).toBe(6);
    expect(b.meta.wings).toBe(12);
    const { wings: _aw, ...restA } = a.meta;
    const { wings: _bw, ...restB } = b.meta;
    expect(restA).toEqual(restB);
    // The wing is the only thing that moves, but it really does move.
    expect(JSON.stringify(a.cells)).not.toBe(JSON.stringify(b.cells));
  });

  it("carries no ground strip: a creature in flight stands on nothing", () => {
    for (const g of buildFlyerGrids()) expect(g.meta.ground).toBe(0);
  });

  it("paints every cell black but the eye, which stays light", () => {
    const grids = buildFlyerGrids();
    let eyes = 0;
    for (const g of grids) {
      const cells = shadowCells(g);
      for (const row of cells) {
        for (const c of row) {
          if (c === null) continue;
          expect([FLYER_INK, FLYER_EYE]).toContain(c);
          if (c === FLYER_EYE) eyes++;
        }
      }
    }
    // The eye is what gives the silhouette presence; it must actually be there.
    expect(eyes).toBeGreaterThan(0);
    expect(FLYER_INK).toBe("#0b0b0d");
  });

  it("keeps its two sentinel colours distinct from each other and the backdrop", () => {
    const [g] = buildFlyerGrids();
    const ink = UPEG_COLORS[32];
    const eye = UPEG_COLORS[35];
    expect(ink).not.toBe(eye);
    expect(UPEG_BACKGROUND_COLORS).not.toContain(ink);
    expect(UPEG_BACKGROUND_COLORS).not.toContain(eye);
    expect(g.bg).not.toBe(ink);
    expect(g.bg).not.toBe(eye);
  });

  it("mirrors exactly — it flies at the runner, not away from it", () => {
    expect(mirrorCells([["a", "b", "c"], [null, "d", null]])).toEqual([
      ["c", "b", "a"],
      [null, "d", null],
    ]);
    // The source piece faces right (its horn is up and to the right); the
    // flyer's eye must therefore end up on its left.
    const [g] = buildFlyerGrids();
    const eyeX = (cells: (string | null)[][]) => {
      for (let y = 0; y < cells.length; y++) {
        for (let x = 0; x < cells[y].length; x++) if (cells[y][x] === FLYER_EYE) return x;
      }
      return -1;
    };
    const before = eyeX(shadowCells(g));
    const after = eyeX(mirrorCells(shadowCells(g)));
    expect(before).toBeGreaterThan(12);
    expect(after).toBeLessThan(12);
  });

  it("renders two same-size frames at an integer scale", () => {
    const fly = buildFlyerFrames({ scale: 6 }) as unknown as FakeCanvas[] & {
      cellPx: number;
      style: string;
      box: { w: number; h: number };
    };
    expect(fly).toHaveLength(2);
    expect(fly.style).toBe("wing-flap");
    expect(fly.cellPx).toBe(6);
    expect(fly[0].width).toBe(fly[1].width);
    expect(fly[0].height).toBe(fly[1].height);
    expect(fly[0].height).toBe(fly.box.h * 6);
    expect(fly[0].smoothing).toBe(false);
    expect(JSON.stringify(fly[0].pixels)).not.toBe(JSON.stringify(fly[1].pixels));
    // Transparent around it, and not one pixel of any colour but ink and eye.
    expect(fly[0].pixels.some((p) => p === null)).toBe(true);
    for (const p of fly[0].pixels) if (p !== null) expect([FLYER_INK, FLYER_EYE]).toContain(p);
  });

  it("is scaled down from the runner, but never below 1x", () => {
    for (let s = 1; s <= 16; s++) {
      const f = flyerScaleFor(s);
      expect(Number.isInteger(f)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(1);
      expect(f).toBeLessThanOrEqual(s);
    }
    expect(flyerScaleFor(4)).toBe(3);
    expect(flyerScaleFor(8)).toBe(6);
  });

  it("rides along on the run frames too", () => {
    const frames = buildRunFrames(gridFromSeed(SEED), { scale: 4 }) as unknown as FakeCanvas[] & {
      flyer: FakeCanvas[] & { cellPx: number };
    };
    expect(frames.flyer).toHaveLength(2);
    expect(frames.flyer.cellPx).toBe(3);
  });
});

describe("sprite.js — drawGrid", () => {
  it("paints all 24x24 cells at integer geometry with smoothing off", () => {
    const canvas = makeFakeCanvas();
    canvas.width = 24 * 5;
    canvas.height = 24 * 5;
    canvas.pixels = new Array(canvas.width * canvas.height).fill(null);
    const ctx = canvas.getContext();
    const grid = gridFromSeed(SEED);
    drawGrid(ctx, grid, 5, 0, 0);
    expect(canvas.smoothing).toBe(false);
    expect(canvas.pixels.every((p) => p !== null)).toBe(true);
    // cell (7,3) must be the colour the grid says it is
    expect(canvas.pixels[(3 * 5 + 2) * canvas.width + (7 * 5 + 2)]).toBe(grid.cells[3][7]);
  });

  it("honours the destination offset", () => {
    const canvas = makeFakeCanvas();
    canvas.width = 24 * 2 + 10;
    canvas.height = 24 * 2 + 10;
    canvas.pixels = new Array(canvas.width * canvas.height).fill(null);
    drawGrid(canvas.getContext(), gridFromSeed(SEED), 2, 10, 10);
    expect(canvas.pixels[0]).toBeNull();
    expect(canvas.pixels[10 * canvas.width + 10]).not.toBeNull();
  });
});
