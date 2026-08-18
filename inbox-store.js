'use strict';

const {
  getConnectAbilityAppStateDir,
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('./connect-documents');
const SqliteInboxRepository = require('./storage/sqlite-inbox-repository');

const STORE_VERSION = 2;
const INBOX_STATUSES = new Set(['active', 'replied', 'paused', 'suppressed', 'resolved']);
const INTENT_LABELS = new Set(['interested', 'not_interested', 'question', 'unsubscribe', 'neutral']);
const MESSAGE_DIRECTIONS = new Set(['inbound', 'outbound']);
const MAX_CONVERSATION_MESSAGES = 50;

class InboxStore {
  constructor(options = {}) {
    this.documentsDir = options.documentsDir || getConnectAbilityAppStateDir();
    this.storePath = options.storePath || resolveInternalStatePath('inbox.json');
    this._repo = options.db ? new SqliteInboxRepository(options.db) : null;
  }

  getAll(filters = {}) {
    const normalizedFilters = normalizeFilters(filters);
    if (this._repo) {
      return this._repo.findAll(normalizedFilters);
    }
    return Object.values(this.readStore().conversations)
      .filter((entry) => matchesFilters(entry, normalizedFilters))
      .sort((left, right) => Number(right.lastInboundAt || 0) - Number(left.lastInboundAt || 0));
  }

  getConversation(conversationUrn) {
    const normalizedConversationUrn = cleanString(conversationUrn, 240);
    if (!normalizedConversationUrn) return null;
    if (this._repo) {
      return this._repo.findByUrn(normalizedConversationUrn);
    }
    return this.readStore().conversations[normalizedConversationUrn] || null;
  }

  upsert(conversationUrn, updates = {}) {
    const normalizedConversationUrn = cleanString(conversationUrn || updates.conversationUrn, 240);
    if (!normalizedConversationUrn) {
      throw new Error('conversationUrn is required');
    }

    const existing = this._repo
      ? this._repo.findByUrn(normalizedConversationUrn)
      : (this.readStore().conversations[normalizedConversationUrn] || null);

    const shouldRecomputeMessageSummary = Array.isArray(updates.messages);
    const next = normalizeConversationRecord({
      ...existing,
      ...updates,
      conversationUrn: normalizedConversationUrn,
      participantNames: mergeParticipantNames(existing?.participantNames, updates.participantNames),
      messages: mergeConversationMessages(existing?.messages, updates.messages),
      lastInboundAt: shouldRecomputeMessageSummary && !Object.prototype.hasOwnProperty.call(updates, 'lastInboundAt')
        ? null
        : (updates.lastInboundAt ?? existing?.lastInboundAt),
      lastOutboundAt: shouldRecomputeMessageSummary && !Object.prototype.hasOwnProperty.call(updates, 'lastOutboundAt')
        ? null
        : (updates.lastOutboundAt ?? existing?.lastOutboundAt),
      lastMessagePreview: shouldRecomputeMessageSummary && !Object.prototype.hasOwnProperty.call(updates, 'lastMessagePreview')
        ? null
        : (updates.lastMessagePreview ?? existing?.lastMessagePreview),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    if (this._repo) {
      this._repo.upsert(next);
    } else {
      const store = this.readStore();
      store.conversations[normalizedConversationUrn] = next;
      writeJsonFileAtomic(this.storePath, store);
    }
    return next;
  }

  archive(conversationUrn) {
    return this.setStatus(conversationUrn, 'resolved');
  }

  appendMessages(conversationUrn, messages = [], updates = {}) {
    const normalizedConversationUrn = cleanString(conversationUrn, 240);
    if (!normalizedConversationUrn) {
      return null;
    }

    const existing = this._repo
      ? this._repo.findByUrn(normalizedConversationUrn)
      : (this.readStore().conversations[normalizedConversationUrn] || null);
    if (!existing) return null;

    const shouldRecomputeMessageSummary = Array.isArray(messages) && messages.length > 0;

    const next = normalizeConversationRecord({
      ...existing,
      ...updates,
      conversationUrn: normalizedConversationUrn,
      messages: mergeConversationMessages(existing.messages, messages),
      lastInboundAt: shouldRecomputeMessageSummary && !Object.prototype.hasOwnProperty.call(updates, 'lastInboundAt')
        ? null
        : (updates.lastInboundAt ?? existing.lastInboundAt),
      lastOutboundAt: shouldRecomputeMessageSummary && !Object.prototype.hasOwnProperty.call(updates, 'lastOutboundAt')
        ? null
        : (updates.lastOutboundAt ?? existing.lastOutboundAt),
      lastMessagePreview: shouldRecomputeMessageSummary && !Object.prototype.hasOwnProperty.call(updates, 'lastMessagePreview')
        ? null
        : (updates.lastMessagePreview ?? existing.lastMessagePreview),
      updatedAt: new Date().toISOString()
    });

    if (this._repo) {
      this._repo.upsert(next);
    } else {
      const store = this.readStore();
      store.conversations[normalizedConversationUrn] = next;
      writeJsonFileAtomic(this.storePath, store);
    }
    return next;
  }

  setStatus(conversationUrn, status) {
    const normalizedConversationUrn = cleanString(conversationUrn, 240);
    const normalizedStatus = normalizeStatus(status, null);
    if (!normalizedConversationUrn || !normalizedStatus) {
      return null;
    }

    const existing = this._repo
      ? this._repo.findByUrn(normalizedConversationUrn)
      : (this.readStore().conversations[normalizedConversationUrn] || null);
    if (!existing) return null;

    const next = normalizeConversationRecord({
      ...existing,
      status: normalizedStatus,
      updatedAt: new Date().toISOString()
    });

    if (this._repo) {
      this._repo.upsert(next);
    } else {
      const store = this.readStore();
      store.conversations[normalizedConversationUrn] = next;
      writeJsonFileAtomic(this.storePath, store);
    }
    return next;
  }

  readStore() {
    const fallback = {
      version: STORE_VERSION,
      conversations: {}
    };
    const store = readJsonFile(this.storePath, fallback);
    return {
      version: Number(store.version) || STORE_VERSION,
      conversations: normalizeConversationMap(store.conversations)
    };
  }
}

function normalizeConversationMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce((accumulator, [conversationUrn, entry]) => {
    const normalized = normalizeConversationRecord({
      ...entry,
      conversationUrn
    });
    if (!normalized) {
      return accumulator;
    }
    accumulator[normalized.conversationUrn] = normalized;
    return accumulator;
  }, {});
}

function normalizeConversationRecord(value = {}) {
  const conversationUrn = cleanString(value.conversationUrn, 240);
  if (!conversationUrn) {
    return null;
  }

  const messages = normalizeConversationMessages(value.messages);
  const latestInboundAt = getLatestMessageTimestamp(messages, 'inbound');
  const latestOutboundAt = getLatestMessageTimestamp(messages, 'outbound');

  return {
    conversationUrn,
    accountId: cleanString(value.accountId, 120) || null,
    accountName: cleanString(value.accountName, 160) || null,
    mailboxUrn: cleanString(value.mailboxUrn, 240) || null,
    participantProfileUrn: cleanString(value.participantProfileUrn, 240) || null,
    participantNames: normalizeParticipantNames(value.participantNames),
    workflowId: cleanString(value.workflowId, 160) || null,
    workflowName: cleanString(value.workflowName, 160) || null,
    runId: cleanString(value.runId, 160) || null,
    prospectId: cleanString(value.prospectId, 160) || null,
    agentId: cleanString(value.agentId, 120) || null,
    agentName: cleanString(value.agentName, 160) || null,
    lastInboundAt: normalizeTimestampNumber(value.lastInboundAt) || latestInboundAt,
    lastOutboundAt: normalizeTimestampNumber(value.lastOutboundAt) || latestOutboundAt,
    status: normalizeStatus(value.status, 'active'),
    intentLabel: normalizeIntentLabel(value.intentLabel),
    lastMessagePreview: cleanString(value.lastMessagePreview, 500) || getLatestMessagePreview(messages),
    messages,
    createdAt: cleanString(value.createdAt, 80) || new Date().toISOString(),
    updatedAt: cleanString(value.updatedAt, 80) || new Date().toISOString()
  };
}

function normalizeFilters(filters = {}) {
  const statuses = Array.isArray(filters.statuses)
    ? filters.statuses.map((status) => normalizeStatus(status, null)).filter(Boolean)
    : [];
  const singleStatus = normalizeStatus(filters.status, null);
  if (singleStatus && !statuses.includes(singleStatus)) {
    statuses.push(singleStatus);
  }

  return {
    accountId: cleanString(filters.accountId, 120) || null,
    workflowId: cleanString(filters.workflowId, 160) || null,
    statuses
  };
}

function matchesFilters(entry, filters) {
  if (filters.accountId && entry.accountId !== filters.accountId) return false;
  if (filters.workflowId && entry.workflowId !== filters.workflowId) return false;
  if (filters.statuses.length && !filters.statuses.includes(entry.status)) return false;
  return true;
}

function normalizeParticipantNames(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((entry) => cleanString(entry, 160))
      .filter(Boolean)
  ));
}

