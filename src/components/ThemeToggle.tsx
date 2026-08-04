"use client";

/**
 * Theme toggle: a chunky pixel-art sun / moon (owner's call — clearly
 * identifiable day/night control, drawn on the same grid language as the
 * art). Shows the mode a tap switches TO: light mode shows a moon, dark
 * mode shows a sun. Persists 'unipegpfp.theme' to localStorage and sets
 * data-theme on <html>. Initial value was already applied before paint by
 * the inline script in layout.tsx.
 */

import { useEffect, useState } from "react";

const STORAGE_KEY = "unipegpfp.theme";

type Theme = "light" | "dark";

/** 9×9 pixel-art glyphs; 1 = filled with --ink. */
const SUN: number[][] = [
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 1, 0, 0, 1, 0, 0, 1, 0],
  [0, 0, 0, 1, 1, 1, 0, 0, 0],
  [0, 0, 1, 1, 1, 1, 1, 0, 0],
  [1, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 0, 1, 1, 1, 1, 1, 0, 0],
  [0, 0, 0, 1, 1, 1, 0, 0, 0],
  [0, 1, 0, 0, 1, 0, 0, 1, 0],
  [0, 0, 0, 0, 1, 0, 0, 0, 0],
];

const MOON: number[][] = [
  [0, 0, 0, 1, 1, 1, 0, 0, 0],
  [0, 0, 1, 1, 1, 0, 0, 0, 0],
  [0, 1, 1, 1, 0, 0, 0, 0, 0],
  [1, 1, 1, 0, 0, 0, 0, 0, 0],
  [1, 1, 1, 0, 0, 0, 0, 0, 0],
  [1, 1, 1, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 0, 0, 0, 0, 1],
  [0, 0, 1, 1, 1, 1, 0, 1, 1],
  [0, 0, 0, 1, 1, 1, 1, 1, 1],
];

function PixelGlyph({ rows }: { rows: number[][] }) {
  return (
    <span
      aria-hidden="true"
      className="grid h-[32px] w-[32px]"
      style={{
        gridTemplateColumns: `repeat(${rows[0].length}, 1fr)`,
        gridTemplateRows: `repeat(${rows.length}, 1fr)`,
      }}
    >
      {rows.flatMap((row, y) =>
        row.map((on, x) => (
          <span
            key={`${x}-${y}`}
            style={on ? { backgroundColor: "var(--ink)" } : undefined}
          />
        )),
      )}
    </span>
  );
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    // Post-hydration sync from the pre-paint script's DOM state. Reading it
    // any earlier (initializer) would mismatch the server-rendered markup.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(current === "dark" ? "dark" : "light");
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode etc. — theme still applies for this visit */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={
        theme === "dark" ? "Switch to light theme" : "Switch to dark theme"
      }
      className="u-focus-square inline-flex h-[var(--control-h)] min-h-[44px] w-[var(--control-h)] min-w-[44px] cursor-pointer items-center justify-center"
    >
      {/* show the mode a tap switches TO; pre-hydration shows the moon so
          the button is never empty (light is the SSR default) */}
      <PixelGlyph rows={theme === "dark" ? SUN : MOON} />
    </button>
  );
}
