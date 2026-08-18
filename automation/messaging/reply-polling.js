const crypto = require('crypto');
const { LinkedInPrivateApiClient } = require('../linkedin-private/client');

const LINKEDIN_MESSAGING_URL = 'https://www.linkedin.com/messaging/';
const CONVERSATION_URN_PATTERN = /urn:li:msg_conversation:[A-Za-z0-9_:-]+/i;
const PROFILE_URN_PATTERN = /urn:li:fsd_profile:[A-Za-z0-9_:-]+/i;
const MESSAGE_URN_PATTERN = /urn:li:[A-Za-z0-9_:-]*message:[A-Za-z0-9_:-]+/i;

async function pollMessagingReplies(options = {}) {
  const {
    page,
    context,
    initialized = false,
    conversationStates = {}
  } = options;

  if (!page || !context) {
    throw new Error('pollMessagingReplies requires both page and context');
  }

  await page.goto(LINKEDIN_MESSAGING_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForTimeout(3500).catch(() => {});

  const client = new LinkedInPrivateApiClient({ page, context });
  const messagingContext = await client.extractMessagingContextFromPage();
  const mailboxUrn = messagingContext.mailboxUrn;
  if (!mailboxUrn) {
    throw new Error('Could not resolve LinkedIn mailbox URN from messaging page');
  }

  const bootstrap = await client.bootstrapInbox(mailboxUrn);
  const conversations = extractInboxConversations(bootstrap);
  const normalizedConversationStates = normalizeConversationStates(conversationStates);

  const results = [];
  for (const conversation of conversations) {
    const conversationState = normalizedConversationStates[conversation.conversationUrn] || createDefaultConversationState();
    const latestActivity = Number(conversation.lastActivityAt || 0);
    const knownActivity = Number(conversationState.lastActivityAt || 0);

    let inboundMessages = [];
    if (initialized && latestActivity > knownActivity) {
      const messagePayload = await client.getConversationMessages(conversation.conversationUrn).catch(() => null);
      const messages = extractConversationMessages(messagePayload, conversation.conversationUrn);
      inboundMessages = messages
        .filter((message) => isInboundMessage(message, mailboxUrn))
        .filter((message) => isNewMessage(message, conversationState))
        .sort((left, right) => left.deliveredAt - right.deliveredAt);
    }

    results.push({
      ...conversation,
      inboundMessages
    });
  }

  return {
    mailboxUrn,
    conversations: results
  };
}

async function fetchConversationThread(options = {}) {
  const {
    page,
    context,
    conversationUrn,
    mailboxUrn: mailboxUrnInput = null,
    client: injectedClient = null,
    clientFactory = null
  } = options;

  if (!page || !context) {
    throw new Error('fetchConversationThread requires both page and context');
  }

  const normalizedConversationUrn = sanitizeText(conversationUrn);
  if (!normalizedConversationUrn) {
    throw new Error('fetchConversationThread requires a conversationUrn');
  }

  await page.goto(LINKEDIN_MESSAGING_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForTimeout(1200).catch(() => {});

  const client = resolveMessagingClient({ page, context, client: injectedClient, clientFactory });
  const messagingContext = await client.extractMessagingContextFromPage().catch(() => ({}));
  const mailboxUrn = sanitizeText(mailboxUrnInput || messagingContext.mailboxUrn || '');
  const payload = await client.getConversationMessages(normalizedConversationUrn);
  const messages = extractConversationMessages(payload, normalizedConversationUrn)
    .map((message) => normalizeConversationMessage(message, mailboxUrn))
    .sort((left, right) => left.deliveredAt - right.deliveredAt);
  const participantProfileUrn = inferParticipantProfileUrn(messages, mailboxUrn);

  return {
    conversationUrn: normalizedConversationUrn,
    mailboxUrn: mailboxUrn || null,
    participantProfileUrn,
    messages
  };
}

async function sendConversationReply(options = {}) {
  const {
    page,
    context,
    conversationUrn,
    mailboxUrn: mailboxUrnInput = null,
    recipientProfileUrn = null,
    text,
    client: injectedClient = null,
    clientFactory = null
  } = options;

  if (!page || !context) {
    throw new Error('sendConversationReply requires both page and context');
  }

  const normalizedConversationUrn = sanitizeText(conversationUrn);
  if (!normalizedConversationUrn) {
    throw new Error('sendConversationReply requires a conversationUrn');
  }

  const normalizedText = sanitizeText(text);
  if (!normalizedText) {
    throw new Error('Reply text is required');
  }

  await page.goto(LINKEDIN_MESSAGING_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });
  await page.waitForTimeout(1200).catch(() => {});

  const client = resolveMessagingClient({ page, context, client: injectedClient, clientFactory });
  const messagingContext = await client.extractMessagingContextFromPage().catch(() => ({}));
  const mailboxUrn = sanitizeText(mailboxUrnInput || messagingContext.mailboxUrn || '');
  if (!mailboxUrn) {
    throw new Error('Could not resolve mailboxUrn for manual reply');
  }

  const normalizedRecipientProfileUrn = sanitizeText(recipientProfileUrn || '');
  await client.getConversationMessages(normalizedConversationUrn).catch(() => null);
  await client.getSeenReceipts(normalizedConversationUrn).catch(() => null);
  if (normalizedRecipientProfileUrn) {
    await client.getComposeViewContext({
      recipientProfileUrn: normalizedRecipientProfileUrn,
      contextEntityUrn: normalizedConversationUrn
    }).catch(() => null);
  }
  await client.naturalPause(1800, 3200);
  await client.sendTypingIndicator(normalizedConversationUrn).catch(() => null);
  await client.naturalPause(
    Math.max(1600, normalizedText.length * 55),
    Math.max(3200, normalizedText.length * 95)
  );

  const originToken = crypto.randomUUID();
  const response = await client.sendMessage({
    mailboxUrn,
    conversationUrn: normalizedConversationUrn,
    text: normalizedText,
    originToken
  });

  return {
    mailboxUrn,
    participantProfileUrn: normalizedRecipientProfileUrn || null,
    message: normalizeConversationMessage({
      conversationUrn: normalizedConversationUrn,
      messageKey: originToken,
      deliveredAt: Date.now(),
      senderProfileUrn: mailboxUrn,
      senderName: 'You',
      text: normalizedText
    }, mailboxUrn),
    response: response?.json || null
  };
}

function normalizeConversationStates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce((accumulator, [conversationUrn, state]) => {
    accumulator[conversationUrn] = {
      lastActivityAt: Number(state?.lastActivityAt || 0),
      lastInboundDeliveredAt: Number(state?.lastInboundDeliveredAt || 0),
      lastMessageKey: state?.lastMessageKey || null,
      participantNames: Array.isArray(state?.participantNames) ? state.participantNames : []
    };
    return accumulator;
  }, {});
}

