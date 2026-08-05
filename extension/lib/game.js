/**
 * unipegPFP extension — the offline runner.
 *
 * An endless runner drawn entirely from the user's own piece: the unicorn is
 * the piece's run frames, the obstacles are pixel Ethereum marks painted in the
 * piece's own colours, and the thing in the sky is a blacked-out Unipeg.
 * No network, no assets, no timers that depend on frame rate.
 *
 * The simulation is split so the interesting parts are pure and unit-tested:
 * `stepRunner`, `speedAt`, `scoreFromDistance`, `shrinkRect`, `rectsOverlap`,
 * `collides`, `spawnGap`, `flyerLanes` and `runnerBox` take numbers and return
 * numbers. `startGame` is the thin impure shell that owns the canvas, the input
 * and the loop.
 */

/**
 * Tuning. Distances are in *sprite heights* (H) so the game feels identical at
 * any zoom or DPI; startGame multiplies them by the real sprite height once.
 *
 * The jump is deliberately floaty rather than tall: apex v^2/2g = 1.33 H, hang
 * time 2v/g = 0.86 s. The apex is what has to fit inside a short board, and the
 * hang time is what carries the runner over a three-wide cluster — so the arc
 * is tuned by moving BOTH numbers, never just the velocity.
 */
export const DEFAULTS = {
  gravity: 14.5, // H per second squared
  jumpVelocity: 6.2, // H per second, upward — apex ~1.33 H, hang ~0.86 s
  baseSpeed: 4.2, // H per second
  maxSpeed: 10, // H per second
  accel: 0.22, // H per second, per second of survival
  hitboxShrink: 0.15, // forgiving: 15% off the runner's box
  scoreUnit: 0.5, // H of travel per point
  frameHz: 11, // run-cycle frames per second at base speed
  gapMin: 1.6, // seconds between obstacles, at the current speed
  gapMax: 2.8,
  gapFloor: 1.0, // never closer than this, however fast it gets
  coyoteTime: 0.08, // seconds of grace after leaving the ground
  duckRatio: 3 / 4, // duck sprite height / run sprite height (sprite.js: 3/4)
  duckGravity: 3.5, // gravity multiplier while ducking in mid-air (fast fall)
  flyerScore: 450, // no flyers before this score — Chrome's dino uses 450 too
  flyerChance: 0.32, // share of spawns that fly, once they are unlocked
  flyerSpeedMult: 1.05, // flyers close slightly faster than the ground scrolls
  flyerHz: 4, // wingbeats per second — deliberately slower than the gallop
  laneLow: 0.8, // H above the ground: must be ducked
  laneMid: 0.36, // must be jumped
  laneHigh: 1.1, // clears a standing runner — visibly, not by a hair
  laneMargin: 0.04, // H of slack held on every lane boundary
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
  if (y <= 0) return { y: 0, vy: 0, grounded: true, airTime: 0, jumped: false };
  return {
    y,
    vy,
    grounded: false,
    airTime: (runner.airTime || 0) + dt,
    jumped: Boolean(runner.jumped),
  };
}

/**
 * Start a jump, if the runner may. Returns a new runner object.
 *
 * There is NO double jump. Coyote time forgives a press a few milliseconds
 * after the ground drops away, but `jumped` records that this airtime began
 * with a jump, so the same window can never be spent twice.
 */
