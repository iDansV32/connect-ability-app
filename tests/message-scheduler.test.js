const test = require('node:test');
const assert = require('node:assert/strict');

const { MessageScheduler } = require('../message-scheduler');
const { createTempWorkspace, writeJson } = require('./test-helpers');

test('MessageScheduler scopes scheduled message mutations by account', () => {
  const workspace = createTempWorkspace('message-scheduler-account-scope-');
  try {
    const scheduler = new MessageScheduler({
      storePath: workspace.path('message-schedules.json')
    });

    const ivanId = scheduler.scheduleMessage({
      profileIds: ['https://www.linkedin.com/in/example-ivan-recipient/'],
      message: 'Hello from Ivan',
      scheduledTime: '2026-03-25T15:00:00.000Z',
      accountId: 'account-ivan',
      accountName: 'Ivan Dans',
      options: {
        accountId: 'account-ivan',
        accountName: 'Ivan Dans'
      }
    });

    const robertId = scheduler.scheduleMessage({
      profileIds: ['https://www.linkedin.com/in/example-robert-recipient/'],
      message: 'Hello from Robert',
      scheduledTime: '2026-03-26T15:00:00.000Z',
      accountId: 'account-robert',
      accountName: 'Robert Henderson',
      options: {
        accountId: 'account-robert',
        accountName: 'Robert Henderson'
      }
    });

    assert.deepEqual(
      scheduler.getScheduledMessages({ accountId: 'account-ivan' }).map((schedule) => schedule.id),
      [ivanId]
    );
    assert.deepEqual(
      scheduler.getScheduledMessages({ accountId: 'account-robert' }).map((schedule) => schedule.id),
      [robertId]
    );

    assert.equal(scheduler.cancelSchedule(robertId, { accountId: 'account-ivan' }), false);
    assert.equal(scheduler.cancelSchedule(ivanId, { accountId: 'account-ivan' }), true);
    assert.equal(
      scheduler.getScheduledMessage(ivanId, { accountId: 'account-ivan' })?.status,
      'cancelled'
    );
    assert.equal(
      scheduler.getScheduledMessage(robertId, { accountId: 'account-robert' })?.status,
      'pending'
    );

    assert.equal(scheduler.clearScheduledLogs(false, { accountId: 'account-ivan' }), 1);
    assert.equal(scheduler.getScheduledMessages({ accountId: 'account-ivan' }).length, 0);
    assert.equal(scheduler.getScheduledMessages({ accountId: 'account-robert' }).length, 1);
  } finally {
    workspace.cleanup();
  }
});

test('MessageScheduler normalizes legacy split date/time schedules', async () => {
  const workspace = createTempWorkspace('message-scheduler-legacy-');
  try {
    const storePath = workspace.path('message-schedules.json');
    writeJson(storePath, [
      {
        id: 'legacy-schedule',
        profileIds: ['https://www.linkedin.com/in/example-legacy-recipient/'],
        message: 'Legacy message payload',
        scheduledDate: '2026-03-27',
        scheduledTime: '09:15',
        options: {
          accountId: 'account-robert',
          accountName: 'Robert Henderson'
        }
      }
    ]);

    const scheduler = new MessageScheduler({ storePath });
    await scheduler.init();
    const messages = scheduler.getScheduledMessages();

    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, 'legacy-schedule');
    assert.equal(messages[0].accountId, 'account-robert');
    assert.equal(messages[0].accountName, 'Robert Henderson');
    assert.ok(Number.isFinite(Date.parse(messages[0].scheduledTime)));
    assert.notEqual(messages[0].scheduledTime, '09:15');
  } finally {
    workspace.cleanup();
  }
});
