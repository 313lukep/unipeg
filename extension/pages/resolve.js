/**
 * upegRUN — Offline Unipeg · piece lookup.
 *
 * Shared by pages/page.js and popup.js. Plain ES module, no build step.
 *
 * The bundled id -> seed snapshot (data/upeg-alive.json) is the source of truth
 * and always answers first, with the network off. It has exactly one blind spot:
 * a piece minted after this build was packaged simply is not in it, and no
 * amount of local cleverness can invent its seed.
 *
 * So that one case — and only that case — is allowed to reach the network:
 *
 *   1. bundled snapshot            (offline, instant, 6,913 pieces)
 *   2. cached overlay in storage   (offline, whatever we fetched before)
 *   3. one GET to upegpfp.art      (only when navigator.onLine, only with the
 *                                   user's explicit permission, never blocking)
 *
 * Step 3 needs a host permission we deliberately do NOT ask for at install time:
 * it lives in `optional_host_permissions` and is requested at the moment of
 * need. Decline it and everything above still works — you just keep the
 * bundled collection.
 */

/** Extra id -> seed entries fetched from upegpfp.art, merged over the bundle. */
export const OVERLAY_KEY = "upegpfp.aliveExtra";

export const REMOTE_URL = "https://upegpfp.art/data/upeg-alive.json";
const REMOTE_ORIGIN = "https://upegpfp.art/*";

/** A hung request must never hold the page hostage. */
const FETCH_TIMEOUT_MS = 8000;

/** Don't re-fetch on every keystroke: one successful pull per page lifetime. */
let fetchedThisSession = false;
let overlayCache = null;

function isOnline() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

/** True if the user has already granted the optional upegpfp.art origin. */
export async function hasRemotePermission() {
  try {
    return await chrome.permissions.contains({ origins: [REMOTE_ORIGIN] });
  } catch {
    return false;
  }
}

/** Must be called from a user gesture. Resolves false if declined or unavailable. */
async function requestRemotePermission() {
  try {
    return await chrome.permissions.request({ origins: [REMOTE_ORIGIN] });
  } catch {
    return false;
  }
}

async function readOverlay() {
  if (overlayCache) return overlayCache;
  try {
    const stored = await chrome.storage.local.get(OVERLAY_KEY);
    const value = stored[OVERLAY_KEY];
    overlayCache = value && typeof value === "object" ? value : {};
  } catch {
    overlayCache = {};
  }
  return overlayCache;
}

/**
 * Keep only ids the bundle does not already carry, so the cache stays a diff
 * (a few entries) instead of a second copy of a 363 KB file.
 */
async function mergeOverlay(upeg, remote) {
  let bundled = {};
  try {
    bundled = await upeg.loadAliveSnapshot();
  } catch {
    bundled = {};
  }
  const overlay = { ...(await readOverlay()) };
  let added = 0;
  for (const key of Object.keys(remote)) {
    if (bundled[key] !== undefined) continue;
    if (overlay[key] !== undefined) continue;
    overlay[key] = String(remote[key]);
    added += 1;
  }
  overlayCache = overlay;
  if (added > 0) {
    try {
      await chrome.storage.local.set({ [OVERLAY_KEY]: overlay });
    } catch (err) {
      // Quota or a closing popup — the in-memory copy still serves this session.
      console.warn("upegRUN: could not cache the fetched pieces", err);
    }
  }
  return added;
}

/** One GET, time-boxed, never throwing. Returns the parsed map or null. */
async function fetchRemote() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REMOTE_URL, { signal: controller.signal, cache: "no-cache" });
    if (!res.ok) return null;
    const json = await res.json();
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function seedFrom(map, id) {
  const raw = map[String(id)];
  if (raw === undefined || raw === null) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * Look a piece id up.
 *
 * @param upeg   the lib/upeg.js module
 * @param id     integer piece id, already range-checked by the caller
 * @param opts   { allowNetwork } — true only from a user gesture (Lock in,
 *               "Fetch it once"); a bare keystroke never opens a socket.
 *
 * Resolves `{ seed, source, reason }`:
 *   seed   BigInt when found, else null
 *   source "bundled" | "cached" | "fetched"
 *   reason why it was not found —
 *     "broken"      the bundled snapshot itself is unreadable (broken install)
 *     "not-alive"   the remote map has been consulted and does not have it
 *     "offline-miss" not bundled, and we are offline so we cannot check
 *     "may-be-new"  not bundled, we are online, and a fetch has not been tried
 *     "declined"    the user declined the optional permission
 *     "unreachable" we tried and upegpfp.art did not answer
 */
export async function resolvePiece(upeg, id, opts = {}) {
  const allowNetwork = opts.allowNetwork === true;

  let seed = null;
  try {
    seed = await upeg.seedForId(id);
  } catch (err) {
    console.error("upegRUN: bundled snapshot unreadable", err);
    return { seed: null, source: null, reason: "broken" };
  }
  if (seed !== null && seed !== undefined) return { seed, source: "bundled", reason: null };

  const overlay = await readOverlay();
  const cached = seedFrom(overlay, id);
  if (cached !== null) return { seed: cached, source: "cached", reason: null };

  // Beyond here we would have to ask the network. The bundle has already had
  // its say, so every path below still ends in a usable answer.
  if (fetchedThisSession) return { seed: null, source: null, reason: "not-alive" };
  if (!isOnline()) return { seed: null, source: null, reason: "offline-miss" };

  const granted = (await hasRemotePermission()) || (allowNetwork && (await requestRemotePermission()));
  if (!granted) {
    return { seed: null, source: null, reason: allowNetwork ? "declined" : "may-be-new" };
  }

  const remote = await fetchRemote();
  if (!remote) return { seed: null, source: null, reason: "unreachable" };
  fetchedThisSession = true;
  await mergeOverlay(upeg, remote);

  const fetched = seedFrom(await readOverlay(), id) ?? seedFrom(remote, id);
  if (fetched !== null && fetched !== undefined) {
    return { seed: fetched, source: "fetched", reason: null };
  }
  return { seed: null, source: null, reason: "not-alive" };
}

/**
 * The one sentence to show for a miss. Same calm, in-palette voice as the site:
 * name the id, say what is true, say what to do — never blame the user.
 */
export function missMessage(id, reason) {
  switch (reason) {
    case "broken":
      return "Piece snapshot unreadable. Reload the extension from chrome://extensions.";
    case "offline-miss":
      return `#${id} — not in the offline collection yet. Connect once to fetch it.`;
    case "may-be-new":
      return `#${id} — not in the offline collection. It may be newly minted.`;
    case "declined":
      return `#${id} — staying offline. The bundled collection is unchanged.`;
    case "unreachable":
      return `#${id} — upegpfp.art didn't answer. The bundled collection still works.`;
    default:
      return `#${id} — MINTED, NOT ALIVE. Its tokens returned to the pool.`;
  }
}

/** True when offering a "Fetch it once" button would actually help. */
export function canFetch(reason) {
  return reason === "may-be-new" || reason === "unreachable";
}
