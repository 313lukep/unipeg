"use client";

/**
 * Full-Body Fit panel — square export preview beside the circle-masked
 * version X will actually show, both blitted from the SAME composed canvas.
 * Breathing-room slider (0-30%, default 12%) re-renders live: a low-res pass
 * immediately, the full-res pass debounced ~80ms after the last change.
 *
 * The panel never fetches — it receives an already-loaded Grid. The circle
 * overlay is exact by construction: fullBodyCompose returns an N x N square
 * whose inscribed circle IS the X crop, so a full-inset dashed circle on the
 * square preview needs no extra maths.
 */

import {
  useCallback,
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

function PreviewCard({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <MicroLabel tone="mute">{label}</MicroLabel>
      <div className="rounded-[12px] bg-card p-3">{children}</div>
    </div>
  );
}

export default function FullBodyPanel({
  grid,
  pieceId,
  cropGhost,
  onCropGhostChange,
}: {
  grid: Grid;
  pieceId: number | null;
  /** X-crop ghost visibility — one control for panel preview AND stage circle. */
  cropGhost: boolean;
  onCropGhostChange: (on: boolean) => void;
}) {
  const [roomPct, setRoomPct] = useState(DEFAULT_ROOM_PCT);
  const [bgMode, setBgMode] = useState<"auto" | string>("auto");
  const [size, setSize] = useState<FullBodySize>(1000);
  const [busy, setBusy] = useState(false);
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [hexFlash, setHexFlash] = useState(false);

  const squareRef = useRef<HTMLCanvasElement | null>(null);
  const circleRef = useRef<HTMLCanvasElement | null>(null);
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

  const effectiveBg = bgMode === "auto" ? detectedBg : bgMode;

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
      if (compositionError !== null || effectiveBg === null) return;
      try {
        const { canvas } = composeFullBodyPreview(grid, {
          breathingRoom: roomPct / 100,
          bg: effectiveBg,
          targetPx,
        });
        blit(canvas, squareRef.current);
        blit(canvas, circleRef.current);
      } catch {
        /* pre-flight covers the known failure modes; never loop on state */
      }
    },
    [grid, roomPct, effectiveBg, compositionError],
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
      bg: effectiveBg ?? undefined,
      size,
    }),
    [roomPct, effectiveBg, size],
  );

  const handleDownload = async () => {
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
  };

  const handleCopy = async () => {
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
  };

  const copyDetectedHex = async () => {
    if (detectedBg === null) return;
    try {
      await navigator.clipboard.writeText(detectedBg);
    } catch {
      /* the flash still confirms the tap */
    }
    setHexFlash(true);
    if (hexTimerRef.current !== null) clearTimeout(hexTimerRef.current);
    hexTimerRef.current = setTimeout(() => setHexFlash(false), 300);
  };

  return (
    <section aria-label="Full-Body Fit" className="flex w-full flex-col gap-6">
      {/* ---- crop ghost toggle: one control for panel AND stage circle ---- */}
      <div className="flex items-center justify-between gap-2">
        <MicroLabel tone="mute">Crop preview</MicroLabel>
        <Pill
          variant={cropGhost ? "active" : "card"}
          aria-pressed={cropGhost}
          onClick={() => onCropGhostChange(!cropGhost)}
        >
          X CROP {cropGhost ? "ON" : "OFF"}
        </Pill>
      </div>

      {/* ---- previews: square + circle mask from the SAME render ----
           Stacked by default, 2-up ONLY in the 640-959px window (the row is
           bounded, not overridden — Tailwind orders min-[960px] before sm in
           the cascade), stacked again inside the narrow desktop rail so each
           preview keeps the full rail width. */}
      <div className="flex flex-col gap-4 sm:max-[959px]:flex-row">
        <PreviewCard label="Square export">
          <div className="relative aspect-square w-full">
            <canvas
              ref={squareRef}
              aria-label="Full-body square preview"
              className="h-full w-full [image-rendering:pixelated]"
            />
            {/* X-crop ghost: the inscribed circle of the composed square. */}
            {cropGhost && (
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

      {compositionError !== null && (
        <p className="border-2 border-ink p-3 font-mono text-[12px] leading-snug text-ink">
          {compositionError}
        </p>
      )}

      {/* ---- breathing room (live) ---- */}
      <CellSlider
        label="Breathing room"
        value={roomPct}
        min={0}
        max={30}
        step={1}
        detents={[DEFAULT_ROOM_PCT]}
        onChange={setRoomPct}
        format={(v) => `ROOM ${v}%`}
      />

      {/* ---- background ---- */}
      <div className="flex flex-col gap-2">
        <MicroLabel tone="mute">Background</MicroLabel>
        <div className="flex flex-wrap items-center gap-2">
          <Pill
            variant={bgMode === "auto" ? "active" : "card"}
            aria-pressed={bgMode === "auto"}
            onClick={() => setBgMode("auto")}
          >
            AUTO
          </Pill>
          {detectedBg !== null && (
            <button
              type="button"
              onClick={copyDetectedHex}
              aria-label={`Copy detected background colour ${detectedBg}`}
              className={`u-focus-square inline-flex h-12 min-h-[44px] cursor-pointer items-center gap-2 font-mono text-[12px] ${
                hexFlash ? "text-accent" : "text-mute"
              }`}
            >
              <span
                aria-hidden="true"
                className="inline-block h-[8px] w-[8px]"
                style={{ backgroundColor: detectedBg }}
              />
              {detectedBg.toUpperCase()}
            </button>
          )}
          {/* literal-pixel swatches from the piece palette */}
          {grid.palette.map((hex) => (
            <button
              key={hex}
              type="button"
              onClick={() => setBgMode(hex)}
              aria-label={`Background ${hex}`}
              aria-pressed={bgMode === hex}
              className={`h-12 min-h-[44px] w-12 min-w-[44px] cursor-pointer border-2 ${
                bgMode === hex ? "border-accent" : "border-line"
              }`}
              style={{ backgroundColor: hex }}
            />
          ))}
        </div>
      </div>

      {/* ---- export ---- */}
      <div className="flex flex-col gap-2">
        <MicroLabel tone="pink">Export</MicroLabel>
        <div className="flex flex-wrap items-center gap-2">
          {SIZES.map((s) => (
            <Pill
              key={s}
              variant={size === s ? "active" : "card"}
              aria-pressed={size === s}
              onClick={() => setSize(s)}
              className="font-mono"
            >
              {s}
            </Pill>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill
            variant="ink"
            onClick={handleDownload}
            disabled={busy || compositionError !== null}
            className="font-mono"
          >
            {savedLabel ?? `DOWNLOAD ${size}×${size} PNG`}
          </Pill>
          <Pill
            variant={copyState === "copied" ? "active" : "card"}
            onClick={handleCopy}
            disabled={busy || compositionError !== null}
            className="font-mono"
          >
            {copyState === "copied" ? "COPIED PNG" : "COPY PNG"}
          </Pill>
        </div>
        {copyState === "failed" && (
          <p className="font-mono text-[12px] leading-none text-mute">
            CLIPBOARD UNAVAILABLE {"—"} DOWNLOAD INSTEAD
          </p>
        )}
        <p className="font-mono text-[12px] leading-none text-mute">
          {filename}
        </p>
      </div>
    </section>
  );
}
