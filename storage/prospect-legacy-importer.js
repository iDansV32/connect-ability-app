'use strict';

/**
 * storage/prospect-legacy-importer.js
 *
 * One-time idempotent import of the legacy prospect-queue.json flat file into
 * the SQLite `prospects` table.
 *
 * Idempotency: skips the import entirely when the prospects table already
 * contains rows — so calling this on every startup is safe.
 *
 * Transactional: all rows are inserted inside a single SQLite transaction via
 * SqliteProspectRepository.importLegacy(); a failure rolls back the whole set.
 *
 * Usage (main.js):
 *   const { importProspects } = require('./storage/prospect-legacy-importer');
 *   const result = importProspects(db, {
 *     storePath: resolveInternalStatePath('prospect-queue.json')
 *   });
 *   // result → { imported: boolean, count: number }
 */

const { readJsonFile } = require('../connect-documents');
const SqliteProspectRepository = require('./sqlite-prospect-repository');
const { normalizeProfileUrl } = require('../automation/url/normalize');

/**
 * Import prospects from legacy JSON into SQLite.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} options
 * @param {string} options.storePath  Path to prospect-queue.json
 * @returns {{ imported: boolean, count: number }}
 */
function importProspects(db, { storePath }) {
  const repo = new SqliteProspectRepository(db);

  // Idempotency guard — skip if already populated
  if (repo.count() > 0) {
    return { imported: false, count: 0 };
  }

  const store = readJsonFile(storePath, { prospects: [] });
  const prospects = Array.isArray(store.prospects) ? store.prospects : [];
  if (!prospects.length) {
    return { imported: false, count: 0 };
  }

  // normalizeProspectRecord is duplicated inline here to avoid a circular dep
  // on prospect-queue-store.js.  We only need enough to produce valid rows.
  const normalized = prospects.map((p) => normalizeForImport(p));
  repo.importLegacy(normalized);

  return { imported: true, count: normalized.length };
}

// ---------------------------------------------------------------------------
// Minimal normaliser for import — mirrors the relevant parts of
// normalizeProspectCandidate in prospect-queue-store.js.
// ---------------------------------------------------------------------------

function normalizeForImport(p) {
  const now = new Date().toISOString();
  const normalizedProfileUrl = normalizeProfileUrl(p.profileUrl || p.normalizedProfileUrl);
  const sources = Array.isArray(p.sources) ? p.sources : [];
  const dedupeKeys = Array.isArray(p.dedupeKeys) ? p.dedupeKeys : [];
  const metrics = p.metrics && typeof p.metrics === 'object' ? p.metrics : {};
  const metadata = p.metadata && typeof p.metadata === 'object' ? p.metadata : {};

  return {
    id:                   p.id || require('../connect-documents').createId('prospect'),
    accountId:            p.accountId    || null,
    accountName:          p.accountName  || null,
    agentId:              p.agentId      || null,
    agentName:            p.agentName    || null,
    fullName:             p.fullName     || null,
    title:                p.title        || p.headline || null,
    company:              p.company      || null,
    profileUrl:           p.profileUrl   || null,
    normalizedProfileUrl: normalizedProfileUrl || null,
    rawTarget:            p.rawTarget    || p.profileUrl || p.fullName || null,
    state:                normalizeState(p.state || p.prospect_state),
    sourceType:           p.sourceType   || p.source || 'unknown',
    sourceId:             p.sourceId     || null,
    sourceLabel:          p.sourceLabel  || null,
    sources,
    dedupeKeys,
    metrics,
    workflowAssignment:   p.workflowAssignment || null,
    metadata,
    score:                p.score !== null && p.score !== undefined ? Number(p.score) : null,
    scoreUpdatedAt:       p.scoreUpdatedAt || null,
    scoreBreakdown:       p.scoreBreakdown || null,
    firstSeenAt:          p.firstSeenAt  || p.createdAt || now,
    lastSeenAt:           p.lastSeenAt   || p.updatedAt || now,
    lastActionAt:         p.lastActionAt || null,
    lastReplyAt:          p.lastReplyAt  || null,
    createdAt:            p.createdAt    || now,
    updatedAt:            p.updatedAt    || now
  };
}

const ALLOWED_STATES = new Set([
  'discovered', 'queued', 'active', 'completed', 'failed', 'responded', 'paused', 'archived'
]);

function normalizeState(value) {
  const s = String(value || '').toLowerCase().trim();
  return ALLOWED_STATES.has(s) ? s : 'discovered';
}

module.exports = { importProspects };
