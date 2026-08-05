/**
 * unipegPFP — Offline Unipeg · MV3 service worker.
 *
 * Single job: when a top-level navigation fails because the machine genuinely
 * has no connectivity, send that tab to our own offline page (which renders the
 * user's Unipeg and a runner game entirely from bundled data — no network).
 *
 * Everything here is deliberately conservative. Hijacking a navigation is a
 * hostile act if we get it wrong, so we only act on an explicit allowlist of
 * connectivity errors and bail on anything ambiguous.
 */

const OFFLINE_PAGE = "pages/offline.html";

/**
 * Explicit allowlist of net errors that mean "there is no working network".
 * Anything not in this set — 404s and other HTTP statuses (which are successful
 * navigations anyway), certificate/HTTPS failures, ERR_BLOCKED_BY_*,
 * ERR_ABORTED, ERR_CONNECTION_REFUSED / RESET (server reachable, refusing),
 * ERR_EMPTY_RESPONSE, safe-browsing interstitials — is left alone. Chrome's own
 * error page is the right answer for those; ours would hide real information.
 */
const CONNECTIVITY_ERRORS = new Set([
  "net::ERR_INTERNET_DISCONNECTED",
  "net::ERR_NAME_NOT_RESOLVED",
  "net::ERR_NETWORK_CHANGED",
  "net::ERR_ADDRESS_UNREACHABLE",
  "net::ERR_CONNECTION_TIMED_OUT",
]);

/** Per-tab loop guard: never redirect the same tab twice in quick succession. */
const REDIRECT_COOLDOWN_MS = 4000;
const lastRedirect = new Map();

function isHttpUrl(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

/** True if we already sent this tab to the offline page moments ago. */
function isCoolingDown(tabId, now) {
  const previous = lastRedirect.get(tabId);
  return typeof previous === "number" && now - previous < REDIRECT_COOLDOWN_MS;
}

function sweepCooldowns(now) {
  for (const [tabId, at] of lastRedirect) {
    if (now - at >= REDIRECT_COOLDOWN_MS) lastRedirect.delete(tabId);
  }
}

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  // Top-level frames only. A failed iframe or subresource is not "you're offline".
  if (details.frameId !== 0) return;
  // Never touch chrome://, about:, file://, view-source:, data:, or our own pages.
  if (!isHttpUrl(details.url)) return;
  if (!CONNECTIVITY_ERRORS.has(details.error)) return;
  if (details.tabId === undefined || details.tabId < 0) return;

  const now = Date.now();
  sweepCooldowns(now);
  if (isCoolingDown(details.tabId, now)) return;
  lastRedirect.set(details.tabId, now);

  const target = chrome.runtime.getURL(OFFLINE_PAGE) + "?from=" + encodeURIComponent(details.url);
  chrome.tabs.update(details.tabId, { url: target }).catch(() => {
    // Tab closed or navigated away between the error and our update — nothing to do.
    lastRedirect.delete(details.tabId);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastRedirect.delete(tabId);
});

/** Seed defaults once, without clobbering anything the user has already set. */
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get("upegpfp.newtabEnabled");
  if (typeof stored["upegpfp.newtabEnabled"] !== "boolean") {
    await chrome.storage.local.set({ "upegpfp.newtabEnabled": true });
  }
});
