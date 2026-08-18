const test = require('node:test');
const assert = require('node:assert/strict');

const ProspectQueueStore = require('../prospect-queue-store');
const { createTempWorkspace } = require('./test-helpers');

test('ProspectQueueStore dedupes prospects by account and LinkedIn profile URL', () => {
  const workspace = createTempWorkspace('prospect-queue-store-');
  try {
    const store = new ProspectQueueStore({
      storePath: workspace.path('prospect-queue.json')
    });

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

    assert.equal(first.id, second.id);
    assert.equal(store.getAllProspects().length, 1);
    assert.equal(second.normalizedProfileUrl, 'https://www.linkedin.com/in/jane-doe');
  } finally {
    workspace.cleanup();
  }
});

test('ProspectQueueStore resolves workflow targets into assigned prospects', () => {
  const workspace = createTempWorkspace('prospect-queue-workflow-');
  try {
    const store = new ProspectQueueStore({
      storePath: workspace.path('prospect-queue.json')
    });

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
    assert.ok(targets[0].prospectId);

    const savedProspect = store.getProspect(targets[0].prospectId);
    assert.equal(savedProspect.state, 'queued');
    assert.equal(savedProspect.workflowAssignment.workflowId, 'workflow-1');
    assert.equal(savedProspect.sources[0].label, 'Chief of Staff');
  } finally {
    workspace.cleanup();
  }
});

test('ProspectQueueStore records activity metrics and terminal workflow progress', () => {
  const workspace = createTempWorkspace('prospect-queue-activity-');
  try {
    const store = new ProspectQueueStore({
      storePath: workspace.path('prospect-queue.json')
    });

    const prospect = store.upsertProspect({
      accountId: 'account-1',
      fullName: 'Jordan Lee',
      profileUrl: 'https://www.linkedin.com/in/jordan-lee/',
      state: 'queued'
    });

    const afterDm = store.recordActivity({
      type: 'dm_sent',
      prospectId: prospect.id,
      accountId: 'account-1',
      workflowId: 'workflow-1',
      workflowName: 'Head of People Sequence',
      runId: 'run-1',
      targetId: 'target-1',
      timestamp: '2026-03-21T12:00:00.000Z'
    });
    assert.equal(afterDm.metrics.dmsSent, 1);
    assert.equal(afterDm.state, 'active');

    const afterAcceptance = store.recordActivity({
      type: 'connection_accepted',
      prospectId: prospect.id,
      accountId: 'account-1',
      timestamp: '2026-03-21T12:30:00.000Z',
      metadata: {
        reason: 'Inferred from successful DM after recorded invite'
      }
    });
    assert.equal(afterAcceptance.metrics.connectionAcceptances, 1);
    assert.equal(afterAcceptance.metadata.connectionAcceptedAt, '2026-03-21T12:30:00.000Z');

    const afterReply = store.recordActivity({
      type: 'dm_reply_received',
      prospectId: prospect.id,
      accountId: 'account-1',
      timestamp: '2026-03-21T13:00:00.000Z',
      metadata: {
        senderName: 'Jordan Lee'
      }
    });
    assert.equal(afterReply.metrics.dmReplies, 1);
    assert.equal(afterReply.state, 'responded');

    const completed = store.updateWorkflowProgress(prospect.id, {
      state: 'completed',
      workflowAssignment: {
        workflowId: 'workflow-1',
        runId: 'run-1',
        targetId: 'target-1'
      },
      timestamp: '2026-03-21T14:00:00.000Z'
    });
    assert.equal(completed.state, 'responded');
    assert.equal(completed.workflowAssignment.runId, 'run-1');
    assert.equal(completed.metrics.workflowsCompleted, 1);
  } finally {
    workspace.cleanup();
  }
});

