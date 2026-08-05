/**
 * The redirect decision in extension/background.js.
 *
 * Hijacking a navigation is only defensible when the page we substitute is
 * telling the truth. "You're offline" is a claim about the machine, not about
 * the host, so the two-tier rule below is the whole safety argument: errors
 * that can only mean "no network" act unconditionally, errors that also happen
 * on a perfectly good connection act only when the browser agrees it is offline.
 */

import { describe, expect, it } from "vitest";

// background.js guards its chrome.* wiring, so importing it here is safe.
import { shouldRedirect, HARD_OFFLINE_ERRORS, AMBIGUOUS_ERRORS } from "../../background.js";

const ONLINE = true;
const OFFLINE = false;

describe("shouldRedirect", () => {
  it("redirects an unambiguous disconnect whatever navigator.onLine says", () => {
    expect(shouldRedirect("net::ERR_INTERNET_DISCONNECTED", OFFLINE)).toBe(true);
    expect(shouldRedirect("net::ERR_INTERNET_DISCONNECTED", ONLINE)).toBe(true);
  });

  it("leaves a mistyped domain alone while the network works", () => {
    // The defect this test exists for: online + ERR_NAME_NOT_RESOLVED is a DNS
    // failure, not an outage. Chrome's own error page is the accurate one.
    expect(shouldRedirect("net::ERR_NAME_NOT_RESOLVED", ONLINE)).toBe(false);
  });

  it("redirects the ambiguous errors only when the browser is offline", () => {
    for (const error of AMBIGUOUS_ERRORS) {
      expect(shouldRedirect(error, OFFLINE)).toBe(true);
      expect(shouldRedirect(error, ONLINE)).toBe(false);
    }
  });

  it("never redirects errors outside both tiers", () => {
    const untouched = [
      "net::ERR_CONNECTION_REFUSED",
      "net::ERR_CONNECTION_RESET",
      "net::ERR_CERT_AUTHORITY_INVALID",
      "net::ERR_SSL_PROTOCOL_ERROR",
      "net::ERR_BLOCKED_BY_CLIENT",
      "net::ERR_BLOCKED_BY_ADMINISTRATOR",
      "net::ERR_ABORTED",
      "net::ERR_EMPTY_RESPONSE",
      "net::ERR_TOO_MANY_REDIRECTS",
      "net::ERR_UNKNOWN_URL_SCHEME",
    ];
    for (const error of untouched) {
      expect(shouldRedirect(error, OFFLINE)).toBe(false);
      expect(shouldRedirect(error, ONLINE)).toBe(false);
    }
  });

  it("treats an unknown online state as online, so it stays out of the way", () => {
    // navigator.onLine is only trusted when it says false; anything else means
    // we have no evidence of an outage and must not claim one.
    expect(shouldRedirect("net::ERR_NAME_NOT_RESOLVED", undefined as never)).toBe(false);
    expect(shouldRedirect("net::ERR_INTERNET_DISCONNECTED", undefined as never)).toBe(true);
  });

  it("keeps the two tiers disjoint", () => {
    for (const error of HARD_OFFLINE_ERRORS) {
      expect(AMBIGUOUS_ERRORS.has(error)).toBe(false);
    }
  });
});
