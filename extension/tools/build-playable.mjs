// Assemble the extension's REAL game modules into one self-contained page.
// Nothing is reimplemented: lib/upeg.js, lib/sprite.js and lib/game.js are
// inlined verbatim (imports/exports stripped, no collisions — checked), the
// bundled data rides along as constants, and a tiny fetch shim serves the
// snapshot so the modules' own loader works untouched.
import { readFileSync, writeFileSync } from "node:fs";

const EXT = "/home/user/unipeg/extension";
const OUT = process.argv[2] || "unipeg-runner.html";

const layers = readFileSync(`${EXT}/data/layers.js`, "utf8")
  .replace(/^export\s+default\s+/m, "const LAYER_DATA = ")
  .replace(/;?\s*$/, ";");
const alive = readFileSync(`${EXT}/data/upeg-alive.json`, "utf8");

const strip = (src) =>
  src
    .replace(/^\s*import[^;]*;\s*$/gm, "")
    .replace(/^export\s+/gm, "")
    // classic <script> scope: import.meta is a syntax error. The only use is
    // resolving the bundled snapshot URL, which our fetch shim answers anyway.
    .replace(/import\.meta\.url/g, "location.href");

const upeg = strip(readFileSync(`${EXT}/lib/upeg.js`, "utf8"));
const sprite = strip(readFileSync(`${EXT}/lib/sprite.js`, "utf8"));
const game = strip(readFileSync(`${EXT}/lib/game.js`, "utf8"));
// scene.js joins them in one flat script scope, so its two helpers that would
// have collided with game.js (`makeRng`, `shapeFromRows`) were renamed at the
// source to `sceneRng` / `cellShape` rather than patched here. Checked: no
// top-level name in scene.js clashes with upeg.js, sprite.js or game.js.
const scene = strip(readFileSync(`${EXT}/lib/scene.js`, "utf8"));

