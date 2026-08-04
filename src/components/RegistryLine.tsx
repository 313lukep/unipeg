"use client";

/**
 * Registry line as provenance badge — mono 12px --mute. Segments:
 *   #381204 · 6571 ALIVE / 10000 CAP · ON-CHAIN SVG · 0x44b2…5505 · [swatches]
 * The truncated contract hash copies the full address on tap; the segment
 * flashes --accent for 300ms instead of a toast. The ≤4 piece swatches render
 * as literal 8px pixels. Grayscale pieces append `PALETTE: MONO → PINK`.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { UpegPiece } from "@/lib/upeg";

const CONTRACT_ADDRESS = "0x44b28991b167582f18ba0259e0173176ca125505";
const CONTRACT_SHORT = "0x44b2…5505";

const PROVENANCE_TEXT: Record<UpegPiece["provenance"], string> = {
  chain: "ON-CHAIN SVG",
  "local-verified": "LOCAL RENDER · VERIFIED PORT",
  recovered: "RECOVERED FROM IMAGE",
};

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
  const [flashing, setFlashing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(CONTRACT_ADDRESS);
    } catch {
      /* clipboard unavailable — the flash still confirms the tap */
    }
    setFlashing(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlashing(false), 300);
  };

  const segments: ReactNode[] = [];

  if (piece !== null) {
    segments.push(<span key="id">#{piece.id}</span>);
  }
  if (aliveCount !== null) {
    segments.push(<span key="alive">{aliveCount} ALIVE / 10000 CAP</span>);
  }
  if (piece !== null) {
    segments.push(<span key="prov">{PROVENANCE_TEXT[piece.provenance]}</span>);
  }
  segments.push(
    <button
      key="contract"
      type="button"
      onClick={copyAddress}
      aria-label={`Copy contract address ${CONTRACT_ADDRESS}`}
      className={`u-focus-square inline-flex min-h-[44px] cursor-pointer items-center font-mono ${
        flashing ? "text-accent" : "text-mute"
      }`}
    >
      {CONTRACT_SHORT}
    </button>,
  );
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
