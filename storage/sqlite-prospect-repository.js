'use strict';

/**
 * storage/sqlite-prospect-repository.js
 *
 * SQLite backend for the prospects table.  Provides targeted read/write
 * operations that replace ProspectQueueStore's full-file JSON load/save cycle.
 *
 * Dedupe strategy (mirrors findProspectIndex in prospect-queue-store.js):
 *   1. Exact ID match — SELECT by id
 *   2. URL match     — SELECT by (account_id, normalized_profile_url)
 *   3. Key match     — SELECT by accountId, filter dedupe_keys_json in-memory
 *      (edge case — most prospects have a LinkedIn URL; falls back to a small
 *       per-account in-memory filter rather than a full-table scan)
 *
 * The `headline` column in the schema maps to the `title` field in JS objects
 * (the schema was scaffolded before the JS field name was settled).
 */

function safeParseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

// ---------------------------------------------------------------------------
// Row ↔ JS prospect object
// ---------------------------------------------------------------------------

function prospectToRow(p) {
  const metadata = p.metadata && typeof p.metadata === 'object' ? p.metadata : {};
  return {
    id:                       p.id,
    account_id:               p.accountId               || null,
    account_name:             p.accountName             || null,
    agent_id:                 p.agentId                 || null,
    agent_name:               p.agentName               || null,
    full_name:                p.fullName                || null,
    headline:                 p.title                   || null,
    company:                  p.company                 || null,
    profile_url:              p.profileUrl              || null,
    normalized_profile_url:   p.normalizedProfileUrl    || null,
    raw_target:               p.rawTarget               || null,
    prospect_state:           p.state                   || 'discovered',
    source:                   p.sourceType              || 'unknown',
    source_id:                p.sourceId                || null,
    source_label:             p.sourceLabel             || null,
    sources_json:             JSON.stringify(Array.isArray(p.sources)    ? p.sources    : []),
    dedupe_keys_json:         JSON.stringify(Array.isArray(p.dedupeKeys) ? p.dedupeKeys : []),
    metrics_json:             JSON.stringify(p.metrics  && typeof p.metrics === 'object' ? p.metrics : {}),
    workflow_assignment_json: p.workflowAssignment      ? JSON.stringify(p.workflowAssignment) : null,
    metadata_json:            Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    score:                    (p.score !== null && p.score !== undefined) ? Number(p.score) : null,
    score_updated_at:         p.scoreUpdatedAt          || null,
    score_breakdown_json:     p.scoreBreakdown          ? JSON.stringify(p.scoreBreakdown) : null,
    archived:                 p.state === 'archived'    ? 1 : 0,
    do_not_contact:           metadata.doNotContact     ? 1 : 0,
    unsubscribed_at:          metadata.unsubscribedAt   || null,
    archive_reason:           metadata.archiveReason    || null,
    first_seen_at:            p.firstSeenAt             || null,
    last_seen_at:             p.lastSeenAt              || null,
    last_action_at:           p.lastActionAt            || null,
    last_reply_at:            p.lastReplyAt             || null,
    // Phase A profile-identity columns (roadmap #7).
    first_name:               p.firstName               || null,
    last_name:                p.lastName                || null,
    raw_headline:             p.rawHeadline             || null,
    company_domain:           p.companyDomain           || null,
    primary_email:            p.primaryEmail            || null,
    suggested_emails_json:    Array.isArray(p.suggestedEmails) ? JSON.stringify(p.suggestedEmails) : null,
    first_interaction_at:     p.firstInteractionAt      || null,
    last_interaction_at:      p.lastInteractionAt       || null,
    created_at:               p.createdAt               || new Date().toISOString(),
    updated_at:               p.updatedAt               || new Date().toISOString()
  };
}

