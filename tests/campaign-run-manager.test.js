const test = require('node:test');
const assert = require('node:assert/strict');

const CampaignRunManager = require('../campaign-run-manager');
const { createTempWorkspace, writeJson } = require('./test-helpers');

test('CampaignRunManager creates a normalized campaign run and persists coordination fields', () => {
  const workspace = createTempWorkspace('campaign-run-manager-');
  try {
    const storePath = workspace.path('campaign-runs.json');
    const manager = new CampaignRunManager({ storePath });

    const run = manager.createRun({
      campaignTemplateId: 'template_1',
      campaignTemplateName: 'Virtual Xperiences',
      accountId: 'account-1',
      accountName: 'Seller',
      agentId: 'agent-1',
      agentName: 'Outbound Agent',
      prospectId: 'prospect-1',
      prospectLabel: 'Jane Doe',
      childRunIds: ['run_linkedin_1'],
      channelType: 'linkedin',
      metadata: {
        source: 'unit-test'
      }
    });

    assert.equal(Boolean(run.id), true);
    assert.equal(run.status, 'queued');
    assert.equal(run.channelType, 'linkedin');
    assert.deepEqual(run.childRunIds, ['run_linkedin_1']);
    assert.equal(run.campaignTemplateName, 'Virtual Xperiences');
    assert.equal(run.enrolledAt, run.createdAt);
    assert.equal(run.holdCause, null);
    assert.equal(run.holdAttempts, 0);
    assert.equal(run.holdLastAttemptAt, null);
    assert.equal(run.apolloContactId, null);
    assert.equal(run.apolloSequenceId, null);
    assert.equal(run.apolloSequenceContactId, null);
    assert.equal(run.apolloEnrollmentStatus, null);
    assert.equal(run.apolloEnrolledAt, null);
    assert.equal(run.apolloLastPolledAt, null);

    const persisted = manager.getRun(run.id);
    assert.equal(persisted.accountId, 'account-1');
    assert.equal(persisted.prospectLabel, 'Jane Doe');
    assert.equal(persisted.metadata.source, 'unit-test');
  } finally {
    workspace.cleanup();
  }
});

test('CampaignRunManager attaches child runs and records waiting, paused, and resumable states', () => {
  const workspace = createTempWorkspace('campaign-run-manager-transitions-');
  try {
    const storePath = workspace.path('campaign-runs.json');
    const manager = new CampaignRunManager({ storePath });

    const created = manager.createRun({
      campaignTemplateName: 'Coordinated campaign',
      channelType: 'multi'
    });

    const attached = manager.attachChildRun(created.id, 'workflow-run-1');
    manager.attachChildRun(created.id, 'workflow-run-1');
    const waiting = manager.markWaiting(created.id, 'apollo_hold');
    const paused = manager.pauseRun(created.id, 'operator_pause');
    const resumed = manager.resumeRun(created.id);

    assert.deepEqual(attached.childRunIds, ['workflow-run-1']);
    assert.equal(waiting.status, 'waiting');
    assert.equal(waiting.waitReason, 'apollo_hold');
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pauseReason, 'operator_pause');
    assert.equal(paused.waitReason, null);
    assert.equal(resumed.status, 'queued');
    assert.equal(resumed.pauseReason, null);
  } finally {
    workspace.cleanup();
  }
});

test('CampaignRunManager normalizes malformed records and supports terminal transitions', () => {
  const workspace = createTempWorkspace('campaign-run-manager-normalize-');
  try {
    const storePath = workspace.path('campaign-runs.json');
    writeJson(storePath, {
      version: 1,
      runs: [
        {
          id: 'campaign-1',
          status: 'nonsense',
          channelType: 'email',
          childRunIds: ['workflow-run-1', 'workflow-run-1', '', null],
          metadata: [],
          createdAt: '2026-03-26T12:00:00.000Z',
          updatedAt: '2026-03-26T12:00:00.000Z'
        }
      ]
    });

    const manager = new CampaignRunManager({ storePath });
    const normalized = manager.getRun('campaign-1');
    assert.equal(normalized.status, 'queued');
    assert.equal(normalized.channelType, 'multi');
    assert.deepEqual(normalized.childRunIds, ['workflow-run-1']);
    assert.deepEqual(normalized.metadata, {});

    const suppressed = manager.suppressRun('campaign-1', 'sales_owned');
    const quarantined = manager.quarantineRun('campaign-1', 'linkedin_challenge');
    const failed = manager.failRun('campaign-1', 'child_run_failed');

    assert.equal(suppressed.status, 'suppressed');
    assert.equal(suppressed.suppressReason, 'sales_owned');
    assert.equal(Boolean(suppressed.suppressedAt), true);
    assert.equal(quarantined.status, 'quarantined');
    assert.equal(quarantined.quarantineReason, 'linkedin_challenge');
    assert.equal(Boolean(quarantined.quarantinedAt), true);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.terminalReason, 'child_run_failed');
  } finally {
    workspace.cleanup();
  }
});

