# Vendored frontend libraries

The renderer at `Connect.html` previously loaded React, ReactDOM, and Babel
from `unpkg.com` at runtime. The senior review flagged that as a renderer
supply-chain risk and an offline-first-launch failure mode. The CSP slice
moved them into `vendor/` so the renderer never reaches out to a third
party for executable code.

## Files currently vendored

| File | Source | SHA-384 (matches the original SRI hash) |
|---|---|---|
| `vendor/react.development.js` | `https://unpkg.com/react@18.3.1/umd/react.development.js` | `sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L` |
| `vendor/react-dom.development.js` | `https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js` | `sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm` |
| `vendor/babel.min.js` | `https://unpkg.com/@babel/standalone@7.29.0/babel.min.js` | `sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y` |

Total ~4.3 MB. Committed to the repo. `vendor/` is **not** gitignored —
treating it like other third-party content under our control.

## Re-vendoring (e.g. upgrading React to a new patch)

```sh
# Pick the new version + URL pattern.
NEW_VER="18.3.2"
NEW_URL="https://unpkg.com/react@${NEW_VER}/umd/react.development.js"
NEW_TARGET="vendor/react.development.js"

# Download.
curl -sSL "$NEW_URL" -o "$NEW_TARGET"

# Get the SHA-384 (base64) that matches the SRI hash format.
openssl dgst -sha384 -binary "$NEW_TARGET" | openssl base64 -A

# Manually update this doc's table with the new version + hash.
# (No code change needed in Connect.html — it loads vendor/ paths
# without integrity attributes since the file is local.)
```

The original integrity hashes (preserved in this doc above) provide a
breadcrumb: anyone re-running the SHA-384 against the current file in
`vendor/` should get the matching hash. If they don't, the file was
tampered with on disk.

## Why no SRI attribute on the `<script src="vendor/…">` tags

SRI is an enforcement mechanism for cross-origin script loads — the
browser refuses to execute a CDN file whose hash doesn't match. For
same-origin local files (which `vendor/…` is, served from `file://` in
the Electron renderer), the browser doesn't enforce SRI even if you
include the attribute. The integrity guarantee for the local copy is
provided by:

- Git's content-addressable blob storage (the file's git SHA matches
  what's committed)
- The CSP `script-src 'self'` directive (no other script source allowed)
- The re-vendoring procedure above, which verifies SHA-384 at vendor
  time

## CSP context

`Connect.html` carries a Content-Security-Policy meta tag. Relevant
directives for these vendored files:

```
script-src 'self' 'unsafe-eval';
```

`'self'` allows the local `vendor/…` paths. `'unsafe-eval'` is required
by `@babel/standalone` to run the in-browser JSX transform (Babel
compiles JSX strings into JS at runtime and executes them via
`Function(...)`). Removing `'unsafe-eval'` requires precompiling JSX →
JS at build time (Vite, esbuild, etc.) — that's a separate slice. Until
then, runtime Babel + `'unsafe-eval'` is the trade-off.

## Known follow-ups

- **Google Fonts still external.** `Connect.html` still loads
  `fonts.googleapis.com` (CSS) and `fonts.gstatic.com` (woff2 files) at
  runtime. CSP allows them explicitly. Vendoring the font files locally
  would make the app fully offline-launchable but adds ~1 MB of woff2
  binaries — deferred to its own slice.
- **Precompile JSX to remove `'unsafe-eval'`.** Bigger refactor. Would
  also retire `vendor/babel.min.js` (~3 MB of the ~4.3 MB total).
- **Production React build for shipped app.** The vendored React is
  `react.development.js` (dev mode, with warnings and dev-only checks).
  A shipped build should use `react.production.min.js` (~140 KB vs the
  current 1.4 MB combined). Switch when the renderer stabilizes.
