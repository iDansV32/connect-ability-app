'use strict';

/**
 * storage/profile-reconstruction.js
 *
 * Phase C step C1 of roadmap #7 (profiles/groups → SQLite migration).
 *
 * Pure reconstruction helper: rebuilds the legacy `profiles.json` record shape
 * from the SQLite spine (`prospects` + `profile_actions`). This is the
 * machinery the Phase C read-flip will install in place of
 * `getEnrichedStoredProfiles`'s JSON-spine-plus-overlay. C1 builds and proves
 * it in isolation — NO runtime wiring. C2/C3/C4 do the flips.
 *
 * Why this exists: today `getEnrichedStoredProfiles(accountId)` reads
 * profiles.json (the spine) and overlays clean identity from SQLite prospects
 * via automation/profile/prospect-overlay.js. Post-flip, SQLite becomes the
 * spine, so we must reconstruct the EXACT same record shape the renderer
 * already consumes. The equivalence gate (tests/profile-reconstruction.test.js):
 *
 *     profiles.json --[real importer]--> SQLite --[reconstruct]--> record R
 *     profiles.json --[prospect-overlay]------------------------> record L
 *     assert deepEqual(R, L)   // field-for-field, per record
 *
 * Shape contract (from docs/profiles-groups-sqlite-migration.md §Phase C):
 *
 *     url, originalUrl, linkedInProfileUrl   <- prospect.profileUrl
 *     firstName, lastName, fullName          <- prospect.* (Phase A columns)
 *     title, rawHeadline                     <- prospect.title / prospect.rawHeadline
 *     company, companyDomain                 <- prospect.* (Phase A)
 *     email, suggestedEmails                 <- prospect.primaryEmail / suggestedEmails
 *     firstInteraction, lastInteraction      <- prospect.firstInteractionAt / lastInteractionAt
 *     accountId, accountName                 <- prospect.*
 *     actions: [{type,timestamp,notes,searchQuery}]  <- profile_actions rows
 *     position, enrichmentSource             <- overlay-equivalent identity resolution
 *
 * Purity: the per-record builder (`reconstructProfileRecord`) is pure (no I/O,
 * no Electron, no process.env). `reconstructProfiles(db, ...)` takes an open
 * better-sqlite3 handle and an injected normalizer — same discipline as the
 * Phase B importers. The main.js boundary owns env + path resolution; this
 * module owns data logic only.
 *
 * Known, INTENTIONAL divergences from the legacy JSON spine (documented +
 * pinned by tests, not bugs):
 *   - The three URL fields (url/originalUrl/linkedInProfileUrl) all collapse to
 *     prospect.profileUrl. profiles.json historically held a normalized `url`
 *     plus raw `originalUrl`/`linkedInProfileUrl`; only the first URL key was
 *     imported into the prospect (Phase B), so the raw forms aren't
 *     recoverable. Equivalence holds exactly when the source record already had
 *     url === originalUrl === linkedInProfileUrl (the common, canonical case).
 *   - Action ordering is canonicalized to (occurred_at, id). The JSON
 *     `actions[]` array is append-ordered, which matches for chronologically
 *     appended actions; out-of-order legacy timestamps are re-sorted.
 */

const SqliteProspectRepository = require('./sqlite-prospect-repository');

// ---------------------------------------------------------------------------
// Identity resolution — MUST stay behaviorally identical to
// automation/profile/prospect-overlay.js (cleanField + name-as-title
// suppression). Replicated here rather than imported so the reconstruction
// helper is self-contained and the overlay module can be deleted in Phase E
// without breaking this. The equivalence test enforces they don't drift.
// ---------------------------------------------------------------------------

const IDENTITY_PLACEHOLDERS = new Set([
  'Not Available',
  'Not available',
  'Unknown Profile',
  'Unknown'
]);

function cleanField(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (IDENTITY_PLACEHOLDERS.has(s)) return null;
  return s;
}

/**
 * Map a profile_actions DB row to the legacy `actions[]` entry shape.
 * Mirrors what automation/profile/storage.js writes:
 *   { type, timestamp, notes, searchQuery }
 * The importer stored empty notes/search_query as NULL; restore '' for notes
 * (storage.js default) and null for searchQuery (storage.js default).
 *
 * @param {object} row  profile_actions row
 * @returns {{type:string, timestamp:string, notes:string, searchQuery:(string|null)}}
 */
function mapActionRow(row) {
  return {
    type: row.action_type,
    timestamp: row.occurred_at,
    notes: row.notes == null ? '' : row.notes,
    searchQuery: row.search_query == null ? null : row.search_query
  };
}

