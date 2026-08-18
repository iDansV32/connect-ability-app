'use strict';

// Required by updateById's in-transaction normalization. The legacy importer
// already requires this same export, so the dependency direction is
// established (storage/ may import from the root store; the store does not
// import the SQLite repo by name — it accepts one via constructor injection,
// so no cycle).
const { _private: { normalizePostRecord } } = require('../scheduled-post-store');

/**
 * SqliteScheduledPostRepository
 *
 * Storage backend for ScheduledPostStore when SQLite is available.
 *
 * API parity is intentional: same readAll / replaceAll / replaceForAccount
 * semantics as the JSON-backed store, so the public ScheduledPostStore
 * doesn't change. The two writes wrap a DELETE+INSERT-all in a single
 * `db.transaction()` so the "replace-as-a-set" semantics stay atomic.
 *
 * Why not UPSERT-by-id? The store's public API is "give me the new full set,
 * I'll persist it." There is no per-row update path in current callers. An
 * UPSERT-with-delete-orphans approach would require tracking which rows
 * survived between snapshots, which the existing callers don't compute.
 * Replicating the JSON semantic of "wipe + insert" keeps behavior identical.
 *
 * The `account_id` index supports the per-account DELETE in
 * replacePostsForAccount; no other queries use indexed predicates today.
 */

const COLUMNS = Object.freeze([
  'id',
  'account_id',
  'account_name',
  'agent_id',
  'agent_name',
  'status',
  'scheduled_date',
  'scheduled_time',
  'created_at',
  'published_at',
  'post_type',
  'visibility',
  'content',
  'error',
  'delivery_strategy',
  'linkedin_resource_key',
  'linkedin_scheduled_at',
  'linkedin_last_synced_at',
  'linkedin_sync_error',
  'hashtags_json',
  'mentions_json',
  'include_image',
  'image_path',
  'source_type',
  'plan_id',
  'plan_name',
  'timezone',
  'content_pillar',
  'content_angle',
  'content_theme',
  'content_brief',
  'content_day'
]);

class SqliteScheduledPostRepository {
  constructor(db) {
    if (!db) throw new Error('SqliteScheduledPostRepository requires a db instance');
    this.db = db;
    this._prep();
  }

  _prep() {
    this._stmtSelectAll = this.db.prepare(
      'SELECT * FROM scheduled_posts'
    );
    this._stmtSelectByAccount = this.db.prepare(
      'SELECT * FROM scheduled_posts WHERE account_id IS ?'
    );
    this._stmtDeleteAll = this.db.prepare(
      'DELETE FROM scheduled_posts'
    );
    // Use `IS ?` so null-target matches account_id IS NULL. SQLite's `=` is
    // strict on NULL and would silently match nothing for the global-scope
    // case (see replacePostsForAccount when targetAccountId is null).
    this._stmtDeleteByAccount = this.db.prepare(
      'DELETE FROM scheduled_posts WHERE account_id IS ?'
    );
    this._stmtInsert = this.db.prepare(`
      INSERT INTO scheduled_posts (
        ${COLUMNS.join(', ')}
      ) VALUES (
        ${COLUMNS.map((col) => '@' + col).join(', ')}
      )
    `);
    this._stmtCount = this.db.prepare(
      'SELECT COUNT(*) AS n FROM scheduled_posts'
    );
    this._stmtSelectById = this.db.prepare(
      'SELECT * FROM scheduled_posts WHERE id = ?'
    );
  }

  readAll() {
    return this._stmtSelectAll.all().map((row) => rowToRecord(row));
  }

  readForAccount(accountId) {
    const normalizedAccountId = normalizeAccountId(accountId);
    return this._stmtSelectByAccount.all(normalizedAccountId).map((row) => rowToRecord(row));
  }

