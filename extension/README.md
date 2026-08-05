# unipegPFP — Offline Unipeg

A Chrome extension that puts your Unipeg where you'll actually see it: on every new
tab, and on the page Chrome shows you when the internet drops. Both come with a
runner game.

It works with the network completely off. That is the whole point.

## What it does

**New tab takeover.** `chrome_url_overrides.newtab` points at `pages/newtab.html`, so
every new tab is your piece: the number in the masthead, the artwork on a plate, and a
board you can play on.

**Offline redirect.** The service worker watches for failed top-level navigations. When
the failure is a genuine connectivity error it sends that tab to `pages/offline.html`,
which says you're offline, names the host that couldn't be reached, offers a **Retry**
that goes back to the exact URL you asked for, and gives you the same runner to play
while you wait.

Both pages are the same page. Only the header block differs.

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
any zoom or device pixel ratio.

## Install it unpacked

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Open a new tab. On first run it asks you to pick a piece — type a number or take the
   mascot, `#185206`.

To test the offline redirect: turn off wi-fi (or use DevTools → Network → Offline) and
navigate to any site.

## Permissions, and why each one is here

| Permission | Why |
|---|---|
| `webNavigation` | The only way to learn that a navigation failed *and why*. `chrome.webNavigation.onErrorOccurred` hands us the net error string; without it there is no signal to act on. |
| `storage` | Holds your piece number, your best run and the new-tab toggle in `chrome.storage.local`. Local only — nothing is synced or sent anywhere. |

**No `host_permissions`, no `tabs`, no content scripts, no remote code.**
`chrome.tabs.update()` and `chrome.tabs.create()` both work without the `tabs`
permission when the extension is only *sending* a tab somewhere rather than reading its
contents, which is all we do. The extension never reads page content, never sees your
browsing history, and makes no network requests of any kind.

### What the redirect will and won't touch

The service worker acts only on `frameId === 0` (top-level navigations), only on
`http:`/`https:` URLs, and only on an explicit allowlist of connectivity errors:

```
net::ERR_INTERNET_DISCONNECTED
net::ERR_NAME_NOT_RESOLVED
net::ERR_NETWORK_CHANGED
net::ERR_ADDRESS_UNREACHABLE
net::ERR_CONNECTION_TIMED_OUT
```

Everything else is left to Chrome: 404s and other HTTP statuses (those are successful
navigations anyway), certificate and HTTPS errors, `ERR_CONNECTION_REFUSED` /
`ERR_CONNECTION_RESET` (the server is reachable and saying no), safe-browsing
interstitials, enterprise-blocked pages, and `ERR_ABORTED`. Hiding any of those would
hide real information. A per-tab cooldown stops redirect loops.

One known rough edge: `ERR_NAME_NOT_RESOLVED` also fires when you simply mistype a
domain while online. You'll land on our page with the mistyped host shown; **Retry**
takes you back to it. It's on the list because on a dropped connection it is by far the
most common error Chrome reports.

## The new-tab toggle

`upegpfp.newtabEnabled` (Settings on the page, or the toolbar popup) turns the takeover
off. **Chrome does not let an extension release the new tab page at runtime** — the
override is declared in the manifest and only lifts when the extension is disabled or
removed. So the toggle is honoured *in* the page: switch it off and new tabs show a
minimal "Unipeg new tab is off" card with a button to turn it back on. To get Chrome's
own new tab back, disable or remove the extension from `chrome://extensions`.

## Storage keys

| Key | Type | Meaning |
|---|---|---|
| `upegpfp.pieceId` | number | Your piece. Ids are global mint serials, validated 1–400000. |
| `upegpfp.highScore` | number | Best run. |
| `upegpfp.newtabEnabled` | boolean | New tab takeover, default `true`. |

## Files

```
manifest.json      MV3 manifest
background.js      service worker — the offline redirect and nothing else
pages/newtab.html  new tab entry     ─┐ same page, different header
pages/offline.html offline entry     ─┘
pages/page.js      shared page script (piece, game, settings)
pages/page.css     shared styles
popup.html/.js     toolbar popup — piece, toggle, best run, play
lib/upeg.js        seed → 24×24 grid, bundled snapshot lookup
lib/sprite.js      run frames, background keyed out, grid drawing
lib/game.js        the endless runner
data/              layer rectangles + id → seed snapshot
icons/             16/48/128, rendered from piece #185206
```

There is **no build step**. The extension loads unpacked exactly as it sits: plain ES
modules, no npm dependencies, no bundler, no minifier. Edit a file, hit reload on
`chrome://extensions`.

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
   navigations in order to show our own offline page*.
6. **Submit for review.** New extensions typically clear review in **a few days**;
   anything touching `webNavigation` can take longer. Pick "publish immediately on
   approval" or hold it and publish by hand.
7. **Updates** bump `version` in `manifest.json` and go through the same upload and
   review.

## Not affiliated

unipegPFP is a community tool. Unipeg (`$uPEG`) is an ERC-20 on Ethereum mainnet at
`0x44b28991b167582f18ba0259e0173176ca125505`; the art is rendered on-chain as SVG from a
24×24 grid, and this extension renders it from a verified byte-for-byte port of that
renderer.
