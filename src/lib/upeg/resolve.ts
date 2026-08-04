import { chainGenerateSvg, chainTotalCount } from "./chain";
import { decodeSeed } from "./seed";
import { generateSvgFromSeed } from "./renderer";
import {
  UpegLookupError,
  type Provenance,
  type UpegPiece,
} from "./types";

/**
 * id -> piece resolution.
 *
 * There is NO public id->seed accessor on-chain (the _upegs mapping is
 * private; accessors are owner-scoped). The app ships a snapshot of every
 * ALIVE piece's (id, seed) — built by a full holder scan via
 * Holder()/OwnerUpegsPage() — at /data/upeg-alive.json. Burned/pooled ids
 * have their seeds deleted on-chain, so the alive set IS the renderable set.
 *
 * Pipeline per lookup:
 *   1. validate id (integer >= 1; <= UpegsTotalCount when reachable)
 *   2. id -> seed via the alive snapshot
 *   3. seed -> SVG via eth_call generate(seed)  [provenance: "chain"]
 *      falling back to the byte-exact local port [provenance: "local-verified"]
 *   4. cache in-memory + localStorage (the art is immutable)
 */

export type AliveMap = Record<string, string>; // id -> seed, decimal strings

export type ResolveDeps = {
  loadAliveMap: () => Promise<AliveMap>;
  generateOnChain: (seed: bigint) => Promise<string>;
  totalCount: () => Promise<number>;
};

const LS_PIECE_PREFIX = "unipegpfp.piece.";
const LS_PIECE_INDEX = "unipegpfp.piece-ids";
const MEMORY_LRU_MAX = 60;
const LS_MAX_PIECES = 40;

/**
 * The alive map now lives in ./alive (baseline snapshot + live event delta,
 * see delta.ts). This wrapper keeps the resolver's dependency injectable.
 */
export function loadAliveMapOnce(): Promise<AliveMap> {
  // Deferred import avoids a resolve <-> alive <-> delta cycle at module load.
  return import("./alive").then((m) => m.getAliveMap());
}

const memoryCache = new Map<number, UpegPiece>(); // insertion-ordered => LRU

function memoryGet(id: number): UpegPiece | undefined {
  const hit = memoryCache.get(id);
  if (hit) {
    memoryCache.delete(id);
    memoryCache.set(id, hit); // refresh recency
  }
  return hit;
}

function memoryPut(piece: UpegPiece): void {
  memoryCache.delete(piece.id);
  memoryCache.set(piece.id, piece);
  while (memoryCache.size > MEMORY_LRU_MAX) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
}

type StoredPiece = { id: number; seed: string; svg: string; provenance: Provenance };

function storageGet(id: number): UpegPiece | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(LS_PIECE_PREFIX + id);
    if (!raw) return undefined;
    const s = JSON.parse(raw) as StoredPiece;
    const seed = BigInt(s.seed);
    return { id: s.id, seed, svg: s.svg, metadata: decodeSeed(seed), provenance: s.provenance };
  } catch {
    return undefined;
  }
}

function storagePut(piece: UpegPiece): void {
  if (typeof localStorage === "undefined") return;
  try {
    const stored: StoredPiece = {
      id: piece.id,
      seed: piece.seed.toString(),
      svg: piece.svg,
      provenance: piece.provenance,
    };
    localStorage.setItem(LS_PIECE_PREFIX + piece.id, JSON.stringify(stored));
    const ids: number[] = JSON.parse(localStorage.getItem(LS_PIECE_INDEX) ?? "[]");
    const next = [piece.id, ...ids.filter((i) => i !== piece.id)];
    for (const evicted of next.slice(LS_MAX_PIECES)) {
      localStorage.removeItem(LS_PIECE_PREFIX + evicted);
    }
    localStorage.setItem(LS_PIECE_INDEX, JSON.stringify(next.slice(0, LS_MAX_PIECES)));
  } catch {
    // Quota/serialisation problems only cost us the cache, never the lookup.
  }
}

export function validatePieceId(input: string | number): number {
  const n = typeof input === "number" ? input : Number(String(input).trim().replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) {
    throw new UpegLookupError(
      "invalid-id",
      "A piece id is a whole number — 1 or higher.",
      Number.isFinite(n) ? n : undefined,
    );
  }
  return n;
}

const defaultDeps: ResolveDeps = {
  loadAliveMap: loadAliveMapOnce,
  generateOnChain: chainGenerateSvg,
  totalCount: chainTotalCount,
};

/**
 * Resolve a piece id to its art. Throws UpegLookupError with a typed code on
 * every failure path — the UI never sees a silent blank.
 */
export async function resolvePiece(
  input: string | number,
  deps: Partial<ResolveDeps> = {},
): Promise<UpegPiece> {
  const { loadAliveMap, generateOnChain, totalCount } = { ...defaultDeps, ...deps };
  const id = validatePieceId(input);

  const cached = memoryGet(id) ?? storageGet(id);
  if (cached) {
    memoryPut(cached);
    return cached;
  }

  const alive = await loadAliveMap();
  const seedStr = alive[String(id)];

  if (!seedStr) {
    // Distinguish "never minted / beyond range" from "minted but not alive".
    let max: number | undefined;
    try {
      max = await totalCount();
    } catch {
      max = undefined; // chain unreachable — still give the best answer we have
    }
    if (max !== undefined && id > max) {
      throw new UpegLookupError(
        "out-of-range",
        `UpegIndexOutOfRange — ids run 1 to ${max}.`,
        id,
      );
    }
    throw new UpegLookupError(
      "not-alive",
      `#${id} was minted but is not alive right now — its tokens went back to the pool. Only alive pieces have art on-chain.`,
      id,
    );
  }

  const seed = BigInt(seedStr);
  let svg: string;
  let provenance: Provenance;
  try {
    svg = await generateOnChain(seed);
    provenance = "chain";
  } catch {
    // The port is byte-exact (fixture-verified), so art is still correct.
    svg = generateSvgFromSeed(seed);
    provenance = "local-verified";
  }

  const piece: UpegPiece = { id, seed, svg, metadata: decodeSeed(seed), provenance };
  memoryPut(piece);
  storagePut(piece);
  return piece;
}

/** Test hook: clear module-level caches. */
export function __resetResolveCaches(): void {
  memoryCache.clear();
}
