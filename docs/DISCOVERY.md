# Phase 0 discovery — verified findings

Four parallel investigations (chain-fetcher agents), plus three GitHub-Actions relay
probes that executed real `eth_call`s from an unrestricted runner. Everything below is
**measured, not assumed**.

## The contract architecture

| thing | value |
|---|---|
| $uPEG token (ERC-20) | `0x44b28991b167582f18ba0259e0173176ca125505` |
| Renderer (UpegHook / SvgGenerator) | `0xe54082dfbf044b6a8f584bdddb90a22d5613c440` |
| Verified source | Blockscout (solc 0.8.33); token 10 files, hook 50 files |
| Renderer function | `generate(uint256 seed) → string` — selector `0x4a7dd523`, raw SVG markup (not a data URI) |
| Metadata decoder | `getSeedData(uint256 seed) → UpegMetadata` (pure), 18 packed uint8 slots |
| `tokenURI` | exists in ABI but **always reverts** — confirmed on-chain; never use |

### Piece ids are global mint serials — not 1–10,000

`Upeg.sol` line 278: `uint upegId = ++_upegsTotalCount;` — ids come from an ever-increasing
mint counter and are never reused. Live reads at probe time:

- `UpegsTotalCount()` = **388,199** (= max id ever minted)
- `totalSupply() / UNIT_PER_UPEG()` = 10,000 → caps **alive** upegs
- `HoldersCount()` = 1,441; full holder scan found **6,922 alive pieces** (ids 28–388,199)

### There is no public id → seed accessor

`_upegs[id]` is private; all accessors are owner-scoped (`OwnerUpeg`, `OwnerUpegsPage`,
`Holder(i)`, …; errors `UpegIndexOutOfRange`, `NotUpegOwner`). Arbitrary id lookup
therefore needs a scan. We ran a **full holder scan on a GitHub Actions runner**
(1,441/1,441 holders, 0 failures, ~3 min) and shipped the result as
`public/data/upeg-alive.json` (id → seed, 6,922 entries). Burned/pooled ids have their
seeds deleted on-chain, so **the alive set is exactly the renderable set**.

### The SVG shape

`viewBox='0 0 24 24'`, single-quoted attributes, a full-bleed background
`<rect x='0' y='0' width='24' height='24'/>` first, then greedy-merged pixel-run rects
per layer. No groups, paths, styles, or `shape-rendering`. 2–7 distinct fills per piece.
Layer paint order: background, body, horn, accessories, wings, hair, tail, legsFront,
legsBack, ground, eyes. Wings + both leg layers reuse `bodyColor`.

### The renderer was ported to TypeScript, byte-exactly

The layer bitmaps live in contract **storage** (set post-deploy), not in source. We
extracted all 91 variants by calling `generate()` with single-layer probe seeds
(`variant << slotOffset`) and parsing the rects. The TS port
(`src/lib/upeg/renderer.ts`) reproduces the on-chain string **byte-for-byte on 16/16
real fixtures** — locked in by unit tests. Palettes (36 colours + 6 backgrounds) copied
verbatim from verified source.

## RPC CORS (measured from an unrestricted runner, browser-style preflight + POST)

| RPC | preflight | POST ACAO | chainId | latency | verdict |
|---|---|---|---|---|---|
| `ethereum-rpc.publicnode.com` | 204, `*` | `*` | 0x1 | 151 ms | ✅ primary |
| `eth.drpc.org` | 204, origin-echo | `*` | 0x1 | 150 ms | ✅ secondary |
| `eth.llamarpc.com` | 403 | — | — | — | ❌ |
| `1rpc.io/eth` | timeout | — | — | — | ❌ |

The app uses viem `fallback([publicnode, drpc])`, fully client-side — no backend needed.

## upeglens.art

`/data/upegs_full.json` on the origin returns 404 — the live site loads its dataset
through a Cloudflare Worker (`DATA_BASE`), and its own source notes the upstream has
**no CORS header**. Since our holder-scan snapshot + verified renderer port cover
everything the dump would give us (and more — we have seeds), **we dropped upeglens as a
source entirely**: better data, zero load on a community project's bandwidth.

## OpenSea

All OpenSea hosts are unreachable from the build sandbox, and the `unipegv4` slug could
not be verified. Multiple `unipegv4.*` domains appear in phishing blocklists (do not
confuse them with the OpenSea slug). With the on-chain path solved client-side, the
raster fallback adds risk and no value — **dropped**. Manual upload/paste remains the
universal fallback (recovery path).

## Final source ranking (implemented)

1. **On-chain**: id → seed via bundled snapshot, seed → SVG via `generate()` eth_call —
   provenance `ON-CHAIN SVG`.
2. **Local verified port**: same seed rendered by the byte-exact TS port when the RPC is
   unreachable — provenance `LOCAL RENDER · VERIFIED PORT`.
3. **Upload / paste** → `imageToGrid` recovery — provenance `RECOVERED FROM IMAGE`.

## Sandbox note

The build environment's egress proxy blocks every RPC/explorer host, upeglens.art and
OpenSea (only GitHub + package registries allowed). All chain interaction during the
build ran through a temporary `chain-probe` branch whose GitHub Actions workflow executed
the calls on a runner and committed results back. The branch is scratch infrastructure
and can be deleted once the build is merged.
