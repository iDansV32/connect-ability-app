const {
  createId,
  getConnectAbilityAppStateDir,
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('./connect-documents');

const STORE_VERSION = 1;
const ALLOWED_POST_STATUSES = new Set(['pending', 'publishing', 'scheduled', 'published', 'failed', 'cancelled']);
const ALLOWED_POST_TYPES = new Set(['text', 'image']);
const ALLOWED_VISIBILITY = new Set(['public', 'connections', 'private']);

class ScheduledPostStore {
  constructor(options = {}) {
    this.documentsDir = options.documentsDir || getConnectAbilityAppStateDir();
    this.storePath = options.storePath || resolveInternalStatePath('scheduled-posts.json');
    // Optional SQLite-backed repo. When present, the JSON path is bypassed
    // entirely — readStore/getAllPosts/replaceAllPosts/replacePostsForAccount
    // all route through the repo's atomic transaction-backed operations.
    // See storage/sqlite-scheduled-post-repository.js for the repo contract.
    this.repo = options.repo || null;
  }

  getAllPosts(filters = {}) {
    const normalizedFilters = normalizePostFilters(filters);
    const rawPosts = this.repo
      ? this.repo.readAll()
      : this.readStore().posts;
    return rawPosts
      .map((post) => normalizePostRecord(post))
      .filter((post) => matchesPostFilters(post, normalizedFilters))
      .sort((left, right) => {
        const leftTime = resolveSortTime(left);
        const rightTime = resolveSortTime(right);
        return leftTime - rightTime;
      });
  }

  replaceAllPosts(posts = []) {
    if (!Array.isArray(posts)) {
      throw new Error('Scheduled posts payload must be an array');
    }

    if (posts.length > 1000) {
      throw new Error('Scheduled posts payload exceeds the maximum of 1000 posts');
    }

    const normalized = posts.map((post) => normalizePostRecord(post));

    if (this.repo) {
      this.repo.replaceAll(normalized);
      return normalized;
    }

    const store = {
      version: STORE_VERSION,
      posts: normalized
    };
    writeJsonFileAtomic(this.storePath, store);
    return store.posts;
  }

  replacePostsForAccount(accountId = null, posts = [], options = {}) {
    if (!Array.isArray(posts)) {
      throw new Error('Scheduled posts payload must be an array');
    }

    const normalizedAccountId = cleanString(accountId, 120) || null;
    const normalizedAccountName = cleanString(options.accountName, 160) || null;

    // Same accountId normalization both backends share: incoming posts get
    // their accountId rewritten to the target. Mismatched accountIds in the
    // payload are silently corrected — matches the long-standing JSON
    // behavior and the repo contract documented in
    // sqlite-scheduled-post-repository.js#replaceForAccount.
    const scopedPosts = posts.map((post) => normalizePostRecord({
      ...post,
      accountId: normalizedAccountId || cleanString(post.accountId, 120) || null,
      accountName: normalizedAccountName || cleanString(post.accountName, 160) || null
    }));

    if (this.repo) {
      // The repo's replaceForAccount enforces the 1000-post cap inside the
      // transaction so total count stays consistent with the JSON store's
      // pre-write guard.
      this.repo.replaceForAccount(normalizedAccountId, scopedPosts);
      // The full set of posts (including other-account rows the repo
      // preserved) is what callers expect. Re-read after the transaction
      // commits.
      return this.repo.readAll().map((post) => normalizePostRecord(post));
    }

    const existingPosts = this.readStore().posts.map((post) => normalizePostRecord(post));
    const preservedPosts = existingPosts.filter((post) => {
      const postAccountId = cleanString(post.accountId, 120) || null;
      if (normalizedAccountId) {
        return postAccountId !== normalizedAccountId;
      }
      return Boolean(postAccountId);
    });
    const mergedPosts = [...preservedPosts, ...scopedPosts];

    if (mergedPosts.length > 1000) {
      throw new Error('Scheduled posts payload exceeds the maximum of 1000 posts');
    }

    const store = {
      version: STORE_VERSION,
      posts: mergedPosts
    };
    writeJsonFileAtomic(this.storePath, store);
    return store.posts;
  }

  /**
   * Update one post by id with a partial set of fields. Granular alternative
   * to replaceAllPosts / replacePostsForAccount for single-row state updates
   * (recording a linkedInResourceKey post-publish, marking a status
   * transition, etc.) without rewriting the whole table.
   *
   * Throws when postId does not exist. A missing local row after a write
   * path has been driven by an external success signal (e.g. LinkedIn
   * already accepted the schedule and returned a resourceKey) is a real
   * consistency problem; failing loudly here surfaces it.
   *
   * Behavior is normalized across backends:
   *   • SQLite path: delegates to SqliteScheduledPostRepository.updateById,
   *     which wraps the change in db.transaction() for atomicity.
   *   • JSON path: read-merge-write through the existing readStore /
   *     writeJsonFileAtomic pattern, same as replaceAllPosts.
   *
   * @param {string} postId
   * @param {object} partial fields to merge into the post record
   * @returns {object} the updated, fully-normalized post record
   */
  updatePostFields(postId, partial = {}) {
    // Normalize the postId once at the public boundary so both backends
    // see the same lookup key. Without this, a whitespace-padded id like
    // ' p1 ' resolves correctly via the JSON path (which already
    // cleanString'd both sides of the comparison) but misses the SQLite
    // path (which compares raw values against the indexed PK).
    const normalizedPostId = cleanString(postId, 160);
    if (!normalizedPostId) throw new Error('postId is required');
    if (!partial || typeof partial !== 'object') {
      throw new Error('partial fields object is required');
    }

    if (this.repo) {
      // SQLite path. The repo normalizes the merged record INSIDE its
      // transaction so an invalid partial rolls back atomically. Already
      // normalized here too — defensive but cheap.
      const updated = this.repo.updateById(normalizedPostId, partial);
      return normalizePostRecord(updated);
    }

    // JSON path. Read all, find by id, merge, normalize, write back. Throws
    // on missing id to match the SQLite path's behavior.
    const store = this.readStore();
    const index = store.posts.findIndex((post) => {
      return cleanString(post.id, 160) === normalizedPostId;
    });
    if (index === -1) {
      throw new Error(`Scheduled post ${normalizedPostId} not found`);
    }
    const merged = normalizePostRecord({
      ...store.posts[index],
      ...partial,
      id: normalizedPostId
    });
    store.posts[index] = merged;
    writeJsonFileAtomic(this.storePath, {
      version: STORE_VERSION,
      posts: store.posts
    });
    return merged;
  }

  readStore() {
    // When the SQLite repo is injected, the JSON file is no longer the
    // source of truth — reading it would return stale data and recreate the
    // split-backend trap this store was migrated to avoid. Route through
    // the repo so every public method (getAllPosts, replaceAll, replacePostsForAccount,
    // readStore) sees the same canonical state.
    if (this.repo) {
      return {
        version: STORE_VERSION,
        posts: this.repo.readAll().map((post) => normalizePostRecord(post))
      };
    }
    const fallback = { version: STORE_VERSION, posts: [] };
    const store = readJsonFile(this.storePath, fallback);
    return {
      version: STORE_VERSION,
      posts: Array.isArray(store.posts) ? store.posts : []
    };
  }
}

function normalizePostRecord(post = {}) {
  const content = cleanMultiline(post.content, 3000);
  if (!content) {
    throw new Error('Scheduled post content is required');
  }

  const scheduledDate = cleanString(post.scheduledDate, 32) || null;
  const scheduledTime = cleanString(post.scheduledTime, 32) || null;
  if ((scheduledDate && !scheduledTime) || (!scheduledDate && scheduledTime)) {
    throw new Error('Scheduled posts require both date and time when either field is provided');
  }

  const status = cleanString(post.status, 40).toLowerCase() || 'pending';
  if (!ALLOWED_POST_STATUSES.has(status)) {
    throw new Error(`Unsupported scheduled post status: ${status}`);
  }

  const postType = cleanString(post.postType, 40).toLowerCase() || 'text';
  const visibility = cleanString(post.visibility, 40).toLowerCase() || 'public';

  return {
    id: cleanString(post.id, 160) || createId('post'),
    content,
    scheduledDate,
    scheduledTime,
    status,
    createdAt: cleanString(post.createdAt, 80) || new Date().toISOString(),
    publishedAt: cleanString(post.publishedAt, 80) || null,
    error: cleanMultiline(post.error, 1200) || null,
    deliveryStrategy: cleanString(post.deliveryStrategy, 80) || null,
    linkedInResourceKey: cleanString(post.linkedInResourceKey, 240) || null,
    linkedInScheduledAt: cleanString(post.linkedInScheduledAt, 80) || null,
    linkedInLastSyncedAt: cleanString(post.linkedInLastSyncedAt, 80) || null,
    linkedInSyncError: cleanMultiline(post.linkedInSyncError, 1200) || null,
    hashtags: normalizeStringList(post.hashtags, 80, 80),
    mentions: normalizeStringList(post.mentions, 80, 80),
    includeImage: Boolean(post.includeImage),
    imagePath: cleanString(post.imagePath, 1200) || null,
    postType: ALLOWED_POST_TYPES.has(postType) ? postType : 'text',
    visibility: ALLOWED_VISIBILITY.has(visibility) ? visibility : 'public',
    accountId: cleanString(post.accountId, 120) || null,
    accountName: cleanString(post.accountName, 160) || null,
    agentId: cleanString(post.agentId, 160) || null,
    agentName: cleanString(post.agentName, 160) || null,
    sourceType: cleanString(post.sourceType, 80) || null,
    planId: cleanString(post.planId, 160) || null,
    planName: cleanString(post.planName, 200) || null,
    timezone: cleanString(post.timezone, 80) || null,
    contentPillar: cleanString(post.contentPillar, 160) || null,
    contentAngle: cleanString(post.contentAngle, 80) || null,
    contentTheme: cleanString(post.contentTheme, 200) || null,
    contentBrief: cleanMultiline(post.contentBrief, 500) || null,
    contentDay: normalizeOptionalInteger(post.contentDay, 1, 365, null)
  };
}

function normalizeStringList(values, maxItems, maxLength) {
  if (!Array.isArray(values)) {
    return [];
  }

  const seen = new Set();
  return values
    .map((value) => cleanString(value, maxLength))
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

function resolveSortTime(post) {
  if (post.scheduledDate && post.scheduledTime) {
    const timestamp = new Date(`${post.scheduledDate}T${post.scheduledTime}`).getTime();
    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }
  }

  const createdAt = new Date(post.createdAt).getTime();
  return Number.isNaN(createdAt) ? 0 : createdAt;
}

function normalizePostFilters(filters = {}) {
  return {
    accountId: cleanString(filters.accountId, 120) || null,
    agentId: cleanString(filters.agentId, 160) || null,
    status: cleanString(filters.status, 40).toLowerCase() || null
  };
}

function matchesPostFilters(post, filters) {
  if (filters.accountId && post.accountId !== filters.accountId) return false;
  if (filters.agentId && post.agentId !== filters.agentId) return false;
  if (filters.status && post.status !== filters.status) return false;
  return true;
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanMultiline(value, maxLength) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\0/g, '').trim().slice(0, maxLength);
}

function normalizeOptionalInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

module.exports = ScheduledPostStore;
// Exposed for the legacy importer (storage/scheduled-post-legacy-importer.js)
// so it can normalize raw JSON rows through the same path the store uses
// without duplicating the rules.
module.exports._private = {
  normalizePostRecord
};
