import layersData from "./layers.json";
import { UPEG_BACKGROUND_COLORS, UPEG_COLORS } from "./palette";
import { decodeSeed } from "./seed";
import type { UpegMetadata } from "./types";

/**
 * TypeScript port of the on-chain SvgGenerator, byte-exact against
 * `UpegHook.generate(seed)` — verified by fixture tests over real pieces
 * (see __tests__/renderer.test.ts). Layer rect data was extracted from the
 * live contract by calling generate() with single-layer seeds and parsing
 * the result (probe round 2); palettes and paint order come from the
 * verified source.
 */

type LayerName =
  | "body" | "horn" | "accessories" | "wings" | "hair"
  | "tail" | "legsFront" | "legsBack" | "ground" | "eyes";

type LayerRects = { variant: number; rects: [number, number, number, number][] };

const LAYERS = layersData.layers as Record<LayerName, LayerRects[]>;

function rect(x: number, y: number, w: number, h: number, fill: string): string {
  return `<rect x='${x}' y='${y}' width='${w}' height='${h}' fill='${fill}'/>`;
}

function layerSvg(name: LayerName, variant: number, fill: string): string {
  const layer = LAYERS[name]?.find((l) => l.variant === variant);
  // The contract renders nothing for an unknown variant id (empty storage array).
  if (!layer) return "";
  return layer.rects.map(([x, y, w, h]) => rect(x, y, w, h, fill)).join("");
}

/** Exact port of SvgGenerator.generateSvg — same string, same paint order. */
export function generateSvgFromMetadata(m: UpegMetadata): string {
  const colour = (i: number) => UPEG_COLORS[i % UPEG_COLORS.length];
  let svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>" +
    rect(0, 0, 24, 24, UPEG_BACKGROUND_COLORS[m.backGroundColor % UPEG_BACKGROUND_COLORS.length]);
  if (m.body > 0) svg += layerSvg("body", m.body, colour(m.bodyColor));
  if (m.horn > 0) svg += layerSvg("horn", m.horn, colour(m.hornColor));
  if (m.accessories > 0) svg += layerSvg("accessories", m.accessories, colour(m.accessoriesColor));
  if (m.wings > 0) svg += layerSvg("wings", m.wings, colour(m.bodyColor));
  if (m.hair > 0) svg += layerSvg("hair", m.hair, colour(m.hairColor));
  if (m.tail > 0) svg += layerSvg("tail", m.tail, colour(m.tailColor));
  if (m.legsFront > 0) svg += layerSvg("legsFront", m.legsFront, colour(m.bodyColor));
  if (m.legsBack > 0) svg += layerSvg("legsBack", m.legsBack, colour(m.bodyColor));
  if (m.ground > 0) svg += layerSvg("ground", m.ground, colour(m.groundColor));
  if (m.eyes > 0) svg += layerSvg("eyes", m.eyes, colour(m.eyesColor));
  return svg + "</svg>";
}

/** Exact port of SvgGenerator.generate(seed). */
export function generateSvgFromSeed(seed: bigint): string {
  return generateSvgFromMetadata(decodeSeed(seed));
}
