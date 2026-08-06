/**
 * upegRUN — the diorama.
 *
 * A quiet clearing that lives behind the new tab: a waterfall on one side, a
 * broadleaf tree on the other, and your pieces grazing and ambling along the
 * bottom half. It is a diorama and not a side-scroller on purpose. A new tab
 * opens a hundred times a day; an endless running world is exhausting at that
 * frequency and fights the search bar for attention. This is meant to be
 * something you are happy to glance at, not something that performs at you.
 *
 * THREE RULES, IN ORDER OF IMPORTANCE.
 *
 * 1. `imageSmoothingEnabled = false`, integer cells, integer scales. Every
 *    coordinate in this file is in scene CELLS, converted to device pixels
 *    exactly once at the blit. There is no 0.5.
 *
 * 2. THE PIECES ARE NEVER RECOLOURED. Depth is staged, not tinted: distance is
 *    read from scale (2, 3 or 4 device px per cell), from overlap, and from how
 *    much scenery sits in front. The invented scenery may be tinted for depth
 *    all it likes. A Unipeg is rendered in exactly the colours the contract
 *    gives it, at every distance, in day and in night.
 *
 * 3. THERE IS NO 3/4 VIEW. The art is one side-on 24x24 grid and inventing
 *    another angle means inventing pixels. Everything that reads as depth here
 *    comes from staging, and the pieces only ever face left or right — mirrored
 *    exactly, whole pixels reversed.
 *
 * The scenery (tree, cliff, water, tufts) is hand-drawn on the same cell
 * lattice as the art, which is the same thing lib/game.js already does for the
 * Ethereum marks. Decoration is drawn; the pieces are on-chain. That line is
 * the one that matters and this file does not cross it.
 *
 * Everything below the `startScene` divider is pure and unit-tested: palettes,
 * mode resolution, the shape tables, the water pattern, the layout solver and
 * the wander simulation all take numbers and return numbers.
 */

/* ------------------------------------------------------------- palettes */

/**
 * Pastels, black and white — the owner's brief. Day is a pale clearing at
 * midday; night is the same clearing under a moon, not a different place.
 *
 * `ink` and `paper` are the page's own tokens and are repeated here so the
 * scene and the chrome over it can never drift apart: pages/page.js reads these
 * to set the page's colours when the mode flips.
 */
export const DAY = {
  name: "day",
  sky: "#F2EFF7",
  skyHigh: "#E4DFEE",
  sun: "#FFEFAF",
  sunCore: "#FFFFFF",
  cloud: "#FFFFFF",
  hillFar: "#C6D9CC",
  hillNear: "#CFE6D5",
  grass: "#D3EAD8",
  grassDark: "#B8DCC1",
  tuft: "#7FB490",
  flower: "#F2A9CC",
  flowerAlt: "#FFFFFF",
  // The canopy has to separate from the grass it stands on. An earlier pass had
  // canopyLight #C7E3CC against grass #BEDCC4 — a ratio of 1.06, which is to
  // say the tree was invisible. Every green here is at least 1.25 from its
  // neighbour, which on pastels is the difference between a tree and a smudge.
  canopyLight: "#9AD1A9",
  canopyMid: "#72B88A",
  canopyDark: "#4E9469",
  trunk: "#4A3B44",
  bark: "#6B5A64",
  rock: "#C9C2D3",
  rockDark: "#A79FB6",
  rockShade: "#8B8399",
  water: "#B7D9EF",
  waterDark: "#8DBEDF",
  foam: "#FFFFFF",
  mist: "#EAF3FA",
  ink: "#0B0B0D",
  paper: "#FFFFFF",
};

