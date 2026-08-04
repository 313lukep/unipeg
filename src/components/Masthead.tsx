/**
 * The Coronation slot. At rest the masthead is the wordmark; when a piece
 * loads, the wordmark abdicates to an 11px micro-label and the piece number
 * takes the display slot — Space Mono 700, digits in --ink, the `#` at 0.6em
 * top-aligned and coloured --accent (the first thing that flushes to the
 * piece's palette).
 *
 * Both rows have fixed heights in BOTH states so the handover causes zero
 * layout shift.
 */

const DISPLAY_SIZE = "clamp(40px, 12vw, 88px)";

export default function Masthead({ pieceId }: { pieceId: number | null }) {
  const crowned = pieceId !== null;

  return (
    <header className="w-full pb-2 pt-4">
      {/* micro-label row: height reserved even while empty */}
      <div className="flex h-4 min-h-[16px] items-end" aria-hidden={!crowned}>
        {crowned && (
          <span className="text-[11px] font-bold uppercase leading-none tracking-[0.14em] text-pink">
            unipegPFP
          </span>
        )}
      </div>

      {/* display slot: fixed height, wordmark or piece number */}
      <div
        className="flex items-center"
        style={{ height: DISPLAY_SIZE }}
      >
        {crowned ? (
          <h1
            className="font-mono font-bold leading-none text-ink"
            style={{ fontSize: DISPLAY_SIZE }}
          >
            <span className="align-top text-[0.6em] text-accent">#</span>
            {pieceId}
          </h1>
        ) : (
          <h1
            className="font-display font-extrabold leading-none text-ink"
            style={{ fontSize: DISPLAY_SIZE }}
          >
            unipegPFP
          </h1>
        )}
      </div>
    </header>
  );
}
