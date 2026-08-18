'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { openDatabase, closeDatabase } = require('../storage/sqlite-db');
const ProspectQueueStore = require('../prospect-queue-store');
const { importProspects } = require('../storage/prospect-legacy-importer');
const { createTempWorkspace, writeJson } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Helper: open a fresh in-memory-like SQLite DB in a temp file, return
// { db, store, cleanup }
// ---------------------------------------------------------------------------

function openTestDb(workspace, name = 'test.db') {
  const db = openDatabase(workspace.path(name));
  return db;
}

function buildStore(db) {
  return new ProspectQueueStore({ db });
}

// ---------------------------------------------------------------------------
// 1. Dedupe by account + LinkedIn profile URL
// ---------------------------------------------------------------------------

test('SQLite ProspectQueueStore dedupes by account + LinkedIn profile URL', (t) => {
  const workspace = createTempWorkspace('pqs-sqlite-dedupe-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    const first = store.upsertProspect({
      accountId: 'account-1',
      fullName: 'Jane Doe',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/'
    });
    const second = store.upsertProspect({
      accountId: 'account-1',
      fullName: 'Jane A. Doe',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/?trk=public_profile'
    });

    assert.equal(first.id, second.id, 'same prospect ID after URL-based dedupe');
    assert.equal(store.getAllProspects().length, 1);
    assert.equal(second.normalizedProfileUrl, 'https://www.linkedin.com/in/jane-doe');
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

test('SQLite ProspectQueueStore different accounts with same URL produce separate records', () => {
  const workspace = createTempWorkspace('pqs-sqlite-separate-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    store.upsertProspect({ accountId: 'account-1', profileUrl: 'https://www.linkedin.com/in/jane-doe/' });
    store.upsertProspect({ accountId: 'account-2', profileUrl: 'https://www.linkedin.com/in/jane-doe/' });

    assert.equal(store.getAllProspects().length, 2);
    assert.equal(store.getAllProspects({ accountId: 'account-1' }).length, 1);
    assert.equal(store.getAllProspects({ accountId: 'account-2' }).length, 1);
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Workflow target resolution
// ---------------------------------------------------------------------------

test('SQLite ProspectQueueStore resolves workflow targets into assigned prospects', () => {
  const workspace = createTempWorkspace('pqs-sqlite-targets-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    const targets = store.upsertWorkflowTargets({
      accountId: 'account-1',
      accountName: 'Account One',
      agentId: 'agent-1',
      agentName: 'Agent One',
      workflowId: 'workflow-1',
      workflowName: 'Chief of Staff Sequence',
      targetType: 'profiles',
      sourceId: 'group-1',
      sourceLabel: 'Chief of Staff',
      targets: [
        {
          value: 'https://www.linkedin.com/in/jane-doe/',
          label: 'Jane Doe',
          title: 'Chief of Staff',
          company: 'Acme'
        }
      ]
    });

    assert.equal(targets.length, 1);
    assert.ok(targets[0].prospectId, 'prospectId is set');
    assert.equal(targets[0].title, 'Chief of Staff');

    const saved = store.getProspect(targets[0].prospectId);
    assert.ok(saved, 'prospect persisted');
    assert.equal(saved.state, 'queued');
    assert.equal(saved.workflowAssignment?.workflowId, 'workflow-1');
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

test('SQLite upsertWorkflowTargets dedupes against existing prospect', () => {
  const workspace = createTempWorkspace('pqs-sqlite-target-dedupe-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    // Pre-insert
    const existing = store.upsertProspect({
      accountId: 'account-1',
      fullName: 'Jane Doe',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/'
    });

    const targets = store.upsertWorkflowTargets({
      accountId: 'account-1',
      workflowId: 'wf-1',
      targets: [{ value: 'https://www.linkedin.com/in/jane-doe/' }]
    });

    assert.equal(targets[0].prospectId, existing.id, 'reuses existing prospect ID');
    assert.equal(store.getAllProspects().length, 1, 'no duplicate row created');
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Workflow progress updates and terminal state persistence
// ---------------------------------------------------------------------------

test('SQLite ProspectQueueStore persists workflow progress updates', () => {
  const workspace = createTempWorkspace('pqs-sqlite-progress-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    const prospect = store.upsertProspect({
      accountId: 'account-1',
      profileUrl: 'https://www.linkedin.com/in/alice/'
    });

    store.updateWorkflowProgress(prospect.id, {
      state: 'active',
      workflowAssignment: { workflowId: 'wf-1', runId: 'run-1', assignedAt: new Date().toISOString() }
    });

    const after = store.getProspect(prospect.id);
    assert.equal(after.state, 'active');
    assert.equal(after.workflowAssignment?.workflowId, 'wf-1');
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

test('SQLite ProspectQueueStore increments workflowsCompleted on completed state', () => {
  const workspace = createTempWorkspace('pqs-sqlite-complete-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    const prospect = store.upsertProspect({
      accountId: 'account-1',
      profileUrl: 'https://www.linkedin.com/in/bob/'
    });

    store.updateWorkflowProgress(prospect.id, { state: 'completed' });

    const after = store.getProspect(prospect.id);
    assert.equal(after.state, 'completed');
    assert.equal(after.metrics.workflowsCompleted, 1);
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

test('SQLite ProspectQueueStore archiveProspect produces terminal archived state', () => {
  const workspace = createTempWorkspace('pqs-sqlite-state-rank-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    const prospect = store.upsertProspect({
      accountId: 'account-1',
      profileUrl: 'https://www.linkedin.com/in/carol/'
    });

    const archived = store.archiveProspect(prospect.id);
    assert.equal(archived.state, 'archived', 'archiveProspect yields archived state');

    // Reading back confirms persistence
    const after = store.getProspect(prospect.id);
    assert.equal(after.state, 'archived', 'archived state is persisted to SQLite');
    assert.equal(after.metadata.doNotContact, true);
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. Archive / do-not-contact
// ---------------------------------------------------------------------------

test('SQLite ProspectQueueStore archiveProspect sets archived state and doNotContact', () => {
  const workspace = createTempWorkspace('pqs-sqlite-archive-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    const prospect = store.upsertProspect({
      accountId: 'account-1',
      profileUrl: 'https://www.linkedin.com/in/dave/'
    });

    const archived = store.archiveProspect(prospect.id, { reason: 'not_interested' });
    assert.equal(archived.state, 'archived');
    assert.equal(archived.metadata.doNotContact, true);
    assert.equal(archived.metadata.archiveReason, 'not_interested');
    assert.ok(!archived.metadata.unsubscribedAt, 'unsubscribedAt not set for non-unsubscribe reason');
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

test('SQLite ProspectQueueStore archiveProspect with unsubscribe_received sets unsubscribedAt', () => {
  const workspace = createTempWorkspace('pqs-sqlite-unsub-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    const prospect = store.upsertProspect({
      accountId: 'account-1',
      profileUrl: 'https://www.linkedin.com/in/eve/'
    });

    const archived = store.archiveProspect(prospect.id, { reason: 'unsubscribe_received' });
    assert.equal(archived.state, 'archived');
    assert.ok(archived.metadata.unsubscribedAt, 'unsubscribedAt is set');
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. Lead score persistence without unnecessary timestamp churn
// ---------------------------------------------------------------------------

test('SQLite ProspectQueueStore applyLeadScores persists score', () => {
  const workspace = createTempWorkspace('pqs-sqlite-scores-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    const prospect = store.upsertProspect({
      accountId: 'account-1',
      profileUrl: 'https://www.linkedin.com/in/frank/'
    });

    const scoreUpdatedAt = '2026-01-15T10:00:00.000Z';
    store.applyLeadScores([{
      prospectId: prospect.id,
      score: 72,
      scoreBreakdown: { total: 0.72, factors: {} },
      scoreUpdatedAt
    }]);

    const after = store.getProspect(prospect.id);
    assert.equal(after.score, 72);
    assert.equal(after.scoreUpdatedAt, scoreUpdatedAt);
    assert.deepEqual(after.scoreBreakdown, { total: 0.72, factors: {} });
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

test('SQLite ProspectQueueStore applyLeadScores does not update updatedAt when score unchanged', () => {
  const workspace = createTempWorkspace('pqs-sqlite-score-churn-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    const prospect = store.upsertProspect({
      accountId: 'account-1',
      profileUrl: 'https://www.linkedin.com/in/grace/'
    });
    const firstUpdatedAt = store.getProspect(prospect.id).updatedAt;

    const scoreUpdatedAt = '2026-01-15T10:00:00.000Z';
    store.applyLeadScores([{ prospectId: prospect.id, score: 50, scoreUpdatedAt }]);

    // Apply same score again — should be a no-op
    const results = store.applyLeadScores([{ prospectId: prospect.id, score: 50, scoreUpdatedAt }]);

    // The second applyLeadScores should return the prospect unchanged
    assert.equal(results.length, 1);
    assert.equal(results[0].score, 50);

    // updatedAt should not have changed from the initial upsert (no mutation)
    const after = store.getProspect(prospect.id);
    assert.equal(after.updatedAt, firstUpdatedAt, 'updatedAt unchanged when score is identical');
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6. Legacy import from JSON when table is empty
// ---------------------------------------------------------------------------

test('importProspects imports all records from legacy JSON on first run', () => {
  const workspace = createTempWorkspace('pqs-legacy-import-');
  const db = openTestDb(workspace);
  try {
    const storePath = workspace.path('prospect-queue.json');
    writeJson(storePath, {
      version: 1,
      prospects: [
        {
          id: 'prospect-001',
          accountId: 'account-1',
          fullName: 'Imported Person',
          profileUrl: 'https://www.linkedin.com/in/imported-person/',
          state: 'discovered',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        },
        {
          id: 'prospect-002',
          accountId: 'account-1',
          fullName: 'Another Person',
          profileUrl: 'https://www.linkedin.com/in/another-person/',
          state: 'active',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z'
        }
      ]
    });

    const result = importProspects(db, { storePath });
    assert.equal(result.imported, true);
    assert.equal(result.count, 2);

    const store = new ProspectQueueStore({ db });
    const all = store.getAllProspects();
    assert.equal(all.length, 2);

    const p = store.getProspect('prospect-001');
    assert.ok(p, 'prospect-001 found');
    assert.equal(p.fullName, 'Imported Person');
    assert.equal(p.normalizedProfileUrl, 'https://www.linkedin.com/in/imported-person');
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

test('importProspects preserves stable IDs so existing references remain valid', () => {
  const workspace = createTempWorkspace('pqs-legacy-ids-');
  const db = openTestDb(workspace);
  try {
    const storePath = workspace.path('prospect-queue.json');
    writeJson(storePath, {
      prospects: [
        {
          id: 'stable-id-abc',
          accountId: 'account-1',
          fullName: 'Stable ID Person',
          profileUrl: 'https://www.linkedin.com/in/stable/',
          state: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    });

    importProspects(db, { storePath });
    const store = new ProspectQueueStore({ db });
    const p = store.getProspect('stable-id-abc');
    assert.ok(p, 'found by original stable ID');
    assert.equal(p.id, 'stable-id-abc');
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7. No import when SQLite already contains data (idempotency)
// ---------------------------------------------------------------------------

test('importProspects skips import when SQLite already contains rows', () => {
  const workspace = createTempWorkspace('pqs-idempotent-');
  const db = openTestDb(workspace);
  try {
    const storePath = workspace.path('prospect-queue.json');
    writeJson(storePath, {
      prospects: [
        {
          id: 'p-001',
          accountId: 'account-1',
          fullName: 'Pre-existing',
          profileUrl: 'https://www.linkedin.com/in/pre-existing/',
          state: 'discovered',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    });

    // First import — should work
    const first = importProspects(db, { storePath });
    assert.equal(first.imported, true);
    assert.equal(first.count, 1);

    // Second import — should be skipped
    const second = importProspects(db, { storePath });
    assert.equal(second.imported, false);
    assert.equal(second.count, 0);

    // Only one row in DB
    const store = new ProspectQueueStore({ db });
    assert.equal(store.getAllProspects().length, 1);
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. recordActivity and updateProspectMetadata
// ---------------------------------------------------------------------------

test('SQLite ProspectQueueStore recordActivity updates metrics and state', () => {
  const workspace = createTempWorkspace('pqs-sqlite-activity-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    const prospect = store.upsertProspect({
      accountId: 'account-1',
      profileUrl: 'https://www.linkedin.com/in/henry/'
    });

    store.recordActivity({
      prospectId: prospect.id,
      type: 'connection_requested',
      accountId: 'account-1',
      timestamp: new Date().toISOString()
    });

    const after = store.getProspect(prospect.id);
    assert.equal(after.metrics.connectionRequests, 1);
    assert.equal(after.state, 'active');
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

test('SQLite ProspectQueueStore updateProspectMetadata patches metadata', () => {
  const workspace = createTempWorkspace('pqs-sqlite-metadata-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    const prospect = store.upsertProspect({
      accountId: 'account-1',
      profileUrl: 'https://www.linkedin.com/in/ivy/'
    });

    store.updateProspectMetadata(prospect.id, { queuedFollowUp: true });

    const after = store.getProspect(prospect.id);
    assert.equal(after.metadata.queuedFollowUp, true);
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. getRelatedProspects cross-account
// ---------------------------------------------------------------------------

test('SQLite ProspectQueueStore getRelatedProspects finds same URL across accounts', () => {
  const workspace = createTempWorkspace('pqs-sqlite-related-');
  const db = openTestDb(workspace);
  try {
    const store = buildStore(db);

    store.upsertProspect({ accountId: 'account-1', profileUrl: 'https://www.linkedin.com/in/jack/' });
    store.upsertProspect({ accountId: 'account-2', profileUrl: 'https://www.linkedin.com/in/jack/' });

    const related = store.getRelatedProspects({
      profileUrl: 'https://www.linkedin.com/in/jack/'
    });

    assert.equal(related.length, 2, 'both accounts appear in related prospects');
  } finally {
    closeDatabase(db);
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 10. JSON fallback still works when no db is provided
// ---------------------------------------------------------------------------

test('ProspectQueueStore JSON fallback still works when db is absent', () => {
  const workspace = createTempWorkspace('pqs-json-fallback-');
  try {
    const store = new ProspectQueueStore({ storePath: workspace.path('pq.json') });
    // No db — should use JSON path

    const p = store.upsertProspect({
      accountId: 'account-1',
      profileUrl: 'https://www.linkedin.com/in/karen/'
    });
    assert.ok(p.id);
    assert.equal(store.getAllProspects().length, 1);
  } finally {
    workspace.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Phase B step 2: upsertProspect supports the 8 Phase A profile-identity
// fields + the { additive } merge flag. This is the API the future profile
// legacy importer will call.
// ---------------------------------------------------------------------------

test('upsertProspect creates a stub prospect for an orphan profile (no prior row)', () => {
  const workspace = createTempWorkspace('pqs-stub-orphan-');
  try {
    const db = openTestDb(workspace);
    try {
      const store = buildStore(db);
      // Caller passes only profile-identity fields — no agentId, no workflow
      // assignment, no metadata. The store should create a complete record.
      const stub = store.upsertProspect({
        accountId: 'account-1',
        profileUrl: 'https://www.linkedin.com/in/orphan-jane/',
        fullName: 'Jane Orphan',
        title: 'Senior Engineer',
        company: 'Acme Co.',
        firstName: 'Jane',
        lastName: 'Orphan',
        rawHeadline: 'Senior Engineer at Acme Co.',
        companyDomain: 'acme.co',
        primaryEmail: 'jane@acme.co',
        suggestedEmails: ['jane@acme.co', 'j.orphan@acme.co'],
        firstInteractionAt: '2026-01-15T00:00:00Z',
        lastInteractionAt: '2026-05-28T00:00:00Z',
        sourceType: 'profiles'
      });
      assert.ok(stub.id, 'stub gets generated id');
      assert.equal(stub.fullName, 'Jane Orphan');
      assert.equal(stub.firstName, 'Jane');
      assert.equal(stub.lastName, 'Orphan');
      assert.equal(stub.rawHeadline, 'Senior Engineer at Acme Co.');
      assert.equal(stub.companyDomain, 'acme.co');
      assert.equal(stub.primaryEmail, 'jane@acme.co');
      assert.deepEqual(stub.suggestedEmails, ['jane@acme.co', 'j.orphan@acme.co']);
      assert.equal(stub.firstInteractionAt, '2026-01-15T00:00:00Z');
      assert.equal(stub.lastInteractionAt, '2026-05-28T00:00:00Z');
      assert.equal(stub.state, 'discovered', 'stub starts in discovered state');
      assert.equal(stub.sourceType, 'profiles');

      // Round-trip via fresh reader to confirm SQL persistence.
      const readBack = store.getAllProspects()[0];
      assert.equal(readBack.firstName, 'Jane');
      assert.equal(readBack.companyDomain, 'acme.co');
      assert.deepEqual(readBack.suggestedEmails, ['jane@acme.co', 'j.orphan@acme.co']);
    } finally { closeDatabase(db); }
  } finally { workspace.cleanup(); }
});

test('upsertProspect (default) overwrites existing fields with non-null candidate values', () => {
  // The historic "candidate wins" semantic preserved for runtime/UI writes.
  const workspace = createTempWorkspace('pqs-default-overwrite-');
  try {
    const db = openTestDb(workspace);
    try {
      const store = buildStore(db);
      const first = store.upsertProspect({
        accountId: 'account-1',
        profileUrl: 'https://www.linkedin.com/in/edit-test/',
        firstName: 'Old First',
        title: 'Old Title'
      });
      const second = store.upsertProspect({
        accountId: 'account-1',
        profileUrl: 'https://www.linkedin.com/in/edit-test/',
        firstName: 'New First',
        title: 'New Title'
      });
      assert.equal(second.id, first.id, 'same prospect (deduped by URL)');
      assert.equal(second.firstName, 'New First', 'default mode: candidate wins');
      assert.equal(second.title, 'New Title', 'default mode: candidate wins');
    } finally { closeDatabase(db); }
  } finally { workspace.cleanup(); }
});

test('upsertProspect with { additive: true } preserves existing non-NULL values', () => {
  // This is the import-safe path. The profile legacy importer (Phase B
  // step 3) will call upsertProspect(input, { additive: true }) so a
  // stale profiles.json record can never clobber a runtime-updated
  // SQLite prospect.
  const workspace = createTempWorkspace('pqs-additive-merge-');
  try {
    const db = openTestDb(workspace);
    try {
      const store = buildStore(db);
      // Runtime write — establishes the "good" SQLite values.
      store.upsertProspect({
        accountId: 'account-1',
        profileUrl: 'https://www.linkedin.com/in/protected/',
        firstName: 'Runtime First',
        title: 'Runtime Title',
        company: 'Runtime Co.'
      });
      // Importer-style call: tries to fill ALL fields including the ones
      // the runtime already set. Additive flag should preserve runtime.
      const merged = store.upsertProspect({
        accountId: 'account-1',
        profileUrl: 'https://www.linkedin.com/in/protected/',
        firstName: 'Importer First',     // SHOULD NOT win
        title: 'Importer Title',         // SHOULD NOT win
        company: 'Importer Co.',         // SHOULD NOT win
        lastName: 'Importer Last',       // SHOULD win (field was NULL)
        rawHeadline: 'Importer Headline' // SHOULD win (field was NULL)
      }, { additive: true });
      assert.equal(merged.firstName, 'Runtime First', 'additive: existing non-NULL preserved');
      assert.equal(merged.title, 'Runtime Title', 'additive: existing non-NULL preserved');
      assert.equal(merged.company, 'Runtime Co.', 'additive: existing non-NULL preserved');
      assert.equal(merged.lastName, 'Importer Last', 'additive: NULL fields get filled');
      assert.equal(merged.rawHeadline, 'Importer Headline', 'additive: NULL fields get filled');
    } finally { closeDatabase(db); }
  } finally { workspace.cleanup(); }
});

test('all 8 Phase A fields round-trip through SQLite cleanly', () => {
  const workspace = createTempWorkspace('pqs-phase-a-roundtrip-');
  try {
    const db = openTestDb(workspace);
    try {
      const store = buildStore(db);
      store.upsertProspect({
        accountId: 'account-1',
        profileUrl: 'https://www.linkedin.com/in/full-fields/',
        firstName: 'Full',
        lastName: 'Fields',
        rawHeadline: 'rH',
        companyDomain: 'fullfields.io',
        primaryEmail: 'full@fields.io',
        suggestedEmails: ['full@fields.io', 'f@fields.io', 'fields@example.com'],
        firstInteractionAt: '2026-01-01T00:00:00Z',
        lastInteractionAt: '2026-05-28T00:00:00Z'
      });
      // Re-instantiate the store from the same DB to force a fresh SQL read.
      const fresh = new ProspectQueueStore({ db });
      const reread = fresh.getAllProspects().find((p) => p.profileUrl === 'https://www.linkedin.com/in/full-fields/');
      assert.ok(reread, 'prospect found after re-read');
      assert.equal(reread.firstName, 'Full');
      assert.equal(reread.lastName, 'Fields');
      assert.equal(reread.rawHeadline, 'rH');
      assert.equal(reread.companyDomain, 'fullfields.io');
      assert.equal(reread.primaryEmail, 'full@fields.io');
      assert.deepEqual(reread.suggestedEmails, ['full@fields.io', 'f@fields.io', 'fields@example.com']);
      assert.equal(reread.firstInteractionAt, '2026-01-01T00:00:00Z');
      assert.equal(reread.lastInteractionAt, '2026-05-28T00:00:00Z');
    } finally { closeDatabase(db); }
  } finally { workspace.cleanup(); }
});

test('upsertProspect accepts `email` as alias for primaryEmail', () => {
  // profiles.json uses `email` as the field name; the importer will pass
  // it through unchanged. The store should accept either.
  const workspace = createTempWorkspace('pqs-email-alias-');
  try {
    const db = openTestDb(workspace);
    try {
      const store = buildStore(db);
      const p = store.upsertProspect({
        accountId: 'account-1',
        profileUrl: 'https://www.linkedin.com/in/email-alias/',
        email: 'alias@example.com'
      });
      assert.equal(p.primaryEmail, 'alias@example.com');
    } finally { closeDatabase(db); }
  } finally { workspace.cleanup(); }
});
