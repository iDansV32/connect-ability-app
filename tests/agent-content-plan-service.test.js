const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentContentPlan } = require('../agent-content-plan-service');

test('buildAgentContentPlan creates 90 scheduled agent-plan posts with metadata', () => {
  const plan = buildAgentContentPlan({
    id: 'agent-1',
    name: 'Customer Success SDR',
    accountId: 'acct-1',
    accountName: 'CS Account',
    niche: 'Customer success leaders in SaaS',
    contentPillars: ['Retention', 'Expansion'],
    personaTitles: ['Chief of Staff', 'Head of People'],
    searchKeywords: ['customer success', 'people ops'],
    postCadence: 'daily',
    timezone: 'America/Chicago'
  }, {
    days: 90,
    startDate: '2026-03-22',
    postingTime: '09:30'
  });

  assert.equal(plan.posts.length, 90);
  assert.equal(plan.cadence, 'daily');
  assert.equal(plan.posts[0].scheduledDate, '2026-03-22');
  assert.equal(plan.posts[0].scheduledTime, '09:30');
  assert.equal(plan.posts[0].agentId, 'agent-1');
  assert.equal(plan.posts[0].sourceType, 'agent_plan');
  assert.equal(plan.posts[0].planId, plan.planId);
  assert.ok(plan.posts[0].content.includes('Customer success leaders in SaaS'));
});

test('buildAgentContentPlan respects weekday cadence and follow-on dates', () => {
  const plan = buildAgentContentPlan({
    id: 'agent-2',
    name: 'People Ops SDR',
    accountId: 'acct-2',
    niche: 'People operations',
    contentPillars: ['Hiring'],
    personaTitles: ['Head of People'],
    searchKeywords: ['people ops'],
    postCadence: 'weekdays'
  }, {
    days: 5,
    startDate: '2026-03-20',
    postingTime: '08:00'
  });

  assert.deepEqual(
    plan.posts.map((post) => post.scheduledDate),
    ['2026-03-20', '2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26']
  );
});
