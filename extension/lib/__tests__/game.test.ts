// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BLIP_ATTACK,
  BLIP_GAIN,
  BLIP_HZ,
  BLIP_SECONDS,
  DEFAULTS,
  ETH_GREY,
  ETH_LARGE,
  ETH_SMALL,
  ETH_TALL,
  FLYER_LANES,
  HIGH_SCORE_KEY,
  SPAWN_PATTERNS,
  bannerLines,
  bannerPlacement,
  clusterShape,
  collides,
  contrastRatio,
  ethFacets,
  flyerLanes,
  jump,
  jumpArc,
  jumpGroups,
  jumpReach,
  loadHighScore,
  makeRng,
  mayFly,
  mixHex,
  patternGap,
  patternIsClearable,
  patternParts,
  patternSpan,
  patternWeight,
  pickLane,
  pickPattern,
  playBlip,
  readable,
  readableFacets,
  rectsOverlap,
  relLuminance,
  runnerBox,
  runnerWidth,
  saveHighScore,
  scoreFromDistance,
  shapeFromRows,
  shrinkRect,
  spawnGap,
  spawnsFlyer,
  speedAt,
  startGame,
  stepRunner,
  usablePatterns,
} from "../game.js";
import { DUCK_DROP, flyerScaleFor } from "../sprite.js";

const G = 2700; // px/s^2 — a round number keeps the closed-form checks readable
const V = 840; // px/s

/** Integrate the runner at a fixed tick until it lands again. */
function simulateJump(dt = 1 / 240, gravity = G, v0 = V) {
  let r = jump({ y: 0, vy: 0, grounded: true, airTime: 0 }, v0, 0);
  let apex = 0;
  let t = 0;
  for (let i = 0; i < 100000; i++) {
    r = stepRunner(r, dt, gravity);
    t += dt;
    apex = Math.max(apex, r.y);
    if (r.grounded) break;
  }
  return { apex, hangTime: t, runner: r };
}

describe("game.js — jump physics", () => {
  it("reaches the closed-form apex v^2 / 2g", () => {
    const { apex } = simulateJump();
    const expected = (V * V) / (2 * G);
    expect(apex).toBeGreaterThan(expected * 0.98);
    expect(apex).toBeLessThan(expected * 1.02);
  });

  it("lands again after 2v/g seconds and settles exactly on the ground", () => {
    const { hangTime, runner } = simulateJump();
    const expected = (2 * V) / G;
    expect(hangTime).toBeGreaterThan(expected * 0.97);
    expect(hangTime).toBeLessThan(expected * 1.03);
    expect(runner.y).toBe(0);
    expect(runner.vy).toBe(0);
    expect(runner.grounded).toBe(true);
  });

  it("is frame-rate independent: the apex is the same at 30fps and 240fps", () => {
    const slow = simulateJump(1 / 30).apex;
    const fast = simulateJump(1 / 240).apex;
    // Constant-acceleration closed form: the only residual is where the samples
    // happen to land relative to the true apex.
    expect(Math.abs(slow - fast) / fast).toBeLessThan(0.01);
  });

  it("does nothing for a zero or negative timestep", () => {
    const r = { y: 5, vy: 3, grounded: false, airTime: 0.1 };
    expect(stepRunner(r, 0, G)).toEqual({ ...r });
    expect(stepRunner(r, -1, G)).toEqual({ ...r });
  });

  it("is the SNAPPIER arc the owner asked for: same height, less time in it", () => {
    // The shipped tuning, pinned. The owner asked for quicker acceleration on
    // the jump, so both numbers went up together: 14.5 -> 17.2 H/s^2 of
    // gravity, 6.2 -> 6.75 H/s of takeoff.
    expect(DEFAULTS.gravity).toBe(17.2);
    expect(DEFAULTS.jumpVelocity).toBe(6.75);

    const apex = DEFAULTS.jumpVelocity ** 2 / (2 * DEFAULTS.gravity);
    const hang = (2 * DEFAULTS.jumpVelocity) / DEFAULTS.gravity;
    const rise = DEFAULTS.jumpVelocity / DEFAULTS.gravity;

    // Quicker: gravity is up a fifth, and the rise and the fall are ~8% shorter.
    expect(DEFAULTS.gravity / 14.5).toBeGreaterThan(1.15);
    expect(hang).toBeLessThan(0.79);
    expect(hang).toBeGreaterThan(0.75); // ...but still an arc, not a hop
    expect(rise).toBeLessThan(0.4);
    expect(hang / ((2 * 6.2) / 14.5)).toBeLessThan(0.93);

    // NOT taller. The apex is measured against two other things — the low
    // flyer lane sits on the crouch only while the arc stays under ~1.33 H,
    // and a short board has to hold the whole arc — so it stays put.
    expect(apex).toBeGreaterThan(1.3);
    expect(apex).toBeLessThan(1.334);
    expect(Math.abs(apex - 6.2 ** 2 / (2 * 14.5))).toBeLessThan(0.01);

    // ...and the simulated arc agrees with the closed form it is tuned from.
    const H = 84;
    const sim = simulateJump(1 / 240, DEFAULTS.gravity * H, DEFAULTS.jumpVelocity * H);
    expect(sim.apex / H).toBeCloseTo(apex, 2);
    expect(sim.hangTime).toBeCloseTo(hang, 2);
  });
});

describe("game.js — no double jump", () => {
  it("refuses a second jump in mid-air once the coyote window has passed", () => {
    let r = jump({ y: 0, vy: 0, grounded: true, airTime: 0 }, V, 0.08);
    for (let i = 0; i < 30; i++) r = stepRunner(r, 1 / 120, G); // 0.25s aloft
    const again = jump(r, V, 0.08);
    expect(again).toBe(r); // same object == refused
    expect(again.vy).toBeLessThan(V);
  });

  it("refuses a second jump INSIDE the coyote window too", () => {
    // The dangerous case: coyote time is meant to forgive a late press after
    // walking off an edge, and must never become a free extra hop.
    let r = jump({ y: 0, vy: 0, grounded: true, airTime: 0 }, V, 0.08);
    r = stepRunner(r, 1 / 240, G);
    expect(r.airTime).toBeLessThan(0.08);
    expect(r.grounded).toBe(false);
    expect(jump(r, V, 0.08)).toBe(r);
  });

  it("never lets the whole arc be re-triggered at any sample", () => {
    let r = jump({ y: 0, vy: 0, grounded: true, airTime: 0 }, V, 0.08);
    let peak = r.vy;
    for (let i = 0; i < 400; i++) {
      r = stepRunner(r, 1 / 240, G);
      if (r.grounded) break;
      r = jump(r, V, 0.08); // a player mashing the key for the whole flight
      peak = Math.max(peak, r.vy);
    }
    expect(peak).toBe(V); // the velocity was never topped up
  });

  it("still allows a coyote-time jump for a fall that did not start with one", () => {
    const falling = stepRunner({ y: 1, vy: 0, grounded: false, airTime: 0 }, 1 / 240, G);
    expect(falling.airTime).toBeLessThan(0.08);
    expect(jump(falling, V, 0.08).vy).toBe(V);
  });
});

describe("game.js — speed ramp", () => {
  it("starts at the base speed and never exceeds the maximum", () => {
    expect(speedAt(0)).toBe(DEFAULTS.baseSpeed);
    for (const t of [0, 1, 10, 60, 600, 1e6]) {
      const s = speedAt(t);
      expect(s).toBeGreaterThanOrEqual(DEFAULTS.baseSpeed);
      expect(s).toBeLessThanOrEqual(DEFAULTS.maxSpeed);
    }
  });

  it("is monotonically non-decreasing", () => {
    let prev = -Infinity;
    for (let t = 0; t < 120; t += 0.5) {
      const s = speedAt(t);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it("clamps negative elapsed time to the base speed", () => {
    expect(speedAt(-5)).toBe(DEFAULTS.baseSpeed);
  });

  it("reaches the cap only after a long survival", () => {
    const capAt = (DEFAULTS.maxSpeed - DEFAULTS.baseSpeed) / DEFAULTS.accel;
    expect(capAt).toBeGreaterThan(60); // a whole minute of clean running
    expect(capAt).toBeLessThan(180); // ...but the cap is reachable, not mythical
    expect(speedAt(capAt)).toBeCloseTo(DEFAULTS.maxSpeed, 6);
  });

  it("opens calmly: real reaction time on the first obstacle", () => {
    // The board is about 8 sprite-heights wide, the runner stands 12% in and is
    // about 1 H wide, so a mark spawning at the right edge has ~6 H of clear
    // board to cross. (The integration test below measures the real thing.)
    const runway = 8 * (1 - 0.12) - 1;
    expect(runway / speedAt(0)).toBeGreaterThan(2); // seconds to react, at t=0
    // The whole opening is a warm-up: still slower at 20 s than the board used
    // to START at, and less than half way to the cap.
    expect(speedAt(20)).toBeLessThan(5);
    expect(speedAt(20)).toBeLessThan(DEFAULTS.baseSpeed + (DEFAULTS.maxSpeed - DEFAULTS.baseSpeed) / 2);
    // ...and it is a ramp, not a step: no second of it jumps by much.
    for (let t = 0; t < 120; t++) {
      expect(speedAt(t + 1) - speedAt(t)).toBeLessThanOrEqual(0.15);
    }
  });

  it("keeps the ramp within the bounds the pacing was designed against", () => {
    expect(DEFAULTS.baseSpeed).toBeGreaterThanOrEqual(2.6);
    expect(DEFAULTS.baseSpeed).toBeLessThanOrEqual(3);
    expect(DEFAULTS.accel).toBeGreaterThanOrEqual(0.08);
    expect(DEFAULTS.accel).toBeLessThanOrEqual(0.12);
    // Points come from distance, so the flyer threshold moves with the ramp:
    // it should land somewhere in the first minute, not the first ten seconds.
    const scoreAt = (t: number) =>
      (DEFAULTS.baseSpeed * t + 0.5 * DEFAULTS.accel * t * t) / DEFAULTS.scoreUnit;
    expect(scoreAt(20)).toBeLessThan(DEFAULTS.flyerScore);
    expect(scoreAt(70)).toBeGreaterThan(DEFAULTS.flyerScore);
  });
});

describe("game.js — spawn gaps", () => {
  const speeds = [DEFAULTS.baseSpeed, 5, 6, 7, 8, 9, DEFAULTS.maxSpeed];

  it("stays inside its own bounds at every speed and every roll", () => {
    for (const speed of speeds) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999, 1]) {
        const gap = spawnGap(r, speed);
        expect(gap).toBeGreaterThanOrEqual(DEFAULTS.gapFloor);
        expect(gap).toBeLessThanOrEqual(DEFAULTS.gapMax);
      }
    }
  });

  it("is randomised: the whole span is reachable at the base speed", () => {
    expect(spawnGap(0, DEFAULTS.baseSpeed)).toBeCloseTo(DEFAULTS.gapMin, 6);
    expect(spawnGap(1, DEFAULTS.baseSpeed)).toBeCloseTo(DEFAULTS.gapMax, 6);
    const rng = makeRng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(Math.round(spawnGap(rng(), 6) * 100));
    expect(seen.size).toBeGreaterThan(50);
  });

  it("scales with speed: closer in time, further apart in space", () => {
    let prevTime = Infinity;
    let prevSpace = -Infinity;
    for (const speed of speeds) {
      const gap = spawnGap(0.5, speed);
      expect(gap).toBeLessThanOrEqual(prevTime + 1e-9);
      expect(gap * speed).toBeGreaterThan(prevSpace);
      prevTime = gap;
      prevSpace = gap * speed;
    }
  });

  it("never spawns sooner than the runner can land", () => {
    // Hang time is the whole point of the floor: an obstacle that arrives while
    // the last jump is still in the air cannot be answered.
    const hang = (2 * DEFAULTS.jumpVelocity) / DEFAULTS.gravity;
    for (const speed of speeds) {
      expect(spawnGap(0, speed)).toBeGreaterThan(hang);
    }
  });

  it("degrades sanely on nonsense input", () => {
    expect(spawnGap(-5, DEFAULTS.baseSpeed)).toBeCloseTo(DEFAULTS.gapMin, 6);
    expect(spawnGap(9, DEFAULTS.baseSpeed)).toBeCloseTo(DEFAULTS.gapMax, 6);
    expect(spawnGap(0.5, 0)).toBeGreaterThanOrEqual(DEFAULTS.gapFloor);
  });
});

