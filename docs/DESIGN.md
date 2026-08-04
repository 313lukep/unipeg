# unipegPFP — design system ("Coronation Plate")

The single design source of truth, produced by the design-lead panel (three independent
proposals, judged and merged). The UI must be built from this document, not from taste.

**Concept: the piece signs the studio.** A disciplined black/white/pink catalogue page;
when a unicorn loads, its number takes over the masthead and its palette dyes the accents.
Black stays black, white stays white, pink stays the app's voice.

## Naming

The app is **unipegPFP** — exact casing, everywhere: masthead wordmark, `<title>`,
metadata, README. (The design panel drafted "UNIPEG PFP STUDIO" before the owner named
it; the wordmark renders the name uppercase-styled as `UNIPEGPFP` only if tracking
demands it — prefer `unipegPFP` verbatim.)

## Reality corrections (from Phase 0 discovery — override any older copy)

- Upeg ids are **global mint serials** (max = `UpegsTotalCount()`, ~388,199 and growing),
  not 1–10,000. 10,000 caps *alive* upegs, ~6,571 currently alive. Validation is
  `1 ≤ id ≤ UpegsTotalCount`; a dead (burned/pooled) id is a real lookup miss, phrased
  in-palette: "#12345 — MINTED, NOT ALIVE. Its tokens returned to the pool."
- Registry line: `#381204 · 6571 ALIVE / 10000 CAP · ON-CHAIN SVG · 0x44b2…5505`.
- No zero-padding anywhere in display. Filenames: `unipeg-381204-fullbody.png`.
- Error copy uses the contract's own error names in mono, e.g.
  `UpegIndexOutOfRange — ids run 1 to 388199`.

## Owner amendments (2026-08-04 — override anything conflicting below)

- **Full-Body Fit**: the added pixels extend the piece's **own current background
  colour** (detected). The colour override/swatch row stays as a secondary control.
