"use client";

/**
 * Full-Body Fit tool, split into three placeable parts so the page can put
 * them in different grid slots (owner's layout):
 *
 *   <FullBodyProvider>  — owns ALL tool state + the render pipeline
 *     <FullBodyPreview />   — 'Square export' + 'On X' cards (desktop: stacked
 *                             right of the stage; mobile: side by side, sticky)
 *     <FullBodyControls />  — compact control rows + the export row
 *
 * Behaviour is unchanged from the single-panel version: both previews blit
 * from the SAME composed canvas; a low-res pass renders immediately on any
 * input change and the full-res pass is debounced ~80ms; the dashed X-crop
 * circle on the square preview is exact by construction (fullBodyCompose
 * returns an N x N square whose inscribed circle IS the X crop) and is gated
 * by the shared cropGhost state. imageSmoothingEnabled is re-disabled after
 * every canvas resize.
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
import { contentBounds, detectBackground } from "@/lib/grid";
import type { Grid } from "@/lib/grid";
import {
  composeFullBodyPreview,
  exportFullBody,
  type FullBodySize,
} from "@/lib/exporter/fullbody";
import MicroLabel from "@/components/ui/MicroLabel";
import Pill from "@/components/ui/Pill";
import CellSlider from "@/components/ui/CellSlider";

const SIZES: FullBodySize[] = [400, 1000, 2000];

/** Owner amendment: exactly three background options, same as the sticker.
 *  AUTO = the piece's own detected background (exporter opts bg: undefined). */
type FullBodyBgMode = "auto" | "black" | "white";
const BG_PILLS: { mode: FullBodyBgMode; label: string }[] = [
  { mode: "auto", label: "AUTO" },
  { mode: "black", label: "BLACK" },
  { mode: "white", label: "WHITE" },
];
const DEFAULT_ROOM_PCT = 12;
const FULL_RES_TARGET_PX = 480;
const LOW_RES_TARGET_PX = 120;
const DEBOUNCE_MS = 80;

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

/** Blit src onto dest 1:1. Resizing resets context state, so smoothing is
 *  re-disabled after every resize. */
function blit(src: HTMLCanvasElement, dest: HTMLCanvasElement | null): void {
  if (!dest) return;
  if (dest.width !== src.width || dest.height !== src.height) {
    dest.width = src.width;
    dest.height = src.height;
  }
  const ctx = dest.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false; // after EVERY resize
  ctx.clearRect(0, 0, dest.width, dest.height);
  ctx.drawImage(src, 0, 0);
}

export type FullBodyProviderProps = {
  grid: Grid;
  pieceId: number | null;
  /** X-crop ghost visibility — one control for preview circle AND anywhere
   *  else the page chooses to reflect it. */
  cropGhost: boolean;
  onCropGhostChange: (on: boolean) => void;
  children: ReactNode;
};

/** All tool state + pipeline, lifted out of render so Preview and Controls
 *  can live in different page slots while sharing one engine. */
