"use client";

/**
 * StickerPanel — the Head Sticker tool rail.
 *
 * Controls are named for what they do to the picture: Outline, Tilt,
 * Background, Shadow, Size in frame, Nudge. The panel owns a live sticker
 * preview canvas: low-res while any control (or the crop box) is being
 * dragged, full-res ~80ms after release. Heavy recomposition is memoised by
 * its actual inputs — unrelated state (circle mask, export size, success
 * labels) never re-rasterises the sticker.
 *
 * Selection is owned by the parent (seeded once per piece from
 * detectHeadSeed); this panel only consumes and forwards changes. It also
 * renders a small crop stage of the source grid with the CropBox overlay so
 * the crop is adjustable right next to its consequences.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CellRect, Grid } from "@/lib/grid";
import { rasterise } from "@/lib/grid";
import {
  composeStickerCanvas,
  exportSticker,
  type StickerOpts,
} from "@/lib/exporter/sticker";
import CropBox from "@/components/CropBox";
import CellSlider from "@/components/ui/CellSlider";
import MicroLabel from "@/components/ui/MicroLabel";
import Pill from "@/components/ui/Pill";

export type StickerPanelProps = {
  grid: Grid;
  pieceId: number | null;
  selection: CellRect;
  onSelectionChange: (r: CellRect) => void;
};

type BgMode = "tint" | "piece-bg" | "solid";
type ExportSize = 400 | 1000 | 2000;

const LOW_RES_PX = 240;
const DEBOUNCE_MS = 80;

/** Track an element's content width (0 until measured; SSR-safe). */
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function Swatch({
  colour,
  selected,
  onSelect,
  label,
}: {
  colour: string;
  selected: boolean;
  onSelect: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      onClick={onSelect}
      className="u-focus-square relative flex min-h-[44px] min-w-[44px] items-center justify-center"
    >
      {/* the swatch is a literal pixel: square, no radius */}
      <span
        aria-hidden="true"
        className="block h-4 w-4"
        style={{
          background: colour,
          boxShadow: selected
            ? "0 0 0 2px var(--paper), 0 0 0 4px var(--accent)"
            : "0 0 0 1px var(--line)",
        }}
      />
    </button>
  );
}