export const NIGHT = {
  name: "night",
  sky: "#12121A",
  skyHigh: "#1B1B26",
  sun: "#E8E4F2", // the moon
  sunCore: "#FFFFFF",
  cloud: "#2A2A38",
  hillFar: "#182420",
  hillNear: "#22312A",
  grass: "#26362D",
  grassDark: "#1C2922",
  tuft: "#3D5647",
  flower: "#7A5169",
  flowerAlt: "#A99CB4",
  canopyLight: "#39604A",
  canopyMid: "#2B4B39",
  canopyDark: "#1D3629",
  trunk: "#171419",
  bark: "#282029",
  rock: "#2E2E3C",
  rockDark: "#22222E",
  rockShade: "#191921",
  water: "#3C5C79",
  waterDark: "#28415A",
  foam: "#C6DCED",
  mist: "#2A3644",
  ink: "#F7F7F8",
  paper: "#0B0B0D",
};

export const PALETTES = { day: DAY, night: NIGHT };

/**
 * Which palette is in force.
 *
 * `setting` is what the user chose — "auto", "day" or "night". Auto follows the
 * clock rather than `prefers-color-scheme`, because the scene is a place and a
 * place is light when it is daytime where you are. 6am to 6pm, on the machine's
 * own hours, no timezone maths and nothing to configure.
 */
export function resolveMode(setting, hour) {
  if (setting === "day" || setting === "night") return setting;
  const h = Number.isFinite(hour) ? ((Math.floor(hour) % 24) + 24) % 24 : 12;
  return h >= 6 && h < 18 ? "day" : "night";
}

/** The palette object for a setting + clock hour. */
export function paletteFor(setting, hour) {
  return PALETTES[resolveMode(setting, hour)];
}

/* --------------------------------------------------------------- shapes */

/**
 * Compile rows of palette letters into runs, one per colour change, exactly
 * like lib/game.js does for the Ethereum marks. `.` is empty. The letters are
 * palette KEYS, not colours, so one shape table serves day and night.
 */
export function cellShape(rows, key) {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const paint = [];
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] === ".") continue;
      let end = x + 1;
      while (end < row.length && row[end] === row[x]) end++;
      paint.push({ x, y, w: end - x, h: 1, k: key[row[x]] });
      x = end - 1;
    }
  }
  return { w, h, rows, paint };
}

/**
 * THE TREE. 25 cells wide, 32 tall, trunk centred on x = 12.
 *
 * A broadleaf lollipop with a dark core, which is the shape that survives being
 * drawn at 2px per cell in the back band as well as 4px in the front — the
 * silhouette does the work and the interior shading is a bonus you only get up
 * close. Drawn once and used at every depth; the back band's small trees are
 * this tree at half scale, not a second drawing.
 */
export const TREE_ROWS = [
  ".........LLLLLLL.........",
  "......LLLLLLLLLLLLL......",
  "....LLLLLLLLLLLLLLLLL....",
  "...LLLLLLLCCCCCLLLLLLL...",
  "..LLLLLLCCCCCCCCCLLLLLL..",
  ".LLLLLLCCCCCCCCCCCLLLLLL.",
  ".LLLLLCCCCCCCCCCCCCLLLLL.",
  "LLLLLCCCCCCCCCCCCCCCLLLLL",
  "LLLLCCCCCCCCCCCCCCCCCLLLL",
  "LLLCCCCCCCCCCCCCCCCCCCLLL",
  "LLLCCCCCCCCKKKCCCCCCCCLLL",
  "LLCCCCCCCCKKKKKCCCCCCCCLL",
  "LLCCCCCCCKKKKKKKCCCCCCCLL",
  "LLCCCCCCCCKKKKKCCCCCCCCLL",
  "LLLCCCCCCCCKKKCCCCCCCCLLL",
  "LLLCCCCCCCCCCCCCCCCCCCLLL",
  ".LLCCCCCCCCCCCCCCCCCCCLL.",
  ".LLLCCCCCCCCCCCCCCCCCLLL.",
  "..LLLCCCCCCCCCCCCCCCLLL..",
  "...LLLLCCCCCCCCCCCLLLL...",
  ".....LLLLCCCCCCCLLLL.....",
  ".......LLLLLLLLLLL.......",
  "..........TTTBB..........",
  "..........TTTBB..........",
  "..........TTTBB..........",
  "..........TTTBB..........",
  ".........TTTTBB..........",
  ".........TTTTBB..........",
  "........TTTTTBBB.........",
  ".......TTTTTTBBBB........",
  "......TTTTTTTBBBBB.......",
  "....TTTTTTTTTBBBBBBB.....",
];

