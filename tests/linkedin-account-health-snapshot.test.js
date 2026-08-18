'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLinkedInAccountHealthSnapshot,
  normalizeSessionHealthState
} = require('../linkedin-account-health-snapshot');

test('normalizeSessionHealthState marks challenge active when challenge is newer than last verification', () => {
  const session = normalizeSessionHealthState({
    email: 'seller@example.com',
    lastVerifiedAt: '2026-03-22T10:00:00.000Z',
    lastChallengeAt: '2026-03-22T11:00:00.000Z'
  });

  assert.equal(session.challengeActive, true);
  assert.equal(session.authFailureActive, false);
});

test('normalizeSessionHealthState clears challenge when a newer verification exists', () => {
  const session = normalizeSessionHealthState({
    email: 'seller@example.com',
    lastVerifiedAt: '2026-03-22T12:00:00.000Z',
    lastChallengeAt: '2026-03-22T11:00:00.000Z',
    lastAuthFailureAt: '2026-03-22T10:30:00.000Z'
  });

  assert.equal(session.challengeActive, false);
  assert.equal(session.authFailureActive, false);
});

test('buildLinkedInAccountHealthSnapshot merges runtime health by account id and session state by email', () => {
  const snapshot = buildLinkedInAccountHealthSnapshot(
    [
      { id: 'li_1', email: 'seller@example.com' },
      { id: 'li_2', email: 'ops@example.com' }
    ],
    {
      li_1: {
        workflow: { status: 'warning', lastError: 'workflow failed' },
        replyMonitor: { status: 'healthy' },
        challenged: {
          at: '2026-03-22T11:05:00.000Z',
          type: 'checkpoint',
          source: 'reply_poll'
        }
      }
    },
    {
      accounts: {
        'seller@example.com': {
          email: 'seller@example.com',
          lastVerifiedAt: '2026-03-22T10:00:00.000Z',
          lastChallengeAt: '2026-03-22T11:00:00.000Z'
        },
        'ops@example.com': {
          email: 'ops@example.com',
          lastVerifiedAt: '2026-03-22T10:00:00.000Z',
          lastAuthFailureAt: '2026-03-22T11:00:00.000Z'
        }
      }
    }
  );

  assert.equal(snapshot.li_1.workflow.status, 'warning');
  assert.equal(snapshot.li_1.challenged.type, 'checkpoint');
  assert.equal(snapshot.li_1.session.challengeActive, true);
  assert.equal(snapshot.li_2.workflow, null);
  assert.equal(snapshot.li_2.replyMonitor, null);
  assert.equal(snapshot.li_2.challenged, null);
  assert.equal(snapshot.li_2.session.authFailureActive, true);
});
