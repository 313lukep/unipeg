/**
 * upegRUN — Offline Unipeg · shared page script for offline.html + newtab.html.
 *
 * Both entries share everything below the header: the setup panel, the piece
 * portrait, the runner, the score bar and settings. The only per-mode difference
 * is `body[data-mode]` and the header markup each HTML file ships.
 *
 * The render path never touches the network. The renderer, the layer data and
 * the id -> seed snapshot are all bundled with the extension; that is the whole
 * point. The single exception lives in resolve.js and is opt-in: an id minted
 * after this build was packaged cannot be in the bundle, so we offer to fetch it
 * once. Everything else — including every piece you have already locked in —
 * works with the network completely off.
 */

import { resolvePiece, missMessage, canFetch } from "./resolve.js";

// The `upegpfp.` prefix predates the rename to upegRUN and is deliberately kept:
// changing it would un-lock the piece of everyone already running the extension.
const KEY = {
  piece: "upegpfp.pieceId",
  locked: "upegpfp.pieceLocked",
  high: "upegpfp.highScore",
  newtab: "upegpfp.newtabEnabled",
  roster: "upegpfp.roster",
  sceneMode: "upegpfp.sceneMode",
};

/** How many pieces may graze at once. Six fills three lanes twice over. */
const ROSTER_MAX = 6;

/** The project's mascot — a guaranteed-alive piece, offered during setup. */
const MASCOT = 185206;
const MAX_ID = 400000;

const MODE = document.body.dataset.mode === "offline" ? "offline" : "newtab";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const el = (id) => document.getElementById(id);

/**
 * Light-page tokens from docs/DESIGN.md (light column), handed to the game so
 * the board paints on the same white ground as the page around it. These are
 * the same values page.css sets on :root — keep the two in step. The pink is
 * the light-mode #D8006E, not the dark-mode #FF4DA1, which fails AA on white.
 */
const PALETTE = {
  paper: "#FFFFFF",
  ink: "#0B0B0D",
  pink: "#D8006E",
  mute: "#66666E",
  card: "#F4F3F5",
  line: "#E7E4E7",
  accent: "#D8006E",
};

const state = {
  pieceId: null,
  locked: false,
  high: 0,
  newtabEnabled: true,
  game: null,
  frames: null,
  grid: null,
  piecePalette: [],
  aliveCount: null,
  applyingOwnChange: false,
  // The clearing
  scene: null,
  sceneMode: "auto",
  roster: [],
  sceneFrames: null,
  // Setup panel
  previewId: null,
  previewToken: 0,
  pendingFetchId: null,
};

/* ── storage ──────────────────────────────────────────────────────────── */

function getStore(keys) {
  return chrome.storage.local.get(keys);
}

async function setStore(values) {
  state.applyingOwnChange = true;
  try {
    await chrome.storage.local.set(values);
  } finally {
    // Released on the next task so our own onChanged callback sees the flag.
    setTimeout(() => {
      state.applyingOwnChange = false;
    }, 0);
  }
}

/* ── helpers ──────────────────────────────────────────────────────────── */

/** Ids are global mint serials, not 1–10000. Validate 1..400000, integers only. */
function parseId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ID) return null;
  return n;
}

/** Integer device scale, so every cell stays a whole number of device pixels. */
function deviceScale() {
  return Math.max(1, Math.round(window.devicePixelRatio || 1));
}