export const TREE = cellShape(TREE_ROWS, {
  L: "canopyLight",
  C: "canopyMid",
  K: "canopyDark",
  T: "trunk",
  B: "bark",
});

/** A grass tuft. Three of them, so the ground is not a repeating stamp. */
export const TUFT_ROWS = [
  ["..t..", ".ttt.", "ttttt"],
  [".t.t.", "ttttt", "ttttt"],
  ["t...t", "tt.tt", "ttttt"],
];

export const TUFTS = TUFT_ROWS.map((rows) => cellShape(rows, { t: "tuft" }));

/** A flower: one pastel head on a stem. Two colourways. */
export const FLOWER_ROWS = ["f", "t"];
export const FLOWERS = [
  cellShape(FLOWER_ROWS, { f: "flower", t: "tuft" }),
  cellShape(FLOWER_ROWS, { f: "flowerAlt", t: "tuft" }),
];

/** A boulder at the foot of the falls, so the water lands on something. */
export const ROCK_ROWS = [
  "..rrrr..",
  ".rrrrrr.",
  "rrrrrrdd",
  "rrrrrddd",
  ".rrdddd.",
];

export const ROCK = cellShape(ROCK_ROWS, { r: "rock", d: "rockDark" });

/* ------------------------------------------------------------ the falls */

/**
 * THE WATER, AS A PURE FUNCTION OF (x, y, tick).
 *
 * Running water without a single sub-pixel: the fall is a field of cells and
 * this decides what each one is at tick `t`. The streaks are a diagonal comb
 * that moves DOWN one whole cell per tick — `y - t` is the whole trick — so the
 * flow reads at 12fps and costs nothing. `x * 3` shears the comb sideways so
 * the streaks do not line up into stripes across the fall.
 *
 * Returns a palette key: "foam", "water" or "waterDark".
 */
export function waterCell(x, y, t) {
  const phase = (((y - t) * 2 + x * 3) % 11 + 11) % 11;
  if (phase < 2) return "foam";
  if (phase < 6) return "water";
  return "waterDark";
}

/**
 * The lip: the two rows where the river tips over the edge are pure white
 * foam, which is what makes the fall read as falling rather than as a blue
 * rectangle. Below that `waterCell` takes over.
 */
export const FALL_LIP_ROWS = 2;

/**
 * The pool's surface ripple — a slower comb, moving sideways rather than down,
 * so the pool reads as disturbed but not as a second waterfall.
 */
export function poolCell(x, y, t) {
  const phase = (((x + ((t / 2) | 0)) * 2 + y * 5) % 13 + 13) % 13;
  if (phase < 2) return "foam";
  if (phase < 7) return "water";
  return "waterDark";
}

/**
 * Spray at the impact line: a sparse, blinking scatter. Sparse on purpose —
 * dense spray at 12fps reads as television static.
 */
export function sprayAt(x, y, t) {
  return ((x * 7 + y * 13 + t * 5) % 23) < 3;
}

/* --------------------------------------------------------------- layout */

/**
 * Where everything stands, in scene cells.
 *
 * Takes the canvas size in CELLS (not pixels — the caller has already divided
 * by the unit) and returns integer positions. Composed around two facts: the
 * search bar floats over the upper third, and the pieces graze in the bottom
 * half. So the sky is deliberately empty in the middle, the falls take the
 * left edge, and the tree takes the right — the two verticals frame the bar
 * instead of colliding with it.
 */
