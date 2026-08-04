# unipegPFP — project context

The app's name is **unipegPFP** (owner's choice — use this exact casing in all UI,
titles, and metadata).

## What this project is

A web app that takes a Unipeg (`$uPEG`) piece by number and turns it into a profile
picture that actually works on X/Twitter's circular avatar crop.

Two outputs from one source image:

1. **Full-body fit** — extend the piece's own background colour outward so the entire
   unicorn stays inside the circle when the user zooms out in X's avatar cropper.
2. **Head sticker** — crop the head + hair/mane, key out the background, add a chunky
   white outline, rotate it, and place it on a chosen background. Sticker style.

## What Unipeg actually is (verified facts — do not guess around these)

- `$uPEG` is an ERC-20 on Ethereum mainnet at `0x44b28991b167582f18ba0259e0173176ca125505`,
  hard-capped at 10,000 tokens.
- It is **not** an ERC-721. Each whole-integer balance (1, 2, 3 …) maps to a collectible
  image via a Uniswap v4 hook (`UpegHook.sol`). Fractional balances are inert.
- **The art is a 24×24 pixel grid, rendered as SVG entirely on-chain.** No IPFS, no
  external storage, no image CDN. A swap generates a hash encoding layers, colours and
  original owner; the on-chain SVG renderer assembles the unicorn from it.
- Site: `https://unipeg.art` · X: `@unipegv4`

**The 24×24 fact is the single most important thing in this codebase.** Every image
operation must happen on a 24×24 colour grid, never on interpolated pixels. Get the grid
first, do all maths in grid cells, rasterise once at the end. This removes every
anti-aliasing, colour-keying and edge-fringe problem before it exists.

## Where to get a piece — verified sources, in priority order

`unipeg.art` itself is behind bot detection and blocks automated requests. Don't build on
it. There are four better sources, all verified reachable:

1. **On-chain read via public RPC.** The token contract's ABI includes the errors
   `UpegIndexOutOfRange` and `NotUpegOwner`, which confirms an index-based accessor
   exists. Several public mainnet RPCs send permissive CORS headers, so `viem` can run in
   the browser with no backend at all. Fetch the verified ABI from `api.etherscan.io`
   (the API host, not `etherscan.io` — the API is built for programmatic access and works
   fine with a free key). Confirm the exact renderer signature before coding against it.

2. **`upeglens.art` — community-built, no bot detection, verified fetchable.** It loads
   the entire collection from a single static file at `data/upegs_full.json`, carrying
   traits, hex colours, distinct-colour counts (2–7 per piece), and rarity tiers for all
   10,000. Also has `dreamer.html` and `rankings.html`. Not affiliated with the official
   team — contact is `@h2crypto_eth`. Being a static file on a simple host, it likely has
   permissive CORS; check, and mirror it server-side if not. Never hammer it — cache once
   and serve locally.

3. **OpenSea.** The objects are wrapped and listed at `opensea.io/collection/unipegv4`.
   OpenSea's API returns CDN image URLs with permissive CORS. Simplest possible path if
   the chain read turns out to be awkward, though you get a rendered raster rather than
   the source SVG.

4. **Manual upload / paste.** Always available, never removed.

CORS note: it only applies to browser requests. A Next.js route handler making a
server-side fetch has no CORS restriction at all — bot detection is the only obstacle
there, and only `unipeg.art` has it.

## Stack

- Next.js (App Router) + TypeScript
- Tailwind for styling
- `viem` for chain reads
- Canvas 2D for rendering and export (`imageSmoothingEnabled = false` everywhere)
- No database. No auth. Cache chain reads in a route-level LRU + `localStorage`.

## Non-negotiables

- `imageSmoothingEnabled = false` on every canvas context, every time. Blurry pixel art
  is a failed build.
- All geometry in grid cells (integers). Convert to device pixels only at render.
- Exports are PNG, transparent where it makes sense, sized for X (400×400 minimum,
  1000×1000 preferred, under 2 MB).
- Works on mobile. Most people set a profile picture from their phone.

## Design direction (from the owner)

- Clean **black / white / pink** palette, with a **light and dark mode** toggle.
- Reference: the unipeg.art gallery — near-black surfaces in dark mode, chunky white
  display headings, letterspaced pink micro-labels (e.g. "EXPLORE"), monospaced piece
  numbers and hex values, pixel art presented on soft muted card backgrounds with
  generous negative space.
