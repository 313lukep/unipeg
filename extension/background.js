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
 * TIER 1 — errors that can only mean "this machine has no network".
 * Chrome reports these when the interface itself is down or suspended; there is
 * no reading of them under which the user is online, so they redirect
 * unconditionally.
 */
export const HARD_OFFLINE_ERRORS = new Set([
  "net::ERR_INTERNET_DISCONNECTED",
  "net::ERR_NETWORK_IO_SUSPENDED",
]);

/**
 * TIER 2 — errors that happen *both* when the network is down and when the
 * network is perfectly fine.
 *
 * ERR_NAME_NOT_RESOLVED is the one that matters: it is what a dropped
 * connection usually looks like, and it is also what a typo looks like. Showing
 * "You're offline" to someone who simply mistyped a domain is a false
 * statement, and it replaces Chrome's accurate DNS error with our own wrong
 * one. So these redirect only when the browser itself agrees it is offline.
 *
 * `navigator.onLine` is exactly the right test here despite its bad reputation:
 * its weakness is false *positives* (it says true on a captive portal), and a
 * false positive costs us nothing — we simply leave Chrome's error page alone,
 * which is the honest outcome anyway. It has no false negatives: if it says
 * false, there is no network interface to speak of.
 */
export const AMBIGUOUS_ERRORS = new Set([
  "net::ERR_NAME_NOT_RESOLVED",
  "net::ERR_NETWORK_CHANGED",
  "net::ERR_ADDRESS_UNREACHABLE",
  "net::ERR_CONNECTION_TIMED_OUT",
]);

/**
 * The whole decision, in one pure function so it can be reasoned about (and
 * tested) without a browser.
 *
 * Everything outside the two sets is left to Chrome: HTTP statuses (those are
 * successful navigations anyway), certificate/HTTPS failures, ERR_BLOCKED_BY_*,
 * ERR_ABORTED, ERR_CONNECTION_REFUSED / RESET (server reachable, refusing),
 * ERR_EMPTY_RESPONSE, safe-browsing interstitials. Ours would hide real
 * information.
 *
 * @param error  the net error string from chrome.webNavigation.onErrorOccurred
 * @param online navigator.onLine at the moment the error arrived
 */
export function shouldRedirect(error, online) {
  if (HARD_OFFLINE_ERRORS.has(error)) return true;
  if (AMBIGUOUS_ERRORS.has(error)) return online === false;
  return false;
}

/** navigator.onLine as seen by the service worker, read fresh at event time. */
function browserIsOnline() {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

/**
 * Duplicate-event guard. Chrome can fire onErrorOccurred more than once for a
 * SINGLE failed navigation, so we swallow a repeat of the same tab+url inside a
 * short window. It is deliberately NOT a per-tab cooldown: the user retrying,
 * or clicking another link while still offline, is a NEW failed navigation and
 * must get the Unipeg page — a blanket cooldown let Chrome's own dino through.
 */
const REDIRECT_DEDUPE_MS = 250;
const lastRedirect = new Map(); // tabId -> { url, at }

function isHttpUrl(url) {
  return typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
}

/** True only if this is a repeat event for the very same failed navigation. */
export function isDuplicateEvent(previous, url, now, window = REDIRECT_DEDUPE_MS) {
  return Boolean(previous) && previous.url === url && now - previous.at < window;
}

function sweepCooldowns(now) {
  for (const [tabId, entry] of lastRedirect) {
    if (now - entry.at >= REDIRECT_DEDUPE_MS) lastRedirect.delete(tabId);
  }
}

function onNavigationError(details) {
  // Top-level frames only. A failed iframe or subresource is not "you're offline".
  if (details.frameId !== 0) return;
  // Never touch chrome://, about:, file://, view-source:, data:, or our own pages.
  if (!isHttpUrl(details.url)) return;
  if (!shouldRedirect(details.error, browserIsOnline())) return;
  if (details.tabId === undefined || details.tabId < 0) return;

  const now = Date.now();
  sweepCooldowns(now);
  if (isDuplicateEvent(lastRedirect.get(details.tabId), details.url, now)) return;
  lastRedirect.set(details.tabId, { url: details.url, at: now });

  const target = chrome.runtime.getURL(OFFLINE_PAGE) + "?from=" + encodeURIComponent(details.url);
  chrome.tabs.update(details.tabId, { url: target }).catch(() => {
    // Tab closed or navigated away between the error and our update — nothing to do.
    lastRedirect.delete(details.tabId);
  });
}

// Guarded so the pure logic above can be imported by the test runner, which has
// no chrome.* at all.
if (typeof chrome !== "undefined" && chrome.webNavigation) {
  chrome.webNavigation.onErrorOccurred.addListener(onNavigationError);

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
}
