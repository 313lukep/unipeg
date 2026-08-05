// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULTS,
  HIGH_SCORE_KEY,
  OBSTACLE_SHAPES,
  collides,
  jump,
  loadHighScore,
  makeRng,
  pickObstacle,
  rectsOverlap,
  saveHighScore,
  scoreFromDistance,
  shrinkRect,
  speedAt,
  startGame,
  stepRunner,
} from "../game.js";

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

  it("refuses a second jump in mid-air once the coyote window has passed", () => {
    let r = jump({ y: 0, vy: 0, grounded: true, airTime: 0 }, V, 0.08);
    for (let i = 0; i < 30; i++) r = stepRunner(r, 1 / 120, G); // 0.25s aloft
    const again = jump(r, V, 0.08);
    expect(again).toBe(r); // same object == refused
    expect(again.vy).toBeLessThan(V);
  });

  it("allows a coyote-time jump just after leaving the ground", () => {
    const falling = stepRunner({ y: 1, vy: 0, grounded: false, airTime: 0 }, 1 / 240, G);
    expect(falling.airTime).toBeLessThan(0.08);
    expect(jump(falling, V, 0.08).vy).toBe(V);
  });

  it("does nothing for a zero or negative timestep", () => {
    const r = { y: 5, vy: 3, grounded: false, airTime: 0.1 };
    expect(stepRunner(r, 0, G)).toEqual(r);
    expect(stepRunner(r, -1, G)).toEqual(r);
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
    // Obstacle overlapping the runner's outer 4px — inside the shrunk box it misses.
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

describe("game.js — obstacles", () => {
  it("ships only shapes with integer cell geometry inside their own box", () => {
    for (const shape of OBSTACLE_SHAPES) {
      for (const [x, y, w, h] of shape.cells) {
        for (const v of [x, y, w, h]) expect(Number.isInteger(v)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x + w).toBeLessThanOrEqual(shape.w);
        expect(y + h).toBeLessThanOrEqual(shape.h);
      }
      expect(shape.h).toBeLessThanOrEqual(3); // must stay jumpable
    }
  });

  it("only ever paints obstacles in the piece's own colours", () => {
    const rng = makeRng(42);
    const palette = ["#ac3232", "#5fcde4"];
    for (let i = 0; i < 200; i++) {
      const { shape, colour } = pickObstacle(rng, palette);
      expect(palette).toContain(colour);
      expect(OBSTACLE_SHAPES).toContain(shape);
    }
  });

  it("falls back to pink when the piece has no colours to give", () => {
    expect(pickObstacle(makeRng(1), []).colour).toBe("#FF4DA1");
  });

  it("has a deterministic rng in [0,1)", () => {
    const a = Array.from({ length: 50 }, makeRng(7));
    const b = Array.from({ length: 50 }, makeRng(7));
    const first = makeRng(7);
    const seq = Array.from({ length: 50 }, () => first());
    expect(seq.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(seq).size).toBeGreaterThan(40);
    expect(a.length).toBe(b.length);
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

describe("game.js — startGame shell", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("boots, draws, responds to Space and cleans up after stop()", async () => {
    const { canvas, rec } = stubCanvas();
    const frames = Object.assign([fakeFrame(88, 96), fakeFrame(88, 96)], { cellPx: 4 });
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
      frames,
      palette: ["#ac3232"],
      onScore: (s) => scores.push(s),
    });

    expect(canvas.getAttribute("tabindex")).toBe("0");
    expect(canvas.getAttribute("role")).toBe("application");
    expect(canvas.getAttribute("aria-label")).toMatch(/space/i);
    expect(game.getState()).toBe("ready");

    // First frame: ready state draws the unicorn and the prompt.
    cb!(0);
    expect(rec.calls).toContain("drawImage");
    expect(rec.calls).toContain("fillText");

    // Space starts the run.
    const evt = new KeyboardEvent("keydown", { code: "Space", cancelable: true });
    window.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(game.getState()).toBe("running");

    // Advance ~2.5 seconds of simulation; the score must climb.
    for (let t = 16; t < 2500; t += 16) cb!(t);
    expect(game.getScore()).toBeGreaterThan(0);
    expect(scores[scores.length - 1]).toBe(game.getScore());

    game.stop();
    expect(cancel).toHaveBeenCalled();
    const after = game.getState();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    expect(game.getState()).toBe(after);
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

    const frames = Object.assign([fakeFrame(88, 96), fakeFrame(88, 96)], { cellPx: 4 });
    const game = startGame({ canvas, frames, palette: ["#ac3232"] });
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

    const frames = Object.assign([fakeFrame(88, 96), fakeFrame(88, 96)], { cellPx: 4 });
    const game = startGame({
      canvas,
      frames,
      // the shape the page actually sends: tokens + the piece's colours
      palette: { ink: "#111111", mute: "#222222", accent: "#333333", piece: ["#ac3232"] },
      scale: 2,
      reducedMotion: true,
    });
    game.restart();
    for (let t = 16; t < 6000 && game.getState() === "running"; t += 16) cb!(t);
    expect(seen.has("#ac3232")).toBe(true); // obstacles wear the piece's colour
    expect(seen.has("#222222")).toBe(true); // ground line uses the page's mute
    expect(seen.has("#FF4DA1")).toBe(false); // never falls back to raw pink
    // scale:2 is honoured instead of the ambient devicePixelRatio
    expect(canvas.width).toBe(1600);
    game.stop();
  });

  it("is losable: a player who never jumps crashes into the first obstacle", async () => {
    const { canvas } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const frames = Object.assign([fakeFrame(88, 96), fakeFrame(88, 96)], { cellPx: 4 });
    const game = startGame({ canvas, frames, palette: ["#ac3232"] });
    game.restart();
    for (let t = 16; t < 15_000 && game.getState() === "running"; t += 16) cb!(t);
    expect(game.getState()).toBe("over");
    expect(game.getScore()).toBeGreaterThan(0);
    // The run is banked as a high score, once storage has answered.
    await vi.waitFor(async () => {
      expect(await loadHighScore()).toBe(game.getScore());
    });
    game.stop();
  });

  it("stays winnable: an autopilot survives two minutes through the whole speed ramp", () => {
    const { canvas } = stubCanvas();
    let cb: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      cb = fn;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const frames = Object.assign([fakeFrame(88, 96), fakeFrame(88, 96)], { cellPx: 4 });
    const game = startGame({ canvas, frames, palette: ["#ac3232"] });
    game.restart();

    const step = 1000 / 60;
    for (let t = step; t < 120_000; t += step) {
      const snap = game.getSnapshot();
      if (snap.state !== "running") break;
      // Jump when the nearest obstacle ahead is about a jump-arc away.
      const me = snap.runnerRect;
      const ahead = snap.obstacles
        .filter((o) => o.x + o.w > me.x)
        .sort((a, b) => a.x - b.x)[0];
      if (ahead && snap.runner.grounded) {
        const gap = ahead.x - (me.x + me.w);
        if (gap < snap.spriteH * 1.4) {
          window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", cancelable: true }));
        }
      }
      cb!(t);
    }

    expect(game.getState()).toBe("running");
    expect(game.getScore()).toBeGreaterThan(1000);
    game.stop();
  });
});
