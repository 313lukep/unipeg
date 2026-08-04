"use client";

/**
 * RecentLookups — up to 8 previously loaded pieces (persisted by the page in
 * 'unipegpfp.recents'). Each renders a pixel-art thumbnail regenerated from
 * its cached seed via the byte-exact local renderer: generateSvgFromSeed ->
 * svgToGridFromRects (pure string path, no fetch) -> a tiny canvas with
 * smoothing off. Clicking a thumbnail reloads that piece.
 */

import { useEffect, useRef } from "react";
import { generateSvgFromSeed } from "@/lib/upeg";
import { rasterise, svgToGridFromRects } from "@/lib/grid";
import MicroLabel from "@/components/ui/MicroLabel";

export type RecentEntry = { id: number; seed: string };

export type RecentLookupsProps = {
  entries: RecentEntry[];
  onSelect: (id: number) => void;
  busy: boolean;
};

const THUMB_CELL = 2; // device px per cell -> 48px for a 24-cell piece

function Thumb({
  entry,
  onSelect,
  busy,
}: {
  entry: RecentEntry;
  onSelect: (id: number) => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    try {
      const grid = svgToGridFromRects(generateSvgFromSeed(BigInt(entry.seed)));
      cv.width = grid.w * THUMB_CELL;
      cv.height = grid.h * THUMB_CELL;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false; // after every resize
      ctx.clearRect(0, 0, cv.width, cv.height);
      rasterise(grid, THUMB_CELL, ctx);
    } catch {
      /* a bad cached seed just renders blank — the id label still works */
    }
  }, [entry.seed]);

  return (
    <button
      type="button"
      onClick={() => onSelect(entry.id)}
      disabled={busy}
      aria-label={`Load piece ${entry.id} again`}
      className="u-focus-square flex min-h-[44px] min-w-[44px] cursor-pointer flex-col items-center gap-1 disabled:cursor-default disabled:opacity-60"
    >
      <canvas
        ref={ref}
        aria-hidden="true"
        className="[image-rendering:pixelated]"
        style={{ width: 48, height: 48 }}
      />
      <span className="font-mono text-[11px] leading-none text-mute">
        #{entry.id}
      </span>
    </button>
  );
}

export default function RecentLookups({
  entries,
  onSelect,
  busy,
}: RecentLookupsProps) {
  if (entries.length === 0) return null;
  return (
    <div className="flex w-full flex-col gap-2">
      <MicroLabel tone="mute">Recent</MicroLabel>
      <div className="flex flex-wrap items-start gap-2">
        {entries.map((e) => (
          <Thumb key={e.id} entry={e} onSelect={onSelect} busy={busy} />
        ))}
      </div>
    </div>
  );
}