export function jump(runner, jumpVelocity, coyoteTime = 0) {
  const canJump = runner.grounded || (!runner.jumped && (runner.airTime || 0) <= coyoteTime);
  if (!canJump) return runner;
  return {
    y: Math.max(runner.y, 0.0001),
    vy: jumpVelocity,
    grounded: false,
    airTime: 0,
    jumped: true,
  };
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

/* ------------------------------------------------------- runner geometry */

/**
 * The runner's box in world pixels. Ducking swaps in the smaller sprite, which
 * is rendered at a smaller INTEGER scale (sprite.js) and stands on the same
 * ground line — so the hitbox shrinks exactly as much as the picture does.
 */
export function runnerBox({ x, groundY, spriteW, spriteH, duckW, duckH, y = 0, ducking = false }) {
  const w = ducking ? duckW : spriteW;
  const h = ducking ? duckH : spriteH;
  return { x, y: groundY - h - y, w, h };
}

/**
 * The highest the *shrunk* runner's feet ever get, in px above the ground.
 * Everything the flyer lanes decide is measured against this one number.
 */
export function jumpReach(spriteH, cfg = DEFAULTS) {
  const apex = ((cfg.jumpVelocity * cfg.jumpVelocity) / (2 * cfg.gravity)) * spriteH;
  return apex + (cfg.hitboxShrink / 2) * spriteH;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * The three heights a flyer can occupy, in px above the ground line, measured
 * to the BOTTOM of its sprite. Each one is a promise about the collision truth
 * table, so each is derived from the geometry rather than eyeballed:
 *
 *   low  — over a duck, into a stand, and too tall to jump over.
 *   mid  — into a duck as well as a stand, but a jump clears it.
 *   high — a standing runner walks under it; jumping into it still hurts.
 *
 * The tuned constants are only ever *preferences*: each lane is clamped into
 * the window its promise allows, given the real sprite heights handed in. If
 * the flyer art were ever too short for the low lane to be unjumpable, the
 * clamp keeps "a standing runner is hit" and gives up the other half — which
 * the unit tests would catch immediately.
 */
export function flyerLanes(spriteH, duckH, flyerH, cfg = DEFAULTS) {
  const shrink = cfg.hitboxShrink / 2;
  const standTop = spriteH * (1 - shrink); // top of the shrunk standing box
  const duckTop = duckH * (1 - shrink); // top of the shrunk crouched box
  const reach = jumpReach(spriteH, cfg);
  const m = cfg.laneMargin * spriteH;
  return {
    low: clamp(cfg.laneLow * spriteH, Math.max(duckTop + m, reach + m - flyerH), standTop - m),
    mid: clamp(cfg.laneMid * spriteH, 0, Math.min(duckTop - m, reach - m - flyerH)),
    high: Math.max(cfg.laneHigh * spriteH, standTop + m),
  };
}

export const FLYER_LANES = ["low", "mid", "high"];

/** Which lane the next flyer takes. Pure given `rand` in [0,1). */
export function pickLane(rand) {
  const i = Math.floor(rand * FLYER_LANES.length);
  return FLYER_LANES[Math.min(Math.max(i, 0), FLYER_LANES.length - 1)];
}

/** Flyers are held back until the run has earned them, exactly like the dino. */
export function mayFly(score, cfg = DEFAULTS) {
  return score >= cfg.flyerScore;
}

/** Pure spawn choice: is the next obstacle a flyer? */
export function spawnsFlyer(rand, score, cfg = DEFAULTS) {
  return mayFly(score, cfg) && rand < cfg.flyerChance;
}

/**
 * Seconds until the next spawn, at the current speed.
 *
 * The random span is in *seconds*, then eased by the square root of the
 * speed-up. A constant time gap would eventually be shorter than a jump arc
 * and the run would become unwinnable; a constant *spatial* gap would make the
 * game easier the faster it got. The square root splits the difference: the
 * distance between obstacles grows with sqrt(speed), so there is always more
 * runway than the jump needs, and never so much that the board looks empty.
 */
export function spawnGap(rand, speed, cfg = DEFAULTS) {
  const span = Math.max(0, cfg.gapMax - cfg.gapMin);
  const easing = Math.sqrt(cfg.baseSpeed / Math.max(speed, cfg.baseSpeed));
  const r = Math.min(Math.max(rand, 0), 1);
  return Math.max(cfg.gapFloor, (cfg.gapMin + r * span) * easing);
}

/* ------------------------------------------------------------- obstacles */

/**
 * THE OBSTACLES ARE ETHEREUM MARKS.
 *
 * The octahedron as pixel art: an upper triangle and a lower triangle split by
 * the mark's own chevron notch, each face divided down a centre seam into a
 * light facet (`L`), the seam (`M`) and a dark facet (`D`). `.` is empty.
 *
 * Both sizes were drawn on the cell grid and rendered to PNG at 4x and 8x to
 * check they still read as Ethereum at the size the game actually draws them.
 * They are painted at the runner's own integer cell scale, so a large mark is
 * about three quarters of the unicorn's height.
 */
export const ETH_SMALL_ROWS = [
  "...M...",
  "..LMD..",
  "..LMD..",
  ".LLMDD.",
  "LLLMDDD",
  ".LLMDD.",
  "L.....D",
  "LLLMDDD",
  ".LLMDD.",
  "..LMD..",
  "...M...",
];

export const ETH_LARGE_ROWS = [
  ".....M.....",
  "....LMD....",
  "....LMD....",
  "...LLMDD...",
  "..LLLMDDD..",
  "..LLLMDDD..",
  ".LLLLMDDDD.",
  "LLLLLMDDDDD",
  ".LLLLMDDDD.",
  "...LLMDD...",
  "LL.......DD",
  "LLLL...DDDD",
  "LLLLLMDDDDD",
  ".LLLLMDDDD.",
  "..LLLMDDD..",
  "...LLMDD...",
  "....LMD....",
  "....LMD....",
  ".....M.....",
];

/**
 * Compile rows into a shape: `paint` is one run per colour change (drawing),
 * `solid` is the same silhouette merged into as few rectangles as possible
 * (collision). Collision against the real silhouette rather than the bounding
 * box is what keeps a diamond fair — the corners of its box are empty air.
 *
 * Both are in integer cells, `y` counting DOWN from the top of the mark.
 */
export function shapeFromRows(rows) {
  const h = rows.length;
  const w = rows[0].length;
  const paint = [];
  const spans = [];
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < w; x++) {
      if (row[x] === ".") continue;
      let end = x + 1;
      while (end < w && row[end] === row[x]) end++;
      paint.push({ x, y, w: end - x, h: 1, facet: row[x] });
      x = end - 1;
    }
    for (let x = 0; x < w; x++) {
      if (row[x] === ".") continue;
      let end = x + 1;
      while (end < w && row[end] !== ".") end++;
      spans.push({ x, y, w: end - x });
      x = end - 1;
    }
  }
  // Merge identical spans in consecutive rows into taller rectangles.
  const solid = [];
  for (const s of spans) {
    const open = solid.find((r) => r.x === s.x && r.w === s.w && r.y + r.h === s.y);
    if (open) open.h += 1;
    else solid.push({ x: s.x, y: s.y, w: s.w, h: 1 });
  }
  return { w, h, rows, paint, solid };
}

