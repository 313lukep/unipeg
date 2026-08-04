"use client";

/**
 * unipegPFP — the artboard, laid out to the owner's spec.
 *
 * Desktop (>=1024px, page still capped at 960px): brand bar, then piece
 * number + registry on one line, the LOAD row, one compact row of RECENT
 * thumbnails + the upload/recover control, then the MAIN ROW — stage left
 * (square, height-driven via --stage-side) with the active tool's previews
 * stacked to its right — and finally the tool tabs + ALL controls in a
 * compact multi-column grid with the condensed export row. The whole page
 * from brand bar to download button fits 1280x900 with no vertical scroll.
 *
 * Mobile: same DOM order; the active tool's preview is sticky under the
 * pinned brand bar (z below it) so it stays visible while the compacted
 * controls scroll beneath.
 *
 * The page owns the piece state machine (idle | loading | loaded | error):
 * resolvePiece -> svgToGrid -> extractPieceTheme/applyPieceTheme ->
 * detectHeadSeed (initial sticker selection) -> coronation handover +
 * column-wipe theatre. Errors surface per UpegLookupError code, mono and
 * in-palette. The recovery path (upload/drop/paste) produces a piece with
 * provenance 'recovered' — masthead stays wordmark, both tools still work.
 *
 * Both tools stay mounted (their providers hold the settings) so state
 * persists across tab switches; only visibility toggles.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Masthead, { BrandBar } from "@/components/Masthead";
import RegistryLine from "@/components/RegistryLine";
import LookupBar from "@/components/LookupBar";
import Stage from "@/components/Stage";
import RecentLookups, { type RecentEntry } from "@/components/RecentLookups";
import UploadDrop from "@/components/UploadDrop";
import {
  FullBodyProvider,
  FullBodyPreview,
  FullBodyControls,
} from "@/components/panels/FullBodyPanel";
import {
  StickerProvider,
  StickerPreview,
  StickerControls,
  StickerStageDragLayer,
} from "@/components/panels/StickerPanel";
import MicroLabel from "@/components/ui/MicroLabel";
import Pill from "@/components/ui/Pill";
import { detectHeadSeed, svgToGrid, GridValidationError } from "@/lib/grid";
import type { CellRect, Grid } from "@/lib/grid";
import {
  resolvePiece,
  startAlivePolling,
  UpegLookupError,
  type UpegMetadata,
  type UpegPiece,
} from "@/lib/upeg";
import {
  applyPieceTheme,
  clearPieceTheme,
  extractPieceTheme,
  type PieceTheme,
} from "@/lib/retint";

type Phase = "idle" | "loading" | "loaded" | "error";
type Tool = "fullbody" | "sticker";

const RECENTS_KEY = "unipegpfp.recents";
const RECENTS_MAX = 8;
const ROW_TICK_MS = 45;

/** Grid classes shared by both main-row states (loaded and not). */
const MAIN_ROW_CLASS =
  "mt-[10px] grid grid-cols-1 gap-[10px] " +
  "lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-x-[24px] lg:gap-y-[14px]";

/** Placeholder metadata for recovered pieces (no seed exists). */
const RECOVERED_METADATA: UpegMetadata = {
  backGroundColor: 0,
  body: 0,
  eyes: 0,
  hair: 0,
  horn: 0,
  legsBack: 0,
  legsFront: 0,
  wings: 0,
  tail: 0,
  accessories: 0,
  ground: 0,
  bodyColor: 0,
  eyesColor: 0,
  hairColor: 0,
  hornColor: 0,
  groundColor: 0,
  accessoriesColor: 0,
  tailColor: 0,
};

/** Head seed with a safe fallback: top-centre square of the grid. */
function initialSelection(grid: Grid): CellRect {
  try {
    return detectHeadSeed(grid).rect;
  } catch {
    const side = Math.min(12, grid.w, grid.h);
    return {
      x: Math.max(0, Math.floor((grid.w - side) / 2)),
      y: Math.max(0, Math.min(grid.h - side, Math.floor(grid.h / 6))),
      w: side,
      h: side,
    };
  }
}

/** Error copy per DESIGN.md — contract error names in mono, always in-palette. */
function errorCopy(err: unknown): string {
  if (err instanceof UpegLookupError) {
    switch (err.code) {
      case "invalid-id":
        // No contract error corresponds to this local validation — plain
        // language only (DESIGN.md: use the contract's OWN error names).
        return "A piece id is a whole number — 1 or higher.";
      case "out-of-range":
        return err.message; // "UpegIndexOutOfRange — ids run 1 to N."
      case "not-alive":
        return `#${err.id ?? "?"} — MINTED, NOT ALIVE. Its tokens returned to the pool.`;
      case "network":
        return "CHAIN UNREACHABLE — no RPC answered. Check your connection and try again.";
      case "dataset-unavailable":
        return "SNAPSHOT UNAVAILABLE — the alive-piece dataset could not load. Try again.";
    }
  }
  if (err instanceof GridValidationError) {
    return `GridValidationError — ${err.reason}`;
  }
  return "SOMETHING WENT SIDEWAYS — try again.";
}

