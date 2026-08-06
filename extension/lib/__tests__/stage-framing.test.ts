// @vitest-environment node
//
// The board has to be tall enough for the jump. That invariant spans two files
// owned by different halves of this project — the board is sized in
// pages/page.css (and mirrored into tools/build-playable.mjs), the arc is set by
// DEFAULTS.gravity / DEFAULTS.jumpVelocity in lib/game.js — so neither file can
// catch a regression on its own. This test is the seam between them: retune the
// jump and it tells you the framing broke, resize the board and it tells you the
// same. It lives here rather than beside the CSS only because vitest.config.ts's
// `include` covers extension/lib/__tests__ and nothing else under extension/.
//
// The owner's report was "the unipeg jumps out of it". Measured in Chromium on
// the pre-fix board, the sprite's top at apex sat 18px below the top edge at
// 1280px wide (7.3% of the board) and 74px ABOVE it at 390px wide.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DEFAULTS } from "../game.js";
import { DEFAULT_SCALE, flyerScaleFor } from "../sprite.js";

const ROOT = new URL("../../", import.meta.url).pathname;
/** Both files carry block comments between declarations; drop them first. */
const source = (path: string) => readFileSync(`${ROOT}${path}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const PAGE_CSS = source("pages/page.css");
const BUILD_PLAYABLE = source("tools/build-playable.mjs");

/** Headroom the framing must keep above the apex, as a share of board height. */
const MIN_HEADROOM = 0.15;

/**
 * Worst-case runner height in CSS pixels.
 *
 * pages/page.js builds frames at `Math.min(8, 4 * deviceScale())`, so the sprite
 * is 24 cells x 4 = 96 CSS px at a device ratio of 1, the same 96 at 2 (scale 8
 * over a 2x ratio) and 64 at 3 — 96 is the worst of the three. Real frames are
 * cropped to the art's bounding box and come out shorter (the mascot measures
 * 84), so sizing against the full 24 cells covers every piece in the collection.
 */
const SPRITE_CSS_PX = 24 * DEFAULT_SCALE;
const CELL_CSS_PX = DEFAULT_SCALE;

/** lib/game.js's own ground line: `height - max(cellPx * 2, height * 0.14)`. */
function groundY(boardPx: number): number {
  return Math.round(boardPx - Math.max(CELL_CSS_PX * 2, boardPx * 0.14));
}

/** Apex height above the ground line, in px: v^2 / 2g, in sprite heights. */
function apexPx(spriteH = SPRITE_CSS_PX): number {
  return (spriteH * DEFAULTS.jumpVelocity ** 2) / (2 * DEFAULTS.gravity);
}

/** Distance from the top of the board to the sprite's top at apex, in px. */
function apexHeadroomPx(boardPx: number): number {
  return groundY(boardPx) - SPRITE_CSS_PX - apexPx();
}

/** Pull one declaration out of the first rule matching `selector`. */
function declaration(css: string, selector: string, prop: string): string {
  const rule = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(css);
  expect(rule, `${selector} rule not found`).not.toBeNull();
  const found = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(rule![1]);
  expect(found, `${selector} { ${prop} } not found`).not.toBeNull();
  return found![1].trim();
}

/** The px floor inside `min-height: min(<floor>px, calc(...))`. */
function heightFloorPx(css: string, selector: string): number {
  const value = declaration(css, selector, "min-height");
  const px = /min\(\s*(\d+)px/.exec(value);
  expect(px, `${selector} min-height is not a min(<px>, …) floor: ${value}`).not.toBeNull();
  return Number(px![1]);
}

function aspectRatio(css: string, selector: string): number {
  const [w, h] = declaration(css, selector, "aspect-ratio").split("/").map(Number);
  return w / h;
}

describe("stage framing — the board is sized by the jump arc", () => {
  const surfaces: Array<[string, string, string]> = [
    ["extension pages", PAGE_CSS, "\\.stage"],
    ["shareable page", BUILD_PLAYABLE, "#stage"],
  ];

  it.each(surfaces)("%s: the board floor clears the apex with room to spare", (_n, css, sel) => {
    const floor = heightFloorPx(css, sel);
    const headroom = apexHeadroomPx(floor);
    expect(headroom).toBeGreaterThan(0);
    expect(headroom / floor).toBeGreaterThanOrEqual(MIN_HEADROOM);
  });

  it.each(surfaces)("%s: the aspect sits between 5:3 and 2:1, not 5:2", (_n, css, sel) => {
    const ratio = aspectRatio(css, sel);
    expect(ratio).toBeLessThanOrEqual(2);
    expect(ratio).toBeGreaterThanOrEqual(5 / 3);
  });

  it("both surfaces agree on the floor, so the shareable page frames like the extension", () => {
    expect(heightFloorPx(BUILD_PLAYABLE, "#stage")).toBe(heightFloorPx(PAGE_CSS, "\\.stage"));
    expect(aspectRatio(BUILD_PLAYABLE, "#stage")).toBe(aspectRatio(PAGE_CSS, "\\.stage"));
  });

  it("the narrow-screen rule keeps the same floor as the wide one", () => {
    // The runner is the same 96 CSS px tall on a phone, so the arc needs the
    // same room; only the reserve subtracted for page chrome changes.
    const media = /@media \(max-width: 560px\)\s*\{([\s\S]*?)\n\}/.exec(PAGE_CSS);
    expect(media).not.toBeNull();
    expect(heightFloorPx(media![1], "\\.stage")).toBe(heightFloorPx(PAGE_CSS, "\\.stage"));
  });

  it("the high flyer lane is fully visible at the board floor", () => {
    const floor = heightFloorPx(PAGE_CSS, "\\.stage");
    // buildFlyerFrames renders at flyerScaleFor(scale); 24 cells is its worst case.
    const flyerH = 24 * flyerScaleFor(DEFAULT_SCALE);
    const laneTop = groundY(floor) - DEFAULTS.laneHigh * SPRITE_CSS_PX - flyerH;
    expect(laneTop).toBeGreaterThan(0);
  });

  it("a snappier jump still fits: 25% more apex keeps the runner on the board", () => {
    // The jump is being retuned in lib/game.js (higher gravity AND higher
    // velocity). This is the slack that buys: if a change lifts the apex by a
    // quarter, the framing must still hold rather than need resizing again.
    const floor = heightFloorPx(PAGE_CSS, "\\.stage");
    const headroom = groundY(floor) - SPRITE_CSS_PX - apexPx() * 1.25;
    expect(headroom).toBeGreaterThan(0);
  });
});