/**
 * Two or three marks with one empty cell between them — the cluster the dino
 * game builds out of cacti. Tight enough to read as one obstacle, and cleared
 * with one jump.
 */
export function clusterShape(shape, count, gap = 1) {
  const n = Math.max(1, Math.round(count));
  if (n === 1) return shape;
  const pad = ".".repeat(Math.max(0, gap));
  return shapeFromRows(shape.rows.map((row) => new Array(n).fill(row).join(pad)));
}

export const ETH_SMALL = shapeFromRows(ETH_SMALL_ROWS);
export const ETH_LARGE = shapeFromRows(ETH_LARGE_ROWS);

/**
 * The spawn table. `minSpeed` is a multiple of the base speed, copying the
 * dino's rule that the widest groups only unlock once the world is moving fast
 * enough for one jump to carry across them. Every entry was checked against
 * the jump arc: time spent above the mark's height, times the scroll speed,
 * has to exceed the group's width plus the runner's own.
 */
export const OBSTACLE_SHAPES = [
  { shape: ETH_SMALL, minSpeed: 1 },
  { shape: ETH_LARGE, minSpeed: 1 },
  { shape: clusterShape(ETH_SMALL, 2), minSpeed: 1 },
  { shape: clusterShape(ETH_SMALL, 3), minSpeed: 1.15 },
  { shape: clusterShape(ETH_LARGE, 2), minSpeed: 1.3 },
  { shape: clusterShape(ETH_LARGE, 3), minSpeed: 1.6 },
];

const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v);

const PINK = "#FF4DA1";