describe("game.js — collision", () => {
  const runner = { x: 100, y: 100, w: 100, h: 100 };

  it("detects a clear overlap", () => {
    expect(rectsOverlap(runner, { x: 150, y: 150, w: 50, h: 50 })).toBe(true);
  });

  it("rejects a clear miss and edge-touching", () => {
    expect(rectsOverlap(runner, { x: 400, y: 100, w: 20, h: 20 })).toBe(false);
    expect(rectsOverlap(runner, { x: 200, y: 100, w: 20, h: 20 })).toBe(false); // touching
  });

  it("shrinks the hitbox about its centre", () => {
    expect(shrinkRect(runner, 0.2)).toEqual({ x: 110, y: 110, w: 80, h: 80 });
    expect(shrinkRect(runner, 0)).toEqual(runner);
  });

  it("is forgiving: a 15% graze misses, a real hit still lands", () => {
    const graze = { x: 196, y: 150, w: 20, h: 20 };
    expect(rectsOverlap(runner, graze)).toBe(true);
    expect(collides(runner, graze, DEFAULTS.hitboxShrink)).toBe(false);

    const real = { x: 150, y: 150, w: 40, h: 40 };
    expect(collides(runner, real, DEFAULTS.hitboxShrink)).toBe(true);
  });

  it("clears the obstacle once the runner has jumped high enough", () => {
    const groundY = 300;
    const obstacle = { x: 120, y: groundY - 40, w: 20, h: 40 };
    const grounded = { x: 100, y: groundY - 100, w: 60, h: 100 };
    expect(collides(grounded, obstacle)).toBe(true);
    const airborne = { ...grounded, y: grounded.y - 70 };
    expect(collides(airborne, obstacle)).toBe(false);
  });
});

describe("game.js — score", () => {
  it("counts one point per unit of travel and never goes backwards", () => {
    let prev = 0;
    for (let d = 0; d < 5000; d += 7) {
      const s = scoreFromDistance(d, 48);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    expect(scoreFromDistance(96, 48)).toBe(2);
    expect(scoreFromDistance(95, 48)).toBe(1);
  });

  it("is zero for no distance and for a nonsense unit", () => {
    expect(scoreFromDistance(0, 48)).toBe(0);
    expect(scoreFromDistance(1000, 0)).toBe(0);
    expect(scoreFromDistance(-10, 48)).toBe(0);
  });
});

/* ------------------------------------------------------- Ethereum marks */

/** Every filled cell of a shape, as "x,y" keys. */
function filledCells(shape: { rows: string[] }) {
  const out = new Set<string>();
  shape.rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch !== ".") out.add(`${x},${y}`);
    });
  });
  return out;
}

/** Every shape any pattern can put on the board. */
const PATTERN_SHAPES = SPAWN_PATTERNS.flatMap((p) => p.parts.map((part) => part.shape));

describe("game.js — obstacles are Ethereum marks", () => {
  const marks = [ETH_SMALL, ETH_LARGE, ETH_TALL];

  it("ships integer cell geometry inside its own box", () => {
    for (const shape of PATTERN_SHAPES) {
      for (const r of [...shape.paint, ...shape.solid]) {
        for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(v)).toBe(true);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(shape.w);
        expect(r.y + r.h).toBeLessThanOrEqual(shape.h);
      }
    }
  });

  it("is an octahedron: taller than wide, symmetric, two triangles", () => {
    for (const mark of marks) {
      // The small and large marks keep the real mark's proportions; the tall
      // one is the same silhouette drawn as a spire.
      const ratio = mark.h / mark.w;
      expect(ratio).toBeGreaterThan(1.4);
      expect(ratio).toBeLessThan(mark === ETH_TALL ? 2.6 : 1.9);
      expect(mark.w % 2).toBe(1); // odd width — there is a centre seam
      for (const row of mark.rows) {
        expect([...row].reverse().join("").replace(/L/g, "?").replace(/D/g, "L").replace(/\?/g, "D")).toBe(row);
      }
      // A widest row (the waist) above a narrower one (the notch), then the
      // second triangle: the silhouette pinches at least once.
      const widths = mark.rows.map((r) => r.replace(/\./g, "").length);
      const waist = widths.indexOf(Math.max(...widths));
      expect(waist).toBeGreaterThan(0);
      expect(Math.min(...widths.slice(waist))).toBeLessThan(Math.max(...widths));
      expect(Math.max(...widths.slice(waist + 1))).toBeGreaterThan(widths[waist + 1]);
    }
  });

  it("splits every mark into a light facet, a seam and a dark facet", () => {
    for (const mark of marks) {
      const seam = (mark.w - 1) / 2;
      let light = 0;
      let dark = 0;
      let seams = 0;
      mark.rows.forEach((row) => {
        [...row].forEach((ch, x) => {
          if (ch === ".") return;
          if (x < seam) expect(ch).toBe("L");
          else if (x > seam) expect(ch).toBe("D");
          else expect(ch).toBe("M");
          if (ch === "L") light++;
          else if (ch === "D") dark++;
          else seams++;
        });
      });
      expect(light).toBe(dark); // the two faces are mirror images
      expect(seams).toBeGreaterThan(0);
    }
  });

  it("collides against the silhouette, not the bounding box", () => {
    for (const shape of PATTERN_SHAPES) {
      const filled = filledCells(shape);
      const covered = new Set<string>();
      for (const r of shape.solid) {
        for (let y = r.y; y < r.y + r.h; y++) {
          for (let x = r.x; x < r.x + r.w; x++) {
            // No solid rect may cover an empty cell...
            expect(filled.has(`${x},${y}`)).toBe(true);
            covered.add(`${x},${y}`);
          }
        }
      }
      // ...and no painted cell may be left uncovered.
      expect(covered.size).toBe(filled.size);
      // The point of all this: the box has real air in its corners.
      expect(filled.size).toBeLessThan(shape.w * shape.h * 0.75);
    }
  });

  it("paints exactly the cells it collides with", () => {
    for (const shape of PATTERN_SHAPES) {
      const painted = new Set<string>();
      for (const r of shape.paint) {
        for (let x = r.x; x < r.x + r.w; x++) painted.add(`${x},${r.y}`);
        expect(r.h).toBe(1);
      }
      expect(painted).toEqual(filledCells(shape));
    }
  });

  it("clusters two and three marks with one cell between them", () => {
    for (const n of [2, 3]) {
      for (const mark of marks) {
        const group = clusterShape(mark, n);
        expect(group.w).toBe(mark.w * n + (n - 1));
        expect(group.h).toBe(mark.h);
        // Each member is the original mark, untouched.
        for (let i = 0; i < n; i++) {
          const slice = group.rows.map((r) => r.slice(i * (mark.w + 1), i * (mark.w + 1) + mark.w));
          expect(slice).toEqual(mark.rows);
        }
        // The spacing columns really are empty.
        for (let i = 1; i < n; i++) {
          const col = i * (mark.w + 1) - 1;
          for (const row of group.rows) expect(row[col]).toBe(".");
        }
      }
    }
    expect(clusterShape(ETH_SMALL, 1)).toBe(ETH_SMALL);
  });

  it("paints every facet the one grey — no second colour anywhere", () => {
    expect(ethFacets()).toEqual({ L: ETH_GREY, M: ETH_GREY, D: ETH_GREY });
    expect(ETH_GREY).toBe("#3C3C3D");
    expect(new Set(Object.values(ethFacets())).size).toBe(1);
  });

  it("is one flat silhouette per mark, notch included", () => {
    const facets = ethFacets();
    for (const [name, shape] of [
      ["small", ETH_SMALL],
      ["large", ETH_LARGE],
      ["tall", ETH_TALL],
    ] as const) {
      // Every painted run resolves to the same colour, whatever letter it wears.
      const colours = new Set(shape.paint.map((r) => facets[r.facet as "L" | "M" | "D"]));
      expect([name, [...colours]]).toEqual([name, [ETH_GREY]]);
      // The chevron notch is CUT, not painted, so flattening cannot fill it in:
      // every mark keeps at least one row whose middle cells are empty (the
      // small and tall marks have one such row, the large one has two).
      const notched = shape.rows.filter((row) => /[A-Z]\.+[A-Z]/.test(row));
      expect([name, notched.length >= 1]).toEqual([name, true]);
    }
  });

  it("compiles arbitrary rows without inventing cells", () => {
    const s = shapeFromRows(["LM.", ".MD"]);
    expect(s.w).toBe(3);
    expect(s.h).toBe(2);
    expect(s.paint).toEqual([
      { x: 0, y: 0, w: 1, h: 1, facet: "L" },
      { x: 1, y: 0, w: 1, h: 1, facet: "M" },
      { x: 1, y: 1, w: 1, h: 1, facet: "M" },
      { x: 2, y: 1, w: 1, h: 1, facet: "D" },
    ]);
    expect(s.solid).toEqual([
      { x: 0, y: 0, w: 2, h: 1 },
      { x: 1, y: 1, w: 2, h: 1 },
    ]);
  });
});