export function layout(wCells, hCells) {
  const w = Math.max(40, Math.round(wCells));
  const h = Math.max(30, Math.round(hCells));

  // The horizon sits just above halfway, so "the bottom half" really is the
  // ground and the grazing band is not squeezed.
  const horizon = Math.round(h * 0.46);
  const depth = h - horizon;

  // Three grazing lanes, back to front, over the bottom half. Each lane's
  // baseline is where a piece's feet land, and `scale` is the piece's own
  // integer cell size in front-band units — 4 is life size, 2 is far away.
  const lanes = [
    { scale: 2, y: horizon + Math.round(depth * 0.22) },
    { scale: 3, y: horizon + Math.round(depth * 0.52) },
    { scale: 4, y: horizon + Math.round(depth * 0.86) },
  ];

  // THE FALLS, on the left. A rock mass rising out of the ground with a notch
  // in the top for the river to come over, water down the notch, and a pool on
  // the ground plane in front of the rock — not a rectangle bolted to the edge.
  const cliffW = Math.max(11, Math.round(w * 0.115));
  const fallW = Math.max(4, Math.round(cliffW * 0.42));
  const cliffTop = Math.max(1, Math.round(h * 0.12));
  const poolY = horizon + Math.round(depth * 0.34);
  const fall = {
    cliffX: 0,
    cliffW,
    top: cliffTop,
    // The notch sits inboard of the cliff's right edge, so water falls down the
    // face rather than off the corner.
    x: Math.round(cliffW * 0.42),
    w: fallW,
    poolY,
    poolH: Math.max(4, Math.round(depth * 0.13)),
    poolW: Math.round(cliffW * 1.35),
  };

  // The hero tree: right side, rooted in the middle lane so the front lane's
  // pieces pass in front of it and the back lane's pass behind. Scale 2 puts it
  // at 64 cells against a 24-cell piece — a tree you stand under, and short
  // enough that its canopy stays clear of the search bar across the sky.
  const treeScale = Math.max(2, Math.min(3, Math.round(depth / 58)));
  const tree = {
    scale: treeScale,
    // centred on the trunk, which is x = 12 of the shape's 25
    x: Math.round(w * 0.79) - 12 * treeScale,
    baseY: lanes[1].y,
    shape: TREE,
  };

  // Three on the skyline at scale 1, standing in the back lane. Scale 1 is the
  // point: at 32 cells they are a THIRD of the hero, which is what makes them
  // read as far away rather than as saplings planted next to it.
  const farTrees = [
    { scale: 1, x: Math.round(w * 0.27), baseY: lanes[0].y - 2 },
    { scale: 1, x: Math.round(w * 0.37), baseY: lanes[0].y },
    { scale: 1, x: Math.round(w * 0.53), baseY: lanes[0].y - 1 },
  ];

  // Sun or moon: high, left of centre, clear of both the tree and the search
  // bar that floats across the middle of the sky.
  // High and far right — above the hero tree's canopy and clear of the search
  // bar, which floats across the middle of the sky.
  const sky = { cx: Math.round(w * 0.88), cy: Math.round(horizon * 0.24), r: 5 };

  return { w, h, horizon, depth, lanes, fall, tree, farTrees, sky };
}

/**
 * Where a piece may walk in its lane, in cells. Kept clear of the falls on the
 * left so nobody grazes inside a waterfall.
 */
// `_laneIndex` is part of the contract even though every lane currently shares
// one span: a caller must not have to know that, and per-lane bounds are the
// obvious next change.
export function laneBounds(scene, _laneIndex) {
  const left = scene.fall.cliffX + scene.fall.cliffW + 2;
  return { min: left, max: Math.max(left + 8, scene.w - 4) };
}

/* ----------------------------------------------------------- the wander */

/**
 * Deterministic RNG, so a peg's wander is reproducible from its id and the
 * simulation is testable without a canvas. Same mulberry32 lib/game.js uses.
 */
export function sceneRng(seed) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cells per second at each state. A graze is a standstill with the head down. */
export const WALK_SPEED = 3.2;

/**
 * How long a piece stays in each state, in seconds — a range, rolled per turn.
 * Grazing is the long one: a clearing where everything is always walking looks
 * like a bus station.
 */
