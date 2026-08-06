import { beforeAll, describe, expect, it } from "vitest";

import { UPEG_BACKGROUND_COLORS, UPEG_COLORS, decodeSeed, gridFromMetadata, gridFromSeed } from "../upeg.js";
import {
  DEFAULT_SCALE,
  DUCK_DROP,
  DUCK_LEAN,
  FLYER_EYE,
  FLYER_INK,
  FLYER_LAYERS,
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
  duckCells,
  flyerScaleFor,
  keyOutBackground,
  mirrorCells,
  neckPivot,
  runCycleBounds,
  safeLean,
  shadowCells,
  topLine,
  unionBounds,
} from "../sprite.js";
import { contrastRatio } from "../game.js";
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

/* ------------------------------------------------------------- the crouch */

type Cells = (string | null)[][];
const seedsFor = (ids: number[]) => ids.map((id) => BigInt((alive as Record<string, string>)[String(id)]));
/** A spread across the collection, plus the ends. */
const ALL_IDS = Object.keys(alive as Record<string, string>).map(Number).sort((a, b) => a - b);
const SPREAD = seedsFor([0, 1, 900, 1900, 2900, 3900, 4900, 5900, ALL_IDS.length - 1].map((i) => ALL_IDS[i]));

function duckedFor(seed: bigint, drop = DUCK_DROP, lean = DUCK_LEAN) {
  const grid = gridFromSeed(seed);
  const keyed = buildRunCycleGrids(grid).map(keyOutBackground) as Cells[];
  const box = runCycleBounds(keyed)!;
  const pivot = neckPivot(grid, keyed[0], box, drop);
  const safe = safeLean(keyed[0], box, pivot, lean);
  const cells = keyed.map((k) => duckCells(k, pivot, { drop, lean: safe }));
  return { grid, keyed, box, pivot, lean: safe, cells, duckBox: runCycleBounds(cells)! };
}