test('ProspectQueueStore only blocks cross-agent handling after accepted connection or reply', () => {
  const workspace = createTempWorkspace('prospect-queue-cross-agent-');
  try {
    const store = new ProspectQueueStore({
      storePath: workspace.path('prospect-queue.json')
    });

    const first = store.upsertProspect({
      accountId: 'account-1',
      accountName: 'Account One',
      agentId: 'agent-1',
      agentName: 'Agent One',
      fullName: 'Jane Doe',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/',
      company: 'Acme'
    });
    const second = store.upsertProspect({
      accountId: 'account-2',
      accountName: 'Account Two',
      agentId: 'agent-2',
      agentName: 'Agent Two',
      fullName: 'Jane Doe',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/?trk=public_profile',
      company: 'Acme'
    });

    store.recordActivity({
      type: 'connection_requested',
      prospectId: first.id,
      accountId: 'account-1',
      agentId: 'agent-1',
      timestamp: '2026-03-21T12:00:00.000Z'
    });

    const afterInviteOnly = store.getContactOwnershipSummary({
      prospectId: second.id,
      accountId: 'account-2',
      agentId: 'agent-2'
    });
    assert.equal(afterInviteOnly.blocked, false);

    store.recordActivity({
      type: 'connection_accepted',
      prospectId: first.id,
      accountId: 'account-1',
      agentId: 'agent-1',
      timestamp: '2026-03-21T12:30:00.000Z'
    });

    const afterAcceptance = store.getContactOwnershipSummary({
      prospectId: second.id,
      accountId: 'account-2',
      agentId: 'agent-2'
    });
    assert.equal(afterAcceptance.blocked, true);
    assert.equal(afterAcceptance.blockReason, 'connected_elsewhere');
    assert.equal(afterAcceptance.handlersInContact[0].agentId, 'agent-1');

    store.recordActivity({
      type: 'dm_reply_received',
      prospectId: first.id,
      accountId: 'account-1',
      agentId: 'agent-1',
      timestamp: '2026-03-21T13:00:00.000Z'
    });

    const afterReply = store.getContactOwnershipSummary({
      prospectId: second.id,
      accountId: 'account-2',
      agentId: 'agent-2'
    });
    assert.equal(afterReply.blocked, true);
    assert.equal(afterReply.blockReason, 'responded_elsewhere');
    assert.equal(afterReply.handlersInContact[0].contactStage, 'responded');
  } finally {
    workspace.cleanup();
  }
});

test('ProspectQueueStore archiveProspect explicitly marks unsubscribed prospects do-not-contact', () => {
  const workspace = createTempWorkspace('prospect-queue-archive-');
  try {
    const store = new ProspectQueueStore({
      storePath: workspace.path('prospect-queue.json')
    });

    const prospect = store.upsertProspect({
      accountId: 'account-1',
      fullName: 'Jordan Lee',
      profileUrl: 'https://www.linkedin.com/in/jordan-lee/',
      state: 'responded'
    });

    const archived = store.archiveProspect(prospect.id, {
      reason: 'unsubscribe_received',
      workflowAssignment: {
        workflowId: 'workflow-1',
        runId: 'run-1',
        targetId: 'target-1'
      },
      timestamp: '2026-03-21T15:00:00.000Z'
    });

    assert.equal(archived.state, 'archived');
    assert.equal(archived.metadata.doNotContact, true);
    assert.equal(archived.metadata.archiveReason, 'unsubscribe_received');
    assert.equal(archived.metadata.unsubscribedAt, '2026-03-21T15:00:00.000Z');
    assert.equal(archived.workflowAssignment.runId, 'run-1');
  } finally {
    workspace.cleanup();
  }
});

test('ProspectQueueStore persists lead scores without churning unchanged timestamps', () => {
  const workspace = createTempWorkspace('prospect-queue-score-');
  try {
    const store = new ProspectQueueStore({
      storePath: workspace.path('prospect-queue.json')
    });

    const prospect = store.upsertProspect({
      accountId: 'account-1',
      fullName: 'Taylor Green',
      profileUrl: 'https://www.linkedin.com/in/taylor-green/'
    });

    const [first] = store.applyLeadScores([{
      prospectId: prospect.id,
      score: 82,
      scoreUpdatedAt: '2026-03-23T12:00:00.000Z',
      scoreBreakdown: {
        total: 0.82,
        factors: {
          titleMatch: { score: 1, weight: 0.5, weighted: 0.5, matchedKeyword: 'Chief of Staff' }
        }
      }
    }]);

    assert.equal(first.score, 82);
    assert.equal(first.scoreUpdatedAt, '2026-03-23T12:00:00.000Z');
    assert.equal(first.scoreBreakdown.factors.titleMatch.matchedKeyword, 'Chief of Staff');

    const [second] = store.applyLeadScores([{
      prospectId: prospect.id,
      score: 82,
      scoreUpdatedAt: '2026-03-23T15:00:00.000Z',
      scoreBreakdown: {
        total: 0.82,
        factors: {
          titleMatch: { score: 1, weight: 0.5, weighted: 0.5, matchedKeyword: 'Chief of Staff' }
        }
      }
    }]);

    assert.equal(second.scoreUpdatedAt, '2026-03-23T12:00:00.000Z');
    assert.equal(store.getProspect(prospect.id).score, 82);
  } finally {
    workspace.cleanup();
  }
});