export const STATE_SECONDS = {
  walk: [2.2, 5.5],
  graze: [3.5, 9],
  idle: [1.2, 3],
};

/**
 * One grazer's state, ready to step. `lane` indexes scene.lanes; `x` is in
 * cells; `dir` is +1 or -1; `phase` advances the two-frame cycle.
 */
export function makeGrazer(id, laneIndex, scene, rand) {
  const b = laneBounds(scene, laneIndex);
  const r = rand || sceneRng(id * 2654435761);
  const state = r() < 0.55 ? "graze" : "walk";
  return {
    id,
    lane: laneIndex,
    x: b.min + r() * Math.max(1, b.max - b.min),
    dir: r() < 0.5 ? -1 : 1,
    state,
    left: span(STATE_SECONDS[state], r()),
    phase: r() * 2,
    rand: r,
  };
}

function span([lo, hi], r) {
  return lo + r * (hi - lo);
}

/**
 * Advance one grazer by `dt` seconds. Pure in the sense that matters: it only
 * touches the object handed to it and its own RNG, so a test can run a
 * thousand seconds of clearing and assert nobody ever left the lane.
 *
 * Turning happens at the edges AND at random, and a piece that turns while
 * grazing lifts its head first — which is why the state machine turns through
 * `walk` rather than flipping `dir` under a grazing sprite.
 */
export function stepGrazer(g, dt, scene) {
  const b = laneBounds(scene, g.lane);
  const r = g.rand;
  g.left -= dt;

  if (g.state === "walk") {
    g.x += g.dir * WALK_SPEED * dt;
    g.phase = (g.phase + dt * 6) % 2;
    if (g.x <= b.min) {
      g.x = b.min;
      g.dir = 1;
    } else if (g.x >= b.max) {
      g.x = b.max;
      g.dir = -1;
    }
  }

  if (g.left <= 0) {
    // Grazing is the resting state and everything returns to it more often
    // than not; a walk is something a piece decides to do.
    const roll = r();
    const next = g.state === "walk" ? (roll < 0.7 ? "graze" : "idle") : roll < 0.45 ? "walk" : g.state === "graze" ? "idle" : "graze";
    if (next === "walk" && r() < 0.35) g.dir = -g.dir;
    g.state = next;
    g.left = span(STATE_SECONDS[next], r());
  }
  return g;
}

/**
 * Lay the roster out across the lanes: back to front, so the first piece a user
 * added is the one standing closest to them. Lanes cycle, so six pieces make
 * two of each depth rather than a crowd on one line.
 */
export function assignLanes(ids, scene) {
  const order = [2, 1, 0];
  return ids.map((id, i) => makeGrazer(id, order[i % order.length], scene, sceneRng((id + i * 7919) * 2654435761)));
}

/**
 * How the caller keys its frame sets: one per piece PER LANE SCALE. A piece in
 * the back lane is drawn from a 2px-per-cell render of the same 24x24 grid, not
 * from the 4px one shrunk — shrinking is resampling, and resampling pixel art
 * is the one thing this codebase never does.
 */
export function frameKey(id, scale) {
  return `${id}@${scale}`;
}

/** The integer scales the lanes use, so a caller knows what to pre-build. */
export const LANE_SCALES = [2, 3, 4];

/* ------------------------------------------------------ the impure shell */

const TICK_HZ = 12;

/**
 * The scene's own frame rate is 12fps, not 60.
 *
 * Pixel art animates on twos and threes; a 12fps walk cycle is what the medium
 * actually looks like, and it means the clearing costs about a twelfth of what
 * a naive rAF loop would on a page that is open all day. The rAF loop still
 * runs at the display's rate — it just skips the work between ticks.
 */
