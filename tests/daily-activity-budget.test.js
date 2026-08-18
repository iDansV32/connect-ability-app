'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_DAILY_BUDGET,
  getActivityBudget,
  canConsumeActivityBudget,
  consumeActivityBudget
} = require('../automation/safety/daily-activity-budget');
const { createTempWorkspace } = require('./test-helpers');

function futureDate(hours = 24) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

test('DEFAULT_DAILY_BUDGET is a positive integer', () => {
  assert.ok(Number.isInteger(DEFAULT_DAILY_BUDGET) && DEFAULT_DAILY_BUDGET > 0);
});

test('getActivityBudget initialises fresh budget with used=0 and default limit', () => {
  const workspace = createTempWorkspace('daily-budget-init-');
  try {
    const budgetPath = workspace.path('budget.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    const budget = getActivityBudget({ budgetPath, now });
    assert.equal(budget.used, 0);
    assert.equal(budget.limit, DEFAULT_DAILY_BUDGET);
    assert.ok(budget.resetTime, 'resetTime must be set');
  } finally {
    workspace.cleanup();
  }
});

test('canConsumeActivityBudget returns allowed:true on a fresh budget', () => {
  const workspace = createTempWorkspace('daily-budget-can-');
  try {
    const budgetPath = workspace.path('budget.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    const result = canConsumeActivityBudget(1, { budgetPath, now });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.exceeded, []);
    assert.equal(result.remaining, DEFAULT_DAILY_BUDGET);
  } finally {
    workspace.cleanup();
  }
});

test('consumeActivityBudget increments used and reports remaining correctly', () => {
  const workspace = createTempWorkspace('daily-budget-consume-');
  try {
    const budgetPath = workspace.path('budget.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    const r1 = consumeActivityBudget(5, { budgetPath, now });
    assert.equal(r1.allowed, true);
    assert.equal(r1.used, 5);
    assert.equal(r1.remaining, DEFAULT_DAILY_BUDGET - 5);

    const r2 = consumeActivityBudget(10, { budgetPath, now });
    assert.equal(r2.allowed, true);
    assert.equal(r2.used, 15);
    assert.equal(r2.remaining, DEFAULT_DAILY_BUDGET - 15);
  } finally {
    workspace.cleanup();
  }
});

test('consumeActivityBudget blocks once the limit is reached', () => {
  const workspace = createTempWorkspace('daily-budget-block-');
  try {
    const budgetPath = workspace.path('budget.json');
    const now = new Date('2026-03-21T12:00:00.000Z');
    const limit = 5;

    consumeActivityBudget(5, { budgetPath, now, dailyBudget: limit });

    const blocked = canConsumeActivityBudget(1, { budgetPath, now, dailyBudget: limit });
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.exceeded.includes('daily_total'));
    assert.equal(blocked.remaining, 0);
  } finally {
    workspace.cleanup();
  }
});

test('budget is per-account — one account exhausted does not block another', () => {
  const workspace = createTempWorkspace('daily-budget-isolation-');
  try {
    const budgetPath = workspace.path('budget.json');
    const now = new Date('2026-03-21T12:00:00.000Z');
    const limit = 3;

    consumeActivityBudget(3, { budgetPath, now, dailyBudget: limit, accountId: 'acc-A' });

    const blocked = canConsumeActivityBudget(1, { budgetPath, now, dailyBudget: limit, accountId: 'acc-A' });
    assert.equal(blocked.allowed, false);

    const other = canConsumeActivityBudget(1, { budgetPath, now, dailyBudget: limit, accountId: 'acc-B' });
    assert.equal(other.allowed, true);
  } finally {
    workspace.cleanup();
  }
});

test('budget resets to zero after 24 hours', () => {
  const workspace = createTempWorkspace('daily-budget-reset-');
  try {
    const budgetPath = workspace.path('budget.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    consumeActivityBudget(DEFAULT_DAILY_BUDGET, { budgetPath, now });

    const blocked = canConsumeActivityBudget(1, { budgetPath, now });
    assert.equal(blocked.allowed, false);

    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    const fresh = canConsumeActivityBudget(1, { budgetPath, now: later });
    assert.equal(fresh.allowed, true);
    assert.equal(fresh.used, 0);
  } finally {
    workspace.cleanup();
  }
});

test('dailyBudget option overrides the default limit', () => {
  const workspace = createTempWorkspace('daily-budget-custom-');
  try {
    const budgetPath = workspace.path('budget.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    const budget = getActivityBudget({ budgetPath, now, dailyBudget: 200 });
    assert.equal(budget.limit, 200);
  } finally {
    workspace.cleanup();
  }
});

test('accountEmail is used as account key when accountId is absent', () => {
  const workspace = createTempWorkspace('daily-budget-email-key-');
  try {
    const budgetPath = workspace.path('budget.json');
    const now = new Date('2026-03-21T12:00:00.000Z');

    consumeActivityBudget(10, { budgetPath, now, accountEmail: 'seller@example.com' });

    const check = getActivityBudget({ budgetPath, now, accountEmail: 'seller@example.com' });
    assert.equal(check.used, 10);

    const other = getActivityBudget({ budgetPath, now, accountEmail: 'other@example.com' });
    assert.equal(other.used, 0);
  } finally {
    workspace.cleanup();
  }
});