const html = `<title>upegRUN Runner — play your Unipeg</title>
<style>
  :root {
    /* Committed LIGHT palette — docs/DESIGN.md's light column, identical to the
       extension's pages/page.css. White paper, no theme toggle. --line is a
       1.26:1 hairline, so it never carries text or a control edge; control
       borders use --mute (5.69:1 on paper). */
    --paper: #ffffff;
    --ink: #0b0b0d;
    --pink: #d8006e;
    --mute: #66666e;
    --card: #f4f3f5;
    --line: #e7e4e7;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--mono);
    font-size: 15px;
    line-height: 1.5;
    display: flex;
    justify-content: center;
  }
  .wrap {
    width: 100%;
    /* Wider than it was (720px) so the board gets the room the owner asked for,
       matching pages/page.css's move from 880px to 960px. */
    max-width: 900px;
    padding: 24px 16px 48px;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .brand { font-weight: 700; letter-spacing: -0.02em; font-size: 20px; }
  .brand b { color: var(--pink); }
  .eyebrow { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--mute); }

  .panel { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  label { font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--mute); }
  input[type="number"] {
    font: inherit; font-size: 16px; background: var(--paper); color: var(--ink);
    border: 2px solid var(--mute); border-radius: 8px; padding: 10px 12px; width: 150px;
    caret-color: var(--pink); -moz-appearance: textfield;
  }
  input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  button {
    font: inherit; font-size: 13px; font-weight: 700; letter-spacing: 0.04em;
    background: var(--paper); color: var(--ink); border: 2px solid var(--mute);
    border-radius: 999px; padding: 10px 18px; min-height: 44px; cursor: pointer;
  }
  button.primary { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  button.primary:hover { background: var(--pink); border-color: var(--pink); }
  button.pink { border-color: var(--pink); color: var(--pink); }
  button:hover { border-color: var(--pink); }
  :focus-visible { outline: 2px solid var(--pink); outline-offset: 2px; }

  /* THE HEADER IS pages/newtab.html's HEADER.
     Piece on a plate, Google beside it, the peg number and best underneath —
     the same order and the same parts as the real new tab. It sits directly
     under the brand, above everything else, and it is NOT part of the board:
     the search bar belongs to the piece you are displaying, not to the one
     running past the Ethereum marks.
     Plain GET form, no autofocus, so the first space bar still jumps. It opens
     in a new tab here so this preview page survives the click. */
  /* Three columns: plate, search, and an empty third exactly as wide as the
     plate, so the middle track's centre lands on the page's centre and the bar
     takes every pixel the two leave. The outer tracks are a fixed width, not
     1fr — an fr track whose min-content exceeds its share freezes there while
     the empty one collapses, which pushed the bar 61px right of centre. Same
     reasoning and the same structure as pages/page.css.
     Plate here: 96px canvas + 10px padding each side + 1px border each side. */
  .ntbar { display: block; }
  .ntbar .search { max-width: 640px; margin: 0 auto; }
  .idle { display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; }
  /* The clearing: a fixed canvas behind everything, exactly as the extension
     mounts it. Click-through, so it can never eat a press meant for the page. */
  .scene { position: fixed; inset: 0; z-index: -1; width: 100%; height: 100%; image-rendering: pixelated; pointer-events: none; }
  body.playing .scene { opacity: 0.35; }
  /* Glass over the scene, so a pill never lands invisibly on grass. */
  .search input[type="search"], .idle button, .hud, .controls, .panel { backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
  .chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--mute); border-radius: 999px; padding: 4px 6px 4px 12px; font-size: 13px; }
  .chip button { min-height: 28px; padding: 2px 10px; font-size: 11px; }
  #ntPortrait { image-rendering: pixelated; border-radius: 8px; background: var(--paper); }
  .plate { flex: none; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px; line-height: 0; }
  /* stretch, not center — the input's box is taller than the button's fixed
     min-height, and mismatched pill heights read as a mistake. */
  .search { display: flex; align-items: stretch; gap: 10px; width: 100%; }
  .search input[type="search"] {
    flex: 1; min-width: 0; font: inherit; font-size: 17px;
    background: var(--paper); color: var(--ink); caret-color: var(--pink);
    border: 1px solid var(--mute); border-radius: 999px; padding: 16px 26px; min-height: 56px;
    appearance: none;
  }
  .search input[type="search"]::-webkit-search-decoration,
  .search input[type="search"]::-webkit-search-cancel-button { appearance: none; }
  .search input[type="search"]::placeholder { color: var(--mute); }
  .search button { flex: none; min-height: 56px; padding: 10px 26px; }

  /* Board height is set by the jump arc, exactly as pages/page.css sets it —
     keep the two in step. The runner is a fixed 84 CSS px tall, the ground sits
     at 0.86 * H and the apex is 1.33 sprite heights above it, so the sprite's
     top at apex is 0.86 * H - 195px. The old 5/2 left that 40px from the top
     edge on a 1280px desktop and 74px ABOVE it on a 390px phone. */
  #stage {
    position: relative; width: 100%; aspect-ratio: 2 / 1;
    min-height: min(340px, calc(100vh - 300px));
    max-height: calc(100vh - 300px);
    background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
  }
  /* Absolute so the board's height comes from the bounds above and nothing else. */
  #run { position: absolute; inset: 0; width: 100%; height: 100%; display: block; image-rendering: pixelated; }

  .hud { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-variant-numeric: tabular-nums; }
  .hud .score { font-size: 22px; font-weight: 700; }
  .hud .hi { color: var(--mute); font-size: 13px; }
  .hint { color: var(--mute); font-size: 13px; }
  .controls { text-align: center; margin: 0; }
  .err { color: var(--pink); font-size: 13px; min-height: 1.2em; }
  .hidden { display: none !important; }
  kbd { background: var(--paper); border: 1px solid var(--mute); border-bottom-width: 2px; border-radius: 5px; padding: 1px 6px; font: inherit; font-size: 12px; color: var(--ink); }
  /* Pushed to the bottom, so the credit line does not float in the middle of
     the sky once the board is put away and the clearing is the page. */
  .wrap { min-height: 100vh; }
  footer { color: var(--mute); font-size: 12px; margin-top: auto; }
  footer a { color: var(--pink); }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>

<canvas id="scene" class="scene" aria-hidden="true"></canvas>

<div class="wrap">
  <header>
    <div class="brand">upeg<b>RUN</b></div>
    <div class="eyebrow">extension preview</div>
  </header>

  <div class="ntbar hidden" id="ntbar">
    <form class="search" id="searchForm" role="search" action="https://www.google.com/search"
          method="get" target="_blank" rel="noopener">
      <input type="search" id="searchInput" name="q" placeholder="Search Google"
             aria-label="Search Google" autocomplete="off" spellcheck="false" enterkeyhint="search" />
      <button type="submit">SEARCH</button>
    </form>
  </div>

  <div class="idle hidden" id="idle">
    <button id="playBtn" class="primary">PLAY UPEGRUN</button>
    <button id="modeBtn">AUTO</button>
    <button id="changeBtn2">EDIT THE CLEARING</button>
  </div>

  <section class="panel" id="setup">
    <div class="row">
      <label for="pieceInput">Your peg</label>
      <input id="pieceInput" type="number" inputmode="numeric" min="1" placeholder="e.g. 37" />
      <button id="loadBtn" class="pink">ADD</button>
      <button id="randomBtn">RANDOM</button>
    </div>
    <div class="row" id="rosterRow"></div>
    <div class="err" id="err"></div>
    <div class="row">
      <button id="lockBtn" class="primary hidden">ENTER THE CLEARING</button>
    </div>
    <div class="hint" id="aliveLine"></div>
  </section>

  <div id="stage" class="hidden"><canvas id="run"></canvas></div>

  <div class="hud hidden" id="hud">
    <div class="score" id="score">0</div>
    <div class="hi">BEST <span id="high">0</span></div>
    <button id="changeBtn">CHANGE PEG</button>
  </div>

  <!-- Under the board, same as pages/newtab.html: in the board they were a
       second banner line that vanished the moment you started. -->
  <p class="hint controls hidden" id="controls">
    <kbd>Space</kbd> or <kbd>↑</kbd> to jump · <kbd>↓</kbd> to duck · dodge the Ethereum marks,
    duck the black winged unipeg
  </p>

  <footer>
    Runs entirely offline — the art is rebuilt from on-chain layer data bundled into this page.
    Same code the Chrome extension ships. <a href="https://upegpfp.art" target="_blank" rel="noopener">upegpfp.art</a>
  </footer>
</div>

<script>
  // ── bundled data ──────────────────────────────────────────────────────
  const ALIVE_SNAPSHOT = ${alive};
  ${layers}

  // The modules load the snapshot through fetch() so the extension can serve
  // it from its own bundle. Here we answer that one request from memory —
  // the module source stays untouched.
  const _fetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = (url, ...rest) =>
    String(url).includes("upeg-alive.json")
      ? Promise.resolve({ ok: true, json: () => Promise.resolve(ALIVE_SNAPSHOT) })
      : (_fetch ? _fetch(url, ...rest) : Promise.reject(new Error("offline")));
</script>

<script>
// ── extension modules, verbatim ─────────────────────────────────────────
${upeg}
${sprite}
${game}
${scene}

// ── page ────────────────────────────────────────────────────────────────
// Same object pages/page.js hands to startGame — light column, keys unchanged.
const PALETTE = { paper: "#ffffff", ink: "#0b0b0d", pink: "#d8006e", mute: "#66666e", card: "#f4f3f5", line: "#e7e4e7", accent: "#d8006e" };
const el = (id) => document.getElementById(id);
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const deviceScale = () => Math.max(1, Math.min(3, Math.round(window.devicePixelRatio || 1)));
const state = { id: null, grid: null, frames: null, palette: [], game: null, roster: [], scene: null, mode: "auto" };
const ROSTER_MAX = 6;

function fitCanvas(canvas, w, h) {
  const r = deviceScale();
  canvas.width = Math.max(1, Math.round(w * r));
  canvas.height = Math.max(1, Math.round(h * r));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
}

// The score bar under the board is the only place the best score is shown.
function setBest(n) {
  el("high").textContent = String(n);
}

/* ── the clearing ────────────────────────────────────────────────────── */

// The page's own colours follow the scene's, exactly as pages/page.js does it:
// the chrome floats over the clearing, so if the sky goes dark and the tokens
// do not, the search bar is black text on a black field.
function applySceneTokens(pal) {
  const r = document.documentElement.style;
  const night = pal.name === "night";
  r.setProperty("--ink", pal.ink);
  r.setProperty("--paper", pal.paper);
  r.setProperty("--mute", night ? "#A8A5B4" : "#5A5763");
  r.setProperty("--card", night ? "rgba(20,20,28,0.72)" : "rgba(255,255,255,0.78)");
  r.setProperty("--line", night ? "rgba(247,247,248,0.16)" : "rgba(11,11,13,0.12)");
  r.setProperty("--pink", night ? "#FF4DA1" : "#C4005F");
  document.documentElement.style.colorScheme = night ? "dark" : "light";
}

function paintRoster() {
  const row = el("rosterRow");
  row.textContent = "";
  for (const id of state.roster) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const n = document.createElement("span");
    n.textContent = "#" + id;
    const x = document.createElement("button");
    x.textContent = "REMOVE";
    x.onclick = () => { state.roster = state.roster.filter((v) => v !== id); paintRoster(); };
    chip.append(n, x);
    row.append(chip);
  }
  el("lockBtn").classList.toggle("hidden", state.roster.length === 0);
  el("loadBtn").disabled = state.roster.length >= ROSTER_MAX;
}

async function bootScene() {
  const byKey = {};
  for (const id of state.roster) {
    const grid = gridFromSeed(await seedForId(id));
    for (const s of LANE_SCALES) {
      const f = buildRunFrames(grid, { scale: s * deviceScale() });
      byKey[frameKey(id, s)] = { walk: f, duck: f.duck };
    }
  }
  const pal = paletteFor(state.mode, new Date().getHours());
  applySceneTokens(pal);
  if (state.scene) state.scene.stop();
  state.scene = startScene({
    canvas: el("scene"), ids: state.roster, framesByKey: byKey, palette: pal, reducedMotion: reduced,
  });
  el("modeBtn").textContent =
    state.mode === "auto" ? "AUTO · " + resolveMode("auto", new Date().getHours()) : state.mode;
}

// The pause rule: off screen, off. Same rule the extension ships.
function syncSceneMotion() {
  if (!state.scene) return;
  if (document.visibilityState === "hidden" || document.body.classList.contains("playing") || reduced) {
    state.scene.pause();
  } else {
    state.scene.play();
  }
}
document.addEventListener("visibilitychange", syncSceneMotion);

async function addPeg(id) {
  el("err").textContent = "";
  const seed = await seedForId(id);
  if (seed === null) {
    el("err").textContent = "#" + id + " isn't in the offline collection — try another number.";
    return false;
  }
  if (state.roster.includes(id)) { el("err").textContent = "#" + id + " is already grazing."; return false; }
  if (state.roster.length >= ROSTER_MAX) { el("err").textContent = "The clearing holds " + ROSTER_MAX + "."; return false; }
  state.roster.push(id);
  // The first piece added is the one the runner uses.
  if (state.id === null) { state.id = id; state.grid = gridFromSeed(seed); state.palette = paletteFromGrid(state.grid); }
  paintRoster();
  return true;
}

async function enterClearing() {
  el("setup").classList.add("hidden");
  el("ntbar").classList.remove("hidden");
  el("idle").classList.remove("hidden");
  await bootScene();
  syncSceneMotion();
}

async function play() {
  document.body.classList.add("playing");
  syncSceneMotion();
  state.frames = buildRunFrames(state.grid, { scale: Math.min(8, 4 * deviceScale()) });
  el("stage").classList.remove("hidden");
  el("hud").classList.remove("hidden");
  el("controls").classList.remove("hidden");
  el("idle").classList.add("hidden");
  el("setup").classList.add("hidden");
  const stage = el("stage");
  const canvas = el("run");
  // Content box, not border box — the 1px border would otherwise push a row of
  // the board out under overflow:hidden, including the top row the arc uses.
  fitCanvas(canvas, stage.clientWidth, stage.clientHeight);
  setBest(await loadHighScore());
  if (state.game) state.game.stop();
  state.game = startGame({
    canvas,
    frames: state.frames,
    palette: { ...PALETTE, bg: state.grid.bg, piece: state.palette },
    // game.js signature: (score, { high, state })
    onScore: (score, meta) => {
      el("score").textContent = String(score);
      if (meta && Number.isFinite(meta.high)) setBest(meta.high);
    },
    scale: deviceScale(),
    reducedMotion: reduced,
  });
  canvas.focus();
}

el("loadBtn").onclick = () => addPeg(Number(el("pieceInput").value));
el("pieceInput").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); el("loadBtn").click(); } };
el("randomBtn").onclick = async () => {
  const ids = await aliveIds();
  const id = ids[Math.floor(Math.random() * ids.length)];
  el("pieceInput").value = String(id);
  addPeg(id);
};
el("lockBtn").onclick = () => enterClearing();
el("playBtn").onclick = () => play();
el("modeBtn").onclick = () => {
  state.mode = { auto: "day", day: "night", night: "auto" }[state.mode];
  const pal = paletteFor(state.mode, new Date().getHours());
  applySceneTokens(pal);
  if (state.scene) state.scene.setPalette(pal);
  el("modeBtn").textContent =
    state.mode === "auto" ? "AUTO · " + resolveMode("auto", new Date().getHours()) : state.mode;
};
// Leaving the board puts you back in the SAME clearing — the scene kept its
// state while it was paused, so nobody's pieces teleport.
el("changeBtn").onclick = () => {
  if (state.game) { state.game.stop(); state.game = null; }
  document.body.classList.remove("playing");
  el("stage").classList.add("hidden");
  el("hud").classList.add("hidden");
  el("controls").classList.add("hidden");
  el("idle").classList.remove("hidden");
  syncSceneMotion();
};
el("changeBtn2").onclick = () => {
  if (state.scene) { state.scene.stop(); state.scene = null; }
  el("ntbar").classList.add("hidden");
  el("idle").classList.add("hidden");
  el("setup").classList.remove("hidden");
};

// The one thing markup cannot do: refuse an empty query rather than opening a
// blank results page. Deliberately no autofocus — see pages/newtab.html.
el("searchForm").addEventListener("submit", (e) => {
  const q = el("searchInput");
  if (q.value.trim() === "") { e.preventDefault(); q.focus(); return; }
  q.value = q.value.trim();
});
el("searchInput").addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  el("searchInput").value = "";
  el("searchInput").blur();
  el("run").focus();
});
// Height counts as well as width: the board is bounded by calc(100vh - …), and
// the clearing is laid out from its canvas size, so both re-solve.
window.addEventListener("resize", () => {
  if (state.scene) state.scene.resize();
  if (!state.game) return;
  const stage = el("stage");
  fitCanvas(el("run"), stage.clientWidth, stage.clientHeight);
});

(async () => {
  const n = await aliveCount();
  el("aliveLine").textContent =
    n.toLocaleString() + " pieces bundled — all searchable with no connection. Add up to " +
    ROSTER_MAX + " to the clearing.";
  const ids = await aliveIds();
  // Four to start with, spread across the collection, so the clearing has
  // something in it the moment the page opens.
  const seed = [185206, ids[0], ids[Math.floor(ids.length / 3)], ids[ids.length - 1]];
  for (const id of seed) if (ids.includes(id)) await addPeg(id);
  el("pieceInput").value = String(ids[Math.floor(ids.length / 2)]);
  paintRoster();
  await enterClearing();
})();
</script>
`;

writeFileSync(OUT, html);
console.log("wrote", OUT, (html.length / 1024).toFixed(0) + "KB");