function useFullBodyEngine({
  grid,
  pieceId,
  cropGhost,
  onCropGhostChange,
}: Omit<FullBodyProviderProps, "children">) {
  const [roomPct, setRoomPct] = useState(DEFAULT_ROOM_PCT);
  const [bgMode, setBgMode] = useState<FullBodyBgMode>("auto");
  const [size, setSize] = useState<FullBodySize>(1000);
  const [busy, setBusy] = useState(false);
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [hexFlash, setHexFlash] = useState(false);

  // The preview canvases live in <FullBodyPreview/>; they register here via
  // callback refs into STATE (not refs), so the draw effect re-runs when
  // they attach and nothing ref-shaped ever crosses the context boundary.
  const [squareEl, setSquareEl] = useState<HTMLCanvasElement | null>(null);
  const [circleEl, setCircleEl] = useState<HTMLCanvasElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hexTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset per-piece choices when a new grid arrives — the "adjust state
  // during render" pattern, so no effect and no extra paint of stale state.
  const [prevGrid, setPrevGrid] = useState(grid);
  if (prevGrid !== grid) {
    setPrevGrid(grid);
    setBgMode("auto");
    setRoomPct(DEFAULT_ROOM_PCT);
  }

  useEffect(() => {
    return () => {
      for (const t of [debounceRef, savedTimerRef, copyTimerRef, hexTimerRef]) {
        if (t.current !== null) clearTimeout(t.current);
      }
    };
  }, []);

  const detectedBg = useMemo(() => {
    try {
      return detectBackground(grid);
    } catch {
      return null;
    }
  }, [grid]);

  // AUTO plumbs through as bg: undefined — the exporter detects for itself.
  const bgOverride =
    bgMode === "black" ? "#000000" : bgMode === "white" ? "#ffffff" : undefined;
  const effectiveBg = bgOverride ?? detectedBg;

  // Pure pre-flight validation (no canvas) so the render effect never has to
  // set error state — errors are derived, effects only draw.
  const compositionError = useMemo(() => {
    if (effectiveBg === null) {
      return "GridValidationError — outer ring is fully transparent";
    }
    try {
      contentBounds(grid, effectiveBg);
      return null;
    } catch {
      return "GridValidationError — no content against this background";
    }
  }, [grid, effectiveBg]);

  const drawPreviews = useCallback(
    (targetPx: number) => {
      if (compositionError !== null) return;
      try {
        const { canvas } = composeFullBodyPreview(grid, {
          breathingRoom: roomPct / 100,
          bg: bgOverride,
          targetPx,
        });
        blit(canvas, squareEl);
        blit(canvas, circleEl);
      } catch {
        /* pre-flight covers the known failure modes; never loop on state */
      }
    },
    [grid, roomPct, bgOverride, compositionError, squareEl, circleEl],
  );

  // Low-res immediately on any input change (feels live while dragging),
  // full-res debounced ~80ms after the last change. Depends ONLY on render
  // inputs — size/success/copy state changes never re-rasterise.
  useEffect(() => {
    drawPreviews(LOW_RES_TARGET_PX);
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      drawPreviews(FULL_RES_TARGET_PX);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    };
  }, [drawPreviews]);

  const filename =
    pieceId !== null ? `unipeg-${pieceId}-fullbody.png` : "unipeg-fullbody.png";

  const exportOpts = useCallback(
    () => ({
      breathingRoom: roomPct / 100,
      bg: bgOverride,
      size,
    }),
    [roomPct, bgOverride, size],
  );

  const handleDownload = useCallback(async () => {
    if (busy || compositionError !== null) return;
    setBusy(true);
    try {
      const blob = await exportFullBody(grid, exportOpts());
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setSavedLabel(`SAVED ${size}×${size} · ${formatKb(blob.size)}`);
      if (savedTimerRef.current !== null) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setSavedLabel(null), 2000);
    } catch {
      /* export failure surfaces via the composition error line */
    } finally {
      setBusy(false);
    }
  }, [busy, compositionError, grid, exportOpts, filename, size]);

  const handleCopy = useCallback(async () => {
    if (busy || compositionError !== null) return;
    setBusy(true);
    let next: "copied" | "failed" = "failed";
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        throw new Error("clipboard unavailable");
      }
      // Pass the promise straight in — required for Safari's user-gesture rule.
      const item = new ClipboardItem({
        "image/png": exportFullBody(grid, exportOpts()),
      });
      await navigator.clipboard.write([item]);
      next = "copied";
    } catch {
      next = "failed";
    } finally {
      setBusy(false);
      setCopyState(next);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopyState("idle"), 2500);
    }
  }, [busy, compositionError, grid, exportOpts]);

  const copyDetectedHex = useCallback(async () => {
    if (detectedBg === null) return;
    try {
      await navigator.clipboard.writeText(detectedBg);
    } catch {
      /* the flash still confirms the tap */
    }
    setHexFlash(true);
    if (hexTimerRef.current !== null) clearTimeout(hexTimerRef.current);
    hexTimerRef.current = setTimeout(() => setHexFlash(false), 300);
  }, [detectedBg]);

  return {
    cropGhost,
    onCropGhostChange,
    roomPct,
    setRoomPct,
    bgMode,
    setBgMode,
    size,
    setSize,
    busy,
    savedLabel,
    copyState,
    hexFlash,
    detectedBg,
    compositionError,
    setSquareEl,
    setCircleEl,
    filename,
    handleDownload,
    handleCopy,
    copyDetectedHex,
  };
}

type FullBodyEngine = ReturnType<typeof useFullBodyEngine>;

const Ctx = createContext<FullBodyEngine | null>(null);

function useFullBody(): FullBodyEngine {
  const ctx = useContext(Ctx);
  if (ctx === null) {
    throw new Error("FullBody parts must render inside <FullBodyProvider>");
  }
  return ctx;
}

export function FullBodyProvider({ children, ...props }: FullBodyProviderProps) {
  const engine = useFullBodyEngine(props);
  return <Ctx.Provider value={engine}>{children}</Ctx.Provider>;
}

function PreviewCard({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="u-fb-card flex min-w-0 flex-1 flex-col gap-[6px] lg:flex-none">
      <MicroLabel tone="mute">{label}</MicroLabel>
      <div className="rounded-[12px] bg-card p-[8px]">{children}</div>
    </div>
  );
}

/** Square export above 'On X' (desktop); side by side on mobile so the
 *  sticky preview stays shallow. Both blit from the same composed canvas. */