/* --------------------------------------------------------- board contrast */

describe("game.js — nothing vanishes into the board", () => {
  const WHITE = "#ffffff";
  const NEAR_BLACK = "#0b0b0d";

  it("measures luminance and contrast the way the web does", () => {
    expect(relLuminance("#ffffff")).toBeCloseTo(1, 6);
    expect(relLuminance("#000000")).toBeCloseTo(0, 6);
    expect(relLuminance("#fff")).toBeCloseTo(1, 6); // short hex too
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 6);
    expect(contrastRatio("#ac3232", "#ac3232")).toBeCloseTo(1, 6);
  });

  it("blends toward a target without leaving the colour space", () => {
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#ac3232", "#000000", 0.5)).toBe("#561919");
  });

  it("leaves a colour alone when it already reads", () => {
    expect(readable("#ac3232", WHITE, 2)).toBe("#ac3232");
    expect(readable("#f7f7f8", NEAR_BLACK, 2)).toBe("#f7f7f8");
  });

  it("pushes a pale colour dark enough to see on white — and keeps its hue", () => {
    const before = "#fcf893"; // the palette's pale yellow: 1.1:1 on white
    expect(contrastRatio(before, WHITE)).toBeLessThan(1.3);
    const after = readable(before, WHITE, 2);
    expect(contrastRatio(after, WHITE)).toBeGreaterThanOrEqual(2);
    // Darkened, not replaced: still yellow-ish, red and green still lead blue.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(after.slice(i, i + 2), 16));
    expect(r).toBeGreaterThan(b);
    expect(g).toBeGreaterThan(b);
    expect(after).not.toBe("#000000");
  });

  it("pushes a near-black colour light enough to see on a dark board", () => {
    const after = readable("#1e1e26", NEAR_BLACK, 2);
    expect(contrastRatio(after, NEAR_BLACK)).toBeGreaterThanOrEqual(2);
    expect(relLuminance(after)).toBeGreaterThan(relLuminance("#1e1e26"));
  });

  it("survives a colour it cannot rescue, and nonsense input", () => {
    // Nothing can hold 21:1 against mid grey — take the extreme and move on.
    expect(["#000000", "#ffffff"]).toContain(readable("#808080", "#808080", 21));
    expect(readable("nope" as string, WHITE)).toBe("#000000");
    expect(readable(undefined as unknown as string, NEAR_BLACK)).toBe("#ffffff");
  });

  it("keeps the mark's grey visible on any board, including its own colour", () => {
    for (const board of [WHITE, NEAR_BLACK, "#161619", "#cbbba0", ETH_GREY]) {
      const facets = readableFacets(ethFacets(), board, 2);
      for (const c of [facets.L, facets.M, facets.D]) {
        expect([board, c, contrastRatio(c, board) >= 2]).toEqual([board, c, true]);
      }
      // Flat in, flat out — the contrast pass must never split one colour into
      // three by rounding the three identical inputs differently.
      expect([board, new Set([facets.L, facets.M, facets.D]).size]).toEqual([board, 1]);
    }
  });

  it("leaves the Ethereum grey untouched on the white board the pages ship", () => {
    expect(readableFacets(ethFacets(), WHITE, 2)).toEqual({
      L: ETH_GREY,
      M: ETH_GREY,
      D: ETH_GREY,
    });
  });
});

/* ------------------------------------------------------------ the patterns */

/**
 * The geometries the game really sees: 4x and 8x cell scales, and the range of
 * content-box heights the collection actually produces (18 to 23 cells). A
 * short piece jumps lower than a tall one while the marks stay the same size,
 * so every clearance claim has to survive the whole range.
 */
const GEOMETRIES = [4, 8].flatMap((scale) =>
  [18, 19, 20, 21, 22, 23].map((cells) => ({
    label: `${cells} cells @ ${scale}x`,
    spriteH: cells * scale,
    spriteW: 22 * scale,
    unit: scale,
  })),
);

const SPEEDS: number[] = [];
for (let s = DEFAULTS.baseSpeed; s < DEFAULTS.maxSpeed; s += 0.2) SPEEDS.push(Number(s.toFixed(2)));
SPEEDS.push(DEFAULTS.maxSpeed);

