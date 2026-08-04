"use client";

/**
 * The stage — a perfect grid-of-cells square sharing the art's literal
 * coordinate system (24×24 for source pieces). Mono ruler numerals along the
 * top edge, a museum scale bar beneath, ghost gridlines on --wash (--card
 * while empty).
 *
 * States:
 *  - idle: blank ghost grid on --card, dashed X-crop circle in place,
 *    PICK YOUR PEG in --mute, one lone --pink pixel at cell (12,4).
 *  - loading: no spinner — cells fill in scan order with --line at 40% while
 *    a mono counter reads `READING CHAIN — ROW 07/24`. Reduced motion:
 *    static 40% checker + counter.
 *  - loaded: the grid rasterised crisp (devicePixelRatio-aware, smoothing
 *    off), a 24-step column wipe on entry (.u-wipe-overlay), dashed X-crop
 *    circle in fullbody mode, CropBox overlay in sticker mode.
 *
 * Static chrome (ghost grid, empty state, circle, counter) is positioned in
 * percentages of the plate so it renders server-side; only the canvas and
 * the CropBox need the measured integer cellPx. All geometry stays in whole
 * cells — cellPx is the one device-space conversion.
 */

import { useEffect, useRef, useState } from "react";
import type { CellRect, Grid } from "@/lib/grid";
import { rasterise } from "@/lib/grid";
import CropBox from "@/components/CropBox";
import MicroLabel from "@/components/ui/MicroLabel";

export type StagePhase = "idle" | "loading" | "loaded" | "error";

export type StageProps = {
  grid: Grid | null;
  phase: StagePhase;
  /** fake-progress row counter, 0..24, driven by the page while loading */
  loadingRow: number;
  mode: "fullbody" | "sticker";
  selection: CellRect | null;
  onSelectionChange: (r: CellRect) => void;
  /** bump to replay the column-wipe theatre (one per successful load) */
  wipeKey: number;
};

const RULER = [0, 6, 12, 18, 23];

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return reduced;
}

