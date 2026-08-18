'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const MODULE_PATH = require.resolve('../automation/posting/posting-transport');

const transport = require(MODULE_PATH);

test('scheduleScheduledPost delegates to DOM scheduler for text posts', async () => {
  let domCalls = 0;
  const result = await transport.scheduleScheduledPost({}, {
    text: 'Hello post',
    scheduledAt: '1774515600000'
  }, {
    domScheduler: async (postConfig) => {
      domCalls += 1;
      assert.equal(postConfig.content, 'Hello post');
      return {
        outcome: 'scheduled',
        linkedInResourceKey: null,
        linkedInScheduledAt: '1774515600000'
      };
    }
  });

  assert.equal(domCalls, 1);
  assert.equal(result.success, true);
  assert.equal(result.transport, 'dom');
  assert.equal(result.verificationResult?.verified, false);
  assert.equal(result.verificationResult?.method, 'dom');
});

test('scheduleScheduledPost delegates to DOM scheduler for image posts', async () => {
  let domCalls = 0;
  const result = await transport.scheduleScheduledPost({}, {
    content: 'Image post',
    scheduledDate: '2026-03-25',
    scheduledTime: '10:00',
    includeImage: true,
    imagePath: '/tmp/example.png'
  }, {
    domScheduler: async () => {
      domCalls += 1;
      return {
        outcome: 'scheduled',
        linkedInResourceKey: null,
        linkedInScheduledAt: '1774515600000'
      };
    }
  });

  assert.equal(domCalls, 1);
  assert.equal(result.success, true);
  assert.equal(result.transport, 'dom');
});
