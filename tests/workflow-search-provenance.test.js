'use strict';

/**
 * tests/workflow-search-provenance.test.js
 *
 * Proves that a People-search receipt's provenance (source / searchTerm /
 * searchRank / searchResultIndex / searchPageUrl) is preserved end-to-end from
 * a structured workflow target through to the prospect record and the recorded
 * activity event — so "rank 1 from search is the profile liked" and "rank 2 is
 * the profile connected" are verifiable, not assumed.
 *
 * Three layers, all offline (no LinkedIn, no Playwright, no credentials):
 *   A. ProspectQueueStore.upsertWorkflowTargets — persists provenance onto the
 *      prospect (sourceType:'search' + metadata.search) and returns it on the
 *      resolved target.
 *   B. WorkflowRunManager.createRun — target + job carry profileUrl, provenance
 *      survives a read round-trip (normalizeRunRecord).
 *   C. durable workflow scheduler — the like/connect activity event metadata
 *      carries searchRank/source for the exact target.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const ProspectQueueStore = require('../prospect-queue-store');
const WorkflowRunManager = require('../workflow-run-manager');
const { createDurableWorkflowScheduler } = require('../automation/runtime/durable-workflow-scheduler');
const { createTempWorkspace } = require('./test-helpers');

const SEARCH_PAGE = 'https://www.linkedin.com/search/results/people/?keywords=software%20engineer';

// A People-search receipt entry as produced by buildPeopleSearchProfiles.
function receiptProfile(rank, slug) {
  return {
    source: 'linkedin_people_search',
    searchTerm: 'software engineer',
    searchRank: rank,
    searchResultIndex: rank,
    searchPageUrl: SEARCH_PAGE,
    profileUrl: `https://www.linkedin.com/in/${slug}`,
    name: `Profile ${rank}`
  };
}

// ---------------------------------------------------------------------------
// A. ProspectQueueStore — provenance persisted on the prospect + resolved target
// ---------------------------------------------------------------------------

describe('upsertWorkflowTargets — search provenance', () => {
  test('persists sourceType:"search" + metadata.search and returns searchProvenance on the target', () => {
    const ws = createTempWorkspace('prov-store-');
    try {
      const store = new ProspectQueueStore({ storePath: ws.path('prospect-queue.json') });
      const resolved = store.upsertWorkflowTargets({
        accountId: 'acc-1',
        accountName: 'Acc One',
        workflowId: 'wf-1',
        workflowName: 'Search WF',
        targetType: 'group',
        targets: [receiptProfile(1, 'alpha'), receiptProfile(2, 'bravo')]
      });

      // Resolved target carries provenance + the exact profile URL.
      assert.equal(resolved.length, 2);
      assert.equal(resolved[0].profileUrl, 'https://www.linkedin.com/in/alpha');
      assert.equal(resolved[0].searchProvenance.searchRank, 1);
      assert.equal(resolved[0].searchProvenance.source, 'linkedin_people_search');
      assert.equal(resolved[1].searchProvenance.searchRank, 2);

      // Prospect record stores search sourceType + nested metadata.search.
      const prospects = store.getAllProspects({ accountId: 'acc-1' });
      const alpha = prospects.find((p) => p.profileUrl === 'https://www.linkedin.com/in/alpha');
      assert.ok(alpha, 'alpha prospect persisted');
      assert.equal(alpha.sourceType, 'search');
      assert.equal(alpha.metadata.search.searchRank, 1);
      assert.equal(alpha.metadata.search.searchTerm, 'software engineer');
      assert.equal(alpha.metadata.search.searchPageUrl, SEARCH_PAGE);
    } finally {
      ws.cleanup();
    }
  });

  test('non-search workflow targets keep their workflow sourceType and carry no provenance', () => {
    const ws = createTempWorkspace('prov-store-plain-');
    try {
      const store = new ProspectQueueStore({ storePath: ws.path('prospect-queue.json') });
      const resolved = store.upsertWorkflowTargets({
        accountId: 'acc-2',
        targetType: 'group',
        targets: ['https://www.linkedin.com/in/plain']
      });
      assert.equal(resolved[0].searchProvenance, undefined);
      const [p] = store.getAllProspects({ accountId: 'acc-2' });
      assert.equal(p.sourceType, 'group');
      assert.equal(p.metadata.search, undefined);
    } finally {
      ws.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// B. WorkflowRunManager — provenance + profileUrl on target/job, survives re-read
// ---------------------------------------------------------------------------

describe('WorkflowRunManager.createRun — search provenance', () => {
  test('target carries profileUrl + searchProvenance; job targetValue is the profile URL; survives re-read', () => {
    const ws = createTempWorkspace('prov-wrm-');
    try {
      const manager = new WorkflowRunManager({
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      });
      const { run, jobs } = manager.createRun({
        workflowName: 'Prov Run',
        accountId: 'acc-1',
        steps: [{ type: 'like_posts' }],
        targets: [{
          value: 'https://www.linkedin.com/in/alpha',
          profileUrl: 'https://www.linkedin.com/in/alpha',
          prospectId: 'p-alpha',
          searchProvenance: { source: 'linkedin_people_search', searchTerm: 'software engineer', searchRank: 1, searchResultIndex: 1, searchPageUrl: SEARCH_PAGE }
        }]
      });

      assert.equal(run.targets[0].profileUrl, 'https://www.linkedin.com/in/alpha');
      assert.equal(run.targets[0].searchProvenance.searchRank, 1);
      assert.equal(jobs[0].targetValue, 'https://www.linkedin.com/in/alpha');

      // Re-read through normalizeRunRecord (fresh manager, same files) — provenance survives.
      const reread = new WorkflowRunManager({
        runsPath: ws.path('runs.json'),
        jobsPath: ws.path('jobs.json')
      }).getRun(run.id);
      assert.equal(reread.targets[0].searchProvenance.searchRank, 1);
      assert.equal(reread.targets[0].searchProvenance.source, 'linkedin_people_search');
      assert.equal(reread.targets[0].profileUrl, 'https://www.linkedin.com/in/alpha');
    } finally {
      ws.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// C. Scheduler — like/connect activity event metadata carries searchRank/source
// ---------------------------------------------------------------------------

function makeSchedulerDeps(manager, dispatchFn, recordedEvents) {
  const worker = new EventEmitter();
  return {
    workflowRunManager: manager,
    accountWorkerProcessManager: { getOrCreate: () => worker, dispatchAndAwaitResult: dispatchFn },
    linkedInAccountHealthStore: { getCoolingDownAccountIds: () => [], getChallengedAccountIds: () => [] },
    prospectQueueStore: { getProspect: () => null, applyLeadScores: () => [] },
    sdrAgentManager: { getAgent: () => null },
    campaignController: { notifyChildRunFinalized: () => {}, executeApolloEnrollmentStep: async () => ({ stepResult: null }) },
    isWithinWorkingHours: () => true,
    scoreProspect: () => ({ score: 50, scoreBreakdown: {} }),
    loadLinkedInCredentials: async () => ({ id: 'acc-1', email: 'a@example.com', password: 'pw' }),
    ensureLinkedInAccountsStore: () => ({ accounts: [] }),
    recordActivityEvent: (e) => recordedEvents.push(e),
    updateProspectWorkflowProgress: () => null,
    emitWorkflowLog: () => {},
    onRunStatusChange: () => {},
    broadcastWorkflowRunsUpdated: () => {},
    broadcastCampaignRunsUpdated: () => {},
    broadcastProspectsUpdated: () => {},
    retryApolloHeldRuns: async () => {},
    processApolloCampaignPolls: async () => {},
    registerRuntimeJob: () => {},
    unregisterRuntimeJob: () => {},
    createRuntimeJobId: (t, a) => `${t}-${a}-${Date.now()}`,
    recordWorkflowHealthSuccess: () => {},
    recordWorkflowHealthFailure: () => {},
    isAppReady: () => true
  };
}

async function runOneStepAndCollectEvents({ ws, stepType, actionEventType, slug, rank }) {
  const manager = new WorkflowRunManager({ runsPath: ws.path('runs.json'), jobsPath: ws.path('jobs.json') });
  const recorded = [];
  const dispatchFn = async () => ({
    stepResult: {
      outcomeType: 'completed',
      success: true,
      stepType,
      profileUrl: `https://www.linkedin.com/in/${slug}`,
      recipientName: `Profile ${rank}`
    }
  });
  const scheduler = createDurableWorkflowScheduler(makeSchedulerDeps(manager, dispatchFn, recorded));

  const { run } = manager.createRun({
    workflowName: 'Action Run',
    accountId: 'acc-1',
    steps: [{ type: stepType }],
    targets: [{
      value: `https://www.linkedin.com/in/${slug}`,
      profileUrl: `https://www.linkedin.com/in/${slug}`,
      prospectId: `p-${slug}`,
      searchProvenance: { source: 'linkedin_people_search', searchTerm: 'software engineer', searchRank: rank, searchResultIndex: rank, searchPageUrl: SEARCH_PAGE }
    }]
  });

  const job = manager.claimDueJobs({ before: new Date().toISOString(), limit: 1, leaseMs: 300000 })[0];
  assert.ok(job, 'job claimable');
  await scheduler.executeDurableWorkflowJob(job);

  const actionEvent = recorded.find((e) => e.type === actionEventType);
  return { run, actionEvent, recorded };
}

describe('durable scheduler — action event provenance', () => {
  test('like rank 1: post_liked event URL === rank-1 profile, metadata.searchRank === 1', async () => {
    const ws = createTempWorkspace('prov-like-');
    try {
      const { actionEvent } = await runOneStepAndCollectEvents({
        ws, stepType: 'like_posts', actionEventType: 'post_liked', slug: 'alpha', rank: 1
      });
      assert.ok(actionEvent, 'post_liked event recorded');
      assert.equal(actionEvent.profileUrl, 'https://www.linkedin.com/in/alpha');
      assert.equal(actionEvent.metadata.searchRank, 1);
      assert.equal(actionEvent.metadata.source, 'linkedin_people_search');
      assert.equal(actionEvent.metadata.searchSource, 'linkedin_people_search');
      assert.equal(actionEvent.metadata.searchTerm, 'software engineer');
      assert.equal(actionEvent.metadata.searchPageUrl, SEARCH_PAGE);
    } finally {
      ws.cleanup();
    }
  });

  test('connect rank 2: connection_requested event URL === rank-2 profile, metadata.searchRank === 2', async () => {
    const ws = createTempWorkspace('prov-connect-');
    try {
      const { actionEvent } = await runOneStepAndCollectEvents({
        ws, stepType: 'send_connection', actionEventType: 'connection_requested', slug: 'bravo', rank: 2
      });
      assert.ok(actionEvent, 'connection_requested event recorded');
      assert.equal(actionEvent.profileUrl, 'https://www.linkedin.com/in/bravo');
      assert.equal(actionEvent.metadata.searchRank, 2);
      assert.equal(actionEvent.metadata.source, 'linkedin_people_search');
      assert.equal(actionEvent.metadata.searchSource, 'linkedin_people_search');
    } finally {
      ws.cleanup();
    }
  });

  test('non-search target: action event metadata has no searchRank/source', async () => {
    const ws = createTempWorkspace('prov-none-');
    try {
      const manager = new WorkflowRunManager({ runsPath: ws.path('runs.json'), jobsPath: ws.path('jobs.json') });
      const recorded = [];
      const dispatchFn = async () => ({
        stepResult: { outcomeType: 'completed', success: true, stepType: 'like_posts', profileUrl: 'https://www.linkedin.com/in/plain' }
      });
      const scheduler = createDurableWorkflowScheduler(makeSchedulerDeps(manager, dispatchFn, recorded));
      manager.createRun({
        workflowName: 'Plain Run', accountId: 'acc-1', steps: [{ type: 'like_posts' }],
        targets: [{ value: 'https://www.linkedin.com/in/plain', profileUrl: 'https://www.linkedin.com/in/plain', prospectId: 'p-plain' }]
      });
      const job = manager.claimDueJobs({ before: new Date().toISOString(), limit: 1, leaseMs: 300000 })[0];
      await scheduler.executeDurableWorkflowJob(job);
      const liked = recorded.find((e) => e.type === 'post_liked');
      assert.ok(liked);
      assert.equal(liked.metadata.searchRank, undefined);
      assert.equal(liked.metadata.source, undefined);
      assert.equal(liked.metadata.searchSource, undefined);
    } finally {
      ws.cleanup();
    }
  });
});
