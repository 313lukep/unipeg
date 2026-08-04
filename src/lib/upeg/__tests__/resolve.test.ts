import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetResolveCaches, resolvePiece, validatePieceId } from "../resolve";
import { generateSvgFromSeed } from "../renderer";
import { UpegLookupError } from "../types";
import fixtures from "./fixtures.json";

const pair = (fixtures as { pairs: { id: string; seed: string; svg?: string }[] }).pairs.find(
  (p) => p.svg,
)!;

const aliveMap = { [pair.id]: pair.seed };

beforeEach(() => {
  __resetResolveCaches();
});

describe("validatePieceId", () => {
  it("accepts integers and #-prefixed strings", () => {
    expect(validatePieceId(42)).toBe(42);
    expect(validatePieceId(" #381204 ")).toBe(381204);
    expect(validatePieceId("1000")).toBe(1000);
    expect(validatePieceId("007")).toBe(7);
  });
  it.each([
    "0",
    "-3",
    "1.5",
    "abc",
    "",
    // Regression: Number() coercion accepted scientific notation and other
    // radix prefixes — ids are strict decimal digits (optional leading #).
    "1e3",
    "0x10",
    "0b101",
    "0o17",
    "12.0",
    "1,000",
    "+5",
    "Infinity",
    "#1e3",
  ])("rejects %j", (bad) => {
    expect(() => validatePieceId(bad)).toThrowError(UpegLookupError);
  });
});

describe("resolvePiece", () => {
  it("returns chain provenance when the RPC succeeds", async () => {
    const piece = await resolvePiece(pair.id, {
      loadAliveMap: async () => aliveMap,
      generateOnChain: async () => pair.svg!,
      totalCount: async () => 400000,
    });
    expect(piece.provenance).toBe("chain");
    expect(piece.svg).toBe(pair.svg);
    expect(piece.seed).toBe(BigInt(pair.seed));
  });

  it("falls back to the verified local port when the RPC fails", async () => {
    const piece = await resolvePiece(pair.id, {
      loadAliveMap: async () => aliveMap,
      generateOnChain: async () => {
        throw new UpegLookupError("network", "rpc down");
      },
      totalCount: async () => 400000,
    });
    expect(piece.provenance).toBe("local-verified");
    // and the local port produces the same bytes as the chain did
    expect(piece.svg).toBe(pair.svg);
    expect(piece.svg).toBe(generateSvgFromSeed(BigInt(pair.seed)));
  });

  it("distinguishes out-of-range from not-alive", async () => {
    const deps = {
      loadAliveMap: async () => aliveMap,
      generateOnChain: async () => pair.svg!,
      totalCount: async () => 1000,
    };
    await expect(resolvePiece(5000, deps)).rejects.toMatchObject({ code: "out-of-range" });
    await expect(resolvePiece(999, deps)).rejects.toMatchObject({ code: "not-alive" });
  });

  it("still reports not-alive when the chain is unreachable", async () => {
    await expect(
      resolvePiece(999, {
        loadAliveMap: async () => aliveMap,
        generateOnChain: async () => {
          throw new Error("down");
        },
        totalCount: async () => {
          throw new UpegLookupError("network", "down");
        },
      }),
    ).rejects.toMatchObject({ code: "not-alive" });
  });

  it("serves repeat lookups from cache without re-fetching", async () => {
    const generateOnChain = vi.fn(async () => pair.svg!);
    const loadAliveMap = vi.fn(async () => aliveMap);
    const deps = { loadAliveMap, generateOnChain, totalCount: async () => 400000 };
    await resolvePiece(pair.id, deps);
    await resolvePiece(pair.id, deps);
    expect(generateOnChain).toHaveBeenCalledTimes(1);
    expect(loadAliveMap).toHaveBeenCalledTimes(1);
  });

  describe("localStorage piece cache", () => {
    const LS_INDEX = "unipegpfp.piece-ids";
    const LS_PREFIX = "unipegpfp.piece.";

    function installLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
      const store = new Map(Object.entries(initial));
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
          return store.size;
        },
      });
      return store;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("still caps stored pieces at 40 when the index JSON is corrupt", async () => {
      // Regression: the piece item was written BEFORE the index parse; a
      // corrupt index JSON threw, abandoned eviction, and orphaned entries
      // beyond the 40 cap forever.
      const store = installLocalStorage({ [LS_INDEX]: "{corrupt json[[" });
      const deps = {
        loadAliveMap: async () =>
          Object.fromEntries(Array.from({ length: 45 }, (_, i) => [String(i + 1), pair.seed])),
        generateOnChain: async () => pair.svg!,
        totalCount: async () => 400000,
      };
      for (let id = 1; id <= 45; id++) {
        __resetResolveCaches(); // force each lookup through storagePut
        await resolvePiece(id, deps);
      }
      const index = JSON.parse(store.get(LS_INDEX)!) as number[];
      expect(index).toHaveLength(40);
      expect(index[0]).toBe(45); // most recent first
      const pieceKeys = [...store.keys()].filter((k) => k.startsWith(LS_PREFIX));
      expect(pieceKeys).toHaveLength(40); // no orphans beyond the cap
      expect(store.has(LS_PREFIX + "1")).toBe(false); // oldest evicted
      expect(store.has(LS_PREFIX + "5")).toBe(false);
      expect(store.has(LS_PREFIX + "6")).toBe(true);
      expect(store.has(LS_PREFIX + "45")).toBe(true);
    });

    it("treats a non-array index as empty and recovers", async () => {
      const store = installLocalStorage({ [LS_INDEX]: JSON.stringify({ nope: true }) });
      await resolvePiece(pair.id, {
        loadAliveMap: async () => aliveMap,
        generateOnChain: async () => pair.svg!,
        totalCount: async () => 400000,
      });
      expect(JSON.parse(store.get(LS_INDEX)!)).toEqual([Number(pair.id)]);
      expect(store.has(LS_PREFIX + pair.id)).toBe(true);
    });
  });

  it("surfaces dataset failure as a typed error", async () => {
    await expect(
      resolvePiece(pair.id, {
        loadAliveMap: async () => {
          throw new UpegLookupError("dataset-unavailable", "404");
        },
        generateOnChain: async () => pair.svg!,
        totalCount: async () => 400000,
      }),
    ).rejects.toMatchObject({ code: "dataset-unavailable" });
  });
});
