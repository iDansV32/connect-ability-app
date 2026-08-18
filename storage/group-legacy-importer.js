'use strict';

/**
 * storage/group-legacy-importer.js
 *
 * Phase B step 4 of roadmap #7. Reads the 3 legacy groups.json paths and
 * imports into SQLite `groups` + `group_members`. Mirrors the shape of
 * profile-legacy-importer:
 *
 *   - Pure module: no Electron, no main.js, no app.getPath.
 *   - Caller supplies the file paths + the prospect store.
 *   - Each individual file failure is fence-isolated and counted as
 *     errors+=1; other files still import.
 *   - Writes one row to import_state with importer_name='groups'.
 *
 * Critical merge asymmetry (per design doc + Phase B framing):
 *
 *   • Cross-store (JSON ↔ SQLite):  SQLite always wins; additive only.
 *   • Intra-source (3 groups.json): most-recent updatedAt wins because
 *     all three files are operator-machine replicas of the same logical
 *     store, written by the save-groups-data IPC handler. The cross-path
 *     write was not transactional (closed by atomic-write commits
 *     19c8ae7 + b0ffe10) — older copies can exist from before that fix.
 *
 * Members semantics:
 *
 *   • String members  → bare URL, member_metadata_json stays NULL.
 *   • Object members  → URL from {url, profileUrl, value}; remaining
 *                       fields preserved in member_metadata_json.
 *   • Composite PK (group_id, normalized_profile_url) deduplicates
 *     URL-variants within the same group.
 *
 * Opportunistic backfill:
 *
 *   When a member URL maps to an existing prospect (looked up by
 *   normalized_profile_url), the prospect_id column is populated. When
 *   no matching prospect exists yet, the column stays NULL — Phase C
 *   read paths handle both cases via LEFT JOIN.
 */

const fs = require('fs');

const { normalizeProfileUrl } = require('../automation/url/normalize');

const IMPORTER_NAME = 'groups';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} options
 * @param {string[]} options.groupsPaths    array of absolute paths to legacy groups.json replicas
 * @param {object} options.prospectStore    ProspectQueueStore with getAllProspects()
 * @param {() => Date} [options.now]
 * @param {boolean} [options.dryRun]
 * @returns {{read:number, importedGroups:number, importedMembers:number, skipped:number, errors:number, ranAt:string}}
 */