test('CampaignRunManager persists Apollo hold attempts and clears them explicitly', () => {
  const workspace = createTempWorkspace('campaign-run-manager-apollo-hold-');
  try {
    const storePath = workspace.path('campaign-runs.json');
    const manager = new CampaignRunManager({ storePath });
    const created = manager.createRun({
      campaignTemplateName: 'Apollo Hold Campaign',
      channelType: 'multi'
    });

    const firstHold = manager.markApolloHold(created.id, 'unreachable');
    const secondHold = manager.markApolloHold(created.id, 'freshness_unknown');
    const thirdHold = manager.markApolloHold(created.id, 'freshness_unknown', { maxAttempts: 3 });

    assert.equal(firstHold.status, 'waiting');
    assert.equal(firstHold.waitReason, 'apollo_hold');
    assert.equal(firstHold.holdCause, 'unreachable');
    assert.equal(firstHold.holdAttempts, 1);
    assert.equal(Boolean(firstHold.holdLastAttemptAt), true);

    assert.equal(secondHold.status, 'waiting');
    assert.equal(secondHold.holdCause, 'freshness_unknown');
    assert.equal(secondHold.holdAttempts, 2);

    assert.equal(thirdHold.status, 'failed');
    assert.equal(thirdHold.terminalReason, 'apollo_hold_max_retries_exceeded');
    assert.equal(thirdHold.holdCause, 'freshness_unknown');
    assert.equal(thirdHold.holdAttempts, 3);

    const cleared = manager.clearApolloHold(created.id);
    assert.equal(cleared.status, 'queued');
    assert.equal(cleared.waitReason, null);
    assert.equal(cleared.terminalReason, null);
    assert.equal(cleared.holdCause, null);
    assert.equal(cleared.holdAttempts, 0);
    assert.equal(cleared.holdLastAttemptAt, null);
  } finally {
    workspace.cleanup();
  }
});

test('CampaignRunManager records Apollo enrollment with write-once timestamps and updates status separately', () => {
  const workspace = createTempWorkspace('campaign-run-manager-apollo-enrollment-');
  try {
    const storePath = workspace.path('campaign-runs.json');
    const manager = new CampaignRunManager({ storePath });
    const created = manager.createRun({
      campaignTemplateName: 'Apollo Enrollment Campaign',
      channelType: 'multi',
      apolloContactId: 'contact-preflight-1',
      apolloSequenceId: 'seq-1'
    });

    const firstEnrollment = manager.recordApolloEnrollment(created.id, {
      apolloContactId: 'contact-preflight-1',
      apolloSequenceId: 'seq-1',
      apolloSequenceContactId: 'seq-contact-1',
      apolloEnrolledAt: '2026-03-27T12:00:00.000Z'
    });
    const secondEnrollment = manager.recordApolloEnrollment(created.id, {
      apolloContactId: 'contact-preflight-1',
      apolloSequenceId: 'seq-1',
      apolloSequenceContactId: 'seq-contact-1',
      apolloEnrolledAt: '2026-03-27T13:00:00.000Z'
    });
    const polled = manager.updateApolloEnrollmentStatus(created.id, {
      status: 'finished',
      lastPolledAt: '2026-03-27T14:00:00.000Z'
    });

    assert.equal(firstEnrollment.apolloContactId, 'contact-preflight-1');
    assert.equal(firstEnrollment.apolloSequenceId, 'seq-1');
    assert.equal(firstEnrollment.apolloSequenceContactId, 'seq-contact-1');
    assert.equal(firstEnrollment.apolloEnrollmentStatus, 'active');
    assert.equal(firstEnrollment.apolloEnrolledAt, '2026-03-27T12:00:00.000Z');

    assert.equal(secondEnrollment.apolloEnrolledAt, '2026-03-27T12:00:00.000Z');
    assert.equal(secondEnrollment.apolloSequenceContactId, 'seq-contact-1');

    assert.equal(polled.apolloEnrollmentStatus, 'finished');
    assert.equal(polled.apolloLastPolledAt, '2026-03-27T14:00:00.000Z');
    assert.equal(polled.apolloSequenceContactId, 'seq-contact-1');
    assert.equal(polled.apolloEnrolledAt, '2026-03-27T12:00:00.000Z');
  } finally {
    workspace.cleanup();
  }
});

test('CampaignRunManager rejects conflicting Apollo sequence-contact ids for the same campaign run', () => {
  const workspace = createTempWorkspace('campaign-run-manager-apollo-enrollment-conflict-');
  try {
    const storePath = workspace.path('campaign-runs.json');
    const manager = new CampaignRunManager({ storePath });
    const created = manager.createRun({
      campaignTemplateName: 'Apollo Enrollment Conflict Campaign',
      channelType: 'multi'
    });

    manager.recordApolloEnrollment(created.id, {
      apolloSequenceId: 'seq-1',
      apolloSequenceContactId: 'seq-contact-1',
      apolloEnrolledAt: '2026-03-27T12:00:00.000Z'
    });

    assert.throws(() => manager.recordApolloEnrollment(created.id, {
      apolloSequenceId: 'seq-1',
      apolloSequenceContactId: 'seq-contact-2',
      apolloEnrolledAt: '2026-03-27T13:00:00.000Z'
    }), /different Apollo sequence-contact id/i);
  } finally {
    workspace.cleanup();
  }
});
