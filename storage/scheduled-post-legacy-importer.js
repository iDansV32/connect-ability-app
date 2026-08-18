'use strict';

/**
 * storage/scheduled-post-legacy-importer.js
 *
 * One-time idempotent import of the legacy scheduled-posts.json flat file
 * into the SQLite `scheduled_posts` table.
 *
 * Idempotency: skips the import entirely when the scheduled_posts table
 * already contains rows — so calling this on every startup is safe.
 *
 * Transactional: all rows are inserted inside a single SQLite transaction.
 * Malformed rows (rejected by normalizePostRecord) are counted as skipped
 * rather than aborting the whole import, since this is a best-effort
 * migration from a less-strict JSON shape.
 *
 * Duplicate-id dedup: SQLite has `id PRIMARY KEY` on scheduled_posts, but
 * legacy JSON historically allowed duplicate ids (no constraint).
 * Re-inserting the same id would throw inside the transaction and abort
 * the whole import — bad for a best-effort migration. We skip duplicates
 * and surface a sub-count in the result so an operator can see whether
 * any rows were dropped.
 *
 * Usage (main.js):
 *   const { importScheduledPosts } = require('./storage/scheduled-post-legacy-importer');
 *   const result = importScheduledPosts(db, {
 *     storePath: resolveInternalStatePath('scheduled-posts.json')
 *   });
 *   // result → { imported, count, skipped, skippedDuplicates }
 *   //   skipped:           total rows not imported (malformed + duplicates)
 *   //   skippedDuplicates: subset of skipped due to id collision
 */

const { readJsonFile } = require('../connect-documents');
const SqliteScheduledPostRepository = require('./sqlite-scheduled-post-repository');
const { _private: { normalizePostRecord } } = require('../scheduled-post-store');

/**
 * Import scheduled posts from legacy JSON into SQLite.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} options
 * @param {string} options.storePath  Path to scheduled-posts.json
 * @returns {{ imported: boolean, count: number, skipped: number, skippedDuplicates: number }}
 */
function importScheduledPosts(db, { storePath }) {
  const repo = new SqliteScheduledPostRepository(db);

  // Idempotency guard — skip if the table already has rows.
  if (repo.count() > 0) {
    return { imported: false, count: 0, skipped: 0, skippedDuplicates: 0 };
  }

  const store = readJsonFile(storePath, { posts: [] });
  const rawPosts = Array.isArray(store.posts) ? store.posts : [];
  if (!rawPosts.length) {
    return { imported: false, count: 0, skipped: 0, skippedDuplicates: 0 };
  }

  const normalized = [];
  // Track ids that have already been queued for insert. First occurrence
  // wins — subsequent duplicates are dropped and counted. "First wins" is
  // deliberate: scheduled-post records have a `createdAt` field but no
  // monotonic ordering guarantee in the legacy JSON, so picking a winner
  // by some other criterion would be guessing. The first occurrence in
  // file order is the simplest deterministic choice and matches how a
  // human reading the file would resolve the conflict.
  const seenIds = new Set();
  let skipped = 0;
  let skippedDuplicates = 0;
  for (const raw of rawPosts) {
    let record;
    try {
      record = normalizePostRecord(raw);
    } catch (_err) {
      // normalizePostRecord throws on missing required fields (content, etc.)
      // or unsupported status. For a best-effort migration we drop the row
      // rather than abort the whole import.
      skipped += 1;
      continue;
    }
    // normalizePostRecord generates a new id when the input doesn't carry
    // one (see createId('post') fallback), so a "duplicate id" here only
    // happens when the legacy JSON itself had a real collision. The
    // generated-id case can't collide with anything because createId
    // produces a fresh value.
    if (seenIds.has(record.id)) {
      skipped += 1;
      skippedDuplicates += 1;
      continue;
    }
    seenIds.add(record.id);
    normalized.push(record);
  }

  if (!normalized.length) {
    return { imported: false, count: 0, skipped, skippedDuplicates };
  }

  // Wrap in a single transaction so the import is atomic.
  db.transaction(() => {
    repo.importLegacy(normalized);
  })();

  return { imported: true, count: normalized.length, skipped, skippedDuplicates };
}

module.exports = { importScheduledPosts };
