import { refreshAliveMap, type RefreshResult } from "./delta";
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
/** True while startAlivePolling's shared loop should keep re-arming. */
let polling = false;
/** Unresolved new-mint ids carried between delta polls (see delta.ts). */
let pendingAdded: RefreshResult["pendingAdded"] = new Map();
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
  const result = await refreshAliveMap({
    map: base.map,
    blockNumber: base.blockNumber,
    pendingAdded,
  });
  pendingAdded = result.pendingAdded; // retry unresolved new mints next poll
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
 *
 * Once the baseline is loaded this resolves IMMEDIATELY with the best state
 * we have; a stale state kicks the delta refresh off in the BACKGROUND and
 * listeners hear about it when it lands. (Awaiting the delta here used to
 * stall the user's first lookup behind ~48s of RPC transport timeouts when
 * the chain was unreachable.) Pass `awaitFresh: true` to explicitly wait for
 * the in-flight refresh instead — it still degrades to the baseline on
 * failure, never rejects because of the chain.
 */
export async function getAliveState(opts?: { awaitFresh?: boolean }): Promise<AliveState> {
  const base = await ensureBaseline();
  const current = state ?? base;
  if (current.live && Date.now() - current.refreshedAt < POLL_MS) return current;
  if (!refreshing) {
    // The .catch converts failure to the baseline, so this promise never
    // rejects — leaving it un-awaited in the background is safe.
    refreshing = runDelta()
      .catch(() => state ?? current)
      .finally(() => {
        refreshing = undefined;
      });
  }
  return opts?.awaitFresh ? refreshing : current;
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
        await getAliveState({ awaitFresh: true }).catch(() => undefined);
      }
      // stop() during the in-flight refresh above must win: without this
      // check the loop re-armed itself forever with zero listeners.
      if (polling) schedule();
    }, delay);
  };
  if (!polling) {
    polling = true;
    void getAliveState().catch(() => undefined);
    schedule();
  }
  return () => {
    if (onChange) listeners.delete(onChange);
    if (listeners.size === 0) {
      polling = false;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
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
  polling = false;
  pendingAdded = new Map();
  listeners.clear();
}
