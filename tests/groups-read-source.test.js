'use strict';

/**
 * tests/groups-read-source.test.js
 *
 * Pins the Phase C step C2b-2 contract for storage/groups-read-source.js —
 * the pure rollback + readiness decision helper for the get-groups-data flip.
 *
 * Pure module: no env, no DB, no logging. Full matrix per the locked contract.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveGroupsReadSource } = require('../storage/groups-read-source');

const readyRow = { importer_name: 'groups', last_run_errors: 0, total_imported: 7 };

// ---------------------------------------------------------------------------
// Rollback precedence
// ---------------------------------------------------------------------------

test('global "1" → json rollback_global (beats readiness)', () => {
  assert.deepEqual(
    resolveGroupsReadSource({ rollbackFlag: '1', importStateRow: readyRow }),
    { source: 'json', reason: 'rollback_global', unknownTokens: [] }
  );
});

test('targeted "groups" → json rollback_targeted_groups', () => {
  assert.deepEqual(
    resolveGroupsReadSource({ rollbackFlag: 'groups', importStateRow: readyRow }),
    { source: 'json', reason: 'rollback_targeted_groups', unknownTokens: [] }
  );
});

test('"groups" with whitespace/case normalizes', () => {
  for (const flag of ['  groups  ', 'Groups', 'GROUPS', 'profiles, GROUPS ']) {
    const r = resolveGroupsReadSource({ rollbackFlag: flag, importStateRow: readyRow });
    assert.equal(r.source, 'json', `flag="${flag}" should roll back groups`);
    assert.equal(r.reason, 'rollback_targeted_groups');
  }
});

test('"profiles" alone does NOT affect groups → readiness decides (sqlite)', () => {
  assert.deepEqual(
    resolveGroupsReadSource({ rollbackFlag: 'profiles', importStateRow: readyRow }),
    { source: 'sqlite', reason: 'sqlite_ok', unknownTokens: [] }
  );
});

test('"1,groups" → global wins (rollback_global)', () => {
  const r = resolveGroupsReadSource({ rollbackFlag: '1,groups', importStateRow: readyRow });
  assert.equal(r.source, 'json');
  assert.equal(r.reason, 'rollback_global');
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

test('no import_state row → json not_ready_no_import_state', () => {
  for (const row of [null, undefined]) {
    assert.deepEqual(
      resolveGroupsReadSource({ rollbackFlag: '', importStateRow: row }),
      { source: 'json', reason: 'not_ready_no_import_state', unknownTokens: [] }
    );
  }
});

test('last_run_errors > 0 → json not_ready_errors', () => {
  assert.deepEqual(
    resolveGroupsReadSource({ rollbackFlag: '', importStateRow: { last_run_errors: 2 } }),
    { source: 'json', reason: 'not_ready_errors', unknownTokens: [] }
  );
});

test('last_run_errors null/undefined → json not_ready_errors (Number(null)===0 guarded)', () => {
  for (const v of [null, undefined]) {
    const r = resolveGroupsReadSource({ rollbackFlag: '', importStateRow: { last_run_errors: v } });
    assert.equal(r.source, 'json');
    assert.equal(r.reason, 'not_ready_errors');
  }
});

test('last_run_errors malformed string → json not_ready_errors', () => {
  const r = resolveGroupsReadSource({ rollbackFlag: '', importStateRow: { last_run_errors: 'abc' } });
  assert.equal(r.source, 'json');
  assert.equal(r.reason, 'not_ready_errors');
});

test('last_run_errors numeric 0 → sqlite sqlite_ok', () => {
  assert.deepEqual(
    resolveGroupsReadSource({ rollbackFlag: '', importStateRow: { last_run_errors: 0 } }),
    { source: 'sqlite', reason: 'sqlite_ok', unknownTokens: [] }
  );
});

test('last_run_errors "0" string → sqlite (numeric coercion)', () => {
  const r = resolveGroupsReadSource({ rollbackFlag: '', importStateRow: { last_run_errors: '0' } });
  assert.equal(r.source, 'sqlite');
  assert.equal(r.reason, 'sqlite_ok');
});

test('zero-group ready import is ready (no total_imported requirement)', () => {
  const r = resolveGroupsReadSource({
    rollbackFlag: '',
    importStateRow: { last_run_errors: 0, total_imported: 0 }
  });
  assert.equal(r.source, 'sqlite');
  assert.equal(r.reason, 'sqlite_ok');
});

// ---------------------------------------------------------------------------
// Unknown tokens — ignored, but surfaced for loud logging
// ---------------------------------------------------------------------------

test('unknown token does not force JSON; surfaces in unknownTokens', () => {
  const r = resolveGroupsReadSource({ rollbackFlag: 'group', importStateRow: readyRow });
  assert.equal(r.source, 'sqlite', 'typo "group" is NOT recognized → no rollback applied');
  assert.equal(r.reason, 'sqlite_ok');
  assert.deepEqual(r.unknownTokens, ['group']);
});

test('unknown token alongside a real rollback token still rolls back + reports unknown', () => {
  const r = resolveGroupsReadSource({ rollbackFlag: 'gropus,groups', importStateRow: readyRow });
  assert.equal(r.source, 'json');
  assert.equal(r.reason, 'rollback_targeted_groups');
  assert.deepEqual(r.unknownTokens, ['gropus']);
});

test('multiple unknown tokens deduped in order', () => {
  const r = resolveGroupsReadSource({ rollbackFlag: 'foo, bar ,foo', importStateRow: readyRow });
  assert.deepEqual(r.unknownTokens, ['foo', 'bar']);
});

// ---------------------------------------------------------------------------
// Empty / absent flag
// ---------------------------------------------------------------------------

test('empty / undefined flag → readiness alone decides', () => {
  for (const flag of ['', undefined, null, '   ', ',,']) {
    const r = resolveGroupsReadSource({ rollbackFlag: flag, importStateRow: readyRow });
    assert.equal(r.source, 'sqlite', `flag=${JSON.stringify(flag)} → readiness decides`);
    assert.deepEqual(r.unknownTokens, []);
  }
});

test('no input at all → safe json fallback', () => {
  const r = resolveGroupsReadSource();
  assert.equal(r.source, 'json');
  assert.equal(r.reason, 'not_ready_no_import_state');
});
