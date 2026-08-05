/**
 * unipegPFP extension — the offline runner.
 *
 * An endless runner drawn entirely from the user's own piece: the unicorn is
 * the piece's run frames, the obstacles are painted in the piece's own colours.
 * No network, no assets, no timers that depend on frame rate.
 *
 * The simulation is split so the interesting parts are pure and unit-tested:
 * `stepRunner`, `speedAt`, `scoreFromDistance`, `shrinkRect`, `rectsOverlap`
 * and `collides` take numbers and return numbers. `startGame` is the thin
 * impure shell that owns the canvas, the input and the loop.
 */

/**
 * Tuning. Distances are in *sprite heights* (H) so the game feels identical at
 * any zoom or DPI; startGame multiplies them by the real sprite height once.
 */
export const DEFAULTS = {
  gravity: 27, // H per second squared
  jumpVelocity: 8.4, // H per second, upward — apex ~1.3 H, hang ~0.62 s
  baseSpeed: 4.2, // H per second
  maxSpeed: 10, // H per second
  accel: 0.22, // H per second, per second of survival
  hitboxShrink: 0.15, // forgiving: 15% off the runner's box
  scoreUnit: 0.5, // H of travel per point
  frameHz: 11, // run-cycle frames per second at base speed
  gapMin: 1.6, // seconds between obstacles, at the current speed
  gapMax: 2.9,
  coyoteTime: 0.08, // seconds of grace after leaving the ground
};

export const HIGH_SCORE_KEY = "upegpfp.highScore";

/* ---------------------------------------------------------------- pure core */

/**
 * One physics step for the runner.
 * `runner.y` is height above the ground line (px, up positive);
 * `runner.vy` is vertical velocity (px/s, up positive).
 * Returns a new runner object — never mutates.
 *
 * Uses the closed-form constant-acceleration update (velocity Verlet) rather
 * than plain Euler: gravity is constant, so this is *exact* at every sample and
 * the jump arc is identical on a 30 Hz and a 240 Hz display. Euler here makes
 * the apex ~9% lower at 30fps, which is the difference between clearing an
 * obstacle and not.
 */
export function stepRunner(runner, dt, gravity) {
  if (!(dt > 0)) return { ...runner };
  const vy = runner.vy - gravity * dt;
  let y = runner.y + runner.vy * dt - 0.5 * gravity * dt * dt;
  if (y <= 0) return { y: 0, vy: 0, grounded: true, airTime: 0 };
  return {
    y,
    vy,
    grounded: false,
    airTime: (runner.airTime || 0) + dt,
  };
}

/** Start a jump, if the runner may. Returns a new runner object. */
export function jump(runner, jumpVelocity, coyoteTime = 0) {
  const canJump = runner.grounded || (runner.airTime || 0) <= coyoteTime;
  if (!canJump) return runner;
  return { y: Math.max(runner.y, 0.0001), vy: jumpVelocity, grounded: false, airTime: 0 };
}

/** Scroll speed after `elapsed` seconds: ramps linearly, then holds at max. */
export function speedAt(elapsed, cfg = DEFAULTS) {
  const t = Math.max(0, elapsed);
  return Math.min(cfg.maxSpeed, cfg.baseSpeed + t * cfg.accel);
}

/** Score is pure distance — monotonic by construction. */
export function scoreFromDistance(distance, unit) {
  if (!(unit > 0)) return 0;
  return Math.max(0, Math.floor(distance / unit));
}

/** Shrink a rect about its centre by `factor` (0.15 = 15% smaller each axis). */
export function shrinkRect(rect, factor) {
  const f = Math.min(Math.max(factor, 0), 0.9);
  const dw = rect.w * f;
  const dh = rect.h * f;
  return {
    x: rect.x + dw / 2,
    y: rect.y + dh / 2,
    w: rect.w - dw,
    h: rect.h - dh,
  };
}

/** Axis-aligned overlap. Touching edges do not count as a hit. */
export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Forgiving collision: the runner's box is shrunk before the test. */
export function collides(runner, obstacle, shrink = DEFAULTS.hitboxShrink) {
  return rectsOverlap(shrinkRect(runner, shrink), obstacle);
}

