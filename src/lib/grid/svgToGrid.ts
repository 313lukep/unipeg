import { Grid, GridValidationError } from "./types";
import { makeGrid, recomputePalette } from "./grid";
import { rgbToHex } from "./colour";

/**
 * SVG -> 24x24 Grid.
 *
 * `svgToGridFromRects` is a pure XML/string path (regex tokenizer, no DOM
 * APIs) so it works identically in node and the browser. `svgToGrid` prefers
 * a browser canvas rasterise when a DOM is available and falls back to the
 * rect parser; importing this module never touches the DOM at module scope.
 */

const GRID_SIZE = 24;

const NAMED_COLOURS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  magenta: "#ff00ff",
  cyan: "#00ffff",
  pink: "#ffc0cb",
  gray: "#808080",
  grey: "#808080",
};

/** Normalise an SVG fill value to lowercase "#rrggbb"; null for "none". */
function parseFillValue(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/;$/, "");
  if (v === "none" || v === "transparent") return null;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(v);
  if (rgb) return rgbToHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
  if (v in NAMED_COLOURS) return NAMED_COLOURS[v];
  throw new GridValidationError(`unsupported fill colour "${raw}"`);
}

/** Parse attributes out of the inside of a tag. */
function parseAttrs(tagBody: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([:A-Za-z_][-.:\w]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagBody)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  return attrs;
}

/** Collect `.class { fill: ... }` rules from every <style> block. */
function parseClassFills(svg: string): Map<string, string | null> {
  const fills = new Map<string, string | null>();
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = styleRe.exec(svg)) !== null) {
    const css = sm[1];
    const ruleRe = /\.([A-Za-z_][-\w]*)\s*\{([^}]*)\}/g;
    let rm: RegExpExecArray | null;
    while ((rm = ruleRe.exec(css)) !== null) {
      const fill = /(?:^|;)\s*fill\s*:\s*([^;]+)/.exec(rm[2]);
      if (fill) fills.set(rm[1], parseFillValue(fill[1]));
    }
  }
  return fills;
}

/**
 * Resolve the fill for an element, matching the CSS cascade a browser
 * applies: inline `style=""` > class rule from a <style> block > the `fill`
 * presentation attribute > inherited fill from an ancestor.
 */
function resolveFill(
  attrs: Record<string, string>,
  classFills: Map<string, string | null>,
  inherited: string | null | undefined,
): string | null | undefined {
  if (attrs.style !== undefined) {
    const m = /(?:^|;)\s*fill\s*:\s*([^;]+)/.exec(attrs.style);
    if (m) return parseFillValue(m[1]);
  }
  if (attrs.class !== undefined) {
    for (const cls of attrs.class.trim().split(/\s+/)) {
      if (classFills.has(cls)) return classFills.get(cls);
    }
  }
  if (attrs.fill !== undefined) return parseFillValue(attrs.fill);
  return inherited;
}

function numAttr(attrs: Record<string, string>, name: string, fallback?: number): number {
  const raw = attrs[name];
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new GridValidationError(`<rect> missing required attribute "${name}"`);
  }
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) {
    throw new GridValidationError(`<rect> attribute ${name}="${raw}" is not a number`);
  }
  return v;
}

/** Divide a viewBox coordinate by the cell scale; must land on an integer cell boundary. */
function toCell(v: number, scale: number, what: string): number {
  const c = v / scale;
  const r = Math.round(c);
  if (Math.abs(c - r) > 1e-4) {
    throw new GridValidationError(
      `${what} = ${v} does not land on an integer cell boundary (scale ${scale})`,
    );
  }
  return r;
}

/**
 * Parse an on-chain-style SVG built from <rect> elements into a 24x24 grid.
 *
 * - fill may come from the rect itself (attribute or style=""), from a CSS
 *   class declared in a <style> block, or be inherited from a <g>/<svg>
 *   ancestor. Precedence follows the browser cascade: style="" beats a
 *   class rule, which beats the fill presentation attribute, which beats
 *   an inherited fill.
 * - viewBox may be "0 0 24 24" or any clean multiple ("0 0 480 480"); all
 *   rect coordinates must land on integer cell boundaries after scaling.
 * - Validates the result is exactly 24x24, fully painted, palette size 2..20.
 */
