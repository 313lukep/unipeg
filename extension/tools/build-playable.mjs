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

const html = `<title>unipegPFP Runner — play your Unipeg</title>
<style>
  :root {
    /* Committed dark arcade palette — the extension's own screen tokens. */
    --paper: #0b0b0d;
    --ink: #f7f7f8;
    --pink: #ff4da1;
    --mute: #9c9ca6;
    --card: #161619;
    --line: #232326;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    color-scheme: dark;
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
    -webkit-font-smoothing: antialiased;
  }
  .wrap {
    width: 100%;
    max-width: 720px;
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
    border: 2px solid var(--line); border-radius: 8px; padding: 10px 12px; width: 150px;
    -moz-appearance: textfield;
  }
  input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  button {
    font: inherit; font-size: 13px; font-weight: 700; letter-spacing: 0.04em;
    background: var(--paper); color: var(--ink); border: 2px solid var(--line);
    border-radius: 999px; padding: 10px 18px; min-height: 44px; cursor: pointer;
  }
  button.primary { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  button.pink { border-color: var(--pink); color: var(--pink); }
  button:hover { border-color: var(--pink); }
  :focus-visible { outline: 2px solid var(--pink); outline-offset: 2px; }

  .preview { display: flex; align-items: center; gap: 14px; }
  #portrait { image-rendering: pixelated; border-radius: 8px; background: var(--paper); }
  .pieceNum { font-size: 26px; font-weight: 700; }
  .pieceNum span { color: var(--pink); font-size: 0.6em; vertical-align: top; }

  #stage { position: relative; width: 100%; aspect-ratio: 5 / 2; background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  #run { width: 100%; height: 100%; display: block; image-rendering: pixelated; }

  .hud { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-variant-numeric: tabular-nums; }
  .hud .score { font-size: 22px; font-weight: 700; }
  .hud .hi { color: var(--mute); font-size: 13px; }
  .hint { color: var(--mute); font-size: 13px; }
  .err { color: var(--pink); font-size: 13px; min-height: 1.2em; }
  .hidden { display: none !important; }
  kbd { background: var(--paper); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; padding: 1px 6px; font: inherit; font-size: 12px; color: var(--ink); }
  footer { color: var(--mute); font-size: 12px; }
  footer a { color: var(--pink); }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
</style>

<div class="wrap">
  <header>
    <div class="brand">unipeg<b>PFP</b> runner</div>
    <div class="eyebrow">extension preview</div>
  </header>

  <section class="panel" id="setup">
    <div class="row">
      <label for="pieceInput">Your peg</label>
      <input id="pieceInput" type="number" inputmode="numeric" min="1" placeholder="e.g. 37" />
      <button id="loadBtn" class="pink">PREVIEW</button>
      <button id="randomBtn">RANDOM</button>
    </div>
    <div class="preview hidden" id="previewRow">
      <canvas id="portrait" width="96" height="96"></canvas>
      <div>
        <div class="pieceNum"><span>#</span><i id="previewNum" style="font-style:normal"></i></div>
        <div class="hint">This is the piece that runs.</div>
      </div>
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
const PALETTE = { paper: "#0b0b0d", ink: "#f7f7f8", pink: "#ff4da1", mute: "#9c9ca6", card: "#161619", line: "#232326", accent: "#ff4da1" };
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

function drawPortrait(grid) {
  const c = el("portrait");
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
    el("previewRow").classList.add("hidden");
    el("lockBtn").classList.add("hidden");
    el("err").textContent = "#" + id + " isn't in the offline collection — try another number.";
    return false;
  }
  state.id = id;
  state.grid = gridFromSeed(seed);
  state.palette = paletteFromGrid(state.grid);
  drawPortrait(state.grid);
  el("previewNum").textContent = String(id);
  el("previewRow").classList.remove("hidden");
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
  const rect = stage.getBoundingClientRect();
  fitCanvas(canvas, rect.width, rect.height);
  el("high").textContent = String(await loadHighScore());
  if (state.game) state.game.stop();
  state.game = startGame({
    canvas,
    frames: state.frames,
    palette: { ...PALETTE, bg: state.grid.bg, piece: state.palette },
    // game.js signature: (score, { high, state })
    onScore: (score, meta) => {
      el("score").textContent = String(score);
      if (meta && Number.isFinite(meta.high)) el("high").textContent = String(meta.high);
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
el("changeBtn").onclick = () => {
  if (state.game) { state.game.stop(); state.game = null; }
  el("stage").classList.add("hidden");
  el("hud").classList.add("hidden");
  el("controls").classList.add("hidden");
  el("setup").classList.remove("hidden");
};
window.addEventListener("resize", () => {
  if (!state.game) return;
  const stage = el("stage");
  fitCanvas(el("run"), stage.getBoundingClientRect().width, stage.getBoundingClientRect().height);
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
