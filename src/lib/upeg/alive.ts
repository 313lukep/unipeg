import { refreshAliveMap } from "./delta";
import { UpegLookupError } from "./types";
import type { AliveMap } from "./resolve";

/**
 * The live alive-set store. One instance per tab.
 *
 * Baseline: bundled /data/upeg-alive.json (+ .meta.json carrying the scan's
 * block number), optionally superseded by NEXT_PUBLIC_LIVE_SNAPSHOT_URL (a
 * cron-refreshed copy — see .github/workflows/refresh-snapshot.yml).
 * Freshness: an on-chain event delta patches the baseline on first use and
 * every ~2 minutes while the tab is visible, with per-client jitter so a
 * crowd of users never polls in lockstep.
 */

const BUNDLED_URL = "/data/upeg-alive.json";
const BUNDLED_META_URL = "/data/upeg-alive.meta.json";
const LIVE_URL = process.env.NEXT_PUBLIC_LIVE_SNAPSHOT_URL;

export type AliveState = {
  map: AliveMap;
  blockNumber: number;
  aliveCount: number;
  refreshedAt: number; // Date.now() of last successful delta
  live: boolean; // true once at least one delta has applied
};

type Listener = (s: AliveState) => void;

const POLL_MS = 120_000;
const JITTER_MS = 30_000;

let state: AliveState | undefined;
let baselinePromise: Promise<AliveState> | undefined;
let refreshing: Promise<AliveState> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<Listener>();

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

async function loadBaseline(): Promise<AliveState> {
  const sources: Array<() => Promise<{ map: AliveMap; blockNumber: number }>> = [];
  if (LIVE_URL) {
    sources.push(async () => {
      const live = await fetchJson<{ blockNumber: number; map: AliveMap }>(LIVE_URL);
      return { map: live.map, blockNumber: live.blockNumber };
    });
  }
  sources.push(async () => {
    const [map, meta] = await Promise.all([
      fetchJson<AliveMap>(BUNDLED_URL),
      fetchJson<{ blockNumber?: number }>(BUNDLED_META_URL).catch(
        () => ({}) as { blockNumber?: number },
      ),
    ]);
    return { map, blockNumber: meta.blockNumber ?? 0 };
  });
  let lastErr: unknown;
  for (const source of sources) {
    try {
      const { map, blockNumber } = await source();
      return {
        map,
        blockNumber,
        aliveCount: Object.keys(map).length,
        refreshedAt: 0,
        live: false,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new UpegLookupError(
    "dataset-unavailable",
    `Could not load the alive-piece snapshot: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

function emit() {
  if (!state) return;
  for (const cb of listeners) cb(state);
}

async function runDelta(): Promise<AliveState> {
  const base = state ?? (await ensureBaseline());
  if (!base.blockNumber) return base; // no block stamp -> nothing to replay from
  const result = await refreshAliveMap({ map: base.map, blockNumber: base.blockNumber });
  state = {
    map: result.map,
    blockNumber: result.blockNumber,
    aliveCount: Object.keys(result.map).length,
    refreshedAt: Date.now(),
    live: true,
  };
  emit();
  return state;
}

function ensureBaseline(): Promise<AliveState> {
  if (state) return Promise.resolve(state);
  if (!baselinePromise) {
    baselinePromise = loadBaseline().then((s) => {
      state = s;
      emit();
      return s;
    }).catch((err) => {
      baselinePromise = undefined;
      throw err;
    });
  }
  return baselinePromise;
}

/**
 * Current alive map, freshened by an event delta when possible. Chain being
 * unreachable degrades to the baseline silently — lookups still work, the
 * UI just shows the snapshot vintage instead of LIVE.
 */
export async function getAliveState(): Promise<AliveState> {
  const base = await ensureBaseline();
  if (base.live && Date.now() - base.refreshedAt < POLL_MS) return base;
  if (!refreshing) {
    refreshing = runDelta()
      .catch(() => base)
      .finally(() => {
        refreshing = undefined;
      });
  }
  return refreshing;
}

export async function getAliveMap(): Promise<AliveMap> {
  return (await getAliveState()).map;
}

/** Begin visibility-aware polling. Returns a stop function. */
export function startAlivePolling(onChange?: Listener): () => void {
  if (onChange) listeners.add(onChange);
  const schedule = () => {
    const delay = POLL_MS + Math.random() * JITTER_MS;
    timer = setTimeout(async () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        await getAliveState().catch(() => undefined);
      }
      schedule();
    }, delay);
  };
  if (!timer) {
    void getAliveState().catch(() => undefined);
    schedule();
  }
  return () => {
    if (onChange) listeners.delete(onChange);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

/** Test hook. */
export function __resetAliveStore(): void {
  state = undefined;
  baselinePromise = undefined;
  refreshing = undefined;
  if (timer) clearTimeout(timer);
  timer = undefined;
  listeners.clear();
}