export default function StickerPanel({
  grid,
  pieceId,
  selection,
  onSelectionChange,
}: StickerPanelProps) {
  // ---- controls state (defaults per spec) --------------------------------
  const [outlineWidth, setOutlineWidth] = useState<0 | 1 | 2 | 3>(1);
  const [outlineColour, setOutlineColour] = useState("#ffffff");
  const [twoTone, setTwoTone] = useState(false);
  const [tilt, setTilt] = useState(-22);
  const [bgMode, setBgMode] = useState<BgMode>("tint");
  const [solidColour, setSolidColour] = useState<string | null>(null);
  const [shadowOn, setShadowOn] = useState(true);
  const [shadowStrength, setShadowStrength] = useState(35); // percent
  const [sizeInFrame, setSizeInFrame] = useState(78); // percent
  const [nudgeX, setNudgeX] = useState(0);
  const [nudgeY, setNudgeY] = useState(0);
  const [circleMask, setCircleMask] = useState(false);
  const [exportSize, setExportSize] = useState<ExportSize>(1000);

  // export feedback
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    },
    [],
  );

  // ---- drag detection: low-res preview while any pointer is down --------
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) return;
    const up = () => setDragging(false);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragging]);

  // ---- measurements ------------------------------------------------------
  const [stageWrapRef, stageWidth] = useElementWidth<HTMLDivElement>();
  const [previewWrapRef, previewWidth] = useElementWidth<HTMLDivElement>();
  // Lazy init, SSR-guarded; dpr only ever feeds effect-driven canvas sizing,
  // so a server/client difference cannot cause a markup mismatch.
  const [dpr] = useState(() =>
    typeof window === "undefined" ? 1 : Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
  );

  const cellPx = stageWidth > 0 ? Math.floor(stageWidth / grid.w) : 0;
  const fullPreviewPx =
    previewWidth > 0 ? Math.max(320, Math.min(960, Math.round(previewWidth * dpr))) : 480;
  const previewPx = dragging ? LOW_RES_PX : fullPreviewPx;

  // ---- crop stage: source grid + CropBox overlay ------------------------
  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = stageCanvasRef.current;
    if (!cv || cellPx <= 0) return;
    const dev = Math.max(1, Math.round(cellPx * dpr));
    cv.width = grid.w * dev;
    cv.height = grid.h * dev;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    // canvas just resized — context reset — smoothing off again
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cv.width, cv.height);
    rasterise(grid, dev, ctx);
  }, [grid, cellPx, dpr]);

  // ---- sticker options --------------------------------------------------
  // exportSize is deliberately NOT part of this memo: it only matters at
  // export time, so flipping the size picker never re-rasterises anything.
  const visualOpts: StickerOpts = useMemo(
    () => ({
      outlineWidth,
      outlineColour,
      twoTone,
      rotationDeg: tilt,
      background:
        bgMode === "solid"
          ? { mode: "solid" as const, colour: solidColour ?? "#ffffff" }
          : { mode: bgMode },
      shadow: { on: shadowOn, opacity: shadowStrength / 100 },
      scale: sizeInFrame / 100,
      nudgeX,
      nudgeY,
      size: 1000,
    }),
    [
      outlineWidth,
      outlineColour,
      twoTone,
      tilt,
      bgMode,
      solidColour,
      shadowOn,
      shadowStrength,
      sizeInFrame,
      nudgeX,
      nudgeY,
    ],
  );

  // ---- debounced heavy compose ------------------------------------------
  const composedRef = useRef<HTMLCanvasElement | null>(null);
  const [composedTick, setComposedTick] = useState(0);
  const [composeError, setComposeError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        composedRef.current = composeStickerCanvas(grid, selection, visualOpts, previewPx);
        setComposeError(null);
      } catch (err) {
        composedRef.current = null;
        setComposeError(err instanceof Error ? err.message : String(err));
      }
      setComposedTick((n) => n + 1);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [grid, selection, visualOpts, previewPx]);

  // ---- cheap redraw of the composed canvas (mask toggle costs nothing) ---
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = previewCanvasRef.current;
    if (!cv) return;
    const src = composedRef.current;
    const px = src?.width ?? previewPx;
    cv.width = px;
    cv.height = px;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    // resize reset the context — smoothing off before any draw
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, px, px);
    if (!src) return;
    ctx.save();
    if (circleMask) {
      ctx.beginPath();
      ctx.arc(px / 2, px / 2, px / 2, 0, Math.PI * 2);
      ctx.clip();
    }
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  }, [composedTick, circleMask, previewPx]);

  // ---- export ------------------------------------------------------------
  const filename =
    pieceId !== null ? `unipeg-${pieceId}-sticker.png` : "unipeg-sticker.png";

  const flash = useCallback((set: (v: string | null) => void, label: string) => {
    set(label);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => {
      setSavedLabel(null);
      setCopyLabel(null);
    }, 2000);
  }, []);

  const handleDownload = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await exportSticker(grid, selection, { ...visualOpts, size: exportSize });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      const kb = (blob.size / 1024).toFixed(1);
      flash(setSavedLabel, `SAVED ${exportSize}×${exportSize} · ${kb}KB`);
    } catch {
      flash(setSavedLabel, "EXPORT FAILED");
    } finally {
      setBusy(false);
    }
  }, [busy, grid, selection, visualOpts, filename, exportSize, flash]);

  const handleCopy = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        throw new Error("clipboard unavailable");
      }
      const blob = await exportSticker(grid, selection, { ...visualOpts, size: exportSize });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flash(setCopyLabel, "COPIED PNG");
    } catch {
      flash(setCopyLabel, "COPY FAILED");
    } finally {
      setBusy(false);
    }
  }, [busy, grid, selection, visualOpts, exportSize, flash]);

  // outline colour options: white first, then the piece's own palette
  const outlineColours = useMemo(() => {
    const seen = new Set<string>(["#ffffff"]);
    const out = ["#ffffff"];
    for (const c of grid.palette) {
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
    return out.slice(0, 8);
  }, [grid.palette]);

  const solidColours = useMemo(() => grid.palette.slice(0, 8), [grid.palette]);

  return (
    <div
      className="flex w-full flex-col gap-4"
      onPointerDownCapture={() => setDragging(true)}
    >
      {/* ---- crop stage ---------------------------------------------- */}
      <section aria-label="Crop">
        <div className="mb-2 flex items-baseline justify-between">
          <MicroLabel tone="mute">CROP</MicroLabel>
          <span className="font-mono text-[12px] text-mute">
            {selection.w}×{selection.h} @ {selection.x},{selection.y}
          </span>
        </div>
        <div ref={stageWrapRef} className="w-full">
          {cellPx > 0 && (
            <div
              className="relative bg-card"
              style={{ width: grid.w * cellPx, height: grid.h * cellPx }}
            >
              <canvas
                ref={stageCanvasRef}
                aria-label="Source piece with crop selection"
                className="block"
                style={{
                  width: grid.w * cellPx,
                  height: grid.h * cellPx,
                  imageRendering: "pixelated",
                }}
              />
              <CropBox
                rect={selection}
                onChange={onSelectionChange}
                cellPx={cellPx}
                gridW={grid.w}
                gridH={grid.h}
                minSize={3}
              />
            </div>
          )}
        </div>
      </section>

      {/* ---- live preview --------------------------------------------- */}
      <section aria-label="Sticker preview">
        <div className="mb-2 flex items-center justify-between gap-2">
          <MicroLabel tone="mute">STICKER PREVIEW</MicroLabel>
          <Pill
            variant={circleMask ? "active" : "card"}
            aria-pressed={circleMask}
            onClick={() => setCircleMask((v) => !v)}
          >
            X CROP {circleMask ? "ON" : "OFF"}
          </Pill>
        </div>
        <div ref={previewWrapRef} className="w-full bg-card p-2" style={{ borderRadius: 12 }}>
          {composeError !== null ? (
            <p className="border-2 border-ink p-3 font-mono text-[12px] text-ink">
              {composeError}
            </p>
          ) : (
            <canvas
              ref={previewCanvasRef}
              aria-label="Live sticker preview"
              className="block h-auto w-full"
              style={{ imageRendering: "pixelated" }}
            />
          )}
        </div>
      </section>

      {/* ---- Outline --------------------------------------------------- */}
      <section aria-label="Outline" className="flex flex-col gap-2">
        <CellSlider
          label="Outline"
          value={outlineWidth}
          min={0}
          max={3}
          step={1}
          onChange={(v) => setOutlineWidth(Math.round(v) as 0 | 1 | 2 | 3)}
          format={(v) => `${v} ${v === 1 ? "CELL" : "CELLS"}`}
        />
        <div className="flex flex-wrap items-center gap-0">
          {outlineColours.map((c) => (
            <Swatch
              key={c}
              colour={c}
              selected={outlineColour === c}
              onSelect={() => setOutlineColour(c)}
              label={`Outline colour ${c}`}
            />
          ))}
          <Pill
            variant={twoTone ? "active" : "card"}
            aria-pressed={twoTone}
            onClick={() => setTwoTone((v) => !v)}
            className="ml-2"
          >
            TWO-TONE {twoTone ? "ON" : "OFF"}
          </Pill>
        </div>
      </section>

      {/* ---- Tilt ------------------------------------------------------ */}
      <section aria-label="Tilt">
        <CellSlider
          label="Tilt"
          value={tilt}
          min={-45}
          max={45}
          step={5}
          detents={[0, -22]}
          onChange={setTilt}
          format={(v) => `TILT ${v} DEG`}
        />
      </section>

      {/* ---- Background ------------------------------------------------ */}
      <section aria-label="Background" className="flex flex-col gap-2">
        <span className="text-[13px] font-semibold text-ink">Background</span>
        <div className="flex flex-wrap items-center gap-2">
          <Pill
            variant={bgMode === "tint" ? "active" : "card"}
            aria-pressed={bgMode === "tint"}
            onClick={() => setBgMode("tint")}
          >
            AUTO TINT
          </Pill>
          <Pill
            variant={bgMode === "piece-bg" ? "active" : "card"}
            aria-pressed={bgMode === "piece-bg"}
            onClick={() => setBgMode("piece-bg")}
          >
            PIECE BG
          </Pill>
        </div>
        <div className="flex flex-wrap items-center gap-0">
          {solidColours.map((c) => (
            <Swatch
              key={c}
              colour={c}
              selected={bgMode === "solid" && solidColour === c}
              onSelect={() => {
                setBgMode("solid");
                setSolidColour(c);
              }}
              label={`Solid background ${c}`}
            />
          ))}
        </div>
      </section>

      {/* ---- Shadow ---------------------------------------------------- */}
      <section aria-label="Shadow" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold text-ink">Shadow</span>
          <Pill
            variant={shadowOn ? "active" : "card"}
            aria-pressed={shadowOn}
            onClick={() => setShadowOn((v) => !v)}
          >
            SHADOW {shadowOn ? "ON" : "OFF"}
          </Pill>
        </div>
        {shadowOn && (
          <CellSlider
            label="Strength"
            value={shadowStrength}
            min={0}
            max={100}
            step={5}
            onChange={setShadowStrength}
            format={(v) => `${v}%`}
          />
        )}
      </section>

      {/* ---- Size + nudge ---------------------------------------------- */}
      <section aria-label="Placement" className="flex flex-col gap-2">
        <CellSlider
          label="Size in frame"
          value={sizeInFrame}
          min={50}
          max={100}
          step={1}
          detents={[78]}
          onChange={setSizeInFrame}
          format={(v) => `${v}%`}
        />
        <CellSlider
          label="Nudge X"
          value={nudgeX}
          min={-25}
          max={25}
          step={1}
          detents={[0]}
          onChange={setNudgeX}
          format={(v) => `${v > 0 ? "+" : ""}${v}%`}
        />
        <CellSlider
          label="Nudge Y"
          value={nudgeY}
          min={-25}
          max={25}
          step={1}
          detents={[0]}
          onChange={setNudgeY}
          format={(v) => `${v > 0 ? "+" : ""}${v}%`}
        />
      </section>

      {/* ---- Export ---------------------------------------------------- */}
      <section aria-label="Export" className="flex flex-col gap-2">
        <MicroLabel tone="pink">EXPORT</MicroLabel>
        <div className="flex flex-wrap items-center gap-2">
          {([400, 1000, 2000] as const).map((s) => (
            <Pill
              key={s}
              variant={exportSize === s ? "active" : "card"}
              aria-pressed={exportSize === s}
              onClick={() => setExportSize(s)}
            >
              <span className="font-mono">{s}</span>
            </Pill>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill variant="ink" onClick={handleDownload} disabled={busy}>
            <span className="font-mono">
              {savedLabel ?? `DOWNLOAD ${exportSize}×${exportSize} PNG`}
            </span>
          </Pill>
          <Pill variant="card" onClick={handleCopy} disabled={busy}>
            <span className="font-mono">{copyLabel ?? "COPY PNG"}</span>
          </Pill>
        </div>
        <span className="font-mono text-[12px] text-mute">{filename}</span>
      </section>
    </div>
  );
}
