# Connect-Ability

Electron + React desktop app for multi-account LinkedIn automation with
persona-driven SDR agents, durable workflow scheduling, and stealth
fingerprinting.

> **Status:** private, developer-test only. No signed installers yet — clone
> the repo and run from source.

## Quick start

Requires **Node 20 LTS**. Works on macOS, Windows (10/11), and Linux.

Node 18 is not recommended for this repo because `better-sqlite3@12.x`
declares Node 20+ support and native module ABI mismatches are otherwise easy
to trigger.

```bash
git clone <repo-url> connect-ability
cd connect-ability
npm install
npx playwright install chromium
cp .env.example .env   # fill in optional values; see below
npm start
```

The Electron window opens against `Connect.html`. First run will be empty —
add a LinkedIn account under **Settings → LinkedIn accounts**, then create
an agent under **SDR Agents**.

### `.env`

The app prefers credentials saved through the UI (stored in the OS
credential vault via `keytar`). The `.env` file is only a fallback. See
[`.env.example`](.env.example) for the supported keys. **Never commit `.env`.**

## Project layout

```
main.js                          Electron main process + IPC
preload.js                       Renderer ↔ main bridge
Connect.html                     React SPA entry (Babel-in-browser)
src/                             React UI (cockpit, inbox, workflows, prospects, posts, agents, settings)
automation/                      Stealth LinkedIn automation (search, messaging, posting, profile extract, runtime worker)
storage/                         Repositories + SQLite scaffold
personas/<agentId>/              Per-agent persona markdown (soul, personality, writing-style, boundaries) — created at runtime, not in a fresh clone
scripts/                         One-off CLI scripts (search-screenshot-like, schedule-post, connect-profiles)
tests/                           Offline unit tests
tests-live/                      LinkedIn-touching integration tests (require live credentials)
```

A fresh clone starts empty by design — no agents, no personas, no prospects, no
LinkedIn accounts, no credentials, and zeroed dashboard metrics. You create all of
it from the app on first run.

App-state lives outside the repo:
- macOS: `~/Library/Application Support/Connect Ability/`
- Windows: `%APPDATA%\Connect Ability\`
- Linux: `~/.local/state/Connect Ability/`

That directory holds `linkedin-accounts.json`, `sdr-agents.json`,
`workflow-runs.json`, `prospect-queue.json`, `inbox.json`,
`scheduled-posts.json`, `sessions/`, `profile-screenshots/`, and friends.

The one exception is `personas/`, which the app writes inside the app directory
rather than app-state. It is gitignored for that reason.

## Native dependencies — heads up

Two native modules need to compile correctly for your platform on
`npm install`:

| Module | What breaks if it fails |
|---|---|
| `keytar` | Saving / loading LinkedIn passwords. Fatal at module load if the binding is missing. |
| `better-sqlite3` | Faster workflow / activity storage. Non-fatal — the app silently falls back to JSON files when the binding is missing. |

If the app shows ABI / `NODE_MODULE_VERSION` errors after install, rebuild the
native modules for Electron:

```bash
npm run postinstall    # invokes electron-builder install-app-deps
```

If plain Node-based tests show ABI errors, rebuild for your local Node runtime:

```bash
npm rebuild better-sqlite3
```

That can conflict with Electron's ABI, so for app testing prefer
`npm run postinstall` after changing Node versions or reinstalling modules.

**Windows builders:** install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (Desktop C++ workload) before `npm install` so node-gyp can compile the C++ bindings.

**Linux builders:** `keytar` needs `libsecret-1-dev`:
```bash
sudo apt-get install -y libsecret-1-dev
```

## Playwright

`npx playwright install chromium` downloads the OS-appropriate Chromium
build (~150 MB). The worker process launches this Chromium directly — there
is no auto-install on first app run yet, so this step is **required** when
running from source.

## Scripts

```bash
npm start              # dev: launches Electron against the source tree
npm test               # offline test suite (currently has known better-sqlite3 ABI failures)
npm run build:mac      # build a macOS .app / .dmg
npm run build:win      # build a Windows installer (must run on Windows)
npm run build:linux    # build a Linux AppImage / deb
npm run mcp:server     # run the standalone MCP server for the Slack/OpenClaw integrations
```

> Cross-compiling a Windows installer from macOS won't produce working
> native bindings — run `build:win` on a real Windows machine (or a Windows
> GitHub Actions runner).

## Known issues

- **`better-sqlite3` ABI mismatch on dev machines.** Depending on whether
  `node_modules` was last rebuilt for Electron or for plain Node, you may see
  `NODE_MODULE_VERSION` errors. JSON fallback works for app use; rebuild with
  `npm run postinstall` for Electron or `npm rebuild better-sqlite3` for
  plain Node tests.
- **Test suite has known failures** tied to the same SQLite ABI mismatch when
  `better-sqlite3` is compiled for Electron instead of the local Node test
  runner. Unit tests not touching SQLite still pass.
- **`scripts/search-screenshot-like.js`** has a hardcoded macOS session path
  at the top — fine for the maintainer, broken for others. Rewrite using
  `getLinkedInSessionStatePath(email)` from `automation/core/session-state.js`
  if you need it on Windows / Linux.

## License / Distribution

Private. Do not share builds or credentials.
