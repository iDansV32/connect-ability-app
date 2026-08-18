'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LEGACY_DIRECT_LOGIN_ENV,
  normalizeLegacyDirectLoginEntryPoint,
  parseLegacyDirectLoginAllowList,
  isLegacyDirectLoginAllowed,
  assertLegacyDirectLoginAllowed
} = require('../automation/runtime/legacy-direct-login-guard');

test('normalizeLegacyDirectLoginEntryPoint trims and lowercases entry points', () => {
  assert.equal(
    normalizeLegacyDirectLoginEntryPoint(' Main.Start-Automation '),
    'main.start-automation'
  );
});

test('parseLegacyDirectLoginAllowList supports allow-all and specific entry points', () => {
  assert.deepEqual(parseLegacyDirectLoginAllowList('1'), {
    allowAll: true,
    entries: new Set()
  });

  const parsed = parseLegacyDirectLoginAllowList(' main.start-automation, messaging.executeSendNow ');
  assert.equal(parsed.allowAll, false);
  assert.deepEqual(
    Array.from(parsed.entries).sort(),
    ['main.start-automation', 'messaging.executesendnow']
  );
});

test('isLegacyDirectLoginAllowed respects specific entry point overrides', () => {
  const env = {
    [LEGACY_DIRECT_LOGIN_ENV]: 'main.start-automation,messaging.executeSendNow'
  };

  assert.equal(isLegacyDirectLoginAllowed('main.start-automation', env), true);
  assert.equal(isLegacyDirectLoginAllowed('messaging.executeSendNow', env), true);
  assert.equal(isLegacyDirectLoginAllowed('main.send-messages-now', env), false);
});

test('assertLegacyDirectLoginAllowed throws a descriptive emergency-only error by default', () => {
  assert.throws(
    () => assertLegacyDirectLoginAllowed('main.start-automation', {
      env: {
        CONNECT_MODE: 'vendor'
      }
    }),
    /Legacy direct-login path "main\.start-automation" is disabled in vendor mode/
  );
});
