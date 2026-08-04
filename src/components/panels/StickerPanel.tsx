"use client";

/**
 * Head Sticker tool, split into placeable parts (owner's layout):
 *
 *   <StickerProvider>       — owns ALL tool state + the compose pipeline
 *     <StickerPreview />        — live preview canvas + its X CROP toggle
 *     <StickerControls />       — compact multi-column control rows + export
 *     <StickerStageDragLayer>   — wraps the page's Stage so dragging the
 *                                 cell-snapped CropBox there gets the same
 *                                 low-res-while-dragging treatment the old
 *                                 in-panel crop stage had
 *
 * Behaviour is unchanged: low-res preview while any pointer drags, full-res
 * ~80ms after release/last change; heavy recomposition memoised by its
 * actual inputs (circle mask, export size and success labels never
 * re-rasterise); exports/copy identical. Selection is owned by the page and
 * edited on the main Stage's CropBox; this panel only consumes it.
 *
 * Outline colour is the owner's two-chip rule: WHITE (default) / BLACK.
 * TWO-TONE's band is automatically the opposite colour — no colour choice.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CellRect, Grid } from "@/lib/grid";
import {
  composeStickerCanvas,
  exportSticker,
  type StickerOpts,
} from "@/lib/exporter/sticker";
import CellSlider from "@/components/ui/CellSlider";
import MicroLabel from "@/components/ui/MicroLabel";
import Pill from "@/components/ui/Pill";

export type StickerProviderProps = {
  grid: Grid;
  pieceId: number | null;
  selection: CellRect;
  children: ReactNode;
};

/** Owner amendment: exactly three background options. */
type BgMode = "black" | "white" | "piece-bg";
/** Owner rule: outlines are white or black, nothing else. */
type OutlineColour = "#ffffff" | "#000000";
type ExportSize = 400 | 1000 | 2000;

const LOW_RES_PX = 240;
const DEBOUNCE_MS = 80;

const OUTLINE_PILLS: { colour: OutlineColour; label: string }[] = [
  { colour: "#ffffff", label: "WHITE" },
  { colour: "#000000", label: "BLACK" },
];

/**
 * Format the outline width (fractional cells, quarter-cell steps) in the
 * art's units: 0 -> NONE, 0.5 -> 1/2 CELL, 1 -> 1 CELL, 1.25 -> 1 1/4 CELL.
 */
function formatOutlineCells(v: number): string {
  if (v <= 0) return "NONE";
  const whole = Math.floor(v);
  const quarters = Math.round((v - whole) * 4);
  const frac = ["", "1/4", "1/2", "3/4"][quarters];
  const num = [whole > 0 ? String(whole) : null, frac || null]
    .filter(Boolean)
    .join(" ");
  return `${num} CELL`;
}

/** Cheap redraw of the composed sticker onto the visible preview canvas,
 *  optionally clipped to X's circle. Resizing resets context state, so
 *  smoothing is re-disabled after every resize. */
function redrawPreview(
  cv: HTMLCanvasElement,
  src: HTMLCanvasElement | null,
  fallbackPx: number,
  circleMask: boolean,
): void {
  const px = src?.width ?? fallbackPx;
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
}

/** Track an element's content width (0 until attached; SSR-safe). The
 *  element arrives via state (callback ref in the consumer), so the observer
 *  re-binds whenever it attaches or swaps. */
function useElementWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return width;
}