  /**
   * Replace the entire table contents with the provided posts atomically.
   * Caller is responsible for normalizing each post first (the JSON store
   * does this via normalizePostRecord). The repo trusts the normalized
   * shape — it does not re-validate fields.
   *
   * @param {object[]} posts already-normalized post records
   */
  replaceAll(posts = []) {
    if (!Array.isArray(posts)) {
      throw new Error('Scheduled posts payload must be an array');
    }
    if (posts.length > 1000) {
      throw new Error('Scheduled posts payload exceeds the maximum of 1000 posts');
    }

    const rows = posts.map((post) => recordToRow(post));
    const stmtDeleteAll = this._stmtDeleteAll;
    const stmtInsert = this._stmtInsert;

    this.db.transaction(() => {
      stmtDeleteAll.run();
      for (const row of rows) {
        stmtInsert.run(row);
      }
    })();
  }

  /**
   * Replace only the rows belonging to a single accountId (or only the
   * null-account rows when targetAccountId is null), preserving rows on
   * other accounts. Mirrors ScheduledPostStore.replacePostsForAccount's
   * semantics exactly.
   *
   * Caller is responsible for ensuring each post in `posts` has had its
   * accountId normalized to `targetAccountId` already (the JSON store does
   * this in normalizePostRecord; the SQLite store keeps the same flow).
   *
   * @param {string|null} targetAccountId normalized account id, or null
   * @param {object[]} posts already-normalized post records scoped to targetAccountId
   */
  replaceForAccount(targetAccountId, posts = []) {
    if (!Array.isArray(posts)) {
      throw new Error('Scheduled posts payload must be an array');
    }
    const normalizedTargetAccountId = normalizeAccountId(targetAccountId);

    const rows = posts.map((post) => recordToRow(post));
    const stmtDeleteByAccount = this._stmtDeleteByAccount;
    const stmtCount = this._stmtCount;
    const stmtInsert = this._stmtInsert;

    this.db.transaction(() => {
      // 1) Wipe target-account rows. Uses IS so null targets match null rows.
      stmtDeleteByAccount.run(normalizedTargetAccountId);
      // 2) Insert the new set.
      for (const row of rows) {
        stmtInsert.run(row);
      }
      // 3) Enforce the same 1000-post cap the JSON store enforces. We check
      //    after insert so the cap reflects the total across all accounts
      //    (which is what JSON store guards). Throwing here aborts the
      //    transaction so the prior state is preserved.
      const { n } = stmtCount.get();
      if (n > 1000) {
        throw new Error('Scheduled posts payload exceeds the maximum of 1000 posts');
      }
    })();
  }

  /**
   * One-shot bulk insert used by the legacy importer. Skips the transaction
   * (caller wraps in its own) and the count cap (importer reports its own
   * counts). Do not call from normal write paths.
   *
   * @param {object[]} posts already-normalized post records
   */
  importLegacy(posts = []) {
    const stmtInsert = this._stmtInsert;
    for (const post of posts) {
      stmtInsert.run(recordToRow(post));
    }
  }

  /**
   * Update one post by id with a partial set of fields. Used for granular
   * server-side persistence (e.g. recording linkedInResourceKey after a
   * successful publish) without rewriting the whole table.
   *
   * Throws when the post id does not exist. A missing local row after we
   * already accepted a LinkedIn schedule is a real consistency problem;
   * failing loudly is better than losing the resourceKey to a silent no-op.
   *
   * Wrapped in db.transaction() so a partial update can't leave torn state
   * (atomic at SQLite level even though it's a single UPDATE — the
   * transaction also gives us the readback-after-write semantics for the
   * returned record).
   *
   * @param {string} postId
   * @param {object} partial fields to update (in record/camelCase shape,
   *                         same shape ScheduledPostStore consumers see)
   * @returns {object} the updated post record (full normalized shape)
   */
  updateById(postId, partial = {}) {
    if (!postId) throw new Error('postId is required');
    const stmtSelectById = this._stmtSelectById;
    const stmtInsert = this._stmtInsert;
    const stmtDeleteById = this.db.prepare(
      'DELETE FROM scheduled_posts WHERE id = ?'
    );

    return this.db.transaction(() => {
      const existing = stmtSelectById.get(postId);
      if (!existing) {
        throw new Error(`Scheduled post ${postId} not found`);
      }
      // Normalize the merged record INSIDE the transaction so an invalid
      // partial (e.g. unsupported status, missing required field) throws
      // BEFORE any row is written. Without this, the DELETE could fire,
      // the INSERT could fire, and normalizePostRecord in the caller would
      // throw afterwards — leaving the table mutated with an invalid row.
      // Throwing inside db.transaction() rolls back the DELETE atomically.
      const merged = normalizePostRecord({ ...rowToRecord(existing), ...partial, id: postId });
      // DELETE + INSERT keeps us using the existing prepared INSERT statement
      // (one source of truth for column ordering). For a single-row swap
      // inside a transaction this is equivalent to UPDATE and avoids drift
      // between two prepared statements that would need parallel maintenance.
      stmtDeleteById.run(postId);
      stmtInsert.run(recordToRow(merged));
      return merged;
    })();
  }

