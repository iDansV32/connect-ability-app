'use strict';

/**
 * tests/sqlite-scheduled-post-repository.test.js
 *
 * Targeted tests for SqliteScheduledPostRepository and the matching legacy
 * importer.  Mirrors the structure of sqlite-workflow-repository.test.js.
 *
 *  1. importScheduledPosts: legacy JSON rows land in SQLite when empty.
 *  2. importScheduledPosts: idempotent — skips when table already populated.
 *  3. importScheduledPosts: skips malformed rows, counts them, imports the rest.
 *  4. replaceAll: atomic full-table swap; survives reopen.
 *  5. replaceForAccount: deletes only the target-account rows; preserves
 *     null-account and other-account rows; enforces the 1000-post cap inside
 *     the transaction (rolls back on overflow).
 *  6. replaceForAccount(null): only null-account rows are deleted; both
 *     accountId-tagged and other rows survive.
 *  7. ScheduledPostStore with repo injection: getAllPosts / replaceAllPosts /
 *     replacePostsForAccount route through the repo and never write JSON.
 *  8. ScheduledPostStore.replacePostsForAccount: payload accountId is
 *     normalized to the target — a misaddressed post does NOT survive as
 *     an other-account row.
 *
 * All tests use in-memory SQLite for isolation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const SqliteScheduledPostRepository = require('../storage/sqlite-scheduled-post-repository');
const { importScheduledPosts } = require('../storage/scheduled-post-legacy-importer');
const ScheduledPostStore = require('../scheduled-post-store');
const { createTempWorkspace } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openMemory() {
  return openDatabase(':memory:');
}

function legacyPost(overrides = {}) {
  return {
    id: 'post_x',
    content: 'hello world',
    scheduledDate: '2026-06-01',
    scheduledTime: '09:00',
    status: 'pending',
    postType: 'text',
    visibility: 'public',
    accountId: 'acc-a',
    accountName: 'Account A',
    hashtags: ['ai', 'sales'],
    mentions: [],
    includeImage: false,
    createdAt: '2026-05-26T12:00:00.000Z',
    ...overrides
  };
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Legacy importer
// ---------------------------------------------------------------------------

test('importScheduledPosts: legacy JSON lands in SQLite', () => {
  const ws = createTempWorkspace('sp-import-fresh-');
  const db = openMemory();
  try {
    const storePath = ws.path('scheduled-posts.json');
    writeJsonFile(storePath, {
      version: 1,
      posts: [
        legacyPost({ id: 'p1', content: 'first' }),
        legacyPost({ id: 'p2', content: 'second', accountId: 'acc-b' })
      ]
    });

    const result = importScheduledPosts(db, { storePath });
    assert.equal(result.imported, true);
    assert.equal(result.count, 2);
    assert.equal(result.skipped, 0);

    const repo = new SqliteScheduledPostRepository(db);
    const all = repo.readAll();
    assert.equal(all.length, 2);
    const ids = new Set(all.map((p) => p.id));
    assert.ok(ids.has('p1'));
    assert.ok(ids.has('p2'));
  } finally {
    closeDatabase(db);
    ws.cleanup();
  }
});

test('importScheduledPosts: idempotency guard skips when table already has rows', () => {
  const ws = createTempWorkspace('sp-import-idem-');
  const db = openMemory();
  try {
    const storePath = ws.path('scheduled-posts.json');
    writeJsonFile(storePath, { version: 1, posts: [legacyPost({ id: 'p1' })] });

    const first = importScheduledPosts(db, { storePath });
    assert.equal(first.imported, true);
    assert.equal(first.count, 1);

    // Second call must skip even if the JSON has more rows now.
    writeJsonFile(storePath, {
      version: 1,
      posts: [legacyPost({ id: 'p1' }), legacyPost({ id: 'p2' })]
    });
    const second = importScheduledPosts(db, { storePath });
    assert.equal(second.imported, false);
    assert.equal(second.count, 0);

    const repo = new SqliteScheduledPostRepository(db);
    assert.equal(repo.count(), 1, 'rerunning the import must not double-insert');
  } finally {
    closeDatabase(db);
    ws.cleanup();
  }
});

test('importScheduledPosts: duplicate ids are deduped (first wins), counted separately from malformed', () => {
  // SQLite has `id PRIMARY KEY` on scheduled_posts but legacy JSON had no
  // such constraint. Without dedup, a duplicate id would throw during the
  // INSERT and roll back the WHOLE import. Verify dedup drops later
  // occurrences, counts them, and lets the rest import cleanly.
  const ws = createTempWorkspace('sp-import-duplicates-');
  const db = openMemory();
  try {
    const storePath = ws.path('scheduled-posts.json');
    writeJsonFile(storePath, {
      version: 1,
      posts: [
        legacyPost({ id: 'p1', content: 'first wins' }),
        legacyPost({ id: 'p1', content: 'duplicate, dropped' }),
        legacyPost({ id: 'p2', content: 'unrelated' }),
        legacyPost({ id: 'p1', content: 'duplicate again' }),
        // Also a malformed row to confirm both kinds count toward skipped.
        { id: 'broken', scheduledDate: '2026-06-01', scheduledTime: '09:00' }
      ]
    });

    const result = importScheduledPosts(db, { storePath });
    assert.equal(result.imported, true);
    assert.equal(result.count, 2, 'p1 + p2 imported');
    assert.equal(result.skipped, 3, 'two dup-id + one malformed');
    assert.equal(result.skippedDuplicates, 2, 'duplicate sub-count surfaced');

    const repo = new SqliteScheduledPostRepository(db);
    const all = repo.readAll();
    assert.equal(all.length, 2);

    // First occurrence wins.
    const p1 = all.find((p) => p.id === 'p1');
    assert.ok(p1);
    assert.equal(p1.content, 'first wins', 'first occurrence is the winner');

    const p2 = all.find((p) => p.id === 'p2');
    assert.ok(p2);
  } finally {
    closeDatabase(db);
    ws.cleanup();
  }
});

test('importScheduledPosts: dedup result shape backward-compatible (skippedDuplicates always present)', () => {
  // Clean migration with no duplicates should still report skippedDuplicates: 0
  // rather than omitting the field — caller code can read it unconditionally.
  const ws = createTempWorkspace('sp-import-no-duplicates-');
  const db = openMemory();
  try {
    const storePath = ws.path('scheduled-posts.json');
    writeJsonFile(storePath, {
      version: 1,
      posts: [
        legacyPost({ id: 'p1' }),
        legacyPost({ id: 'p2' })
      ]
    });

    const result = importScheduledPosts(db, { storePath });
    assert.equal(result.imported, true);
    assert.equal(result.count, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.skippedDuplicates, 0, 'field present even when zero');

    // Empty-file case: still includes the field.
    const ws2 = createTempWorkspace('sp-import-empty-');
    try {
      const storePath2 = ws2.path('scheduled-posts.json');
      writeJsonFile(storePath2, { version: 1, posts: [] });
      const db2 = openMemory();
      try {
        const emptyResult = importScheduledPosts(db2, { storePath: storePath2 });
        assert.equal(emptyResult.imported, false);
        assert.equal(emptyResult.skippedDuplicates, 0);
      } finally {
        closeDatabase(db2);
      }
    } finally { ws2.cleanup(); }
  } finally {
    closeDatabase(db);
    ws.cleanup();
  }
});

test('importScheduledPosts: malformed rows are skipped, the rest import', () => {
  const ws = createTempWorkspace('sp-import-malformed-');
  const db = openMemory();
  try {
    const storePath = ws.path('scheduled-posts.json');
    writeJsonFile(storePath, {
      version: 1,
      posts: [
        legacyPost({ id: 'p1', content: 'valid' }),
        // missing content — normalizePostRecord throws
        { id: 'broken1', scheduledDate: '2026-06-01', scheduledTime: '09:00' },
        // partial date/time pair — normalizePostRecord throws
        { id: 'broken2', content: 'half-scheduled', scheduledDate: '2026-06-02' },
        legacyPost({ id: 'p2', content: 'also valid' })
      ]
    });

    const result = importScheduledPosts(db, { storePath });
    assert.equal(result.imported, true);
    assert.equal(result.count, 2, 'two valid rows imported');
    assert.equal(result.skipped, 2, 'two malformed rows counted');

    const repo = new SqliteScheduledPostRepository(db);
    const all = repo.readAll();
    const ids = new Set(all.map((p) => p.id));
    assert.ok(ids.has('p1'));
    assert.ok(ids.has('p2'));
    assert.equal(ids.has('broken1'), false);
    assert.equal(ids.has('broken2'), false);
  } finally {
    closeDatabase(db);
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// SqliteScheduledPostRepository: replaceAll
// ---------------------------------------------------------------------------

test('SqliteScheduledPostRepository.replaceAll is atomic and survives close/reopen', () => {
  const ws = createTempWorkspace('sp-replace-all-');
  const dbPath = ws.path('test.db');
  let db = openDatabase(dbPath);
  try {
    const repo = new SqliteScheduledPostRepository(db);
    repo.replaceAll([
      { id: 'p1', accountId: 'acc-a', status: 'pending', postType: 'text',
        visibility: 'public', content: 'one', createdAt: '2026-05-26T12:00:00.000Z' },
      { id: 'p2', accountId: 'acc-b', status: 'pending', postType: 'text',
        visibility: 'public', content: 'two', createdAt: '2026-05-26T12:01:00.000Z' }
    ]);
    assert.equal(repo.count(), 2);

    // Replace with a single row — old rows must be gone.
    repo.replaceAll([
      { id: 'p3', accountId: 'acc-c', status: 'pending', postType: 'text',
        visibility: 'public', content: 'three', createdAt: '2026-05-26T12:02:00.000Z' }
    ]);
    assert.equal(repo.count(), 1);

    closeDatabase(db);
    db = openDatabase(dbPath);
    const repo2 = new SqliteScheduledPostRepository(db);
    const all = repo2.readAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'p3');
    assert.equal(all[0].accountId, 'acc-c');
  } finally {
    closeDatabase(db);
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// SqliteScheduledPostRepository: replaceForAccount
// ---------------------------------------------------------------------------

test('replaceForAccount(accountId): deletes only target-account rows; preserves null + other-account', () => {
  const db = openMemory();
  try {
    const repo = new SqliteScheduledPostRepository(db);
    repo.replaceAll([
      // 1 global (accountId=null), 2 acc-a, 1 acc-b
      { id: 'g1', accountId: null,    status: 'pending', postType: 'text', visibility: 'public', content: 'global',  createdAt: 't0' },
      { id: 'a1', accountId: 'acc-a', status: 'pending', postType: 'text', visibility: 'public', content: 'a-one',   createdAt: 't1' },
      { id: 'a2', accountId: 'acc-a', status: 'pending', postType: 'text', visibility: 'public', content: 'a-two',   createdAt: 't2' },
      { id: 'b1', accountId: 'acc-b', status: 'pending', postType: 'text', visibility: 'public', content: 'b-one',   createdAt: 't3' }
    ]);
    assert.equal(repo.count(), 4);

    // Replace acc-a with a single new row.
    repo.replaceForAccount('acc-a', [
      { id: 'a3', accountId: 'acc-a', status: 'pending', postType: 'text', visibility: 'public', content: 'a-three', createdAt: 't4' }
    ]);

    const remaining = repo.readAll();
    const remainingIds = new Set(remaining.map((p) => p.id));
    assert.equal(remaining.length, 3, 'global + acc-b + new acc-a row = 3');
    assert.ok(remainingIds.has('g1'),  'global row preserved');
    assert.ok(remainingIds.has('b1'),  'other-account row preserved');
    assert.ok(remainingIds.has('a3'),  'new acc-a row inserted');
    assert.equal(remainingIds.has('a1'), false, 'old acc-a row deleted');
    assert.equal(remainingIds.has('a2'), false, 'old acc-a row deleted');
  } finally {
    closeDatabase(db);
  }
});

test('replaceForAccount(null): deletes only null-account rows; preserves accountId-tagged rows', () => {
  const db = openMemory();
  try {
    const repo = new SqliteScheduledPostRepository(db);
    repo.replaceAll([
      { id: 'g1', accountId: null,    status: 'pending', postType: 'text', visibility: 'public', content: 'global',  createdAt: 't0' },
      { id: 'g2', accountId: null,    status: 'pending', postType: 'text', visibility: 'public', content: 'global2', createdAt: 't1' },
      { id: 'a1', accountId: 'acc-a', status: 'pending', postType: 'text', visibility: 'public', content: 'a-one',   createdAt: 't2' }
    ]);
    assert.equal(repo.count(), 3);

    repo.replaceForAccount(null, [
      { id: 'g3', accountId: null,    status: 'pending', postType: 'text', visibility: 'public', content: 'global3', createdAt: 't3' }
    ]);

    const remaining = repo.readAll();
    const remainingIds = new Set(remaining.map((p) => p.id));
    assert.equal(remaining.length, 2, 'one acc-a + one new global = 2');
    assert.ok(remainingIds.has('a1'), 'acc-a row preserved');
    assert.ok(remainingIds.has('g3'), 'new global row inserted');
    assert.equal(remainingIds.has('g1'), false, 'old global rows deleted');
    assert.equal(remainingIds.has('g2'), false, 'old global rows deleted');
  } finally {
    closeDatabase(db);
  }
});

test('replaceForAccount: 1000-post cap rolls back the transaction', () => {
  const db = openMemory();
  try {
    const repo = new SqliteScheduledPostRepository(db);
    // Pre-fill with 600 rows on acc-other.
    const preload = [];
    for (let i = 0; i < 600; i += 1) {
      preload.push({
        id: `other-${i}`, accountId: 'acc-other', status: 'pending',
        postType: 'text', visibility: 'public', content: 'x', createdAt: 't'
      });
    }
    repo.replaceAll(preload);
    assert.equal(repo.count(), 600);

    // Try to replace acc-a with 500 rows — total would be 1100, over cap.
    const newAccA = [];
    for (let i = 0; i < 500; i += 1) {
      newAccA.push({
        id: `a-${i}`, accountId: 'acc-a', status: 'pending',
        postType: 'text', visibility: 'public', content: 'y', createdAt: 't'
      });
    }

    assert.throws(
      () => repo.replaceForAccount('acc-a', newAccA),
      /maximum of 1000/i
    );

    // Transaction must have rolled back: acc-other rows still there, no acc-a rows.
    assert.equal(repo.count(), 600, 'transaction must roll back on cap overflow');
    const all = repo.readAll();
    assert.equal(all.every((p) => p.accountId === 'acc-other'), true);
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// ScheduledPostStore with repo injection
// ---------------------------------------------------------------------------

test('ScheduledPostStore({ repo }): replaceAllPosts routes through SQLite, never writes JSON', () => {
  const ws = createTempWorkspace('sp-store-sqlite-');
  const db = openMemory();
  try {
    const repo = new SqliteScheduledPostRepository(db);
    const store = new ScheduledPostStore({
      repo,
      storePath: ws.path('scheduled-posts.json')
    });

    store.replaceAllPosts([
      { id: 'p1', content: 'one', accountId: 'acc-a', status: 'pending',
        postType: 'text', visibility: 'public', createdAt: '2026-05-26T12:00:00.000Z' }
    ]);

    // The row must exist in SQLite.
    assert.equal(repo.count(), 1);
    // The JSON file must NOT have been created.
    assert.equal(
      fs.existsSync(ws.path('scheduled-posts.json')),
      false,
      'scheduled-posts.json must not exist when repo is injected'
    );

    // getAllPosts reads from the repo.
    const all = store.getAllPosts();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'p1');
  } finally {
    closeDatabase(db);
    ws.cleanup();
  }
});

test('ScheduledPostStore({ repo }).replacePostsForAccount normalizes payload accountId to target', () => {
  // Mirrors the JSON-store behavior on line 66 of scheduled-post-store.js:
  // a misaddressed post is rewritten to the target accountId, not preserved
  // as an other-account row.
  const db = openMemory();
  try {
    const repo = new SqliteScheduledPostRepository(db);
    const store = new ScheduledPostStore({ repo });

    // Seed an acc-b row that must survive the acc-a replace.
    store.replaceAllPosts([
      { id: 'b1', accountId: 'acc-b', status: 'pending', postType: 'text',
        visibility: 'public', content: 'b-original', createdAt: 't0' }
    ]);

    // Pass a misaddressed post (claims accountId='acc-c') to a replace
    // targeted at acc-a. Expected: the post's accountId is rewritten to
    // acc-a; acc-b survives; acc-c does NOT appear.
    store.replacePostsForAccount('acc-a', [
      { id: 'misaddressed', accountId: 'acc-c', status: 'pending', postType: 'text',
        visibility: 'public', content: 'should-be-acc-a', createdAt: 't1' }
    ]);

    const all = store.getAllPosts();
    const byAccount = new Map(all.map((p) => [p.accountId, p]));
    assert.ok(byAccount.has('acc-a'), 'misaddressed post landed under acc-a');
    assert.ok(byAccount.has('acc-b'), 'unrelated acc-b row preserved');
    assert.equal(byAccount.has('acc-c'), false, 'mis-claimed acc-c must NOT be created');

    // And the misaddressed post's accountId is now acc-a in storage.
    const misaddressed = all.find((p) => p.id === 'misaddressed');
    assert.equal(misaddressed.accountId, 'acc-a');
  } finally {
    closeDatabase(db);
  }
});

test('ScheduledPostStore({ repo }).readStore ignores stale JSON; reads from SQLite', () => {
  // The split-backend trap this guards against: a leftover scheduled-posts.json
  // from before the migration would otherwise be read by readStore(), even
  // though the repo is canonical. After the fix, readStore must route through
  // the repo and the JSON content is irrelevant.
  const ws = createTempWorkspace('sp-store-stale-json-');
  const db = openMemory();
  try {
    const stalePath = ws.path('scheduled-posts.json');
    writeJsonFile(stalePath, {
      version: 1,
      posts: [legacyPost({ id: 'stale-row-1', content: 'this should never appear' })]
    });

    const repo = new SqliteScheduledPostRepository(db);
    repo.replaceAll([
      { id: 'sqlite-row-1', content: 'this is canonical', accountId: 'acc-a',
        status: 'pending', postType: 'text', visibility: 'public',
        createdAt: '2026-05-26T12:00:00.000Z' }
    ]);

    const store = new ScheduledPostStore({ repo, storePath: stalePath });

    // getAllPosts already routes through the repo (per earlier tests); the
    // critical pin here is readStore (the unfixed gap the reviewer flagged).
    const fromReadStore = store.readStore();
    const ids = fromReadStore.posts.map((p) => p.id);
    assert.deepEqual(ids, ['sqlite-row-1'], 'readStore must return SQLite rows, not stale JSON');
    assert.equal(ids.includes('stale-row-1'), false);
  } finally {
    closeDatabase(db);
    ws.cleanup();
  }
});

test('ScheduledPostStore without repo still writes JSON (backward compat)', () => {
  const ws = createTempWorkspace('sp-store-json-');
  try {
    const store = new ScheduledPostStore({
      storePath: ws.path('scheduled-posts.json')
    });

    store.replaceAllPosts([
      { id: 'p1', content: 'one', accountId: 'acc-a', status: 'pending',
        postType: 'text', visibility: 'public', createdAt: '2026-05-26T12:00:00.000Z' }
    ]);

    assert.equal(fs.existsSync(ws.path('scheduled-posts.json')), true);
    const parsed = JSON.parse(fs.readFileSync(ws.path('scheduled-posts.json'), 'utf8'));
    assert.equal(parsed.posts.length, 1);
    assert.equal(parsed.posts[0].id, 'p1');
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// updateById / updatePostFields — granular single-row updates used by the
// idempotency persistence path in main.js (record linkedInResourceKey
// without rewriting the whole table).
// ---------------------------------------------------------------------------

test('updateById merges partial fields, returns the merged record, preserves other rows', () => {
  const db = openMemory();
  try {
    const repo = new SqliteScheduledPostRepository(db);
    repo.replaceAll([
      { id: 'p1', accountId: 'acc-a', status: 'pending', postType: 'text', visibility: 'public',
        content: 'one', createdAt: 't0' },
      { id: 'p2', accountId: 'acc-b', status: 'pending', postType: 'text', visibility: 'public',
        content: 'two', createdAt: 't1' }
    ]);

    const updated = repo.updateById('p1', {
      linkedInResourceKey: 'urn:li:share:abc',
      linkedInScheduledAt: '2026-06-01T09:00:00.000Z',
      status: 'scheduled',
      deliveryStrategy: 'linkedin_scheduled'
    });

    // Returned record has the merged shape.
    assert.equal(updated.id, 'p1');
    assert.equal(updated.linkedInResourceKey, 'urn:li:share:abc');
    assert.equal(updated.status, 'scheduled');
    assert.equal(updated.content, 'one', 'unchanged fields preserved');

    // Other rows untouched.
    const all = repo.readAll();
    assert.equal(all.length, 2);
    const p2 = all.find((p) => p.id === 'p2');
    assert.equal(p2.linkedInResourceKey, null, 'unrelated row not modified');
    assert.equal(p2.content, 'two');
  } finally {
    closeDatabase(db);
  }
});

test('updateById throws when postId not found (no silent no-op)', () => {
  // Per the user refinement: a missing local row after LinkedIn has
  // accepted a schedule is a real consistency problem. Fail loudly rather
  // than silently dropping the update.
  const db = openMemory();
  try {
    const repo = new SqliteScheduledPostRepository(db);
    repo.replaceAll([
      { id: 'p1', accountId: 'acc-a', status: 'pending', postType: 'text', visibility: 'public',
        content: 'one', createdAt: 't0' }
    ]);

    assert.throws(
      () => repo.updateById('does-not-exist', { linkedInResourceKey: 'urn:li:share:x' }),
      /not found/i
    );
    // Original row untouched.
    assert.equal(repo.readAll()[0].id, 'p1');
  } finally {
    closeDatabase(db);
  }
});

test('updateById preserves row identity (PRIMARY KEY survives the DELETE+INSERT)', () => {
  // Implementation detail: updateById uses DELETE+INSERT inside a
  // transaction to reuse the existing INSERT prepared statement. Verify
  // there's no observable side effect — id stays the same, count is stable.
  const db = openMemory();
  try {
    const repo = new SqliteScheduledPostRepository(db);
    repo.replaceAll([
      { id: 'p1', accountId: 'acc-a', status: 'pending', postType: 'text', visibility: 'public',
        content: 'one', createdAt: 't0' }
    ]);
    assert.equal(repo.count(), 1);

    repo.updateById('p1', { status: 'scheduled' });
    repo.updateById('p1', { linkedInResourceKey: 'urn:li:share:x' });
    repo.updateById('p1', { error: null });

    assert.equal(repo.count(), 1, 'three updates produce one row, not three');
    const final = repo.readAll()[0];
    assert.equal(final.id, 'p1');
    assert.equal(final.status, 'scheduled');
    assert.equal(final.linkedInResourceKey, 'urn:li:share:x');
  } finally {
    closeDatabase(db);
  }
});

// ---------------------------------------------------------------------------
// ScheduledPostStore.updatePostFields — both backends through one public method
// ---------------------------------------------------------------------------

test('ScheduledPostStore({ repo }).updatePostFields routes through SQLite, never writes JSON', () => {
  const ws = createTempWorkspace('sp-update-fields-sqlite-');
  const db = openMemory();
  try {
    const repo = new SqliteScheduledPostRepository(db);
    const store = new ScheduledPostStore({
      repo,
      storePath: ws.path('scheduled-posts.json')
    });
    store.replaceAllPosts([
      { id: 'p1', accountId: 'acc-a', content: 'one', status: 'pending',
        postType: 'text', visibility: 'public', createdAt: 't0' }
    ]);

    const updated = store.updatePostFields('p1', {
      linkedInResourceKey: 'urn:li:share:xyz',
      status: 'scheduled'
    });

    assert.equal(updated.linkedInResourceKey, 'urn:li:share:xyz');
    assert.equal(updated.status, 'scheduled');
    assert.equal(repo.readAll()[0].linkedInResourceKey, 'urn:li:share:xyz', 'change visible in SQLite');
    assert.equal(fs.existsSync(ws.path('scheduled-posts.json')), false, 'no JSON writes through repo path');
  } finally {
    closeDatabase(db);
    ws.cleanup();
  }
});

test('ScheduledPostStore (JSON path) updatePostFields merges and persists atomically', () => {
  const ws = createTempWorkspace('sp-update-fields-json-');
  try {
    const store = new ScheduledPostStore({ storePath: ws.path('scheduled-posts.json') });
    store.replaceAllPosts([
      { id: 'p1', accountId: 'acc-a', content: 'one', status: 'pending',
        postType: 'text', visibility: 'public', createdAt: 't0' },
      { id: 'p2', accountId: 'acc-b', content: 'two', status: 'pending',
        postType: 'text', visibility: 'public', createdAt: 't1' }
    ]);

    const updated = store.updatePostFields('p1', {
      linkedInResourceKey: 'urn:li:share:json-1',
      status: 'scheduled'
    });
    assert.equal(updated.linkedInResourceKey, 'urn:li:share:json-1');

    // Other row preserved through the read-merge-write cycle.
    const all = store.getAllPosts();
    assert.equal(all.length, 2);
    const p2 = all.find((p) => p.id === 'p2');
    assert.equal(p2.linkedInResourceKey, null);

    // File on disk reflects the change.
    const parsed = JSON.parse(fs.readFileSync(ws.path('scheduled-posts.json'), 'utf8'));
    const p1 = parsed.posts.find((p) => p.id === 'p1');
    assert.equal(p1.linkedInResourceKey, 'urn:li:share:json-1');
  } finally {
    ws.cleanup();
  }
});

test('ScheduledPostStore.updatePostFields throws on missing postId (both backends)', () => {
  // SQLite path.
  const db = openMemory();
  try {
    const sqliteStore = new ScheduledPostStore({ repo: new SqliteScheduledPostRepository(db) });
    assert.throws(
      () => sqliteStore.updatePostFields('does-not-exist', { status: 'scheduled' }),
      /not found/i
    );
  } finally { closeDatabase(db); }

  // JSON path.
  const ws = createTempWorkspace('sp-update-fields-missing-');
  try {
    const jsonStore = new ScheduledPostStore({ storePath: ws.path('scheduled-posts.json') });
    jsonStore.replaceAllPosts([
      { id: 'p1', accountId: 'acc-a', content: 'one', status: 'pending',
        postType: 'text', visibility: 'public', createdAt: 't0' }
    ]);
    assert.throws(
      () => jsonStore.updatePostFields('does-not-exist', { status: 'scheduled' }),
      /not found/i
    );
  } finally { ws.cleanup(); }
});

test('updateById: invalid partial throws inside transaction; SQLite row unchanged', () => {
  // Regression guard for the atomicity gap: an invalid partial (here, a
  // status not in ALLOWED_POST_STATUSES) must be rejected by
  // normalizePostRecord INSIDE the transaction so the DELETE+INSERT rolls
  // back. Without that, the DELETE could fire and leave the table mutated.
  const db = openMemory();
  try {
    const repo = new SqliteScheduledPostRepository(db);
    repo.replaceAll([
      { id: 'p1', accountId: 'acc-a', status: 'pending', postType: 'text', visibility: 'public',
        content: 'original', createdAt: 't0', linkedInResourceKey: 'urn:li:share:original' }
    ]);

    assert.throws(
      () => repo.updateById('p1', { status: 'unsupported_status_value' }),
      /Unsupported scheduled post status/i
    );

    // The pre-update row must be exactly preserved — no torn state.
    const after = repo.readAll();
    assert.equal(after.length, 1);
    assert.equal(after[0].id, 'p1');
    assert.equal(after[0].status, 'pending', 'status unchanged after failed update');
    assert.equal(after[0].content, 'original', 'content unchanged');
    assert.equal(after[0].linkedInResourceKey, 'urn:li:share:original', 'resourceKey unchanged');
  } finally {
    closeDatabase(db);
  }
});

test('updatePostFields normalizes whitespace-padded postId for both backends', () => {
  // Regression guard for backend drift: without normalization at the public
  // boundary, the JSON path strips whitespace from both sides of the id
  // comparison while the SQLite path looks up the raw padded value against
  // an indexed PK column. Inputs like ' p1 ' would succeed on JSON and fail
  // on SQLite. After the fix, both backends resolve the same lookup.

  // SQLite path.
  const db = openMemory();
  try {
    const store = new ScheduledPostStore({ repo: new SqliteScheduledPostRepository(db) });
    store.replaceAllPosts([
      { id: 'p1', accountId: 'acc-a', content: 'one', status: 'pending',
        postType: 'text', visibility: 'public', createdAt: 't0' }
    ]);
    const updated = store.updatePostFields('  p1  ', { status: 'scheduled' });
    assert.equal(updated.id, 'p1');
    assert.equal(updated.status, 'scheduled', 'SQLite path resolved padded id');
  } finally { closeDatabase(db); }

  // JSON path.
  const ws = createTempWorkspace('sp-update-fields-padded-json-');
  try {
    const store = new ScheduledPostStore({ storePath: ws.path('scheduled-posts.json') });
    store.replaceAllPosts([
      { id: 'p1', accountId: 'acc-a', content: 'one', status: 'pending',
        postType: 'text', visibility: 'public', createdAt: 't0' }
    ]);
    const updated = store.updatePostFields('\tp1\n', { status: 'scheduled' });
    assert.equal(updated.id, 'p1');
    assert.equal(updated.status, 'scheduled', 'JSON path resolved padded id');
  } finally { ws.cleanup(); }
});

test('ScheduledPostStore.updatePostFields rejects empty/invalid input', () => {
  const db = openMemory();
  try {
    const store = new ScheduledPostStore({ repo: new SqliteScheduledPostRepository(db) });
    assert.throws(() => store.updatePostFields('', { status: 'scheduled' }), /postId is required/i);
    assert.throws(() => store.updatePostFields(null, { status: 'scheduled' }), /postId is required/i);
    assert.throws(() => store.updatePostFields('p1', null), /partial fields object is required/i);
  } finally { closeDatabase(db); }
});
