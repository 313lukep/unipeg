import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetAliveStore,
  getAliveState,
  startAlivePolling,
  type AliveState,
} from "../alive";
import { refreshAliveMap, type RefreshResult } from "../delta";
import type { AliveMap } from "../resolve";

vi.mock("../delta", () => ({ refreshAliveMap: vi.fn() }));

const mockRefresh = vi.mocked(refreshAliveMap);

const POLL_MS = 120_000; // mirrors alive.ts
const JITTER_MS = 30_000;

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const BASE_MAP: AliveMap = { "1": "11", "2": "22" };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stubBaselineFetch(blockNumber = 100): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => ({
      ok: true,
      json: async () => (String(url).includes("meta") ? { blockNumber } : BASE_MAP),
    })),
  );
}

function refreshResult(
  map: AliveMap,
  blockNumber: number,
  pendingAdded = new Map<string, `0x${string}`>(),
): RefreshResult {
  return { map, blockNumber, addedCount: 0, removedCount: 0, pendingAdded };
}

beforeEach(() => {
  __resetAliveStore();
  mockRefresh.mockReset();
  stubBaselineFetch();
});

afterEach(() => {
  __resetAliveStore();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("getAliveState first-lookup latency", () => {
  it("resolves immediately with the baseline while the delta refresh is in flight", async () => {
    // Regression: getAliveState used to await the delta refresh whenever
    // state.live was false — with RPCs down that is ~48s of transport
    // timeouts stalling the user's FIRST lookup even though the baseline
    // was already loaded.
    const d = deferred<RefreshResult>();
    mockRefresh.mockReturnValue(d.promise);
    const seen: AliveState[] = [];
    const stop = startAlivePolling((s) => seen.push(s));

    // Resolves without the deferred delta ever settling — baseline only.
    const s1 = await getAliveState();
    expect(s1.live).toBe(false);
    expect(s1.map).toEqual(BASE_MAP);

    // When the background delta lands, listeners hear about it.
    d.resolve(refreshResult({ "1": "11" }, 101));
    await vi.waitFor(() => {
      expect(seen.some((s) => s.live)).toBe(true);
    });
    const s2 = await getAliveState();
    expect(s2.live).toBe(true);
    expect(s2.map).toEqual({ "1": "11" });
    stop();
  });

  it("awaitFresh: true explicitly waits for the delta refresh", async () => {
    mockRefresh.mockResolvedValue(refreshResult({ "9": "99" }, 105));
    const s = await getAliveState({ awaitFresh: true });
    expect(s.live).toBe(true);
    expect(s.map).toEqual({ "9": "99" });
  });

  it("awaitFresh degrades to the baseline when the delta refresh fails", async () => {
    mockRefresh.mockRejectedValue(new Error("rpc down"));
    const s = await getAliveState({ awaitFresh: true });
    expect(s.live).toBe(false);
    expect(s.map).toEqual(BASE_MAP);
  });
});

describe("startAlivePolling stop()", () => {
  it("stop() during an in-flight poll prevents the loop from re-arming", async () => {
    // Regression: stop() only cleared the armed timer; a poll already
    // in flight re-armed schedule() after its await, so polling continued
    // forever with zero listeners.
    vi.useFakeTimers();
    const d = deferred<RefreshResult>();
    mockRefresh.mockReturnValue(d.promise);

    const stop = startAlivePolling(() => undefined);
    await vi.advanceTimersByTimeAsync(1); // baseline load + initial background refresh
    expect(vi.getTimerCount()).toBe(1); // poll timer armed

    // Fire the poll; it awaits the still-pending delta refresh.
    await vi.advanceTimersByTimeAsync(POLL_MS + JITTER_MS);
    expect(vi.getTimerCount()).toBe(0); // timer consumed, poll in flight

    stop();
    d.resolve(refreshResult(BASE_MAP, 101));
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0); // no re-arm after stop()

    await vi.advanceTimersByTimeAsync(10 * (POLL_MS + JITTER_MS));
    expect(mockRefresh).toHaveBeenCalledTimes(1); // and never polls again
  });
});

describe("pending-added carry-forward", () => {
  it("feeds unresolved added ids from one refresh into the next", async () => {
    vi.useFakeTimers();
    const pending = new Map<string, `0x${string}`>([["500001", OWNER]]);
    mockRefresh
      .mockResolvedValueOnce(refreshResult(BASE_MAP, 101, pending))
      .mockResolvedValueOnce(refreshResult({ ...BASE_MAP, "500001": "777" }, 102));

    await getAliveState({ awaitFresh: true });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh.mock.calls[0][0].pendingAdded?.size).toBe(0);

    vi.advanceTimersByTime(POLL_MS + 1); // age the state past freshness
    const s = await getAliveState({ awaitFresh: true });
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(mockRefresh.mock.calls[1][0].pendingAdded?.get("500001")).toBe(OWNER);
    expect(s.map["500001"]).toBe("777");
  });
});
