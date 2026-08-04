import { beforeEach, describe, expect, it, vi } from "vitest";
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
  });
  it.each(["0", "-3", "1.5", "abc", ""])("rejects %j", (bad) => {
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
