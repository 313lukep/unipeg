/**
 * unipegPFP — Offline Unipeg · shared page script for offline.html + newtab.html.
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

const KEY = {
  piece: "upegpfp.pieceId",
  locked: "upegpfp.pieceLocked",
  high: "upegpfp.highScore",
  newtab: "upegpfp.newtabEnabled",
};

/** The project's mascot — a guaranteed-alive piece, offered during setup. */
const MASCOT = 185206;
const MAX_ID = 400000;

const MODE = document.body.dataset.mode === "offline" ? "offline" : "newtab";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const el = (id) => document.getElementById(id);

/** Dark-page tokens from docs/DESIGN.md, handed to the game so it stays in palette. */
const PALETTE = {
  paper: "#0B0B0D",
  ink: "#F7F7F8",
  pink: "#FF4DA1",
  mute: "#9C9CA6",
  card: "#161619",
  line: "#232326",
  accent: "#FF4DA1",
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

const lib = { upeg: null, sprite: null, game: null };

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
    console.error("unipegPFP: renderer failed to load", err);
    return false;
  }
  // The game is a nice-to-have; a broken game must not cost you the artwork.
  try {
    lib.game = await import("../lib/game.js");
  } catch (err) {
    console.error("unipegPFP: game failed to load", err);
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
  ctx.fillStyle = PALETTE.card;
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
      console.error("unipegPFP: game stop failed", err);
    }
  }
  state.game = null;
}

function bootGame() {
  const stage = el("stage");
  const canvas = el("run");
  if (!lib.game || !stage || !canvas || !state.frames) return;
  stopGame();
  const rect = stage.getBoundingClientRect();
  fitCanvas(canvas, rect.width, rect.height);
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
    console.error("unipegPFP: game failed to start", err);
    setHint("Runner unavailable — the artwork is still yours");
  }
}

/* ── score ────────────────────────────────────────────────────────────── */

function paintHigh() {
  setText("best", String(state.high));
  setText("bestInline", String(state.high));
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

function showOnly(which) {
  show(el("pick"), which === "pick");
  show(el("offState"), which === "off");
  show(el("stage"), which === "play");
  show(el("foot"), which === "play");
  // The new tab header is nothing but the piece, so it has nothing to say
  // before one is chosen; the offline header still has to say "you're offline".
  const head = document.querySelector(".head");
  if (head) head.hidden = which === "off" || (which === "pick" && MODE === "newtab");
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

  showOnly("play");
  drawPortrait(state.grid);
  setText("pieceDigits", String(id));
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
  window.addEventListener("resize", () => {
    if (Math.abs(window.innerWidth - lastWidth) < 2) return;
    lastWidth = window.innerWidth;
    clearTimeout(timer);
    // Debounced: re-fits the board to the new size, which restarts the run.
    timer = setTimeout(() => {
      if (!el("pick").hidden) {
        updatePreview();
        return;
      }
      if (!state.grid) return;
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
    // The popup can change the piece, the lock or the takeover while a page is open.
    if (changes[KEY.piece] || changes[KEY.newtab] || changes[KEY.locked]) {
      window.location.reload();
    }
  });
}

/* ── boot ─────────────────────────────────────────────────────────────── */

async function main() {
  if (MODE === "offline") wireOffline();
  wireSetup();
  wireSettings();
  wireKeys();
  wireResize();
  wireStorage();

  const store = await getStore([KEY.piece, KEY.locked, KEY.high, KEY.newtab]);
  state.high = Number.isFinite(store[KEY.high]) ? store[KEY.high] : 0;
  state.newtabEnabled = store[KEY.newtab] !== false;
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
  console.error("unipegPFP: page failed", err);
  showSetup("Something broke locally. Reload the extension from chrome://extensions.", true);
});