function fitCanvas(canvas, cssWidth, cssHeight) {
  const k = deviceScale();
  const w = Math.max(1, Math.floor(cssWidth));
  const h = Math.max(1, Math.floor(cssHeight));
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.width = w * k;
  canvas.height = h * k;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** Only http(s) survives — `from` arrives in a query string and must not be trusted. */
function safeFrom(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function show(node, visible) {
  if (node) node.hidden = !visible;
}

function setText(id, text) {
  const node = el(id);
  if (node) node.textContent = text;
}

/* ── bundled renderer (no network, ever) ──────────────────────────────── */

const lib = { upeg: null, sprite: null, game: null, scene: null };

async function loadLibs() {
  if (lib.upeg && lib.sprite) return true;
  try {
    const [upeg, sprite] = await Promise.all([
      import("../lib/upeg.js"),
      import("../lib/sprite.js"),
    ]);
    lib.upeg = upeg;
    lib.sprite = sprite;
  } catch (err) {
    console.error("upegRUN: renderer failed to load", err);
    return false;
  }
  // The game and the clearing are both nice-to-haves; neither may cost you the
  // artwork if it fails to load.
  try {
    lib.game = await import("../lib/game.js");
  } catch (err) {
    console.error("upegRUN: game failed to load", err);
  }
  try {
    lib.scene = await import("../lib/scene.js");
  } catch (err) {
    console.error("upegRUN: the clearing failed to load", err);
  }
  return true;
}

/* ── rendering ────────────────────────────────────────────────────────── */

/**
 * Sizes a 24x24 canvas so one grid cell is always a whole number of device
 * pixels. `basePx` is CSS px per cell; the device scale multiplies it, and both
 * are integers, so the piece is never resampled.
 */
function pixelTarget(canvasId, basePx) {
  const canvas = el(canvasId);
  if (!canvas) return null;
  const cellPx = basePx * deviceScale(); // device px per cell — always an integer
  canvas.width = 24 * cellPx;
  canvas.height = 24 * cellPx;
  canvas.style.width = 24 * basePx + "px";
  canvas.style.height = 24 * basePx + "px";
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  return { ctx, cellPx, canvas };
}

function portraitTarget() {
  return pixelTarget("portrait", window.innerWidth < 560 ? 3 : 4);
}

function previewTarget() {
  return pixelTarget("setupPreview", window.innerWidth < 560 ? 4 : 5);
}

function drawPortrait(grid) {
  const target = portraitTarget();
  if (!target) return;
  lib.sprite.drawGrid(target.ctx, grid, target.cellPx, 0, 0);
}

/**
 * Empty state from docs/DESIGN.md: a blank 24x24 ghost grid with one lone pink
 * pixel at cell (12,4) — where a horn would be. It does not blink; it waits.
 */
function drawGhost(target) {
  if (!target) return;
  const { ctx, cellPx, canvas } = target;
  const rule = deviceScale();
  // Paper, not card: the plate behind this canvas is already --card, so a card
  // fill would leave the empty grid with no edge at all on a light page. Paper
  // makes the 24x24 square read as the sheet the art will land on.
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = PALETTE.line;
  for (let i = 4; i < 24; i += 4) {
    ctx.fillRect(i * cellPx, 0, rule, canvas.height);
    ctx.fillRect(0, i * cellPx, canvas.width, rule);
  }
  ctx.fillStyle = PALETTE.pink;
  ctx.fillRect(12 * cellPx, 4 * cellPx, cellPx, cellPx);
}

function stopGame() {
  if (state.game && typeof state.game.stop === "function") {
    try {
      state.game.stop();
    } catch (err) {
      console.error("upegRUN: game stop failed", err);
    }
  }
  state.game = null;
}

function bootGame() {
  const stage = el("stage");
  const canvas = el("run");
  if (!lib.game || !stage || !canvas || !state.frames) return;
  stopGame();
  // clientWidth/clientHeight, not getBoundingClientRect: the stage carries a 1px
  // border, and fitting the canvas to the border box made it overhang the board
  // by a pixel on each side. Overflow hid it, but the pixel it hid was a row of
  // the board — including the top row the jump arc is now measured against.
  fitCanvas(canvas, stage.clientWidth, stage.clientHeight);
  try {
    state.game = lib.game.startGame({
      canvas,
      frames: state.frames,
      palette: {
        ...PALETTE,
        bg: state.grid ? state.grid.bg : PALETTE.card,
        // The piece's own colours, most-used first — obstacles can wear them.
        piece: state.piecePalette || [],
      },
      onScore: handleScore,
      scale: deviceScale(),
      reducedMotion,
    });
  } catch (err) {
    console.error("upegRUN: game failed to start", err);
    setHint("Runner unavailable — the artwork is still yours");
  }
}

/* ── the clearing ─────────────────────────────────────────────────────── */

/**
 * The scene's palette drives the PAGE's palette, not the other way round.
 *
 * The chrome floats over the clearing, so if the sky goes to near-black at
 * 6pm and the tokens do not follow, the search bar is black text on a black
 * field. `scene.js` publishes `ink`/`paper` in both palettes for exactly this,
 * and `--card`/`--line`/`--mute` are derived here so the pills read as glass
 * sitting on the scene rather than as opaque cards punched through it.
 */
function applySceneTokens(pal) {
  const root = document.documentElement.style;
  const night = pal.name === "night";
  root.setProperty("--ink", pal.ink);
  root.setProperty("--paper", pal.paper);
  root.setProperty("--mute", night ? "#A8A5B4" : "#5A5763");
  root.setProperty("--card", night ? "rgba(20,20,28,0.72)" : "rgba(255,255,255,0.78)");
  root.setProperty("--line", night ? "rgba(247,247,248,0.16)" : "rgba(11,11,13,0.12)");
  root.setProperty("--pink", night ? "#FF4DA1" : "#C4005F");
  document.documentElement.style.colorScheme = night ? "dark" : "light";
}

const MODE_LABEL = { auto: "Auto", day: "Day", night: "Night" };
const MODE_NEXT = { auto: "day", day: "night", night: "auto" };

function currentPalette() {
  return lib.scene.paletteFor(state.sceneMode, new Date().getHours());
}

function paintModeButton() {
  const btn = el("modeBtn");
  if (!btn || !lib.scene) return;
  const resolved = lib.scene.resolveMode(state.sceneMode, new Date().getHours());
  btn.textContent = state.sceneMode === "auto" ? `Auto · ${resolved}` : MODE_LABEL[state.sceneMode];
  btn.title = "Day / night — Auto follows your clock";
}

/**
 * Build the walk + graze frames every grazer needs, at the three lane scales.
 *
 * Keyed by piece id and then by scale, so six pieces on three depths is six
 * decodes and eighteen frame sets — measured at ~10ms and under a megabyte for
 * a five-piece roster, which is the whole reason this feature is affordable on
 * a page that opens a hundred times a day.
 */
async function buildSceneFrames(ids) {
  const byId = {};
  // Only the ids that actually resolved come back. An id that is not in the
  // bundle used to still get a lane and a wander, and then drew nothing — an
  // invisible grazer taking up one of the six places in the clearing.
  const drawn = [];
  for (const id of ids) {
    const seed = await resolvePiece(lib.upeg, id, { allowNetwork: false });
    if (seed.seed === null || seed.seed === undefined) continue;
    drawn.push(id);
    const grid = await lib.upeg.gridFromSeed(seed.seed);
    // One entry per lane scale; the scene picks the one its lane was laid out
    // for, so every sprite lands on whole device pixels with no resampling.
    // The key stays in scene cells (2/3/4) while the render is in DEVICE pixels
    // — multiply by the ratio here and the sprite matches the scene's unit,
    // which is the front lane's own 4 x ratio.
    for (const scale of lib.scene.LANE_SCALES) {
      const frames = lib.sprite.buildRunFrames(grid, { scale: scale * deviceScale() });
      byId[lib.scene.frameKey(id, scale)] = { walk: frames, duck: frames.duck };
    }
  }
  return { byId, drawn };
}

async function bootScene() {
  const canvas = el("scene");
  if (!canvas || MODE !== "newtab" || !lib.scene || !lib.sprite || !lib.upeg) return;
  const ids = state.roster.length ? state.roster : state.pieceId != null ? [state.pieceId] : [];
  if (!ids.length) return;

  const { byId: byKey, drawn } = await buildSceneFrames(ids);
  state.sceneFrames = byKey;
  const pal = currentPalette();
  applySceneTokens(pal);
  if (!drawn.length) return;

  if (state.scene) state.scene.stop();
  try {
    state.scene = lib.scene.startScene({
      canvas,
      ids: drawn,
      framesByKey: byKey,
      palette: pal,
      reducedMotion,
    });
  } catch (err) {
    console.error("upegRUN: the clearing failed to start", err);
    state.scene = null;
    return;
  }
  paintModeButton();
  syncSceneMotion();
}

/**
 * THE PAUSE RULE. The clearing animates only when it is on screen, in front,
 * and not behind the board. A new tab left open in a background window costs
 * nothing at all — this is the difference between a nice extension and the one
 * you uninstall because your laptop is warm.
 */
function syncSceneMotion() {
  if (!state.scene) return;
  const hidden = document.visibilityState === "hidden";
  const playing = document.body.classList.contains("playing");
  if (hidden || playing || reducedMotion) state.scene.pause();
  else state.scene.play();
}

function cycleSceneMode() {
  state.sceneMode = MODE_NEXT[state.sceneMode] || "auto";
  const pal = currentPalette();
  applySceneTokens(pal);
  if (state.scene) state.scene.setPalette(pal);
  paintModeButton();
  setStore({ [KEY.sceneMode]: state.sceneMode });
}

/* ── score ────────────────────────────────────────────────────────────── */

/** The score bar under the board is the only place the best score is shown. */
function paintHigh() {
  setText("best", String(state.high));
}

let persistTimer = 0;
function persistHigh() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    // Re-read first: lib/game.js also persists, and the larger value must win.
    const stored = (await getStore(KEY.high))[KEY.high];
    const current = Number.isFinite(stored) ? stored : 0;
    if (state.high > current) await setStore({ [KEY.high]: state.high });
  }, 400);
}