/** Rough perceived luminance, 0..255. Only used to order facets. */
function luminance(hex) {
  const s = hex.replace("#", "");
  const v = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.slice(0, 6);
  const n = parseInt(v, 16);
  if (!Number.isFinite(n)) return 0;
  return 0.2126 * ((n >> 16) & 0xff) + 0.7152 * ((n >> 8) & 0xff) + 0.0722 * (n & 0xff);
}

/**
 * Three facet colours for one mark, sampled from the piece's own palette:
 * lightest colour on the left face, darkest on the right, the middle one on
 * the seam. `rand` rotates which three of the piece's colours get used, so a
 * seven-colour piece does not paint every mark identically. A piece with one
 * colour gets one flat mark — the silhouette is what has to read, and it does.
 */
export function facetColours(palette, rand = 0) {
  const cs = [...new Set((palette || []).filter(isHex))];
  if (!cs.length) return { L: PINK, M: PINK, D: PINK };
  const start = Math.floor(Math.min(Math.max(rand, 0), 0.999) * cs.length);
  const picked = [];
  for (let i = 0; i < Math.min(3, cs.length); i++) picked.push(cs[(start + i) % cs.length]);
  picked.sort((a, b) => luminance(a) - luminance(b));
  return {
    D: picked[0],
    M: picked[Math.floor((picked.length - 1) / 2)],
    L: picked[picked.length - 1],
  };
}

