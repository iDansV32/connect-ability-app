'use strict';

/**
 * tests/external-api-safety.test.js
 *
 * Pins the external-API safety policy: blocked functions, headless rejection,
 * forced-visible + launchSource stamping, and discovery filtering. This is the
 * single seam that decides what an external HTTP API caller can trigger, so the
 * coverage is deliberately exhaustive.
 *
 * Pure module — no Electron, no Playwright, no LinkedIn, no credentials.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EXTERNAL_API_LAUNCH_SOURCE,
  ExternalApiSafetyError,
  classifyExternalApiFunction,
  applyExternalApiSafety,
  filterExternalApiFunctions,
  filterExternalApiCatalog,
  filterExternalApiExamples
} = require('../external-api-safety');

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('classification: blocked functions', () => {
  for (const name of ['startAutomation', 'startNameListAutomation', 'sendScheduledNow', 'startWorkflow', 'send']) {
    const p = classifyExternalApiFunction(name);
    assert.equal(p.allowed, false, `${name} must be blocked`);
    assert.ok(p.blockedReason, `${name} must carry a blockedReason`);
  }
});

test('classification: visible-browser functions', () => {
  for (const name of ['publishLinkedInPost', 'runGroupWorkflow', 'sendNewDm', 'findLinkedInProfilesBySearch']) {
    const p = classifyExternalApiFunction(name);
    assert.equal(p.allowed, true);
    assert.equal(p.forcesVisible, true, `${name} must force visible`);
  }
});

test('classification: read-only / store / stub functions are allowed, not forced-visible', () => {
  for (const name of [
    'getLoginStatus', 'getMessageStats', 'checkMessageQuota', 'getAllProfiles',
    'getAllWorkflows', 'getGroupsData', 'getScheduledMessages', 'saveCredentials',
    'createWorkflow', 'updateWorkflow', 'scheduleMessage', 'loginLinkedIn', 'logoutLinkedIn',
    'addProfilesToWorkflow', 'stopAutomation'
  ]) {
    const p = classifyExternalApiFunction(name);
    assert.equal(p.allowed, true, `${name} should be allowed`);
    assert.equal(p.forcesVisible, false, `${name} should not be forced-visible`);
  }
});

// ---------------------------------------------------------------------------
// applyExternalApiSafety — blocking
// ---------------------------------------------------------------------------

test('blocks startAutomation / startNameListAutomation with legacy code', () => {
  for (const name of ['startAutomation', 'startNameListAutomation']) {
    assert.throws(
      () => applyExternalApiSafety(name, [{}]),
      (err) => err instanceof ExternalApiSafetyError && err.code === 'external_api_legacy_browser_blocked'
    );
  }
});

test('blocks sendScheduledNow as legacy automation subprocess', () => {
  assert.throws(
    () => applyExternalApiSafety('sendScheduledNow', ['sched-1']),
    (err) => err.code === 'external_api_legacy_browser_blocked'
  );
});

test('blocks startWorkflow as not-source-aware (v1)', () => {
  assert.throws(
    () => applyExternalApiSafety('startWorkflow', ['wf-1']),
    (err) => err.code === 'external_api_not_source_aware'
  );
});

test('blocks generic send as IPC bypass vector', () => {
  assert.throws(
    () => applyExternalApiSafety('send', ['send-messages-now', {}]),
    (err) => err.code === 'external_api_generic_send_blocked'
  );
});

// ---------------------------------------------------------------------------
// applyExternalApiSafety — visible-browser forcing
// ---------------------------------------------------------------------------

test('runGroupWorkflow: rejects explicit headless:true', () => {
  assert.throws(
    () => applyExternalApiSafety('runGroupWorkflow', [{ groupId: 'g1', headless: true }]),
    (err) => err instanceof ExternalApiSafetyError && err.code === 'external_api_headless_forbidden'
  );
  // Truthy variants are also rejected.
  for (const h of ['true', 1, '1']) {
    assert.throws(
      () => applyExternalApiSafety('runGroupWorkflow', [{ groupId: 'g1', headless: h }]),
      (err) => err.code === 'external_api_headless_forbidden',
      `headless=${JSON.stringify(h)} must be rejected`
    );
  }
});

test('runGroupWorkflow: forces headless:false and stamps launchSource', () => {
  const [payload] = applyExternalApiSafety('runGroupWorkflow', [{ groupId: 'g1', steps: [], headless: false }]);
  assert.equal(payload.headless, false);
  assert.equal(payload.launchSource, EXTERNAL_API_LAUNCH_SOURCE);
  assert.equal(payload.groupId, 'g1');
});

test('runGroupWorkflow: missing headless is forced to false + stamped (the default-undefined case)', () => {
  const [payload] = applyExternalApiSafety('runGroupWorkflow', [{ groupId: 'g1' }]);
  assert.equal(payload.headless, false);
  assert.equal(payload.launchSource, EXTERNAL_API_LAUNCH_SOURCE);
});

test('runGroupWorkflow: positional form is normalized to a stamped object', () => {
  const result = applyExternalApiSafety('runGroupWorkflow', ['group-7', [{ type: 'view_profile' }], 'hi {firstName}']);
  assert.equal(result.length, 1, 'collapsed to a single object arg');
  const [payload] = result;
  assert.equal(payload.groupId, 'group-7');
  assert.deepEqual(payload.actions, [{ type: 'view_profile' }]);
  assert.equal(payload.connectionMessage, 'hi {firstName}');
  assert.equal(payload.headless, false);
  assert.equal(payload.launchSource, EXTERNAL_API_LAUNCH_SOURCE);
});

test('publishLinkedInPost: rejects headless:true, forces false + stamps launchSource', () => {
  assert.throws(
    () => applyExternalApiSafety('publishLinkedInPost', [{ content: 'x', headless: true }]),
    (err) => err.code === 'external_api_headless_forbidden'
  );
  const [payload] = applyExternalApiSafety('publishLinkedInPost', [{ content: 'hello', scheduledDate: '2026-06-01', scheduledTime: '09:00' }]);
  assert.equal(payload.headless, false);
  assert.equal(payload.launchSource, EXTERNAL_API_LAUNCH_SOURCE);
  assert.equal(payload.content, 'hello');
});

test('sendNewDm: stamps launchSource + forces headless:false, rejects headless:true', () => {
  const [payload] = applyExternalApiSafety('sendNewDm', [{
    profileUrl: 'https://www.linkedin.com/in/madison-crane-4c7a91e02/',
    message: 'Hi {firstName}, wanted to reach out.',
    recipientName: 'Madison Crane'
  }]);
  assert.equal(payload.launchSource, EXTERNAL_API_LAUNCH_SOURCE);
  assert.equal(payload.headless, false);
  assert.equal(payload.profileUrl, 'https://www.linkedin.com/in/madison-crane-4c7a91e02/');
  assert.equal(payload.message, 'Hi {firstName}, wanted to reach out.');

  assert.throws(
    () => applyExternalApiSafety('sendNewDm', [{ profileUrl: 'x', message: 'y', headless: true }]),
    (err) => err.code === 'external_api_headless_forbidden'
  );
});

test('findLinkedInProfilesBySearch: stamps launchSource + forces headless:false, rejects headless:true', () => {
  const [payload] = applyExternalApiSafety('findLinkedInProfilesBySearch', [{ searchTerm: 'Head of People', maxResults: 5 }]);
  assert.equal(payload.launchSource, EXTERNAL_API_LAUNCH_SOURCE);
  assert.equal(payload.headless, false);
  assert.equal(payload.searchTerm, 'Head of People');
  assert.equal(payload.maxResults, 5);

  for (const h of [true, 'true', 1, '1']) {
    assert.throws(
      () => applyExternalApiSafety('findLinkedInProfilesBySearch', [{ searchTerm: 'x', headless: h }]),
      (err) => err.code === 'external_api_headless_forbidden',
      `headless=${JSON.stringify(h)} must be rejected`
    );
  }
});

test('non-browser allowed functions pass args through unchanged', () => {
  const args = [{ accountId: 'acc-1' }];
  const out = applyExternalApiSafety('getMessageStats', args);
  assert.deepEqual(out, args);
  // Even if such a payload carried headless:true, a non-browser fn ignores it
  // (it never launches a browser) — passed through untouched.
  const out2 = applyExternalApiSafety('getAllProfiles', [{ headless: true }]);
  assert.deepEqual(out2, [{ headless: true }]);
});

// ---------------------------------------------------------------------------
// Discovery filtering
// ---------------------------------------------------------------------------

test('filterExternalApiFunctions hides every blocked function', () => {
  const all = [
    'getLoginStatus', 'publishLinkedInPost', 'runGroupWorkflow',
    'startAutomation', 'startNameListAutomation', 'sendScheduledNow',
    'startWorkflow', 'send', 'getMessageStats', 'updateWorkflow'
  ];
  const filtered = filterExternalApiFunctions(all);
  for (const blocked of ['startAutomation', 'startNameListAutomation', 'sendScheduledNow', 'startWorkflow', 'send']) {
    assert.equal(filtered.includes(blocked), false, `${blocked} must be hidden`);
  }
  for (const allowed of ['getLoginStatus', 'publishLinkedInPost', 'runGroupWorkflow', 'getMessageStats', 'updateWorkflow']) {
    assert.equal(filtered.includes(allowed), true, `${allowed} must remain`);
  }
});

test('filterExternalApiCatalog drops blocked entries and strips headless knob', () => {
  const catalog = [
    { id: 'shape', function: 'string (required)', args: { function: 'string' } }, // meta doc — keep
    { id: 'startAutomation', function: 'startAutomation', args: { headless: 'boolean' } }, // drop
    { id: 'runGroupWorkflow', function: 'runGroupWorkflow', args: { groupId: 'string', headless: 'boolean' } }, // keep, strip headless
    { id: 'getMessageStats', function: 'getMessageStats', args: {} } // keep
  ];
  const filtered = filterExternalApiCatalog(catalog);
  const fns = filtered.map((e) => e.function);
  assert.equal(fns.includes('startAutomation'), false, 'blocked entry dropped');
  assert.ok(fns.includes('string (required)'), 'meta shape doc kept');
  assert.ok(fns.includes('runGroupWorkflow'), 'visible-browser entry kept');

  const rg = filtered.find((e) => e.function === 'runGroupWorkflow');
  assert.equal('headless' in rg.args, false, 'headless knob stripped from advertised args');
  assert.match(rg.headlessPolicy, /forced-false/i, 'notes the forced-visible policy');
});

test('filterExternalApiCatalog strips headless from the REAL argsShape array form (nested)', () => {
  // Mirrors the real API_OPERATION_CATALOG entry in main.js, which uses
  // `argsShape` (an array), NOT `args`. headless lives one object deep, with a
  // sibling nested `steps` array — the strip must reach it without disturbing
  // the rest of the shape.
  const catalog = [
    {
      id: 'runGroupWorkflow',
      via: 'POST /api/call',
      function: 'runGroupWorkflow',
      argsShape: [
        {
          groupId: 'string',
          targets: [
            {
              profileUrl: 'string',
              source: 'linkedin_people_search',
              searchTerm: 'string',
              searchRank: 'number',
              searchResultIndex: 'number',
              searchPageUrl: 'string'
            }
          ],
          steps: [
            { type: 'view_profile | send_dm', minDelayMs: 'number', maxDelayMs: 'number' }
          ],
          headless: 'boolean'
        }
      ]
    },
    {
      id: 'startAutomation',
      via: 'POST /api/call',
      function: 'startAutomation',
      argsShape: [{ searchQuery: 'string', headless: 'boolean' }] // blocked → dropped
    }
  ];
  const filtered = filterExternalApiCatalog(catalog);
  const fns = filtered.map((e) => e.function);
  assert.equal(fns.includes('startAutomation'), false, 'blocked entry dropped');

  const rg = filtered.find((e) => e.function === 'runGroupWorkflow');
  assert.ok(rg, 'visible-browser entry kept');
  const shape = rg.argsShape[0];
  assert.equal('headless' in shape, false, 'headless stripped from the real argsShape form');
  assert.equal(shape.groupId, 'string', 'sibling fields preserved');
  assert.equal(shape.targets[0].source, 'linkedin_people_search', 'structured target provenance advertised');
  assert.equal(shape.targets[0].searchRank, 'number', 'search rank field preserved');
  assert.deepEqual(
    shape.steps,
    [{ type: 'view_profile | send_dm', minDelayMs: 'number', maxDelayMs: 'number' }],
    'nested steps array preserved intact'
  );
  assert.match(rg.headlessPolicy, /forced-false/i, 'notes the forced-visible policy');
});

test('filterExternalApiExamples drops blocked keys and strips headless from payloads', () => {
  const examples = {
    health: { method: 'GET', url: '/api/health' }, // meta — keep
    startAutomation: { method: 'POST', url: '/api/call', body: { function: 'startAutomation', args: [{ headless: false }] } }, // drop
    runGroupWorkflow: { method: 'POST', url: '/api/call', body: { function: 'runGroupWorkflow', args: [{ groupId: 'g1', headless: false }] } }, // keep, strip headless
    updateWorkflow: { method: 'POST', url: '/api/call', body: { function: 'updateWorkflow', args: ['wf-1', { name: 'Edited' }] } } // keep
  };
  const filtered = filterExternalApiExamples(examples);
  assert.ok('health' in filtered, 'meta example kept');
  assert.equal('startAutomation' in filtered, false, 'blocked example dropped');
  assert.ok('runGroupWorkflow' in filtered, 'allowed example kept');
  assert.equal('headless' in filtered.runGroupWorkflow.body.args[0], false, 'headless stripped from example payload');
  assert.ok('updateWorkflow' in filtered, 'non-browser update example kept');
});
