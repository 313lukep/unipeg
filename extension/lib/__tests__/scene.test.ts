// @vitest-environment node
//
// The diorama's pure half: palettes, mode resolution, the shape tables, the
// water pattern, the layout solver and the wander. `startScene` is the impure
// shell and is checked in the browser instead.

import { describe, expect, it } from "vitest";

import {
  DAY,
  FLOWERS,
  NIGHT,
  PALETTES,
  BOULDER,
  BUSH,
  ROCK,
  TREE,
  TREE_ROWS,
  TUFTS,
  WALK_SPEED,
  assignLanes,
  laneBounds,
  layout,
  makeGrazer,
  sceneRng,
  paletteFor,
  poolCell,
  resolveMode,
  cellShape,
  sprayAt,
  stepGrazer,
  streamCell,
  streamCenter,
  streamEdges,
  bankWobble,
  waterCell,
} from "../scene.js";

/* ------------------------------------------------------------- palettes */

describe("scene.js — day and night", () => {
  it("follows the clock on auto, and obeys an explicit choice", () => {
    for (const h of [6, 9, 12, 17]) expect([h, resolveMode("auto", h)]).toEqual([h, "day"]);
    for (const h of [18, 22, 0, 3, 5]) expect([h, resolveMode("auto", h)]).toEqual([h, "night"]);
    // An explicit setting ignores the clock entirely.
    expect(resolveMode("night", 12)).toBe("night");
    expect(resolveMode("day", 3)).toBe("day");
    // Nonsense in, midday out — never undefined.
    expect(resolveMode(undefined as unknown as string, NaN)).toBe("day");
    expect(resolveMode("auto", -3)).toBe("night"); // 21:00
    expect(resolveMode("auto", 30)).toBe("day"); // 06:00
  });

  it("resolves to a real palette object", () => {
    expect(paletteFor("auto", 12)).toBe(DAY);
    expect(paletteFor("auto", 23)).toBe(NIGHT);
    expect(Object.keys(PALETTES).sort()).toEqual(["day", "night"]);
  });

  it("names the same keys in both, so no lookup can fall through", () => {
    expect(Object.keys(DAY).sort()).toEqual(Object.keys(NIGHT).sort());
    for (const [k, v] of Object.entries(DAY)) {
      if (k === "name") continue;
      expect([k, /^#[0-9A-Fa-f]{6}$/.test(v as string)]).toEqual([k, true]);
      expect([k, /^#[0-9A-Fa-f]{6}$/.test(NIGHT[k as keyof typeof NIGHT] as string)]).toEqual([k, true]);
    }
  });

  it("is genuinely a night, and genuinely a day", () => {
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const lin = (c: number) => {
        const u = c / 255;
        return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    };
    // The sky is the tell: pale by day, near-black by night.
    expect(lum(DAY.sky)).toBeGreaterThan(0.7);
    expect(lum(NIGHT.sky)).toBeLessThan(0.05);
    // Every night surface is darker than its day counterpart — a palette that
    // got half-flipped would sail past a spot check on one colour.
    for (const k of ["sky", "grass", "canopyMid", "water", "rock", "hillNear"] as const) {
      expect([k, lum(NIGHT[k]) < lum(DAY[k])]).toEqual([k, true]);
    }
    // ...and the page text token inverts with it, or the chrome goes invisible.
    expect(lum(DAY.ink)).toBeLessThan(0.05);
    expect(lum(NIGHT.ink)).toBeGreaterThan(0.8);
    expect(lum(DAY.ink) < lum(DAY.paper)).toBe(true);
    expect(lum(NIGHT.ink) > lum(NIGHT.paper)).toBe(true);
  });
});

/* --------------------------------------------------------------- shapes */

describe("scene.js — the drawn scenery", () => {
  it("compiles rows into runs without inventing cells", () => {
    const s = cellShape(["ab.", ".bb"], { a: "grass", b: "water" });
    expect(s.w).toBe(3);
    expect(s.h).toBe(2);
    expect(s.paint).toEqual([
      { x: 0, y: 0, w: 1, h: 1, k: "grass" },
      { x: 1, y: 0, w: 1, h: 1, k: "water" },
      { x: 1, y: 1, w: 2, h: 1, k: "water" },
    ]);
  });

  it("the tree is rectangular, rooted, and paints only known palette keys", () => {
    expect(TREE_ROWS.every((r) => r.length === TREE_ROWS[0].length)).toBe(true);
    expect(TREE.w).toBe(25);
    expect(TREE.h).toBe(32);
    // The trunk reaches the bottom row: a tree that floats is a shrub.
    expect(TREE_ROWS[TREE_ROWS.length - 1]).toMatch(/[TB]/);
    // Canopy above, trunk below, and they meet.
    expect(TREE_ROWS[0]).not.toMatch(/[TB]/);
    expect(TREE_ROWS[TREE_ROWS.length - 1]).not.toMatch(/[LCK]/);
  });

  it("every shape's keys exist in both palettes", () => {
    const shapes = [TREE, ROCK, BOULDER, BUSH, ...TUFTS, ...FLOWERS];
    for (const s of shapes) {
      for (const r of s.paint) {
        expect([r.k, r.k in DAY, r.k in NIGHT]).toEqual([r.k, true, true]);
      }
    }
  });
});

/* ---------------------------------------------------------- the falls */

describe("scene.js — running water", () => {
  it("only ever asks for water colours", () => {
    const seen = new Set<string>();
    for (let t = 0; t < 40; t++) {
      for (let y = 0; y < 30; y++) for (let x = 0; x < 12; x++) seen.add(waterCell(x, y, t));
      for (let y = 0; y < 6; y++) for (let x = 0; x < 40; x++) seen.add(poolCell(x, y, t));
    }
    expect([...seen].sort()).toEqual(["foam", "water", "waterDark"]);
    for (const k of seen) expect([k, k in DAY, k in NIGHT]).toEqual([k, true, true]);
  });

  it("flows DOWNWARD by exactly one cell per tick", () => {
    // The streak at (x, y) on tick t is the streak at (x, y-1) on tick t-1:
    // that identity IS the flow, and it is what keeps it sub-pixel-free.
    for (let x = 0; x < 9; x++) {
      for (let y = 3; y < 25; y++) {
        for (let t = 1; t < 9; t++) {
          expect(waterCell(x, y, t)).toBe(waterCell(x, y - 1, t - 1));
        }
      }
    }
  });

  it("is never a flat wall and never a stripe across the fall", () => {
    for (let t = 0; t < 12; t++) {
      const col = new Set<string>();
      for (let y = 0; y < 24; y++) col.add(waterCell(3, y, t));
      expect([t, col.size]).toEqual([t, 3]); // all three tones in every column
      // Adjacent columns are sheared, so no full-width band of one colour.
      const row = new Set<string>();
      for (let x = 0; x < 8; x++) row.add(waterCell(x, 10, t));
      expect([t, row.size > 1]).toEqual([t, true]);
    }
  });

  it("negative coordinates stay in range — the spray reaches left of the fall", () => {
    for (let x = -8; x < 0; x++) {
      for (let y = -4; y < 4; y++) {
        expect(["foam", "water", "waterDark"]).toContain(waterCell(x, y, 3));
        expect(typeof sprayAt(x, y, 3)).toBe("boolean");
      }
    }
  });

  it("the stream flows RIGHT by exactly one cell per tick", () => {
    // Same identity as the fall, turned ninety degrees.
    for (let y = 0; y < 9; y++) {
      for (let x = 3; x < 30; x++) {
        for (let t = 1; t < 9; t++) {
          expect(streamCell(x, y, t)).toBe(streamCell(x - 1, y, t - 1));
        }
      }
    }
  });

  it("the stream only ever asks for water colours, at any coordinate", () => {
    const seen = new Set<string>();
    for (let t = 0; t < 30; t++)
      for (let y = -4; y < 14; y++) for (let x = -20; x < 90; x++) seen.add(streamCell(x, y, t));
    expect([...seen].sort()).toEqual(["foam", "water", "waterDark"]);
  });

  it("the banks wander, in whole cells, and never invert the channel", () => {
    const seen = new Set<number>();
    for (let x = 0; x < 400; x++) {
      const v = bankWobble(x);
      expect(Number.isInteger(v)).toBe(true);
      seen.add(v);
    }
    // It varies (a constant would be a canal)...
    expect(seen.size).toBeGreaterThan(1);
    // ...but never enough to close a 5-cell channel: max wobble is 2 a side.
    expect(Math.max(...seen)).toBeLessThanOrEqual(2);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
  });

  it("keeps the spray sparse — scatter, not static", () => {
    let on = 0;
    let total = 0;
    for (let t = 0; t < 12; t++)
      for (let y = 0; y < 5; y++)
        for (let x = 0; x < 12; x++) {
          total++;
          if (sprayAt(x, y, t)) on++;
        }
    expect(on / total).toBeLessThan(0.25);
    expect(on).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------------- layout */

describe("scene.js — the composition", () => {
  const sizes: Array<[number, number]> = [
    [320, 225], // 1280x900 at unit 4
    [420, 180],
    [214, 150],
    [160, 120],
    [640, 300],
    [90, 60], // absurdly small, still has to resolve
  ];

  it.each(sizes)("lays out %ix%i cells with everything on the board", (w, h) => {
    const s = layout(w, h);
    expect(Number.isInteger(s.horizon)).toBe(true);
    // The horizon is above halfway, so the bottom half really is ground.
    expect(s.horizon).toBeLessThan(s.h * 0.5);
    expect(s.horizon).toBeGreaterThan(0);

    // Three lanes, strictly back to front, all below the horizon and on canvas.
    expect(s.lanes).toHaveLength(3);
    let prev = s.horizon;
    for (const lane of s.lanes) {
      expect(Number.isInteger(lane.y)).toBe(true);
      expect(lane.y).toBeGreaterThan(prev - 1);
      expect(lane.y).toBeLessThanOrEqual(s.h);
      prev = lane.y;
    }
    // Depth is scale, and only ever an integer one.
    expect(s.lanes.map((l) => l.scale)).toEqual([2, 3, 4]);

    // The falls sit BELOW the treeline now — a feature in the middle distance,
    // not a cliff face — and land in the stream.
    expect(s.fall.top).toBeGreaterThan(s.horizon);
    expect(s.fall.poolY).toBeGreaterThan(s.fall.top);
    expect(s.fall.poolY + s.fall.poolH).toBeLessThanOrEqual(s.h + s.fall.poolH);
    // The water runs down the cliff, not beside it.
    expect(s.fall.x).toBeGreaterThanOrEqual(s.fall.shelfX);
    expect(s.fall.x + s.fall.w).toBeLessThanOrEqual(s.fall.shelfX + s.fall.shelfW);

    // The tree is rooted in the middle lane and stands on the canvas.
    expect(s.tree.baseY).toBe(s.lanes[1].y);
    expect(s.tree.x + s.tree.shape.w * s.tree.scale).toBeLessThanOrEqual(s.w + s.tree.shape.w * s.tree.scale);
    // The far trees are strictly smaller than the hero and stand in the BACK
    // lane. Equal-sized trees at different heights read as a row of saplings
    // planted on a slope, not as distance.
    for (const t of s.farTrees) {
      expect([w, h, t.scale]).toEqual([w, h, 1]);
      expect([w, h, t.scale < s.tree.scale]).toEqual([w, h, true]);
      expect([w, h, t.baseY <= s.lanes[1].y]).toEqual([w, h, true]);
    }
    // ...and the hero's canopy has to clear the horizon, or it is a bush.
    expect([w, h, s.tree.baseY - TREE.h * s.tree.scale < s.horizon]).toEqual([w, h, true]);
  });

  it("puts the falls and the tree on OPPOSITE sides, framing the search bar", () => {
    const s = layout(320, 225);
    const fallMid = s.fall.shelfX + s.fall.shelfW / 2;
    const treeMid = s.tree.x + 12 * s.tree.scale;
    expect(fallMid).toBeLessThan(s.w * 0.25);
    expect(treeMid).toBeGreaterThan(s.w * 0.6);
    // ...and the middle of the sky, where the bar floats, is clear of both.
    expect(s.fall.shelfX + s.fall.shelfW).toBeLessThan(s.w * 0.35);
    expect(s.tree.x).toBeGreaterThan(s.w * 0.5);
  });

  it("runs the stream between the middle and front lanes AT EVERY COLUMN", () => {
    // The channel meanders now, so it is not enough to check one y: the whole
    // curve — banks included — has to stay in the gap for every x, or a bend
    // swings out and something grazes in the water.
    for (const [w, h] of sizes) {
      const s = layout(w, h);
      const bad: string[] = [];
      for (let x = 0; x < s.w; x++) {
        const { top, bottom } = streamEdges(x, s.stream);
        if (top <= s.lanes[1].y) bad.push(`x=${x} top ${top} <= lane1 ${s.lanes[1].y}`);
        if (bottom >= s.lanes[2].y) bad.push(`x=${x} bottom ${bottom} >= lane2 ${s.lanes[2].y}`);
        if (bottom <= top) bad.push(`x=${x} channel inverted`);
        if (!Number.isInteger(top) || !Number.isInteger(bottom)) bad.push(`x=${x} fractional`);
      }
      expect([w, h, bad.slice(0, 3)]).toEqual([w, h, []]);
      const gap = s.lanes[2].y - s.lanes[1].y;
      expect([w, h, s.stream.h >= 3]).toEqual([w, h, true]);
      expect([w, h, s.stream.h <= gap - 2]).toEqual([w, h, true]);
    }
  });

  it("the stream actually meanders — it is not a canal", () => {
    const s = layout(320, 225);
    const mids = [];
    for (let x = 0; x < s.w; x++) mids.push(streamCenter(x, s.stream));
    const lo = Math.min(...mids);
    const hi = Math.max(...mids);
    // A real swing, not a wobble: several whole cells between the extremes.
    expect(hi - lo).toBeGreaterThanOrEqual(4);
    // ...and it genuinely turns rather than sloping one way across the page:
    // the centreline's direction has to reverse at least twice.
    let turns = 0;
    let dir = 0;
    for (let i = 1; i < mids.length; i++) {
      const d = Math.sign(mids[i] - mids[i - 1]);
      if (d !== 0 && d !== dir) {
        if (dir !== 0) turns++;
        dir = d;
      }
    }
    expect(turns).toBeGreaterThanOrEqual(2);
  });

  it("hangs the falls off the meander's far bend, which is what sets them back", () => {
    for (const [w, h] of sizes) {
      const s = layout(w, h);
      const atFalls = streamCenter(s.stream.anchorX, s.stream);
      let furthest = Infinity;
      for (let x = 0; x < s.w; x++) furthest = Math.min(furthest, streamCenter(x, s.stream));
      // The channel is at (or within a cell of) its most distant point exactly
      // where the water lands, and runs toward the viewer from there.
      expect([w, h, atFalls]).toEqual([w, h, furthest]);
      // ...and the shelf is inset from the left edge, not bleeding off it.
      expect([w, h, s.fall.shelfX > 0]).toEqual([w, h, true]);
    }
  });

  it("lands the falls in the stream, short and wide", () => {
    for (const [w, h] of sizes) {
      const s = layout(w, h);
      // The pool meets the channel where the channel actually is under the
      // falls — the stream meanders, so a fixed y would miss it by the swing.
      const under = streamEdges(s.stream.anchorX, s.stream);
      expect([w, h, Math.abs(s.fall.poolY - under.top) <= 3]).toEqual([w, h, true]);
      expect([w, h, s.fall.poolY + s.fall.poolH > under.top]).toEqual([w, h, true]);
      // Rock on BOTH sides of the water, not a face behind it.
      expect([w, h, s.fall.x > s.fall.shelfX]).toEqual([w, h, true]);
      expect([w, h, s.fall.x + s.fall.w < s.fall.shelfX + s.fall.shelfW]).toEqual([w, h, true]);
      // ...and roughly centred in the shelf, so neither shoulder is a sliver.
      const left = s.fall.x - s.fall.shelfX;
      const right = s.fall.shelfX + s.fall.shelfW - (s.fall.x + s.fall.w);
      expect([w, h, Math.abs(left - right) <= 1]).toEqual([w, h, true]);
      // SHORT: the drop is less than the width of the shelf it comes off, and
      // well under half the ground's depth. It used to be nearly all of it.
      const drop = s.fall.poolY - s.fall.top;
      expect([w, h, drop < s.depth * 0.5]).toEqual([w, h, true]);
      expect([w, h, drop > 0]).toEqual([w, h, true]);
    }
  });

  it("keeps grazing ground clear of the waterfall at every size", () => {
    for (const [w, h] of sizes) {
      const s = layout(w, h);
      for (let lane = 0; lane < 3; lane++) {
        const b = laneBounds(s, lane);
        expect([w, h, lane, b.min > s.fall.shelfX + s.fall.shelfW]).toEqual([w, h, lane, true]);
        expect([w, h, lane, b.max > b.min]).toEqual([w, h, lane, true]);
      }
    }
  });
});

/* --------------------------------------------------------------- wander */

describe("scene.js — the wander", () => {
  const scene = layout(320, 225);

  it("is deterministic: the same id always starts the same way", () => {
    const a = makeGrazer(185206, 1, scene);
    const b = makeGrazer(185206, 1, scene);
    expect([a.x, a.dir, a.state]).toEqual([b.x, b.dir, b.state]);
  });

  it("never leaves its lane, over an hour of clearing", () => {
    const gs = assignLanes([185206, 37, 4021, 9, 12345, 777], scene);
    const bounds = gs.map((g) => laneBounds(scene, g.lane));
    // Collect violations rather than asserting inside the loop: an expect per
    // tick per piece is a quarter of a million assertions and times the suite
    // out without testing anything the tally does not.
    const escaped: string[] = [];
    for (let i = 0; i < 3600 * 12; i++) {
      for (let k = 0; k < gs.length; k++) {
        const g = stepGrazer(gs[k], 1 / 12, scene);
        if (!(g.x >= bounds[k].min - 0.001 && g.x <= bounds[k].max + 0.001 && Number.isFinite(g.x))) {
          escaped.push(`#${g.id} lane ${g.lane} at x=${g.x} tick ${i}`);
        }
      }
    }
    expect(escaped).toEqual([]);
  }, 20000);

  it("spends most of its time grazing, and does actually walk", () => {
    const g = makeGrazer(185206, 2, scene);
    const seen: Record<string, number> = { walk: 0, graze: 0, idle: 0 };
    for (let i = 0; i < 3600 * 4; i++) {
      stepGrazer(g, 1 / 12, scene);
      seen[g.state]++;
    }
    expect(seen.walk).toBeGreaterThan(0);
    expect(seen.graze).toBeGreaterThan(0);
    expect(seen.idle).toBeGreaterThan(0);
    // A clearing where everything is always walking looks like a bus station.
    expect(seen.graze).toBeGreaterThan(seen.walk);
  });

  it("only ever faces left or right, and never spins a grazing sprite round", () => {
    // The invariant that matters on screen: a piece that is head-down at both
    // ends of a tick does not change which way it is pointing. Turns happen at
    // a lane edge (which only the walk branch reaches) or on the decision to
    // walk — both of which are drawn as a walking sprite that same tick.
    const bad: string[] = [];
    const dirs = new Set<number>();
    for (const id of [4021, 185206, 37]) {
      const g = makeGrazer(id, 1, scene);
      let lastDir = g.dir;
      for (let i = 0; i < 3600 * 4; i++) {
        const before = g.state;
        stepGrazer(g, 1 / 12, scene);
        dirs.add(g.dir);
        if (g.dir !== lastDir) {
          if (before === "graze" && g.state === "graze") bad.push(`#${id} turned mid-graze at ${i}`);
          lastDir = g.dir;
        }
      }
    }
    expect(bad).toEqual([]);
    expect([...dirs].sort()).toEqual([-1, 1]);
  }, 20000);

  it("walks at a believable pace — a lane crossing takes real seconds", () => {
    const b = laneBounds(scene, 2);
    const seconds = (b.max - b.min) / WALK_SPEED;
    expect(seconds).toBeGreaterThan(20);
    expect(seconds).toBeLessThan(200);
  });

  it("spreads a roster across all three depths before doubling up", () => {
    const three = assignLanes([1, 2, 3], scene).map((g) => g.lane);
    expect(new Set(three).size).toBe(3);
    const six = assignLanes([1, 2, 3, 4, 5, 6], scene).map((g) => g.lane);
    expect(six.filter((l) => l === 0)).toHaveLength(2);
    expect(six.filter((l) => l === 1)).toHaveLength(2);
    expect(six.filter((l) => l === 2)).toHaveLength(2);
    // The first piece added stands closest to the viewer.
    expect(six[0]).toBe(2);
  });

  it("gives two pieces with the same id different wanders", () => {
    const [a, b] = assignLanes([185206, 185206], scene);
    expect(a.x === b.x && a.dir === b.dir).toBe(false);
  });

  it("sceneRng is the deterministic 0..1 source the sim relies on", () => {
    const r = sceneRng(12345);
    const vals = Array.from({ length: 200 }, () => r());
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(vals).size).toBeGreaterThan(190);
    expect(sceneRng(12345)()).toBe(sceneRng(12345)());
    expect(sceneRng(1)()).not.toBe(sceneRng(2)());
  });
});
