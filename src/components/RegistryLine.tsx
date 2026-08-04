"use client";

/**
 * Registry line — mono 12px --mute. Segments (owner trimmed the provenance
 * label and contract hash from the display):
 *   #381204 · 6571 ALIVE / 10000 CAP · [swatches]
 * Recovered uploads still say RECOVERED FROM IMAGE (best-effort art must be
 * marked). The ≤4 piece swatches render as literal 8px pixels. Grayscale
 * pieces append `PALETTE: MONO → PINK`.
 */

import { type ReactNode } from "react";
import type { UpegPiece } from "@/lib/upeg";

function Sep() {
  return <span aria-hidden="true">{"·"}</span>;
}

export default function RegistryLine({
  piece,
  aliveCount,
  swatches,
  mono,
}: {
  piece: UpegPiece | null;
  aliveCount: number | null;
  swatches: string[];
  mono: boolean;
}) {
  const segments: ReactNode[] = [];

  // Recovered pieces carry no real serial (the page passes id 0) — the
  // registry line then leads with provenance instead of a fake number.
  if (piece !== null && piece.id >= 1) {
    segments.push(<span key="id">#{piece.id}</span>);
  }
  if (aliveCount !== null) {
    segments.push(<span key="alive">{aliveCount} ALIVE / 10000 CAP</span>);
  }
  if (piece !== null && piece.provenance === "recovered") {
    segments.push(<span key="prov">RECOVERED FROM IMAGE</span>);
  }
  if (swatches.length > 0) {
    segments.push(
      <span
        key="swatches"
        className="inline-flex items-center gap-[2px]"
        role="img"
        aria-label={`Piece palette: ${swatches.join(", ")}`}
      >
        {swatches.map((hex, i) => (
          <span
            key={`${hex}-${i}`}
            className="inline-block h-[8px] w-[8px]"
            style={{ backgroundColor: hex }}
          />
        ))}
      </span>,
    );
  }
  if (mono) {
    segments.push(<span key="mono">PALETTE: MONO {"→"} PINK</span>);
  }

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[12px] leading-none text-mute">
      {segments.map((seg, i) => (
        <span key={i} className="inline-flex items-center gap-x-2">
          {i > 0 && <Sep />}
          {seg}
        </span>
      ))}
    </p>
  );
}
