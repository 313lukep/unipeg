import type { UpegMetadata } from "./types";

/**
 * Seed byte layout, ported from the verified UpegMetadataLibrary:
 * byte 0 backGroundColor · 1 horn · 2 accessories · 3 hair · 4 wings · 5 tail ·
 * 6 legsFront · 7 legsBack · 8 eyes · 9 body · 10 ground · 11 bodyColor ·
 * 12 eyesColor · 13 hairColor · 14 hornColor · 15 groundColor ·
 * 16 accessoriesColor · 17 tailColor. Trait value 0 = layer absent;
 * colour value 0 = real palette index 0.
 */
export function decodeSeed(seed: bigint): UpegMetadata {
  const byte = (shift: bigint) => Number((seed >> shift) & 0xffn);
  return {
    backGroundColor: byte(0n),
    horn: byte(8n),
    accessories: byte(16n),
    hair: byte(24n),
    wings: byte(32n),
    tail: byte(40n),
    legsFront: byte(48n),
    legsBack: byte(56n),
    eyes: byte(64n),
    body: byte(72n),
    ground: byte(80n),
    bodyColor: byte(88n),
    eyesColor: byte(96n),
    hairColor: byte(104n),
    hornColor: byte(112n),
    groundColor: byte(120n),
    accessoriesColor: byte(128n),
    tailColor: byte(136n),
  };
}

export function encodeMetadata(m: UpegMetadata): bigint {
  return (
    (BigInt(m.backGroundColor) << 0n) |
    (BigInt(m.horn) << 8n) |
    (BigInt(m.accessories) << 16n) |
    (BigInt(m.hair) << 24n) |
    (BigInt(m.wings) << 32n) |
    (BigInt(m.tail) << 40n) |
    (BigInt(m.legsFront) << 48n) |
    (BigInt(m.legsBack) << 56n) |
    (BigInt(m.eyes) << 64n) |
    (BigInt(m.body) << 72n) |
    (BigInt(m.ground) << 80n) |
    (BigInt(m.bodyColor) << 88n) |
    (BigInt(m.eyesColor) << 96n) |
    (BigInt(m.hairColor) << 104n) |
    (BigInt(m.hornColor) << 112n) |
    (BigInt(m.groundColor) << 120n) |
    (BigInt(m.accessoriesColor) << 128n) |
    (BigInt(m.tailColor) << 136n)
  );
}