describe("sprite.js — the crouch is a neck pivot", () => {
  it("reads the topline off a column at a time", () => {
    const cells: Cells = [
      [null, "#fff", null],
      ["#fff", "#fff", null],
      [null, "#fff", null],
    ];
    expect(topLine(cells)).toEqual([1, 0, -1]);
  });

  it("derives the back line from the piece's own body, not from a magic row", () => {
    for (const seed of SPREAD) {
      const { grid, box, pivot } = duckedFor(seed);
      // Above the back line there is head, horn and mane; below it, torso.
      expect(pivot.backLine).toBeGreaterThanOrEqual(box.y + DUCK_DROP);
      expect(pivot.backLine).toBeLessThanOrEqual(box.y + Math.floor(box.h * 0.7));
      // The art faces right, so the neck's base is right of the box's middle
      // and the fold leans that way.
      expect(pivot.facing).toBe(1);
      expect(pivot.split).toBeGreaterThan(box.x);
      expect(pivot.split).toBeLessThan(box.x + box.w);
      expect(grid.meta.body).toBeGreaterThan(0);
    }
  });

  it("is exactly DUCK_DROP cells shorter, with the feet on the same row", () => {
    for (const seed of SPREAD) {
      const { box, duckBox } = duckedFor(seed);
      expect(duckBox.h).toBe(box.h - DUCK_DROP);
      expect(duckBox.y).toBe(box.y + DUCK_DROP);
      // The one thing a duck may never do: leave the ground.
      expect(duckBox.y + duckBox.h).toBe(box.y + box.h);
      // ...and it is never a wider target than the stand.
      expect(duckBox.w).toBeLessThanOrEqual(box.w);
      expect(duckBox.x).toBeGreaterThanOrEqual(box.x);
    }
  });

  it("moves the head down rather than shrinking it: cell counts are preserved", () => {
    for (const seed of SPREAD) {
      const { keyed, cells, pivot } = duckedFor(seed);
      const painted = (c: Cells) => c.flat().filter((v) => v !== null).length;
      const overwritten = painted(keyed[0]) - painted(cells[0]);
      // Cells only vanish by landing on top of body cells — never by being
      // resampled away, and never more than the fold could possibly cover.
      expect(overwritten).toBeGreaterThanOrEqual(0);
      expect(painted(cells[0])).toBeGreaterThan(painted(keyed[0]) * 0.6);
      // Everything at or below the back line is untouched: the legs still run.
      for (let y = pivot.backLine + DUCK_DROP; y < 24; y++) {
        expect([y, cells[0][y]]).toEqual([y, keyed[0][y]]);
      }
    }
  });

  it("keeps the crouch a 2-frame cycle whose legs still animate", () => {
    for (const seed of SPREAD) {
      const { cells } = duckedFor(seed);
      expect(cells).toHaveLength(2);
      expect(JSON.stringify(cells[0])).not.toBe(JSON.stringify(cells[1]));
    }
  });

  it("holds every promise for every piece in the collection", () => {
    // 6,913 pieces, every hair/horn/wing/accessory variant the contract ships.
    let leaned = 0;
    for (const id of ALL_IDS) {
      const seed = BigInt((alive as Record<string, string>)[String(id)]);
      const grid = gridFromSeed(seed);
      const keyed = buildRunCycleGrids(grid).map(keyOutBackground) as Cells[];
      const box = runCycleBounds(keyed)!;
      const pivot = neckPivot(grid, keyed[0], box, DUCK_DROP);
      const lean = safeLean(keyed[0], box, pivot, DUCK_LEAN);
      if (lean > 0) leaned++;
      const duckBox = runCycleBounds(keyed.map((k) => duckCells(k, pivot, { drop: DUCK_DROP, lean })))!;
      if (duckBox.h !== box.h - DUCK_DROP || duckBox.y + duckBox.h !== box.y + box.h) {
        throw new Error(`#${id}: stand ${JSON.stringify(box)} duck ${JSON.stringify(duckBox)}`);
      }
    }
    // Every piece's muzzle already reaches the edge of its own box, so the
    // forward lean is always the one that would widen the hitbox — and is
    // always declined. The fold is what does the work.
    expect(leaned).toBe(0);
  });

  it("can lean the head forward, and declines when that would widen the box", () => {
    // A hand-built horse: a flat back at row 12, a torso under it, and a neck
    // and head rising on the right — the shape every piece in the collection
    // has, with none of its decoration.
    const cells: Cells = Array.from({ length: 24 }, () => new Array(24).fill(null));
    for (let y = 12; y <= 20; y++) for (let x = 4; x <= 14; x++) cells[y][x] = "#111111";
    for (let y = 6; y <= 11; y++) for (let x = 12; x <= 14; x++) cells[y][x] = "#222222";
    const box = contentBounds(cells)!;
    const pivot = neckPivot(null as never, cells, box, 3);
    expect(pivot).toMatchObject({ facing: 1, backLine: 12, split: 12 });

    // The head owns the box's right edge, so the lean is declined — exactly
    // what happens for all 6,913 real pieces.
    expect(safeLean(cells, box, pivot, 1)).toBe(0);

    // The mechanism itself still works when a caller insists on it.
    const leaned = duckCells(cells, pivot, { drop: 3, lean: 1 });
    expect(leaned[9][15]).toBe("#222222"); // head cell, down 3 and forward 1
    expect(leaned[9][12]).toBeNull(); // ...and gone from where it was
    expect(leaned.every((row) => row.length === 24)).toBe(true);

    const straight = duckCells(cells, pivot, { drop: 3, lean: 0 });
    const moved = contentBounds(straight)!;
    expect(moved.y).toBe(box.y + 3);
    expect(moved.h).toBe(box.h - 3);
    expect(moved.w).toBe(box.w);
    expect(straight[9][14]).toBe("#222222");
  });

  it("rides along on the run frames at the SAME integer scale", () => {
    const frames = buildRunFrames(gridFromSeed(SEED), { scale: 8 }) as unknown as FakeCanvas[] & {
      cellPx: number;
      box: { w: number; h: number; y: number };
      duck: FakeCanvas[] & { cellPx: number; box: { w: number; h: number; y: number } };
    };
    const duck = frames.duck;
    expect(duck).toHaveLength(frames.length);
    // Same cell size as the stand — the crouch is not a smaller unicorn.
    expect(duck.cellPx).toBe(frames.cellPx);
    expect(duck.cellPx).toBe(8);
    expect(duck.box.h).toBe(frames.box.h - DUCK_DROP);
    expect(duck.box.w).toBe(frames.box.w);
    expect(duck[0].height).toBe(duck.box.h * 8);
    expect(duck[0].width).toBe(frames[0].width);
    expect(duck[0].height).toBeLessThan(frames[0].height);
    expect(duck[0].smoothing).toBe(false);
    // Still the piece, still animated.
    expect(duck[0].pixels.some((p) => p !== null)).toBe(true);
    expect(JSON.stringify(duck[0].pixels)).not.toBe(JSON.stringify(duck[1].pixels));
  });

  it("honours a caller who wants a shallower or deeper fold", () => {
    for (const drop of [2, 3, 4]) {
      const frames = buildRunFrames(gridFromSeed(SEED), { scale: 4, duckDrop: drop }) as unknown as {
        box: { h: number };
        duck: { box: { h: number } };
      };
      expect(frames.duck.box.h).toBe(frames.box.h - drop);
    }
  });
});

