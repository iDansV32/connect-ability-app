'use strict';

/**
 * storage/profile-legacy-importer.js
 *
 * Phase B step 3 of roadmap #7. Reads the legacy profiles.json store and
 * imports it into SQLite via:
 *   - prospect-queue-store.upsertProspect({...}, { additive: true })
 *     for the identity / contact fields (8 Phase A columns + existing
 *     prospect columns). Additive flag means the importer never clobbers
 *     a runtime-written non-NULL SQLite value.
 *   - INSERT OR IGNORE into profile_actions for each action entry,
 *     keyed on a deterministic legacy_dedupe_key. The unique partial
 *     index on that column means repeated imports never duplicate.
 *
 * Pure module: no Electron, no main.js, no app.getPath. The caller wires
 * the prospect store and the db handle and supplies the file path. Phase B
 * step 5 will be the startup wiring; this commit is just the importer + tests.
 *
 * Return shape (per agreed convention):
 *   {
 *     read,                // total profiles.json records examined
 *     importedProspects,   // new prospect upserts that created a row
 *     importedActions,     // profile_actions rows inserted (INSERT OR IGNORE wins)
 *     skipped,             // non-object entries + records missing url
 *     errors,              // file-read / parse / malformed-action failures
 *     ranAt                // ISO timestamp
 *   }
 *
 * Also writes a single row to the import_state table with the same counts.
 * total_imported accumulates across runs (prospect upserts + action inserts).
 */

const fs = require('fs');
const crypto = require('crypto');

const { normalizeProfileUrl } = require('../automation/url/normalize');

const IMPORTER_NAME = 'profiles';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} options
 * @param {string} options.profilesPath       absolute path to profiles.json
 * @param {object} options.prospectStore      ProspectQueueStore with upsertProspect()
 * @param {() => Date} [options.now]          clock injection (defaults to new Date())
 * @param {boolean} [options.dryRun]          when true, count but don't write
 * @returns {{read:number, importedProspects:number, importedActions:number, skipped:number, errors:number, ranAt:string}}
 */