function createDefaultConversationState() {
  return {
    lastActivityAt: 0,
    lastInboundDeliveredAt: 0,
    lastMessageKey: null,
    participantNames: []
  };
}

function extractInboxConversations(payload) {
  const matches = [];
  visit(payload?.conversations?.json || payload?.conversations || payload, (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const conversationUrn = findFirstMatchingString(value, CONVERSATION_URN_PATTERN);
    if (!conversationUrn) return;
    matches.push({
      conversationUrn,
      participantNames: extractParticipantNames(value),
      lastActivityAt: extractTimestamp(value),
      unreadCount: extractUnreadCount(value),
      messageKey: findFirstMatchingString(value, MESSAGE_URN_PATTERN)
    });
  });

  return uniqueBy(matches, (conversation) => conversation.conversationUrn)
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
}

function extractConversationMessages(payload, conversationUrn) {
  const matches = [];
  visit(payload?.json || payload, (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const foundConversationUrn = findFirstMatchingString(value, CONVERSATION_URN_PATTERN);
    const deliveredAt = extractTimestamp(value);
    if (!foundConversationUrn || foundConversationUrn !== conversationUrn || !deliveredAt) return;

    const messageKey = findFirstMatchingString(value, MESSAGE_URN_PATTERN) || `${conversationUrn}_${deliveredAt}`;
    matches.push({
      conversationUrn,
      messageKey,
      deliveredAt,
      senderProfileUrn: findFirstMatchingString(pickLikelySenderNode(value), PROFILE_URN_PATTERN) || findFirstMatchingString(value, PROFILE_URN_PATTERN),
      senderName: extractBestName(pickLikelySenderNode(value)) || extractBestName(value),
      text: extractMessageText(value)
    });
  });

  return uniqueBy(matches, (message) => message.messageKey);
}

function isInboundMessage(message, mailboxUrn) {
  if (!message) return false;
  if (message.senderProfileUrn && mailboxUrn) {
    return message.senderProfileUrn !== mailboxUrn;
  }
  return Boolean(message.text);
}