export default function Stage({
  grid,
  phase,
  loadingRow,
  mode,
  selection,
  onSelectionChange,
  wipeKey,
}: StageProps) {
  const cols = grid?.w ?? 24;
  const rows = grid?.h ?? 24;

  // Measure the wrapper; once measured the plate snaps to cellPx * cols so
  // cells are exact device-independent pixels (canvas + CropBox alignment).
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // dpr only feeds effect-driven canvas sizing — lazy init is SSR-safe.
  const [dpr] = useState(() =>
    typeof window === "undefined"
      ? 1
      : Math.max(1, Math.min(3, window.devicePixelRatio || 1)),
  );

  const reduced = useReducedMotion();

  const cellPx = width > 0 ? Math.max(1, Math.floor(width / cols)) : 0;
  const measured = cellPx > 0;

  const loaded = phase === "loaded" && grid !== null;

  // Rasterise the loaded grid, devicePixelRatio-aware, smoothing off after
  // every resize (resizing resets context state).
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!loaded || grid === null || cellPx <= 0) return;
    const cv = canvasRef.current;
    if (!cv) return;
    const dev = Math.max(1, Math.round(cellPx * dpr));
    cv.width = grid.w * dev;
    cv.height = grid.h * dev;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false; // after EVERY resize
    ctx.clearRect(0, 0, cv.width, cv.height);
    rasterise(grid, dev, ctx);
  }, [loaded, grid, cellPx, dpr]);

  const counterRow = Math.max(0, Math.min(24, loadingRow));
  const counterText = `READING CHAIN — ROW ${String(counterRow).padStart(2, "0")}/24`;

  const showCircle = phase === "idle" || (loaded && mode === "fullbody");
  // Inscribed circle as percentages — equal device size on both axes.
  const circleW = (Math.min(cols, rows) / cols) * 100;
  const circleH = (Math.min(cols, rows) / rows) * 100;

  const pct = (n: number, total: number) => `${(n / total) * 100}%`;

  return (
    <div ref={wrapRef} className="w-full">
      <div
        className="flex flex-col"
        style={measured ? { width: cellPx * cols } : { width: "100%" }}
      >
        {/* ruler numerals along the top edge */}
        <div className="relative h-[16px]" aria-hidden="true">
          {RULER.filter((n) => n < cols).map((n) => (
            <span
              key={n}
              className="absolute bottom-[2px] font-mono text-[10px] leading-none text-mute"
              style={{ left: `calc(${pct(n, cols)} + 1px)` }}
            >
              {n}
            </span>
          ))}
        </div>

        {/* the plate */}
        <div
          className="relative"
          style={{
            width: "100%",
            aspectRatio: `${cols} / ${rows}`,
            background: loaded ? "var(--wash)" : "var(--card)",
          }}
        >
          {/* ghost gridlines */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "linear-gradient(to right, var(--line) 1px, transparent 1px)," +
                "linear-gradient(to bottom, var(--line) 1px, transparent 1px)",
              backgroundSize: `${100 / cols}% ${100 / rows}%`,
            }}
          />

          {/* the art, crisp */}
          {loaded && measured && (
            <canvas
              ref={canvasRef}
              aria-label={`Loaded piece, ${cols} by ${rows} cells`}
              className="absolute inset-0 h-full w-full [image-rendering:pixelated]"
            />
          )}

          {/* the theatre: column wipe, keyed to replay per load */}
          {loaded && !reduced && (
            <div key={wipeKey} className="u-wipe-overlay" aria-hidden="true" />
          )}

          {/* loading: scan-order fill + mono counter (no spinner) */}
          {phase === "loading" && (
            <>
              {reduced ? (
                <div
                  aria-hidden="true"
                  className="absolute inset-0"
                  style={{
                    backgroundImage:
                      "repeating-conic-gradient(var(--line) 0% 25%, transparent 0% 50%)",
                    backgroundSize: `${200 / cols}% ${200 / rows}%`,
                    opacity: 0.4,
                  }}
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="absolute left-0 top-0 w-full"
                  style={{
                    height: pct(Math.min(rows, counterRow), rows),
                    background: "var(--line)",
                    opacity: 0.4,
                  }}
                />
              )}
              <div
                className="absolute inset-0 flex items-center justify-center"
                role="status"
              >
                <span className="bg-card px-2 py-1 font-mono text-[12px] font-bold leading-none text-ink">
                  {counterText}
                </span>
              </div>
            </>
          )}

          {/* empty state: lone pink pixel where a horn would be */}
          {phase === "idle" && cols === 24 && rows === 24 && (
            <span
              aria-hidden="true"
              className="absolute bg-pink"
              style={{
                left: pct(12, cols),
                top: pct(4, rows),
                width: pct(1, cols),
                height: pct(1, rows),
              }}
            />
          )}
          {phase === "idle" && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="font-display text-[clamp(18px,4vw,28px)] font-bold uppercase tracking-wide text-mute">
                Pick your peg
              </p>
            </div>
          )}

          {/* dashed X-crop circle: what X actually keeps */}
          {showCircle && (
            <>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-mute"
                style={{ width: `${circleW}%`, height: `${circleH}%` }}
              />
              <span
                className="pointer-events-none absolute left-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-1"
                style={{ top: `${(100 - circleH) / 2}%` }}
              >
                <MicroLabel tone="mute">X crop</MicroLabel>
              </span>
            </>
          )}

          {/* sticker mode: the crop selection, snapped to whole cells */}
          {loaded && measured && mode === "sticker" && selection !== null && (
            <CropBox
              rect={selection}
              onChange={onSelectionChange}
              cellPx={cellPx}
              gridW={cols}
              gridH={rows}
              minSize={3}
            />
          )}
        </div>

        {/* museum scale bar */}
        <div
          aria-hidden="true"
          className="mt-2 flex items-center gap-2 font-mono text-[10px] leading-none text-mute"
        >
          <span>|</span>
          <span className="h-px w-8 bg-mute" />
          <span>{cols} px</span>
          <span className="h-px w-8 bg-mute" />
          <span>|</span>
        </div>
      </div>
    </div>
  );
}
