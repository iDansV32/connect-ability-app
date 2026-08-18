'use strict';

/**
 * storage/health-legacy-importer.js
 *
 * One-time, idempotent migration helpers that seed SQLite tables from the
 * existing JSON / JSONL files on the first startup after Ticket 6.
 *
 * Each function is a no-op when the target table already contains rows
 * (idempotency guard identical to workflow-legacy-importer).
 */

const fs = require('fs');

const SqliteActivityEventRepository = require('./sqlite-activity-event-repository');
const SqliteAccountHealthRepository = require('./sqlite-account-health-repository');

// ---------------------------------------------------------------------------
// Activity events — from activity-events.jsonl
// ---------------------------------------------------------------------------

/**
 * Import activity events from the legacy JSONL file into SQLite.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ eventsPath: string }} opts
 * @returns {{ imported: boolean, count: number }}
 */
function importActivityEvents(db, { eventsPath }) {
  // Idempotency guard: skip if table already has rows.
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM activity_events').get();
  if (n > 0) {
    return { imported: false, count: 0 };
  }

  if (!eventsPath || !fs.existsSync(eventsPath)) {
    return { imported: false, count: 0 };
  }

  const lines = fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch (_) {
      // Skip malformed lines.
    }
  }

  if (events.length === 0) {
    return { imported: false, count: 0 };
  }

  const repo = new SqliteActivityEventRepository(db);
  const count = repo.importLegacy(events);
  return { imported: true, count };
}

// ---------------------------------------------------------------------------
// LinkedIn account health — from linkedin-account-health.json
// ---------------------------------------------------------------------------

/**
 * Import LinkedIn account health records from the legacy JSON file.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ storePath: string }} opts
 * @returns {{ imported: boolean, count: number }}
 */
function importAccountHealth(db, { storePath }) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM linkedin_account_health').get();
  if (n > 0) {
    return { imported: false, count: 0 };
  }

  if (!storePath || !fs.existsSync(storePath)) {
    return { imported: false, count: 0 };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch (_) {
    return { imported: false, count: 0 };
  }

  const accountsMap = raw?.accounts;
  if (!accountsMap || typeof accountsMap !== 'object' || Array.isArray(accountsMap)) {
    return { imported: false, count: 0 };
  }

  const accountCount = Object.keys(accountsMap).length;
  if (accountCount === 0) {
    return { imported: false, count: 0 };
  }

  const repo = new SqliteAccountHealthRepository(db);
  repo.importLegacy(accountsMap);
  return { imported: true, count: accountCount };
}

module.exports = { importActivityEvents, importAccountHealth };
