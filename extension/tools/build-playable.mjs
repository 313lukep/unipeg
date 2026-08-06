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
  .ntbar { display: flex; align-items: center; gap: 20px; }
  .ntbody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  .ntsub { margin: 0; color: var(--mute); font-size: 13px; }
  .ntsub b { color: var(--ink); }
  .ntsub .hash { color: var(--pink); }
  #ntPortrait { image-rendering: pixelated; border-radius: 8px; background: var(--paper); }
  .plate { flex: none; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px; line-height: 0; }
  .search { display: flex; align-items: center; gap: 10px; }
  .search input[type="search"] {
    flex: 1; min-width: 0; font: inherit; font-size: 16px;
    background: var(--paper); color: var(--ink); caret-color: var(--pink);
    border: 1px solid var(--mute); border-radius: 999px; padding: 12px 20px; min-height: 48px;
    appearance: none;
  }
  .search input[type="search"]::-webkit-search-decoration,
  .search input[type="search"]::-webkit-search-cancel-button { appearance: none; }
  .search input[type="search"]::placeholder { color: var(--mute); }
  .search button { flex: none; min-height: 48px; }

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
  .err { color: var(--pink); font-size: 13px; min-height: 1.2em; }
  .hidden { display: none !important; }
  kbd { background: var(--paper); border: 1px solid var(--mute); border-bottom-width: 2px; border-radius: 5px; padding: 1px 6px; font: inherit; font-size: 12px; color: var(--ink); }
  footer { color: var(--mute); font-size: 12px; }
  footer a { color: var(--pink); }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>

<div class="wrap">
  <header>
    <div class="brand">upeg<b>RUN</b></div>
    <div class="eyebrow">extension preview</div>
  </header>

  <div class="ntbar hidden" id="ntbar">
    <div class="plate"><canvas id="ntPortrait" width="96" height="96" role="img" aria-label="Your Unipeg"></canvas></div>
    <div class="ntbody">
      <form class="search" id="searchForm" role="search" action="https://www.google.com/search"
            method="get" target="_blank" rel="noopener">
        <input type="search" id="searchInput" name="q" placeholder="Search Google"
               aria-label="Search Google" autocomplete="off" spellcheck="false" enterkeyhint="search" />
        <button type="submit">SEARCH</button>
      </form>
      <p class="ntsub">
        Peg <b><span class="hash">#</span><span id="pieceDigits">&mdash;</span></b>
        &middot; best <b id="bestInline">0</b>.
      </p>
    </div>
  </div>

  <section class="panel" id="setup">
    <div class="row">
      <label for="pieceInput">Your peg</label>
      <input id="pieceInput" type="number" inputmode="numeric" min="1" placeholder="e.g. 37" />
      <button id="loadBtn" class="pink">PREVIEW</button>
      <button id="randomBtn">RANDOM</button>
    </div>
    <div class="err" id="err"></div>
    <div class="row">
      <button id="lockBtn" class="primary hidden">LOCK IN &amp; PLAY</button>
    </div>
    <div class="hint" id="aliveLine"></div>
  </section>

  <div id="stage" class="hidden"><canvas id="run"></canvas></div>

  <div class="hud hidden" id="hud">
    <div class="score" id="score">0</div>
    <div class="hi">BEST <span id="high">0</span></div>
    <button id="changeBtn">CHANGE PEG</button>
  </div>

  <p class="hint hidden" id="controls">
    <kbd>Space</kbd> or <kbd>↑</kbd> jump · <kbd>↓</kbd> duck · dodge the Ethereum marks,
    duck the black winged unipeg.
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

// ── page ────────────────────────────────────────────────────────────────
// Same object pages/page.js hands to startGame — light column, keys unchanged.
const PALETTE = { paper: "#ffffff", ink: "#0b0b0d", pink: "#d8006e", mute: "#66666e", card: "#f4f3f5", line: "#e7e4e7", accent: "#d8006e" };
const el = (id) => document.getElementById(id);
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const deviceScale = () => Math.max(1, Math.min(3, Math.round(window.devicePixelRatio || 1)));
const state = { id: null, grid: null, frames: null, palette: [], game: null };

function fitCanvas(canvas, w, h) {
  const r = deviceScale();
  canvas.width = Math.max(1, Math.round(w * r));
  canvas.height = Math.max(1, Math.round(h * r));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
}

// Best shows twice — in the header line and in the score bar — so both move
// together or neither does.
function setBest(n) {
  const s = String(n);
  el("high").textContent = s;
  el("bestInline").textContent = s;
}

// One portrait on the page, and it lives in the header beside the search bar —
// the piece you are DISPLAYING. The one on the board is a different animal.
function drawPortrait(grid) {
  const c = el("ntPortrait");
  const cell = 4 * deviceScale();
  c.width = 24 * cell; c.height = 24 * cell;
  c.style.width = c.style.height = 24 * 4 + "px";
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  drawGrid(ctx, grid, cell, 0, 0);
}

async function preview(id) {
  el("err").textContent = "";
  const seed = await seedForId(id);
  if (seed === null) {
    el("ntbar").classList.add("hidden");
    el("lockBtn").classList.add("hidden");
    el("err").textContent = "#" + id + " isn't in the offline collection — try another number.";
    return false;
  }
  state.id = id;
  state.grid = gridFromSeed(seed);
  state.palette = paletteFromGrid(state.grid);
  drawPortrait(state.grid);
  el("pieceDigits").textContent = String(id);
  el("ntbar").classList.remove("hidden");
  el("lockBtn").classList.remove("hidden");
  return true;
}

async function play() {
  state.frames = buildRunFrames(state.grid, { scale: Math.min(8, 4 * deviceScale()) });
  el("stage").classList.remove("hidden");
  el("hud").classList.remove("hidden");
  el("controls").classList.remove("hidden");
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

el("loadBtn").onclick = () => preview(Number(el("pieceInput").value));
el("pieceInput").onkeydown = (e) => { if (e.key === "Enter") el("loadBtn").click(); };
el("randomBtn").onclick = async () => {
  const ids = await aliveIds();
  const id = ids[Math.floor(Math.random() * ids.length)];
  el("pieceInput").value = String(id);
  preview(id);
};
el("lockBtn").onclick = () => play();
// The header stays put — you are still displaying a piece, so the piece and the
// search bar stay where they are. Only the board goes away.
el("changeBtn").onclick = () => {
  if (state.game) { state.game.stop(); state.game = null; }
  el("stage").classList.add("hidden");
  el("hud").classList.add("hidden");
  el("controls").classList.add("hidden");
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
// Height counts as well as width: the board is bounded by calc(100vh - …).
window.addEventListener("resize", () => {
  if (!state.game) return;
  const stage = el("stage");
  fitCanvas(el("run"), stage.clientWidth, stage.clientHeight);
});

(async () => {
  const n = await aliveCount();
  el("aliveLine").textContent = n.toLocaleString() + " pieces bundled — all searchable with no connection.";
  const ids = await aliveIds();
  const start = ids.includes(185206) ? 185206 : ids[0];
  el("pieceInput").value = String(start);
  await preview(start);
})();
</script>
`;

writeFileSync(OUT, html);
console.log("wrote", OUT, (html.length / 1024).toFixed(0) + "KB");