/** Small deterministic RNG so obstacle layout is testable. */
export function makeRng(seed = 1) {
  let a = seed >>> 0 || 1;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Obstacle shapes, in integer cells. Each is a list of [x, y, w, h] runs
 * measured from the obstacle's bottom-left, y counting up.
 */
export const OBSTACLE_SHAPES = [
  // small block
  { w: 1, h: 2, cells: [[0, 0, 1, 2]] },
  // tall block
  { w: 1, h: 3, cells: [[0, 0, 1, 3]] },
  // cactus-ish: trunk with one arm
  { w: 3, h: 3, cells: [[1, 0, 1, 3], [0, 1, 1, 1], [2, 2, 1, 1]] },
  // spike
  { w: 3, h: 2, cells: [[0, 0, 3, 1], [1, 1, 1, 1]] },
  // twin spikes
  { w: 5, h: 2, cells: [[0, 0, 2, 1], [0, 1, 1, 1], [3, 0, 2, 1], [4, 1, 1, 1]] },
  // wide low wall
  { w: 4, h: 2, cells: [[0, 0, 4, 1], [0, 1, 1, 1], [3, 1, 1, 1]] },
];

/** Pick a shape + colour for the next obstacle. Pure given `rng`. */
export function pickObstacle(rng, palette) {
  const shape = OBSTACLE_SHAPES[Math.floor(rng() * OBSTACLE_SHAPES.length) % OBSTACLE_SHAPES.length];
  const colours = palette && palette.length ? palette : ["#FF4DA1"];
  const colour = colours[Math.floor(rng() * colours.length) % colours.length];
  return { shape, colour };
}

/* ------------------------------------------------------- persistence shim */

function storageArea() {
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      return chrome.storage.local;
    }
  } catch {
    /* not an extension page */
  }
  return null;
}

/** Read the stored high score. Works on a plain page (localStorage) too. */
export async function loadHighScore() {
  const area = storageArea();
  if (area) {
    try {
      const got = await area.get(HIGH_SCORE_KEY);
      const v = got && got[HIGH_SCORE_KEY];
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  }
  try {
    if (typeof localStorage !== "undefined") {
      return Number(localStorage.getItem(HIGH_SCORE_KEY)) || 0;
    }
  } catch {
    /* storage blocked */
  }
  return 0;
}

/** Persist a new high score. Never throws. */
export async function saveHighScore(score) {
  const area = storageArea();
  if (area) {
    try {
      await area.set({ [HIGH_SCORE_KEY]: score });
    } catch {
      /* quota / context gone */
    }
    return;
  }
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(HIGH_SCORE_KEY, String(score));
    }
  } catch {
    /* storage blocked */
  }
}

/* --------------------------------------------------------------- the game */

const INK = "#F7F7F8";
const MUTE = "#9C9CA6";
const PINK = "#FF4DA1";