function handleScore(score) {
  const n = Math.max(0, Math.floor(Number(score) || 0));
  setText("score", String(n));
  if (n > state.high) {
    state.high = n;
    paintHigh();
    persistHigh();
  }
}

/* ── board notice ─────────────────────────────────────────────────────── */

/**
 * Overlays a line on the board. Reserved for failures: lib/game.js draws its
 * own "press space" prompt, so a second prompt here would only be noise.
 */
function setHint(text) {
  const hint = el("stagehint");
  if (!hint) return;
  hint.textContent = text || "";
  show(hint, Boolean(text));
}

/* ── views ────────────────────────────────────────────────────────────── */

/**
 * Four views, one of which only the new tab has.
 *
 *   pick   first run / change peg
 *   off    the takeover was switched off
 *   scene  THE CLEARING — the new tab at rest: diorama, search bar, Play
 *   play   the board
 *
 * The offline page has no `scene`: it boots straight to `play`, because the
 * reason you are looking at it is that something failed and the game is the
 * consolation. A diorama would be the wrong tone entirely.
 */
function showOnly(which) {
  show(el("pick"), which === "pick");
  show(el("offState"), which === "off");
  show(el("idle"), which === "scene");
  show(el("stage"), which === "play");
  show(el("foot"), which === "play");
  show(el("controls"), which === "play");
  // The search bar stays up over the clearing and over the board; it goes away
  // for setup and for the off card. The offline header always speaks.
  const head = document.querySelector(".head");
  if (head) head.hidden = which === "off" || (which === "pick" && MODE === "newtab");
  // The clearing keeps running behind the resting page and stops behind the
  // board: nobody needs a waterfall in their peripheral vision while jumping.
  document.body.classList.toggle("playing", which === "play");
  syncSceneMotion();
}