describe("game.js — the pattern set", () => {
  it("is varied: singles, a tall, a two-beat, tight clusters and a breather", () => {
    const names = SPAWN_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(8);
    // singles of three different marks
    const singles = SPAWN_PATTERNS.filter((p) => p.parts.length === 1);
    expect(new Set(singles.map((p) => p.parts[0].shape)).size).toBeGreaterThanOrEqual(5);
    // at least one pattern whose parts are separated in TIME, not cells
    expect(SPAWN_PATTERNS.some((p) => p.parts.some((part) => (part.after || 0) > 0))).toBe(true);
    // at least one pattern whose parts are separated in CELLS
    expect(SPAWN_PATTERNS.some((p) => p.parts.length > 1 && p.parts.every((part) => !part.after))).toBe(true);
    // ...and a breather: a spawn that is mostly silence.
    expect(Math.max(...SPAWN_PATTERNS.map((p) => p.gapAfter))).toBeGreaterThanOrEqual(1.8);
    // widths run from one mark to a three-wide wall
    const widths = SPAWN_PATTERNS.map((p) => Math.max(...p.parts.map((x) => (x.at || 0) + x.shape.w)));
    expect(Math.min(...widths)).toBe(ETH_SMALL.w);
    expect(Math.max(...widths)).toBeGreaterThan(ETH_LARGE.w * 2);
  });

  it("unlocks the hard patterns later than the easy ones", () => {
    // "Hard" is not "wide": a two-wide group of small marks is wider than one
    // large mark and still easier, because the jump spends longer above it.
    // The unlock order therefore follows the arc, not the ruler.
    const geo = GEOMETRIES[3];
    const hardness = (p: (typeof SPAWN_PATTERNS)[number]) =>
      SPEEDS.find((s) => patternIsClearable(p, s, geo)) ?? Infinity;
    for (const p of SPAWN_PATTERNS) {
      expect(p.minRatio).toBeGreaterThanOrEqual(1);
      expect(p.minRatio * DEFAULTS.baseSpeed).toBeLessThan(DEFAULTS.maxSpeed);
      for (const other of SPAWN_PATTERNS) {
        if (hardness(other) > hardness(p)) {
          expect([other.name, p.name, other.minRatio >= p.minRatio]).toEqual([other.name, p.name, true]);
        }
      }
    }
    // ...and there is always more than one thing to see at the very start.
    const openers = SPAWN_PATTERNS.filter((p) => p.minRatio <= 1);
    expect(openers.length).toBeGreaterThanOrEqual(3);
  });

  it("is jumpable: every group the spawner can produce fits inside jumpReach", () => {
    // THE SAFETY ARGUMENT. For every geometry, every speed, and every pattern
    // the spawner is willing to use at that speed: the ground covered while the
    // hitbox is above the group must beat the group's width plus the runner's,
    // with the configured margin. `jumpReach` is the guard underneath it — a
    // group taller than the reach has a zero-length window and can never pass.
    for (const geo of GEOMETRIES) {
      const arc = jumpArc(geo.spriteH);
      const runnerW = runnerWidth(geo.spriteW);
      expect(arc.reach).toBeCloseTo(jumpReach(geo.spriteH), 9);
      for (const speed of SPEEDS) {
        for (const pattern of usablePatterns(speed, geo)) {
          const speedPx = speed * geo.spriteH;
          const groups = jumpGroups(patternParts(pattern, speedPx, geo.unit), speedPx, geo.spriteH, runnerW);
          for (const g of groups) {
            const label = `${pattern.name} @ ${speed} H/s, ${geo.label}`;
            expect([label, g.h < arc.reach]).toEqual([label, true]);
            expect([label, arc.window(g.h) * speedPx >= (g.w + runnerW) * DEFAULTS.clearMargin]).toEqual([
              label,
              true,
            ]);
          }
        }
      }
    }
  });

  it("never lets a pattern and the one behind it become one impossible jump", () => {
    // The gap is measured from the BACK of a pattern, so the worst case is the
    // shortest roll (rand = 0) after every pattern, followed by every other.
    for (const geo of GEOMETRIES) {
      const arc = jumpArc(geo.spriteH);
      const runnerW = runnerWidth(geo.spriteW);
      for (const speed of SPEEDS) {
        const speedPx = speed * geo.spriteH;
        const usable = usablePatterns(speed, geo);
        for (const a of usable) {
          const gap = patternGap(0, speed, a, DEFAULTS, geo);
          for (const b of usable) {
            const parts = [
              ...patternParts(a, speedPx, geo.unit),
              ...patternParts(b, speedPx, geo.unit).map((p) => ({ ...p, x: p.x + gap * speedPx })),
            ];
            const groups = jumpGroups(parts, speedPx, geo.spriteH, runnerW);
            for (const g of groups) {
              const label = `${a.name} -> ${b.name} @ ${speed} H/s, ${geo.label}`;
              expect([label, arc.window(g.h) * speedPx >= (g.w + runnerW) * DEFAULTS.clearMargin]).toEqual([
                label,
                true,
              ]);
            }
          }
        }
      }
    }
  });

  it("keeps a two-beat pattern two beats at every speed", () => {
    const twoBeat = SPAWN_PATTERNS.find((p) => p.parts.some((part) => (part.after || 0) > 0))!;
    for (const geo of GEOMETRIES) {
      const runnerW = runnerWidth(geo.spriteW);
      for (const speed of SPEEDS) {
        const speedPx = speed * geo.spriteH;
        const groups = jumpGroups(patternParts(twoBeat, speedPx, geo.unit), speedPx, geo.spriteH, runnerW);
        // Two separate decisions — never collapsing into one wide obstacle,
        // however fast the board is moving.
        expect([twoBeat.name, speed, geo.label, groups.length]).toEqual([twoBeat.name, speed, geo.label, 2]);
      }
    }
  });

  it("measures the pause from the back of the pattern, and lets a breather breathe", () => {
    const geo = GEOMETRIES[3];
    const speed = DEFAULTS.baseSpeed;
    const small = SPAWN_PATTERNS.find((p) => p.name === "small")!;
    const breather = SPAWN_PATTERNS.find((p) => p.name === "breather")!;
    const range = SPAWN_PATTERNS.find((p) => p.name === "range")!;
    // A breather is the same mark as a small single, with a longer silence.
    expect(breather.parts[0].shape).toBe(small.parts[0].shape);
    expect(patternGap(0.5, speed, breather, DEFAULTS, geo)).toBeGreaterThan(
      patternGap(0.5, speed, small, DEFAULTS, geo) * 1.5,
    );
    // A wide pattern occupies real time, and the pause is added on top of it.
    expect(patternSpan(range, speed * geo.spriteH, geo.unit)).toBeGreaterThan(
      patternSpan(small, speed * geo.spriteH, geo.unit),
    );
    expect(patternGap(0, speed, range, DEFAULTS, geo)).toBeGreaterThan(
      patternSpan(range, speed * geo.spriteH, geo.unit) + DEFAULTS.gapFloor - 1e-9,
    );
    // The floor still holds at the top speed.
    for (const p of SPAWN_PATTERNS) {
      expect(patternGap(0, DEFAULTS.maxSpeed, p, DEFAULTS, geo)).toBeGreaterThanOrEqual(DEFAULTS.gapFloor);
    }
  });

  it("favours easy singles early and mixes clusters in late", () => {
    const geo = GEOMETRIES[3];
    const share = (speed: number) => {
      const usable = usablePatterns(speed, geo);
      const total = usable.reduce((a, p) => a + patternWeight(p, speed), 0);
      const easy = usable
        .filter((p) => p.parts.length === 1 && p.parts[0].shape === ETH_SMALL)
        .reduce((a, p) => a + patternWeight(p, speed), 0);
      return easy / total;
    };
    expect(share(DEFAULTS.baseSpeed)).toBeGreaterThan(0.55);
    expect(share(DEFAULTS.maxSpeed)).toBeLessThan(0.25);
    // The opening really is only openers.
    expect(usablePatterns(DEFAULTS.baseSpeed, geo).every((p) => p.minRatio <= 1.1)).toBe(true);
    // ...and the endgame really does have everything.
    expect(usablePatterns(DEFAULTS.maxSpeed, GEOMETRIES[5]).length).toBe(SPAWN_PATTERNS.length);
  });

  it("never spawns the same pattern twice running", () => {
    const geo = GEOMETRIES[3];
    const rng = makeRng(7);
    let last: string | null = null;
    const seen = new Set<string>();
    for (let i = 0; i < 4000; i++) {
      const speed = DEFAULTS.baseSpeed + (i / 4000) * (DEFAULTS.maxSpeed - DEFAULTS.baseSpeed);
      const pattern = pickPattern(rng(), speed, geo, last, DEFAULTS);
      expect(pattern.name).not.toBe(last);
      last = pattern.name;
      seen.add(pattern.name);
    }
    // Over a full ramp the player sees the whole set.
    expect(seen.size).toBe(SPAWN_PATTERNS.length);
  });

  it("only ever picks something the current speed has unlocked and can clear", () => {
    for (const geo of [GEOMETRIES[0], GEOMETRIES[3], GEOMETRIES[11]]) {
      const rng = makeRng(23);
      for (const speed of SPEEDS) {
        for (let i = 0; i < 40; i++) {
          const pattern = pickPattern(rng(), speed, geo, null, DEFAULTS);
          expect([pattern.name, speed >= pattern.minRatio * DEFAULTS.baseSpeed]).toEqual([pattern.name, true]);
          expect([pattern.name, patternIsClearable(pattern, speed, geo)]).toEqual([pattern.name, true]);
        }
      }
    }
  });

  it("left nothing unclearable when the jump got snappier", () => {
    // THE GUARD, RE-RUN. A quicker arc covers less ground while airborne, so
    // `clearMargin` came down with it (1.25 -> 1.15). This is what says that
    // trade did not cost the board a pattern: every pattern still becomes
    // clearable inside the speed range, for every geometry that ships.
    expect(DEFAULTS.clearMargin).toBe(1.15);
    for (const geo of GEOMETRIES) {
      for (const pattern of SPAWN_PATTERNS) {
        const at = SPEEDS.find((s) => patternIsClearable(pattern, s, geo));
        expect([pattern.name, geo.label, at !== undefined]).toEqual([pattern.name, geo.label, true]);
        // ...and once clearable it stays clearable: a faster board is never a
        // board that takes an obstacle away again.
        for (const s of SPEEDS) {
          if (s < at!) continue;
          expect([pattern.name, geo.label, s, patternIsClearable(pattern, s, geo)]).toEqual([
            pattern.name,
            geo.label,
            s,
            true,
          ]);
        }
      }
      // The opener is clearable from the very first second, so `usablePatterns`
      // never has to fall back to something the guard would have rejected.
      expect([geo.label, patternIsClearable(SPAWN_PATTERNS[0], DEFAULTS.baseSpeed, geo)]).toEqual([
        geo.label,
        true,
      ]);
    }
  });

  it("kept the pacing: the same patterns arrive at the same speeds as before", () => {
    // The floaty arc with a 25% margin, and the snappy arc with a 15% one, are
    // the same board. This measures it rather than asserting it: for every
    // pattern, the speed at which it becomes clearable moved by at most
    // 0.2 H/s — under one tick of the ramp.
    const before = { ...DEFAULTS, gravity: 14.5, jumpVelocity: 6.2, clearMargin: 1.25 };
    const geo = GEOMETRIES[3];
    for (const pattern of SPAWN_PATTERNS) {
      const was = SPEEDS.find((s) => patternIsClearable(pattern, s, geo, before)) ?? Infinity;
      const now = SPEEDS.find((s) => patternIsClearable(pattern, s, geo)) ?? Infinity;
      expect([pattern.name, Number.isFinite(was), Number.isFinite(now)]).toEqual([pattern.name, true, true]);
      expect([pattern.name, Math.abs(now - was) <= 0.2]).toEqual([pattern.name, true]);
    }
  });

  it("degrades to the easiest single rather than spawning nothing", () => {
    // A hypothetical piece so short that nothing is comfortably clearable.
    const tiny = { spriteH: 8, spriteW: 200, unit: 8 };
    const table = usablePatterns(DEFAULTS.baseSpeed, tiny);
    expect(table).toEqual([SPAWN_PATTERNS[0]]);
    expect(pickPattern(0.9, DEFAULTS.baseSpeed, tiny, SPAWN_PATTERNS[0].name).name).toBe(SPAWN_PATTERNS[0].name);
  });
});

/* --------------------------------------------------------- the duck + flyer */

/**
 * Real sprite dimensions: the run box is 22 cells wide and 18-23 tall, the
 * flyer's is 22x22, and the crouch is the run box with the front end folded
 * DUCK_DROP cells down — same width, same cell scale, same feet.
 */
function dims(scale: number, runCells = 21) {
  return {
    spriteH: runCells * scale,
    spriteW: 22 * scale,
    duckH: (runCells - DUCK_DROP) * scale,
    duckW: 22 * scale,
    // The flyer's content box: 22 cells wide, 21 tall since the hind legs
    // came off (sprite.js FLYER_LAYERS).
    flyerH: 21 * flyerScaleFor(scale),
    flyerW: 22 * flyerScaleFor(scale),
  };
}

const GROUND = 400;

function boxAt(d: ReturnType<typeof dims>, y: number, ducking: boolean) {
  return runnerBox({ x: 0, groundY: GROUND, ...d, y, ducking });
}

function flyerAt(d: ReturnType<typeof dims>, lane: number) {
  return { x: 0, y: GROUND - lane - d.flyerH, w: d.flyerW, h: d.flyerH };
}

describe("game.js — duck geometry", () => {
  const d = dims(4);

  it("stands and crouches on the same ground line", () => {
    expect(boxAt(d, 0, false).y + d.spriteH).toBe(GROUND);
    expect(boxAt(d, 0, true).y + d.duckH).toBe(GROUND);
  });

  it("is LOWER, not smaller: same width, a whole number of cells shorter", () => {
    const stand = boxAt(d, 0, false);
    const crouch = boxAt(d, 0, true);
    expect(crouch.w).toBe(stand.w); // the crouch is not a shrunk unicorn
    expect(stand.h - crouch.h).toBe(DUCK_DROP * 4); // 5 cells at the 4x scale
    expect(crouch.h).toBe(64);
    // Shorter by enough to matter, but still most of a unicorn.
    expect(crouch.h / stand.h).toBeLessThan(0.9);
    expect(crouch.h / stand.h).toBeGreaterThan(0.7);
  });

  it("stays a whole number of cells shorter at every scale and piece height", () => {
    for (const scale of [3, 4, 5, 6, 7, 8]) {
      for (const cells of [18, 19, 20, 21, 22, 23]) {
        const g = dims(scale, cells);
        expect((g.spriteH - g.duckH) / scale).toBe(DUCK_DROP);
        expect(Number.isInteger(g.duckH / scale)).toBe(true);
        expect(g.duckW).toBe(g.spriteW);
      }
    }
  });

  it("rises with the jump, crouched or not", () => {
    expect(boxAt(d, 50, false).y).toBe(boxAt(d, 0, false).y - 50);
    expect(boxAt(d, 50, true).y).toBe(boxAt(d, 0, true).y - 50);
  });
});

