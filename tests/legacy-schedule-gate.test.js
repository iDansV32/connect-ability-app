'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateLegacyScheduledMessageGate } = require('../automation/safety/legacy-schedule-gate');

function buildHealthStore({ challenged = false, cooling = false } = {}) {
  const calls = { isChallenged: [], isCoolingDown: [] };
  return {
    calls,
    isChallenged(accountId) {
      calls.isChallenged.push(accountId);
      return challenged;
    },
    isCoolingDown(accountId, subsystem, now) {
      calls.isCoolingDown.push({ accountId, subsystem, now });
      return cooling;
    }
  };
}

const ACCOUNT = { id: 'acc_1', timezoneId: 'America/Chicago', workingHours: null };

test('allows a healthy account inside working hours', () => {
  const healthStore = buildHealthStore();
  const decision = evaluateLegacyScheduledMessageGate({
    account: ACCOUNT,
    healthStore,
    workingHoursCheck: () => true
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, 'ok');
  assert.equal(decision.reason, null);
});

test('blocks when the account has an active challenge', () => {
  const decision = evaluateLegacyScheduledMessageGate({
    account: ACCOUNT,
    healthStore: buildHealthStore({ challenged: true }),
    workingHoursCheck: () => true
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'account_challenged');
  assert.match(decision.reason, /challenge/i);
});

test('blocks when the account is cooling down on the workflow subsystem', () => {
  const healthStore = buildHealthStore({ cooling: true });
  const decision = evaluateLegacyScheduledMessageGate({
    account: ACCOUNT,
    healthStore,
    workingHoursCheck: () => true
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'account_cooling_down');
  assert.equal(healthStore.calls.isCoolingDown[0].subsystem, 'workflow');
});

test('blocks outside working hours even when health is clean', () => {
  const decision = evaluateLegacyScheduledMessageGate({
    account: ACCOUNT,
    healthStore: buildHealthStore(),
    workingHoursCheck: () => false
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'outside_working_hours');
});

test('challenge check takes priority over working hours', () => {
  const decision = evaluateLegacyScheduledMessageGate({
    account: ACCOUNT,
    healthStore: buildHealthStore({ challenged: true }),
    workingHoursCheck: () => false
  });
  assert.equal(decision.code, 'account_challenged');
});

test('missing health store still enforces working hours', () => {
  const blocked = evaluateLegacyScheduledMessageGate({
    account: ACCOUNT,
    workingHoursCheck: () => false
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'outside_working_hours');

  const allowed = evaluateLegacyScheduledMessageGate({
    account: ACCOUNT,
    workingHoursCheck: () => true
  });
  assert.equal(allowed.allowed, true);
});

test('account without an id skips health checks instead of throwing', () => {
  const healthStore = buildHealthStore({ challenged: true });
  const decision = evaluateLegacyScheduledMessageGate({
    account: { timezoneId: 'America/Chicago' },
    healthStore,
    workingHoursCheck: () => true
  });
  assert.equal(decision.allowed, true);
  assert.equal(healthStore.calls.isChallenged.length, 0);
});

test('uses the real working-hours default when no predicate is injected (weekend blocked)', () => {
  // Saturday 03:00 UTC — outside the default Mon-Fri window in any timezone.
  const decision = evaluateLegacyScheduledMessageGate({
    account: { id: 'acc_1', timezoneId: 'UTC' },
    now: new Date('2026-08-01T03:00:00Z')
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'outside_working_hours');
});