/* ── setup panel ──────────────────────────────────────────────────────── */

const DEFAULT_SETUP_NOTE = "Any alive piece, 1 to 400000. Rendered locally, offline.";

function setNote(text, bad) {
  const node = el("pickNote");
  if (!node) return;
  node.textContent = text || DEFAULT_SETUP_NOTE;
  node.classList.toggle("bad", Boolean(bad));
}

function setPreviewIdle() {
  state.previewId = null;
  drawGhost(previewTarget());
  const num = el("previewNum");
  if (num) {
    num.textContent = "#—";
    num.classList.remove("live");
  }
  const lock = el("lockBtn");
  if (lock) lock.disabled = true;
}

/**
 * Setup / change-peg view. `note` overrides the standing copy (an error, or a
 * word about why we came back here).
 */
function showSetup(note, bad) {
  showOnly("pick");
  drawGhost(portraitTarget());
  setPreviewIdle();
  show(el("fetchBtn"), false);
  setNote(note, bad);
  const input = el("pickInput");
  if (input) {
    if (state.pieceId != null && input.value === "") input.value = String(state.pieceId);
    input.focus();
    input.select();
    if (input.value !== "") updatePreview();
  }
}

/**
 * Render whatever is in the input, right now. `allowNetwork` is only ever true
 * from a click (Lock in, Fetch it once) because asking for an optional
 * permission requires a user gesture — a keystroke must never open a socket.
 */
