# upegRUN — Offline Unipeg

A Chrome extension that puts your Unipeg where you'll actually see it: on every new
tab, and on the page Chrome shows you when the internet drops. Both come with a
runner game.

It works with the network completely off. That is the whole point.

## What it does

**New tab takeover.** `chrome_url_overrides.newtab` points at `pages/newtab.html`, so
every new tab is your piece: the artwork on a plate, a Google search bar beside it, and a
board you can play on.

**Offline redirect.** The service worker watches for failed top-level navigations. When
the failure genuinely means "this machine has no network" it sends that tab to
`pages/offline.html`, which says you're offline, names the host that couldn't be reached,
offers a **Retry** that goes back to the exact URL you asked for, and gives you the same
runner to play while you wait. What counts as "genuinely" is
[two-tier](#which-errors-get-redirected-and-which-dont) and deliberately strict.

Both pages are the same page. Only the header block differs.

## Setup, and locking in

First run shows a setup panel instead of the board:

1. **Type a piece number.** The unicorn appears as you type — a live 24×24 render on a
   plate beside the input, with its number under it. **Try #185206** fills in the mascot
   if you just want to look at something.
2. **Lock in.** That writes `upegpfp.pieceId` and sets `upegpfp.pieceLocked = true`.

Once locked, every new tab and every offline page boots straight into that piece with no
prompt, forever, until you say otherwise. **Change peg** — in the page footer, and in the
toolbar popup — clears the lock and brings the setup panel back with your current number
prefilled, so you can preview a different one before committing to it.

The setup copy makes a promise, and it is a real one: **once a piece is locked in it
renders with the network completely off.** The id → seed snapshot and the renderer are
both bundled, so the artwork is computed locally from 363 KB of data that shipped with
the extension. Nothing is fetched to draw it — not on first run, not ever.

Validation matches the site: integers only, 1 to 400000, and the piece has to be alive.
The voice matches too — `UpegIndexOutOfRange — ids run 1 to 400000`, or `#42 — MINTED,
NOT ALIVE. Its tokens returned to the pool.` Wrong numbers get an explanation, not a red
box.

### Pieces minted after this build

The bundled snapshot has exactly one blind spot, and it's worth naming: a piece minted
*after* the extension was packaged is not in it, and no local cleverness can invent its
seed. That is the only thing in this extension that the network can affect, and it is
handled honestly rather than papered over:

- **Offline:** `#412001 — not in the offline collection yet. Connect once to fetch it.`
  No spinner, no retry loop, no pretending.
- **Online:** a **Fetch it once** button appears. It asks for the optional `upegpfp.art`
  permission, pulls `https://upegpfp.art/data/upeg-alive.json` once (8-second ceiling,
  never blocking), caches the ids the bundle doesn't have in `chrome.storage.local`, and
  retries the lookup. From then on that piece renders offline like any other.
- **Declined, or the host doesn't answer:** you're told so plainly and the bundled
  collection is untouched. Nothing breaks.

The fetch is only ever attempted from a click, never from a keystroke — an optional
permission needs a user gesture, and typing a number should not open a socket.

## The honest note about Chrome's dinosaur

**Chrome's built-in offline page cannot be modified by an extension, and this one does
not pretend otherwise.** The dino page lives on `chrome://` — hard-blocked to
extensions: no content scripts, no scripting injection, no `chrome://` host permission
at any price. Nothing published anywhere gets around that; anything claiming to "replace
the dino game" is doing what this does.

So this extension does the two things that genuinely work, and ships both:

1. It reaches the failed navigation *before* Chrome's error page settles and sends the
   tab to a page we do control.
2. It owns the new tab outright, which no other surface contests.

The cost of approach 1 is honest and worth naming: your tab ends up on a different URL
than the one that failed, so Chrome's own reload no longer points at your destination.
That's why **Retry** is the first control on the page and carries the original URL
(`?from=`) — one click and you're back to what you asked for. When the machine comes
back online the button says so, but it never navigates on its own; nobody should get
yanked out of a run.

## How the offline rendering works

There is **no network dependency in the render path at all** — no RPC, no API, no image
CDN, no fonts. The extension bundles:

- the on-chain SVG renderer, ported to plain JavaScript (`lib/upeg.js`),
- every layer's rectangles, straight from the contract (`data/layers.js`),
- an id → seed snapshot of all 6,913 alive pieces (`data/upeg-alive.json`, ~363 KB).

A piece is drawn by decoding its seed into a 24×24 colour grid and painting it cell by
cell. All geometry is integer cells scaled by an integer factor, and
`imageSmoothingEnabled` is `false` on every canvas context, so the pixels stay pixels at
any zoom or device pixel ratio. That holds for the setup preview too: it is the same
renderer at the same integer scale, so what you see while choosing is exactly what you
lock in.

The [optional fetch](#pieces-minted-after-this-build) is a *lookup*, not a render: it can
only tell us the seed of a piece minted after this build. Once a seed is known — from the
bundle or from that one fetch — drawing it never touches the network again.

## The look: light, and committed to it

**The pages are white.** Not "white by default" — there is no theme toggle and no
`prefers-color-scheme` branch. The new tab, the offline page, the popup and the
standalone playable build all commit to light the same way an earlier round committed to
dark, which puts them alongside Chrome's own offline page and the website's light mode.

The tokens are `docs/DESIGN.md`'s **light** column, set once on `:root` in
`pages/page.css` and mirrored as the `PALETTE` object `pages/page.js` hands to
`startGame`, so the board paints on the same ground as the page around it:

| token | value | note |
|---|---|---|
| `--paper` | `#FFFFFF` | page + board ground |
| `--ink` | `#0B0B0D` | 19.66:1 on paper |
| `--pink` | `#D8006E` | 5.07:1 on paper — the light-mode pink. The dark-mode `#FF4DA1` is 3.08:1 on white and is not used here. |
| `--mute` | `#66666E` | 5.69:1 on paper, 5.14:1 on card |
| `--card` | `#F4F3F5` | plates, panels, the stage |
| `--line` | `#E7E4E7` | **1.26:1 — hairline separators only.** Never text, never a control edge. |

Two rules follow from that table and are worth keeping:

- **Control borders are `--mute`, not `--line`.** A `#E7E4E7` pill on white is invisible.
  Buttons, inputs, the toggle glyph and the settings dialog all take the mute edge; card
  surfaces take the line hairline, because there a 1.26:1 edge is exactly enough.
- **Nothing signals state with `opacity`.** A faded pill on white is a grey ghost. The
  disabled **Lock in** button restyles with real tokens instead.

If you change a colour, change it in `pages/page.css`, in the `PALETTE` object in
`pages/page.js`, and in `tools/build-playable.mjs` — the standalone page carries its own
copy of both so it stays a faithful preview of the extension.

## Install it unpacked

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Open a new tab. On first run you get the setup panel — type a number, watch it render,
   hit **Lock in**. Or take the mascot, `#185206`.

To test the offline redirect: turn off wi-fi (or use DevTools → Network → Offline) and
navigate to any site. To confirm it stays out of the way, mistype a domain *while online*
— you should get Chrome's own DNS error, untouched.

## Permissions, and why each one is here

| Permission | Why |
|---|---|
| `webNavigation` | The only way to learn that a navigation failed *and why*. `chrome.webNavigation.onErrorOccurred` hands us the net error string; without it there is no signal to act on. |
| `storage` | Holds your piece number, the lock, your best run and the new-tab toggle in `chrome.storage.local`. Local only — nothing is synced or sent anywhere. |

**Optional, requested only at the moment of need:**

| Optional permission | Why, and why it isn't mandatory |
|---|---|
| `https://upegpfp.art/*` | The one case the bundle cannot cover: a piece minted after this build was packaged. Asked for only when you type such an id and click **Fetch it once**, used for a single GET of `data/upeg-alive.json`, then cached locally. It is in `optional_host_permissions`, not `host_permissions`, so **the extension installs with nothing but `webNavigation` + `storage`** and shows no host-access warning. Decline it and every bundled piece still works exactly as before — you simply keep the collection you shipped with. |

**No mandatory `host_permissions`, no `tabs`, no content scripts, no remote code.**
`chrome.tabs.update()` and `chrome.tabs.create()` both work without the `tabs`
permission when the extension is only *sending* a tab somewhere rather than reading its
contents, which is all we do. The extension never reads page content and never sees your
browsing history. Apart from the optional, user-triggered fetch above, it makes no
network requests of any kind — and none at all on the render path.

### Which errors get redirected, and which don't

The service worker acts only on `frameId === 0` (top-level navigations), only on
`http:`/`https:` URLs, and only on an explicit allowlist — split in two, because the net
errors themselves are not equally trustworthy.

**Tier 1 — unconditional.** These can only mean the machine has no network:

```
net::ERR_INTERNET_DISCONNECTED
net::ERR_NETWORK_IO_SUSPENDED
```

**Tier 2 — only when `navigator.onLine === false` in the service worker.** These fire on
a dropped connection *and* on a perfectly good one:

```
net::ERR_NAME_NOT_RESOLVED
net::ERR_NETWORK_CHANGED
net::ERR_ADDRESS_UNREACHABLE
net::ERR_CONNECTION_TIMED_OUT
```

**Why the split.** `ERR_NAME_NOT_RESOLVED` is what a dropped connection usually looks
like — and it is also what a typo looks like. Redirecting it unconditionally meant that
mistyping a domain on a working connection replaced Chrome's accurate DNS error with a
page whose headline said *"You're offline"*. That headline was simply false, and it hid
the one piece of information the user needed. A page that lies about the state of your
machine is worse than no page, so tier 2 now requires the browser itself to agree.

`navigator.onLine` is the right test here in spite of its reputation. Its known weakness
is false *positives* — it reports `true` behind a captive portal — and a false positive
costs us nothing: we leave Chrome's error page alone, which is the honest outcome anyway.
It has no false negatives. If it says `false`, there is no network interface to speak of.

Everything outside both tiers is left to Chrome: 404s and other HTTP statuses (those are
successful navigations anyway), certificate and HTTPS errors, `ERR_CONNECTION_REFUSED` /
`ERR_CONNECTION_RESET` (the server is reachable and saying no), safe-browsing
interstitials, enterprise-blocked pages, and `ERR_ABORTED`. Hiding any of those would
hide real information. A per-tab cooldown stops redirect loops.

The decision lives in one pure function, `shouldRedirect(error, online)` in
`background.js`, and is covered by `lib/__tests__/background.test.ts`.

## The new-tab toggle

`upegpfp.newtabEnabled` (Settings on the page, or the toolbar popup) turns the takeover
off. **Chrome does not let an extension release the new tab page at runtime** — the
override is declared in the manifest and only lifts when the extension is disabled or
removed. So the toggle is honoured *in* the page: switch it off and new tabs show a
minimal "Unipeg new tab is off" card with a button to turn it back on. To get Chrome's
own new tab back, disable or remove the extension from `chrome://extensions`.

## Storage keys

They are still prefixed `upegpfp.`, and they stay that way. The extension was renamed to
**upegRUN** after the first builds shipped; renaming the keys would silently un-lock every
piece someone had already chosen. A prefix is not a brand.

| Key | Type | Meaning |
|---|---|---|
| `upegpfp.pieceId` | number | Your piece. Ids are global mint serials, validated 1–400000. |
| `upegpfp.pieceLocked` | boolean | Set by **Lock in**. While `true` the pages boot straight into the piece; **Change peg** sets it `false` and setup returns. A piece saved before this key existed counts as locked — nobody is asked to set up a thing they already set up. |
| `upegpfp.aliveExtra` | object | id → seed for pieces fetched from `upegpfp.art` that the bundled snapshot predates. Stored as a diff, not a second copy — usually empty. |
| `upegpfp.highScore` | number | Best run. |
| `upegpfp.newtabEnabled` | boolean | New tab takeover, default `true`. |

## Files

```
manifest.json      MV3 manifest
background.js      service worker — the offline redirect and nothing else
pages/newtab.html  new tab entry     ─┐ same page, different header
pages/offline.html offline entry     ─┘
pages/page.js      shared page script (setup, piece, game, settings)
pages/resolve.js   piece lookup: bundle → cache → optional one-off fetch
pages/page.css     shared styles
popup.html/.js     toolbar popup — piece, toggle, best run, play, change peg
lib/upeg.js        seed → 24×24 grid, bundled snapshot lookup
lib/sprite.js      run frames, background keyed out, grid drawing
lib/game.js        the endless runner
data/              layer rectangles + id → seed snapshot
icons/             16/48/128, rendered from piece #185206
```

There is **no build step**. The extension loads unpacked exactly as it sits: plain ES
modules, no npm dependencies, no bundler, no minifier. Edit a file, hit reload on
`chrome://extensions`.

## The new tab's search bar

A new tab is a place people type into, so the search bar is where the giant piece number
used to be; the number moved down into the line under it, at reading size.

- **New tab only.** `pages/offline.html` ships no `#searchForm` at all, so the code that
  wires it is a no-op there by construction. A search box that cannot reach anything is
  worse than no search box.
- **It is a plain form**: `<form action="https://www.google.com/search" method="get">`
  with an `q` input. It submits correctly with `page.js` never loaded. The script only
  adds the two things markup cannot: refusing an empty query, and going quiet with a
  "No connection" placeholder while `navigator.onLine` is `false`.
- **It never takes focus.** A new tab hands the keyboard to the omnibox; autofocusing
  here would mean your first space bar types a space instead of jumping. Click the board
  (or press <kbd>Esc</kbd> in the field) and the game has the keyboard back.
- **Typing never drives the game.** Both `page.js` and `lib/game.js` ignore key events
  whose target is an `input`, so <kbd>Space</kbd> in the search field is a space.

## The obstacles

The marks are Ethereum's octahedron drawn on the cell grid, at the runner's own integer
scale, in **one flat `#3C3C3D`** — both faces of the solid are the same grey, so the
silhouette carries the shape — with **`#627EEA` down the one-cell centre seam** and
nowhere else. Grey outruns blue better than 3:1 in every size.

They used to be sampled from the piece's own palette, three facets per mark. It looked
good and read wrong: a red piece threw red diamonds, and the obstacle stopped saying
"Ethereum" and started saying "stray bit of unicorn".

Both colours are still passed through the contrast pass before they are drawn, so a page
that hands the game a board they would sink into gets them lifted. On the white board
these pages actually ship, neither moves.

## Accessibility and motion

- Every control is keyboard reachable, with square-cornered focus rings.
- The board is focusable; Space and ↑ jump, and page scroll is suppressed while playing.
- `prefers-reduced-motion` is respected: the idle animation stops, the game stays fully
  playable.
- Touch targets are at least 44px; the layout works down to phone widths.

## Publishing to the Chrome Web Store

1. **Register as a developer.** Go to the [Chrome Web Store Developer
   Dashboard](https://chrome.google.com/webstore/devconsole) and pay the **one-time $5
   registration fee**. It's per account, not per extension.
2. **Zip the folder.** Zip the *contents* of `extension/` so `manifest.json` sits at the
   root of the archive, not inside a nested folder:
   ```
   cd extension && zip -r ../unipegpfp-offline-1.0.0.zip . -x '**/__tests__/*' '**/.DS_Store'
   ```
3. **Create the item** in the dashboard and upload the zip.
4. **Fill in the listing.** Name, description, category (Fun or Productivity), at least
   one 1280×800 or 640×400 screenshot, a 128×128 icon (already in `icons/`), and a
   privacy policy URL if you declare any data collection — this extension collects
   none, so declare that.
5. **Justify the permissions.** The dashboard asks for a written reason for each one and
   for the single purpose of the extension. The Permissions table above is the answer;
   `webNavigation` is the one reviewers look at, so be specific: *detect failed
   navigations in order to show our own offline page*. For the optional
   `https://upegpfp.art/*` host: *fetch the id → artwork map once, at the user's explicit
   request, for pieces minted after the bundled snapshot was built; optional because the
   extension is fully functional without it*.
6. **Submit for review.** New extensions typically clear review in **a few days**;
   anything touching `webNavigation` can take longer. Pick "publish immediately on
   approval" or hold it and publish by hand.
7. **Updates** bump `version` in `manifest.json` and go through the same upload and
   review.

## Not affiliated

upegRUN is a community tool. Unipeg (`$uPEG`) is an ERC-20 on Ethereum mainnet at
`0x44b28991b167582f18ba0259e0173176ca125505`; the art is rendered on-chain as SVG from a
24×24 grid, and this extension renders it from a verified byte-for-byte port of that
renderer.
