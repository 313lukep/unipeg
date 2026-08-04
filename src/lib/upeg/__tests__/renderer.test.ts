import { describe, expect, it } from "vitest";
import { decodeSeed, encodeMetadata } from "../seed";
import { generateSvgFromSeed } from "../renderer";
import fixtures from "./fixtures.json";

type FixturePair = { id: string; seed: string; svg?: string };

const pairs = (fixtures as { pairs: FixturePair[] }).pairs;
const withSvg = pairs.filter((p): p is Required<FixturePair> => Boolean(p.svg));

describe("on-chain renderer port", () => {
  it("has real fixtures to verify against", () => {
    expect(withSvg.length).toBeGreaterThanOrEqual(10);
  });

  it("reproduces the on-chain SVG byte-for-byte for every fixture piece", () => {
    for (const p of withSvg) {
      const local = generateSvgFromSeed(BigInt(p.seed));
      expect(local, `piece #${p.id}`).toBe(p.svg);
    }
  });

  it("round-trips seed encode/decode", () => {
    for (const p of pairs.slice(0, 20)) {
      const seed = BigInt(p.seed);
      // Only the 18 low bytes carry metadata; the rest of the seed is entropy
      // and owner hash, so compare re-encoding of the decoded fields.
      const m = decodeSeed(seed);
      expect(decodeSeed(encodeMetadata(m))).toEqual(m);
    }
  });

  it("every fixture SVG is a 24x24 viewBox with a full-bleed background rect", () => {
    for (const p of withSvg) {
      expect(p.svg.startsWith("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>")).toBe(true);
      expect(p.svg).toContain("<rect x='0' y='0' width='24' height='24'");
    }
  });
});
