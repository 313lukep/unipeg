/**
 * unipegPFP — Offline Unipeg · shared page script for offline.html + newtab.html.
 *
 * Both entries share everything below the header: the piece portrait, the runner,
 * the score bar and settings. The only per-mode difference is `body[data-mode]`
 * and the header markup each HTML file ships.
 *
 * Nothing here touches the network. The renderer, the layer data and the
 * id -> seed snapshot are all bundled with the extension; that is the whole point.
 */

const KEY = {
  piece: "upegpfp.pieceId",
  high: "upegpfp.highScore",
  newtab: "upegpfp.newtabEnabled",
};

/** The project's mascot — a guaranteed-alive piece, offered on first run. */
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
  high: 0,
  newtabEnabled: true,
  game: null,
  frames: null,
  grid: null,
  piecePalette: [],
  aliveCount: null,
  hintDismissed: false,
  applyingOwnChange: false,
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

function drawPortrait(grid) {
  const canvas = el("portrait");
  if (!canvas) return;
  const base = window.innerWidth < 560 ? 3 : 4; // CSS px per cell
  const cellPx = base * deviceScale(); // device px per cell — always an integer
  canvas.width = 24 * cellPx;
  canvas.height = 24 * cellPx;
  canvas.style.width = 24 * base + "px";
  canvas.style.height = 24 * base + "px";
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  lib.sprite.drawGrid(ctx, grid, cellPx, 0, 0);
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

/* ── hint ─────────────────────────────────────────────────────────────── */

function setHint(text) {
  const hint = el("stagehint");
  if (!hint) return;
  hint.textContent = text;
  show(hint, Boolean(text) && !state.hintDismissed);
}

function dismissHint() {
  if (state.hintDismissed) return;
  state.hintDismissed = true;
  show(el("stagehint"), false);
}

/* ── views ────────────────────────────────────────────────────────────── */

function showOnly(which) {
  show(el("pick"), which === "pick");
  show(el("offState"), which === "off");
  show(el("stage"), which === "play");
  show(el("foot"), which === "play");
  const head = document.querySelector(".head");
  if (head) head.hidden = which === "off";
}

function showPick(note, bad) {
  showOnly("pick");
  const noteEl = el("pickNote");
  if (noteEl) {
    noteEl.textContent = note || "Any alive piece, 1 to 400000. Rendered locally, offline.";
    noteEl.classList.toggle("bad", Boolean(bad));
  }
  const input = el("pickInput");
  if (input) input.focus();
}

function showOff() {
  showOnly("off");
}

async function showPiece(id) {
  const ok = await loadLibs();
  if (!ok) {
    showPick("Renderer unavailable. Reload the extension from chrome://extensions.", true);
    return;
  }

  const seed = await lib.upeg.seedForId(id);
  if (seed === null || seed === undefined) {
    const input = el("pickInput");
    if (input) input.value = String(id);
    showPick(`#${id} — MINTED, NOT ALIVE. Its tokens returned to the pool.`, true);
    return;
  }

  state.pieceId = id;
  state.grid = await lib.upeg.gridFromSeed(seed);
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
  setHint(MODE === "newtab" ? "Click the board, then press space" : "Space or tap to jump");
  bootGame();

  const canvas = el("run");
  if (canvas && MODE === "offline") canvas.focus({ preventScroll: true });
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
    const seed = await lib.upeg.seedForId(id);
    if (seed === null || seed === undefined) {
      if (note) {
        note.textContent = `#${id} — MINTED, NOT ALIVE. Its tokens returned to the pool.`;
        note.classList.add("bad");
      }
      return;
    }
  }
  const toggle = el("setNewtab");
  await setStore({
    [KEY.piece]: id,
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

function wirePick() {
  const form = el("pickForm");
  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = parseId(el("pickInput").value);
      if (id === null) {
        showPick(`UpegIndexOutOfRange — ids run 1 to ${MAX_ID}`, true);
        return;
      }
      await setStore({ [KEY.piece]: id });
      window.location.reload();
    });
  }
  const mascot = el("pickMascot");
  if (mascot) {
    mascot.addEventListener("click", async () => {
      await setStore({ [KEY.piece]: MASCOT });
      window.location.reload();
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
      if (event.code === "Space" || event.code === "ArrowUp") {
        event.preventDefault();
        dismissHint();
      }
    },
    false
  );

  const stage = el("stage");
  if (stage) {
    stage.addEventListener("pointerdown", () => {
      const canvas = el("run");
      if (canvas) canvas.focus({ preventScroll: true });
      dismissHint();
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
    // The popup can change the piece or the takeover while a page is open.
    if (changes[KEY.piece] || changes[KEY.newtab]) window.location.reload();
  });
}

/* ── boot ─────────────────────────────────────────────────────────────── */

async function main() {
  if (MODE === "offline") wireOffline();
  wirePick();
  wireSettings();
  wireKeys();
  wireResize();
  wireStorage();

  const store = await getStore([KEY.piece, KEY.high, KEY.newtab]);
  state.high = Number.isFinite(store[KEY.high]) ? store[KEY.high] : 0;
  state.newtabEnabled = store[KEY.newtab] !== false;
  paintHigh();

  if (MODE === "newtab" && !state.newtabEnabled) {
    showOff();
    return;
  }

  const id = parseId(store[KEY.piece]);
  if (id === null) {
    await loadLibs();
    showPick();
    return;
  }
  await showPiece(id);
}

main().catch((err) => {
  console.error("unipegPFP: page failed", err);
  showPick("Something broke locally. Reload the extension from chrome://extensions.", true);
});
