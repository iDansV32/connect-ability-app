'use strict';

/**
 * tests/do-not-contact.test.js
 *
 * Targeted unit tests for the shared DNC policy module. Both the action-router
 * and the MCP server depend on resolveDoNotContactSummary behaving exactly
 * this way — these tests are the single source of truth for the rule.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDoNotContactSummary } = require('../automation/safety/do-not-contact');

test('returns blocked:false for null, undefined, primitives, and non-objects', () => {
  for (const input of [null, undefined, 0, '', 'archived', true, [1, 2, 3]]) {
    const result = resolveDoNotContactSummary(input);
    // Note: arrays are typeof 'object' so they pass the type guard. The
    // function treats them as prospects with no metadata/state, which
    // correctly returns blocked:false.
    if (Array.isArray(input)) {
      assert.equal(result.blocked, false, `array input should be unblocked`);
    } else {
      assert.deepEqual(result, { blocked: false }, `input=${String(input)}`);
    }
  }
});

test('archived state blocks with reason=prospect_archived', () => {
  const result = resolveDoNotContactSummary({
    id: 'p-1',
    state: 'archived',
    metadata: { archiveReason: 'unsubscribe_received' }
  });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'prospect_archived');
  assert.equal(result.archived, true);
  assert.equal(result.prospectId, 'p-1');
  assert.equal(result.archiveReason, 'unsubscribe_received');
});

test('metadata.doNotContact alone blocks with reason=do_not_contact', () => {
  const result = resolveDoNotContactSummary({
    id: 'p-2',
    state: 'active',
    metadata: { doNotContact: true }
  });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'do_not_contact');
  assert.equal(result.doNotContact, true);
  assert.equal(result.archived, false);
});

test('archived takes precedence over doNotContact in the reason', () => {
  // archiveProspect sets both flags; the canonical reason should be the more
  // specific 'prospect_archived'.
  const result = resolveDoNotContactSummary({
    id: 'p-3',
    state: 'archived',
    metadata: { doNotContact: true, archiveReason: 'manual_archive' }
  });
  assert.equal(result.reason, 'prospect_archived');
  assert.equal(result.archived, true);
  assert.equal(result.doNotContact, true);
});

test('active prospect with no DNC metadata returns blocked:false', () => {
  const result = resolveDoNotContactSummary({
    id: 'p-4',
    state: 'active',
    metadata: {}
  });
  assert.deepEqual(result, { blocked: false });
});

test('case-insensitive state match: STATE=ARCHIVED still blocks', () => {
  const result = resolveDoNotContactSummary({
    id: 'p-5',
    state: '  Archived  ',
    metadata: {}
  });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'prospect_archived');
});

test('metadata.doNotContact only blocks when strictly === true', () => {
  for (const value of ['true', 1, {}, [], 'yes']) {
    const result = resolveDoNotContactSummary({
      id: 'p-x',
      state: 'active',
      metadata: { doNotContact: value }
    });
    assert.equal(result.blocked, false, `doNotContact=${JSON.stringify(value)} should not block`);
  }
});

test('archiveReason is null when not a string', () => {
  const result = resolveDoNotContactSummary({
    id: 'p-6',
    state: 'archived',
    metadata: { archiveReason: 42 }
  });
  assert.equal(result.archiveReason, null);
});

test('action-router re-export points to the same symbol', () => {
  // Ensures backward compatibility for any test or caller that already
  // imports from action-router._private.
  const { _private } = require('../automation/runtime/action-router');
  assert.equal(_private.resolveDoNotContactSummary, resolveDoNotContactSummary,
    'action-router._private should re-export the same function reference');
});
