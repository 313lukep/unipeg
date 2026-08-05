/**
 * unipegPFP — Offline Unipeg · toolbar popup.
 * Set the piece, toggle the new tab takeover, see the best run, open the board.
 * Validation uses the bundled snapshot, so it is accurate with the network off.
 */

const KEY = {
  piece: "upegpfp.pieceId",
  high: "upegpfp.highScore",
  newtab: "upegpfp.newtabEnabled",
};
const MAX_ID = 400000;

const el = (id) => document.getElementById(id);
const note = el("note");

function parseId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ID) return null;
  return n;
}

function say(text, bad) {
  note.textContent = text;
  note.classList.toggle("bad", Boolean(bad));
}

/** Loaded on demand — it pulls in the bundled id -> seed snapshot. */
let upeg = null;
async function getUpeg() {
  if (!upeg) {
    try {
      upeg = await import("./lib/upeg.js");
    } catch (err) {
      console.error("unipegPFP: renderer unavailable in popup", err);
      return null;
    }
  }
  return upeg;
}

async function init() {
  const store = await chrome.storage.local.get([KEY.piece, KEY.high, KEY.newtab]);
  const id = parseId(store[KEY.piece]);
  if (id !== null) el("piece").value = String(id);
  el("newtab").checked = store[KEY.newtab] !== false;
  el("best").textContent = String(Number.isFinite(store[KEY.high]) ? store[KEY.high] : 0);

  const mod = await getUpeg();
  if (mod && typeof mod.aliveCount === "function") {
    try {
      const count = await mod.aliveCount();
      if (count) say(`${count} pieces bundled — all render offline.`);
    } catch {
      /* the count is decoration; never block the popup on it */
    }
  }
}

el("pieceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = parseId(el("piece").value);
  if (id === null) {
    say(`UpegIndexOutOfRange — ids run 1 to ${MAX_ID}`, true);
    return;
  }
  const mod = await getUpeg();
  if (mod && typeof mod.seedForId === "function") {
    const seed = await mod.seedForId(id);
    if (seed === null || seed === undefined) {
      say(`#${id} — MINTED, NOT ALIVE. Its tokens returned to the pool.`, true);
      return;
    }
  }
  await chrome.storage.local.set({ [KEY.piece]: id });
  say(`Saved. #${id} is your peg.`);
});

el("newtab").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ [KEY.newtab]: event.target.checked });
  say(
    event.target.checked
      ? "New tab takeover on."
      : "New tab takeover off — new tabs show a blank Unipeg card."
  );
});

el("play").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("pages/newtab.html") });
  window.close();
});

init().catch((err) => {
  console.error("unipegPFP: popup failed", err);
  say("Something broke locally. Reload the extension.", true);
});
