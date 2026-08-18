'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasActiveDmJobForProspect,
  resolveAcceptedConnectionFollowUpPlan
} = require('../accepted-connection-followup');

test('resolveAcceptedConnectionFollowUpPlan builds a one-step DM follow-up run for a fresh acceptance', () => {
  const plan = resolveAcceptedConnectionFollowUpPlan({
    event: {
      id: 'evt-1',
      type: 'connection_accepted',
      timestamp: '2026-03-23T10:00:00.000Z',
      accountId: 'account-1',
      accountName: 'Account One',
      agentId: 'agent-1',
      agentName: 'Agent One'
    },
    prospect: {
      id: 'prospect-1',
      fullName: 'Jane Doe',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/',
      accountId: 'account-1',
      accountName: 'Account One',
      agentId: 'agent-1',
      agentName: 'Agent One',
      state: 'active',
      metrics: {
        dmsSent: 0
      },
      metadata: {}
    },
    agent: {
      id: 'agent-1',
      name: 'Agent One',
      dmTemplatePrimary: 'Hi {firstName}, thanks for connecting.'
    },
    jobs: []
  });

  assert.equal(plan.shouldQueue, true);
  assert.equal(plan.templateInfo.slot, 'dm_primary');
  assert.equal(plan.runInput.workflowId, 'accepted-follow-up-agent-1');
  assert.equal(plan.runInput.steps.length, 1);
  assert.equal(plan.runInput.steps[0].type, 'send_dm');
  assert.equal(plan.runInput.steps[0].messageTemplate, 'Hi {firstName}, thanks for connecting.');
  assert.equal(plan.runInput.steps[0].metadata.autoAcceptedConnectionFollowUp, true);
  assert.equal(plan.runInput.targets[0].prospectId, 'prospect-1');
  assert.equal(plan.metadataPatch.acceptedConnectionFollowUpEventId, 'evt-1');
});

test('resolveAcceptedConnectionFollowUpPlan skips when outreach has already started', () => {
  const plan = resolveAcceptedConnectionFollowUpPlan({
    event: {
      type: 'connection_accepted',
      accountId: 'account-1'
    },
    prospect: {
      id: 'prospect-1',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/',
      accountId: 'account-1',
      agentId: 'agent-1',
      metrics: {
        dmsSent: 1
      },
      metadata: {}
    },
    agent: {
      id: 'agent-1',
      dmTemplatePrimary: 'Hi'
    }
  });

  assert.equal(plan.shouldQueue, false);
  assert.equal(plan.reason, 'outreach_already_started');
});

test('resolveAcceptedConnectionFollowUpPlan skips when the prospect is already marked do-not-contact', () => {
  const plan = resolveAcceptedConnectionFollowUpPlan({
    event: {
      type: 'connection_accepted',
      accountId: 'account-1'
    },
    prospect: {
      id: 'prospect-1',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/',
      accountId: 'account-1',
      agentId: 'agent-1',
      state: 'archived',
      metadata: {
        doNotContact: true
      }
    },
    agent: {
      id: 'agent-1',
      dmTemplatePrimary: 'Hi'
    }
  });

  assert.equal(plan.shouldQueue, false);
  assert.equal(plan.reason, 'do_not_contact');
});

test('resolveAcceptedConnectionFollowUpPlan skips when a prior accepted-connection follow-up is already queued in prospect metadata', () => {
  const plan = resolveAcceptedConnectionFollowUpPlan({
    event: {
      type: 'connection_accepted',
      accountId: 'account-1'
    },
    prospect: {
      id: 'prospect-1',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/',
      accountId: 'account-1',
      agentId: 'agent-1',
      metadata: {
        acceptedConnectionFollowUpQueuedAt: '2026-03-23T09:00:00.000Z'
      }
    },
    agent: {
      id: 'agent-1',
      dmTemplatePrimary: 'Hi'
    }
  });

  assert.equal(plan.shouldQueue, false);
  assert.equal(plan.reason, 'follow_up_already_queued');
});

test('hasActiveDmJobForProspect and planner skip when an active send_dm job already exists for the prospect', () => {
  const jobs = [
    {
      prospectId: 'prospect-1',
      stepType: 'send_dm',
      status: 'queued'
    }
  ];

  assert.equal(hasActiveDmJobForProspect(jobs, 'prospect-1'), true);

  const plan = resolveAcceptedConnectionFollowUpPlan({
    event: {
      type: 'connection_accepted',
      accountId: 'account-1'
    },
    prospect: {
      id: 'prospect-1',
      profileUrl: 'https://www.linkedin.com/in/jane-doe/',
      accountId: 'account-1',
      agentId: 'agent-1',
      metadata: {}
    },
    agent: {
      id: 'agent-1',
      dmTemplatePrimary: 'Hi'
    },
    jobs
  });

  assert.equal(plan.shouldQueue, false);
  assert.equal(plan.reason, 'active_dm_job_exists');
});
