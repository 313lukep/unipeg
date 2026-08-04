# unipegPFP

Turn your Unipeg (`$uPEG`) into a profile picture that survives X/Twitter's circular
avatar crop.

Two tools, one on-chain source of truth:

- **Full-Body Fit** — extends the piece's own background outward so the whole unicorn
  sits inside the inscribed circle when you zoom all the way out in X's cropper.
- **Head Sticker** — crops the head + mane, keys out the background, adds a chunky
  outline, tilts it, and sets it on a soft background derived from the unicorn's own
  colours.

## How it gets the art

The art is a 24×24 pixel grid rendered as SVG entirely on-chain by a Uniswap v4 hook.
The app resolves a piece id in three verified layers (see `docs/DISCOVERY.md`):

1. **id → seed**: a block-stamped snapshot of every alive piece
   (`public/data/upeg-alive.json`, built by a full holder scan), kept current by
   **replaying `OnUpegMinted`/`OnUpegBurned` events client-side** on load and every
   ~2 minutes while the tab is open — the collection changes constantly and the app
   tracks it live.
2. **seed → SVG**: `eth_call generate(seed)` on the renderer contract
   (`0xe540…c440`) via CORS-verified public RPCs — provenance shows **ON-CHAIN SVG**.
   If the RPC is unreachable, a **byte-exact TypeScript port** of the renderer
   (fixture-verified against 16 real on-chain outputs) renders the same art —
   provenance shows **LOCAL RENDER · VERIFIED PORT**.
3. **Upload / paste** — screenshots and upscaled PNGs are reconstructed back onto the
   24×24 grid (autocorrelation period detection) and marked **RECOVERED FROM IMAGE**.

## Scale

Fully static — no backend, no database. Chain reads happen in the visitor's browser
against two independent public RPCs with fallback; polling is jittered and
visibility-aware. 500–1000 concurrent users cost the origin nothing beyond CDN traffic.
A scheduled workflow (`refresh-snapshot.yml`, activates on the default branch)
re-scans the collection every 5 minutes and publishes to the `data-live` branch to keep
the client-side delta window tiny.

## Develop

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # vitest — grid maths, renderer port fixtures, resolver, delta
npm run build
```

- `src/lib/grid/` — the pixel engine: SVG→grid, image recovery, background detection,
  content bounds, keying, dilation, circle-fit maths, head auto-detect, rasterisation.
  Pure functions, all geometry in integer cells.
- `src/lib/upeg/` — chain layer: verified ABI surface, byte-exact renderer port,
  alive-set store + event delta, typed piece resolver with LRU + localStorage caching.
- `src/components/`, `src/app/` — the interface ("Coronation Plate" design system,
  `docs/DESIGN.md`): black/white/pink, light + dark, retints to the loaded piece.
- `scripts/scan-alive.mjs` — the holder-scan snapshot builder.

Design and discovery documents live in `docs/`. Project facts and non-negotiables in
`CLAUDE.md`; the specialist agent definitions used to build this live in
`.claude/agents/`.