async function updatePreview(options = {}) {
  const allowNetwork = options.allowNetwork === true;
  const token = ++state.previewToken;
  const input = el("pickInput");
  const raw = input ? input.value.trim() : "";

  if (raw === "") {
    setPreviewIdle();
    show(el("fetchBtn"), false);
    setNote(null);
    return null;
  }

  const id = parseId(raw);
  if (id === null) {
    setPreviewIdle();
    show(el("fetchBtn"), false);
    setNote(`UpegIndexOutOfRange — ids run 1 to ${MAX_ID}`, true);
    return null;
  }

  if (!(await loadLibs())) {
    setPreviewIdle();
    setNote("Renderer unavailable. Reload the extension from chrome://extensions.", true);
    return null;
  }

  // A network-allowed lookup can put a permission prompt on screen; say what is
  // happening first so the panel is never silently busy behind it.
  if (allowNetwork) setNote(`Checking #${id}…`);

  const found = await resolvePiece(lib.upeg, id, { allowNetwork });
  if (token !== state.previewToken) return null; // a later keystroke won

  if (found.seed === null || found.seed === undefined) {
    setPreviewIdle();
    setNote(missMessage(id, found.reason), true);
    state.pendingFetchId = canFetch(found.reason) ? id : null;
    const fetchBtn = el("fetchBtn");
    if (fetchBtn) {
      fetchBtn.textContent =
        found.reason === "unreachable" ? "Try upegpfp.art again" : "Fetch it once";
      show(fetchBtn, state.pendingFetchId !== null);
    }
    return null;
  }

  const grid = await lib.upeg.gridFromSeed(found.seed);
  if (token !== state.previewToken) return null;

  const target = previewTarget();
  if (target) lib.sprite.drawGrid(target.ctx, grid, target.cellPx, 0, 0);
  const num = el("previewNum");
  if (num) {
    num.textContent = `#${id}`;
    num.classList.add("live");
  }
  const lock = el("lockBtn");
  if (lock) lock.disabled = false;
  show(el("fetchBtn"), false);
  state.pendingFetchId = null;
  state.previewId = id;
  setNote(
    found.source === "bundled"
      ? `#${id} — alive. Lock it in and it renders with the network off.`
      : `#${id} — fetched and cached. It renders offline from now on.`
  );
  return id;
}

/** Saves the piece and flips the lock. From here the page boots straight in. */
async function lockIn(id) {
  await setStore({ [KEY.piece]: id, [KEY.locked]: true });
  window.location.reload();
}

/* ── the piece ────────────────────────────────────────────────────────── */

async function showPiece(id) {
  const ok = await loadLibs();
  if (!ok) {
    showSetup("Renderer unavailable. Reload the extension from chrome://extensions.", true);
    return;
  }

  // Bundle and cache only: booting must never wait on a socket, even when the
  // machine is online. If the locked piece somehow is not there, setup explains.
  const found = await resolvePiece(lib.upeg, id, { allowNetwork: false });
  if (found.seed === null || found.seed === undefined) {
    const input = el("pickInput");
    if (input) input.value = String(id);
    showSetup(missMessage(id, found.reason), true);
    return;
  }

  state.pieceId = id;
  state.grid = await lib.upeg.gridFromSeed(found.seed);
  state.piecePalette =
    typeof lib.upeg.paletteFromGrid === "function" ? lib.upeg.paletteFromGrid(state.grid) : [];
  // Sprite cells are built at the canvas's own device resolution, so the game
  // can blit frames 1:1 with no resampling on any display.
  state.frames = await lib.sprite.buildRunFrames(state.grid, {
    scale: Math.min(8, 4 * deviceScale()),
  });

  // The new tab rests in the clearing and only builds the board when you ask
  // for it; the offline page goes straight to the board, because that is the
  // reason you are looking at it.
  if (MODE === "newtab") {
    showOnly("scene");
    await bootScene();
    paintHigh();
    setText("score", "0");
    return;
  }

  showOnly("play");
  drawPortrait(state.grid);
  // `pieceChip` is the offline page's, beside its Retry button.
  setText("pieceChip", `#${id}`);
  paintHigh();
  setText("score", "0");
  setHint("");
  bootGame();
  // Deliberately no programmatic focus: the offline page already owns the
  // keyboard (window-level handlers), and focusing the board on load paints a
  // focus ring around the whole stage, which reads as an error box.
}

/* ── settings ─────────────────────────────────────────────────────────── */

async function openSettings() {
  const dialog = el("settings");
  if (!dialog) return;
  const piece = el("setPiece");
  const toggle = el("setNewtab");
  if (piece) piece.value = state.pieceId == null ? "" : String(state.pieceId);
  if (toggle) toggle.checked = state.newtabEnabled;
  // Re-read from state each time it opens: cancelling must not leave a roster
  // edit behind, so `saveSettings` is the only thing that writes it.
  state.roster = cleanRoster(state.roster);
  paintRoster();
  const note = el("setNote");
  if (note) {
    if (state.aliveCount == null && lib.upeg) {
      try {
        state.aliveCount = await lib.upeg.aliveCount();
      } catch {
        state.aliveCount = null;
      }
    }
    note.textContent = state.aliveCount
      ? `${state.aliveCount} pieces bundled — all render with the network off.`
      : "Rendered locally, with the network off.";
    note.classList.remove("bad");
  }
  dialog.showModal();
}