function rowToProspect(row) {
  return {
    id:                   row.id,
    accountId:            row.account_id               || null,
    accountName:          row.account_name             || null,
    agentId:              row.agent_id                 || null,
    agentName:            row.agent_name               || null,
    fullName:             row.full_name                || null,
    title:                row.headline                 || null,
    company:              row.company                  || null,
    profileUrl:           row.profile_url              || null,
    normalizedProfileUrl: row.normalized_profile_url   || null,
    rawTarget:            row.raw_target               || null,
    state:                row.prospect_state           || 'discovered',
    sourceType:           row.source                   || 'unknown',
    sourceId:             row.source_id                || null,
    sourceLabel:          row.source_label             || null,
    sources:              safeParseJson(row.sources_json,             []),
    dedupeKeys:           safeParseJson(row.dedupe_keys_json,         []),
    metrics:              safeParseJson(row.metrics_json,             {}),
    workflowAssignment:   safeParseJson(row.workflow_assignment_json, null),
    metadata:             safeParseJson(row.metadata_json,            {}),
    score:                (row.score !== null && row.score !== undefined) ? Number(row.score) : null,
    scoreUpdatedAt:       row.score_updated_at         || null,
    scoreBreakdown:       safeParseJson(row.score_breakdown_json,     null),
    firstSeenAt:          row.first_seen_at            || null,
    lastSeenAt:           row.last_seen_at             || null,
    lastActionAt:         row.last_action_at           || null,
    lastReplyAt:          row.last_reply_at            || null,
    // Phase A profile-identity columns (roadmap #7).
    firstName:            row.first_name               || null,
    lastName:             row.last_name                || null,
    rawHeadline:          row.raw_headline             || null,
    companyDomain:        row.company_domain           || null,
    primaryEmail:         row.primary_email            || null,
    suggestedEmails:      safeParseJson(row.suggested_emails_json, null),
    firstInteractionAt:   row.first_interaction_at     || null,
    lastInteractionAt:    row.last_interaction_at      || null,
    createdAt:            row.created_at,
    updatedAt:            row.updated_at
  };
}

// ---------------------------------------------------------------------------

class SqliteProspectRepository {
  constructor(db) {
    this._db = db;
  }

  /**
   * Find a prospect by its stable ID.
   * @returns {object|null}
   */
  findById(id) {
    const row = this._db
      .prepare('SELECT * FROM prospects WHERE id = ?')
      .get(id);
    return row ? rowToProspect(row) : null;
  }

  /**
   * Find a prospect by (accountId, normalizedProfileUrl) — the primary dedupe key.
   * @returns {object|null}
   */
  findByNormalizedUrl(accountId, normalizedProfileUrl) {
    if (!normalizedProfileUrl) return null;
    const accountKey = accountId || '__global__';
    const row = this._db
      .prepare(
        'SELECT * FROM prospects WHERE (account_id = ? OR (account_id IS NULL AND ? = \'__global__\')) ' +
        'AND normalized_profile_url = ? LIMIT 1'
      )
      .get(accountKey, accountKey, normalizedProfileUrl);
    return row ? rowToProspect(row) : null;
  }

  /**
   * Find all prospects for an account (used for name/key-based dedupe fallback).
   * Returns a lightweight list — only id + dedupe_keys_json to avoid large deserialisation.
   * @returns {Array<{id, dedupeKeys}>}
   */
  findDedupeKeysByAccount(accountId) {
    const accountKey = accountId || '__global__';
    const rows = this._db
      .prepare(
        'SELECT id, dedupe_keys_json FROM prospects ' +
        'WHERE account_id = ? OR (account_id IS NULL AND ? = \'__global__\')'
      )
      .all(accountKey, accountKey);
    return rows.map((r) => ({
      id: r.id,
      dedupeKeys: safeParseJson(r.dedupe_keys_json, [])
    }));
  }

  /**
   * Find all prospects that share a normalizedProfileUrl across all accounts.
   * Used by getRelatedProspects / getContactOwnershipSummary.
   * @returns {object[]}
   */
  findByRelatedUrl(normalizedProfileUrl) {
    if (!normalizedProfileUrl) return [];
    const rows = this._db
      .prepare('SELECT * FROM prospects WHERE normalized_profile_url = ?')
      .all(normalizedProfileUrl);
    return rows.map(rowToProspect);
  }

  /**
   * Find all prospects whose normalised full_name and company match.
   * Used as a fallback for name-based related-prospect lookup.
   * Comparison is done in-memory after loading candidates (SQLite has no
   * built-in case-insensitive accent normalisation).
   * @returns {object[]}
   */
  findByNameAndCompany(normalizedName, normalizedCompany) {
    if (!normalizedName || !normalizedCompany) return [];
    // Load all then filter; acceptable because this path is rare (no profile URL).
    const rows = this._db.prepare('SELECT * FROM prospects').all();
    return rows
      .map(rowToProspect)
      .filter((p) => {
        return normalizeComparableText(p.fullName) === normalizedName
          && normalizeComparableText(p.company) === normalizedCompany;
      });
  }

