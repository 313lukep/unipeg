"use client";

/**
 * LookupBar — mono input (`# PIECE NUMBER`) plus the LOAD pill. Enter
 * submits; the id is validated via validatePieceId BEFORE any fetch, so an
 * invalid id never touches the network. Loading is spinner-free per
 * DESIGN.md — the pill label changes to READING… while the chain answers.
 */

import { useState, type FormEvent } from "react";
import { UpegLookupError, validatePieceId } from "@/lib/upeg";
import MicroLabel from "@/components/ui/MicroLabel";
import Pill from "@/components/ui/Pill";

export type LookupBarProps = {
  onLookup: (id: number) => void;
  onInvalid: (err: UpegLookupError) => void;
  busy: boolean;
};

export default function LookupBar({ onLookup, onInvalid, busy }: LookupBarProps) {
  const [value, setValue] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const raw = value.trim();
    if (raw === "") return;
    try {
      onLookup(validatePieceId(raw));
    } catch (err) {
      if (err instanceof UpegLookupError) onInvalid(err);
    }
  };

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-2">
      <MicroLabel tone="pink">Load</MicroLabel>
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          placeholder="# PIECE NUMBER"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-label="Piece number"
          className="h-12 min-h-[44px] w-full min-w-0 flex-1 border-2 border-line bg-card px-3 font-mono text-[15px] text-ink placeholder:text-mute"
        />
        <Pill variant="ink" type="submit" disabled={busy} className="font-mono">
          {busy ? "READING…" : "LOAD"}
        </Pill>
      </div>
    </form>
  );
}