/**
 * Rebuild a single profiles.json-shaped record from a JS prospect object
 * (rowToProspect shape) plus its already-ordered profile_actions rows.
 *
 * Pure. The identity fields (fullName/title/company) resolve via the same
 * clean-and-suppress rule the legacy overlay applies, with the SAME fallback:
 * overlay output = clean(prospect.X) ?? legacyJsonValue, and after a faithful
 * Phase B import legacyJsonValue === the raw prospect.X — so falling back to
 * the raw prospect value reproduces the overlay output exactly.
 *
 * @param {object} prospect      rowToProspect-shaped object
 * @param {Array<object>} actionRows  profile_actions rows (pre-ordered)
 * @returns {object} profiles.json-shaped record
 */
function reconstructProfileRecord(prospect, actionRows) {
  const p = prospect || {};

  const fullNameClean = cleanField(p.fullName);
  let titleClean = cleanField(p.title);
  let companyClean = cleanField(p.company);

  // name-as-title is the signature of a bad bio extraction: suppress BOTH
  // title and company so neither overlays as clean. (overlay then keeps the
  // legacy JSON value — which equals the raw prospect value here.)
  if (titleClean && fullNameClean && titleClean.toLowerCase() === fullNameClean.toLowerCase()) {
    titleClean = null;
    companyClean = null;
  }

  const url = p.profileUrl || p.normalizedProfileUrl || '';

  const record = {
    url,
    originalUrl: url,
    linkedInProfileUrl: url,
    firstName: p.firstName || '',
    lastName: p.lastName || '',
    // overlay: clean ?? legacyValue; legacyValue === raw prospect value post-import.
    fullName: fullNameClean != null ? fullNameClean : (p.fullName != null ? p.fullName : 'Unknown Profile'),
    title: titleClean != null ? titleClean : (p.title != null ? p.title : ''),
    company: companyClean != null ? companyClean : (p.company != null ? p.company : ''),
    rawHeadline: p.rawHeadline || '',
    email: p.primaryEmail || 'Not available',
    accountId: p.accountId || null,
    accountName: p.accountName || null,
    firstInteraction: p.firstInteractionAt || null,
    lastInteraction: p.lastInteractionAt || null,
    actions: Array.isArray(actionRows) ? actionRows.map(mapActionRow) : []
  };

  // The overlay only mirrors title -> position and stamps enrichmentSource when
  // it had a clean identity field to overlay (an index entry was built only if
  // fullName || title || company survived cleaning). Match that precisely so a
  // prospect with no usable identity reconstructs without these keys.
  if (titleClean != null) {
    record.position = titleClean;
  }
  if (fullNameClean || titleClean || companyClean) {
    record.enrichmentSource = 'prospect';
  }

  // Optional enrichment fields: present only when the prospect carries them,
  // matching what storage.js wrote (suggestedEmails + companyDomain).
  if (Array.isArray(p.suggestedEmails) && p.suggestedEmails.length > 0) {
    record.suggestedEmails = p.suggestedEmails;
  }
  if (p.companyDomain) {
    record.companyDomain = p.companyDomain;
  }

  return record;
}

/**
 * Reconstruct the full profiles list from the SQLite spine.
 *
 * Loads prospects (optionally account-filtered) via the canonical repository
 * mapping, then attaches each prospect's profile_actions ordered by
 * (occurred_at, id). Returns the array of reconstructed records.
 *
 * NOTE on array ordering: the per-record shape is the contract; the array
 * order here follows the repository's `ORDER BY updated_at DESC` and is NOT
 * guaranteed to match the legacy profiles.json insertion order. Callers/tests
 * that need a stable comparison should key by normalized url. C3 will decide
 * the renderer-facing ordering.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [options]
 * @param {string|null} [options.accountId]  filter to one account (repo-level)
 * @returns {Array<object>} reconstructed profiles.json-shaped records
 */
function reconstructProfiles(db, options = {}) {
  const repo = new SqliteProspectRepository(db);
  const filters = {};
  if (options.accountId) {
    filters.accountId = options.accountId;
  }
  const prospects = repo.findAll(filters);
  if (!prospects.length) return [];

  // One pass over profile_actions, grouped by prospect_id, pre-ordered.
  const actionsByProspect = new Map();
  const actionRows = db
    .prepare('SELECT * FROM profile_actions ORDER BY occurred_at ASC, id ASC')
    .all();
  for (const row of actionRows) {
    if (!actionsByProspect.has(row.prospect_id)) {
      actionsByProspect.set(row.prospect_id, []);
    }
    actionsByProspect.get(row.prospect_id).push(row);
  }

  return prospects.map((prospect) =>
    reconstructProfileRecord(prospect, actionsByProspect.get(prospect.id) || [])
  );
}

module.exports = {
  reconstructProfileRecord,
  reconstructProfiles,
  mapActionRow,
  // exported for the equivalence test's drift guard
  cleanField
};
