const test = require('node:test');
const assert = require('node:assert/strict');

const CampaignController = require('../campaign-controller');
const CampaignRunManager = require('../campaign-run-manager');
const ApolloPollStore = require('../apollo-poll-store');
const WorkflowRunManager = require('../workflow-run-manager');
const { createTempWorkspace, writeJson } = require('./test-helpers');

test('CampaignController creates prospect-scoped campaign runs and linked child workflow runs', async () => {
  const workspace = createTempWorkspace('campaign-controller-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const controller = new CampaignController({ campaignRuns, workflowRuns });

    const created = await controller.createCoordinatedWorkflowRuns({
      campaignRunInput: {
        campaignTemplateId: 'template-1',
        campaignTemplateName: 'Virtual Xperiences',
        accountId: 'account-1',
        accountName: 'Seller',
        agentId: 'agent-1',
        agentName: 'Outbound Agent',
        metadata: {
          source: 'unit-test'
        }
      },
      workflowRunInput: {
        workflowId: 'workflow-1',
        workflowName: '14 Day Sequence',
        accountId: 'account-1',
        accountName: 'Seller',
        agentId: 'agent-1',
        agentName: 'Outbound Agent',
        steps: [
          { type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }
        ],
        targets: [
          { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' },
          { prospectId: 'prospect-2', value: 'https://www.linkedin.com/in/john-doe/', label: 'John Doe' }
        ]
      }
    });

    assert.equal(created.campaignRuns.length, 2);
    assert.equal(created.workflowRuns.length, 2);
    assert.equal(created.jobs.length, 2);

    created.campaignRuns.forEach((campaignRun, index) => {
      const workflowRun = created.workflowRuns[index];
      assert.equal(workflowRun.campaignRunId, campaignRun.id);
      assert.deepEqual(campaignRun.childRunIds, [workflowRun.id]);
      assert.equal(campaignRun.prospectId, workflowRun.targets[0].prospectId);
      assert.equal(campaignRun.prospectLabel, workflowRun.targets[0].label);
    });
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController cancels the campaign run if child workflow creation fails', async () => {
  const workspace = createTempWorkspace('campaign-controller-error-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const workflowRuns = {
      createRun() {
        throw new Error('boom');
      }
    };
    const controller = new CampaignController({ campaignRuns, workflowRuns });

    await assert.rejects(() => controller.createCoordinatedWorkflowRun({
      campaignRunInput: {
        campaignTemplateName: 'Test Campaign'
      },
      workflowRunInput: {
        workflowName: 'Test Workflow',
        steps: [
          { type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }
        ],
        targets: [
          { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
        ]
      }
    }), /boom/);

    const [campaignRun] = campaignRuns.getAllRuns();
    assert.equal(campaignRun.status, 'cancelled');
    assert.equal(campaignRun.terminalReason, 'workflow_creation_failed');
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController cancels only stale orphaned campaign runs during startup reconciliation', () => {
  const workspace = createTempWorkspace('campaign-controller-orphans-');
  try {
    const oldTimestamp = '2026-03-27T00:00:00.000Z';
    const recentTimestamp = '2026-03-27T00:08:30.000Z';
    const now = '2026-03-27T00:10:00.000Z';
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const validWorkflow = workflowRuns.createRun({
      workflowName: 'Valid Child',
      accountId: 'account-1',
      steps: [
        { type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }
      ],
      targets: [
        { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
      ]
    });

    writeJson(workspace.path('campaign-runs.json'), {
      version: 1,
      runs: [
        {
          id: 'orphan-empty',
          campaignTemplateName: 'Orphan Empty',
          status: 'queued',
          channelType: 'multi',
          childRunIds: [],
          createdAt: oldTimestamp,
          updatedAt: oldTimestamp
        },
        {
          id: 'orphan-missing',
          campaignTemplateName: 'Orphan Missing',
          status: 'running',
          channelType: 'multi',
          childRunIds: ['missing-run-id'],
          createdAt: oldTimestamp,
          updatedAt: oldTimestamp
        },
        {
          id: 'recent-empty',
          campaignTemplateName: 'Recent Empty',
          status: 'queued',
          channelType: 'multi',
          childRunIds: [],
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp
        },
        {
          id: 'valid-linked',
          campaignTemplateName: 'Valid Linked',
          status: 'queued',
          channelType: 'multi',
          childRunIds: [validWorkflow.run.id],
          createdAt: oldTimestamp,
          updatedAt: oldTimestamp
        }
      ]
    });

    const controller = new CampaignController({ campaignRuns, workflowRuns });
    const reconciled = controller.reconcileOrphanedCampaignRuns({
      orphanOlderThanMs: 5 * 60 * 1000,
      now
    });

    assert.deepEqual(reconciled.map((run) => run.id).sort(), ['orphan-empty', 'orphan-missing']);
    assert.equal(campaignRuns.getRun('orphan-empty').status, 'cancelled');
    assert.equal(campaignRuns.getRun('orphan-empty').terminalReason, 'orphaned_on_startup');
    assert.equal(campaignRuns.getRun('orphan-missing').status, 'cancelled');
    assert.equal(campaignRuns.getRun('recent-empty').status, 'queued');
    assert.equal(campaignRuns.getRun('valid-linked').status, 'queued');
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController finalizes campaigns when all child runs become terminal', () => {
  const workspace = createTempWorkspace('campaign-controller-finalization-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const controller = new CampaignController({ campaignRuns, workflowRuns });

    const completedChild = workflowRuns.createRun({
      workflowName: 'Completed Child',
      accountId: 'account-1',
      steps: [{ type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }],
      targets: [{ prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }]
    });
    workflowRuns.updateRunMetadata(completedChild.run.id, { status: 'completed', completedAt: '2026-03-27T00:00:00.000Z' });

    const cancelledChild = workflowRuns.createRun({
      workflowName: 'Cancelled Child',
      accountId: 'account-1',
      steps: [{ type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }],
      targets: [{ prospectId: 'prospect-2', value: 'https://www.linkedin.com/in/john-doe/', label: 'John Doe' }]
    });
    workflowRuns.cancelRun(cancelledChild.run.id, 'operator_cancelled');

    const failedChild = workflowRuns.createRun({
      workflowName: 'Failed Child',
      accountId: 'account-1',
      steps: [{ type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }],
      targets: [{ prospectId: 'prospect-3', value: 'https://www.linkedin.com/in/alex-doe/', label: 'Alex Doe' }]
    });
    workflowRuns.updateRunMetadata(failedChild.run.id, { status: 'failed', completedAt: '2026-03-27T00:01:00.000Z' });

    const mixedCampaign = campaignRuns.createRun({
      campaignTemplateName: 'Mixed Campaign',
      childRunIds: [completedChild.run.id, cancelledChild.run.id]
    });
    const failedCampaign = campaignRuns.createRun({
      campaignTemplateName: 'Failed Campaign',
      childRunIds: [completedChild.run.id, failedChild.run.id]
    });
    const cancelledCampaign = campaignRuns.createRun({
      campaignTemplateName: 'Cancelled Campaign',
      childRunIds: [cancelledChild.run.id]
    });

    const mixedFinalized = controller.notifyChildRunFinalized(mixedCampaign.id, completedChild.run.id);
    const failedFinalized = controller.notifyChildRunFinalized(failedCampaign.id, failedChild.run.id);
    const cancelledFinalized = controller.notifyChildRunFinalized(cancelledCampaign.id, cancelledChild.run.id);

    assert.equal(mixedFinalized.status, 'completed');
    assert.equal(failedFinalized.status, 'failed');
    assert.equal(failedFinalized.terminalReason, 'child_run_failed');
    assert.equal(cancelledFinalized.status, 'cancelled');
    assert.equal(cancelledFinalized.terminalReason, 'child_runs_cancelled');
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController applies Apollo hold only before child workflow execution starts', () => {
  const workspace = createTempWorkspace('campaign-controller-apollo-hold-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const controller = new CampaignController({ campaignRuns, workflowRuns });

    const holdableCampaign = campaignRuns.createRun({
      campaignTemplateName: 'Holdable Campaign'
    });
    const held = controller.markApolloHold(holdableCampaign.id, 'unreachable');

    assert.equal(held.status, 'waiting');
    assert.equal(held.waitReason, 'apollo_hold');
    assert.equal(held.holdAttempts, 1);

    const runningChild = workflowRuns.createRun({
      workflowName: 'Running Child',
      accountId: 'account-1',
      steps: [{ type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }],
      targets: [{ prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }]
    });
    workflowRuns.updateRunMetadata(runningChild.run.id, { status: 'running' });

    const runningCampaign = campaignRuns.createRun({
      campaignTemplateName: 'Running Campaign',
      childRunIds: [runningChild.run.id]
    });
    const unchanged = controller.markApolloHold(runningCampaign.id, 'unreachable');

    assert.equal(unchanged.status, 'queued');
    assert.equal(unchanged.waitReason, null);
    assert.equal(unchanged.holdAttempts, 0);
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController retries Apollo holds on a fixed cadence and clears them when the dependency recovers', async () => {
  const workspace = createTempWorkspace('campaign-controller-apollo-retry-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const controller = new CampaignController({ campaignRuns, workflowRuns });

    const campaignRun = campaignRuns.createRun({
      campaignTemplateName: 'Retry Campaign'
    });
    const initialHold = campaignRuns.markApolloHold(campaignRun.id, 'unreachable');
    const initialHoldAt = Date.parse(initialHold.holdLastAttemptAt);

    const skippedRetry = await controller.retryApolloHoldCampaignRuns({
      now: new Date(initialHoldAt + (30 * 1000)).toISOString(),
      retryIntervalMs: 60 * 1000
    });
    assert.equal(skippedRetry.length, 0);
    assert.equal(campaignRuns.getRun(campaignRun.id).holdAttempts, 1);

    const retried = await controller.retryApolloHoldCampaignRuns({
      now: new Date(initialHoldAt + (90 * 1000)).toISOString(),
      retryIntervalMs: 60 * 1000,
      checkApolloHold: async () => ({ cleared: false, holdCause: 'freshness_unknown' })
    });
    assert.equal(retried.length, 1);
    assert.equal(retried[0].currentRun.status, 'waiting');
    assert.equal(retried[0].currentRun.holdAttempts, 2);
    assert.equal(retried[0].currentRun.holdCause, 'freshness_unknown');

    const cleared = await controller.retryApolloHoldCampaignRuns({
      now: new Date(Date.parse(retried[0].currentRun.holdLastAttemptAt) + (75 * 1000)).toISOString(),
      retryIntervalMs: 60 * 1000,
      checkApolloHold: async () => ({ cleared: true })
    });
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].currentRun.status, 'queued');
    assert.equal(cleared[0].currentRun.holdAttempts, 0);
    assert.equal(cleared[0].currentRun.holdCause, null);
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController holds Apollo-managed campaigns before child workflow creation when identity resolution is ambiguous', async () => {
  const workspace = createTempWorkspace('campaign-controller-apollo-identity-hold-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const prospects = {
      getProspect: () => ({
        id: 'prospect-1',
        fullName: 'Jane Doe',
        profileUrl: 'https://www.linkedin.com/in/jane-doe/',
        metadata: {}
      })
    };
    const controller = new CampaignController({
      campaignRuns,
      workflowRuns,
      prospects,
      createApolloClient: async () => ({
        getContact: async () => null,
        matchPerson: async () => ({
          candidates: [
            { contactId: 'contact-1' },
            { contactId: 'contact-2' }
          ]
        }),
        listUsers: async () => [],
        listContactStages: async () => [],
        listDealStages: async () => []
      })
    });

    const created = await controller.createCoordinatedWorkflowRun({
      campaignRunInput: {
        campaignTemplateName: 'Apollo Campaign'
      },
      workflowRunInput: {
        workflowName: 'Apollo Workflow',
        accountId: 'account-1',
        steps: [
          { type: 'apollo_enroll_sequence', sequenceId: 'seq-ambiguous', minDelayMs: 0, maxDelayMs: 0 }
        ],
        targets: [
          { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
        ]
      }
    });

    assert.equal(created.workflowRun, null);
    assert.deepEqual(created.jobs, []);
    assert.equal(created.campaignRun.status, 'waiting');
    assert.equal(created.campaignRun.waitReason, 'apollo_hold');
    assert.equal(created.campaignRun.holdCause, 'freshness_unknown');
    assert.deepEqual(created.campaignRun.childRunIds, []);
    assert.equal(created.campaignRun.apolloContactId, null);
    assert.equal(created.campaignRun.apolloSequenceId, 'seq-ambiguous');
    assert.equal(created.campaignRun.metadata.apolloPreflight.reason, 'apollo_identity_ambiguous');
    assert.equal(created.campaignRun.metadata.apolloPreflight.apolloSequenceId, 'seq-ambiguous');
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController creates a net-new Apollo contact, persists it, and proceeds when CRM eligibility passes', async () => {
  const workspace = createTempWorkspace('campaign-controller-apollo-create-contact-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const metadataPatches = [];
    const prospects = {
      getProspect: () => ({
        id: 'prospect-1',
        fullName: 'Jane Doe',
        profileUrl: 'https://www.linkedin.com/in/jane-doe/',
        metadata: {}
      }),
      updateProspectMetadata: (prospectId, metadataPatch) => {
        metadataPatches.push({ prospectId, metadataPatch });
        return { id: prospectId, metadata: metadataPatch };
      }
    };
    const controller = new CampaignController({
      campaignRuns,
      workflowRuns,
      prospects,
      createApolloClient: async () => ({
        getContact: async (contactId) => ({ id: contactId }),
        matchPerson: async () => null,
        createContact: async () => ({ id: 'contact-new' }),
        listUsers: async () => [],
        listContactStages: async () => [],
        listDealStages: async () => [],
        searchDeals: async () => [],
        searchTasks: async () => []
      })
    });

    const created = await controller.createCoordinatedWorkflowRun({
      campaignRunInput: {
        campaignTemplateName: 'Apollo Campaign'
      },
      workflowRunInput: {
        workflowName: 'Apollo Workflow',
        accountId: 'account-1',
        steps: [
          { type: 'apollo_enroll_sequence', sequenceId: 'seq-create-contact', minDelayMs: 0, maxDelayMs: 0 }
        ],
        targets: [
          { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
        ]
      }
    });

    assert.equal(Boolean(created.workflowRun?.id), true);
    assert.equal(created.campaignRun.status, 'queued');
    assert.equal(created.campaignRun.apolloContactId, 'contact-new');
    assert.equal(created.campaignRun.apolloSequenceId, 'seq-create-contact');
    assert.equal(created.campaignRun.metadata.apolloPreflight.status, 'eligible');
    assert.equal(created.campaignRun.metadata.apolloPreflight.apolloContactId, 'contact-new');
    assert.equal(created.campaignRun.metadata.apolloPreflight.apolloSequenceId, 'seq-create-contact');
    assert.equal(created.campaignRun.childRunIds.length, 1);
    assert.equal(metadataPatches.length, 1);
    assert.equal(metadataPatches[0].prospectId, 'prospect-1');
    assert.equal(metadataPatches[0].metadataPatch.integrations.apollo.apolloContactId, 'contact-new');
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController suppresses Apollo-managed campaigns when CRM eligibility returns suppression reasons', async () => {
  const workspace = createTempWorkspace('campaign-controller-apollo-suppressed-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const prospects = {
      getProspect: () => ({
        id: 'prospect-1',
        fullName: 'Jane Doe',
        profileUrl: 'https://www.linkedin.com/in/jane-doe/',
        metadata: {}
      })
    };
    const controller = new CampaignController({
      campaignRuns,
      workflowRuns,
      prospects,
      createApolloClient: async () => ({
        getContact: async () => ({
          id: 'contact-1',
          stageName: 'Customer'
        }),
        matchPerson: async () => ({
          id: 'person-1',
          contactId: 'contact-1'
        }),
        listUsers: async () => [],
        listContactStages: async () => [],
        listDealStages: async () => [],
        searchDeals: async () => [],
        searchTasks: async () => []
      })
    });

    const created = await controller.createCoordinatedWorkflowRun({
      campaignRunInput: {
        campaignTemplateName: 'Apollo Campaign'
      },
      workflowRunInput: {
        workflowName: 'Apollo Workflow',
        accountId: 'account-1',
        steps: [
          { type: 'apollo_enroll_sequence', sequenceId: 'seq-suppressed', minDelayMs: 0, maxDelayMs: 0 }
        ],
        targets: [
          { prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }
        ]
      }
    });

    assert.equal(created.workflowRun, null);
    assert.equal(created.campaignRun.status, 'suppressed');
    assert.equal(created.campaignRun.suppressReason, 'contact_stage_active_sales_process');
    assert.equal(created.campaignRun.apolloContactId, 'contact-1');
    assert.equal(created.campaignRun.apolloSequenceId, 'seq-suppressed');
    assert.deepEqual(created.campaignRun.metadata.apolloPreflight.suppressionReasons, [
      'contact_stage_active_sales_process'
    ]);
    assert.deepEqual(created.campaignRun.childRunIds, []);
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController records Apollo enrollment and creates a poll record when sequence-contact id is present', () => {
  const workspace = createTempWorkspace('campaign-controller-apollo-poll-create-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const apolloPolls = new ApolloPollStore({
      storePath: workspace.path('apollo-polls.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const controller = new CampaignController({
      campaignRuns,
      apolloPolls,
      workflowRuns
    });

    const campaignRun = campaignRuns.createRun({
      campaignTemplateName: 'Apollo Poll Campaign',
      apolloContactId: 'contact-1',
      apolloSequenceId: 'seq-1'
    });

    const recorded = controller.recordApolloEnrollment(campaignRun.id, {
      apolloContactId: 'contact-1',
      apolloSequenceId: 'seq-1',
      apolloSequenceContactId: 'seq-contact-1',
      apolloEnrolledAt: '2026-03-27T12:00:00.000Z'
    }, {
      nextPollAt: '2026-03-27T12:30:00.000Z',
      maxPolls: 12,
      pollIntervalMs: 15 * 60 * 1000
    });

    assert.equal(recorded.campaignRun.apolloContactId, 'contact-1');
    assert.equal(recorded.campaignRun.apolloSequenceId, 'seq-1');
    assert.equal(recorded.campaignRun.apolloSequenceContactId, 'seq-contact-1');
    assert.equal(recorded.campaignRun.metadata.apolloPolling.pollStatus, 'active');
    assert.equal(recorded.campaignRun.metadata.apolloPolling.pollCount, 0);
    assert.equal(recorded.campaignRun.metadata.apolloPolling.maxPolls, 12);
    assert.equal(recorded.pollRecord.nextPollAt, '2026-03-27T12:30:00.000Z');
    assert.equal(apolloPolls.getPollRecord(campaignRun.id).apolloSequenceContactId, 'seq-contact-1');
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController executes Apollo enrollment steps in main process and records polling metadata', async () => {
  const workspace = createTempWorkspace('campaign-controller-apollo-enroll-step-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const apolloPolls = new ApolloPollStore({
      storePath: workspace.path('apollo-polls.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    let addContactsPayload = null;
    const controller = new CampaignController({
      campaignRuns,
      apolloPolls,
      workflowRuns,
      createApolloClient: async () => ({
        addContactsToSequence: async (payload) => {
          addContactsPayload = payload;
          return {
            sequence_contact_id: 'seq-contact-1',
            status: 'active',
            created_at: '2026-03-27T12:00:00.000Z'
          };
        }
      })
    });

    const campaignRun = campaignRuns.createRun({
      campaignTemplateName: 'Apollo Enrollment Campaign',
      apolloContactId: 'contact-1',
      apolloSequenceId: 'seq-1'
    });

    const execution = await controller.executeApolloEnrollmentStep({
      campaignRunId: campaignRun.id,
      job: {
        stepType: 'apollo_enroll_sequence',
        targetValue: 'https://www.linkedin.com/in/jane-doe/',
        targetLabel: 'Jane Doe',
        step: {
          type: 'apollo_enroll_sequence',
          sequenceId: 'seq-1',
          emailAccountId: 'email-account-1'
        }
      }
    });

    assert.deepEqual(addContactsPayload, {
      sequenceId: 'seq-1',
      emailAccountId: 'email-account-1',
      contactIds: ['contact-1']
    });
    assert.equal(execution.stepResult.outcomeType, 'completed');
    assert.equal(execution.stepResult.metadata.apolloSequenceContactId, 'seq-contact-1');
    assert.equal(execution.stepResult.metadata.pollRecordCreated, true);
    assert.equal(execution.campaignRun.apolloSequenceContactId, 'seq-contact-1');
    assert.equal(apolloPolls.getPollRecord(campaignRun.id).apolloSequenceContactId, 'seq-contact-1');
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController pauses, suppresses, and resumes Apollo polling from LinkedIn-side campaign transitions', () => {
  const workspace = createTempWorkspace('campaign-controller-linkedin-propagation-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const apolloPolls = new ApolloPollStore({
      storePath: workspace.path('apollo-polls.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const controller = new CampaignController({
      campaignRuns,
      apolloPolls,
      workflowRuns
    });

    const pausableCampaign = campaignRuns.createRun({
      campaignTemplateName: 'LinkedIn Reply Campaign',
      apolloContactId: 'contact-1',
      apolloSequenceId: 'seq-1'
    });
    controller.recordApolloEnrollment(pausableCampaign.id, {
      apolloContactId: 'contact-1',
      apolloSequenceId: 'seq-1',
      apolloSequenceContactId: 'seq-contact-1'
    }, {
      nextPollAt: '2026-03-27T12:00:00.000Z',
      pollIntervalMs: 30 * 60 * 1000
    });

    const paused = controller.pauseCampaignFromLinkedIn(pausableCampaign.id, 'reply_received');
    assert.equal(paused.campaignRun.status, 'paused');
    assert.equal(paused.campaignRun.pauseReason, 'linkedin_reply:reply_received');
    assert.equal(paused.pollRecord.status, 'paused');
    assert.equal(paused.pollRecord.nextPollAt, null);

    const resumed = controller.resumeCampaignFromLinkedIn(pausableCampaign.id);
    assert.equal(resumed.campaignRun.status, 'queued');
    assert.equal(resumed.pollRecord.status, 'active');
    assert.equal(Boolean(resumed.pollRecord.nextPollAt), true);
    assert.match(resumed.pollRecord.nextPollAt, /^20/);

    const suppressibleCampaign = campaignRuns.createRun({
      campaignTemplateName: 'LinkedIn Unsubscribe Campaign',
      apolloContactId: 'contact-2',
      apolloSequenceId: 'seq-2'
    });
    controller.recordApolloEnrollment(suppressibleCampaign.id, {
      apolloContactId: 'contact-2',
      apolloSequenceId: 'seq-2',
      apolloSequenceContactId: 'seq-contact-2'
    }, {
      nextPollAt: '2026-03-27T12:00:00.000Z'
    });

    const suppressed = controller.suppressCampaignFromLinkedIn(suppressibleCampaign.id, 'unsubscribe_received');
    assert.equal(suppressed.campaignRun.status, 'suppressed');
    assert.equal(suppressed.campaignRun.suppressReason, 'linkedin_reply:unsubscribe_received');
    assert.equal(suppressed.pollRecord.status, 'completed');
    assert.equal(suppressed.pollRecord.lastPollResult.outcome, 'linkedin_suppressed');
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController treats Apollo enrollment API outages as transient workflow step failures', async () => {
  const workspace = createTempWorkspace('campaign-controller-apollo-enroll-transient-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const apolloPolls = new ApolloPollStore({
      storePath: workspace.path('apollo-polls.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const controller = new CampaignController({
      campaignRuns,
      apolloPolls,
      workflowRuns,
      createApolloClient: async () => ({
        addContactsToSequence: async () => {
          throw new Error('Apollo API error (503): upstream unavailable');
        }
      })
    });

    const campaignRun = campaignRuns.createRun({
      campaignTemplateName: 'Apollo Enrollment Campaign',
      apolloContactId: 'contact-1',
      apolloSequenceId: 'seq-1'
    });

    const execution = await controller.executeApolloEnrollmentStep({
      campaignRunId: campaignRun.id,
      job: {
        stepType: 'apollo_enroll_sequence',
        targetValue: 'https://www.linkedin.com/in/jane-doe/',
        targetLabel: 'Jane Doe',
        step: {
          type: 'apollo_enroll_sequence',
          sequenceId: 'seq-1'
        }
      }
    });

    assert.equal(execution.stepResult.outcomeType, 'failed_transient');
    assert.equal(execution.stepResult.metadata.apolloStatus, 503);
    assert.equal(apolloPolls.getPollRecord(campaignRun.id), null);
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController processes due Apollo polls and updates CampaignRun polling metadata', async () => {
  const workspace = createTempWorkspace('campaign-controller-apollo-poll-process-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const apolloPolls = new ApolloPollStore({
      storePath: workspace.path('apollo-polls.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const controller = new CampaignController({
      campaignRuns,
      apolloPolls,
      workflowRuns
    });

    const campaignRun = campaignRuns.createRun({
      campaignTemplateName: 'Apollo Poll Campaign',
      apolloContactId: 'contact-1',
      apolloSequenceId: 'seq-1',
      apolloEnrollmentStatus: 'active'
    });
    controller.recordApolloEnrollment(campaignRun.id, {
      apolloContactId: 'contact-1',
      apolloSequenceId: 'seq-1',
      apolloSequenceContactId: 'seq-contact-1'
    }, {
      nextPollAt: '2026-03-27T12:00:00.000Z'
    });

    const updates = await controller.processDueApolloPolls({
      now: '2026-03-27T12:30:00.000Z',
      pollApolloExecution: async () => ({
        outcome: 'ok',
        observedAt: '2026-03-27T12:30:00.000Z',
        apolloEnrollmentStatus: 'finished',
        sequenceContactStatus: 'finished',
        dealSnapshot: { count: 1, openCount: 0, stageNames: ['Closed Won'] },
        taskSnapshot: { count: 2, openCount: 0, completedCount: 2, recentTypes: ['meeting', 'call'] }
      })
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].currentPoll.status, 'completed');
    assert.equal(updates[0].currentPoll.pollCount, 1);
    assert.equal(updates[0].currentCampaignRun.apolloEnrollmentStatus, 'finished');
    assert.equal(updates[0].currentCampaignRun.apolloLastPolledAt, '2026-03-27T12:30:00.000Z');
    assert.equal(updates[0].currentCampaignRun.metadata.apolloPolling.pollStatus, 'completed');
    assert.equal(updates[0].currentCampaignRun.metadata.apolloPolling.lastPollResult.outcome, 'ok');
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController suppresses campaigns and drains child workflow runs from Apollo poll observations', async () => {
  const workspace = createTempWorkspace('campaign-controller-apollo-poll-suppress-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const apolloPolls = new ApolloPollStore({
      storePath: workspace.path('apollo-polls.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const controller = new CampaignController({
      campaignRuns,
      apolloPolls,
      workflowRuns
    });

    const createdWorkflow = workflowRuns.createRun({
      workflowName: 'Apollo Child Workflow',
      accountId: 'account-1',
      accountName: 'Seller',
      steps: [{ type: 'send_dm', messageTemplate: 'Hello', minDelayMs: 0, maxDelayMs: 0 }],
      targets: [{ prospectId: 'prospect-1', value: 'https://www.linkedin.com/in/jane-doe/', label: 'Jane Doe' }]
    });

    const campaignRun = campaignRuns.createRun({
      campaignTemplateName: 'Apollo Poll Campaign',
      accountId: 'account-1',
      accountName: 'Seller',
      prospectId: 'prospect-1',
      prospectLabel: 'Jane Doe',
      apolloContactId: 'contact-1',
      apolloSequenceId: 'seq-1',
      apolloEnrollmentStatus: 'active',
      childRunIds: [createdWorkflow.run.id]
    });
    controller.recordApolloEnrollment(campaignRun.id, {
      apolloContactId: 'contact-1',
      apolloSequenceId: 'seq-1',
      apolloSequenceContactId: 'seq-contact-1'
    }, {
      nextPollAt: '2026-03-27T12:00:00.000Z'
    });

    const updates = await controller.processDueApolloPolls({
      now: '2026-03-27T12:30:00.000Z',
      pollApolloExecution: async () => ({
        outcome: 'ok',
        observedAt: '2026-03-27T12:30:00.000Z',
        apolloEnrollmentStatus: 'active',
        contact: {
          stageName: 'Customer'
        },
        dealSnapshot: {
          nonClosedLostStageNames: ['Demo']
        },
        taskSnapshot: {
          latestMeetingOrCallCompletedAt: '2026-03-15T00:00:00.000Z'
        }
      })
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].transition.type, 'suppressed');
    assert.deepEqual(updates[0].transition.drainedChildRunIds, [createdWorkflow.run.id]);
    assert.equal(updates[0].currentCampaignRun.status, 'suppressed');
    assert.match(updates[0].currentCampaignRun.suppressReason, /apollo_poll:contact_stage_active_sales_process:stage=customer/);
    assert.match(updates[0].currentCampaignRun.suppressReason, /apollo_poll:deal_stage_not_closed_lost:stages=demo/);
    assert.match(updates[0].currentCampaignRun.suppressReason, /apollo_poll:meeting_booked_recently:task_completed_at=2026-03-15T00:00:00.000Z/);
    assert.equal(updates[0].currentPoll.status, 'completed');

    const drainedWorkflowRun = workflowRuns.getRun(createdWorkflow.run.id);
    assert.equal(drainedWorkflowRun.status, 'cancelled');
    assert.equal(drainedWorkflowRun.drainPending, false);
    assert.equal(Boolean(drainedWorkflowRun.drainCompletedAt), true);
    assert.equal(drainedWorkflowRun.lastError, updates[0].currentCampaignRun.suppressReason);
  } finally {
    workspace.cleanup();
  }
});

test('CampaignController default Apollo poll probe summarizes contact, deals, and tasks', async () => {
  const workspace = createTempWorkspace('campaign-controller-apollo-poll-default-probe-');
  try {
    const campaignRuns = new CampaignRunManager({
      storePath: workspace.path('campaign-runs.json')
    });
    const apolloPolls = new ApolloPollStore({
      storePath: workspace.path('apollo-polls.json')
    });
    const workflowRuns = new WorkflowRunManager({
      runsPath: workspace.path('workflow-runs.json'),
      jobsPath: workspace.path('workflow-step-jobs.json')
    });
    const controller = new CampaignController({
      campaignRuns,
      apolloPolls,
      workflowRuns,
      createApolloClient: async () => ({
        getContact: async () => ({
          id: 'contact-1',
          ownerId: 'user-1',
          stageName: 'Lead',
          lifecycleStage: 'lead',
          updatedAt: '2026-03-27T11:00:00.000Z'
        }),
        searchDeals: async () => ([
          { id: 'deal-1', status: 'closed_lost', stageName: 'Closed Lost' }
        ]),
        searchTasks: async () => ([
          { id: 'task-1', type: 'email', completedAt: null },
          { id: 'task-2', type: 'call', completedAt: '2026-02-10T10:00:00.000Z', updatedAt: '2026-02-10T10:00:00.000Z' }
        ]),
        listUsers: async () => ([
          { id: 'user-1', role: 'Sales' }
        ]),
        listDealStages: async () => ([
          { id: 'stage-closed-lost', name: 'Closed Lost' }
        ])
      })
    });

    const campaignRun = campaignRuns.createRun({
      campaignTemplateName: 'Apollo Poll Campaign',
      apolloContactId: 'contact-1',
      apolloSequenceId: 'seq-1',
      apolloEnrollmentStatus: 'active'
    });
    controller.recordApolloEnrollment(campaignRun.id, {
      apolloContactId: 'contact-1',
      apolloSequenceId: 'seq-1',
      apolloSequenceContactId: 'seq-contact-1'
    }, {
      nextPollAt: '2026-03-27T12:00:00.000Z'
    });

    const updates = await controller.processDueApolloPolls({
      now: '2026-03-27T12:30:00.000Z'
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].currentPoll.status, 'active');
    assert.equal(updates[0].currentPoll.pollCount, 1);
    assert.equal(updates[0].currentPoll.lastPollResult.contact.stageName, 'Lead');
    assert.equal(updates[0].currentPoll.lastPollResult.dealSnapshot.count, 1);
    assert.deepEqual(updates[0].currentPoll.lastPollResult.dealSnapshot.nonClosedLostStageNames, []);
    assert.equal(updates[0].currentPoll.lastPollResult.taskSnapshot.openCount, 1);
    assert.equal(updates[0].currentPoll.lastPollResult.taskSnapshot.latestMeetingOrCallCompletedAt, '2026-02-10T10:00:00.000Z');
    assert.equal(updates[0].currentCampaignRun.apolloLastPolledAt, '2026-03-27T12:30:00.000Z');
    assert.equal(updates[0].transition, null);
  } finally {
    workspace.cleanup();
  }
});