async function saveSettings() {
  const dialog = el("settings");
  const note = el("setNote");
  const id = parseId(el("setPiece") ? el("setPiece").value : null);
  if (id === null) {
    if (note) {
      note.textContent = `UpegIndexOutOfRange — ids run 1 to ${MAX_ID}`;
      note.classList.add("bad");
    }
    return;
  }
  if (lib.upeg) {
    // Saving is a click, so the optional fetch is allowed to ask here.
    const found = await resolvePiece(lib.upeg, id, { allowNetwork: true });
    if (found.seed === null || found.seed === undefined) {
      if (note) {
        note.textContent = missMessage(id, found.reason);
        note.classList.add("bad");
      }
      return;
    }
  }
  const toggle = el("setNewtab");
  await setStore({
    [KEY.piece]: id,
    [KEY.locked]: true,
    [KEY.newtab]: toggle ? toggle.checked : true,
    [KEY.roster]: cleanRoster(state.roster),
  });
  if (dialog) dialog.close();
  window.location.reload();
}

/* ── wiring ───────────────────────────────────────────────────────────── */

function wireOffline() {
  const retry = el("retry");
  const from = safeFrom(new URLSearchParams(window.location.search).get("from"));
  if (from) {
    setText("host", from.hostname);
    if (retry) {
      retry.addEventListener("click", () => {
        window.location.replace(from.href);
      });
    }
  } else {
    setText("host", "That page");
    if (retry) retry.textContent = "Reload";
    if (retry) {
      retry.addEventListener("click", () => {
        window.history.back();
      });
    }
  }
  // Don't yank anyone out of a run — just say the door is open again.
  window.addEventListener("online", () => {
    if (retry) retry.textContent = from ? "Back online — retry" : "Back online";
  });
}

function wireSetup() {
  const input = el("pickInput");
  if (input) {
    let timer = 0;
    input.addEventListener("input", () => {
      // The preview is a keystroke behind by definition, so the id it last
      // agreed to is void the moment the number changes. Lock in re-resolves.
      state.previewId = null;
      const lock = el("lockBtn");
      if (lock) lock.disabled = input.value.trim() === "";
      clearTimeout(timer);
      // Short enough to feel live, long enough not to redraw mid-number.
      timer = setTimeout(() => updatePreview(), 140);
    });
  }

  const form = el("pickForm");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      // Re-validate on submit: the preview may be a keystroke behind, and this
      // click is also our one chance to ask for the optional fetch permission.
      const id = state.previewId ?? (await updatePreview({ allowNetwork: true }));
      if (id === null || id === undefined) return;
      await lockIn(id);
    });
  }

  const mascot = el("pickMascot");
  if (mascot) {
    mascot.addEventListener("click", () => {
      if (input) {
        input.value = String(MASCOT);
        input.focus();
      }
      updatePreview();
    });
  }

  const fetchBtn = el("fetchBtn");
  if (fetchBtn) {
    fetchBtn.addEventListener("click", async () => {
      const id = state.pendingFetchId;
      if (id === null) return;
      fetchBtn.disabled = true;
      setNote(`Asking upegpfp.art about #${id}…`);
      try {
        await updatePreview({ allowNetwork: true });
      } finally {
        fetchBtn.disabled = false;
      }
    });
  }

  const change = el("changeBtn");
  if (change) {
    change.addEventListener("click", async () => {
      stopGame();
      state.locked = false;
      await setStore({ [KEY.locked]: false });
      showSetup("Change your peg. The one you have stays put until you lock a new one in.");
    });
  }
}

/* ── the roster ───────────────────────────────────────────────────────── */

/** Ids only, deduped, capped, and every one of them a real integer. */
function cleanRoster(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const id = parseId(raw);
    if (id !== null && !out.includes(id)) out.push(id);
    if (out.length >= ROSTER_MAX) break;
  }
  return out;
}

function paintRoster() {
  const ul = el("roster");
  if (!ul) return;
  ul.textContent = "";
  if (!state.roster.length) {
    const li = document.createElement("li");
    li.className = "rosterempty";
    li.textContent = "Empty — your locked piece grazes alone.";
    ul.append(li);
  }
  for (const id of state.roster) {
    const li = document.createElement("li");
    const chip = document.createElement("span");
    chip.className = "mono";
    chip.textContent = `#${id}`;
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "btn quiet";
    drop.textContent = "Remove";
    drop.setAttribute("aria-label", `Remove piece ${id} from the clearing`);
    drop.addEventListener("click", () => {
      state.roster = state.roster.filter((x) => x !== id);
      paintRoster();
    });
    li.append(chip, drop);
    ul.append(li);
  }
  const note = el("rosterNote");
  if (note) {
    note.textContent = `Up to ${ROSTER_MAX}. They wander, graze and doze. ${state.roster.length} in the clearing.`;
    note.classList.remove("bad");
  }
  const add = el("rosterAdd");
  if (add) add.disabled = state.roster.length >= ROSTER_MAX;
}