/** Pick a mark + its facet colours for the next obstacle. Pure given `rng`. */
export function pickObstacle(rng, palette, speedRatio = 1) {
  const usable = OBSTACLE_SHAPES.filter((o) => speedRatio >= o.minSpeed);
  const table = usable.length ? usable : [OBSTACLE_SHAPES[0]];
  const shape = table[Math.min(Math.floor(rng() * table.length), table.length - 1)].shape;
  return { shape, colours: facetColours(palette, rng()) };
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

/**
 * `palette` may be the piece's colours as a plain array (the shared contract's
 * minimum) or a theme object carrying them under `piece`/`colours` alongside
 * the page's own tokens. Accept both, so the game stays in palette with
 * whatever the page hands it.
 */
function pieceColours(palette) {
  const raw = Array.isArray(palette)
    ? palette
    : palette && typeof palette === "object"
      ? palette.piece || palette.colours || []
      : [];
  return (Array.isArray(raw) ? raw : []).filter(isHex);
}

function paletteTheme(palette) {
  const p = !Array.isArray(palette) && palette && typeof palette === "object" ? palette : {};
  return {
    ink: isHex(p.ink) ? p.ink : INK,
    mute: isHex(p.mute) ? p.mute : MUTE,
    accent: isHex(p.accent) ? p.accent : isHex(p.pink) ? p.pink : PINK,
  };
}

function prefersReducedMotion() {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const JUMP_CODES = new Set(["Space", "ArrowUp", "Enter", " ", "Up"]);
const DUCK_CODES = new Set(["ArrowDown", "Down"]);

/**
 * Boot the runner on `canvas`.
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {HTMLCanvasElement[]} opts.frames  run-cycle frames from buildRunFrames.
 *   The array also carries `.duck` and `.flyer` frame sets; pass them
 *   separately as `duckFrames` / `flyerFrames` to override.
 * @param {string[]|object} opts.palette     the piece's own colours — either a
 *   plain array, or a theme object with them under `piece`
 * @param {(score:number, meta:{high:number,state:string})=>void} [opts.onScore]
 * @param {number} [opts.scale]              device-pixel ratio the page sized
 *   the canvas and the sprite frames at; keeps the blit exactly 1:1
 * @param {boolean} [opts.reducedMotion]     overrides the media query
 */
export function startGame({
  canvas,
  frames,
  duckFrames,
  flyerFrames,
  palette,
  onScore,
  config,
  scale,
  reducedMotion,
} = {}) {
  if (!canvas) throw new Error("startGame needs a canvas");
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const sprite = frames && frames.length ? frames : null;
  const spriteH = sprite ? sprite[0].height : 96;
  const spriteW = sprite ? sprite[0].width : 96;
  const cellPx = Math.max(1, Math.round((frames && frames.cellPx) || spriteH / 24));

  // The crouch. Real duck frames are rendered at a smaller integer scale by
  // sprite.js; without them we blit the bottom slice of the standing frame,
  // which is still a 1:1 pixel copy — never a fractional squash.
  const duck = pickFrames(duckFrames, frames && frames.duck);
  const duckH = duck ? duck[0].height : Math.round(spriteH * cfg.duckRatio);
  const duckW = duck ? duck[0].width : spriteW;

  // The flyer: an all-black winged Unipeg, same source, smaller integer scale.
  const flyer = pickFrames(flyerFrames, frames && frames.flyer);
  const flyerH = flyer ? flyer[0].height : Math.round(spriteH * 0.78);
  const flyerW = flyer ? flyer[0].width : Math.round(spriteW * 0.78);
  const lanes = flyerLanes(spriteH, duckH, flyerH, cfg);

  // Obstacles are painted at the unicorn's own cell scale, so a mark is made of
  // exactly the same size pixels the art is.
  const obstacleUnit = cellPx;
  const found = pieceColours(palette);
  const colours = (found.length ? found : [PINK]).slice(0, 7);
  const theme = paletteTheme(palette);

  // Everything below is in device pixels, derived once from the sprite height.
  const gravity = cfg.gravity * spriteH;
  const jumpV = cfg.jumpVelocity * spriteH;
  const scoreUnit = cfg.scoreUnit * spriteH;

  const reduced = typeof reducedMotion === "boolean" ? reducedMotion : prefersReducedMotion();
  // The page tells us the ratio it built the sprite frames at; matching it here
  // is what keeps every sprite pixel landing on a whole device pixel.
  const ratio = Number.isFinite(scale) && scale > 0 ? scale : null;

  let width = 0;
  let height = 0;
  let groundY = 0;
  let runnerX = 0;

  let state = "ready"; // ready | running | over
  let runner = { y: 0, vy: 0, grounded: true, airTime: 0, jumped: false };
  let ducking = false;
  let obstacles = [];
  let elapsed = 0;
  let distance = 0;
  let nextGap = 0;
  let score = 0;
  let high = 0;
  let frameClock = 0;
  let frameIndex = 0;
  let flapClock = 0;
  let flapIndex = 0;
  let specks = [];
  let rng = makeRng((Date.now() & 0xffff) || 7);
  let rafId = 0;
  let last = 0;
  let stopped = false;

  let highLoaded = false;
  loadHighScore().then((v) => {
    high = Math.max(high, v);
    highLoaded = true;
    emit();
  });

  function pickFrames(explicit, attached) {
    const set = explicit && explicit.length ? explicit : attached;
    return set && set.length ? set : null;
  }

  function emit() {
    if (typeof onScore === "function") onScore(score, { high, state });
  }

  function resize() {
    const dpr = ratio || Math.min(Math.max(globalThis.devicePixelRatio || 1, 1), 3);
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
    runner = { y: 0, vy: 0, grounded: true, airTime: 0, jumped: false };
    obstacles = [];
    elapsed = 0;
    distance = 0;
    score = 0;
    frameClock = 0;
    frameIndex = 0;
    flapClock = 0;
    flapIndex = 0;
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

  function setDuck(down) {
    if (stopped) return;
    ducking = Boolean(down);
  }

  function spawn() {
    const speed = speedAt(elapsed, cfg);
    if (spawnsFlyer(rng(), score, cfg)) {
      const lane = pickLane(rng());
      obstacles.push({
        kind: "flyer",
        lane,
        x: width + obstacleUnit,
        y: Math.round(groundY - lanes[lane] - flyerH),
        w: flyerW,
        h: flyerH,
        speed: cfg.flyerSpeedMult,
      });
      return;
    }
    const { shape, colours: facets } = pickObstacle(rng, colours, speed / cfg.baseSpeed);
    obstacles.push({
      kind: "eth",
      x: width + obstacleUnit,
      shape,
      facets,
      w: shape.w * obstacleUnit,
      h: shape.h * obstacleUnit,
      y: groundY - shape.h * obstacleUnit,
      speed: 1,
    });
  }

  async function gameOver() {
    state = "over";
    emit();
    // A very short first run can end before storage has answered; banking the
    // score without waiting would overwrite a real best with a worse one.
    if (!highLoaded) {
      high = Math.max(high, await loadHighScore());
      highLoaded = true;
    }
    if (score > high) {
      high = score;
      await saveHighScore(high);
    }
    emit();
  }

  /** Every solid rectangle of one obstacle, in world pixels. */
  function obstacleRects(o) {
    if (o.kind === "flyer") return [{ x: o.x, y: o.y, w: o.w, h: o.h }];
    return o.shape.solid.map((r) => ({
      x: o.x + r.x * obstacleUnit,
      y: o.y + r.y * obstacleUnit,
      w: r.w * obstacleUnit,
      h: r.h * obstacleUnit,
    }));
  }

  function update(dt) {
    if (state !== "running") return;
    elapsed += dt;
    const speed = speedAt(elapsed, cfg) * spriteH;
    distance += speed * dt;

    // Ducking in mid-air is a fast fall, exactly as the dino does it.
    const g = ducking && !runner.grounded ? gravity * cfg.duckGravity : gravity;
    runner = stepRunner(runner, dt, g);

    // Obstacles.
    nextGap -= dt;
    if (nextGap <= 0) {
      spawn();
      nextGap = spawnGap(rng(), speedAt(elapsed, cfg), cfg);
    }
    for (const o of obstacles) o.x -= speed * o.speed * dt;
    obstacles = obstacles.filter((o) => o.x + o.w > -obstacleUnit);

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
    // Wingbeat — a fixed, slower cadence, so the flyer never looks like it is
    // galloping through the air.
    if (flyer && flyer.length > 1) {
      flapClock += dt * cfg.flyerHz;
      flapIndex = Math.floor(flapClock) % flyer.length;
    }

    // Parallax ground specks.
    if (!reduced) {
      for (const s of specks) {
        s.x -= speed * s.depth * dt;
        if (s.x + s.w < 0) s.x += width + s.w;
      }
    }

    // Collision, against each obstacle's real silhouette.
    const box = runnerRect();
    for (const o of obstacles) {
      if (o.x > box.x + box.w || o.x + o.w < box.x) continue;
      for (const r of obstacleRects(o)) {
        if (collides(box, r, cfg.hitboxShrink)) {
          gameOver();
          return;
        }
      }
    }
  }

  function runnerRect() {
    return runnerBox({
      x: runnerX,
      groundY,
      spriteW,
      spriteH,
      duckW,
      duckH,
      y: runner.y,
      ducking,
    });
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;

    // Ground line + specks.
    ctx.fillStyle = theme.mute;
    ctx.globalAlpha = 0.45;
    ctx.fillRect(0, groundY, width, Math.max(1, Math.round(cellPx / 2)));
    for (const s of specks) {
      ctx.fillRect(Math.round(s.x), Math.round(s.y), Math.round(s.w), Math.max(1, Math.round(cellPx / 2)));
    }
    ctx.globalAlpha = 1;

    for (const o of obstacles) {
      if (o.kind === "flyer") drawFlyer(o);
      else drawMark(o);
    }

    drawRunner();

    if (state === "over") drawBanner("CRASHED — PRESS SPACE TO RUN AGAIN");
    else if (state === "ready") drawBanner("SPACE OR TAP TO RUN · ↓ TO DUCK");
  }

  /** One Ethereum mark, in the piece's own colours. */
  function drawMark(o) {
    const x0 = Math.round(o.x);
    for (const r of o.shape.paint) {
      ctx.fillStyle = o.facets[r.facet] || o.facets.L;
      ctx.fillRect(
        x0 + r.x * obstacleUnit,
        o.y + r.y * obstacleUnit,
        r.w * obstacleUnit,
        r.h * obstacleUnit,
      );
    }
  }

  function drawFlyer(o) {
    const x = Math.round(o.x);
    if (flyer) {
      ctx.drawImage(flyer[Math.min(flapIndex, flyer.length - 1)], x, Math.round(o.y));
      return;
    }
    ctx.fillStyle = theme.ink;
    ctx.fillRect(x, Math.round(o.y), o.w, o.h);
  }

  function drawRunner() {
    const idle = state !== "running";
    const idx = idle && reduced ? 0 : frameIndex;
    const box = runnerRect();
    const x = Math.round(box.x);
    const y = Math.round(box.y);
    if (ducking && duck) {
      ctx.drawImage(duck[Math.min(idx, duck.length - 1)], x, y);
      return;
    }
    if (!sprite) {
      ctx.fillStyle = theme.accent;
      ctx.fillRect(x, y, box.w, box.h);
      return;
    }
    const frame = sprite[Math.min(idx, sprite.length - 1)];
    if (ducking) {
      // Fallback crouch: the bottom `duckH` rows of the standing frame, blitted
      // 1:1. Not as good as real duck frames, but not a single resampled pixel.
      ctx.drawImage(frame, 0, spriteH - duckH, spriteW, duckH, x, y, spriteW, duckH);
      return;
    }
    ctx.drawImage(frame, x, y);
  }

  function drawBanner(text) {
    const size = Math.max(11, Math.round(cellPx * 2.4));
    ctx.font = `700 ${size}px "Space Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = state === "over" ? theme.accent : theme.mute;
    ctx.fillText(text, Math.round(width / 2), Math.round(groundY - spriteH * 1.6));
    if (state === "over") {
      ctx.fillStyle = theme.ink;
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
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    const code = e.code || e.key;
    if (JUMP_CODES.has(code)) {
      // preventDefault before the repeat check: a held Space must never scroll
      // the page, even though only the first press jumps.
      e.preventDefault();
      if (e.repeat) return;
      press();
    } else if (DUCK_CODES.has(code)) {
      e.preventDefault();
      if (e.repeat) return;
      setDuck(true);
    }
  }

  function onKeyUp(e) {
    const code = e.code || e.key;
    if (!DUCK_CODES.has(code)) return;
    if (e.cancelable) e.preventDefault();
    setDuck(false);
  }

  /** A key-up that never arrives (tab switch, alt-tab) must not stick. */
  function onBlur() {
    setDuck(false);
  }

  function pointerIsDuck(e) {
    // Touch has no arrow keys, and the low flyer has to be duckable on a phone:
    // the bottom strip of the board is a duck pad, the rest jumps.
    const rect = typeof canvas.getBoundingClientRect === "function" ? canvas.getBoundingClientRect() : null;
    if (!rect || !rect.height || !Number.isFinite(e.clientY)) return false;
    return e.clientY - rect.top > rect.height * 0.66;
  }

  function onPointerDown(e) {
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    if (canvas.focus) canvas.focus();
    if (state === "running" && pointerIsDuck(e)) setDuck(true);
    else press();
  }

  function onPointerUp() {
    setDuck(false);
  }

  function onResize() {
    resize();
  }

  // Keyboard reachable and announced.
  if (!canvas.hasAttribute("tabindex")) canvas.setAttribute("tabindex", "0");
  canvas.setAttribute("role", "application");
  canvas.setAttribute(
    "aria-label",
    "Unipeg runner game. Press Space or Arrow Up to jump, hold Arrow Down to duck. " +
      "Press Space to start or restart.",
  );

  addEventListener("keydown", onKeyDown, { passive: false });
  addEventListener("keyup", onKeyUp, { passive: false });
  addEventListener("blur", onBlur);
  canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
  addEventListener("pointerup", onPointerUp);
  addEventListener("pointercancel", onPointerUp);
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
      removeEventListener("keyup", onKeyUp);
      removeEventListener("blur", onBlur);
      removeEventListener("pointerup", onPointerUp);
      removeEventListener("pointercancel", onPointerUp);
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
        duckH,
        duckW,
        flyerH,
        flyerW,
        lanes: { ...lanes },
        ducking,
        runner: { ...runner },
        runnerRect: runnerRect(),
        obstacles: obstacles.map((o) => ({
          kind: o.kind,
          lane: o.lane || null,
          x: o.x,
          y: o.y,
          w: o.w,
          h: o.h,
          rects: obstacleRects(o),
        })),
      };
    },
  };
}
