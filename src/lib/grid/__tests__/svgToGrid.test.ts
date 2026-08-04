import { describe, expect, it } from "vitest";
import { svgToGrid, svgToGridFromRects } from "../svgToGrid";
import { gridsEqual } from "../grid";
import { GridValidationError } from "../types";
import { PALETTE } from "./helpers";

const { bg, body, mane, horn, dark } = PALETTE;

/** Realistic on-chain-style fixture, viewBox 0 0 24 24, direct fills. */
const FIXTURE_24 = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges">
  <!-- background -->
  <rect x="0" y="0" width="24" height="24" fill="${bg}"/>
  <rect x="4" y="10" width="12" height="8" fill="${body}"/>
  <rect x="14" y="5" width="6" height="6" fill="${body}"/>
  <rect x="12" y="4" width="2" height="7" fill="${mane}"/>
  <rect x="16" y="1" width="1" height="4" fill="${horn}"/>
  <rect x="17" y="7" width="1" height="1" fill="${dark}"/>
  <rect x="5" y="18" width="2" height="4" fill="${body}"/>
  <rect x="11" y="18" width="2" height="4" fill="${body}"/>
</svg>`;

/**
 * Same art at 20x scale (viewBox 0 0 480 480), exercising class+<style>
 * fills and fill inheritance from a <g> parent.
 */
const FIXTURE_480 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480">
  <style>
    .bg { fill: ${bg}; }
    .mane { fill: ${mane}; }
    .horn { fill: ${horn}; }
  </style>
  <rect x="0" y="0" width="480" height="480" class="bg"/>
  <g fill="${body}">
    <rect x="80" y="200" width="240" height="160"/>
    <rect x="280" y="100" width="120" height="120"/>
    <rect x="100" y="360" width="40" height="80"/>
    <rect x="220" y="360" width="40" height="80"/>
  </g>
  <rect x="240" y="80" width="40" height="140" class="mane"/>
  <rect x="320" y="20" width="20" height="80" class="horn"/>
  <rect x="340" y="140" width="20" height="20" style="fill: ${dark}"/>
</svg>`;