async function addToRoster() {
  const input = el("rosterInput");
  const note = el("rosterNote");
  const id = parseId(input ? input.value : null);
  const fail = (msg) => {
    if (note) {
      note.textContent = msg;
      note.classList.add("bad");
    }
  };
  if (id === null) return fail(`Ids run 1 to ${MAX_ID}.`);
  if (state.roster.includes(id)) return fail(`#${id} is already grazing.`);
  if (state.roster.length >= ROSTER_MAX) return fail(`The clearing holds ${ROSTER_MAX}.`);
  // Bundle and cache only — adding a grazer must not open a socket.
  const found = await resolvePiece(lib.upeg, id, { allowNetwork: false });
  if (found.seed === null || found.seed === undefined) return fail(missMessage(id, found.reason));
  state.roster.push(id);
  if (input) input.value = "";
  paintRoster();
}

function wireRoster() {
  const add = el("rosterAdd");
  if (add) add.addEventListener("click", addToRoster);
  const input = el("rosterInput");
  if (input) {
    input.addEventListener("keydown", (event) => {
      // Enter in this field adds a grazer; it must not submit the dialog and
      // close Settings out from under you.
      if (event.key !== "Enter") return;
      event.preventDefault();
      addToRoster();
    });
  }
}

/* ── the resting page ─────────────────────────────────────────────────── */

function wireIdle() {
  const play = el("playBtn");
  if (play) {
    play.addEventListener("click", () => {
      showOnly("play");
      drawPortrait(state.grid);
      setHint("");
      bootGame();
      const canvas = el("run");
      if (canvas) canvas.focus({ preventScroll: true });
    });
  }
  const leave = el("leaveBtn");
  if (leave) {
    leave.addEventListener("click", () => {
      stopGame();
      showOnly("scene");
    });
  }
  const mode = el("modeBtn");
  if (mode) mode.addEventListener("click", cycleSceneMode);

  // The pause rule: off screen, off.
  document.addEventListener("visibilitychange", syncSceneMotion);
  window.addEventListener("pagehide", () => {
    if (state.scene) state.scene.pause();
  });
}

function wireSettings() {
  const button = el("settingsBtn");
  if (button) button.addEventListener("click", openSettings);
  const form = el("settingsForm");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveSettings();
    });
  }
  const cancel = el("setCancel");
  if (cancel) {
    cancel.addEventListener("click", () => {
      const dialog = el("settings");
      if (dialog) dialog.close();
    });
  }
  const enable = el("enableBtn");
  if (enable) {
    enable.addEventListener("click", async () => {
      await setStore({ [KEY.newtab]: true });
      window.location.reload();
    });
  }
}

function isTypingTarget(node) {
  if (!node || !node.tagName) return false;
  const tag = node.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    tag === "button" ||
    tag === "a" ||
    node.isContentEditable === true
  );
}

/* ── the new tab's search bar ─────────────────────────────────────────── */

/**
 * NEW TAB ONLY. offline.html ships no `#searchForm`, so this is a no-op there
 * by construction rather than by a mode check — a search box that cannot reach
 * anything is worse than no search box.
 *
 * The form is a real GET to google.com/search and submits fine with this
 * function never called. All it adds is the two things markup cannot do:
 * refusing an empty query (which would land on a blank results page), and
 * saying so when there is no connection.
 *
 * It never takes focus. A new tab hands the keyboard to the omnibox, and the
 * board is one click away; autofocusing here would mean the first space bar
 * types a space instead of jumping. `isTypingTarget` keeps the game's window
 * handlers off the field for as long as it does have focus.
 */