- **Head Sticker background**: exactly **three options** — **BLACK** (`#000000`),
  **WHITE** (`#FFFFFF`), or **PIECE BG** (the piece's existing background colour).
  Default BLACK. The derived complement-tint idea is dropped from the UI (the
  exporter may keep the capability internally).

## Tokens (CSS custom properties on `:root`, `[data-theme=dark]` overrides)

| token | light | dark | role |
|---|---|---|---|
| `--paper` | `#FFFFFF` | `#0B0B0D` | Page background. Never retints. |
| `--ink` | `#0B0B0D` | `#F7F7F8` | Primary text, display headings, piece digits, the solid Download button. Never retints. |
| `--pink` | `#D8006E` | `#FF4DA1` | Brand chrome that never retints: wordmark, wayfinding micro-labels (LOAD, TOOL, EXPORT), empty-state pixel, resting focus rings. Deliberately not raw Uniswap `#FF007A` (fails AA on white at 3.80:1); these measure 5.07:1 light / 6.39:1 dark on paper. **Rule: pink = chrome about the APP, accent = chrome about the PIECE.** |
| `--accent` | boots = pink | boots = pink | The live accent. Retints to the loaded piece: `oklch(0.45 var(--piece-c) var(--piece-h))` light, `oklch(0.80 min(var(--piece-c),0.17) var(--piece-h))` dark. Drives the `#` glyph, focus rings after load, slider ticks/thumbs, selected-pill borders, link underlines, copy-flash, `::selection`. |
| `--wash` | `#FFECF5`* | `#231219`* | Stage/plate surface, derived: `oklch(0.965 min(var(--piece-c),0.03) var(--piece-h))` light / L 0.21 dark. *Listed hex = resting pink-hue results. |
| `--card` | `#F4F3F5` | `#161619` | Static soft surface behind control groups. Flat fill — no blur, shadow, or gradient. Never retints. |
| `--line` | `#E7E4E7` | `#232326` | Hairlines only: ghost gridlines, desktop rail rule, registry separators. Never carries text. |
| `--mute` | `#66666E` | `#9C9CA6` | Grey micro-labels, registry line, ruler numerals, scale bar, live filename. Never retints. |

**Retint mechanism.** Client-side, from the loaded 24×24 grid: discard the piece's
background colour, cluster the rest to ≤4 OKLCH swatches, winner by
`chroma × sqrt(coverage)`. Set `--piece-h` (hue 0–360) and `--piece-c` (chroma clamped
to `[0.05, 0.19]`) on `<html>`, registered via `@property` so they animate. **Only hue
and chroma travel; lightness is pinned per mode**, which makes contrast structural:
verified worst case across all 360 hues — accent vs paper 5.83:1 light / 8.76:1 dark,
ink on wash ≥16:1. Grayscale guard: if max extracted chroma < 0.05, stay on resting pink
and append `PALETTE: MONO → PINK` to the registry line. The 4 swatches also populate the
sticker BG chip row and render as literal 8px pixels in the registry line.

## Typography (all via `next/font/google`)

- **Display — Bricolage Grotesque 700/800.** Rationed to exactly four places: resting
  masthead wordmark (800), the two tool names Full-Body Fit / Head Sticker (700), the
  empty-state line PICK YOUR PEG (700, `--mute`). Always ink or mute, never retinted.
- **Body — Instrument Sans** (variable). UI copy 15–16px/1.5 at 400; control labels 13px
  600; micro-labels 11px 700 uppercase tracking 0.14em — `--pink` for wayfinding verbs
  (LOAD, TOOL, EXPORT), `--mute` for passive nouns (CROP PREVIEW, FILENAME, PROVENANCE).
- **Mono — Space Mono 400/700.** Everything that is on-chain truth: piece numbers,
  contract address, hex values, coordinates, slider readouts (`PAD 2 CELLS`,
  `TILT -8 DEG`), output size, live filename, ruler numerals.
- **The Coronation slot.** At rest the masthead is the wordmark. On load it abdicates:
  wordmark collapses to an 11px micro-label; `#381204` takes the display slot — Space
  Mono 700 at `clamp(40px, 12vw, 88px)`, digits `--ink`, the `#` at 0.6em top-aligned to
  cap-height, coloured `--accent` (first thing that flushes to the piece's colour).
  **Reserve the slot's height; the handover must cause zero layout shift.**

## Layout — THE ARTBOARD

24-column grid, **zero gutters** — spacing is empty cells, exactly like unpainted pixels.
One variable drives everything: `--cell: min(calc(100vw / 24), 40px)`. Tailwind v4
`@theme` sets `--spacing: calc(var(--cell) / 4)` so every utility snaps to quarter-cell
increments; rows use `grid-auto-rows: var(--cell)`. Mobile portrait: artboard = full
viewport. Desktop: capped at 960px (24 × 40px), centred on plain `--paper` — a sheet on
a table. Desktop split: stage cols 1–16, controls rail cols 17–24, `--line` rule exactly
on gridline 17.

The **stage** is a perfect 24×24-cell square sharing the art's literal coordinate system
— SVG pixel (12,4) sits in page cell (12,4). Mono ruler numerals (0 · 6 · 12 · 18 · 23)
along the stage's top edge; a museum scale bar `|– 24 px –|` beneath. The grid is drawn
only there; everywhere else it is felt (pill heights, slider ticks, snap points).

Every control is 3 cells tall → ≥44px touch targets with no magic numbers. Pills are
full-radius; surfaces are 12px radius; nothing else is rounded.

## Micro-details (all required)

- **Empty state:** blank 24×24 ghost grid on `--card`, dashed X-crop circle in place,
  PICK YOUR PEG in `--mute`, one lone `--pink` pixel at cell (12,4) — where a horn would
  be. It does not blink; it waits.
- **Loading:** no spinner. Cells fill in scan order with `--line` at 40% while a mono
  counter reads `READING CHAIN — ROW 07/24`; colour snaps in on resolve. Reduced motion:
  static 40% checker + counter.
- **The theatre:** on load, the stage paints in a 24-step column wipe (`steps(24)`,
  430ms) while `--piece-h/--piece-c` transition 400ms — one synchronized pour as the
  masthead hands over. `prefers-reduced-motion`: both 0ms, single-frame cut.
- **Focus rings:** 2px solid `--accent`, 2px offset, deliberately **square-cornered even
  on round pills** (a cell-boundary tell). Pink at rest, piece-dyed after load.
- **Crop ghost:** dashed 1px `--mute` circle on the stage showing exactly what X keeps,
  `X CROP` micro-label at its tangent; on by default in Full-Body Fit. It and the pills
  are the only circles on the page.
- **Theme toggle:** a 2×2 pixel glyph (two ink cells, two paper cells) rotating 90° on
  toggle (instant under reduced motion). Follows `prefers-color-scheme` initially,
  persists to localStorage, applied via `data-theme` on `<html>` **before paint**.
- **Sliders:** cell-tick tracks, 2-cell square thumb, values in the artwork's units in
  Space Mono 700. Tilt detents at 0/±8° (5° snap steps per spec range ±45°); pad steps
  in whole cells.
- **Download:** solid `--ink` pill, `--paper` label, `DOWNLOAD 1000×1000 PNG` — never
  retinted. Live filename beneath in `--mute` mono. Success swaps label to
  `SAVED 1000×1000 · 12.4KB` for 2s.
- **Registry line as provenance badge:** mono 12px `--mute`, truncated contract hash
  copies on tap, segment flashes `--accent` 300ms instead of a toast. Provenance segment
  says which source the art came from: `ON-CHAIN SVG` / `LOCAL RENDER (VERIFIED PORT)` /
  `RECOVERED FROM IMAGE`.
- **Errors stay in-palette:** mono, `--ink` border. No red exists anywhere.
- `::selection` is `--accent` with contrast-matched text.

## Accessibility

- Contrast: guaranteed by the lightness pin (see retint). Dev-mode assert re-checks
  computed values as a belt.
- Reduced motion: every animation gated on `prefers-reduced-motion`.
- Keyboard: everything reachable; visible square focus rings; the crop selector operable
  by arrow keys (move) / shift+arrows (resize).
- Mobile portrait is the first-class layout (the reference screenshot is mobile).