describe("svgToGridFromRects", () => {
  it("parses a 24x24 viewBox fixture into a fully painted grid", () => {
    const g = svgToGridFromRects(FIXTURE_24);
    expect(g.w).toBe(24);
    expect(g.h).toBe(24);
    expect(g.palette).toHaveLength(5);
    expect(g.palette).toContain(bg);
    // spot checks
    expect(g.cells[0][0]).toBe(bg);
    expect(g.cells[12][10]).toBe(body);
    expect(g.cells[7][17]).toBe(dark); // eye
    expect(g.cells[2][16]).toBe(horn);
    expect(g.cells[6][13]).toBe(mane);
    for (const row of g.cells) for (const c of row) expect(c).not.toBeNull();
  });

  it("parses the 20x-scaled variant (class fills + <g> inheritance) to the same grid", () => {
    const a = svgToGridFromRects(FIXTURE_24);
    const b = svgToGridFromRects(FIXTURE_480);
    expect(gridsEqual(a, b)).toBe(true);
  });

  it("throws on rects that miss the cell lattice", () => {
    const off = FIXTURE_24.replace('x="17" y="7"', 'x="17.5" y="7"');
    expect(() => svgToGridFromRects(off)).toThrow(GridValidationError);
  });

  it("throws when the grid is not fully painted (missing background rect)", () => {
    const noBg = FIXTURE_24.replace(
      `<rect x="0" y="0" width="24" height="24" fill="${bg}"/>`,
      "",
    );
    expect(() => svgToGridFromRects(noBg)).toThrow(GridValidationError);
    expect(() => svgToGridFromRects(noBg)).toThrow(/not fully painted/);
  });

  it("throws on a single-colour palette", () => {
    const flat = `<svg viewBox="0 0 24 24"><rect x="0" y="0" width="24" height="24" fill="#ffffff"/></svg>`;
    expect(() => svgToGridFromRects(flat)).toThrow(GridValidationError);
  });

  it("throws on malformed input", () => {
    expect(() => svgToGridFromRects("not an svg at all")).toThrow(GridValidationError);
    expect(() => svgToGridFromRects("<svg><rect/></svg>")).toThrow(GridValidationError);
  });

  it("ignores rects inside non-rendered containers (<defs>, <clipPath>, <mask>)", () => {
    // Regression: resource rects were painted (and lattice-validated) as if
    // they were geometry. The clip rect below is even off-lattice — it must
    // be skipped entirely, not throw.
    const withDefs = FIXTURE_24.replace(
      "</svg>",
      `<defs>
         <clipPath id="clip"><rect x="0.5" y="0.5" width="10.25" height="10.25"/></clipPath>
         <mask id="m"><rect x="0" y="0" width="24" height="24" fill="white"/></mask>
         <pattern id="p" width="4" height="4"><rect x="0" y="0" width="2" height="2" fill="#123456"/></pattern>
       </defs></svg>`,
    );
    const a = svgToGridFromRects(FIXTURE_24);
    const b = svgToGridFromRects(withDefs);
    expect(gridsEqual(a, b)).toBe(true);
    expect(b.palette).not.toContain("#ffffff");
    expect(b.palette).not.toContain("#123456");
  });

  it("resolves fill precedence like the browser cascade (style/class beat the fill attribute)", () => {
    // Regression: the parser used to check the fill presentation attribute
    // first, inverting the CSS cascade. A browser resolves inline style >
    // class rule > fill attribute > inherited — the rect parser must match,
    // or the same SVG yields different grids in node vs the canvas path.
    const base = (cellRect: string) => `<svg viewBox="0 0 24 24">
      <style>.c1 { fill: #ff00ff; }</style>
      <rect x="0" y="0" width="24" height="24" fill="${bg}"/>
      ${cellRect}
    </svg>`;

    // style="" beats the fill attribute
    const styleVsAttr = svgToGridFromRects(
      base(`<rect x="0" y="0" width="1" height="1" fill="#111111" style="fill:#222222"/>`),
    );
    expect(styleVsAttr.cells[0][0]).toBe("#222222");

    // class rule beats the fill attribute
    const classVsAttr = svgToGridFromRects(
      base(`<rect x="0" y="0" width="1" height="1" fill="#111111" class="c1"/>`),
    );
    expect(classVsAttr.cells[0][0]).toBe("#ff00ff");

    // style="" beats a class rule (already correct — pinned here)
    const styleVsClass = svgToGridFromRects(
      base(`<rect x="0" y="0" width="1" height="1" class="c1" style="fill:#222222"/>`),
    );
    expect(styleVsClass.cells[0][0]).toBe("#222222");

    // fill attribute still beats an inherited <g> fill
    const attrVsInherited = svgToGridFromRects(
      base(`<g fill="#333333"><rect x="0" y="0" width="1" height="1" fill="#111111"/></g>`),
    );
    expect(attrVsInherited.cells[0][0]).toBe("#111111");

    // class rule beats an inherited <g> fill (already correct — pinned here)
    const classVsInherited = svgToGridFromRects(
      base(`<g fill="#333333"><rect x="0" y="0" width="1" height="1" class="c1"/></g>`),
    );
    expect(classVsInherited.cells[0][0]).toBe("#ff00ff");
  });

  it("throws on rects outside the viewBox", () => {
    const out = `<svg viewBox="0 0 24 24">
      <rect x="0" y="0" width="24" height="24" fill="#ffffff"/>
      <rect x="20" y="20" width="8" height="8" fill="#000000"/>
    </svg>`;
    expect(() => svgToGridFromRects(out)).toThrow(GridValidationError);
  });
});

describe("svgToGrid (async)", () => {
  it("is node-safe and falls back to the rect parser without a DOM", async () => {
    const g = await svgToGrid(FIXTURE_24);
    expect(gridsEqual(g, svgToGridFromRects(FIXTURE_24))).toBe(true);
  });

  it("rejects with GridValidationError when both paths fail", async () => {
    await expect(svgToGrid("<svg></svg>")).rejects.toThrow(GridValidationError);
  });
});