/** All tool state + compose pipeline, shared by Preview and Controls. */
function useStickerEngine({
  grid,
  pieceId,
  selection,
}: Omit<StickerProviderProps, "children">) {
  // ---- controls state (defaults per spec) --------------------------------
  // Outline is fractional cells (0..1.5 in 1/4-cell steps); owner default 1/2.
  const [outlineWidth, setOutlineWidth] = useState(0.5);
  const [outlineColour, setOutlineColour] = useState<OutlineColour>("#ffffff");
  const [twoTone, setTwoTone] = useState(false);
  const [tilt, setTilt] = useState(-22);
  const [bgMode, setBgMode] = useState<BgMode>("black");
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
  const beginDrag = useCallback(() => setDragging(true), []);
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
  // Preview elements live in <StickerPreview/>; they register here via
  // callback refs into STATE, so effects re-run on attach and nothing
  // ref-shaped crosses the context boundary.
  const [previewWrapEl, setPreviewWrapEl] = useState<HTMLDivElement | null>(
    null,
  );
  const [previewCanvasEl, setPreviewCanvasEl] =
    useState<HTMLCanvasElement | null>(null);
  const previewWidth = useElementWidth(previewWrapEl);
  // Lazy init, SSR-guarded; dpr only ever feeds effect-driven canvas sizing,
  // so a server/client difference cannot cause a markup mismatch.
  const [dpr] = useState(() =>
    typeof window === "undefined"
      ? 1
      : Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
  );

  const fullPreviewPx =
    previewWidth > 0
      ? Math.max(320, Math.min(960, Math.round(previewWidth * dpr)))
      : 480;
  const previewPx = dragging ? LOW_RES_PX : fullPreviewPx;

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
        bgMode === "piece-bg"
          ? { mode: "piece-bg" as const }
          : {
              mode: "solid" as const,
              colour: bgMode === "black" ? "#000000" : "#ffffff",
            },
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
        composedRef.current = composeStickerCanvas(
          grid,
          selection,
          visualOpts,
          previewPx,
        );
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
  useEffect(() => {
    if (!previewCanvasEl) return;
    redrawPreview(previewCanvasEl, composedRef.current, previewPx, circleMask);
  }, [composedTick, circleMask, previewPx, previewCanvasEl]);

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
      const blob = await exportSticker(grid, selection, {
        ...visualOpts,
        size: exportSize,
      });
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
      // Pass the promise straight in — awaiting the export first would let
      // Safari's user-gesture window expire before clipboard.write runs.
      const item = new ClipboardItem({
        "image/png": exportSticker(grid, selection, {
          ...visualOpts,
          size: exportSize,
        }),
      });
      await navigator.clipboard.write([item]);
      flash(setCopyLabel, "COPIED PNG");
    } catch {
      flash(setCopyLabel, "COPY FAILED");
    } finally {
      setBusy(false);
    }
  }, [busy, grid, selection, visualOpts, exportSize, flash]);

  return {
    selection,
    outlineWidth,
    setOutlineWidth,
    outlineColour,
    setOutlineColour,
    twoTone,
    setTwoTone,
    tilt,
    setTilt,
    bgMode,
    setBgMode,
    shadowOn,
    setShadowOn,
    shadowStrength,
    setShadowStrength,
    sizeInFrame,
    setSizeInFrame,
    nudgeX,
    setNudgeX,
    nudgeY,
    setNudgeY,
    circleMask,
    setCircleMask,
    exportSize,
    setExportSize,
    savedLabel,
    copyLabel,
    busy,
    beginDrag,
    setPreviewWrapEl,
    setPreviewCanvasEl,
    composeError,
    filename,
    handleDownload,
    handleCopy,
  };
}

type StickerEngine = ReturnType<typeof useStickerEngine>;

const Ctx = createContext<StickerEngine | null>(null);

function useSticker(): StickerEngine {
  const ctx = useContext(Ctx);
  if (ctx === null) {
    throw new Error("Sticker parts must render inside <StickerProvider>");
  }
  return ctx;
}

export function StickerProvider({ children, ...props }: StickerProviderProps) {
  const engine = useStickerEngine(props);
  return <Ctx.Provider value={engine}>{children}</Ctx.Provider>;
}

/** Wrap the page's Stage with this so dragging its CropBox switches the
 *  sticker preview to the low-res pass (same as any in-panel drag). */