function prefersReducedMotion() {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Boot the runner on `canvas`.
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {HTMLCanvasElement[]} opts.frames  run-cycle frames from buildRunFrames
 * @param {string[]} opts.palette            the piece's own colours
 * @param {(score:number, meta:{high:number,state:string})=>void} [opts.onScore]
 */
export function startGame({ canvas, frames, palette, onScore, config } = {}) {
  if (!canvas) throw new Error("startGame needs a canvas");
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const sprite = frames && frames.length ? frames : null;
  const spriteH = sprite ? sprite[0].height : 96;
  const spriteW = sprite ? sprite[0].width : 96;
  const cellPx = Math.max(1, Math.round((frames && frames.cellPx) || spriteH / 24));
  const colours = (palette && palette.length ? palette : [PINK]).slice(0, 6);

  // Everything below is in device pixels, derived once from the sprite height.
  const gravity = cfg.gravity * spriteH;
  const jumpV = cfg.jumpVelocity * spriteH;
  const scoreUnit = cfg.scoreUnit * spriteH;

  const reduced = prefersReducedMotion();

  let width = 0;
  let height = 0;
  let groundY = 0;
  let runnerX = 0;

  let state = "ready"; // ready | running | over
  let runner = { y: 0, vy: 0, grounded: true, airTime: 0 };
  let obstacles = [];
  let elapsed = 0;
  let distance = 0;
  let nextGap = 0;
  let score = 0;
  let high = 0;
  let frameClock = 0;
  let frameIndex = 0;
  let specks = [];
  let rng = makeRng((Date.now() & 0xffff) || 7);
  let rafId = 0;
  let last = 0;
  let stopped = false;

  loadHighScore().then((v) => {
    high = v;
    emit();
  });

  function emit() {
    if (typeof onScore === "function") onScore(score, { high, state });
  }

  function resize() {
    const dpr = Math.min(Math.max(globalThis.devicePixelRatio || 1, 1), 3);
    const cssW = canvas.clientWidth || canvas.width || 640;
    const cssH = canvas.clientHeight || canvas.height || 220;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (w !== canvas.width || h !== canvas.height) {
      canvas.width = w;
      canvas.height = h;
      ctx.imageSmoothingEnabled = false;
    }
    width = canvas.width;
    height = canvas.height;
    groundY = Math.round(height - Math.max(cellPx * 2, height * 0.14));
    runnerX = Math.round(Math.max(cellPx * 3, width * 0.12));
    specks = buildSpecks();
  }

  function buildSpecks() {
    if (reduced) return [];
    const out = [];
    const count = Math.max(6, Math.round(width / (cellPx * 14)));
    const r = makeRng(99);
    for (let i = 0; i < count; i++) {
      out.push({
        x: r() * width,
        y: groundY + cellPx * (1 + Math.floor(r() * 3)),
        w: cellPx * (1 + Math.floor(r() * 2)),
        depth: 0.35 + r() * 0.35,
      });
    }
    return out;
  }

  function reset() {
    state = "ready";
    runner = { y: 0, vy: 0, grounded: true, airTime: 0 };
    obstacles = [];
    elapsed = 0;
    distance = 0;
    score = 0;
    frameClock = 0;
    frameIndex = 0;
    rng = makeRng((Date.now() & 0xffff) || 7);
    nextGap = cfg.gapMin;
    emit();
  }

  function begin() {
    reset();
    state = "running";
    emit();
  }

  function press() {
    if (stopped) return;
    if (state === "ready") return begin();
    if (state === "over") return begin();
    runner = jump(runner, jumpV, cfg.coyoteTime);
  }

  function spawn() {
    const { shape, colour } = pickObstacle(rng, colours);
    obstacles.push({
      x: width + cellPx * 2,
      shape,
      colour,
      w: shape.w * cellPx,
      h: shape.h * cellPx,
      scored: false,
    });
  }

  function gameOver() {
    state = "over";
    if (score > high) {
      high = score;
      saveHighScore(high);
    }
    emit();
  }

  function update(dt) {
    if (state !== "running") return;
    elapsed += dt;
    const speed = speedAt(elapsed, cfg) * spriteH;
    distance += speed * dt;

    runner = stepRunner(runner, dt, gravity);

    // Obstacles.
    nextGap -= dt;
    if (nextGap <= 0) {
      spawn();
      const span = cfg.gapMax - cfg.gapMin;
      // Close the gaps as the world speeds up, but only by the square root of
      // the speedup — a constant *spatial* gap would eventually be shorter than
      // a jump arc and the run would become unwinnable.
      const easing = Math.sqrt(cfg.baseSpeed / speedAt(elapsed, cfg));
      nextGap = Math.max(0.9, (cfg.gapMin + rng() * span) * easing);
    }
    for (const o of obstacles) o.x -= speed * dt;
    obstacles = obstacles.filter((o) => o.x + o.w > -cellPx * 2);

    // Score.
    const next = scoreFromDistance(distance, scoreUnit);
    if (next !== score) {
      score = next;
      emit();
    }

    // Run cycle — faster legs as the world speeds up.
    if (sprite && sprite.length > 1) {
      frameClock += dt * cfg.frameHz * (speed / (cfg.baseSpeed * spriteH));
      frameIndex = Math.floor(frameClock) % sprite.length;
    }

    // Parallax ground specks.
    if (!reduced) {
      for (const s of specks) {
        s.x -= speed * s.depth * dt;
        if (s.x + s.w < 0) s.x += width + s.w;
      }
    }

    // Collision.
    const box = runnerRect();
    for (const o of obstacles) {
      if (collides(box, { x: o.x, y: groundY - o.h, w: o.w, h: o.h }, cfg.hitboxShrink)) {
        gameOver();
        break;
      }
    }
  }

  function runnerRect() {
    return {
      x: runnerX,
      y: groundY - spriteH - runner.y,
      w: spriteW,
      h: spriteH,
    };
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;

    // Ground line + specks.
    ctx.fillStyle = MUTE;
    ctx.globalAlpha = 0.45;
    ctx.fillRect(0, groundY, width, Math.max(1, Math.round(cellPx / 2)));
    for (const s of specks) {
      ctx.fillRect(Math.round(s.x), Math.round(s.y), Math.round(s.w), Math.max(1, Math.round(cellPx / 2)));
    }
    ctx.globalAlpha = 1;

    // Obstacles, in the piece's own colours.
    for (const o of obstacles) {
      ctx.fillStyle = o.colour;
      for (const [cx, cy, cw, ch] of o.shape.cells) {
        ctx.fillRect(
          Math.round(o.x) + cx * cellPx,
          groundY - (cy + ch) * cellPx,
          cw * cellPx,
          ch * cellPx,
        );
      }
    }

    // The unicorn.
    const idle = state !== "running";
    const idx = idle && reduced ? 0 : frameIndex;
    const y = Math.round(groundY - spriteH - runner.y);
    if (sprite) {
      ctx.drawImage(sprite[Math.min(idx, sprite.length - 1)], Math.round(runnerX), y);
    } else {
      ctx.fillStyle = PINK;
      ctx.fillRect(Math.round(runnerX), y, spriteW, spriteH);
    }

    if (state === "over") drawBanner("CRASHED — PRESS SPACE TO RUN AGAIN");
    else if (state === "ready") drawBanner("PRESS SPACE OR TAP TO RUN");
  }

  function drawBanner(text) {
    const size = Math.max(11, Math.round(cellPx * 2.4));
    ctx.font = `700 ${size}px "Space Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = state === "over" ? PINK : MUTE;
    ctx.fillText(text, Math.round(width / 2), Math.round(groundY - spriteH * 1.6));
    if (state === "over") {
      ctx.fillStyle = INK;
      ctx.font = `400 ${Math.max(10, Math.round(size * 0.8))}px "Space Mono", ui-monospace, monospace`;
      ctx.fillText(
        `SCORE ${score} · BEST ${Math.max(high, score)}`,
        Math.round(width / 2),
        Math.round(groundY - spriteH * 1.6 + size * 1.6),
      );
    }
  }

  function tick(now) {
    if (stopped) return;
    if (!last) last = now;
    // Clamp: a backgrounded tab must not teleport the runner into an obstacle.
    const dt = Math.min((now - last) / 1000, 1 / 20);
    last = now;
    update(dt);
    draw();
    rafId = requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------ input */

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
  }

  function onKeyDown(e) {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (e.code === "Space" || e.code === "ArrowUp" || e.key === " " || e.key === "ArrowUp" || e.key === "Enter") {
      e.preventDefault();
      press();
    }
  }

  function onPointerDown(e) {
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    if (canvas.focus) canvas.focus();
    press();
  }

  function onResize() {
    resize();
  }

  // Keyboard reachable and announced.
  if (!canvas.hasAttribute("tabindex")) canvas.setAttribute("tabindex", "0");
  canvas.setAttribute("role", "application");
  canvas.setAttribute(
    "aria-label",
    "Unipeg runner game. Press Space or Arrow Up to jump. Press Space to start or restart.",
  );

  addEventListener("keydown", onKeyDown, { passive: false });
  canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
  let resizeObserver = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(canvas);
  } else {
    addEventListener("resize", onResize);
  }

  resize();
  reset();
  rafId = requestAnimationFrame(tick);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(rafId);
      removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("pointerdown", onPointerDown);
      if (resizeObserver) resizeObserver.disconnect();
      else removeEventListener("resize", onResize);
    },
    restart() {
      begin();
    },
    getScore() {
      return score;
    },
    getState() {
      return state;
    },
    /** Read-only introspection: used by the tests to autopilot a run. */
    getSnapshot() {
      return {
        state,
        score,
        high,
        elapsed,
        groundY,
        spriteH,
        spriteW,
        runner: { ...runner },
        runnerRect: runnerRect(),
        obstacles: obstacles.map((o) => ({ x: o.x, w: o.w, h: o.h })),
      };
    },
  };
}