function readRecents(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is RecentEntry =>
          typeof e === "object" &&
          e !== null &&
          typeof (e as RecentEntry).id === "number" &&
          typeof (e as RecentEntry).seed === "string",
      )
      .slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [piece, setPiece] = useState<UpegPiece | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [theme, setTheme] = useState<PieceTheme | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [aliveCount, setAliveCount] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>("fullbody");
  const [selection, setSelection] = useState<CellRect | null>(null);
  // X-crop ghost in Full-Body Fit — on by default per DESIGN.md.
  const [cropGhost, setCropGhost] = useState(true);
  const [loadingRow, setLoadingRow] = useState(0);
  const [wipeKey, setWipeKey] = useState(0);
  const [recents, setRecents] = useState<RecentEntry[]>([]);

  const loadSeq = useRef(0);
  const rowTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Registry line: live alive count. The alive store loads the bundled
  // snapshot, patches it with an on-chain mint/burn event delta, and keeps
  // polling (~2 min, jittered, only while the tab is visible) — the
  // collection churns constantly, so the count and lookups stay current.
  useEffect(() => {
    const stop = startAlivePolling((s) => setAliveCount(s.aliveCount));
    return stop;
  }, []);

  // Recents from localStorage — post-hydration sync from an external store.
  // Reading it in the initializer would mismatch the server-rendered markup.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecents(readRecents());
  }, []);

  const pushRecent = useCallback((entry: RecentEntry) => {
    setRecents((prev) => {
      const next = [entry, ...prev.filter((e) => e.id !== entry.id)].slice(
        0,
        RECENTS_MAX,
      );
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {
        /* quota — recents just don't persist */
      }
      return next;
    });
  }, []);

  // Fake-progress rows while awaiting the chain; snap on resolve.
  const stopRows = useCallback(() => {
    if (rowTimer.current !== null) {
      clearInterval(rowTimer.current);
      rowTimer.current = null;
    }
  }, []);
  const startRows = useCallback(() => {
    stopRows();
    setLoadingRow(1);
    rowTimer.current = setInterval(() => {
      setLoadingRow((r) => Math.min(r + 1, 23));
    }, ROW_TICK_MS);
  }, [stopRows]);
  useEffect(() => stopRows, [stopRows]);

  const crown = useCallback((nextPiece: UpegPiece, nextGrid: Grid) => {
    const t = extractPieceTheme(nextGrid);
    applyPieceTheme(t);
    setPiece(nextPiece);
    setGrid(nextGrid);
    setTheme(t);
    setSelection(initialSelection(nextGrid));
    setErrorText(null);
    setPhase("loaded");
    setWipeKey((k) => k + 1);
  }, []);

  const loadPiece = useCallback(
    async (id: number) => {
      const seq = ++loadSeq.current;
      setPhase("loading");
      setErrorText(null);
      setPiece(null);
      setGrid(null);
      setSelection(null);
      startRows();
      try {
        const resolved = await resolvePiece(id);
        const g = await svgToGrid(resolved.svg);
        if (seq !== loadSeq.current) return;
        stopRows();
        setLoadingRow(24); // snap
        crown(resolved, g);
        pushRecent({ id: resolved.id, seed: resolved.seed.toString() });
      } catch (err) {
        if (seq !== loadSeq.current) return;
        stopRows();
        clearPieceTheme();
        setTheme(null);
        setPhase("error");
        setErrorText(errorCopy(err));
      }
    },
    [crown, pushRecent, startRows, stopRows],
  );

  const handleInvalid = useCallback(
    (err: UpegLookupError) => {
      loadSeq.current++;
      stopRows();
      clearPieceTheme();
      setPiece(null);
      setGrid(null);
      setSelection(null);
      setTheme(null);
      setPhase("error");
      setErrorText(errorCopy(err));
    },
    [stopRows],
  );

  const handleRecovered = useCallback(
    (g: Grid) => {
      loadSeq.current++;
      stopRows();
      crown(
        {
          id: 0, // no serial — masthead stays wordmark, registry skips the id
          seed: 0n,
          svg: "",
          metadata: RECOVERED_METADATA,
          provenance: "recovered",
        },
        g,
      );
    },
    [crown, stopRows],
  );

  const pieceId =
    piece !== null && piece.provenance !== "recovered" ? piece.id : null;
  const loaded = phase === "loaded" && grid !== null && selection !== null;
  const busy = phase === "loading";

  return (
    <main className="mx-auto flex w-full max-w-[960px] flex-1 flex-col px-4 pb-[24px]">
      {/* pinned brand bar: big wordmark, credit, theme toggle */}
      <BrandBar />

      {/* piece number + registry line — one line on desktop */}
      <div className="flex flex-col lg:flex-row lg:items-center lg:gap-x-[16px]">
        <Masthead pieceId={pieceId} />
        <div className="min-w-0 lg:pt-[26px]">
          <RegistryLine
            piece={piece}
            aliveCount={aliveCount}
            swatches={theme?.swatches ?? []}
            mono={theme?.mono ?? false}
          />
        </div>
      </div>

      {/* LOAD row */}
      <div className="mt-[8px]">
        <LookupBar onLookup={loadPiece} onInvalid={handleInvalid} busy={busy} />
      </div>

      {/* one compact row: recent thumbnails + the upload/recover control */}
      <div className="mt-[8px] flex flex-col gap-[8px] lg:flex-row lg:items-center lg:gap-[16px]">
        <div className="min-w-0 lg:flex-1">
          <RecentLookups entries={recents} onSelect={loadPiece} busy={busy} />
        </div>
        <div className="lg:shrink-0">
          <UploadDrop onRecovered={handleRecovered} busy={busy} />
        </div>
      </div>

      {loaded && grid !== null && selection !== null ? (
        <FullBodyProvider
          grid={grid}
          pieceId={pieceId}
          cropGhost={cropGhost}
          onCropGhostChange={setCropGhost}
        >
          <StickerProvider grid={grid} pieceId={pieceId} selection={selection}>
            <div className={MAIN_ROW_CLASS}>
              {/* MAIN ROW left: the stage (cell-snapped CropBox in sticker
                  mode; dragging it low-reses the sticker preview) */}
              <div className="min-w-0 lg:col-start-1 lg:row-start-1 lg:max-w-[var(--stage-side)]">
                <StickerStageDragLayer active={tool === "sticker"}>
                  <Stage
                    grid={grid}
                    phase={phase}
                    loadingRow={loadingRow}
                    mode={tool}
                    selection={selection}
                    onSelectionChange={setSelection}
                    wipeKey={wipeKey}
                  />
                </StickerStageDragLayer>
              </div>

              {/* MAIN ROW right: the active tool's previews. On mobile this
                  block is sticky under the pinned brand bar (z below its
                  z-50) so the preview stays visible while controls scroll. */}
              <div className="min-w-0 max-lg:sticky max-lg:top-[88px] max-lg:z-40 max-lg:border-b max-lg:border-line max-lg:bg-paper max-lg:pb-[8px] lg:col-start-2 lg:row-start-1">
                <div className={tool === "fullbody" ? "" : "hidden"}>
                  <FullBodyPreview />
                </div>
                <div className={tool === "sticker" ? "" : "hidden"}>
                  <StickerPreview />
                </div>
              </div>

              {/* BELOW: tool tabs + ALL controls, compact multi-column.
                  u-dense = 36px control chrome on desktop only. */}
              <div className="u-dense flex min-w-0 flex-col gap-[8px] lg:col-span-2 lg:row-start-2">
                <div className="flex flex-wrap items-center gap-2">
                  <MicroLabel tone="pink">Tool</MicroLabel>
                  <Pill
                    variant={tool === "fullbody" ? "active" : "card"}
                    aria-pressed={tool === "fullbody"}
                    onClick={() => setTool("fullbody")}
                    className="font-display font-bold"
                  >
                    Full-Body Fit
                  </Pill>
                  <Pill
                    variant={tool === "sticker" ? "active" : "card"}
                    aria-pressed={tool === "sticker"}
                    onClick={() => setTool("sticker")}
                    className="font-display font-bold"
                  >
                    Head Sticker
                  </Pill>
                </div>

                {/* both stay mounted so settings persist across tabs */}
                <div className={tool === "fullbody" ? "" : "hidden"}>
                  <FullBodyControls />
                </div>
                <div className={tool === "sticker" ? "" : "hidden"}>
                  <StickerControls />
                </div>

                {/* how-to, condensed */}
                <p className="text-[12px] leading-snug text-mute">
                  On X: Edit profile {"→"} tap your avatar {"→"} pick
                  the file, then pinch-zoom fully out — the full-body export
                  sits exactly inside the circle. The head sticker looks right
                  at any zoom.
                </p>
              </div>
            </div>
          </StickerProvider>
        </FullBodyProvider>
      ) : (
        <div className={MAIN_ROW_CLASS}>
          <div className="flex min-w-0 flex-col gap-[10px] lg:col-start-1 lg:row-start-1 lg:max-w-[var(--stage-side)]">
            <Stage
              grid={grid}
              phase={phase}
              loadingRow={loadingRow}
              mode={tool}
              selection={selection}
              onSelectionChange={setSelection}
              wipeKey={wipeKey}
            />
            {phase === "error" && errorText !== null && (
              <p
                role="alert"
                className="border-2 border-ink p-3 font-mono text-[12px] leading-snug text-ink"
              >
                {errorText}
              </p>
            )}
          </div>
          <div className="min-w-0 lg:col-start-2 lg:row-start-1">
            <p className="text-[13px] leading-relaxed text-mute">
              Load a piece by number, tap a recent one, or drop a screenshot —
              then fit the whole unicorn in X&rsquo;s circle or cut a head
              sticker.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