function importGroups(db, options = {}) {
  const groupsPaths = Array.isArray(options.groupsPaths) ? options.groupsPaths : [];
  const prospectStore = options.prospectStore;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const dryRun = options.dryRun === true;
  const ranAt = clock().toISOString();

  const counts = {
    read: 0,
    importedGroups: 0,
    importedMembers: 0,
    skipped: 0,
    errors: 0,
    ranAt
  };

  // Step 1: read all three paths into one merged map keyed by group id.
  // Missing files are NOT errors (the operator may simply not have a
  // legacy copy in that location). Malformed JSON or non-array root in
  // a present file IS an error, but doesn't abort the run.
  const mergedById = new Map();

  for (const filePath of groupsPaths) {
    if (!filePath || !fs.existsSync(filePath)) continue;
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (_) {
      counts.errors += 1;
      continue;
    }
    if (!raw || !raw.trim()) continue;
    let records;
    try {
      records = JSON.parse(raw);
    } catch (_) {
      counts.errors += 1;
      continue;
    }
    if (!Array.isArray(records)) {
      counts.errors += 1;
      continue;
    }

    for (const record of records) {
      counts.read += 1;

      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        counts.skipped += 1;
        continue;
      }

      // ID resolution: explicit id > name fallback (mirrors the runtime IPC
      // handler's `group.id || group.name` behavior).
      const id = pickString(record.id) || pickString(record.name);
      if (!id) {
        counts.skipped += 1;
        continue;
      }

      const recordUpdatedAt = pickString(record.updatedAt);
      const existing = mergedById.get(id);
      if (existing) {
        // Most-recent updatedAt wins. When neither side has updatedAt,
        // the first-encountered record stays (pinned in tests as the
        // "no crash" fallback).
        if (recordUpdatedAt && (!existing.record.updatedAt || recordUpdatedAt > existing.record.updatedAt)) {
          mergedById.set(id, { record, sourcePath: filePath });
        }
      } else {
        mergedById.set(id, { record, sourcePath: filePath });
      }
    }
  }

  // Step 2: prepare INSERTs. groups uses UPSERT (INSERT ... ON CONFLICT
  // DO UPDATE) — NOT `INSERT OR REPLACE`, which would internally DELETE
  // the existing group row and trigger the `group_members.group_id ON
  // DELETE CASCADE`, wiping every member. UPSERT updates the row in place,
  // preserving the FK relationship. group_members uses INSERT OR IGNORE
  // (composite PK collapses URL variants + idempotent re-runs).
  const insertGroup = db.prepare(`
    INSERT INTO groups
      (id, name, description, color, account_id, created_at, updated_at)
    VALUES
      (@id, @name, @description, @color, @account_id, @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name        = excluded.name,
      description = excluded.description,
      color       = excluded.color,
      account_id  = excluded.account_id,
      updated_at  = excluded.updated_at
  `);
  const insertMember = db.prepare(`
    INSERT OR IGNORE INTO group_members
      (group_id, profile_url, normalized_profile_url, prospect_id,
       member_metadata_json, added_at)
    VALUES
      (@group_id, @profile_url, @normalized_profile_url, @prospect_id,
       @member_metadata_json, @added_at)
  `);

  // Step 3: build prospect URL → id lookup ONCE for the whole import.
  // Avoids per-member scans of getAllProspects().
  const prospectIdByUrl = new Map();
  if (prospectStore && typeof prospectStore.getAllProspects === 'function') {
    for (const p of prospectStore.getAllProspects()) {
      if (p.normalizedProfileUrl) {
        prospectIdByUrl.set(p.normalizedProfileUrl, p.id);
      }
    }
  }

  // Step 4: iterate merged map and write.
  const dryRunSeenMembers = new Set();
  for (const { record } of mergedById.values()) {
    const id = pickString(record.id) || pickString(record.name);
    const groupRow = {
      id,
      name: pickString(record.name) || id,
      description: pickString(record.description) || null,
      color: pickString(record.color) || null,
      account_id: pickString(record.accountId) || null,
      created_at: pickString(record.createdAt) || ranAt,
      updated_at: pickString(record.updatedAt) || ranAt
    };

    // Pre-check: does this group already exist in SQLite? If yes, this
    // is a re-run on the same data — skip the importedGroups counter
    // increment (idempotency reporting).
    const existingRow = db.prepare('SELECT updated_at FROM groups WHERE id = ?').get(id);
    const isNewGroup = !existingRow;

    if (!dryRun) {
      insertGroup.run(groupRow);
    }
    if (isNewGroup) {
      counts.importedGroups += 1;
    }

    const members = Array.isArray(record.members) ? record.members : [];
    for (const member of members) {
      const memberInfo = memberUrlAndMeta(member);
      if (!memberInfo.url) {
        counts.errors += 1;
        continue;
      }
      const normalized = normalizeProfileUrl(memberInfo.url);
      if (!normalized) {
        counts.errors += 1;
        continue;
      }

      const memberRow = {
        group_id: id,
        profile_url: memberInfo.url,
        normalized_profile_url: normalized,
        prospect_id: prospectIdByUrl.get(normalized) || null,
        member_metadata_json: memberInfo.metadataJson,
        added_at: ranAt
      };

      if (dryRun) {
        // Approximate composite PK dedupe in dryRun by tracking the
        // (group_id, normalized) pairs we've already counted this run.
        const key = `${id}::${normalized}`;
        if (!dryRunSeenMembers.has(key)) {
          dryRunSeenMembers.add(key);
          counts.importedMembers += 1;
        }
        continue;
      }

      const result = insertMember.run(memberRow);
      if (result.changes === 1) {
        counts.importedMembers += 1;
      }
    }
  }

  return finalize(db, counts, dryRun);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * Extract URL + metadata from a member entry. Members come in two shapes:
 *   - bare string: the URL itself.
 *   - object: { url | profileUrl | value, ...rest }. The "rest" goes
 *     into member_metadata_json so the UI's existing tolerance for
 *     inline name/label survives the migration.
 */
function memberUrlAndMeta(member) {
  if (typeof member === 'string') {
    return { url: member.trim(), metadataJson: null };
  }
  if (member && typeof member === 'object' && !Array.isArray(member)) {
    const url = pickString(member.url) || pickString(member.profileUrl) || pickString(member.value);
    if (!url) return { url: '', metadataJson: null };
    // Strip the URL-bearing keys; whatever else is there → metadata.
    const { url: _u, profileUrl: _p, value: _v, ...rest } = member;
    const metadataJson = Object.keys(rest).length ? JSON.stringify(rest) : null;
    return { url, metadataJson };
  }
  return { url: '', metadataJson: null };
}

function finalize(db, counts, dryRun) {
  if (dryRun) return counts;
  const totalThisRun = counts.importedGroups + counts.importedMembers;
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
  importGroups
};