describe("game.js — flyer lanes", () => {
  const scales = [3, 4, 5, 6, 7, 8];
  const runHeights = [19, 20, 21, 22];

  it("puts the three lanes in order and keeps them above the ground", () => {
    const d = dims(4);
    const lanes = flyerLanes(d.spriteH, d.duckH, d.flyerH);
    expect(lanes.mid).toBeGreaterThan(0);
    expect(lanes.low).toBeGreaterThan(lanes.mid);
    expect(lanes.high).toBeGreaterThan(lanes.low);
    expect(FLYER_LANES).toEqual(["low", "mid", "high"]);
  });

  it("is the truth table the design promises, at every scale we ship", () => {
    for (const scale of scales) {
      for (const cells of runHeights) {
        const d = dims(scale, cells);
        const lanes = flyerLanes(d.spriteH, d.duckH, d.flyerH);
        const stand = boxAt(d, 0, false);
        const crouch = boxAt(d, 0, true);
        const label = `scale ${scale}, ${cells} cells`;

        // LOW: hits a standing runner, misses a ducking one.
        expect([label, collides(stand, flyerAt(d, lanes.low))]).toEqual([label, true]);
        expect([label, collides(crouch, flyerAt(d, lanes.low))]).toEqual([label, false]);

        // MID: hits both — ducking does not save you, jumping does.
        expect([label, collides(stand, flyerAt(d, lanes.mid))]).toEqual([label, true]);
        expect([label, collides(crouch, flyerAt(d, lanes.mid))]).toEqual([label, true]);

        // HIGH: a standing runner walks straight under it.
        expect([label, collides(stand, flyerAt(d, lanes.high))]).toEqual([label, false]);
        expect([label, collides(crouch, flyerAt(d, lanes.high))]).toEqual([label, false]);
      }
    }
  });

  it("makes the low lane genuinely unjumpable — not one height in the arc clears it", () => {
    for (const scale of scales) {
      for (const cells of runHeights) {
        const d = dims(scale, cells);
        const lanes = flyerLanes(d.spriteH, d.duckH, d.flyerH);
        const apex = jumpReach(d.spriteH) - (DEFAULTS.hitboxShrink / 2) * d.spriteH;
        const low = flyerAt(d, lanes.low);
        for (let i = 0; i <= 200; i++) {
          const y = (apex * i) / 200;
          expect([scale, cells, i, collides(boxAt(d, y, false), low)]).toEqual([scale, cells, i, true]);
        }
      }
    }
  });

  it("makes the mid lane jumpable, at the apex and with room to spare", () => {
    for (const scale of scales) {
      for (const cells of runHeights) {
        const d = dims(scale, cells);
        const lanes = flyerLanes(d.spriteH, d.duckH, d.flyerH);
        const apex = jumpReach(d.spriteH) - (DEFAULTS.hitboxShrink / 2) * d.spriteH;
        expect(collides(boxAt(d, apex, false), flyerAt(d, lanes.mid))).toBe(false);
        // ...and the window is not a single frame wide.
        expect(collides(boxAt(d, apex * 0.93, false), flyerAt(d, lanes.mid))).toBe(false);
      }
    }
  });

  it("still punishes a jump into the high lane", () => {
    const d = dims(4);
    const lanes = flyerLanes(d.spriteH, d.duckH, d.flyerH);
    const apex = jumpReach(d.spriteH) - (DEFAULTS.hitboxShrink / 2) * d.spriteH;
    expect(collides(boxAt(d, apex, false), flyerAt(d, lanes.high))).toBe(true);
  });

  it("flies the low lane closer to the ground than it used to", () => {
    // THE OWNER'S NOTE: the low flyer should skim lower. `laneLow` is only a
    // request — the clamp puts the lane on the crouch, because the flyer's
    // belly has to pass over a ducking runner's back — so what actually moved
    // it was a deeper crouch (DUCK_DROP 4 -> 5) and half the boundary slack
    // (laneMargin 0.04 -> 0.02 H). This pins the result, not the request.
    const before = { ...DEFAULTS, duckDrop: 4, laneMargin: 0.04 };
    for (const scale of [4, 8]) {
      for (const cells of runHeights) {
        const d = dims(scale, cells);
        const old = { ...d, duckH: (cells - 4) * scale };
        const label = `${cells} cells @ ${scale}x`;
        const now = flyerLanes(d.spriteH, d.duckH, d.flyerH).low / d.spriteH;
        const was = flyerLanes(old.spriteH, old.duckH, old.flyerH, before).low / old.spriteH;
        expect([label, now < was]).toEqual([label, true]);
        expect([label, was - now > 0.05]).toEqual([label, true]); // 5% of a sprite lower
        expect([label, now < 0.75]).toEqual([label, true]);
        // ...and it is the crouch that places it, not the tuning constant.
        expect([label, now > DEFAULTS.laneLow]).toEqual([label, true]);
      }
    }
    // Nowhere, at any scale, does it end up higher than the runner's shoulder.
    for (const scale of scales) {
      for (const cells of runHeights) {
        const d = dims(scale, cells);
        const lanes = flyerLanes(d.spriteH, d.duckH, d.flyerH);
        expect([scale, cells, lanes.low / d.spriteH < 0.9]).toEqual([scale, cells, true]);
      }
    }
  });

  it("never flies a lane into the ground", () => {
    // Every lane is a height above the ground line, measured to the BOTTOM of
    // the flyer's box: if one ever went negative the creature would be drawn
    // through the floor.
    for (const scale of scales) {
      for (const cells of runHeights) {
        const d = dims(scale, cells);
        const lanes = flyerLanes(d.spriteH, d.duckH, d.flyerH);
        for (const name of FLYER_LANES) {
          const lane = lanes[name as keyof typeof lanes];
          expect([scale, cells, name, lane > 0]).toEqual([scale, cells, name, true]);
          expect([scale, cells, name, flyerAt(d, lane).y + d.flyerH < GROUND]).toEqual([
            scale,
            cells,
            name,
            true,
          ]);
        }
      }
    }
  });

  it("keeps a standing runner hit by the low lane even if the art shrinks", () => {
    // A hypothetical stubby flyer: the low lane gives up unjumpability rather
    // than the promise that a standing runner is hit.
    const d = { ...dims(4), flyerH: 10, flyerW: 40 };
    const lanes = flyerLanes(d.spriteH, d.duckH, d.flyerH);
    expect(collides(boxAt(d, 0, false), flyerAt(d, lanes.low))).toBe(true);
    expect(collides(boxAt(d, 0, true), flyerAt(d, lanes.low))).toBe(false);
  });

  it("spreads flyers over all three lanes", () => {
    expect(pickLane(0)).toBe("low");
    expect(pickLane(0.5)).toBe("mid");
    expect(pickLane(0.999)).toBe("high");
    expect(pickLane(1)).toBe("high"); // never off the end
    expect(pickLane(-1)).toBe("low");
    const rng = makeRng(5);
    const seen = new Set<string>();
    for (let i = 0; i < 90; i++) seen.add(pickLane(rng()));
    expect(seen.size).toBe(3);
  });
});

describe("game.js — flyer threshold", () => {
  it("holds every flyer back until the score threshold", () => {
    expect(DEFAULTS.flyerScore).toBe(350);
    for (const score of [0, 1, 100, 349]) {
      expect(mayFly(score)).toBe(false);
      for (const r of [0, 0.1, 0.31, 0.5, 0.99]) expect(spawnsFlyer(r, score)).toBe(false);
    }
    expect(mayFly(350)).toBe(true);
    expect(mayFly(3500)).toBe(true);
  });

  it("mixes flyers into roughly a third of the spawns after that", () => {
    const rng = makeRng(17);
    let flyers = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) if (spawnsFlyer(rng(), 1000)) flyers++;
    expect(flyers / n).toBeGreaterThan(DEFAULTS.flyerChance - 0.05);
    expect(flyers / n).toBeLessThan(DEFAULTS.flyerChance + 0.05);
  });
});

describe("game.js — the banner", () => {
  it("is ASCII, and says nothing at all while the run is live", () => {
    // The old ready banner was "SPACE OR TAP TO RUN · ↓ TO DUCK". The arrow and
    // the interpunct are not in every fallback monospace font, so they came out
    // as tofu on some machines AND changed the measured width that centres the
    // string. Words, not glyphs.
    const all = [...bannerLines("ready"), ...bannerLines("over", 12, 30), ...bannerLines("running")];
    expect(all.length).toBeGreaterThan(0);
    for (const line of all) {
      expect(line).toMatch(/^[\x20-\x7E]+$/);
      expect(line).not.toMatch(/[^\x00-\x7F]/);
    }
    expect(bannerLines("running")).toEqual([]);
    expect(bannerLines("running", 999, 999)).toEqual([]);
    // ONE line on ready. The controls are page copy under the board now, where
    // they survive the run starting; the banner is only the call to action.
    expect(bannerLines("ready")).toEqual(["PRESS SPACE OR TAP TO RUN"]);
    expect(bannerLines("ready").join(" ")).not.toMatch(/DUCK/);
  });

  it("reports the score on a crash, and never a best worse than the score", () => {
    expect(bannerLines("over", 40, 900)[1]).toBe("SCORE 40   BEST 900");
    // A first run that beat the stored best still reads correctly, even before
    // storage has been written back.
    expect(bannerLines("over", 900, 40)[1]).toBe("SCORE 900   BEST 900");
  });

  it("sits above the runner, and stays on a board too short to hold it", () => {
    const size = 24;
    const lead = 38;
    const roomy = bannerPlacement({ lines: 2, size, lead, groundY: 600, spriteH: 168, height: 700 });
    // Where it wants to be: 1.6 sprite-heights above the ground line.
    expect(roomy).toBe(Math.round(600 - 168 * 1.6));

    // The board that used to push it off the top: 240 px tall, 168 px runner.
    const tight = bannerPlacement({ lines: 2, size, lead, groundY: 206, spriteH: 168, height: 240 });
    expect(tight).toBeGreaterThanOrEqual(0);
    expect(tight + size).toBeLessThanOrEqual(240);

    // On the board, and off the runner, at any board size we can think of —
    // including ones far too small for the game to be playable on.
    for (const height of [80, 140, 240, 400, 900]) {
      for (const spriteH of [40, 84, 168, 300]) {
        const groundY = Math.round(height - Math.max(8, height * 0.14));
        for (const lines of [1, 2]) {
          const label = `${height}px board, ${spriteH}px runner, ${lines} lines`;
          const top = bannerPlacement({ lines, size, lead, groundY, spriteH, height });
          const block = size + lead * (lines - 1);
          expect([label, top >= 0]).toEqual([label, true]);
          expect([label, top + size <= height]).toEqual([label, true]);
          // The block clears the runner's shoulder whenever there is any room
          // above it at all.
          const shoulder = Math.round(groundY - spriteH * 0.35);
          if (shoulder >= block) expect([label, top + block <= shoulder]).toEqual([label, true]);
          else expect([label, top]).toEqual([label, 0]);
        }
      }
    }
  });
});