export function svgToGridFromRects(svg: string): Grid {
  const src = svg.replace(/<!--[\s\S]*?-->/g, "");

  const svgTag = /<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(src);
  if (!svgTag) throw new GridValidationError("no <svg> element found");
  const svgAttrs = parseAttrs(svgTag[1]);

  let minX = 0;
  let minY = 0;
  let vbW: number;
  let vbH: number;
  if (svgAttrs.viewbox !== undefined) {
    const parts = svgAttrs.viewbox.trim().split(/[\s,]+/).map(parseFloat);
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p))) {
      throw new GridValidationError(`unparseable viewBox "${svgAttrs.viewbox}"`);
    }
    [minX, minY, vbW, vbH] = parts;
  } else if (svgAttrs.width !== undefined && svgAttrs.height !== undefined) {
    vbW = parseFloat(svgAttrs.width);
    vbH = parseFloat(svgAttrs.height);
    if (!Number.isFinite(vbW) || !Number.isFinite(vbH)) {
      throw new GridValidationError("svg has no viewBox and unparseable width/height");
    }
  } else {
    throw new GridValidationError("svg has neither viewBox nor width/height");
  }
  if (vbW <= 0 || vbH <= 0) {
    throw new GridValidationError(`degenerate viewBox size ${vbW}x${vbH}`);
  }
  const scaleX = vbW / GRID_SIZE;
  const scaleY = vbH / GRID_SIZE;

  const classFills = parseClassFills(src);
  const grid = makeGrid(GRID_SIZE, GRID_SIZE, null);

  // Tokenize tags, maintaining a stack of {inherited fill, non-rendered?}
  // frames for container elements. Rects inside non-rendered subtrees
  // (<defs>, <clipPath>, <mask>, <pattern>, <symbol>, ...) define resources,
  // not painted geometry — they must not paint cells, and their coordinates
  // (which may legitimately sit off-lattice) must not be validated.
  type Frame = { fill: string | null | undefined; hidden: boolean };
  const stack: Frame[] = [{ fill: undefined, hidden: false }];
  const NON_RENDERED = new Set([
    "defs",
    "clippath",
    "mask",
    "pattern",
    "symbol",
    "marker",
    "metadata",
    "title",
    "desc",
  ]);
  const tagRe = /<(\/?)([A-Za-z_][-\w:]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let rectCount = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src)) !== null) {
    const [, closing, name, body, selfClosing] = m;
    const lower = name.toLowerCase();
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = parseAttrs(body);
    const parent = stack[stack.length - 1];
    const inherited = parent.fill;
    const fill = resolveFill(attrs, classFills, inherited);
    const hidden = parent.hidden || NON_RENDERED.has(lower);

    if (lower === "rect" && !hidden) {
      rectCount++;
      if (fill !== null) {
        // undefined (nothing declared anywhere) -> SVG default fill: black.
        const colour = fill === undefined ? "#000000" : fill;
        const x = toCell(numAttr(attrs, "x", 0) - minX, scaleX, "rect x");
        const y = toCell(numAttr(attrs, "y", 0) - minY, scaleY, "rect y");
        const w = toCell(numAttr(attrs, "width"), scaleX, "rect width");
        const h = toCell(numAttr(attrs, "height"), scaleY, "rect height");
        if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > GRID_SIZE || y + h > GRID_SIZE) {
          throw new GridValidationError(
            `rect ${x},${y} ${w}x${h} falls outside the ${GRID_SIZE}x${GRID_SIZE} lattice`,
          );
        }
        for (let cy = y; cy < y + h; cy++) {
          for (let cx = x; cx < x + w; cx++) {
            grid.cells[cy][cx] = colour;
          }
        }
      }
    }
    if (!selfClosing) {
      // Any non-self-closed element (including <rect>) nests until its close tag.
      stack.push({ fill, hidden });
    }
  }

  if (rectCount === 0) throw new GridValidationError("svg contains no <rect> elements");

  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      if (grid.cells[y][x] === null) {
        throw new GridValidationError(
          `grid not fully painted: cell ${x},${y} has no colour (missing background rect?)`,
        );
      }
    }
  }
  const out = recomputePalette(grid);
  if (out.palette.length < 2 || out.palette.length > 20) {
    throw new GridValidationError(
      `implausible palette size ${out.palette.length} (expected 2..20)`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Browser rasterise path
// ---------------------------------------------------------------------------

function browserCanvasAvailable(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof Image !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function"
  );
}

async function svgToGridViaCanvas(svg: string): Promise<Grid> {
  const SCALE = 8;
  const size = GRID_SIZE * SCALE;

  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  let imageData: { data: Uint8ClampedArray };
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new GridValidationError("svg failed to load as an image"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new GridValidationError("could not acquire a 2d canvas context");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    imageData = ctx.getImageData(0, 0, size, size);
  } finally {
    URL.revokeObjectURL(url);
  }

  const data = imageData.data;
  const px = (x: number, y: number): [number, number, number, number] => {
    const i = (y * size + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };

  const grid = makeGrid(GRID_SIZE, GRID_SIZE, null);
  for (let cy = 0; cy < GRID_SIZE; cy++) {
    for (let cx = 0; cx < GRID_SIZE; cx++) {
      const x0 = cx * SCALE;
      const y0 = cy * SCALE;
      // Corners (inset 1px) + centre: every sample must be identical & opaque,
      // otherwise the cell is half-toned and the rasterise path is not trusted.
      const samples: [number, number][] = [
        [x0 + 1, y0 + 1],
        [x0 + SCALE - 2, y0 + 1],
        [x0 + 1, y0 + SCALE - 2],
        [x0 + SCALE - 2, y0 + SCALE - 2],
        [x0 + (SCALE >> 1), y0 + (SCALE >> 1)],
      ];
      const first = px(...samples[0]);
      if (first[3] !== 255) {
        throw new GridValidationError(`cell ${cx},${cy} is not opaque after rasterise`);
      }
      for (const [sx, sy] of samples) {
        const p = px(sx, sy);
        if (p[0] !== first[0] || p[1] !== first[1] || p[2] !== first[2] || p[3] !== first[3]) {
          throw new GridValidationError(`half-tone cell at ${cx},${cy}`);
        }
      }
      grid.cells[cy][cx] = rgbToHex(first[0], first[1], first[2]);
    }
  }
  const out = recomputePalette(grid);
  if (out.palette.length < 2 || out.palette.length > 20) {
    throw new GridValidationError(`implausible palette size ${out.palette.length}`);
  }
  return out;
}

/**
 * Async SVG -> Grid. In the browser: rasterise into a 24x24 lattice with
 * smoothing disabled and validate every cell is a solid colour. On any
 * validation failure — or when no DOM is available (node) — fall back to the
 * pure `svgToGridFromRects` parser. Throws GridValidationError when both
 * paths fail.
 */
export async function svgToGrid(svg: string): Promise<Grid> {
  if (browserCanvasAvailable()) {
    try {
      return await svgToGridViaCanvas(svg);
    } catch {
      // fall through to the rect parser
    }
  }
  try {
    return svgToGridFromRects(svg);
  } catch (e) {
    if (e instanceof GridValidationError) throw e;
    throw new GridValidationError(`svg could not be parsed: ${String(e)}`);
  }
}