function mergeParticipantNames(existing, incoming) {
  return normalizeParticipantNames([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]);
}

function normalizeConversationMessages(value) {
  if (!Array.isArray(value)) return [];
  return uniqueBy(
    value
      .map((message) => normalizeConversationMessage(message))
      .filter(Boolean)
      .sort((left, right) => left.deliveredAt - right.deliveredAt),
    (message) => message.messageKey
  ).slice(-MAX_CONVERSATION_MESSAGES);
}

function mergeConversationMessages(existing, incoming) {
  return normalizeConversationMessages([
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(incoming) ? incoming : [])
  ]);
}

function normalizeConversationMessage(value = {}) {
  const messageKey = cleanString(value.messageKey, 240);
  if (!messageKey) {
    return null;
  }

  return {
    messageKey,
    deliveredAt: normalizeTimestampNumber(value.deliveredAt),
    senderName: cleanString(value.senderName, 160) || null,
    senderProfileUrn: cleanString(value.senderProfileUrn, 240) || null,
    text: cleanString(value.text, 2000) || '',
    direction: normalizeMessageDirection(value.direction)
  };
}

function getLatestMessagePreview(messages) {
  const normalizedMessages = Array.isArray(messages) ? messages : normalizeConversationMessages(messages);
  const latest = normalizedMessages[normalizedMessages.length - 1] || null;
  return cleanString(latest?.text, 500) || null;
}

function getLatestMessageTimestamp(messages, direction) {
  const normalizedMessages = Array.isArray(messages) ? messages : normalizeConversationMessages(messages);
  return normalizedMessages.reduce((latest, message) => {
    if (message?.direction !== direction) {
      return latest;
    }
    return Math.max(latest, normalizeTimestampNumber(message.deliveredAt));
  }, 0);
}

function normalizeTimestampNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeStatus(value, fallback = 'active') {
  const normalized = cleanString(value, 40).toLowerCase();
  if (INBOX_STATUSES.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeIntentLabel(value) {
  const normalized = cleanString(value, 80).toLowerCase();
  return INTENT_LABELS.has(normalized) ? normalized : null;
}

function normalizeMessageDirection(value) {
  const normalized = cleanString(value, 40).toLowerCase();
  return MESSAGE_DIRECTIONS.has(normalized) ? normalized : 'inbound';
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

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = InboxStore;