describe("game.js — the jump blip", () => {
  const stubNode = (log: string[]) => ({
    type: "",
    frequency: { setValueAtTime: (v: number) => log.push(`hz:${v}`) },
    gain: {
      setValueAtTime: (v: number, t: number) => log.push(`gain@${t.toFixed(3)}=${v}`),
      linearRampToValueAtTime: (v: number, t: number) => log.push(`ramp@${t.toFixed(3)}=${v}`),
      exponentialRampToValueAtTime: (v: number, t: number) => log.push(`exp@${t.toFixed(3)}=${v}`),
    },
    connect: () => log.push("connect"),
    disconnect: () => log.push("disconnect"),
    start: (t: number) => log.push(`start@${t}`),
    stop: (t: number) => log.push(`stop@${t.toFixed(3)}`),
    onended: null as null | (() => void),
  });

  it("schedules one short square note with a ramped envelope", () => {
    const log: string[] = [];
    const audio = {
      currentTime: 0,
      destination: {},
      createOscillator: () => stubNode(log),
      createGain: () => stubNode(log),
    };
    expect(playBlip(audio)).toBe(true);
    // A few tens of milliseconds, not a tone.
    expect(BLIP_SECONDS).toBeGreaterThan(0.02);
    expect(BLIP_SECONDS).toBeLessThan(0.12);
    expect(log).toContain(`hz:${BLIP_HZ}`);
    expect(log).toContain(`stop@${BLIP_SECONDS.toFixed(3)}`);
    // The envelope is what stops it clicking: it starts at ~0, ramps up over
    // the attack, and is back down before the oscillator is switched off.
    expect(log.some((l) => l.startsWith("gain@0.000=0.0001"))).toBe(true);
    expect(log).toContain(`ramp@${BLIP_ATTACK.toFixed(3)}=${BLIP_GAIN}`);
    expect(log).toContain(`exp@${BLIP_SECONDS.toFixed(3)}=0.0001`);
    expect(BLIP_ATTACK).toBeLessThan(BLIP_SECONDS / 4);
    // Quiet: a tick under the run, not a beep at you.
    expect(BLIP_GAIN).toBeGreaterThan(0);
    expect(BLIP_GAIN).toBeLessThan(0.12);
  });

  it("returns false rather than throwing for anything that is not an AudioContext", () => {
    for (const bad of [null, undefined, {}, 7, "audio", { createOscillator: 1 }]) {
      expect(playBlip(bad as never)).toBe(false);
    }
    // A context that blows up mid-schedule is still not the game's problem.
    const hostile = {
      currentTime: 0,
      destination: {},
      createOscillator() {
        throw new Error("no");
      },
      createGain: () => ({}),
    };
    expect(playBlip(hostile as never)).toBe(false);
  });
});

describe("game.js — high score persistence", () => {
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("reads and writes chrome.storage.local when it exists", async () => {
    const store: Record<string, number> = {};
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (obj: Record<string, number>) => {
            Object.assign(store, obj);
          }),
        },
      },
    };
    expect(await loadHighScore()).toBe(0);
    await saveHighScore(137);
    expect(store[HIGH_SCORE_KEY]).toBe(137);
    expect(await loadHighScore()).toBe(137);
  });

  it("falls back to localStorage on a plain page", async () => {
    await saveHighScore(42);
    expect(await loadHighScore()).toBe(42);
  });

  it("never throws when storage is hostile", async () => {
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: async () => {
            throw new Error("context invalidated");
          },
          set: async () => {
            throw new Error("quota");
          },
        },
      },
    };
    expect(await loadHighScore()).toBe(0);
    await expect(saveHighScore(9)).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------- integration */

type DrawnText = { text: string; x: number; y: number; font: string; fill: string };
type Recorder = { calls: string[]; texts: DrawnText[] };

function stubCanvas(): { canvas: HTMLCanvasElement; rec: Recorder } {
  const rec: Recorder = { calls: [], texts: [] };
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 800 });
  Object.defineProperty(canvas, "clientHeight", { value: 240 });
  const ctx = {
    fillStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    globalAlpha: 1,
    imageSmoothingEnabled: true,
    clearRect: () => rec.calls.push("clearRect"),
    fillRect: () => rec.calls.push("fillRect"),
    drawImage: () => rec.calls.push("drawImage"),
    fillText: (text: string, x: number, y: number) => {
      rec.calls.push("fillText");
      rec.texts.push({ text, x, y, font: ctx.font, fill: ctx.fillStyle });
    },
  };
  canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  return { canvas, rec };
}

