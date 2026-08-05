// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULTS,
  ETH_LARGE,
  ETH_SMALL,
  FLYER_LANES,
  HIGH_SCORE_KEY,
  OBSTACLE_SHAPES,
  clusterShape,
  collides,
  facetColours,
  flyerLanes,
  jump,
  jumpReach,
  loadHighScore,
  makeRng,
  mayFly,
  pickLane,
  pickObstacle,
  rectsOverlap,
  runnerBox,
  saveHighScore,
  scoreFromDistance,
  shapeFromRows,
  shrinkRect,
  spawnGap,
  spawnsFlyer,
  speedAt,
  startGame,
  stepRunner,
} from "../game.js";
import { duckScaleFor, flyerScaleFor } from "../sprite.js";

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

  it("reaches the cap in a sane amount of time", () => {
    const capAt = (DEFAULTS.maxSpeed - DEFAULTS.baseSpeed) / DEFAULTS.accel;
    expect(capAt).toBeGreaterThan(10);
    expect(speedAt(capAt)).toBeCloseTo(DEFAULTS.maxSpeed, 6);
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

describe("game.js — obstacles are Ethereum marks", () => {
  const marks = [ETH_SMALL, ETH_LARGE];

  it("ships integer cell geometry inside its own box", () => {
    for (const { shape } of OBSTACLE_SHAPES) {
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
      expect(mark.h / mark.w).toBeGreaterThan(1.4); // the mark's own proportions
      expect(mark.h / mark.w).toBeLessThan(1.9);
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
    for (const { shape } of OBSTACLE_SHAPES) {
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
    for (const { shape } of OBSTACLE_SHAPES) {
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

  it("offers singles and clusters of two and three, and nothing wider", () => {
    const sizes = OBSTACLE_SHAPES.map(({ shape }) => {
      for (const mark of marks) {
        for (const n of [1, 2, 3]) {
          if (shape.w === mark.w * n + (n - 1) && shape.h === mark.h) return n;
        }
      }
      return 0;
    });
    expect(new Set(sizes)).toEqual(new Set([1, 2, 3]));
    expect(sizes).not.toContain(0);
    expect(sizes.filter((n) => n === 1).length).toBe(2); // one small, one large
  });

  it("holds the widest groups back until the world is moving fast enough", () => {
    for (const { shape, minSpeed } of OBSTACLE_SHAPES) {
      expect(minSpeed).toBeGreaterThanOrEqual(1);
      expect(minSpeed * DEFAULTS.baseSpeed).toBeLessThanOrEqual(DEFAULTS.maxSpeed);
      // Wider group => later unlock, never the other way round.
      for (const other of OBSTACLE_SHAPES) {
        if (other.shape.w > shape.w) expect(other.minSpeed).toBeGreaterThanOrEqual(minSpeed);
      }
    }
    const atBase = OBSTACLE_SHAPES.filter((o) => o.minSpeed <= 1);
    expect(atBase.length).toBeGreaterThanOrEqual(3);
  });

  it("is jumpable: every group fits inside the jump arc at its unlock speed", () => {
    // The whole safety argument in one assertion. Time spent with the shrunk
    // hitbox above the mark, times the scroll speed, must exceed the group's
    // width plus the runner's own.
    const H = 84; // a real sprite height: 21 cells at the page's 4x scale
    const unit = 4; // ...and its cell size
    const runnerW = 22 * unit * (1 - DEFAULTS.hitboxShrink);
    const v0 = DEFAULTS.jumpVelocity * H;
    const g = DEFAULTS.gravity * H;
    for (const { shape, minSpeed } of OBSTACLE_SHAPES) {
      const need = shape.h * unit - (DEFAULTS.hitboxShrink / 2) * H;
      const disc = v0 * v0 - 2 * g * need;
      expect(disc).toBeGreaterThan(0); // tall enough to clear at all
      const window = (2 * Math.sqrt(disc)) / g; // seconds spent above it
      const travel = window * minSpeed * DEFAULTS.baseSpeed * H;
      expect(travel).toBeGreaterThan((shape.w * unit + runnerW) * 1.25);
    }
  });

  it("paints marks only in the piece's own colours", () => {
    const rng = makeRng(42);
    const palette = ["#ac3232", "#5fcde4", "#e7d632"];
    for (let i = 0; i < 200; i++) {
      const { shape, colours } = pickObstacle(rng, palette, 2);
      for (const c of [colours.L, colours.M, colours.D]) expect(palette).toContain(c);
      expect(OBSTACLE_SHAPES.some((o) => o.shape === shape)).toBe(true);
    }
  });

  it("orders the facets light / seam / dark by luminance", () => {
    const { L, M, D } = facetColours(["#1e1e26", "#a0a0a0", "#f7f7f8"], 0);
    expect(L).toBe("#f7f7f8");
    expect(M).toBe("#a0a0a0");
    expect(D).toBe("#1e1e26");
  });

  it("survives a piece with one colour, and one with none", () => {
    expect(facetColours(["#ac3232"])).toEqual({ L: "#ac3232", M: "#ac3232", D: "#ac3232" });
    expect(facetColours([])).toEqual({ L: "#FF4DA1", M: "#FF4DA1", D: "#FF4DA1" });
    expect(facetColours(["nope", ""] as string[])).toEqual({ L: "#FF4DA1", M: "#FF4DA1", D: "#FF4DA1" });
  });

  it("varies which of a rich palette a mark wears", () => {
    const palette = ["#ac3232", "#5fcde4", "#e7d632", "#37946e", "#cb67d2", "#306082"];
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(JSON.stringify(facetColours(palette, i / 60)));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("never picks a group the current speed has not unlocked", () => {
    const rng = makeRng(11);
    for (let i = 0; i < 300; i++) {
      const ratio = 1 + (i % 3) * 0.1; // 1.0, 1.1, 1.2
      const { shape } = pickObstacle(rng, ["#ac3232"], ratio);
      const entry = OBSTACLE_SHAPES.find((o) => o.shape === shape)!;
      expect(entry.minSpeed).toBeLessThanOrEqual(ratio);
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

/* --------------------------------------------------------- the duck + flyer */

/**
 * Real sprite dimensions: the run box is 22x21 cells and the flyer's is 22x22,
 * so at the page's scales these are the numbers the game actually sees.
 */
function dims(scale: number, runCells = 21) {
  return {
    spriteH: runCells * scale,
    spriteW: 22 * scale,
    duckH: runCells * duckScaleFor(scale),
    duckW: 22 * duckScaleFor(scale),
    flyerH: 22 * flyerScaleFor(scale),
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

  it("shrinks the hitbox by exactly as much as the sprite shrinks", () => {
    const stand = boxAt(d, 0, false);
    const crouch = boxAt(d, 0, true);
    expect(crouch.h / stand.h).toBeCloseTo(3 / 4, 12);
    expect(crouch.w / stand.w).toBeCloseTo(3 / 4, 12);
    expect(crouch.h).toBe(63);
    expect(crouch.w).toBe(66);
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
    expect(DEFAULTS.flyerScore).toBe(450);
    for (const score of [0, 1, 100, 449]) {
      expect(mayFly(score)).toBe(false);
      for (const r of [0, 0.1, 0.31, 0.5, 0.99]) expect(spawnsFlyer(r, score)).toBe(false);
    }
    expect(mayFly(450)).toBe(true);
    expect(mayFly(4500)).toBe(true);
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

type Recorder = { calls: string[] };

function stubCanvas(): { canvas: HTMLCanvasElement; rec: Recorder } {
  const rec: Recorder = { calls: [] };
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
    fillText: () => rec.calls.push("fillText"),
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

/** The frame set sprite.js hands over: run frames carrying duck + flyer. */
function frameSet(scale = 4) {
  const d = duckScaleFor(scale);
  const f = flyerScaleFor(scale);
  const frames = Object.assign([fakeFrame(22 * scale, 21 * scale), fakeFrame(22 * scale, 21 * scale)], {
    cellPx: scale,
    box: { x: 1, y: 2, w: 22, h: 21 },
    duck: Object.assign([fakeFrame(22 * d, 21 * d), fakeFrame(22 * d, 21 * d)], { cellPx: d }),
    flyer: Object.assign([fakeFrame(22 * f, 22 * f), fakeFrame(22 * f, 22 * f)], { cellPx: f }),
  });
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

  it("takes the piece colours from either a plain array or a theme object", () => {
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
      frames: frameSet(2),
      // the shape the page actually sends: tokens + the piece's colours
      palette: { ink: "#111111", mute: "#222222", accent: "#333333", piece: ["#ac3232"] },
      scale: 2,
      reducedMotion: true,
    });
    game.restart();
    for (let t = 16; t < 6000 && game.getState() === "running"; t += 16) cb!(t);
    expect(seen.has("#ac3232")).toBe(true); // marks wear the piece's colour
    expect(seen.has("#222222")).toBe(true); // ground line uses the page's mute
    expect(seen.has("#FF4DA1")).toBe(false); // never falls back to raw pink
    // scale:2 is honoured instead of the ambient devicePixelRatio
    expect(canvas.width).toBe(1600);
    game.stop();
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

  it("keeps flyers out of the first 450 points, then flies them at three heights", () => {
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

  it("stays winnable: an autopilot survives three minutes of the whole ramp", () => {
    const { canvas } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const game = startGame({ canvas, frames: frameSet(), palette: ["#ac3232"], reducedMotion: true });
    game.restart();
    const step = 1000 / 60;
    for (let t = step; t < 180_000; t += step) {
      if (game.getState() !== "running") break;
      autopilot(game);
      cb!(t);
    }
    expect(game.getState()).toBe("running");
    expect(game.getScore()).toBeGreaterThan(2500);
    game.stop();
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