export function FullBodyPreview() {
  const f = useFullBody();
  // Local refs registered into engine STATE in an effect — the engine's
  // draw effect re-runs on attach, and no ref crosses a render boundary.
  const squareRef = useRef<HTMLCanvasElement | null>(null);
  const circleRef = useRef<HTMLCanvasElement | null>(null);
  const { setSquareEl, setCircleEl } = f;
  useEffect(() => {
    setSquareEl(squareRef.current);
    setCircleEl(circleRef.current);
    return () => {
      setSquareEl(null);
      setCircleEl(null);
    };
  }, [setSquareEl, setCircleEl]);
  return (
    <section
      aria-label="Full-Body Fit preview"
      className="flex w-full flex-col gap-[8px]"
    >
      <div className="flex flex-row gap-[8px] lg:flex-col lg:gap-[12px]">
        <PreviewCard label="Square export">
          <div className="relative aspect-square w-full">
            <canvas
              ref={squareRef}
              aria-label="Full-body square preview"
              className="h-full w-full [image-rendering:pixelated]"
            />
            {/* X-crop ghost: the inscribed circle of the composed square. */}
            {f.cropGhost && (
              <>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-full border border-dashed border-mute"
                />
                <span className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 bg-card px-1">
                  <MicroLabel tone="mute">X crop</MicroLabel>
                </span>
              </>
            )}
          </div>
        </PreviewCard>

        <PreviewCard label="On X">
          <div className="relative aspect-square w-full overflow-hidden rounded-full">
            <canvas
              ref={circleRef}
              aria-label="Full-body preview inside X's circular crop"
              className="h-full w-full [image-rendering:pixelated]"
            />
          </div>
        </PreviewCard>
      </div>

      {f.compositionError !== null && (
        <p className="border-2 border-ink p-3 font-mono text-[12px] leading-snug text-ink">
          {f.compositionError}
        </p>
      )}
    </section>
  );
}

/** Compact multi-column controls + condensed export row. */
export function FullBodyControls() {
  const f = useFullBody();
  return (
    <section
      aria-label="Full-Body Fit controls"
      className="flex w-full flex-col gap-[8px]"
    >
      <div className="grid grid-cols-1 items-center gap-x-[24px] gap-y-[6px] lg:grid-cols-2">
        {/* breathing room (live) */}
        <div className="u-cslider-row">
          <CellSlider
            label="Breathing room"
            value={f.roomPct}
            min={0}
            max={30}
            step={1}
            detents={[DEFAULT_ROOM_PCT]}
            onChange={f.setRoomPct}
            format={(v) => `ROOM ${v}%`}
          />
        </div>

        {/* background */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-ink">Background</span>
          {BG_PILLS.map(({ mode, label }) => (
            <Pill
              key={mode}
              variant={f.bgMode === mode ? "active" : "card"}
              aria-pressed={f.bgMode === mode}
              onClick={() => f.setBgMode(mode)}
            >
              {label}
            </Pill>
          ))}
          {f.detectedBg !== null && (
            <button
              type="button"
              onClick={f.copyDetectedHex}
              aria-label={`Copy detected background colour ${f.detectedBg}`}
              className={`u-focus-square inline-flex h-[var(--control-h)] min-h-[44px] cursor-pointer items-center gap-2 font-mono text-[12px] ${
                f.hexFlash ? "text-accent" : "text-mute"
              }`}
            >
              <span
                aria-hidden="true"
                className="inline-block h-[8px] w-[8px]"
                style={{ backgroundColor: f.detectedBg }}
              />
              {f.detectedBg.toUpperCase()}
            </button>
          )}
        </div>

        {/* crop ghost toggle — gates the preview circle */}
        <div className="flex items-center justify-between gap-2 lg:justify-start">
          <MicroLabel tone="mute">Crop preview</MicroLabel>
          <Pill
            variant={f.cropGhost ? "active" : "card"}
            aria-pressed={f.cropGhost}
            onClick={() => f.onCropGhostChange(!f.cropGhost)}
          >
            X CROP {f.cropGhost ? "ON" : "OFF"}
          </Pill>
        </div>
      </div>

      {/* condensed export row: size picker + download + copy + filename */}
      <div className="flex flex-wrap items-center gap-x-[10px] gap-y-[6px]">
        <MicroLabel tone="pink">Export</MicroLabel>
        {SIZES.map((s) => (
          <Pill
            key={s}
            variant={f.size === s ? "active" : "card"}
            aria-pressed={f.size === s}
            onClick={() => f.setSize(s)}
            className="font-mono"
          >
            {s}
          </Pill>
        ))}
        <Pill
          variant="ink"
          onClick={f.handleDownload}
          disabled={f.busy || f.compositionError !== null}
          className="font-mono"
        >
          {f.savedLabel ?? `DOWNLOAD ${f.size}×${f.size} PNG`}
        </Pill>
        <Pill
          variant={f.copyState === "copied" ? "active" : "card"}
          onClick={f.handleCopy}
          disabled={f.busy || f.compositionError !== null}
          className="font-mono"
        >
          {f.copyState === "copied" ? "COPIED PNG" : "COPY PNG"}
        </Pill>
        <span className="font-mono text-[12px] leading-none text-mute">
          {f.filename}
        </span>
        {f.copyState === "failed" && (
          <span className="font-mono text-[12px] leading-none text-mute">
            CLIPBOARD UNAVAILABLE {"—"} DOWNLOAD INSTEAD
          </span>
        )}
      </div>
    </section>
  );
}
