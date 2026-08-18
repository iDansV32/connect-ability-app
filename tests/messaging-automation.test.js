'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LEGACY_DIRECT_LOGIN_ENV } = require('../automation/runtime/legacy-direct-login-guard');

const {
  executeSendNow,
  searchAndMessage
} = require('../automation/messaging/automation');

async function withLegacyDirectLoginEnv(value, fn) {
  const previousValue = process.env[LEGACY_DIRECT_LOGIN_ENV];
  if (value === undefined || value === null) {
    delete process.env[LEGACY_DIRECT_LOGIN_ENV];
  } else {
    process.env[LEGACY_DIRECT_LOGIN_ENV] = value;
  }

  try {
    return await fn();
  } finally {
    if (previousValue === undefined) {
      delete process.env[LEGACY_DIRECT_LOGIN_ENV];
    } else {
      process.env[LEGACY_DIRECT_LOGIN_ENV] = previousValue;
    }
  }
}

test('executeSendNow rejects the legacy messaging path by default', async () => {
  await assert.rejects(
    executeSendNow({
      linkedinEmail: 'alice@example.com',
      linkedinPassword: 'secret',
      profileUrls: [],
      message: 'Hello'
    }),
    /Legacy direct-login path "messaging\.executesendnow" is disabled/
  );
});

test('executeSendNow still rejects strictStealth even when the emergency override is set', async () => {
  await withLegacyDirectLoginEnv('messaging.executesendnow', async () => {
    await assert.rejects(
      executeSendNow({
        strictStealth: true,
        linkedinEmail: 'alice@example.com',
        linkedinPassword: 'secret',
        profileUrls: [],
        message: 'Hello'
      }),
      /Legacy messaging automation path is not available in strictStealth mode/
    );
  });
});

test('searchAndMessage rejects the legacy messaging path by default', async () => {
  await assert.rejects(
    searchAndMessage({
      linkedinEmail: 'alice@example.com',
      linkedinPassword: 'secret',
      searchName: 'Alice Example',
      message: 'Hello'
    }),
    /Legacy direct-login path "messaging\.searchandmessage" is disabled/
  );
});

test('searchAndMessage still rejects strictStealth even when the emergency override is set', async () => {
  await withLegacyDirectLoginEnv('messaging.searchandmessage', async () => {
    await assert.rejects(
      searchAndMessage({
        strictStealth: true,
        linkedinEmail: 'alice@example.com',
        linkedinPassword: 'secret',
        searchName: 'Alice Example',
        message: 'Hello'
      }),
      /Legacy messaging automation path is not available in strictStealth mode/
    );
  });
});