describe("sprite.js — the flyer", () => {
  it("is built from real alive piece #39, with the broad swept wing", () => {
    expect(String(FLYER_SEED)).toBe(String((alive as Record<string, string>)[String(FLYER_PIECE_ID)]));
    const [base] = buildFlyerGrids();
    // The flatter of the two swept wings leads, so the resting frame is level.
    expect(base.meta.wings).toBe(2);
    expect(base.meta.horn).toBe(5);
    expect(FLYER_WING_CYCLE).toEqual([2, 1]);
  });

  it("flaps between the two swept wings and changes nothing else", () => {
    const [a, b] = buildFlyerGrids();
    expect(a.meta.wings).toBe(2);
    expect(b.meta.wings).toBe(1);
    const { wings: _aw, ...restA } = a.meta;
    const { wings: _bw, ...restB } = b.meta;
    expect(restA).toEqual(restB);
    // The wing is the only thing that moves, but it really does move.
    expect(JSON.stringify(a.cells)).not.toBe(JSON.stringify(b.cells));
  });

  it("flies level: the hind legs are off, everything else is the real piece", () => {
    const meta = decodeSeed(FLYER_SEED);
    expect(FLYER_LAYERS).toEqual({ ground: 0, legsBack: 0 });
    for (const g of buildFlyerGrids()) {
      // The trailing hind legs are what made it read as a rearing horse...
      expect(g.meta.legsBack).toBe(0);
      // ...and the gathered forelegs stay, so it is still a horse with its
      // legs tucked up rather than a wing with a head on it.
      expect(g.meta.legsFront).toBe(meta.legsFront);
      expect(g.meta.legsFront).toBeGreaterThan(0);
      expect(g.meta.horn).toBe(meta.horn);
      expect(g.meta.tail).toBe(meta.tail);
      expect(g.meta.body).toBe(meta.body);
      expect(g.meta.eyes).toBe(meta.eyes);
    }
  });

  it("reads measurably more level than the full piece did", () => {
    // "Tilt" as a number: regress each column's centre of mass against x on the
    // mirrored silhouette. Positive means the shape falls away from nose to
    // tail — which is exactly what "rearing" looks like.
    const tilt = (cells: (string | null)[][]) => {
      const pts: [number, number][] = [];
      for (let x = 0; x < cells[0].length; x++) {
        let sum = 0;
        let n = 0;
        for (let y = 0; y < cells.length; y++) {
          if (cells[y][x] !== null) {
            sum += y;
            n++;
          }
        }
        if (n) pts.push([x, sum / n]);
      }
      const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      let num = 0;
      let den = 0;
      for (const [x, y] of pts) {
        num += (x - mx) * (y - my);
        den += (x - mx) ** 2;
      }
      return num / den;
    };
    const meta = decodeSeed(FLYER_SEED);
    for (const wings of FLYER_WING_CYCLE) {
      const rearing = tilt(mirrorCells(shadowCells(gridFromMetadata({ ...meta, ground: 0, wings }))));
      const level = tilt(mirrorCells(shadowCells(gridFromMetadata({ ...meta, ...FLYER_LAYERS, wings }))));
      expect(rearing).toBeGreaterThan(0.29); // the pose the owner called too tilted
      expect(level).toBeLessThan(0.23);
      expect(level).toBeGreaterThan(0.1); // still a creature, not a plank
      expect(level).toBeLessThan(rearing * 0.75); // a third of the tilt, gone
    }
    // The base frame is the flatter of the two — that is why it leads.
    const flat = (w: number) => tilt(mirrorCells(shadowCells(gridFromMetadata({ ...meta, ...FLYER_LAYERS, wings: w }))));
    expect(flat(FLYER_WING_CYCLE[0])).toBeLessThan(flat(FLYER_WING_CYCLE[1]));
  });

  it("carries no ground strip: a creature in flight stands on nothing", () => {
    for (const g of buildFlyerGrids()) expect(g.meta.ground).toBe(0);
  });

  it("paints every cell black but the eye, which is red", () => {
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
    expect(FLYER_EYE).toBe("#e5484d");
  });

  it("picks a red the eye stays legible in, on the body AND on the board", () => {
    // The eye has two very different neighbours: the near-black silhouette it
    // sits inside, and the board that shows through around the creature. A red
    // that only clears one of them is a red that vanishes half the time.
    expect(contrastRatio(FLYER_EYE, FLYER_INK)).toBeGreaterThan(3.5);
    expect(contrastRatio(FLYER_EYE, "#ffffff")).toBeGreaterThan(3.5);
    expect(contrastRatio(FLYER_EYE, "#f4f3f5")).toBeGreaterThan(3.5); // the shipped light board
    // ...and it is a red: dominant red channel, and not a pink or an orange.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(FLYER_EYE.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(g * 1.8);
    expect(r).toBeGreaterThan(b * 1.8);
    expect(Math.abs(g - b)).toBeLessThan(24);
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