function wireSearch() {
  const form = el("searchForm");
  if (!form) return;
  const input = el("searchInput");
  const button = el("searchBtn");

  const paintConnection = () => {
    const off = navigator.onLine === false;
    if (off) form.setAttribute("data-offline", "");
    else form.removeAttribute("data-offline");
    if (button) button.disabled = off;
    if (input) {
      input.placeholder = off ? "No connection — the runner still works" : "Search Google";
    }
  };
  paintConnection();
  window.addEventListener("online", paintConnection);
  window.addEventListener("offline", paintConnection);

  form.addEventListener("submit", (event) => {
    if (navigator.onLine === false || !input || input.value.trim() === "") {
      event.preventDefault();
      if (input) input.focus();
      return;
    }
    // Submit the trimmed query, not the one with the stray spaces in it.
    input.value = input.value.trim();
  });

  // Escape hands the page back: blur the field so space jumps again.
  input?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    input.value = "";
    input.blur();
    const canvas = el("run");
    if (canvas && !el("stage").hidden) canvas.focus({ preventScroll: true });
  });
}

function wireKeys() {
  // Space must jump, not scroll the page — but never steal it from a control.
  window.addEventListener(
    "keydown",
    (event) => {
      const dialog = el("settings");
      if (dialog && dialog.open) return;
      if (isTypingTarget(event.target)) return;
      if (event.code === "Space" || event.code === "ArrowUp") event.preventDefault();
    },
    false
  );

  // A new tab opens with the address bar focused, so the first click on the
  // board is what actually hands the keyboard to the game.
  const stage = el("stage");
  if (stage) {
    stage.addEventListener("pointerdown", () => {
      const canvas = el("run");
      if (canvas) canvas.focus({ preventScroll: true });
    });
  }
}

function wireResize() {
  let timer = 0;
  let lastWidth = window.innerWidth;
  let lastHeight = window.innerHeight;
  window.addEventListener("resize", () => {
    // Height matters now, not just width: the board's height is bounded by
    // `calc(100vh - …)`, so a window that only gets shorter still resizes it.
    if (
      Math.abs(window.innerWidth - lastWidth) < 2 &&
      Math.abs(window.innerHeight - lastHeight) < 2
    ) {
      return;
    }
    lastWidth = window.innerWidth;
    lastHeight = window.innerHeight;
    clearTimeout(timer);
    // Debounced: re-fits the board to the new size, which restarts the run.
    timer = setTimeout(() => {
      // The clearing is laid out from the canvas size, so it re-solves too.
      if (state.scene) state.scene.resize();
      if (!el("pick").hidden) {
        updatePreview();
        return;
      }
      if (!state.grid) return;
      // Nothing below this belongs to the resting page: rebuilding the board
      // while it is hidden would start a run nobody asked for.
      if (el("stage").hidden) return;
      drawPortrait(state.grid);
      bootGame();
    }, 220);
  });
}

function wireStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[KEY.high]) {
      const value = changes[KEY.high].newValue;
      if (Number.isFinite(value) && value > state.high) {
        state.high = value;
        paintHigh();
      }
    }
    if (state.applyingOwnChange) return;
    // The popup can change the piece, the lock or the takeover while a page is
    // open; another tab can change the roster.
    if (changes[KEY.piece] || changes[KEY.newtab] || changes[KEY.locked] || changes[KEY.roster]) {
      window.location.reload();
    }
  });
}

/* ── boot ─────────────────────────────────────────────────────────────── */

async function main() {
  if (MODE === "offline") wireOffline();
  wireSearch();
  wireSetup();
  wireSettings();
  wireRoster();
  wireIdle();
  wireKeys();
  wireResize();
  wireStorage();

  const store = await getStore([
    KEY.piece,
    KEY.locked,
    KEY.high,
    KEY.newtab,
    KEY.roster,
    KEY.sceneMode,
  ]);
  state.high = Number.isFinite(store[KEY.high]) ? store[KEY.high] : 0;
  state.newtabEnabled = store[KEY.newtab] !== false;
  state.roster = cleanRoster(store[KEY.roster]);
  state.sceneMode = ["auto", "day", "night"].includes(store[KEY.sceneMode])
    ? store[KEY.sceneMode]
    : "auto";
  paintHigh();

  if (MODE === "newtab" && !state.newtabEnabled) {
    showOnly("off");
    return;
  }

  const id = parseId(store[KEY.piece]);
  state.pieceId = id;
  // A saved piece from before the lock existed counts as locked — nobody should
  // be asked to set up a thing they already set up.
  state.locked = id !== null && store[KEY.locked] !== false;

  if (!state.locked) {
    await loadLibs();
    showSetup(id === null ? null : "Pick a new peg, or lock the same one back in.");
    return;
  }
  await showPiece(id);
}

main().catch((err) => {
  console.error("upegRUN: page failed", err);
  showSetup("Something broke locally. Reload the extension from chrome://extensions.", true);
});