  /**
   * Returns total row count. Used by the legacy importer's idempotency guard
   * (skip import when table already has rows).
   */
  count() {
    return this._stmtCount.get().n;
  }
}

// ---------------------------------------------------------------------------
// Row <-> record translation
// ---------------------------------------------------------------------------

function normalizeAccountId(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

function recordToRow(post = {}) {
  return {
    id: post.id || null,
    account_id: post.accountId || null,
    account_name: post.accountName || null,
    agent_id: post.agentId || null,
    agent_name: post.agentName || null,
    status: post.status || 'pending',
    scheduled_date: post.scheduledDate || null,
    scheduled_time: post.scheduledTime || null,
    created_at: post.createdAt || new Date().toISOString(),
    published_at: post.publishedAt || null,
    post_type: post.postType || 'text',
    visibility: post.visibility || 'public',
    content: post.content || '',
    error: post.error || null,
    delivery_strategy: post.deliveryStrategy || null,
    linkedin_resource_key: post.linkedInResourceKey || null,
    linkedin_scheduled_at: post.linkedInScheduledAt || null,
    linkedin_last_synced_at: post.linkedInLastSyncedAt || null,
    linkedin_sync_error: post.linkedInSyncError || null,
    hashtags_json: JSON.stringify(Array.isArray(post.hashtags) ? post.hashtags : []),
    mentions_json: JSON.stringify(Array.isArray(post.mentions) ? post.mentions : []),
    include_image: post.includeImage ? 1 : 0,
    image_path: post.imagePath || null,
    source_type: post.sourceType || null,
    plan_id: post.planId || null,
    plan_name: post.planName || null,
    timezone: post.timezone || null,
    content_pillar: post.contentPillar || null,
    content_angle: post.contentAngle || null,
    content_theme: post.contentTheme || null,
    content_brief: post.contentBrief || null,
    content_day: Number.isFinite(Number(post.contentDay)) ? Number(post.contentDay) : null
  };
}

function rowToRecord(row = {}) {
  return {
    id: row.id || null,
    accountId: row.account_id || null,
    accountName: row.account_name || null,
    agentId: row.agent_id || null,
    agentName: row.agent_name || null,
    status: row.status || 'pending',
    scheduledDate: row.scheduled_date || null,
    scheduledTime: row.scheduled_time || null,
    createdAt: row.created_at || null,
    publishedAt: row.published_at || null,
    postType: row.post_type || 'text',
    visibility: row.visibility || 'public',
    content: row.content || '',
    error: row.error || null,
    deliveryStrategy: row.delivery_strategy || null,
    linkedInResourceKey: row.linkedin_resource_key || null,
    linkedInScheduledAt: row.linkedin_scheduled_at || null,
    linkedInLastSyncedAt: row.linkedin_last_synced_at || null,
    linkedInSyncError: row.linkedin_sync_error || null,
    hashtags: parseJsonArray(row.hashtags_json),
    mentions: parseJsonArray(row.mentions_json),
    includeImage: Boolean(row.include_image),
    imagePath: row.image_path || null,
    sourceType: row.source_type || null,
    planId: row.plan_id || null,
    planName: row.plan_name || null,
    timezone: row.timezone || null,
    contentPillar: row.content_pillar || null,
    contentAngle: row.content_angle || null,
    contentTheme: row.content_theme || null,
    contentBrief: row.content_brief || null,
    contentDay: row.content_day === null || row.content_day === undefined
      ? null
      : Number(row.content_day)
  };
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

module.exports = SqliteScheduledPostRepository;