  /**
   * Return all prospects matching optional filters.
   * @param {object} [filters]
   * @param {string} [filters.accountId]
   * @param {string} [filters.agentId]
   * @param {string} [filters.state]
   * @param {string} [filters.workflowId]  — post-filter (stored in workflow_assignment_json)
   * @returns {object[]}
   */
  findAll(filters = {}) {
    const conditions = [];
    const params = [];

    if (filters.accountId) {
      conditions.push('account_id = ?');
      params.push(filters.accountId);
    }
    if (filters.agentId) {
      conditions.push('agent_id = ?');
      params.push(filters.agentId);
    }
    if (filters.state) {
      conditions.push('prospect_state = ?');
      params.push(filters.state);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this._db
      .prepare(`SELECT * FROM prospects ${where} ORDER BY updated_at DESC`)
      .all(...params);

    const prospects = rows.map(rowToProspect);

    // workflowId filter requires parsing JSON — do it in-memory
    if (filters.workflowId) {
      return prospects.filter(
        (p) => p.workflowAssignment && p.workflowAssignment.workflowId === filters.workflowId
      );
    }
    return prospects;
  }

  /**
   * Insert or replace a prospect row.
   * @param {object} prospect — normalised prospect object
   */
  upsert(prospect) {
    const row = prospectToRow(prospect);
    this._db.prepare(`
      INSERT INTO prospects (
        id, account_id, account_name, agent_id, agent_name,
        full_name, headline, company, profile_url, normalized_profile_url, raw_target,
        prospect_state, source, source_id, source_label,
        sources_json, dedupe_keys_json, metrics_json,
        workflow_assignment_json, metadata_json,
        score, score_updated_at, score_breakdown_json,
        archived, do_not_contact, unsubscribed_at, archive_reason,
        first_seen_at, last_seen_at, last_action_at, last_reply_at,
        first_name, last_name, raw_headline, company_domain,
        primary_email, suggested_emails_json,
        first_interaction_at, last_interaction_at,
        created_at, updated_at
      ) VALUES (
        @id, @account_id, @account_name, @agent_id, @agent_name,
        @full_name, @headline, @company, @profile_url, @normalized_profile_url, @raw_target,
        @prospect_state, @source, @source_id, @source_label,
        @sources_json, @dedupe_keys_json, @metrics_json,
        @workflow_assignment_json, @metadata_json,
        @score, @score_updated_at, @score_breakdown_json,
        @archived, @do_not_contact, @unsubscribed_at, @archive_reason,
        @first_seen_at, @last_seen_at, @last_action_at, @last_reply_at,
        @first_name, @last_name, @raw_headline, @company_domain,
        @primary_email, @suggested_emails_json,
        @first_interaction_at, @last_interaction_at,
        @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        account_id               = excluded.account_id,
        account_name             = excluded.account_name,
        agent_id                 = excluded.agent_id,
        agent_name               = excluded.agent_name,
        full_name                = excluded.full_name,
        headline                 = excluded.headline,
        company                  = excluded.company,
        profile_url              = excluded.profile_url,
        normalized_profile_url   = excluded.normalized_profile_url,
        raw_target               = excluded.raw_target,
        prospect_state           = excluded.prospect_state,
        source                   = excluded.source,
        source_id                = excluded.source_id,
        source_label             = excluded.source_label,
        sources_json             = excluded.sources_json,
        dedupe_keys_json         = excluded.dedupe_keys_json,
        metrics_json             = excluded.metrics_json,
        workflow_assignment_json = excluded.workflow_assignment_json,
        metadata_json            = excluded.metadata_json,
        score                    = excluded.score,
        score_updated_at         = excluded.score_updated_at,
        score_breakdown_json     = excluded.score_breakdown_json,
        archived                 = excluded.archived,
        do_not_contact           = excluded.do_not_contact,
        unsubscribed_at          = excluded.unsubscribed_at,
        archive_reason           = excluded.archive_reason,
        first_seen_at            = excluded.first_seen_at,
        last_seen_at             = excluded.last_seen_at,
        last_action_at           = excluded.last_action_at,
        last_reply_at            = excluded.last_reply_at,
        first_name               = excluded.first_name,
        last_name                = excluded.last_name,
        raw_headline             = excluded.raw_headline,
        company_domain           = excluded.company_domain,
        primary_email            = excluded.primary_email,
        suggested_emails_json    = excluded.suggested_emails_json,
        first_interaction_at     = excluded.first_interaction_at,
        last_interaction_at      = excluded.last_interaction_at,
        created_at               = excluded.created_at,
        updated_at               = excluded.updated_at
    `).run(row);
  }

  /**
   * Bulk-upsert an array of prospects inside a single transaction.
   * Used by the legacy importer.
   * @param {object[]} prospects
   */
  importLegacy(prospects) {
    const doImport = this._db.transaction(() => {
      for (const p of prospects) {
        this.upsert(p);
      }
    });
    doImport();
  }

  /**
   * Count all rows — used for the idempotency guard in the importer.
   * @returns {number}
   */
  count() {
    return this._db.prepare('SELECT COUNT(*) AS n FROM prospects').get().n;
  }
}

// ---------------------------------------------------------------------------
// Shared text normaliser (mirrors the same function in prospect-queue-store.js)
// ---------------------------------------------------------------------------

function normalizeComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, '')
    .replace(/linkedin\.com\/in\//g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

module.exports = SqliteProspectRepository;
