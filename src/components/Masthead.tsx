import ThemeToggle from "@/components/ThemeToggle";

/**
 * Brand bar + piece-number slot (owner's layout).
 *
 * `BrandBar` is pinned to the top of the page: the unipegPFP wordmark big
 * and permanent, "created by @Wiggz_eth" beside it, theme toggle on the
 * right. Sits on --paper with a --line rule so content slides beneath it.
 *
 * `Masthead` below it is now just the piece-number slot — Space Mono 700,
 * digits in --ink, the `#` at 0.6em top-aligned and coloured --accent (the
 * first thing that flushes to the piece's palette). Slightly smaller than
 * the original coronation size, per the owner. Height is reserved in both
 * states so loading a piece causes zero layout shift.
 */

const NUMBER_SIZE = "clamp(30px, 9vw, 64px)";

export function BrandBar() {
  return (
    <header className="sticky top-0 z-50 -mx-4 border-b border-line bg-paper px-4">
      <div className="flex items-center justify-between gap-3 py-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0">
          <span
            className="font-display font-extrabold leading-none text-ink"
            style={{ fontSize: "clamp(26px, 7vw, 40px)" }}
          >
            unipegPFP
          </span>
          <a
            href="https://x.com/Wiggz_eth"
            target="_blank"
            rel="noopener noreferrer"
            className="u-focus-square inline-flex min-h-[44px] items-center gap-1.5"
          >
            <span className="text-[11px] font-bold uppercase leading-none tracking-[0.14em] text-mute">
              created by
            </span>
            <span className="text-[13px] font-bold leading-none text-pink">
              @Wiggz_eth
            </span>
          </a>
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}

export default function Masthead({ pieceId }: { pieceId: number | null }) {
  return (
    <div
      className="flex items-center pt-3"
      style={{ height: `calc(${NUMBER_SIZE} + 12px)` }}
    >
      {pieceId !== null && (
        <h1
          className="font-mono font-bold leading-none text-ink"
          style={{ fontSize: NUMBER_SIZE }}
        >
          <span className="align-top text-[0.6em] text-accent">#</span>
          {pieceId}
        </h1>
      )}
    </div>
  );
}
