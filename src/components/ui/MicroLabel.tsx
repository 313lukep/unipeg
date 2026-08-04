import type { ReactNode } from "react";

/**
 * 11px 700 uppercase tracking-0.14em micro-label.
 * tone="pink"  → wayfinding verbs about the APP (LOAD, TOOL, EXPORT).
 * tone="mute"  → passive nouns (CROP PREVIEW, FILENAME, PROVENANCE).
 */
export default function MicroLabel({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "pink" | "mute";
}) {
  return (
    <span
      className={`text-[11px] font-bold uppercase leading-none tracking-[0.14em] ${
        tone === "pink" ? "text-pink" : "text-mute"
      }`}
    >
      {children}
    </span>
  );
}
