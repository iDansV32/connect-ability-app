# Native module ABI — the two-rebuild workflow

> **Required first run, every install:**
> ```sh
> npm install
> npm run rebuild:electron     # ← required before `npm start`
> ```
> The `npm start` script does **not** rebuild — that is intentional, to keep
> app launch fast. Without `rebuild:electron`, `npm start` will fail to load
> the native module. `npm test` rebuilds for Node automatically (it owns its
> own ABI switch). See "Asymmetry between test and start" below for why.

## Why there are two ABIs

`better-sqlite3` is a C++ Node addon compiled against a specific Node-engine
ABI ("MODULE_VERSION"). Three relevant runtimes here:

| Runtime              | MODULE_VERSION |
|----------------------|----------------|
| Node 24.x (pinned)   | 137            |
| Electron 40.x bundled Node | 125      |
| (Historical: Node 18) | 108           |
| (Historical: Electron 23) | 113       |

The Electron app runs against the Electron-bundled Node (125). `npm test`
runs under standalone Node (137 on the pinned baseline). **A binary built
for one will refuse to load in the other:**

```
NODE_MODULE_VERSION 125. This version of Node.js requires NODE_MODULE_VERSION 137.
```

That is the source of the historical ~108 failures the test suite carried
on `main` before the Electron upgrade. The two `rebuild:*` scripts let you
flip the binary to whichever ABI you need.

## The two scripts

```sh
npm run rebuild:electron   # → electron-builder install-app-deps
                           #   produces a 125-ABI binary for `npm start`
                           #   and the packaged app
npm run rebuild:node       # → npm rebuild better-sqlite3
                           #   produces a 137-ABI binary for `npm test`
```

Both work on the current toolchain (Node 24 + Electron 40 + Apple Clang 21).
Before the Electron 23 → 40 upgrade, neither did — see git history of this
file for the failure modes that motivated the upgrade.

## Asymmetry between `test` and `start`

`npm test` runs `rebuild:node` automatically, then runs the suite. Tests run
constantly during development; the rebuild has to be fast and invisible.

`npm start` does **not** run `rebuild:electron` automatically. App launch
runs occasionally; rebuild adds 30–60s to that path, which is painful when
you're iterating. Instead, you run `rebuild:electron` **once after install**
or **once after a branch switch that changed the install**, and then
`npm start` is fast every subsequent launch.

If you run `npm test` (which flips to Node ABI) and then `npm start`
(which expects Electron ABI), you'll have to re-run `rebuild:electron`
before `npm start` works again. That's the expected cost of switching
contexts.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npm start` errors with `Cannot find module .../better_sqlite3.node` or `ERR_DLOPEN_FAILED` | Binary is in Node ABI (or missing) | `npm run rebuild:electron` |
| `npm test` reports `NODE_MODULE_VERSION 125. This version of Node.js requires NODE_MODULE_VERSION 137` | The test rebuild script isn't running, or you're on a non-pinned Node | Check `node --version` matches `.nvmrc`. Run `npm test` again (it should rebuild). |
| Packaged `.app` crashes immediately on launch with `Cannot find module ... better_sqlite3.node` | `electron-builder install-app-deps` failed during `npm run build:mac` | Re-run `npm run rebuild:electron`, then `npm run build:mac` |
| `npm rebuild better-sqlite3` fails with `ModuleNotFoundError: No module named 'distutils'` | You're on Node 18 with Python 3.13 | `nvm use` to switch to the pinned Node 24 — Node 24 ships node-gyp that doesn't need distutils |
| C++ compile fails with `cast-function-type-mismatch` against V8 headers | You're on Electron 23 with current Apple Clang | This is what the Electron 40 upgrade fixed; ensure you're on Electron 40+ via `git log -1 -- package.json` |

## After a fresh clone

```sh
git clone <repo>
cd Connect
nvm use                       # picks up .nvmrc → Node 24.16.0
npm install                   # postinstall runs electron-builder install-app-deps;
                              # leaves better-sqlite3 in Electron ABI ready for `npm start`
npm run rebuild:electron      # belt-and-suspenders; usually a no-op after postinstall
                              # but ensures the binary is fresh for whatever Electron version
                              # is currently in package.json
npm start                     # ← should work now
```

If `npm test` is your first action instead of `npm start`, that's fine —
`npm test` will rebuild for Node first and the suite will run. After that,
to go back to running the app, do `npm run rebuild:electron && npm start`.

## Pinned baselines

- **Node**: `24.16.0` (`.nvmrc`) — Active LTS "Krypton" (Oct 2025 → Apr 2028).
- **Electron**: `^40.10.2` — current LTS line, supported through ~Q4 2026
  per Electron's "latest 3 stable majors" policy.
- **engines.node**: `>=24.0.0 <25.0.0` in `package.json`. Soft signal; npm
  warns but doesn't enforce by default.

## Why this doc exists

Before the Electron 40 upgrade, both rebuild paths were broken on a current
macOS toolchain (Python 3.13 had removed distutils; Apple Clang 21 was too
new for Electron 23's V8 headers). That meant the project relied on a
deployed-app binary that could be wiped by any `npm install`. The upgrade
closed both gaps. This doc is the steady-state record of the workflow
that's now achievable; the broken-rebuild history lives in git log of this
file.
