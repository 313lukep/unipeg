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
 * `collides`, `spawnGap`, `flyerLanes`, `runnerBox`, the jump arc (`jumpReach`,
 * `jumpArc`, `jumpGroups`), the spawn table (`patternIsClearable`,
 * `pickPattern`, `patternGap`) and the contrast pass (`readable`,
 * `readableFacets`) all take numbers and return numbers. `startGame` is the
 * thin impure shell that owns the canvas, the input and the loop.
 */

/**
 * Tuning. Distances are in *sprite heights* (H) so the game feels identical at
 * any zoom or DPI; startGame multiplies them by the real sprite height once.
 *
 * The jump is deliberately floaty rather than tall: apex v^2/2g = 1.33 H, hang
 * time 2v/g = 0.86 s. The apex is what has to fit inside a short board, and the
 * hang time is what carries the runner over a three-wide cluster — so the arc
 * is tuned by moving BOTH numbers, never just the velocity.
 *
 * THE RAMP — why it opens this slowly.
 *
 * The board is roughly 8 H wide, the runner stands 12% in from the left and is
 * about 1 H wide itself, so a mark spawning at the right edge has ~6 H of clear
 * board to cross before it reaches the runner's nose:
 *
 *   base 2.8 H/s  ->  ~2.0 s of reaction time on the very first obstacle
 *   (the old 4.2 gave ~1.5 s, which is where "too fast too early" came from —
 *    measured on the real board, not modelled: see the autopilot test)
 *
 * At 0.10 H/s per second of survival the ramp is a slope you notice but never
 * trip over: the old opening speed arrives at t = 14 s, twenty seconds in it is
 * still only 4.8 H/s (~150 points, a warm-up), and the 10 H/s cap is 72 seconds
 * of clean running away — a long run, not an opening. Everything downstream is
 * derived from these two numbers rather than pinned to them: obstacle patterns
 * unlock on speed, the gap between spawns eases with sqrt(speed), and both are
 * re-checked against the real jump arc before anything is allowed to spawn.
 */
