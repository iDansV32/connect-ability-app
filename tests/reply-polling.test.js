'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchConversationThread,
  sendConversationReply
} = require('../automation/messaging/reply-polling');

function createPageStub() {
  const calls = [];
  return {
    calls,
    async goto(url, options) {
      calls.push({ type: 'goto', url, options });
    },
    async waitForTimeout(timeoutMs) {
      calls.push({ type: 'waitForTimeout', timeoutMs });
    }
  };
}

test('fetchConversationThread normalizes inbound and outbound messages from the worker client', async () => {
  const page = createPageStub();
  const client = {
    async extractMessagingContextFromPage() {
      return {
        mailboxUrn: 'urn:li:fsd_profile:self'
      };
    },
    async getConversationMessages(conversationUrn) {
      assert.equal(conversationUrn, 'urn:li:msg_conversation:1');
      return {
        json: {
          elements: [
            {
              message: {
                conversationUrn: 'urn:li:msg_conversation:1',
                deliveredAt: 1760000000000,
                messageUrn: 'urn:li:msg_message:1',
                sender: {
                  entityUrn: 'urn:li:fsd_profile:jane',
                  firstName: 'Jane',
                  lastName: 'Doe'
                },
                bodyText: 'Hello there'
              }
            },
            {
              message: {
                conversationUrn: 'urn:li:msg_conversation:1',
                deliveredAt: 1760000005000,
                messageUrn: 'urn:li:msg_message:2',
                sender: {
                  entityUrn: 'urn:li:fsd_profile:self',
                  firstName: 'You'
                },
                bodyText: 'Thanks for the note'
              }
            }
          ]
        }
      };
    }
  };

  const result = await fetchConversationThread({
    page,
    context: {},
    conversationUrn: 'urn:li:msg_conversation:1',
    client
  });

  assert.equal(result.mailboxUrn, 'urn:li:fsd_profile:self');
  assert.equal(result.participantProfileUrn, 'urn:li:fsd_profile:jane');
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].direction, 'inbound');
  assert.equal(result.messages[0].senderName, 'Jane Doe');
  assert.equal(result.messages[1].direction, 'outbound');
  assert.equal(page.calls[0].url, 'https://www.linkedin.com/messaging/');
});

test('sendConversationReply uses conversation context and returns a normalized outbound message', async () => {
  const page = createPageStub();
  const recorded = [];
  const client = {
    async extractMessagingContextFromPage() {
      recorded.push('extractMessagingContextFromPage');
      return {
        mailboxUrn: 'urn:li:fsd_profile:self'
      };
    },
    async getConversationMessages(conversationUrn) {
      recorded.push(['getConversationMessages', conversationUrn]);
      return { json: {} };
    },
    async getSeenReceipts(conversationUrn) {
      recorded.push(['getSeenReceipts', conversationUrn]);
      return { json: {} };
    },
    async getComposeViewContext(payload) {
      recorded.push(['getComposeViewContext', payload]);
      return { json: {} };
    },
    async naturalPause(minMs, maxMs) {
      recorded.push(['naturalPause', minMs, maxMs]);
    },
    async sendTypingIndicator(conversationUrn) {
      recorded.push(['sendTypingIndicator', conversationUrn]);
      return { json: {} };
    },
    async sendMessage(payload) {
      recorded.push(['sendMessage', payload]);
      return {
        json: {
          sent: true
        }
      };
    }
  };

  const result = await sendConversationReply({
    page,
    context: {},
    conversationUrn: 'urn:li:msg_conversation:1',
    recipientProfileUrn: 'urn:li:fsd_profile:jane',
    text: 'Appreciate the reply.',
    client
  });

  assert.equal(result.mailboxUrn, 'urn:li:fsd_profile:self');
  assert.equal(result.participantProfileUrn, 'urn:li:fsd_profile:jane');
  assert.equal(result.message.direction, 'outbound');
  assert.equal(result.message.senderName, 'You');
  assert.equal(result.message.text, 'Appreciate the reply.');
  assert.equal(recorded[0], 'extractMessagingContextFromPage');
  assert.deepEqual(recorded.find((entry) => Array.isArray(entry) && entry[0] === 'getComposeViewContext')[1], {
    recipientProfileUrn: 'urn:li:fsd_profile:jane',
    contextEntityUrn: 'urn:li:msg_conversation:1'
  });
  const sendMessageCall = recorded.find((entry) => Array.isArray(entry) && entry[0] === 'sendMessage');
  assert.equal(sendMessageCall[1].mailboxUrn, 'urn:li:fsd_profile:self');
  assert.equal(sendMessageCall[1].conversationUrn, 'urn:li:msg_conversation:1');
  assert.equal(sendMessageCall[1].text, 'Appreciate the reply.');
  assert.match(sendMessageCall[1].originToken, /^[0-9a-f-]{36}$/i);
});

test('sendConversationReply skips compose warmup when recipient profile is unavailable', async () => {
  const page = createPageStub();
  let composeCalls = 0;
  const client = {
    async extractMessagingContextFromPage() {
      return {
        mailboxUrn: 'urn:li:fsd_profile:self'
      };
    },
    async getConversationMessages() {
      return { json: {} };
    },
    async getSeenReceipts() {
      return { json: {} };
    },
    async getComposeViewContext() {
      composeCalls += 1;
      return { json: {} };
    },
    async naturalPause() {},
    async sendTypingIndicator() {
      return { json: {} };
    },
    async sendMessage() {
      return { json: {} };
    }
  };

  await sendConversationReply({
    page,
    context: {},
    conversationUrn: 'urn:li:msg_conversation:1',
    text: 'Quick follow-up.',
    client
  });

  assert.equal(composeCalls, 0);
});

test('sendConversationReply rejects when mailbox resolution fails', async () => {
  const page = createPageStub();
  await assert.rejects(
    sendConversationReply({
      page,
      context: {},
      conversationUrn: 'urn:li:msg_conversation:1',
      text: 'Ping',
      client: {
        async extractMessagingContextFromPage() {
          return {};
        }
      }
    }),
    /Could not resolve mailboxUrn/
  );
});
