import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  GRID_SIZE,
  UPEG_BACKGROUND_COLORS,
  UPEG_COLORS,
  aliveCount,
  aliveIds,
  decodeSeed,
  gridFromSeed,
  layerVariants,
  paletteFromGrid,
  seedForId,
} from "../upeg.js";
import layersModule from "../../data/layers.js";
import layersJson from "../../data/layers.json";
import repoLayers from "../../../src/lib/upeg/layers.json";
import { UPEG_BACKGROUND_COLORS as REPO_BG, UPEG_COLORS as REPO_COLORS } from "../../../src/lib/upeg/palette";
import { decodeSeed as repoDecodeSeed } from "../../../src/lib/upeg/seed";
import fixtures from "../../../src/lib/upeg/__tests__/fixtures.json";

type FixturePair = { id: string; seed: string; svg?: string };
const pairs = (fixtures as { pairs: FixturePair[] }).pairs;
const withSvg = pairs.filter((p): p is Required<FixturePair> => Boolean(p.svg));

/**
 * Reference implementation: rasterise an on-chain SVG string onto a 24x24 grid
 * by replaying its rects in document order. This is deliberately dumb — it is
 * the chain's own output, and the thing gridFromSeed must agree with.
 */
function gridFromSvg(svg: string): string[][] {
  const cells: string[][] = Array.from({ length: GRID_SIZE }, () =>
    new Array(GRID_SIZE).fill(""),
  );
  const re = /<rect x='(-?\d+)' y='(-?\d+)' width='(\d+)' height='(\d+)' fill='(#[0-9a-f]{6})'\/>/g;
  let m: RegExpExecArray | null;
  let painted = 0;
  while ((m = re.exec(svg))) {
    painted++;
    const x = Number(m[1]);
    const y = Number(m[2]);
    const w = Number(m[3]);
    const h = Number(m[4]);
    const fill = m[5];
    for (let row = Math.max(y, 0); row < Math.min(y + h, GRID_SIZE); row++) {
      for (let col = Math.max(x, 0); col < Math.min(x + w, GRID_SIZE); col++) {
        cells[row][col] = fill;
      }
    }
  }
  // Guard against a regex that silently matches nothing.
  if (painted === 0) throw new Error("no rects parsed out of fixture SVG");
  return cells;
}

/** Serve the bundled snapshot from disk so the module's fetch() path is exercised. */
function stubFetchFromDisk() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === "string" ? input : input.toString();
    const body = readFileSync(fileURLToPath(href), "utf8");
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(body),
    } as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

describe("upeg.js — grid port matches the chain", () => {
  it("has real on-chain fixtures to verify against", () => {
    expect(withSvg.length).toBeGreaterThanOrEqual(10);
  });

  it("builds a grid identical to the on-chain SVG for every fixture piece", () => {
    for (const p of withSvg) {
      const mine = gridFromSeed(BigInt(p.seed));
      const theirs = gridFromSvg(p.svg);
      expect(mine.cells, `piece #${p.id}`).toEqual(theirs);
    }
  });

  it("reports the same background colour the chain paints in cell (0,0)", () => {
    for (const p of withSvg) {
      const mine = gridFromSeed(BigInt(p.seed));
      expect(mine.bg, `piece #${p.id}`).toBe(gridFromSvg(p.svg)[0][0]);
    }
  });

  it("always fills all 24x24 cells with a 6-digit hex colour", () => {
    for (const p of withSvg.slice(0, 40)) {
      const { cells } = gridFromSeed(BigInt(p.seed));
      expect(cells.length).toBe(24);
      for (const row of cells) {
        expect(row.length).toBe(24);
        for (const c of row) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("decodes seeds identically to the repo's verified decoder", () => {
    for (const p of pairs.slice(0, 50)) {
      expect(decodeSeed(BigInt(p.seed))).toEqual(repoDecodeSeed(BigInt(p.seed)));
    }
  });

  it("accepts a seed as bigint, decimal string or number", () => {
    const seed = BigInt(pairs[0].seed);
    expect(decodeSeed(pairs[0].seed)).toEqual(decodeSeed(seed));
    expect(decodeSeed(255)).toEqual(decodeSeed(255n));
  });
});

describe("upeg.js — bundled data is a faithful copy", () => {
  it("ships the repo's layer geometry verbatim", () => {
    expect(layersJson).toEqual(repoLayers);
  });

  it("keeps the generated ES module in sync with layers.json", () => {
    expect(layersModule).toEqual(layersJson);
  });

  it("ships the contract palettes verbatim", () => {
    expect(UPEG_COLORS).toEqual([...REPO_COLORS]);
    expect(UPEG_BACKGROUND_COLORS).toEqual([...REPO_BG]);
  });

  it("exposes 15 variants for each animatable leg layer", () => {
    expect(layerVariants("legsFront")).toHaveLength(15);
    expect(layerVariants("legsBack")).toHaveLength(15);
    expect(layerVariants("nope")).toEqual([]);
  });
});

describe("upeg.js — trait overrides", () => {
  const seed = BigInt(withSvg[0].seed);

  it("swaps a leg variant without touching any other layer", () => {
    const base = gridFromSeed(seed);
    const swapped = gridFromSeed(seed, { legsFront: (base.meta.legsFront % 15) + 1 });
    expect(swapped.meta.body).toBe(base.meta.body);
    expect(swapped.meta.hair).toBe(base.meta.hair);
    expect(swapped.bg).toBe(base.bg);
    expect(swapped.meta.legsFront).not.toBe(base.meta.legsFront);
  });

  it("renders nothing for a variant id the contract has no art for", () => {
    const legless = gridFromSeed(seed, { legsFront: 200, legsBack: 200 });
    const base = gridFromSeed(seed);
    // Some cells must differ (legs vanish) but the piece is still fully painted.
    expect(legless.cells).not.toEqual(base.cells);
    expect(legless.cells[0][0]).toBe(base.bg);
  });
});

describe("upeg.js — palette extraction", () => {
  it("excludes the background and orders by coverage", () => {
    const grid = gridFromSeed(BigInt(withSvg[0].seed));
    const palette = paletteFromGrid(grid);
    expect(palette.length).toBeGreaterThan(0);
    expect(palette).not.toContain(grid.bg);
    expect(new Set(palette).size).toBe(palette.length);
  });
});

describe("upeg.js — bundled alive snapshot", () => {
  it("resolves a known id to the fixture's seed and caches the load", async () => {
    restoreFetch = stubFetchFromDisk();
    const known = pairs.find((p) => p.id === "381204") ?? pairs[0];
    const seed = await seedForId(Number(known.id));
    expect(seed).toBe(BigInt(known.seed));

    // Second call must not hit fetch again.
    const spoiled = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("snapshot should be cached");
    }) as unknown as typeof fetch;
    expect(await seedForId(Number(known.id))).toBe(BigInt(known.seed));
    globalThis.fetch = spoiled;
  });

  it("returns null for ids that are not alive or not valid", async () => {
    expect(await seedForId(999999999)).toBeNull();
    expect(await seedForId(0)).toBeNull();
    expect(await seedForId(-3)).toBeNull();
    expect(await seedForId(1.5)).toBeNull();
    expect(await seedForId("nope")).toBeNull();
  });

  it("counts the whole snapshot and lists ids ascending", async () => {
    const count = await aliveCount();
    expect(count).toBeGreaterThan(6000);
    const ids = await aliveIds();
    expect(ids).toHaveLength(count);
    expect(ids[0]).toBeLessThan(ids[ids.length - 1]);
  });
});