export function startScene(options) {
  const { canvas, framesByKey, palette, ids = [], reducedMotion = false } = options || {};
  if (!canvas) throw new Error("startScene needs a canvas");

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  let pal = palette || DAY;
  let unit = 1;
  let scene = null;
  let grazers = [];
  let tick = 0;
  let raf = 0;
  let last = 0;
  let acc = 0;
  let stopped = false;
  let running = false;

  /** Mirrored copies, built once. A -1 scale on integer bounds is exact. */
  const mirrored = new Map();
  function facing(set, dir) {
    if (dir > 0) return set;
    if (!mirrored.has(set)) {
      mirrored.set(
        set,
        set.map((src) => {
          const c = document.createElement("canvas");
          c.width = src.width;
          c.height = src.height;
          const cx = c.getContext("2d");
          cx.imageSmoothingEnabled = false;
          cx.translate(src.width, 0);
          cx.scale(-1, 1);
          cx.drawImage(src, 0, 0);
          return c;
        }),
      );
    }
    return mirrored.get(set);
  }

  /**
   * ONE UNIT, ONE MEANING: `unit` is device pixels per SCENE CELL, and a scene
   * cell is one art cell of a front-band piece. So a front piece is 24 cells
   * tall, the tree is `TREE.h * tree.scale` cells tall, and every `scale` in the
   * layout is a count of scene cells — never a second multiplier on top of one.
   *
   * Getting this wrong is what drew the first tree at two and a half times the
   * size it was designed for: `scale` and `unit` were both being applied, so a
   * 32-cell tree came out 640px instead of 256.
   */
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, Math.round(window.devicePixelRatio || 1)));
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    // Front-band pieces are drawn at 4 art-cell pixels, times the device ratio,
    // exactly like the game builds its own frames. That is the unit.
    unit = LANE_SCALES[LANE_SCALES.length - 1] * dpr;
    ctx.imageSmoothingEnabled = false;
    scene = layout(canvas.width / unit, canvas.height / unit);
    grazers = assignLanes(ids, scene);
    paint();
  }

  function fill(key, x, y, w, h) {
    ctx.fillStyle = pal[key] || pal.ink;
    ctx.fillRect(x * unit, y * unit, w * unit, h * unit);
  }

  function stamp(shape, x, y, scale) {
    for (const r of shape.paint) {
      ctx.fillStyle = pal[r.k] || pal.ink;
      ctx.fillRect((x + r.x * scale) * unit, (y + r.y * scale) * unit, r.w * scale * unit, scale * unit);
    }
  }

  function paintSky() {
    fill("sky", 0, 0, scene.w, scene.horizon + 1);
    fill("skyHigh", 0, 0, scene.w, Math.round(scene.horizon * 0.45));

    // Sun or moon: a disc built row by row from an integer circle, so its edge
    // is stepped pixels rather than an anti-aliased arc.
    const { cx, cy, r: rad } = scene.sky;
    for (let y = -rad; y <= rad; y++) {
      const half = Math.round(Math.sqrt(Math.max(0, rad * rad - y * y)));
      if (!half) continue;
      fill("sun", cx - half, cy + y, half * 2 + 1, 1);
    }
    if (pal.name === "night") {
      // The crescent is a SECOND disc in sky colour, offset right — bitten out
      // with the same integer-circle routine that drew the moon. A rectangle
      // bite (which is what this was) reads as a square notch, not a crescent.
      for (let y = -rad; y <= rad; y++) {
        const half = Math.round(Math.sqrt(Math.max(0, rad * rad - y * y)));
        if (!half) continue;
        fill("sky", cx - half + 3, cy + y, half * 2 + 1, 1);
      }
      // Stars. Whole cells, and the twinkle is a slow modulo rather than an
      // opacity ramp, because a fading pixel is a blurred pixel.
      for (let i = 0; i < 70; i++) {
        const sx = (i * 37) % scene.w;
        const sy = (i * 53) % Math.max(1, scene.horizon - 3);
        if ((i + ((tick / 8) | 0)) % 9 === 0) continue;
        fill(i % 6 === 0 ? "sunCore" : "cloud", sx, sy, 1, 1);
      }
    } else {
      fill("sunCore", cx - 1, cy - 2, 2, 2);
    }
  }

  function paintGround() {
    // A soft band of far hills where the sky meets the ground, then the ground
    // in three shallow tones — one per lane — so depth reads without a line.
    fill("hillFar", 0, scene.horizon - 2, scene.w, 3);
    fill("grass", 0, scene.horizon, scene.w, scene.h - scene.horizon);
    fill("hillNear", 0, scene.horizon + 1, scene.w, Math.max(1, Math.round(scene.depth * 0.16)));
    fill("grassDark", 0, scene.lanes[2].y - 2, scene.w, scene.h - scene.lanes[2].y + 2);
  }

  function paintTufts() {
    // Fixed positions from a fixed seed: it is the same clearing every time you
    // open a tab, which is most of what makes it a place rather than a screen
    // saver. Tufts sit on a lane's baseline and take that lane's scale, so the
    // far ones are genuinely smaller pixel grids.
    const f = scene.fall;
    const r = sceneRng(0x5eed);
    for (let i = 0; i < 70; i++) {
      const x = Math.round(r() * scene.w);
      const lane = Math.floor(r() * 3);
      const s = lane === 0 ? 1 : lane === 1 ? 1 : 2;
      const y = scene.lanes[lane].y - Math.round(r() * 2);
      // Nothing grows on the rock, and nothing grows in the pool.
      if (x < f.cliffX + f.cliffW + 1) continue;
      if (x < f.cliffX + f.poolW + 2 && y > f.poolY - 2) continue;
      const pick = r();
      const shape = pick < 0.2 ? FLOWERS[i % 2] : TUFTS[i % TUFTS.length];
      stamp(shape, x, y - shape.h * s, s);
    }
  }

  /** The right-hand edge of the rock, stepped rather than ruled. */
  function cliffEdgeAt(y, f) {
    const t = (y - f.top) / Math.max(1, scene.h - f.top);
    // Widens toward the base like a real face, in whole cells, with two notches
    // cut out of it so the silhouette is not a wedge.
    const base = f.cliffW * (0.72 + 0.28 * t);
    const step = ((y * 7) % 13 < 4 ? 1 : 0) + ((y * 5) % 23 < 3 ? 1 : 0);
    return Math.round(base) - step;
  }

  function paintFalls() {
    const f = scene.fall;

    // The rock mass, drawn a row at a time so the edge can step. It STOPS at
    // the pool rather than running off the bottom of the screen: the cliff is
    // behind the clearing, so the ground plane has to come forward over its
    // foot. A rock face that reaches the bottom edge reads as a wall you are
    // standing against, which is the opposite of depth.
    const foot = f.poolY + Math.round(f.poolH * 0.5);
    for (let y = f.top; y < foot; y++) {
      const edge = cliffEdgeAt(y, f);
      fill("rock", f.cliffX, y, edge, 1);
      fill("rockShade", f.cliffX + edge - 2, y, 2, 1);
      // Strata: a darker seam every so often reads as rock rather than as a
      // grey rectangle. Irregular spacing — evenly ruled lines read as paper.
      if ((y * 5) % 17 < 1) fill("rockDark", f.cliffX, y, Math.max(1, edge - 3), 1);
    }
    // The lip of the notch the river comes over.
    fill("rockDark", f.x - 2, f.top, f.w + 4, 2);

    // The fall, from the notch down to the pool. Two rows of pure foam at the
    // top is what makes it read as falling rather than as a blue ribbon.
    const top = f.top + 1;
    for (let y = top; y < f.poolY; y++) {
      for (let x = f.x; x < f.x + f.w; x++) {
        fill(y - top < FALL_LIP_ROWS ? "foam" : waterCell(x - f.x, y, tick), x, y, 1, 1);
      }
    }

    // The pool: a lens on the ground plane, narrowing at both ends, so it sits
    // in the grass instead of being a bar ruled across it.
    for (let y = f.poolY; y < f.poolY + f.poolH; y++) {
      const k = (y - f.poolY) / Math.max(1, f.poolH - 1);
      const inset = Math.round(Math.abs(k - 0.5) * 2 * f.poolW * 0.22);
      const x0 = f.cliffX + inset;
      const x1 = f.cliffX + f.poolW - inset;
      for (let x = x0; x < x1; x++) fill(poolCell(x, y, tick), x, y, 1, 1);
    }

    // Spray where the two meet, and a boulder for the water to break on.
    for (let y = f.poolY - 4; y < f.poolY + 2; y++) {
      for (let x = f.x - 4; x < f.x + f.w + 4; x++) {
        if (sprayAt(x, y, tick)) fill("mist", x, y, 1, 1);
      }
    }
    stamp(ROCK, f.x + f.w + 1, f.poolY - 5, 1);
  }

  function paintGrazer(g) {
    const lane = scene.lanes[g.lane];
    // Each lane has its own integer scale, and the caller built a frame set per
    // scale. Picking by lane is what keeps a distant piece a genuinely smaller
    // PIXEL grid rather than a downscaled — i.e. resampled — big one.
    const set = framesByKey && (framesByKey[frameKey(g.id, lane.scale)] || framesByKey[frameKey(g.id, 4)]);
    if (!set || !set.walk) return;
    const use = g.state === "graze" ? set.duck || set.walk : set.walk;
    const cell = facing(use, g.dir);
    const img = cell[Math.floor(g.phase) % cell.length];
    if (!img) return;
    // The sprite was built at the lane's own integer scale, so it lands on
    // whole device pixels with no resampling. Round in CELLS, then multiply.
    const x = Math.round(g.x) * unit;
    const y = lane.y * unit - img.height;
    ctx.drawImage(img, x, y);
  }

  function paint() {
    if (!scene) return;
    ctx.imageSmoothingEnabled = false;
    paintSky();
    paintGround();
    // Painter's algorithm, strictly back to front: far trees, then the back and
    // middle lanes, then the hero tree, then the front lane. That ordering is
    // the only depth cue that costs nothing and reads instantly — a piece in
    // the front lane walks IN FRONT of the tree, one in the back walks behind.
    for (const t of scene.farTrees) {
      stamp(t.shape || TREE, t.x, t.baseY - TREE.h * t.scale, t.scale);
    }
    paintFalls();
    paintTufts();
    const sorted = grazers.slice().sort((a, b) => scene.lanes[a.lane].y - scene.lanes[b.lane].y);
    for (const g of sorted) if (g.lane !== 2) paintGrazer(g);
    stamp(
      scene.tree.shape,
      scene.tree.x,
      scene.tree.baseY - scene.tree.shape.h * scene.tree.scale,
      scene.tree.scale,
    );
    for (const g of sorted) if (g.lane === 2) paintGrazer(g);
  }

  function frame(now) {
    if (stopped) return;
    raf = requestAnimationFrame(frame);
    if (!running) return;
    const dt = Math.min(0.25, (now - last) / 1000 || 0);
    last = now;
    acc += dt;
    const step = 1 / TICK_HZ;
    let dirty = false;
    while (acc >= step) {
      acc -= step;
      tick++;
      for (const g of grazers) stepGrazer(g, step, scene);
      dirty = true;
    }
    if (dirty) paint();
  }

  function play() {
    if (stopped || running || reducedMotion) return;
    running = true;
    last = performance.now();
    acc = 0;
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function pause() {
    running = false;
  }

  resize();
  if (!reducedMotion) play();

  return {
    /** Repaint with a different palette — the day/night flip. */
    setPalette(next) {
      pal = next || pal;
      paint();
    },
    /** Swap the roster without rebuilding the clearing. */
    setIds(next) {
      options.ids = next;
      grazers = assignLanes(next || [], scene);
      paint();
    },
    resize,
    play,
    pause,
    isRunning: () => running,
    stop() {
      stopped = true;
      running = false;
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
