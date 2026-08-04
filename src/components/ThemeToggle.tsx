"use client";

/**
 * Theme toggle: a 2×2 pixel glyph (two ink cells, two paper cells) that
 * rotates 90° on toggle (instant under reduced motion — the global
 * kill-switch removes the transition). Persists 'unipegpfp.theme' to
 * localStorage and sets data-theme on <html>. Initial value was already
 * applied before paint by the inline script in layout.tsx.
 */

import { useEffect, useState } from "react";

const STORAGE_KEY = "unipegpfp.theme";

type Theme = "light" | "dark";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  const [quarterTurns, setQuarterTurns] = useState(0);

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setQuarterTurns((t) => t + 1);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode etc. — theme still applies for this visit */
    }
  };

  const cellOn = { backgroundColor: "var(--ink)" } as const;
  const cellOff = {
    backgroundColor: "var(--paper)",
    boxShadow: "inset 0 0 0 1px var(--line)",
  } as const;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={
        theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
      }
      className="u-focus-square inline-flex h-12 min-h-[44px] w-12 min-w-[44px] cursor-pointer items-center justify-center"
    >
      <span
        aria-hidden="true"
        className="grid h-[14px] w-[14px] grid-cols-2 grid-rows-2 transition-transform duration-200"
        style={{ transform: `rotate(${quarterTurns * 90}deg)` }}
      >
        <span style={cellOn} />
        <span style={cellOff} />
        <span style={cellOff} />
        <span style={cellOn} />
      </span>
    </button>
  );
}