function importProfiles(db, options = {}) {
  const profilesPath = options.profilesPath;
  const prospectStore = options.prospectStore;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const dryRun = options.dryRun === true;
  const ranAt = clock().toISOString();

  const counts = {
    read: 0,
    importedProspects: 0,
    importedActions: 0,
    skipped: 0,
    errors: 0,
    ranAt
  };

  // Step 1: read + parse. Every failure mode produces zero-import results
  // and an errors counter increment — never throws to caller.
  if (!profilesPath || !fs.existsSync(profilesPath)) {
    return finalize(db, counts, dryRun);
  }

  let raw;
  try {
    raw = fs.readFileSync(profilesPath, 'utf8');
  } catch (_) {
    counts.errors += 1;
    return finalize(db, counts, dryRun);
  }
  if (!raw || !raw.trim()) {
    return finalize(db, counts, dryRun);
  }

  let records;
  try {
    records = JSON.parse(raw);
  } catch (_) {
    counts.errors += 1;
    return finalize(db, counts, dryRun);
  }
  if (!Array.isArray(records)) {
    counts.errors += 1;
    return finalize(db, counts, dryRun);
  }

  // Step 2: prepare the INSERT OR IGNORE for profile_actions.
  const insertAction = db.prepare(`
    INSERT OR IGNORE INTO profile_actions
      (prospect_id, normalized_profile_url, action_type, occurred_at,
       notes, search_query, account_id, legacy_dedupe_key, created_at)
    VALUES
      (@prospect_id, @normalized_profile_url, @action_type, @occurred_at,
       @notes, @search_query, @account_id, @legacy_dedupe_key, @created_at)
  `);

  // Step 2b: snapshot known prospect ids so we can detect ACTUAL new
  // prospects vs. ones the upsert merged via name+company dedupe-keys
  // (which a URL-only lookup would miss, producing phantom "new" counts
  // AND a null prospectId that makes every action of that record fail).
  // Discovered during smoke against real profiles.json data: 14 records
  // hit name+company dedupe and 21 actions failed before this fix.
  const knownProspectIds = new Set();
  if (prospectStore && typeof prospectStore.getAllProspects === 'function') {
    for (const p of prospectStore.getAllProspects()) {
      if (p && p.id) knownProspectIds.add(p.id);
    }
  }

  // Step 3: iterate. Each record fence-isolated; malformed records skip
  // or count as errors, but never break the loop.
  for (const record of records) {
    counts.read += 1;

    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      counts.skipped += 1;
      continue;
    }

    const url = pickFirstString(record, ['url', 'originalUrl', 'linkedInProfileUrl', 'profileUrl']);
    if (!url) {
      counts.skipped += 1;
      continue;
    }

    const normalizedUrl = normalizeProfileUrl(url);
    if (!normalizedUrl) {
      counts.skipped += 1;
      continue;
    }

    // Build the upsertProspect input. profiles.json field names mapped to
    // the API's expected shape. `email` is the historic field name; the
    // store already accepts it as an alias for primaryEmail.
    const upsertInput = {
      accountId: record.accountId || null,
      accountName: record.accountName || null,
      profileUrl: url,
      fullName: record.fullName || null,
      firstName: record.firstName || null,
      lastName: record.lastName || null,
      title: record.title || null,
      rawHeadline: record.rawHeadline || null,
      company: record.company || null,
      companyDomain: record.companyDomain || null,
      email: record.email || null,
      suggestedEmails: Array.isArray(record.suggestedEmails) ? record.suggestedEmails : null,
      firstInteractionAt: record.firstInteraction || null,
      lastInteractionAt: record.lastInteraction || null,
      sourceType: 'profiles'
    };

    // Counter + prospectId resolution.
    //
    // Non-dryRun: call upsertProspect and use its RETURN VALUE for the
    // prospect id. This is the source of truth — upsertProspect runs the
    // full dedupe pipeline (id → normalized URL → per-account dedupe
    // keys) and returns the resulting prospect, whether newly-created or
    // merged. Tracking `knownProspectIds` lets us count true new arrivals
    // accurately even when the merge happens via name+company dedupe
    // (which a URL-only pre-check would miss). Pre-fix, that
    // mismatch produced phantom new-prospect counts AND broken action
    // FKs — both surfaced during smoke against real profiles.json data.
    //
    // dryRun: fall back to URL-only findExistingProspect as an
    // approximation. The counter is best-effort in dry-run mode (won't
    // catch name+company merges); the trade-off is acceptable because
    // dry-run doesn't write anything anyway.
    let prospectId;
    if (dryRun) {
      const existing = findExistingProspect(prospectStore, upsertInput);
      if (!existing) {
        counts.importedProspects += 1;
      }
      prospectId = existing ? existing.id : 'dry-run-stub';
    } else {
      const prospect = prospectStore.upsertProspect(upsertInput, { additive: true });
      prospectId = prospect && prospect.id ? prospect.id : null;
      if (prospectId && !knownProspectIds.has(prospectId)) {
        counts.importedProspects += 1;
        knownProspectIds.add(prospectId);
      }
    }

    // Action processing. Each action is independently fence-isolated.
    const actions = Array.isArray(record.actions) ? record.actions : [];
    for (const action of actions) {
      if (!action || typeof action !== 'object' || Array.isArray(action)) {
        counts.errors += 1;
        continue;
      }
      const actionType = typeof action.type === 'string' && action.type.trim();
      if (!actionType) {
        counts.errors += 1;
        continue;
      }
      const occurredAt = typeof action.timestamp === 'string' && action.timestamp.trim()
        ? action.timestamp.trim()
        : ranAt;
      const notes = typeof action.notes === 'string' ? action.notes : '';
      const searchQuery = typeof action.searchQuery === 'string' ? action.searchQuery : '';

      const dedupeKey = buildLegacyDedupeKey({
        normalizedProfileUrl: normalizedUrl,
        actionType,
        occurredAt,
        notes,
        searchQuery
      });

      if (dryRun) {
        // Count would-import without writing.
        counts.importedActions += 1;
        continue;
      }

      if (!prospectId) {
        // upsertProspect didn't yield an id we can FK to — should be rare,
        // but count as error rather than crash.
        counts.errors += 1;
        continue;
      }

      const result = insertAction.run({
        prospect_id: prospectId,
        normalized_profile_url: normalizedUrl,
        action_type: actionType,
        occurred_at: occurredAt,
        notes: notes || null,
        search_query: searchQuery || null,
        account_id: record.accountId || null,
        legacy_dedupe_key: dedupeKey,
        created_at: ranAt
      });
      // INSERT OR IGNORE: result.changes is 1 on insert, 0 on dedupe-hit.
      if (result.changes === 1) {
        counts.importedActions += 1;
      }
    }
  }

  return finalize(db, counts, dryRun);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickFirstString(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function findExistingProspect(prospectStore, input) {
  const normalizedUrl = normalizeProfileUrl(input.profileUrl || '');
  if (!normalizedUrl) return null;

  // Use the store's read API to find by URL. ProspectQueueStore exposes
  // getAllProspects() which works for both SQLite and JSON backends.
  // We scan rather than calling repo.findByNormalizedUrl directly because
  // the latter would couple this module to the SQLite backend. Scan is
  // acceptable here — Phase B imports happen at startup, not per-request.
  const all = prospectStore.getAllProspects ? prospectStore.getAllProspects() : [];
  for (const p of all) {
    if (p.normalizedProfileUrl === normalizedUrl && (
      !input.accountId || !p.accountId || p.accountId === input.accountId
    )) {
      return p;
    }
  }
  return null;
}

/**
 * Deterministic dedupe key for an action imported from the legacy JSON.
 * Composed so two identical action records always produce the same key
 * across runs. The unique partial index on profile_actions.legacy_dedupe_key
 * turns repeat imports into INSERT OR IGNORE no-ops.
 *
 * IMPORTANT: the key uses `normalizedProfileUrl`, NOT `prospect_id`. Actions
 * in profiles.json are records of "what happened to this profile URL"; their
 * identity is the URL + action attributes, not which prospect row we happen
 * to attach them to. Using prospect_id here would make the key sensitive to
 * the non-determinism of upsertProspect's dedupe lookup (multiple prospects
 * with the same account+URL produce ambiguous LIMIT 1 results), which
 * smoke testing revealed produces phantom action re-inserts on subsequent
 * runs even when the source data is identical.
 */
function buildLegacyDedupeKey({ normalizedProfileUrl, actionType, occurredAt, notes, searchQuery }) {
  const notesHash = crypto.createHash('sha1').update(notes || '').digest('hex');
  const composite = [
    normalizedProfileUrl || '',
    actionType || '',
    occurredAt || '',
    notesHash,
    searchQuery || ''
  ].join('|');
  return crypto.createHash('sha1').update(composite).digest('hex');
}

/**
 * Write the import_state row (when not dryRun) and return the counts. The
 * row's last_run_* columns mirror this run's counts; total_imported
 * accumulates across runs (prospect upserts + action inserts).
 */
function finalize(db, counts, dryRun) {
  if (dryRun) return counts;

  const totalThisRun = counts.importedProspects + counts.importedActions;

  db.prepare(`
    INSERT INTO import_state
      (importer_name, last_run_at, last_run_imported, last_run_skipped, last_run_errors, total_imported)
    VALUES
      (@importer_name, @last_run_at, @last_run_imported, @last_run_skipped, @last_run_errors, @total_imported)
    ON CONFLICT(importer_name) DO UPDATE SET
      last_run_at        = excluded.last_run_at,
      last_run_imported  = excluded.last_run_imported,
      last_run_skipped   = excluded.last_run_skipped,
      last_run_errors    = excluded.last_run_errors,
      total_imported     = import_state.total_imported + excluded.last_run_imported
  `).run({
    importer_name:     IMPORTER_NAME,
    last_run_at:       counts.ranAt,
    last_run_imported: totalThisRun,
    last_run_skipped:  counts.skipped,
    last_run_errors:   counts.errors,
    total_imported:    totalThisRun
  });
  return counts;
}

module.exports = {
  importProfiles,
  buildLegacyDedupeKey
};
