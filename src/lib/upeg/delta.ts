import { parseAbiItem, type PublicClient } from "viem";
import { getChainClient } from "./chain";
import { UPEG_TOKEN_ADDRESS } from "./types";
import type { AliveMap } from "./resolve";

/**
 * Live freshness. The bundled snapshot is a block-stamped baseline; this
 * module replays OnUpegMinted / OnUpegBurned / OnUpegTransfer events since
 * that block and patches the alive map, so every user sees the current
 * collection regardless of snapshot age. Seeds for newly-minted pieces are
 * resolved via OwnerUpegsPage on the piece's current owner (batched).
 *
 * Scale notes (500–1000 concurrent users):
 * - one getLogs sweep per session + one every poll interval while visible
 * - poll interval is jittered so clients never fire in lockstep
 * - two independent fallback RPCs (CORS-verified) share the load
 */

const MINTED = parseAbiItem(
  "event OnUpegMinted(address indexed owner, uint256 upegId)",
);
const BURNED = parseAbiItem(
  "event OnUpegBurned(address indexed owner, uint256 upegId)",
);
const TRANSFER = parseAbiItem(
  "event OnUpegTransfer(address indexed from, address indexed to, uint256 upegId)",
);

const PAGE_ABI = [
  {
    type: "function",
    name: "OwnerUpegsPage",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "page", type: "uint256" },
      { name: "pageSize", type: "uint256" },
    ],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "id", type: "uint256" },
          { name: "seed", type: "uint256" },
        ],
      },
    ],
  },
] as const;

const CHUNK = 9_000n; // conservative getLogs window accepted by both RPCs
const PAGE_SIZE = 80n;

export type AliveDelta = {
  /** newly-minted ids still alive, with the owner believed current */
  added: Map<string, `0x${string}`>;
  /** baseline ids that have been burned */
  removed: Set<string>;
  toBlock: number;
};

type UpegEvent =
  | { kind: "mint"; id: string; owner: `0x${string}` }
  | { kind: "burn"; id: string }
  | { kind: "transfer"; id: string; to: `0x${string}` };

/** Fetch and order all upeg lifecycle events since a block (chunked). */
export async function fetchEventsSince(
  fromBlock: number,
  client: PublicClient = getChainClient(),
): Promise<{ events: UpegEvent[]; toBlock: number }> {
  const toBlock = Number(await client.getBlockNumber());
  const events: UpegEvent[] = [];
  for (let start = BigInt(fromBlock); start <= BigInt(toBlock); start += CHUNK + 1n) {
    const end = start + CHUNK > BigInt(toBlock) ? BigInt(toBlock) : start + CHUNK;
    const logs = await client.getLogs({
      address: UPEG_TOKEN_ADDRESS,
      events: [MINTED, BURNED, TRANSFER],
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      const anyLog = log as unknown as {
        eventName: string;
        args: Record<string, unknown>;
      };
      const id = String(anyLog.args.upegId);
      if (anyLog.eventName === "OnUpegMinted") {
        events.push({ kind: "mint", id, owner: anyLog.args.owner as `0x${string}` });
      } else if (anyLog.eventName === "OnUpegBurned") {
        events.push({ kind: "burn", id });
      } else if (anyLog.eventName === "OnUpegTransfer") {
        events.push({ kind: "transfer", id, to: anyLog.args.to as `0x${string}` });
      }
    }
  }
  return { events, toBlock };
}

/** Pure replay: ordered events -> net delta against the baseline. */
export function computeAliveDelta(
  events: UpegEvent[],
  toBlock: number,
): AliveDelta {
  const added = new Map<string, `0x${string}`>();
  const removed = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "mint") {
      added.set(ev.id, ev.owner);
      removed.delete(ev.id);
    } else if (ev.kind === "burn") {
      if (added.has(ev.id)) added.delete(ev.id);
      else removed.add(ev.id);
    } else if (added.has(ev.id)) {
      added.set(ev.id, ev.to); // track current owner of new pieces only
    }
  }
  return { added, removed, toBlock };
}

/** Resolve seeds for newly-minted ids, one paged read per distinct owner. */
export async function resolveNewSeeds(
  added: Map<string, `0x${string}`>,
  client: PublicClient = getChainClient(),
): Promise<Map<string, string>> {
  const byOwner = new Map<`0x${string}`, Set<string>>();
  for (const [id, owner] of added) {
    const set = byOwner.get(owner) ?? new Set<string>();
    set.add(id);
    byOwner.set(owner, set);
  }
  const seeds = new Map<string, string>();
  for (const [owner, wanted] of byOwner) {
    for (let page = 0n; ; page++) {
      let rows: readonly { id: bigint; seed: bigint }[];
      try {
        rows = await client.readContract({
          address: UPEG_TOKEN_ADDRESS,
          abi: PAGE_ABI,
          functionName: "OwnerUpegsPage",
          args: [owner, page, PAGE_SIZE],
        });
      } catch {
        break; // owner emptied since the event — their ids just stay unresolved
      }
      for (const row of rows) {
        const id = row.id.toString();
        if (wanted.has(id)) {
          seeds.set(id, row.seed.toString());
          wanted.delete(id);
        }
      }
      if (wanted.size === 0 || rows.length < Number(PAGE_SIZE)) break;
    }
  }
  return seeds;
}

export type RefreshResult = {
  map: AliveMap;
  blockNumber: number;
  addedCount: number;
  removedCount: number;
};

/** Baseline + events => current alive map. Pure apart from the injected IO. */
export async function refreshAliveMap(
  baseline: { map: AliveMap; blockNumber: number },
  client: PublicClient = getChainClient(),
): Promise<RefreshResult> {
  const { events, toBlock } = await fetchEventsSince(
    baseline.blockNumber + 1,
    client,
  );
  const delta = computeAliveDelta(events, toBlock);
  const seeds = await resolveNewSeeds(delta.added, client);
  const map: AliveMap = { ...baseline.map };
  let addedCount = 0;
  for (const [id, seed] of seeds) {
    if (!map[id]) addedCount++;
    map[id] = seed;
  }
  let removedCount = 0;
  for (const id of delta.removed) {
    if (map[id]) {
      delete map[id];
      removedCount++;
    }
  }
  return { map, blockNumber: toBlock, addedCount, removedCount };
}
