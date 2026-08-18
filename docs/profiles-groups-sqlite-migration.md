# Profiles + Groups → SQLite migration (design)

> **Status:** Design only. No code changes. No `main` behavior changes.
> Implementation phases (A → E) are branched + PR'd separately.
>
> **Roadmap:** This is item #7 from the substrate work that landed earlier
> in the same arc as crash telemetry (`35d7227`), external API hardening
> (`3d1bb8a`), build determinism (`28b5304`), Electron 40 upgrade (PR #1),
> atomic JSON writes (`19c8ae7` + `b0ffe10`), CSP + vendor React/Babel
> (`58e5a8f`), and SQLite workflow performance (`132a09e`). Those closed
> the immediate reliability/security gaps. #7 is architecture maturation,
> not "stop the bleeding."

## 1. Current state

### 1a. `profiles.json`

Flat JSON array, ~200+ records typical. 17 distinct fields observed in the
real-world store on this machine:

| Field | Presence | Notes |
|---|---|---|
| `url`, `originalUrl`, `linkedInProfileUrl` | universal | Three URL fields per record — historical inconsistency. `url-utils.js` normalizes for joins. |
| `fullName`, `firstName`, `lastName` | universal | Identity |
| `title`, `rawHeadline`, `company` | universal | Identity, frequently stale (the prospect-overlay was added precisely to mask this) |
| `companyDomain`, `email`, `suggestedEmails` | partial | Contact enrichment; `email` universal, others ~60% coverage |
| `firstInteraction`, `lastInteraction` | universal | Timestamps |
| `actions` | universal | **Nested array** — per-profile log of `{ type, timestamp, notes, searchQuery }` |
| `accountId`, `accountName` | partial | Account-scoping added later; older records lack it |

**Writes:** 4 sites in `main.js` + `automation/profile/storage.js` (all atomic
post-#4). Whole-file rewrite per write.
**Reads:** 8+ IPC handlers full-read `profiles.json` on every call. Overlay
(`prospect-overlay.js`) joins with SQLite prospects at read time for
identity correction.

### 1b. `groups.json`

Flat JSON array, small (typically <20 records). 7 fields:

- `id`, `name`, `description`, `color`, `createdAt`, `updatedAt`
- `members`: **list of bare LinkedIn URL strings**, no nested objects in
  current data — but `group-member-enrichment.js` tolerantly accepts
  `{ url, name }` object members from older code paths.

**Writes:** Triple-write to 3 paths (`Documents/Connect-Ability/groups.json`
\+ `standalone-groups.json` + `userData/groups.json`). Atomic per-file
post-#4 but cross-path is not transactional.
**Reads:** `get-groups-data` IPC reads all 3 paths and merges.
`group-member-enrichment.js` joins members against the enriched profile
list at read time.

### 1c. Already-SQLite-backed identity store: `prospects`

The `prospects` table in `storage/schema.js` is the de facto identity
store of truth post-Q1. Per the senior review and the existing
`prospect-overlay.js`, **SQLite prospects already wins over `profiles.json`
on every shared field** (`fullName` / `title` / `headline` / `company`).
The overlay is a read-time bandage; the write paths still go to
`profiles.json`.

**Key architectural insight:** `profiles.json` is largely duplicative of
`prospects`. The migration isn't "profiles → SQLite" — it's "**profiles →
consolidate into existing `prospects` table, plus new tables for the
parts `prospects` doesn't cover** (actions log, contact enrichment, and
groups)."

## 2. Proposed schema

### 2a. Extend `prospects` table (don't create a parallel "profiles" table)

```sql
ALTER TABLE prospects ADD COLUMN first_name             TEXT;
ALTER TABLE prospects ADD COLUMN last_name              TEXT;
ALTER TABLE prospects ADD COLUMN raw_headline           TEXT;  -- pre-cleaning, debug
ALTER TABLE prospects ADD COLUMN company_domain         TEXT;
ALTER TABLE prospects ADD COLUMN primary_email          TEXT;
ALTER TABLE prospects ADD COLUMN suggested_emails_json  TEXT;  -- JSON array; rare list, 1–3 entries typical
ALTER TABLE prospects ADD COLUMN first_interaction_at   TEXT;
ALTER TABLE prospects ADD COLUMN last_interaction_at    TEXT;
ALTER TABLE prospects ADD COLUMN normalized_profile_url TEXT;
CREATE INDEX IF NOT EXISTS idx_prospects_normalized_url
  ON prospects(normalized_profile_url);
```

Existing prospect fields already cover: `profile_url`, `full_name`,
`headline` (= title), `company`, `account_id`.

The **`normalized_profile_url`** column is the critical join key. It's the
output of the runtime `normalizeUrl` helper (strip protocol/query/trailing
slash, lowercase). All future joins go through this column; the raw
`profile_url` is preserved as written.

### 2b. New table: `profile_actions`

Replaces the nested `actions: [...]` array.

```sql
CREATE TABLE IF NOT EXISTS profile_actions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id            TEXT    NOT NULL REFERENCES prospects(id),
  normalized_profile_url TEXT    NOT NULL,                   -- denormalized for fast lookup
  action_type            TEXT    NOT NULL,                   -- 'Profile Viewed', 'Post Liked', etc.
  occurred_at            TEXT    NOT NULL,
  notes                  TEXT,
  search_query           TEXT,
  account_id             TEXT,
  legacy_dedupe_key      TEXT,                               -- non-NULL only for rows imported from JSON
  created_at             TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_actions_prospect
  ON profile_actions(prospect_id);
CREATE INDEX IF NOT EXISTS idx_profile_actions_occurred
  ON profile_actions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_profile_actions_normalized_url
  ON profile_actions(normalized_profile_url);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_actions_legacy_dedupe
  ON profile_actions(legacy_dedupe_key)
  WHERE legacy_dedupe_key IS NOT NULL;
```

Schema is intentionally close to `activity_events` but kept separate —
`profile_actions` is the user-visible log on the profile detail panel;
`activity_events` is the analytics/audit stream.

**`legacy_dedupe_key`** is the safety net for re-runs of the importer.
Composed deterministically as:

```
sha1(
  prospect_id + '|' +
  action_type + '|' +
  occurred_at + '|' +
  sha1(notes || '') + '|' +
  (search_query || '')
)
```

Unique partial index on this column means repeated imports of the same
legacy `actions[]` entry are silently ignored by `INSERT OR IGNORE`. New
writes from the runtime leave the column NULL (the unique index is
partial, so it doesn't constrain NULL rows).

### 2c. New tables: `groups` + `group_members`

```sql
CREATE TABLE IF NOT EXISTS groups (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  description  TEXT,
  color        TEXT,
  account_id   TEXT,                  -- nullable; legacy / cross-account groups allowed
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id               TEXT    NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  profile_url            TEXT    NOT NULL,
  normalized_profile_url TEXT    NOT NULL,
  prospect_id            TEXT,                                 -- backfilled when prospect exists
  member_metadata_json   TEXT,                                 -- preserved iff legacy data had object members
  added_at               TEXT    NOT NULL,
  PRIMARY KEY (group_id, normalized_profile_url)
);
CREATE INDEX IF NOT EXISTS idx_group_members_prospect
  ON group_members(prospect_id);
CREATE INDEX IF NOT EXISTS idx_group_members_normalized_url
  ON group_members(normalized_profile_url);
```

Decisions:
- **Members keyed by `normalized_profile_url`** (not `prospect_id`) because
  the current group store accepts URLs for which no prospect record exists
  yet. `prospect_id` is opportunistically backfilled when a matching
  prospect is created.
- **Primary key is `(group_id, normalized_profile_url)`** so the same URL
  in different normalization forms (with/without trailing slash, etc.)
  doesn't appear twice in the same group.
- **`member_metadata_json`** is populated only when the legacy data had
  inline `{ url, name }` object members. Bare-URL members leave it NULL.

### 2d. New table: `import_state`

Observability marker for one-time and idempotent importers.

```sql
CREATE TABLE IF NOT EXISTS import_state (
  importer_name      TEXT    PRIMARY KEY,         -- 'profiles', 'groups', etc.
  last_run_at        TEXT    NOT NULL,
  last_run_imported  INTEGER NOT NULL DEFAULT 0,  -- rows actually inserted
  last_run_skipped   INTEGER NOT NULL DEFAULT 0,  -- rows ignored (dedupe / already present)
  last_run_errors    INTEGER NOT NULL DEFAULT 0,
  total_imported     INTEGER NOT NULL DEFAULT 0   -- cumulative across runs
);
```

Cheap "has this been imported?" check, separate from per-row dedup. Lets
us tell "importer ran but found 0 new rows" apart from "importer was
disabled / failed."

## 3. Migration strategy

Phased — same shape as the proven `health-legacy-importer.js` /
`prospect-legacy-importer.js` work that's already on main.

### Phase A — schema only, no data move

- Add the new columns to `prospects` via `ALTER TABLE` (idempotent, wrapped
  in try/catch on the per-column ALTER for re-run safety).
- Create the new tables (`profile_actions`, `groups`, `group_members`,
  `import_state`) with `CREATE TABLE IF NOT EXISTS`.
- Create the indexes.
- **No code path reads/writes the new columns yet.** Validates schema
  lands cleanly on every install.

### Phase B — one-time import, dual-read disabled

- New `storage/profile-legacy-importer.js`: reads `profiles.json`, upserts
  into `prospects` (filling new columns where they're NULL — never
  overwriting non-NULL SQLite fields) + inserts actions into
  `profile_actions` using `INSERT OR IGNORE` on `legacy_dedupe_key`.
  Records import state via `import_state`.
- New `storage/group-legacy-importer.js`: reads `groups.json` from the 3
  paths, dedupes, upserts into `groups` + `group_members`. Normalizes URLs
  during import. Records state.
- Both importers run from `main.js` startup. Gated by
  `process.env.CONNECT_DISABLE_LEGACY_IMPORT !== '1'` (escape hatch).
- **The importer is purely additive.** It NEVER overwrites a non-NULL
  SQLite field. The "newer timestamp wins" rule is explicitly NOT used —
  legacy JSON timestamps are not trustworthy enough. SQLite write paths
  win every conflict going forward.
- **Reads still serve from JSON via prospect-overlay** during this phase.
  SQLite is filled but not yet consulted by the read surfaces.

### Phase C — flip reads, keep dual writes

> **Refined design (post-Phase-B). Do NOT start Phase C code until Phase B
> (PR #7, startup wiring) is smoke-tested and merged — Phase C depends on
> SQLite being populated correctly.**

#### Reframe: we are not adding SQLite to reads; we are changing the spine

`getEnrichedStoredProfiles` (main.js) ALREADY reads both stores today:

```js
function getEnrichedStoredProfiles(accountId, filters) {
  const profiles  = getVisibleStoredProfiles(accountId);    // JSON = current SPINE
  const prospects = prospectQueueStore.getAllProspects(...); // SQLite identity overlay
  const index     = buildProspectEnrichmentIndex(prospects, normalizeProfileUrl);
  return overlayProspectEnrichment(profiles, index, normalizeProfileUrl);
}
```

So Phase C is **swapping which store is the spine** (JSON-spine-with-SQLite-overlay
→ SQLite-spine-with-JSON-fallback), not introducing SQLite reads from scratch.
Smaller, more contained change.

#### The shape contract (load-bearing)

After the flip, SQLite must reconstruct the exact profiles.json record shape
the renderer expects, from `prospects` + `profile_actions`:

```
url, originalUrl, linkedInProfileUrl  ← prospect.profileUrl
fullName, firstName, lastName         ← prospect.* (Phase A columns)
title, rawHeadline                    ← prospect.title / prospect.rawHeadline
company, companyDomain                ← prospect.* (Phase A)
email, suggestedEmails                ← prospect.primaryEmail / suggestedEmails (Phase A)
firstInteraction, lastInteraction     ← prospect.firstInteractionAt / lastInteractionAt (Phase A)
accountId, accountName                ← prospect.*
actions: [{type,timestamp,notes,searchQuery}]  ← profile_actions rows, mapped
```

The Phase C gate: for the same data, `JSON+overlay output` and
`SQLite reconstruction output` must be field-for-field equal. Snapshot diff.

#### Profile-read spine — which prospects are visible (LOCKED)

The flipped profile read serves **only prospects with at least one
`profile_actions` row**:

```sql
SELECT prospects WHERE EXISTS (
  SELECT 1 FROM profile_actions WHERE profile_actions.prospect_id = prospects.id
)
```

This is the SQL-native way to **preserve the legacy visible set**. A record
landed in `profiles.json` IFF `storeProfileAction` fired against it, and that
always wrote ≥1 action; those actions import into `profile_actions`. So
"has a `profile_action`" is exactly "was in `profiles.json`". Workflow- and
search-only prospects that were never viewed have no `profile_actions` and
therefore must NOT surface in the Profiles UI — matching today's behavior.

C3's job is **migration equivalence, not product expansion.** The flipped
SQLite read output must match the current JSON+overlay output in **record
count, ordering, and visible membership**. If we later want an "All Prospects"
view that includes untouched search/import leads, that is an explicit product
change with its own UI language and filters — never a silent side effect of
the storage migration. (If new records appeared in the panel after the flip,
users couldn't tell a migration bug from a feature.)

**Verified against real legacy data (2026-06):** `215 / 215` profiles have a
URL and `0` have an empty `actions: []`. Every legacy profile therefore imports
≥1 `profile_action`, so pure `EXISTS(profile_actions)` drops no records.
**No synthetic import-time action and no `legacy_profile_visible` marker are
needed right now.**

If a future install's legacy `profiles.json` is ever found to contain
empty-action profiles (re-run the `emptyActionsWithUrl` count before C3 where
this is in doubt), **prefer a write-once `legacy_profile_visible` marker set by
the importer over injecting synthetic fake actions** — a fake action would
pollute the user-visible action timeline, whereas a marker keeps the action
history honest while still making the record visible.

C3 tests to pin this rule:
- a prospect WITH a `profile_action` appears;
- a prospect with NO `profile_action` does not appear;
- imported legacy profiles appear (their legacy actions imported into
  `profile_actions`);
- runtime-created profiles appear once `storeProfileAction` dual-writes a
  `profile_action`;
- the rollback flag (`CONNECT_USE_LEGACY_JSON_STORES`) returns the JSON path.

#### Per-write-surface dual-write policy (NOT one universal rule)

| Write surface | Type | Failure policy |
|---|---|---|
| `save-groups-data` | UI save | **Current read-spine write is required.** While JSON is the spine, JSON write must succeed; SQLite write is best-effort sync. After the flip, SQLite write becomes required. |
| `storeProfileAction` | automation-side | **Persistence failure must NOT cause a LinkedIn action retry or duplicate side effect.** Log loudly, continue. A dropped action row is recoverable on next importer run; a duplicate LinkedIn action is not. |

General rule: the dual-write's *required* store is whichever is the current
read spine for that surface; the other store is best-effort sync. Cross-store
writes are NOT transactional — a divergence window is acceptable because the
legacy importer re-syncs on restart, and the read spine always serves correct
data.

#### Rollback flag — supports BOTH global and targeted

`CONNECT_USE_LEGACY_JSON_STORES`:
- `=1` → global rollback (all flipped surfaces serve legacy JSON)
- `=groups,profiles` → targeted rollback (comma-separated surface names)

Parsed at the main.js boundary, passed down as a resolved per-surface boolean
(never read from `process.env` inside the pure read functions — same purity
discipline as crash-telemetry / external-api-policy / run-legacy-importers).

#### Migration-readiness guard

If `import_state` shows NO successful `profiles` (or `groups`) import, the
flipped read path must fall back to JSON rather than serving empty SQLite
data. This protects the case where Phase B's importer was disabled
(`CONNECT_DISABLE_LEGACY_IMPORT=1`) or failed — the read flip must not blank
the UI. Check: `import_state` row exists for the importer AND
`last_run_errors === 0` (or a non-zero `total_imported`).

#### Deterministic ordering (test-pinned)

`actions[]` and group/member lists must have deterministic order, ideally
matching current JSON output:
- Profile actions: `ORDER BY occurred_at, id` (confirm against current UI
  expectation — the JSON `actions[]` order is append-order, which `id`
  preserves).
- Group members: `ORDER BY added_at, normalized_profile_url` (or whatever
  matches the current `members[]` array order).

Pin both with tests — the snapshot equivalence test catches ordering drift.

#### Account-filtering parity

`getEnrichedStoredProfiles(accountId, filters)` must behave identically after
the flip, ESPECIALLY for older records with missing `accountId`. The
`getScopedProspectFilters` + null-accountId records are the edge case. Test
the (accountId set) and (accountId null / record-has-no-accountId) paths
explicitly.

#### NULL normalized_profile_url guard

Phase B imports fill many `prospects.normalized_profile_url` values, but
pre-existing prospects (created before the column or via a path that didn't
set it) may have NULL. Phase C reconstruction must NOT assume every prospect
row has a non-NULL normalized URL — either backfill in a Phase C migration
step or handle NULL gracefully in the JOIN (LEFT JOIN + COALESCE on raw
profile_url).

#### Surface flip order + sub-slicing

| Slice | Scope | Risk |
|---|---|---|
| **C1** | Pure reconstruction helper (`prospects + profile_actions → profile shape`) + equivalence tests vs JSON+overlay. **No runtime wiring.** | Low |
| **C2** | Flip `get-groups-data` + dual-write `save-groups-data`. Smallest data, simplest enrichment. Behind rollback + readiness guards. | Medium |
| **C3** | Flip `getEnrichedStoredProfiles` (covers `getAllProfiles` AND `getProfileData`) + dual-write `storeProfileAction`. **Keystone — highest risk.** | High |
| **C4** | Flip `load-profiles-from-json`. Keep the IPC name `loadProfilesFromJson` for compatibility even though it reads SQLite internally — renaming is later cleanup. | Medium |

C1 first: build + test the reconstruction in isolation against fixtures
before flipping any live surface. The Phase C equivalent of "build the
machinery, prove it, then wire it."

#### `prospect-overlay.js` / `group-member-enrichment.js`

Collapse into SQL JOINs in the reconstruction helper, but **do NOT delete the
modules in Phase C** — they remain the fallback path behind the rollback flag.
Deletion is Phase E.

#### MCP awareness

MCP reads `prospects` directly via SQLite (no overlay). After PR #4 extended
`SqliteProspectRepository.rowToProspect` with the Phase A columns, MCP's
`list_prospects`/`get_prospect` see them automatically. **Action item:
confirm** `connect-mcp-server.js`'s prospect serialization path uses
`rowToProspect` (likely free, one-line verification, no code change expected).

### Phase D — drop JSON writes (keep JSON files)

- After Phase C has been stable, remove the JSON-write code paths.
- `profiles.json` + `groups.json` files **remain on disk untouched**.
- **No automatic archival or deletion.** Only an explicit
  `CONNECT_ARCHIVE_LEGACY_JSON=1` operator flag (manual, no default) ever
  moves the files.
- Two full releases must pass with no rollback before considering removal.

### Phase E — code cleanup (1+ release after Phase D)

- Delete `prospect-overlay.js`, `group-member-enrichment.js`, and the
  legacy JSON read paths in `automation/profile/storage.js` +
  `automation/profile/process.js`.
- The legacy importers stay (idempotent + cheap) for users upgrading from
  a pre-D version. Eventually remove them too — but not in this phase.

## 4. Compatibility / read APIs

The external contract must not break. Surfaces and their migration shape:

| API | Caller | Current source | Post-migration source | Visible change |
|---|---|---|---|---|
| `getAllProfiles()` IPC | renderer (SDR agents, prospects panel) | `profiles.json` + prospect-overlay | `prospects` JOIN `profile_actions` | None — same array shape returned |
| `getProfileData(url)` IPC | renderer (profile detail) | `profiles.json` + prospect-overlay | `prospects` + `profile_actions` WHERE prospect_id | None |
| `loadProfilesFromJson()` IPC | renderer (initial bootstrap) | `profiles.json` direct | `prospects` table | None |
| `storeProfileAction()` | action-router on every step | `profiles.json` append + prospect upsert | `profile_actions` INSERT + prospect UPSERT | None |
| `get-groups-data` IPC | renderer | 3-path JSON read + enrichment | `groups` + `group_members` JOIN `prospects` | None |
| `save-groups-data` IPC | renderer (groups panel save) | 3-path JSON write | `groups` + `group_members` transactional UPDATE | None |
| MCP `list_prospects`, `get_prospect` | MCP clients | `prospects` (already) | `prospects` (now with more fields) | New fields appear — additive |
| External API `getAllProfiles`, `getGroupsData` | external HTTP API | IPC chain | IPC chain to SQLite | None |

The renderer doesn't know which backend serves it; all reads come through
`electronAPI.*` IPC. As long as response shapes are preserved, no renderer
code changes.

## 5. Rollback plan

Three layers, easiest → most invasive:

### 5a. Runtime flag (no code revert)

`CONNECT_USE_LEGACY_JSON_STORES=1`: bypasses the SQLite read paths,
serves the legacy JSON. Useful during Phase C if a regression surfaces
but the JSON files are still being written. Adds no new code surface —
it's a guard inside the read functions.

### 5b. Code revert (single commit)

Phase C is one commit (or a small commit cluster). Reverting it restores
the JSON-read code paths. SQLite data stays intact (no schema drop) so
re-applying later is a no-op data-wise. Safe because Phase B + atomic
dual-writes mean both stores are in sync at any moment.

### 5c. Data restore from JSON (full rollback)

Legacy JSON files are still on disk after Phase D — Phase D explicitly
does NOT move/delete them. If SQLite gets catastrophically corrupted,
the JSON files re-imported via the Phase B importer reconstruct state.

**The migration is reversible at every phase boundary** — no Phase
requires "burn the previous bridges" until Phase E (and even then,
data-wise, restoring JSON files re-bootstraps SQLite via Phase B).

## 6. Test matrix

Each phase needs its own test pinning the contract that phase introduces.

### Phase A tests

- `applySchema` adds the new columns without breaking existing data.
- ALTER TABLE is idempotent — second run is a no-op (uses
  `IF NOT EXISTS` for new tables/indexes; try/catch around per-column
  ALTERs since SQLite doesn't have `IF NOT EXISTS` for ADD COLUMN).
- New tables are created with the right columns + indexes.
- Empty `import_state` table reads cleanly.

### Phase B tests (importer)

- `importProfileLegacyData(db, profilesPath)`: handles empty / missing /
  malformed files (each → no-op + log + `import_state` row with error).
- Idempotency: running twice produces the same SQLite state.
- **Additive contract:** a profiles.json record with `fullName='X'` does
  NOT overwrite a SQLite `prospects.full_name='Y'`. Fields that are NULL
  in SQLite are filled; non-NULL fields are preserved.
- **Legacy dedupe:** the same `actions[]` entry imported twice produces
  exactly one `profile_actions` row.
- **URL normalization:** `https://www.linkedin.com/in/x/` and
  `https://linkedin.com/in/x` normalize to the same key.
- **Orphan-prospect handling:** a profiles.json record with no matching
  prospect row creates a stub prospect (does NOT skip).
- Same shape for `importGroupsLegacyData` from the 3 JSON paths, including
  dedupe across paths.
- `import_state` row updated on each run.

### Phase C tests (read flip)

**C1 (pure reconstruction helper) — gate before any flip:**
- Reconstruction output === JSON+overlay output, field-for-field, for a
  fixture covering all 17 profile fields + actions array.
- Edge cases: empty prospect, prospect with no actions, prospect with many
  actions, missing optional fields, NULL `normalized_profile_url`.
- Deterministic action ordering (`ORDER BY occurred_at, id`) matches the
  JSON `actions[]` append order.

**C2/C3/C4 (per flip):**
- Snapshot equivalence: legacy path vs SQLite path produce identical IPC
  return for the same data.
- `getAllProfiles()` / `getProfileData()` / `get-groups-data` shape parity.
- `memberProfiles` enrichment (now a SQL JOIN) matches the JS-enrichment
  output.
- Dual-write lands in BOTH stores; the `profile_actions` row matches what
  would have landed in JSON `actions[]`.
- **Rollback flag**: `CONNECT_USE_LEGACY_JSON_STORES=1` (global) and
  `=groups` / `=profiles` (targeted) each route the affected surface to the
  legacy path.
- **Migration-readiness guard**: with `import_state` showing no successful
  import, the flipped read falls back to JSON (does not blank the UI).
- **Account filtering parity**: `(accountId set)` and
  `(accountId null / record-has-no-accountId)` both behave identically to
  the pre-flip output.

**Dual-write failure semantics:**
- `save-groups-data`: while JSON is the spine, JSON-write failure surfaces;
  SQLite-write failure logs + continues. (Inverts after the flip.)
- `storeProfileAction`: SQLite-write failure logs loudly + continues; never
  triggers a LinkedIn action retry or duplicate side effect.

### Phase D tests (drop JSON writes)

- After Phase D, writes only hit SQLite. `profiles.json` and `groups.json`
  mtime should NOT change.
- Regression test: if a writer accidentally calls the legacy write path,
  the test catches it (assert file mtime unchanged after a known write).

### Cross-phase invariants

- Round-trip: write via the new API → read via the new API → same fields back.
- Concurrency: two simultaneous `storeProfileAction` calls don't lose
  data. SQLite handles this; was a real risk under JSON.
- MCP/main parallel access: MCP server and main process both writing
  prospects fields don't trample each other.

### Hand-tested smoke (not unit-testable)

- Open the app, open the prospects panel — same records visible.
- Add a prospect to a group — survives restart.
- View a profile, do an action, restart, action history is intact.

## 7. Open-question answers (locked)

1. **Member objects in legacy groups data:** importer normalizes to rows,
   preserves inline metadata in `group_members.member_metadata_json`
   ONLY when present.
2. **Importer cadence:** runs every startup while dual-write is active,
   idempotent via the `import_state` marker table. Reduce to one-time
   after Phase D stabilizes.
3. **Profiles with no matching prospect:** create stub prospects. Do
   not skip old data.
4. **Account scoping on groups:** nullable `account_id` on `groups`. Do
   not force per-account groups yet.

## 8. Estimated scope

| Phase | Commits | Risk | Reviewer attention |
|---|---|---|---|
| A — schema | 1 | Low | Skim |
| B — importers + tests | 2–3 | Medium | Read both importers carefully |
| C — flip reads + dual write | 3–4 | High | Detailed — biggest behavioral change |
| D — drop JSON writes | 1 | Medium | Verify smoke before merge |
| E — delete legacy code | 1 | Low | Skim |

**Branch + PR per phase**, not all on main. Phase C deserves separate
review attention. Total: ~2–3 weeks of careful work.

## 9. What this design deliberately does NOT do

- **No "newer timestamp wins" reconciliation.** Legacy JSON timestamps
  aren't trustworthy. SQLite write paths win. The importer is purely
  additive (fills NULL columns).
- **No auto-archival of JSON files in Phase D.** Files stay where they
  are; only an explicit operator flag moves them. Two-release minimum
  before considering removal.
- **No new "profiles" table.** The existing `prospects` table is the
  identity store of truth; we extend it.
- **No simultaneous migration of every consumer.** Phased flip-and-dual-
  write lets us validate each surface before retiring the legacy path.

---

**This document is the design pass. Phase A implementation begins on a
branch (`phase-a-schema-only`) when explicitly approved. Until then this
doc is the only `main` change.**