export const DEFAULTS = {
  gravity: 14.5, // H per second squared
  jumpVelocity: 6.2, // H per second, upward — apex ~1.33 H, hang ~0.86 s
  baseSpeed: 2.8, // H per second — a calm walk-on, see THE RAMP above
  maxSpeed: 10, // H per second — reached at t = 72 s, not before
  accel: 0.1, // H per second, per second of survival
  hitboxShrink: 0.15, // forgiving: 15% off the runner's box
  clearMargin: 1.25, // a group must fit the jump arc with 25% to spare
  scoreUnit: 0.5, // H of travel per point
  frameHz: 11, // run-cycle frames per second at base speed
  gapMin: 1.6, // seconds between obstacles, at the current speed
  gapMax: 2.8,
  gapFloor: 1.25, // never closer than this, however fast it gets
  coyoteTime: 0.08, // seconds of grace after leaving the ground
  duckDrop: 4, // cells the crouch folds down by (sprite.js DUCK_DROP)
  duckGravity: 3.5, // gravity multiplier while ducking in mid-air (fast fall)
  flyerScore: 450, // no flyers before this score — Chrome's dino uses 450 too
  flyerChance: 0.32, // share of spawns that fly, once they are unlocked
  flyerSpeedMult: 1.05, // flyers close slightly faster than the ground scrolls
  flyerHz: 4, // wingbeats per second — deliberately slower than the gallop
  laneLow: 0.66, // H above the ground: must be ducked — sits low, skimming the head
  laneMid: 0.36, // must be jumped
  laneHigh: 1.1, // clears a standing runner — visibly, not by a hair
  laneMargin: 0.04, // H of slack held on every lane boundary
  facetContrast: 2, // minimum contrast an obstacle holds against the board
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
 * The runner's box in world pixels. Ducking swaps in the crouched sprite, whose
 * head, neck and wing tips have been folded down a whole number of cells by
 * sprite.js — same scale, same feet, same ground line, `duckDrop` cells
 * shorter. The hitbox is measured from those folded cells, so the box is
 * exactly the picture: a duck is genuinely lower, never merely smaller.
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

/**
 * The jump arc, as the three numbers every spawn decision is made from.
 *
 * `hang(t)`   — seconds in the air, takeoff to landing.
 * `window(h)` — seconds the shrunk hitbox spends ABOVE something `h` px tall.
 *               Zero when `h` is at or past `jumpReach`, which is the same
 *               statement as "this cannot be jumped at all".
 * `rise(h)`   — seconds from takeoff until the hitbox first clears `h` px.
 *               How much runway a jump has to be started with.
 *
 * Multiply a window by the scroll speed and you get the ground covered while
 * airborne — the only quantity that decides whether an obstacle group is
 * clearable, and the reason wide groups have to wait for a fast world.
 */
export function jumpArc(spriteH, cfg = DEFAULTS) {
  const v0 = cfg.jumpVelocity * spriteH;
  const g = cfg.gravity * spriteH;
  const reach = jumpReach(spriteH, cfg);
  const root = (height) => {
    if (height >= reach) return 0;
    const need = Math.max(0, height - (cfg.hitboxShrink / 2) * spriteH);
    return Math.sqrt(Math.max(0, v0 * v0 - 2 * g * need));
  };
  return {
    hang: (2 * v0) / g,
    reach,
    window: (height) => (2 * root(height)) / g,
    rise: (height) => (height >= reach ? Infinity : (v0 - root(height)) / g),
  };
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

/**
 * The same mark drawn narrow and tall: the small mark's own width, stretched
 * along the axis it is already stretched on. It reads as a spire rather than a
 * second size of diamond, and because the jump clears 1.4 H it is a *timing*
 * obstacle, not a wall — the thing you jump slightly later than you expect.
 */
export const ETH_TALL_ROWS = [
  "...M...",
  "..LMD..",
  "..LMD..",
  "..LMD..",
  ".LLMDD.",
  ".LLMDD.",
  "LLLMDDD",
  ".LLMDD.",
  ".LLMDD.",
  "L.....D",
  "LLLMDDD",
  ".LLMDD.",
  ".LLMDD.",
  "..LMD..",
  "..LMD..",
  "..LMD..",
  "...M...",
];

export const ETH_SMALL = shapeFromRows(ETH_SMALL_ROWS);
export const ETH_LARGE = shapeFromRows(ETH_LARGE_ROWS);
export const ETH_TALL = shapeFromRows(ETH_TALL_ROWS);

/* --------------------------------------------------------- spawn patterns */

/**
 * THE PATTERN SET.
 *
 * One mark, over and over, at a metronome's spacing, is the thing that made the
 * old board boring. A spawn is now a *pattern*: one or more marks with a shape,
 * an offset, and a say in how long the pause after it is.
 *
 *   at    — cells from the pattern's own origin. Fixed geometry: parts an `at`
 *           apart are one obstacle to be jumped in one arc, at every speed.
 *   after — SECONDS from the pattern's origin. Elastic geometry: the second
 *           mark is always the same amount of *time* behind the first, so a
 *           pattern meant to be two separate decisions stays two separate
 *           decisions at 2.8 H/s and at 10 H/s alike.
 *   gapAfter — multiplies the pause that follows. The breather is nothing but
 *           a small mark with a long silence behind it, and that silence is
 *           what makes the busy patterns feel busy.
 *
 * `minRatio` (a multiple of the base speed) is a *pacing* preference — it is
 * what keeps the opening to easy singles. It is NOT the safety rule: every
 * pattern is re-checked against the real jump arc and the real sprite before it
 * is allowed to spawn (`patternIsClearable`), because a short piece jumps lower
 * than a tall one while the marks stay the same size.
 */
export const SPAWN_PATTERNS = [
  // Openers — one decision, plenty of air.
  { name: "small", minRatio: 1, gapAfter: 1, weight: [6, 2], parts: [{ shape: ETH_SMALL, at: 0 }] },
  { name: "tall", minRatio: 1, gapAfter: 1, weight: [3, 2], parts: [{ shape: ETH_TALL, at: 0 }] },
  { name: "breather", minRatio: 1, gapAfter: 1.9, weight: [3, 1.5], parts: [{ shape: ETH_SMALL, at: 0 }] },
  // Two decisions in quick succession: land, then go again.
  {
    name: "one-two",
    minRatio: 1,
    gapAfter: 1.15,
    weight: [3, 3.5],
    parts: [
      { shape: ETH_SMALL, at: 0 },
      { shape: ETH_SMALL, at: 0, after: 1.4 },
    ],
  },
  // One decision, wider — the cluster the dino builds out of cacti.
  {
    // Three beats with landing room — jump, land, jump, land, jump. The owner
    // asked for this over parked stacks: each mark is its own decision.
    name: "three-beat",
    minRatio: 1.05,
    gapAfter: 1.2,
    weight: [2, 3.5],
    parts: [
      { shape: ETH_SMALL, at: 0 },
      { shape: ETH_SMALL, at: 0, after: 1.4 },
      { shape: ETH_SMALL, at: 0, after: 1.4 },
    ],
  },
  {
    // Spaced mixed sizes — the second beat is taller, so the same rhythm
    // needs a bigger commitment.
    name: "step-up",
    minRatio: 1.2,
    gapAfter: 1.15,
    weight: [1.5, 3],
    parts: [
      { shape: ETH_SMALL, at: 0 },
      { shape: ETH_LARGE, at: 0, after: 1.5 },
    ],
  },
  { name: "twin", minRatio: 1.1, gapAfter: 1, weight: [1, 1.6], parts: [{ shape: clusterShape(ETH_SMALL, 2), at: 0 }] },
  { name: "large", minRatio: 1.25, gapAfter: 1, weight: [1, 3], parts: [{ shape: ETH_LARGE, at: 0 }] },
  { name: "trio", minRatio: 1.3, gapAfter: 1.1, weight: [0.2, 1], parts: [{ shape: clusterShape(ETH_SMALL, 3), at: 0 }] },
  // A small mark tucked against a large one: one arc, but it starts sooner
  // than the eye expects because the tall half is at the back.
  {
    name: "pair",
    minRatio: 1.6,
    gapAfter: 1.1,
    weight: [0.5, 2.5],
    parts: [
      { shape: ETH_SMALL, at: 0 },
      { shape: ETH_LARGE, at: ETH_SMALL.w + 1 },
    ],
  },
  { name: "wall", minRatio: 1.75, gapAfter: 1.15, weight: [0.2, 1], parts: [{ shape: clusterShape(ETH_LARGE, 2), at: 0 }] },
  { name: "range", minRatio: 2.25, gapAfter: 1.2, weight: [0.15, 0.8], parts: [{ shape: clusterShape(ETH_LARGE, 3), at: 0 }] },
];

/**
 * Where a pattern's parts land, in world px relative to the pattern's origin,
 * at this scroll speed. `speedPx` is px per second; `unit` is the cell size.
 */
export function patternParts(pattern, speedPx, unit) {
  return pattern.parts.map((part) => ({
    shape: part.shape,
    x: (part.at || 0) * unit + (part.after || 0) * speedPx,
    w: part.shape.w * unit,
    h: part.shape.h * unit,
  }));
}

/**
 * Split placed parts into the groups that have to be cleared in ONE jump.
 *
 * Two parts belong to the same group when the runner could not possibly land
 * between them: coming down from the first takes `hang` seconds, and the second
 * has to be jumped `rise` seconds before it arrives, so anything closer than
 * that much travel is one obstacle wearing two hats. Deriving it rather than
 * declaring it is what lets `after` be written in seconds and still mean the
 * same thing at every speed.
 */
export function jumpGroups(parts, speedPx, spriteH, runnerW, cfg = DEFAULTS) {
  const arc = jumpArc(spriteH, cfg);
  const groups = [];
  for (const part of parts) {
    const open = groups[groups.length - 1];
    if (open) {
      const separation = part.x - (open.x + open.w);
      const landing = (arc.hang + arc.rise(part.h) - arc.rise(open.h)) * speedPx + runnerW - open.w;
      if (separation < landing) {
        open.w = Math.max(open.w, part.x + part.w - open.x);
        open.h = Math.max(open.h, part.h);
        continue;
      }
    }
    groups.push({ x: part.x, w: part.w, h: part.h });
  }
  return groups;
}

/** The runner's hitbox width in px — the thing every clearance is measured against. */
export function runnerWidth(spriteW, cfg = DEFAULTS) {
  return spriteW * (1 - cfg.hitboxShrink);
}

/**
 * Can this pattern be jumped at this speed, by this piece?
 *
 * The whole safety argument, in one function: for every group, the ground
 * covered while the hitbox is above it must exceed the group's width plus the
 * runner's own, with `clearMargin` to spare. A group taller than `jumpReach`
 * fails immediately — its window is zero.
 */
export function patternIsClearable(pattern, speed, dims, cfg = DEFAULTS) {
  const { spriteH, spriteW, unit } = dims;
  const speedPx = speed * spriteH;
  const runnerW = runnerWidth(spriteW, cfg);
  const arc = jumpArc(spriteH, cfg);
  const groups = jumpGroups(patternParts(pattern, speedPx, unit), speedPx, spriteH, runnerW, cfg);
  return groups.every((g) => arc.window(g.h) * speedPx >= (g.w + runnerW) * cfg.clearMargin);
}

/**
 * How heavily a pattern is favoured right now. Early weights hold at the base
 * speed, late weights at the cap, and it slides linearly between them: the
 * opening is nearly all singles and breathers, the endgame is nearly all
 * clusters, and neither ever becomes the only thing you see.
 */
export function patternWeight(pattern, speed, cfg = DEFAULTS) {
  const span = Math.max(1e-6, cfg.maxSpeed - cfg.baseSpeed);
  const t = Math.min(Math.max((speed - cfg.baseSpeed) / span, 0), 1);
  const [early, late] = pattern.weight;
  return early + (late - early) * t;
}

/** Patterns the current speed has unlocked AND the jump arc can still answer. */
export function usablePatterns(speed, dims, cfg = DEFAULTS) {
  const unlocked = SPAWN_PATTERNS.filter(
    (p) => speed >= p.minRatio * cfg.baseSpeed && patternIsClearable(p, speed, dims, cfg),
  );
  return unlocked.length ? unlocked : [SPAWN_PATTERNS[0]];
}

/**
 * Pick the next pattern. Pure given `rand` in [0,1).
 *
 * `last` is the name of the pattern that just spawned; it is struck out of the
 * table, so the board can never show the same thing twice running. (If it is
 * somehow the only thing available — a speed where nothing else is clearable —
 * the no-repeat rule yields rather than deadlock the spawner.)
 */
export function pickPattern(rand, speed, dims, last = null, cfg = DEFAULTS) {
  const table = usablePatterns(speed, dims, cfg);
  const pool = table.filter((p) => p.name !== last);
  const use = pool.length ? pool : table;
  const weights = use.map((p) => Math.max(0, patternWeight(p, speed, cfg)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return use[0];
  let roll = Math.min(Math.max(rand, 0), 0.999999) * total;
  for (let i = 0; i < use.length; i++) {
    roll -= weights[i];
    if (roll < 0) return use[i];
  }
  return use[use.length - 1];
}

const isHex = (v) => typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v);

const PINK = "#FF4DA1";

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
  picked.sort((a, b) => relLuminance(a) - relLuminance(b));
  return {
    D: picked[0],
    M: picked[Math.floor((picked.length - 1) / 2)],
    L: picked[picked.length - 1],
  };
}

/* ------------------------------------------------------ colour + contrast */

/** sRGB relative luminance, 0..1. */
export function relLuminance(hex) {
  const s = String(hex || "").replace("#", "");
  const v = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.slice(0, 6);
  const n = parseInt(v, 16);
  if (!Number.isFinite(n)) return 0;
  const lin = (c) => {
    const u = c / 255;
    return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin((n >> 16) & 0xff) + 0.7152 * lin((n >> 8) & 0xff) + 0.0722 * lin(n & 0xff);
}

/** WCAG contrast ratio between two hex colours, 1..21. */
export function contrastRatio(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function channels(hex) {
  const s = String(hex || "").replace("#", "");
  const v = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.slice(0, 6);
  const n = parseInt(v, 16);
  return Number.isFinite(n) ? [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff] : [0, 0, 0];
}

const hex2 = (n) => Math.round(Math.min(Math.max(n, 0), 255)).toString(16).padStart(2, "0");

/** Blend `hex` toward `target` by `k` (0 = unchanged, 1 = target). */
export function mixHex(hex, target, k) {
  const a = channels(hex);
  const b = channels(target);
  const t = Math.min(Math.max(k, 0), 1);
  return "#" + a.map((v, i) => hex2(v + (b[i] - v) * t)).join("");
}

/**
 * The same colour, pushed until it can actually be seen on `board`.
 *
 * THE BOARD MAY BE WHITE. Every colour the game paints — the ground, the
 * specks, the banner, and the piece's own colours on the obstacles — is passed
 * through here first, so nothing is ever asked to be pale-on-pale. The push is
 * a straight blend toward black on a light board and toward white on a dark
 * one, which keeps the hue and only spends what it has to; if even the extreme
 * cannot make the ratio, the extreme is what you get.
 */
export function readable(hex, board, min = 3) {
  if (!isHex(hex)) return relLuminance(board) > 0.5 ? "#000000" : "#ffffff";
  if (contrastRatio(hex, board) >= min) return hex;
  const target = relLuminance(board) > 0.5 ? "#000000" : "#ffffff";
  for (let i = 1; i <= 10; i++) {
    const shifted = mixHex(hex, target, i / 10);
    if (contrastRatio(shifted, board) >= min) return shifted;
  }
  return target;
}

/** The three facets of one mark, each guaranteed visible against the board. */
export function readableFacets(facets, board, min = DEFAULTS.facetContrast) {
  return {
    L: readable(facets.L, board, min),
    M: readable(facets.M, board, min),
    D: readable(facets.D, board, min),
  };
}

/* --------------------------------------------------------------- spawning */

/**
 * How long a pattern itself occupies, in seconds: from its origin to the back
 * edge of its last mark. A three-wide cluster is half a second of board at the
 * base speed, and a pattern with an elastic part is longer still.
 */
export function patternSpan(pattern, speedPx, unit) {
  if (!pattern || !pattern.parts) return 0;
  return Math.max(
    ...pattern.parts.map(
      (p) => (p.after || 0) + (((p.at || 0) + p.shape.w) * unit) / Math.max(speedPx, 1e-6),
    ),
  );
}

/**
 * Seconds until the next spawn, after `pattern`.
 *
 * The gap is measured from the BACK of the pattern, not from its origin — a
 * three-wide cluster or a two-beat pattern would otherwise eat its own runway
 * and hand the player an unanswerable follow-up. On top of that the pattern's
 * `gapAfter` stretches the pause (or, for a busy one, never shortens it past
 * the floor), so a breather really is a breather and a cluster is always
 * followed by room to recover.
 */
export function patternGap(rand, speed, pattern, cfg = DEFAULTS, dims = null) {
  const scale = pattern && Number.isFinite(pattern.gapAfter) ? pattern.gapAfter : 1;
  const span = dims ? patternSpan(pattern, speed * dims.spriteH, dims.unit) : 0;
  return span + Math.max(cfg.gapFloor, spawnGap(rand, speed, cfg) * scale);
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
const PAPER = "#0B0B0D";
/** The flyer's near-black, kept in step with sprite.js FLYER_INK. */
const SHADOW = "#0b0b0d";

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

/**
 * The board's own colours, resolved from whatever the page passed.
 *
 * THE BOARD IS NOT ASSUMED TO BE DARK. The page owns the theme and may flip it
 * to white underneath us, so `board` is read from the page's surface token
 * (`board`, then `card`, then `paper`) and every other colour is then measured
 * against it: an `ink` that does not contrast with the surface it is drawn on
 * is a page bug we correct rather than repeat. Nothing here can vanish.
 *
 * `bg` is deliberately NOT consulted — pages pass the *piece's* background
 * colour under that name, which is the one colour the board must not be.
 */
function paletteTheme(palette) {
  const p = !Array.isArray(palette) && palette && typeof palette === "object" ? palette : {};
  const board = isHex(p.board) ? p.board : isHex(p.card) ? p.card : isHex(p.paper) ? p.paper : PAPER;
  const light = relLuminance(board) > 0.5;
  return {
    board,
    light,
    ink: readable(isHex(p.ink) ? p.ink : light ? PAPER : INK, board, 7),
    mute: readable(isHex(p.mute) ? p.mute : MUTE, board, 2.4),
    accent: readable(isHex(p.accent) ? p.accent : isHex(p.pink) ? p.pink : PINK, board, 3),
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

  // The crouch. Real duck frames come from sprite.js with the head, neck and
  // wing tips folded down whole cells — same scale, same feet, `duckDrop` cells
  // shorter. Without them we blit the bottom slice of the standing frame, which
  // is a 1:1 pixel copy of the same number of cells: never a fractional squash.
  const duck = pickFrames(duckFrames, frames && frames.duck);
  const duckH = duck ? duck[0].height : Math.max(cellPx, spriteH - cfg.duckDrop * cellPx);
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
  let lastPattern = null;
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
    lastPattern = null;
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

  /** What the clearance maths needs to know about this piece, in px. */
  function dims() {
    return { spriteH, spriteW, unit: obstacleUnit };
  }

  /**
   * One spawn: either a flyer, or a whole pattern of marks laid out at once.
   * The pattern also decides the pause that follows it, and is remembered so
   * the next spawn cannot repeat it.
   */
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
      return null;
    }
    const pattern = pickPattern(rng(), speed, dims(), lastPattern, cfg);
    lastPattern = pattern.name;
    const origin = width + obstacleUnit;
    // One roll of the piece's palette per pattern, not per mark: a pattern is
    // one thing the player reads, and two marks a cell apart in two different
    // colour schemes read as noise.
    const facets = readableFacets(facetColours(colours, rng()), theme.board, cfg.facetContrast);
    for (const part of patternParts(pattern, speed * spriteH, obstacleUnit)) {
      obstacles.push({
        kind: "eth",
        pattern: pattern.name,
        x: origin + part.x,
        shape: part.shape,
        facets,
        w: part.w,
        h: part.h,
        y: groundY - part.h,
        speed: 1,
      });
    }
    return pattern;
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
      const pattern = spawn();
      nextGap = patternGap(rng(), speedAt(elapsed, cfg), pattern, cfg, dims());
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

  /**
   * The board, drawn entirely from the palette the page handed over.
   *
   * Sky, ground line and ground texture are all the page's own tokens, run
   * through `readable` against the board first — on a white board the ground is
   * a dark hairline and the specks are grey, on a near-black one they are the
   * light greys they always were. The only thing that stays put whatever the
   * theme is the flyer: an all-black silhouette reads best on white, and it is
   * the one shape in the game whose whole point is being a shadow.
   */
  function draw() {
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;

    // Sky.
    ctx.fillStyle = theme.board;
    ctx.fillRect(0, 0, width, height);

    // Ground line + specks.
    const rule = Math.max(1, Math.round(cellPx / 2));
    ctx.fillStyle = theme.mute;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(0, groundY, width, rule);
    ctx.globalAlpha = 0.55;
    for (const s of specks) {
      ctx.fillRect(Math.round(s.x), Math.round(s.y), Math.round(s.w), rule);
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
    // Black, on any board — the same near-black sprite.js paints the real
    // silhouette with, so the stand-in reads as the same creature.
    ctx.fillStyle = SHADOW;
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
    // The overlay is the one thing a player reads rather than dodges: hold it
    // to text contrast against the board, not decoration contrast.
    ctx.fillStyle = state === "over" ? readable(theme.accent, theme.board, 4.5) : theme.ink;
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
        pattern: lastPattern,
        board: theme.board,
        ducking,
        runner: { ...runner },
        runnerRect: runnerRect(),
        obstacles: obstacles.map((o) => ({
          kind: o.kind,
          lane: o.lane || null,
          pattern: o.pattern || null,
          facets: o.facets ? { ...o.facets } : null,
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