function normalizeConversationMessage(message, mailboxUrn = '') {
  const normalizedMailboxUrn = sanitizeText(mailboxUrn);
  const deliveredAt = Number(message?.deliveredAt || 0);
  return {
    conversationUrn: sanitizeText(message?.conversationUrn) || null,
    messageKey: sanitizeText(message?.messageKey) || `${sanitizeText(message?.conversationUrn) || 'conversation'}_${deliveredAt || Date.now()}`,
    deliveredAt: Number.isFinite(deliveredAt) && deliveredAt > 0 ? deliveredAt : Date.now(),
    senderProfileUrn: sanitizeText(message?.senderProfileUrn) || null,
    senderName: sanitizeText(message?.senderName) || null,
    text: sanitizeText(message?.text),
    direction: isInboundMessage(message, normalizedMailboxUrn) ? 'inbound' : 'outbound'
  };
}

function inferParticipantProfileUrn(messages = [], mailboxUrn = '') {
  const normalizedMailboxUrn = sanitizeText(mailboxUrn);
  for (const message of Array.isArray(messages) ? messages : []) {
    const senderProfileUrn = sanitizeText(message?.senderProfileUrn);
    if (!senderProfileUrn) continue;
    if (normalizedMailboxUrn && senderProfileUrn === normalizedMailboxUrn) continue;
    return senderProfileUrn;
  }
  return null;
}

function isNewMessage(message, conversationState) {
  if (!message) return false;
  const previousTimestamp = Number(conversationState.lastInboundDeliveredAt || 0);
  if (message.deliveredAt > previousTimestamp) return true;
  return message.deliveredAt === previousTimestamp && message.messageKey !== conversationState.lastMessageKey;
}

function extractUnreadCount(value) {
  const counts = [];
  visit(value, (node, key) => {
    if (typeof node !== 'number') return;
    if (!/unread|badge/i.test(String(key || ''))) return;
    counts.push(node);
  });
  return counts.length ? Math.max(...counts) : 0;
}

function extractTimestamp(value) {
  const numbers = [];
  visit(value, (node, key) => {
    if (typeof node !== 'number') return;
    if (!/updated|delivered|created|activity/i.test(String(key || ''))) return;
    if (node > 1000000000000) numbers.push(node);
  });
  return numbers.length ? Math.max(...numbers) : 0;
}

function extractParticipantNames(value) {
  const names = [];
  visit(value, (node, key, parent) => {
    if (typeof node !== 'string') return;
    if (!/name|title|fullName/i.test(String(key || ''))) return;
    const cleaned = sanitizeText(node);
    if (!cleaned || isUrn(cleaned) || cleaned.length > 120) return;
    if (parent && typeof parent.firstName === 'string' && typeof parent.lastName === 'string') {
      names.push(`${sanitizeText(parent.firstName)} ${sanitizeText(parent.lastName)}`.trim());
      return;
    }
    names.push(cleaned);
  });
  return uniqueStrings(names).slice(0, 4);
}

function extractBestName(value) {
  const names = extractParticipantNames(value);
  return names[0] || null;
}

function extractMessageText(value) {
  let found = null;
  visit(value, (node, key) => {
    if (found || typeof node !== 'string') return;
    if (!/text|body|snippet|preview/i.test(String(key || ''))) return;
    const cleaned = sanitizeText(node);
    if (!cleaned || isUrn(cleaned) || cleaned.length > 400) return;
    found = cleaned;
  });
  return found || '';
}

function pickLikelySenderNode(value) {
  if (!value || typeof value !== 'object') return value;
  for (const [key, nested] of Object.entries(value)) {
    if (/from|sender|actor|participant/i.test(key)) {
      return nested;
    }
  }
  return value;
}

function findFirstMatchingString(value, pattern) {
  let found = null;
  visit(value, (node) => {
    if (found || typeof node !== 'string') return;
    const match = node.match(pattern);
    if (match) {
      found = match[0];
    }
  });
  return found;
}

function visit(value, fn, seen = new WeakSet(), key = null, parent = null) {
  if (!value || typeof value !== 'object') {
    fn(value, key, parent);
    return;
  }

  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, fn, seen, index, value));
    return;
  }

  Object.entries(value).forEach(([entryKey, entryValue]) => {
    fn(entryValue, entryKey, value);
    visit(entryValue, fn, seen, entryKey, value);
  });
}

function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isUrn(value) {
  return /^urn:li:/i.test(String(value || ''));
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = sanitizeText(value).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueBy(values, getKey) {
  const seen = new Set();
  return values.filter((value) => {
    const key = getKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveMessagingClient({ page, context, client = null, clientFactory = null } = {}) {
  if (client) {
    return client;
  }
  if (typeof clientFactory === 'function') {
    return clientFactory({ page, context });
  }
  return new LinkedInPrivateApiClient({ page, context });
}

module.exports = {
  extractConversationMessages,
  fetchConversationThread,
  normalizeConversationMessage,
  pollMessagingReplies,
  sendConversationReply
};