function fakeFrame(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * The frame set sprite.js hands over: run frames carrying duck + flyer. The
 * duck is the same width and the same cell scale as the run frames, and
 * DUCK_DROP cells shorter — the shape of a fold, not of a shrink.
 */
function frameSet(scale = 4, runCells = 21) {
  const f = flyerScaleFor(scale);
  const frames = Object.assign(
    [fakeFrame(22 * scale, runCells * scale), fakeFrame(22 * scale, runCells * scale)],
    {
      cellPx: scale,
      box: { x: 1, y: 2, w: 22, h: runCells },
      duck: Object.assign(
        [
          fakeFrame(22 * scale, (runCells - DUCK_DROP) * scale),
          fakeFrame(22 * scale, (runCells - DUCK_DROP) * scale),
        ],
        { cellPx: scale, box: { x: 1, y: 2 + DUCK_DROP, w: 22, h: runCells - DUCK_DROP } },
      ),
      flyer: Object.assign([fakeFrame(22 * f, 21 * f), fakeFrame(22 * f, 21 * f)], { cellPx: f }),
    },
  );
  return frames;
}

function key(type: string, code: string, extra: KeyboardEventInit = {}) {
  return new KeyboardEvent(type, { code, cancelable: true, ...extra });
}

describe("game.js — startGame shell", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("boots, draws, responds to Space and cleans up after stop()", async () => {
    const { canvas, rec } = stubCanvas();
    const scores: number[] = [];

    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    const cancel = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancel);

    const game = startGame({
      canvas,
      frames: frameSet(),
      palette: ["#ac3232"],
      onScore: (s: number) => scores.push(s),
    });

    expect(canvas.getAttribute("tabindex")).toBe("0");
    expect(canvas.getAttribute("role")).toBe("application");
    expect(canvas.getAttribute("aria-label")).toMatch(/space/i);
    expect(canvas.getAttribute("aria-label")).toMatch(/duck/i);
    expect(game.getState()).toBe("ready");

    cb!(0);
    expect(rec.calls).toContain("drawImage");
    expect(rec.calls).toContain("fillText");

    const evt = key("keydown", "Space");
    window.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(game.getState()).toBe("running");

    for (let t = 16; t < 2500; t += 16) cb!(t);
    expect(game.getScore()).toBeGreaterThan(0);
    expect(scores[scores.length - 1]).toBe(game.getScore());

    game.stop();
    expect(cancel).toHaveBeenCalled();
    const after = game.getState();
    window.dispatchEvent(key("keydown", "Space"));
    expect(game.getState()).toBe(after);
  });

  it("swallows Space and both arrows so the page never scrolls", () => {
    const { canvas } = stubCanvas();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const game = startGame({ canvas, frames: frameSet(), palette: [] });
    for (const code of ["Space", "ArrowUp", "ArrowDown"]) {
      const down = key("keydown", code);
      window.dispatchEvent(down);
      expect([code, down.defaultPrevented]).toEqual([code, true]);
      // ...including while the key is auto-repeating.
      const repeat = key("keydown", code, { repeat: true });
      window.dispatchEvent(repeat);
      expect([code, repeat.defaultPrevented]).toEqual([code, true]);
    }
    game.stop();
  });

  it("ignores key repeat: a held Space is one jump, not a hover", () => {
    const { canvas } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const game = startGame({ canvas, frames: frameSet(), palette: [] });
    game.restart();
    window.dispatchEvent(key("keydown", "Space"));
    cb!(16);
    const vy = game.getSnapshot().runner.vy;
    for (let t = 32; t < 400; t += 16) {
      window.dispatchEvent(key("keydown", "Space", { repeat: true }));
      cb!(t);
    }
    const snap = game.getSnapshot();
    expect(snap.runner.vy).toBeLessThan(vy); // still on the way down
    expect(snap.runner.jumped).toBe(true);
    game.stop();
  });

  it("cannot double jump, however hard the key is mashed", () => {
    const { canvas } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const game = startGame({ canvas, frames: frameSet(), palette: [] });
    game.restart();
    const H = game.getSnapshot().spriteH;
    const apex = (DEFAULTS.jumpVelocity ** 2 / (2 * DEFAULTS.gravity)) * H;
    let peak = 0;
    for (let t = 16; t < 1200; t += 16) {
      window.dispatchEvent(key("keydown", "Space"));
      cb!(t);
      peak = Math.max(peak, game.getSnapshot().runner.y);
    }
    expect(peak).toBeLessThan(apex * 1.05);
    game.stop();
  });

  it("ducks while Arrow Down is held, and stands up when it is let go", () => {
    const { canvas } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const game = startGame({ canvas, frames: frameSet(), palette: [] });
    game.restart();
    cb!(16);

    const standing = game.getSnapshot();
    expect(standing.ducking).toBe(false);
    expect(standing.runnerRect.h).toBe(standing.spriteH);

    window.dispatchEvent(key("keydown", "ArrowDown"));
    cb!(32);
    const crouched = game.getSnapshot();
    expect(crouched.ducking).toBe(true);
    expect(crouched.runnerRect.h).toBe(crouched.duckH);
    expect(crouched.runnerRect.w).toBe(crouched.duckW);
    // Same ground line, smaller box.
    expect(crouched.runnerRect.y + crouched.runnerRect.h).toBe(standing.groundY);
    expect(crouched.duckH).toBeLessThan(crouched.spriteH);

    window.dispatchEvent(key("keyup", "ArrowDown"));
    cb!(48);
    expect(game.getSnapshot().ducking).toBe(false);
    expect(game.getSnapshot().runnerRect.h).toBe(standing.spriteH);
    game.stop();
  });

  it("lets go of the duck when the window loses focus", () => {
    const { canvas } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const game = startGame({ canvas, frames: frameSet(), palette: [] });
    game.restart();
    window.dispatchEvent(key("keydown", "ArrowDown"));
    cb!(16);
    expect(game.getSnapshot().ducking).toBe(true);
    window.dispatchEvent(new Event("blur"));
    cb!(32);
    expect(game.getSnapshot().ducking).toBe(false);
    game.stop();
  });

  it("fast-falls when ducking in mid-air", () => {
    const { canvas } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const fall = (duckAt: number | null) => {
      const game = startGame({ canvas, frames: frameSet(), palette: [] });
      game.restart();
      cb!(0);
      window.dispatchEvent(key("keydown", "Space"));
      let landed = 0;
      for (let t = 16; t < 3000; t += 16) {
        if (duckAt !== null && t >= duckAt) window.dispatchEvent(key("keydown", "ArrowDown"));
        cb!(t);
        if (game.getSnapshot().runner.grounded) {
          landed = t;
          break;
        }
      }
      window.dispatchEvent(key("keyup", "ArrowDown"));
      game.stop();
      return landed;
    };

    const floaty = fall(null);
    const dropped = fall(300);
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThan(floaty);
  });

  it("ignores keystrokes aimed at a text field", () => {
    const { canvas } = stubCanvas();
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const game = startGame({ canvas, frames: [fakeFrame(40, 40)], palette: [] });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    expect(game.getState()).toBe("ready");
    game.stop();
    input.remove();
  });

  it("runs with reduced motion on, without parallax or idle animation", () => {
    const { canvas, rec } = stubCanvas();
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const game = startGame({ canvas, frames: frameSet(), palette: ["#ac3232"] });
    cb!(0);
    game.restart();
    for (let t = 16; t < 1200; t += 16) cb!(t);
    expect(game.getState()).toBe("running");
    expect(game.getScore()).toBeGreaterThan(0);
    expect(rec.calls).toContain("drawImage");
    game.stop();
  });

  it("throws only when there is no canvas at all", () => {
    expect(() => startGame({} as never)).toThrow(/canvas/);
  });

  /** Every colour the game actually asked the canvas for, over a short run. */
  function paintedColours(palette: unknown, scale = 2) {
    const seen = new Set<string>();
    const { canvas } = stubCanvas();
    const ctx = canvas.getContext("2d") as unknown as { fillStyle: string };
    Object.defineProperty(ctx, "fillStyle", {
      get: () => "",
      set: (v: string) => {
        seen.add(v);
      },
    });
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const game = startGame({
      canvas,
      frames: frameSet(scale),
      palette: palette as string[],
      scale,
      reducedMotion: true,
    });
    cb!(0); // the READY overlay
    game.restart();
    for (let t = 16; t < 8000 && game.getState() === "running"; t += 16) cb!(t);
    cb!(8016); // ...and the CRASHED one, so the overlay text is covered too
    const snap = game.getSnapshot();
    game.stop();
    return { seen, canvas, board: snap.board };
  }

  it("takes its surface from the theme object, and its marks from Ethereum", () => {
    const { seen, canvas, board } = paintedColours({
      // the shape the page actually sends: tokens + the piece's colours
      paper: "#0b0b0d",
      card: "#161619",
      ink: "#f7f7f8",
      mute: "#9c9ca6",
      accent: "#ff4da1",
      piece: ["#ac3232"],
    });
    const marks = readableFacets(ethFacets(), board, DEFAULTS.facetContrast);
    expect(seen.has(marks.L)).toBe(true); // the one grey the marks wear
    expect(seen.has("#ac3232")).toBe(false); // the piece's colour never lands on a mark
    expect(seen.has("#9c9ca6")).toBe(true); // ground line uses the page's mute
    expect(seen.has("#161619")).toBe(true); // and the board is the page's card
    expect(seen.has("#FF4DA1")).toBe(false); // never falls back to raw pink
    // scale:2 is honoured instead of the ambient devicePixelRatio
    expect(canvas.width).toBe(1600);
  });

  it("draws a WHITE board from the palette, with nothing vanishing into it", () => {
    // The page owns the theme and may hand us a light one. Everything the game
    // paints has to survive that: sky, ground, texture, marks and overlay.
    const light = {
      paper: "#ffffff",
      card: "#ffffff",
      ink: "#0b0b0d",
      mute: "#6b6b76",
      accent: "#d6006b",
      // a deliberately awful piece: near-white and pale-yellow pixels
      piece: ["#fcf893", "#f7f7f8", "#cbdbfc"],
    };
    const { seen, board } = paintedColours(light);
    expect(board).toBe("#ffffff");
    expect(seen.has("#ffffff")).toBe(true); // the sky really is painted
    for (const colour of seen) {
      if (colour === "#ffffff") continue;
      // Every other colour the game paints holds a real ratio against white.
      expect([colour, contrastRatio(colour, "#ffffff") >= DEFAULTS.facetContrast]).toEqual([colour, true]);
    }
    // ...and no pale piece colour was drafted onto a mark in the first place:
    // the marks are one Ethereum grey, already legible on white, so the
    // contrast pass has nothing to spend.
    expect(seen.has("#fcf893")).toBe(false);
    expect(seen.has(ETH_GREY)).toBe(true);
  });

  it("keeps the dark board exactly as it was", () => {
    const { seen, board } = paintedColours({
      card: "#161619",
      ink: "#f7f7f8",
      mute: "#9c9ca6",
      accent: "#ff4da1",
      piece: ["#ac3232", "#5fcde4"],
    });
    expect(board).toBe("#161619");
    // Page tokens on a near-black board are untouched — the contrast pass only
    // ever spends what it has to.
    expect(seen.has("#f7f7f8")).toBe(true);
    expect(seen.has("#9c9ca6")).toBe(true);
    // The one colour it does spend on is the mark's grey: #3C3C3D is 1.64:1
    // against #161619, so it gets lifted just far enough to be seen.
    const marks = readableFacets(ethFacets(), board, DEFAULTS.facetContrast);
    expect(marks.L).not.toBe(ETH_GREY);
    expect(contrastRatio(marks.L, board)).toBeGreaterThanOrEqual(DEFAULTS.facetContrast);
    expect(seen.has(marks.L)).toBe(true);
    // Lifted, still flat: one colour in, one colour out.
    expect(new Set([marks.L, marks.M, marks.D]).size).toBe(1);
  });

  it("is losable: a player who never jumps crashes into the first mark", async () => {
    const { canvas } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const game = startGame({ canvas, frames: frameSet(), palette: ["#ac3232"] });
    game.restart();
    for (let t = 16; t < 15_000 && game.getState() === "running"; t += 16) cb!(t);
    expect(game.getState()).toBe("over");
    expect(game.getScore()).toBeGreaterThan(0);
    await vi.waitFor(async () => {
      expect(await loadHighScore()).toBe(game.getScore());
    });
    game.stop();
  });

  it("keeps flyers out of the first 350 points, then flies them at three heights", () => {
    const { canvas } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const game = startGame({ canvas, frames: frameSet(), palette: ["#ac3232"], reducedMotion: true });
    game.restart();
    const lanes = new Set<string>();
    const step = 1000 / 60;
    for (let t = step; t < 180_000; t += step) {
      autopilot(game);
      cb!(t);
      const snap = game.getSnapshot();
      if (snap.state !== "running") break;
      for (const o of snap.obstacles) {
        if (o.kind !== "flyer") continue;
        expect(snap.score).toBeGreaterThanOrEqual(DEFAULTS.flyerScore);
        lanes.add(o.lane!);
      }
    }
    expect(game.getState()).toBe("running");
    expect(lanes).toEqual(new Set(["low", "mid", "high"]));
    game.stop();
  });

  it("opens with real reaction time on the real board", () => {
    // The claim the pacing rests on, measured rather than modelled: how many
    // seconds a player has between first seeing the opening mark and being hit
    // by it. 800x240 css at 1x is the size the page actually gives the canvas.
    const { canvas } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const game = startGame({ canvas, frames: frameSet(), palette: ["#ac3232"], scale: 1, reducedMotion: true });
    game.restart();
    let runway = 0;
    for (let t = 16; t < 6000; t += 16) {
      cb!(t);
      const snap = game.getSnapshot();
      if (!snap.obstacles.length) continue;
      const me = snap.runnerRect;
      const first = snap.obstacles[0];
      runway = (first.x - (me.x + me.w)) / (speedAt(snap.elapsed) * snap.spriteH);
      break;
    }
    expect(runway).toBeGreaterThan(1.8); // seconds — a calm opening, not a reflex test
    game.stop();
  });

  /**
   * Drive one autopilot run to `ms` and report what it saw.
   *
   * `seed` pins `Date.now`, which is where startGame's RNG seed comes from, so
   * a run is reproducible. It has to be: the board's variety over three minutes
   * is a sampling question, and the rarest pattern ("range", weight 0.15 early,
   * and not clearable below 8.5 H/s) misses a given three-minute window often
   * enough that an unpinned seed made this test fail about one run in four —
   * before any of this round's changes as well as after.
   */
  function autopilotRun(seed: number, ms: number) {
    const { canvas } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const now = vi.spyOn(Date, "now").mockReturnValue(seed);

    const game = startGame({ canvas, frames: frameSet(), palette: ["#ac3232"], reducedMotion: true });
    game.restart();
    now.mockRestore();

    const step = 1000 / 60;
    const spawned: string[] = [];
    const early = new Set<string>();
    for (let t = step; t < ms; t += step) {
      if (game.getState() !== "running") break;
      autopilot(game);
      cb!(t);
      const snap = game.getSnapshot();
      if (snap.pattern && snap.pattern !== spawned[spawned.length - 1]) spawned.push(snap.pattern);
      if (snap.elapsed < 15 && snap.pattern) early.add(snap.pattern);
    }
    const out = { state: game.getState(), score: game.getScore(), spawned, early };
    game.stop();
    return out;
  }

  it("stays winnable: an autopilot survives three minutes of the whole ramp", () => {
    const run = autopilotRun(20260806, 180_000);
    expect(run.state).toBe("running");
    expect(run.score).toBeGreaterThan(2500);

    // ...and the run it survived was a varied one: the whole pattern set turns
    // up over three minutes, never twice in a row, and the first fifteen
    // seconds stay on the openers.
    expect(new Set(run.spawned).size).toBe(SPAWN_PATTERNS.length);
    for (let i = 1; i < run.spawned.length; i++) expect(run.spawned[i]).not.toBe(run.spawned[i - 1]);
    for (const name of run.early) {
      const pattern = SPAWN_PATTERNS.find((p) => p.name === name)!;
      expect([name, pattern.minRatio * DEFAULTS.baseSpeed <= speedAt(15)]).toEqual([name, true]);
    }
  });

  it("shows the ready banner, hides it while running, and swaps it on a crash", () => {
    const { canvas, rec } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const game = startGame({ canvas, frames: frameSet(), palette: ["#ac3232"], reducedMotion: true });

    // READY: the banner is on the board.
    cb!(0);
    expect(game.getState()).toBe("ready");
    expect(rec.texts.map((t) => t.text)).toEqual(bannerLines("ready"));

    // RUNNING: it is gone, and it stays gone for a whole second of frames.
    rec.texts.length = 0;
    window.dispatchEvent(key("keydown", "Space"));
    expect(game.getState()).toBe("running");
    for (let t = 16; t < 1000; t += 16) cb!(t);
    expect(rec.texts).toEqual([]);

    // CRASHED: a different banner, carrying the score.
    rec.texts.length = 0;
    for (let t = 1000; t < 40_000 && game.getState() === "running"; t += 16) cb!(t);
    expect(game.getState()).toBe("over");
    rec.texts.length = 0;
    cb!(40_016);
    expect(rec.texts).toHaveLength(2);
    expect(rec.texts[0].text).toBe("CRASHED - PRESS SPACE TO RUN AGAIN");
    expect(rec.texts[1].text).toContain(`SCORE ${game.getScore()}`);

    // ...and pressing Space clears it again in the same frame it restarts in.
    rec.texts.length = 0;
    window.dispatchEvent(key("keydown", "Space"));
    cb!(40_032);
    expect(game.getState()).toBe("running");
    expect(rec.texts).toEqual([]);
    game.stop();
  });

  it("draws the banner in ASCII, centred, and inside the board", () => {
    const { canvas, rec } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const game = startGame({ canvas, frames: frameSet(), palette: ["#ac3232"], reducedMotion: true });
    cb!(0);
    const snap = game.getSnapshot();
    for (const t of rec.texts) {
      expect(t.text).toMatch(/^[\x20-\x7E]+$/); // printable ASCII only — no tofu
      expect(t.x).toBe(Math.round(canvas.width / 2));
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeLessThan(snap.groundY - snap.spriteH); // clear of the runner
      expect(t.font).toMatch(/monospace/);
    }
    // Both lines fit on the board at the shipped font size.
    const size = Math.max(11, Math.round((snap.spriteH / 21) * 2.4));
    for (const t of rec.texts) expect(t.text.length * size * 0.62).toBeLessThan(canvas.width);
    game.stop();
  });

  it("never beeps twice for one jump, and never at all when muted", () => {
    const scheduled: string[] = [];
    const node = () => ({
      type: "",
      frequency: { setValueAtTime: () => {} },
      gain: {
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
        exponentialRampToValueAtTime: () => {},
      },
      connect: () => {},
      disconnect: () => {},
      start: () => scheduled.push("start"),
      stop: () => {},
      onended: null,
    });
    class FakeAudioContext {
      static made = 0;
      currentTime = 0;
      state = "suspended";
      destination = {};
      constructor() {
        FakeAudioContext.made++;
      }
      resume() {
        this.state = "running";
        return Promise.resolve();
      }
      createOscillator() {
        return node();
      }
      createGain() {
        return node();
      }
      close() {}
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { canvas } = stubCanvas();
    const game = startGame({ canvas, frames: frameSet(), palette: [] });

    // The first press STARTS the run — a start is not a jump, and nothing is
    // built before a user gesture that actually jumps.
    window.dispatchEvent(key("keydown", "Space"));
    cb!(16);
    expect(FakeAudioContext.made).toBe(0);
    expect(scheduled).toHaveLength(0);

    // One jump, one blip — and the context is only now created.
    window.dispatchEvent(key("keydown", "Space"));
    expect(FakeAudioContext.made).toBe(1);
    expect(scheduled).toHaveLength(1);

    // Mashing mid-air cannot jump, so it cannot blip either.
    for (let t = 32; t < 300; t += 16) {
      window.dispatchEvent(key("keydown", "Space"));
      cb!(t);
    }
    expect(scheduled).toHaveLength(1);

    // Muted: still jumps, makes no sound, and builds no more contexts.
    for (let t = 300; t < 1400; t += 16) cb!(t);
    expect(game.getSnapshot().runner.grounded).toBe(true);
    expect(game.setMuted(true)).toBe(true);
    expect(game.isMuted()).toBe(true);
    window.dispatchEvent(key("keydown", "Space"));
    expect(game.getSnapshot().runner.grounded).toBe(false);
    expect(scheduled).toHaveLength(1);
    expect(FakeAudioContext.made).toBe(1);
    expect(game.getSnapshot().muted).toBe(true);
    game.stop();
  });

  it("starts muted when the page asks, and never throws without audio", () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    // No AudioContext at all — the offline/blocked case. Jumping must be a
    // no-op soundwise, not an exception.
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    const { canvas } = stubCanvas();
    const silent = startGame({ canvas, frames: frameSet(), palette: [], muted: true });
    expect(silent.isMuted()).toBe(true);
    expect(silent.setMuted(false)).toBe(false);
    silent.restart();
    expect(() => window.dispatchEvent(key("keydown", "Space"))).not.toThrow();
    expect(silent.getSnapshot().runner.grounded).toBe(false);
    silent.stop();

    // ...and an AudioContext whose constructor throws (autoplay lockdown).
    class Hostile {
      constructor() {
        throw new Error("blocked");
      }
    }
    vi.stubGlobal("AudioContext", Hostile);
    const { canvas: c2 } = stubCanvas();
    const loud = startGame({ canvas: c2, frames: frameSet(), palette: [] });
    loud.restart();
    expect(() => window.dispatchEvent(key("keydown", "Space"))).not.toThrow();
    expect(loud.getSnapshot().runner.grounded).toBe(false);
    expect(() => loud.stop()).not.toThrow();
  });

  it("stays winnable on a board it has never seen before", () => {
    // Survival is not a property of one lucky seed. Four different boards, a
    // minute each: the snappier arc has to answer all of them.
    for (const seed of [1, 7, 4242, 65535]) {
      const run = autopilotRun(seed, 60_000);
      expect([seed, run.state]).toEqual([seed, "running"]);
      expect([seed, run.score > 500]).toEqual([seed, true]);
      for (let i = 1; i < run.spawned.length; i++) {
        expect([seed, run.spawned[i]]).not.toEqual([seed, run.spawned[i - 1]]);
      }
    }
  });
});

