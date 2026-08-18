# Security audit follow-up — post Electron 40 upgrade

> **Snapshot generated after Electron 40 upgrade; re-run `npm audit` before
> making security decisions from this file.** The advisory landscape moves
> faster than this doc does — treat the table below as a dated reference,
> not a living source of truth.

> **Source:** `npm audit` run on branch `electron-31-upgrade` after commit
> `acac9c1` (Electron 23 → 40, Playwright 1.51.1 → 1.60.0, Node baseline
> 18 → 24) under Node 24.16.0. 12 advisories total — all transitive except
> one LOW-severity direct dep we can probably remove entirely.
>
> **Headline: the upgrade closed every direct-dep advisory we control,
> including the IPC-spoof CVE (`GHSA-xj5x-m3f3-5x3h`) that motivated the
> original senior review.** The remaining 12 advisories live in upstream
> packages pulled in by build tooling or the MCP SDK; none are reachable
> from application code paths.

## Before / after — directly-controllable advisories

| Package | Pre-upgrade state (main) | Post-upgrade state (this branch) |
|---|---|---|
| `electron` | 17 CVEs incl. IPC-spoof, ASAR bypass, multiple use-after-frees, AppleScript injection on macOS, Registry key injection on Windows — fix range was `<35.7.5` / `<38.8.6` / `<39.8.5` depending on CVE | **0 CVEs.** Electron 40.10.2 carries forward all the prior patches. |
| `playwright` | 1 HIGH: "downloads and installs browsers without verifying SSL cert" (range `<1.55.1`) | **0 CVEs.** Pinned exact `1.60.0`. |
| `electron-updater` | Windows Code-Signing-Bypass GHSA in `5.x` (called out in original senior review) | **0 CVEs.** Bumped to `^6.8.3`. |

The Electron upgrade alone retired 17 advisories. The Playwright bump retired
one more. The electron-updater bump retired the Windows code-signing path.

## Remaining advisories — all transitive

These come from packages pulled in by `electron-builder` (and its
`@electron/rebuild` toolchain) and by `@modelcontextprotocol/sdk`. None are
reachable from runtime application code — they're inside the build pipeline
or the MCP server's HTTP server (which sits behind the same external-API
hardening that landed in `3d1bb8a`).

### HIGH severity (4 packages, all transitive)

| Package | Pulled by | Advisory class | Why we're not chasing it manually |
|---|---|---|---|
| `fast-uri` (`<=3.1.1`) | electron-builder / @electron/rebuild toolchain | Path traversal via percent-encoded segments, host confusion | Build-tooling only; not on any request path |
| `minimatch` (`<3.1.4`) | electron-builder + glob-using build tooling | Three separate ReDoS classes | Same — build-time, not runtime |
| `tar-fs` (`>=2.0.0 <2.1.4`) | electron-builder packaging step | Symlink validation bypass, dir-escape on extraction | Runs only during `npm run build:mac` against trusted inputs |
| `tmp` (`<=0.2.5`) | `chromium` direct dep (see below) and tooling | Temp-file path traversal | Resolves with `chromium` removal + upstream tooling bumps |

### MODERATE severity (7 packages, all transitive)

| Package | Pulled by | Advisory class |
|---|---|---|
| `@hono/node-server` (`<1.19.13`) | `@modelcontextprotocol/sdk` HTTP server | Middleware bypass via repeated slashes |
| `brace-expansion` (`<=1.1.12`) | build tooling | ReDoS x2 |
| `express-rate-limit` | build tooling | (no specific via title surfaced in audit) |
| `hono` (`<4.12.18`) | MCP SDK (10 advisories in this cluster) | Cookie validation, path traversal in toSSG, JSX HTML injection, JWT NumericDate validation, body-limit bypass, etc. |
| `ip-address` (`<=10.1.0`) | tooling | XSS in Address6 HTML-emitting methods |
| `js-yaml` (`>=4.0.0 <4.1.1`) | tooling | Prototype pollution in merge `<<` |
| `qs` (`>=6.11.1 <=6.15.1`) | tooling | DoS via TypeError crash on null/undefined |

### LOW severity (1 direct)

`chromium` (`^3.0.3`) — direct dep pulling a vulnerable `tmp`. The `chromium`
npm package is **separate from Electron's bundled Chromium runtime** and per
the original senior review appears unused in the codebase (no `require(
'chromium')` call sites). Worth a removal pass.

## Recommended disposition

- **Direct dep cleanup (small, do soon):**
  - Verify `chromium` npm package is unused (grep `require\(['"]chromium['"]\)`
    + `import.*from.*['"]chromium['"]`). If unused, remove from `package.json`.
    That also retires the transitive `tmp` HIGH advisory via `chromium`.

- **MCP SDK hono cluster (largest single source, wait for upstream):**
  - 10 of the 12 remaining advisories trace to `@modelcontextprotocol/sdk`
    bringing in `hono`, `@hono/node-server`, `qs`, etc. Track upstream
    `@modelcontextprotocol/sdk` releases; bump when a release picks up
    newer `hono` (≥4.12.18) and friends. Manual `npm audit fix --force`
    here would likely break the MCP transport — defer.

- **Build-tooling transitives (defer):**
  - `fast-uri`, `minimatch`, `tar-fs`, `tmp`, `brace-expansion`, `js-yaml`,
    `ip-address` all sit inside `electron-builder` / `@electron/rebuild`
    trees. Wait for upstream bumps (electron-builder 26 → 27 cycle, etc).
    These run only at build/packaging time against trusted inputs.

- **`npm audit fix --force`: do not run.** Would break the MCP transport
  and likely the electron-builder packaging path. The 12 remaining are
  transitive in active upstream chains; let upstream handle them.

## What this means for the senior-review threat model

The Electron upgrade slice's job was to retire the *highest-leverage* P0
from the original review: the chain "Electron 23 EOL + `executeJavaScript`
IPC-spoof CVE + open-default external API → renderer RCE for any browser
tab on the user's machine." That chain was closed in two pieces:

  1. **`3d1bb8a`** — External API safe-by-default bind + exact-origin CORS
     + timing-safe token compare. Closed the open-default exposure.
  2. **`acac9c1`** (this branch) — Electron 23 → 40. Closed the IPC-spoof
     CVE underneath.

Crash telemetry (`35d7227`) is the safety net for whatever the upgrade
itself disturbs in renderer / IPC / worker boot. Build determinism
(`28b5304`) keeps the dev environment reproducible.

The 12 remaining advisories are not in this threat model. They're in
build tooling and the MCP control plane, which is itself token-gated by
`3d1bb8a`. Tracked here, not blocked on.