export function StickerStageDragLayer({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const s = useSticker();
  return (
    <div onPointerDownCapture={active ? s.beginDrag : undefined}>{children}</div>
  );
}

/** Live sticker preview with its X CROP toggle and the crop readout. */
export function StickerPreview() {
  const s = useSticker();
  // Local refs registered into engine STATE in an effect — the engine's
  // measure/draw effects re-run on attach, and no ref crosses a render
  // boundary.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { setPreviewWrapEl, setPreviewCanvasEl, composeError } = s;
  useEffect(() => {
    setPreviewWrapEl(wrapRef.current);
    setPreviewCanvasEl(canvasRef.current);
    return () => {
      setPreviewWrapEl(null);
      setPreviewCanvasEl(null);
    };
  }, [setPreviewWrapEl, setPreviewCanvasEl, composeError]);
  return (
    <section
      aria-label="Sticker preview"
      className="flex w-full flex-col gap-[6px]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <MicroLabel tone="mute">Sticker preview</MicroLabel>
          <span className="font-mono text-[11px] leading-none text-mute">
            CROP {s.selection.w}×{s.selection.h} @ {s.selection.x},
            {s.selection.y}
          </span>
        </div>
        <Pill
          variant={s.circleMask ? "active" : "card"}
          aria-pressed={s.circleMask}
          onClick={() => s.setCircleMask(!s.circleMask)}
        >
          X CROP {s.circleMask ? "ON" : "OFF"}
        </Pill>
      </div>
      <div
        ref={wrapRef}
        className="u-sticker-preview w-full bg-card p-[8px]"
        style={{ borderRadius: 12 }}
      >
        {s.composeError !== null ? (
          <p className="border-2 border-ink p-3 font-mono text-[12px] text-ink">
            {s.composeError}
          </p>
        ) : (
          <canvas
            ref={canvasRef}
            aria-label="Live sticker preview"
            className="block h-auto w-full"
            style={{ imageRendering: "pixelated" }}
          />
        )}
      </div>
    </section>
  );
}

/** Compact multi-column controls + condensed export row. */
export function StickerControls() {
  const s = useSticker();
  return (
    <section
      aria-label="Head Sticker controls"
      className="flex w-full flex-col gap-[8px]"
      onPointerDownCapture={s.beginDrag}
    >
      <div className="grid grid-cols-1 items-center gap-x-[24px] gap-y-[6px] lg:grid-cols-2">
        {/* outline thickness: 0..1.5 cells in 1/4 steps, default 1/2 */}
        <div className="u-cslider-row">
          <CellSlider
            label="Outline"
            value={s.outlineWidth}
            min={0}
            max={1.5}
            step={0.25}
            onChange={(v) => s.setOutlineWidth(Math.round(v * 4) / 4)}
            format={formatOutlineCells}
          />
        </div>

        {/* outline colour: exactly two chips (owner rule) + TWO-TONE, whose
            band is automatically the opposite colour */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-ink">Outline</span>
          {OUTLINE_PILLS.map(({ colour, label }) => (
            <Pill
              key={colour}
              variant={s.outlineColour === colour ? "active" : "card"}
              aria-pressed={s.outlineColour === colour}
              onClick={() => s.setOutlineColour(colour)}
            >
              {label}
            </Pill>
          ))}
          <Pill
            variant={s.twoTone ? "active" : "card"}
            aria-pressed={s.twoTone}
            onClick={() => s.setTwoTone(!s.twoTone)}
          >
            TWO-TONE {s.twoTone ? "ON" : "OFF"}
          </Pill>
        </div>

        {/* tilt — detents sit ON the 5-degree lattice (0 / -20) so no value
            is magnet-trapped; the build-spec default -22 stays reachable as
            the initial value (keyboard steps re-enter the native lattice). */}
        <div className="u-cslider-row">
          <CellSlider
            label="Tilt"
            value={s.tilt}
            min={-45}
            max={45}
            step={5}
            detents={[0, -20]}
            onChange={s.setTilt}
            format={(v) => `TILT ${v} DEG`}
          />
        </div>

        {/* background */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-ink">Background</span>
          <Pill
            variant={s.bgMode === "black" ? "active" : "card"}
            aria-pressed={s.bgMode === "black"}
            onClick={() => s.setBgMode("black")}
          >
            BLACK
          </Pill>
          <Pill
            variant={s.bgMode === "white" ? "active" : "card"}
            aria-pressed={s.bgMode === "white"}
            onClick={() => s.setBgMode("white")}
          >
            WHITE
          </Pill>
          <Pill
            variant={s.bgMode === "piece-bg" ? "active" : "card"}
            aria-pressed={s.bgMode === "piece-bg"}
            onClick={() => s.setBgMode("piece-bg")}
          >
            PIECE BG
          </Pill>
        </div>

        {/* shadow: toggle + strength on one row */}
        <div className="flex items-center gap-[8px]">
          <Pill
            variant={s.shadowOn ? "active" : "card"}
            aria-pressed={s.shadowOn}
            onClick={() => s.setShadowOn(!s.shadowOn)}
            className="shrink-0"
          >
            SHADOW {s.shadowOn ? "ON" : "OFF"}
          </Pill>
          {s.shadowOn && (
            <div className="u-cslider-row u-cslider-bare min-w-0 flex-1">
              <CellSlider
                label="Shadow strength"
                value={s.shadowStrength}
                min={0}
                max={100}
                step={5}
                onChange={s.setShadowStrength}
                format={(v) => `${v}%`}
              />
            </div>
          )}
        </div>

        {/* size in frame — tilt-invariant by the exporter's construction */}
        <div className="u-cslider-row">
          <CellSlider
            label="Size in frame"
            value={s.sizeInFrame}
            min={50}
            max={100}
            step={1}
            detents={[78]}
            onChange={s.setSizeInFrame}
            format={(v) => `${v}%`}
          />
        </div>

        {/* nudge X/Y side by side (mobile); own cells on desktop */}
        <div className="grid grid-cols-2 gap-x-[12px] lg:contents">
          <div className="u-cslider-row min-w-0">
            <CellSlider
              label="Nudge X"
              value={s.nudgeX}
              min={-25}
              max={25}
              step={1}
              detents={[0]}
              onChange={s.setNudgeX}
              format={(v) => `${v > 0 ? "+" : ""}${v}%`}
            />
          </div>
          <div className="u-cslider-row min-w-0">
            <CellSlider
              label="Nudge Y"
              value={s.nudgeY}
              min={-25}
              max={25}
              step={1}
              detents={[0]}
              onChange={s.setNudgeY}
              format={(v) => `${v > 0 ? "+" : ""}${v}%`}
            />
          </div>
        </div>
      </div>

      {/* condensed export row: size picker + download + copy + filename */}
      <div className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px]">
        <MicroLabel tone="pink">Export</MicroLabel>
        {([400, 1000, 2000] as const).map((sz) => (
          <Pill
            key={sz}
            variant={s.exportSize === sz ? "active" : "card"}
            aria-pressed={s.exportSize === sz}
            onClick={() => s.setExportSize(sz)}
          >
            <span className="font-mono">{sz}</span>
          </Pill>
        ))}
        <Pill variant="ink" onClick={s.handleDownload} disabled={s.busy}>
          <span className="font-mono">
            {s.savedLabel ?? `DOWNLOAD ${s.exportSize}×${s.exportSize} PNG`}
          </span>
        </Pill>
        <Pill variant="card" onClick={s.handleCopy} disabled={s.busy}>
          <span className="font-mono">{s.copyLabel ?? "COPY PNG"}</span>
        </Pill>
        <span className="font-mono text-[12px] text-mute">{s.filename}</span>
      </div>
    </section>
  );
}
