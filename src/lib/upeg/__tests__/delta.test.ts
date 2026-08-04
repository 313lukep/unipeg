import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import {
  computeAliveDelta,
  refreshAliveMap,
  resolveNewSeeds,
} from "../delta";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

describe("computeAliveDelta", () => {
  it("nets out mint+burn of the same id", () => {
    const d = computeAliveDelta(
      [
        { kind: "mint", id: "500000", owner: A },
        { kind: "burn", id: "500000" },
      ],
      100,
    );
    expect(d.added.size).toBe(0);
    expect(d.removed.size).toBe(0);
  });

  it("tracks burns of baseline pieces and ownership of new mints", () => {
    const d = computeAliveDelta(
      [
        { kind: "burn", id: "123" }, // baseline piece burned
        { kind: "mint", id: "500001", owner: A },
        { kind: "transfer", id: "500001", to: B }, // moved after mint
        { kind: "transfer", id: "777", to: B }, // baseline transfer — irrelevant
      ],
      100,
    );
    expect([...d.removed]).toEqual(["123"]);
    expect(d.added.get("500001")).toBe(B);
    expect(d.added.has("777")).toBe(false);
  });
});

function fakeClient(opts: {
  blockNumber?: bigint;
  logs?: unknown[];
  pages?: Record<string, { id: bigint; seed: bigint }[][]>;
}): PublicClient {
  return {
    getBlockNumber: async () => opts.blockNumber ?? 1000n,
    getLogs: async () => opts.logs ?? [],
    readContract: async (args: { args: readonly unknown[] }) => {
      const [owner, page] = args.args as [string, bigint, bigint];
      const pages = opts.pages?.[owner.toLowerCase()] ?? [];
      return pages[Number(page)] ?? [];
    },
  } as unknown as PublicClient;
}

describe("resolveNewSeeds", () => {
  it("finds seeds via paged owner reads, one owner at a time", async () => {
    const added = new Map<string, `0x${string}`>([
      ["500001", A],
      ["500002", A],
    ]);
    const seeds = await resolveNewSeeds(
      added,
      fakeClient({
        pages: {
          [A]: [
            [
              { id: 500001n, seed: 111n },
              { id: 42n, seed: 999n },
              { id: 500002n, seed: 222n },
            ],
          ],
        },
      }),
    );
    expect(seeds.get("500001")).toBe("111");
    expect(seeds.get("500002")).toBe("222");
    expect(seeds.size).toBe(2);
  });

  it("leaves ids unresolved when the owner read fails, without throwing", async () => {
    const client = {
      getBlockNumber: async () => 1000n,
      getLogs: async () => [],
      readContract: async () => {
        throw new Error("revert");
      },
    } as unknown as PublicClient;
    const seeds = await resolveNewSeeds(new Map([["500001", A]]), client);
    expect(seeds.size).toBe(0);
  });
});

describe("refreshAliveMap", () => {
  it("applies mints and burns to the baseline map", async () => {
    const logs = [
      {
        eventName: "OnUpegMinted",
        args: { owner: A, upegId: 500001n },
      },
      {
        eventName: "OnUpegBurned",
        args: { owner: B, upegId: 123n },
      },
    ];
    const result = await refreshAliveMap(
      { map: { "123": "5", "456": "6" }, blockNumber: 900 },
      fakeClient({
        blockNumber: 1000n,
        logs,
        pages: { [A]: [[{ id: 500001n, seed: 12345n }]] },
      }),
    );
    expect(result.map["500001"]).toBe("12345");
    expect(result.map["123"]).toBeUndefined();
    expect(result.map["456"]).toBe("6");
    expect(result.addedCount).toBe(1);
    expect(result.removedCount).toBe(1);
    expect(result.blockNumber).toBe(1000);
  });
});