/**
 * A player, near enough: jump the marks and the mid flyers, duck the low ones,
 * ignore the high ones. It only reads the snapshot, so it proves the game is
 * beatable with the information a human has on screen.
 */
function autopilot(game: ReturnType<typeof startGame>) {
  const snap = game.getSnapshot();
  if (snap.state !== "running") return;
  const me = snap.runnerRect;
  const speed = speedAt(snap.elapsed) * snap.spriteH;
  const ahead = snap.obstacles
    .filter((o) => o.x + o.w > me.x)
    .sort((a, b) => a.x - b.x)[0];
  const holdDuck = () => window.dispatchEvent(key("keydown", "ArrowDown"));
  const release = () => window.dispatchEvent(key("keyup", "ArrowDown"));
  if (!ahead) return release();

  const contact = (ahead.x - (me.x + me.w)) / speed; // seconds until it reaches us
  const clearing = (ahead.w + me.w) / speed; // seconds it takes to pass us

  if (ahead.kind === "flyer" && ahead.lane === "high") return release();
  if (ahead.kind === "flyer" && ahead.lane === "low") {
    if (contact < clearing * 1.5 + 0.25) return holdDuck();
    return release();
  }
  release();
  if (!snap.runner.grounded) return;

  // Jump early enough to be over it before it arrives, and to still be over it
  // when the tail goes past: aim the apex at the middle of the crossing.
  const top = snap.groundY - ahead.y - (DEFAULTS.hitboxShrink / 2) * snap.spriteH;
  const v0 = DEFAULTS.jumpVelocity * snap.spriteH;
  const g = DEFAULTS.gravity * snap.spriteH;
  const disc = v0 * v0 - 2 * g * top;
  if (disc <= 0) return;
  const rise = (v0 - Math.sqrt(disc)) / g; // time to get above it
  const above = (2 * Math.sqrt(disc)) / g; // time spent above it
  const lead = rise + Math.max(0, (above - clearing) / 2);
  if (contact <= lead) window.dispatchEvent(key("keydown", "Space"));
}
