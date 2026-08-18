const {
  getConnectAbilityAppStateDir,
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('./connect-documents');
const SqliteNotificationRepository  = require('./storage/sqlite-notification-repository');
const SqliteReplyMonitorRepository  = require('./storage/sqlite-reply-monitor-repository');
const { ACCOUNT_WORKER_MESSAGE_TYPES } = require('./automation/runtime/account-worker-protocol');
const { classifyIntent } = require('./agents/reply-intent-service');

const STORE_VERSION = 2;
const MAX_STORED_NOTIFICATIONS = 250;

class LinkedInReplyMonitor {
  constructor(options = {}) {
    this.documentsDir = options.documentsDir || getConnectAbilityAppStateDir();
    this.statePath = options.statePath || resolveInternalStatePath('dm-reply-monitor.json');
    this._notifRepo   = options.db ? new SqliteNotificationRepository(options.db)  : null;
    this._monitorRepo = options.db ? new SqliteReplyMonitorRepository(options.db)  : null;
    this.readAccounts = typeof options.readAccounts === 'function' ? options.readAccounts : (() => []);
    this.readAgents = typeof options.readAgents === 'function' ? options.readAgents : (() => []);
    this.recordEvent = typeof options.recordEvent === 'function' ? options.recordEvent : (() => null);
    this.notify = typeof options.notify === 'function' ? options.notify : (() => {});
    this.matchWorkflowRun = typeof options.matchWorkflowRun === 'function' ? options.matchWorkflowRun : (() => null);
    this.inboxStore = options.inboxStore || null;
    this.pauseWorkflowRun = typeof options.pauseWorkflowRun === 'function' ? options.pauseWorkflowRun : (() => null);
    this.cancelWorkflowRun = typeof options.cancelWorkflowRun === 'function' ? options.cancelWorkflowRun : null;
    this.archiveProspect = typeof options.archiveProspect === 'function' ? options.archiveProspect : null;
    this.classifyIntent = typeof options.classifyIntent === 'function' ? options.classifyIntent : classifyIntent;
    this.onInboxUpdated = typeof options.onInboxUpdated === 'function' ? options.onInboxUpdated : (() => {});
    this.extraShouldPollAccount = typeof options.extraShouldPollAccount === 'function' ? options.extraShouldPollAccount : null;
    this.onPollResult = typeof options.onPollResult === 'function' ? options.onPollResult : null;
    this.accountWorkerProcessManager = options.accountWorkerProcessManager || null;
    this.workerPollTimeoutMs = Math.max(5000, Number(options.workerPollTimeoutMs) || 120000);
    this.intervalMs = Math.max(60000, Number(options.intervalMs) || 180000);
    this.timer = null;
    this.polling = false;
  }

  start() {
    if (this.timer) return;
    this.pollAll().catch((error) => {
      console.error('LinkedIn reply monitor initial poll failed:', error);
    });
    this.timer = setInterval(() => {
      this.pollAll().catch((error) => {
        console.error('LinkedIn reply monitor poll failed:', error);
      });
    }, this.intervalMs);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  getState() {
    return this.readState();
  }

  getNotifications(filters = {}) {
    const limit = Math.max(1, Number(filters.limit) || 30);
    const accountId = sanitizeText(filters.accountId || '');
    const unreadOnly = filters.unreadOnly === true;

    if (this._notifRepo) {
      const items = this._notifRepo.findAll({
        accountId: accountId || undefined,
        unreadOnly,
        limit
      });
      const total = this._notifRepo.count();
      const unreadCount = this._notifRepo.countUnread(accountId || undefined);
      return { items, total, unreadCount };
    }

    const state = this.readState();
    const items = Object.values(state.notifications || {})
      .filter(Boolean)
      .filter((notification) => !accountId || notification.accountId === accountId)
      .filter((notification) => !unreadOnly || !notification.readAt)
      .sort((left, right) => Number(right.deliveredAt || 0) - Number(left.deliveredAt || 0))
      .slice(0, limit);

    return {
      items,
      total: Object.keys(state.notifications || {}).length,
      unreadCount: Object.values(state.notifications || {}).filter((notification) => notification && !notification.readAt).length
    };
  }

  markNotificationRead(notificationId) {
    const normalizedNotificationId = sanitizeText(notificationId);
    if (!normalizedNotificationId) {
      return { success: false, error: 'notificationId is required' };
    }

    if (this._notifRepo) {
      const updated = this._notifRepo.markRead(normalizedNotificationId, new Date().toISOString());
      if (!updated) {
        return { success: false, error: 'Notification not found' };
      }
      return {
        success: true,
        notification: updated,
        unreadCount: this._notifRepo.countUnread()
      };
    }

    const state = this.readState();
    const existing = state.notifications?.[normalizedNotificationId];
    if (!existing) {
      return { success: false, error: 'Notification not found' };
    }

    state.notifications[normalizedNotificationId] = {
      ...existing,
      readAt: existing.readAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    writeJsonFileAtomic(this.statePath, state);

    return {
      success: true,
      notification: state.notifications[normalizedNotificationId],
      unreadCount: Object.values(state.notifications || {}).filter((notification) => notification && !notification.readAt).length
    };
  }

  markAllNotificationsRead(filters = {}) {
    const accountId = sanitizeText(filters.accountId || '');

    if (this._notifRepo) {
      const updated = this._notifRepo.markAllRead(accountId || undefined, new Date().toISOString());
      return {
        success: true,
        updated,
        unreadCount: this._notifRepo.countUnread(accountId || undefined)
      };
    }

    const state = this.readState();
    const now = new Date().toISOString();
    let updated = 0;

    Object.entries(state.notifications || {}).forEach(([notificationId, notification]) => {
      if (!notification || notification.readAt) return;
      if (accountId && notification.accountId !== accountId) return;
      state.notifications[notificationId] = {
        ...notification,
        readAt: now,
        updatedAt: now
      };
      updated += 1;
    });

    if (updated > 0) {
      writeJsonFileAtomic(this.statePath, state);
    }

    return {
      success: true,
      updated,
      unreadCount: Object.values(state.notifications || {}).filter((notification) => notification && !notification.readAt).length
    };
  }

  async pollAll() {
    if (this.polling) {
      return this.readState();
    }

    this.polling = true;
    const state = this.readState();
    try {
      const accountValues = await Promise.resolve(this.readAccounts());
      const agentValues = await Promise.resolve(this.readAgents());
      const accounts = Array.isArray(accountValues) ? accountValues : [];
      const agents = Array.isArray(agentValues) ? agentValues : [];
      const pollableAccounts = accounts.filter((account) => {
        if (!shouldPollAccount(account, agents)) {
          return false;
        }
        if (!this.extraShouldPollAccount) {
          return true;
        }
        try {
          return this.extraShouldPollAccount(account, agents) !== false;
        } catch (error) {
          console.error('LinkedIn reply monitor extraShouldPollAccount failed:', error);
          return false;
        }
      });

      if (accounts.length > 0 && pollableAccounts.length === 0) {
        console.warn('LinkedIn reply monitor found accounts, but none were pollable.');
      }

      for (const account of pollableAccounts) {
        await this.pollAccount(account, state);
      }

      state.lastPolledAt = new Date().toISOString();
      this._saveState(state);
      return state;
    } finally {
      this.polling = false;
    }
  }

  async pollAccount(account, state) {
    const accountState = ensureAccountState(state, account);

    try {
      const pollResult = await this.pollAccountViaWorker(account, accountState);
      const mailboxUrn = pollResult.mailboxUrn;
      const conversations = Array.isArray(pollResult.conversations) ? pollResult.conversations : [];

      accountState.mailboxUrn = mailboxUrn || null;
      const nowIso = new Date().toISOString();

      if (!accountState.initialized) {
        conversations.forEach((conversation) => {
          const conversationState = ensureConversationState(accountState, conversation.conversationUrn);
          conversationState.lastActivityAt = conversation.lastActivityAt || 0;
          conversationState.lastInboundDeliveredAt = conversation.lastActivityAt || 0;
          conversationState.lastMessageKey = conversation.messageKey || null;
          conversationState.participantNames = conversation.participantNames || [];
        });
        accountState.initialized = true;
        accountState.lastSuccessAt = nowIso;
        accountState.lastError = null;
        return;
      }

      for (const conversation of conversations) {
        const conversationState = ensureConversationState(accountState, conversation.conversationUrn);
        const knownActivity = Number(conversationState.lastActivityAt || 0);
        const latestActivity = Number(conversation.lastActivityAt || 0);
        if (latestActivity <= knownActivity) {
          continue;
        }

        const inboundMessages = Array.isArray(conversation.inboundMessages)
          ? conversation.inboundMessages
          : [];

        const inboxConversation = {
          ...conversation,
          mailboxUrn
        };

        for (const message of inboundMessages) {
          const intentLabel = this.resolveIntentLabel(message?.text || '');
          const match = this.matchWorkflowRun({
            accountId: account.id,
            participantNames: conversation.participantNames,
            conversationUrn: conversation.conversationUrn,
            message
          }) || {};

          const notification = upsertReplyNotification(state, {
            accountId: account.id,
            accountName: account.name || account.email,
            senderName: message.senderName || conversation.participantNames[0] || 'LinkedIn reply',
            text: message.text || 'New LinkedIn reply received.',
            deliveredAt: message.deliveredAt,
            workflowId: match.workflowId || null,
            workflowName: match.workflowName || null,
            runId: match.runId || null,
            agentId: match.agentId || null,
            agentName: match.agentName || null,
            conversationUrn: conversation.conversationUrn,
            messageKey: message.messageKey,
            senderProfileUrn: message.senderProfileUrn || null
          });

          this.recordEvent({
            type: 'dm_reply_received',
            accountId: account.id,
            accountName: account.name || account.email,
            agentId: match.agentId || null,
            agentName: match.agentName || null,
            workflowId: match.workflowId || null,
            workflowName: match.workflowName || null,
            runId: match.runId || null,
            targetId: match.targetId || null,
            prospectId: match.prospectId || null,
            targetValue: message.senderName || conversation.participantNames[0] || conversation.conversationUrn,
            status: 'ok',
            metadata: {
              notificationId: notification.id,
              conversationUrn: conversation.conversationUrn,
              senderName: message.senderName || null,
              senderProfileUrn: message.senderProfileUrn || null,
              text: message.text || '',
              deliveredAt: message.deliveredAt,
              participantNames: conversation.participantNames || [],
              intentLabel
            }
          });

          this.upsertInboxConversation(account, inboxConversation, message, match, intentLabel);
          this.applyIntentAutoAction(inboxConversation, match, intentLabel);
          this.notify(notification);
        }

        const latestInbound = inboundMessages[inboundMessages.length - 1] || null;
        conversationState.lastActivityAt = latestActivity;
        conversationState.lastInboundDeliveredAt = latestInbound?.deliveredAt || Math.max(Number(conversationState.lastInboundDeliveredAt || 0), latestActivity);
        conversationState.lastMessageKey = latestInbound?.messageKey || conversation.messageKey || conversationState.lastMessageKey || null;
        conversationState.participantNames = conversation.participantNames || conversationState.participantNames || [];
      }

      accountState.lastSuccessAt = nowIso;
      accountState.lastError = null;
      this.reportPollResult(account, true, null);
    } catch (error) {
      accountState.lastError = error.message || String(error);
      this.reportPollResult(account, false, error);
    }
  }

  async pollAccountViaWorker(account, accountState) {
    if (!this.accountWorkerProcessManager || typeof this.accountWorkerProcessManager.dispatchAndAwaitMessage !== 'function') {
      throw new Error('LinkedIn reply monitor requires an account worker process manager');
    }

    const requestId = `reply-poll:${account.id || account.email || 'account'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const result = await this.accountWorkerProcessManager.dispatchAndAwaitMessage(
      {
        accountId: account.id || null,
        accountName: account.name || account.email,
        id: account.id || null,
        name: account.name || account.email,
        email: account.email,
        password: account.password,
        fingerprintProfileSeed: account.fingerprintProfileSeed || null,
        delayProfileSeed: account.delayProfileSeed || null,
        strictStealth: account.strictStealth === true
      },
      {
        type: ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES,
        requestId,
        initialized: accountState.initialized === true,
        conversationStates: accountState.conversations || {}
      },
      {
        type: ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES_RESULT,
        timeoutMs: this.workerPollTimeoutMs,
        timeoutLabel: `reply poll result for request ${requestId}`,
        closedLabel: `reply poll result for request ${requestId}`,
        matchMessage: (payload) => (
          payload?.type === ACCOUNT_WORKER_MESSAGE_TYPES.POLL_REPLIES_RESULT
          && payload.requestId === requestId
        )
      }
    );

    if (result?.error) {
      throw new Error(result.error);
    }

    return result?.pollResult || { mailboxUrn: null, conversations: [] };
  }

  reportPollResult(account, success, error) {
    if (!this.onPollResult) return;
    try {
      this.onPollResult({
        account,
        success,
        error: error || null
      });
    } catch (callbackError) {
      console.error('LinkedIn reply monitor onPollResult failed:', callbackError);
    }
  }

  upsertInboxConversation(account, conversation, message, match = {}, intentLabel = null) {
    if (!this.inboxStore || typeof this.inboxStore.upsert !== 'function') {
      return null;
    }

    try {
      const nextConversation = this.inboxStore.upsert(conversation.conversationUrn, {
        accountId: account.id || null,
        accountName: account.name || account.email || null,
        participantNames: conversation.participantNames || [],
        workflowId: match.workflowId || null,
        workflowName: match.workflowName || null,
        runId: match.runId || null,
        prospectId: match.prospectId || null,
        agentId: match.agentId || null,
        agentName: match.agentName || null,
        mailboxUrn: conversation.mailboxUrn || null,
        participantProfileUrn: message?.senderProfileUrn || conversation.participantProfileUrn || null,
        lastInboundAt: Number(message?.deliveredAt || conversation.lastActivityAt || 0),
        status: 'replied',
        intentLabel,
        lastMessagePreview: sanitizeText(message?.text || ''),
        messages: [{
          conversationUrn: conversation.conversationUrn,
          messageKey: message?.messageKey,
          deliveredAt: Number(message?.deliveredAt || Date.now()),
          senderName: message?.senderName || conversation.participantNames?.[0] || null,
          senderProfileUrn: message?.senderProfileUrn || null,
          text: message?.text || '',
          direction: 'inbound'
        }]
      });
      this.notifyInboxUpdated(nextConversation);
      return nextConversation;
    } catch (error) {
      console.error('LinkedIn reply monitor failed to upsert inbox conversation:', error);
      return null;
    }
  }

  applyIntentAutoAction(conversation, match = {}, intentLabel = null) {
    if (intentLabel === 'unsubscribe') {
      return this.handleUnsubscribeIntent(conversation, match);
    }
    return this.pauseMatchedWorkflowRun(conversation, match);
  }

  pauseMatchedWorkflowRun(conversation, match = {}) {
    if (!match?.runId || typeof this.pauseWorkflowRun !== 'function') {
      return null;
    }

    try {
      const result = this.pauseWorkflowRun(match.runId, { reason: 'reply_received' });
      if (result && this.inboxStore && typeof this.inboxStore.setStatus === 'function') {
        const updatedConversation = this.inboxStore.setStatus(conversation.conversationUrn, 'paused');
        this.notifyInboxUpdated(updatedConversation);
      }
      return result;
    } catch (error) {
      console.error('LinkedIn reply monitor failed to pause matched workflow run:', error);
      return null;
    }
  }

  handleUnsubscribeIntent(conversation, match = {}) {
    let workflowResult = null;
    let prospectResult = null;

    if (match?.runId) {
      try {
        if (typeof this.cancelWorkflowRun === 'function') {
          workflowResult = this.cancelWorkflowRun(match.runId, 'unsubscribe_received');
        } else if (typeof this.pauseWorkflowRun === 'function') {
          workflowResult = this.pauseWorkflowRun(match.runId, { reason: 'unsubscribe_received' });
        }
      } catch (error) {
        console.error('LinkedIn reply monitor failed to stop unsubscribed workflow run:', error);
      }
    }

    if (match?.prospectId && typeof this.archiveProspect === 'function') {
      try {
        prospectResult = this.archiveProspect(match.prospectId, {
          reason: 'unsubscribe_received',
          workflowAssignment: {
            workflowId: match.workflowId || null,
            workflowName: match.workflowName || null,
            runId: match.runId || null,
            targetId: match.targetId || null
          }
        });
      } catch (error) {
        console.error('LinkedIn reply monitor failed to archive unsubscribed prospect:', error);
      }
    }

    if (this.inboxStore && typeof this.inboxStore.setStatus === 'function') {
      const updatedConversation = this.inboxStore.setStatus(conversation.conversationUrn, 'suppressed');
      this.notifyInboxUpdated(updatedConversation);
    }

    return {
      workflow: workflowResult,
      prospect: prospectResult
    };
  }

  resolveIntentLabel(messageText) {
    try {
      return this.classifyIntent(messageText);
    } catch (error) {
      console.error('LinkedIn reply monitor intent classification failed:', error);
      return 'neutral';
    }
  }

  notifyInboxUpdated(conversation) {
    if (!conversation) return;
    try {
      this.onInboxUpdated(conversation);
    } catch (error) {
      console.error('LinkedIn reply monitor onInboxUpdated callback failed:', error);
    }
  }

  readState() {
    if (this._monitorRepo) {
      const base = this._monitorRepo.readFullState();
      // Build a compatible notifications map from SQLite
      const notifItems = this._notifRepo ? this._notifRepo.findAll({ limit: MAX_STORED_NOTIFICATIONS }) : [];
      const notifications = {};
      for (const n of notifItems) {
        notifications[n.id] = n;
      }
      return { ...base, notifications };
    }
    const fallback = {
      version: STORE_VERSION,
      lastPolledAt: null,
      accounts: {},
      notifications: {}
    };
    const store = readJsonFile(this.statePath, fallback);
    return {
      version: Number(store.version) || STORE_VERSION,
      lastPolledAt: store.lastPolledAt || null,
      accounts: store.accounts && typeof store.accounts === 'object' ? { ...store.accounts } : {},
      notifications: normalizeNotificationMap(store.notifications)
    };
  }

  /**
   * Persist the in-memory state object.
   * When SQLite is available, flushes accounts/cursors/notifications separately.
   * Falls back to a single atomic JSON write.
   *
   * @param {object} state — same shape as readState() returns
   */
  _saveState(state) {
    if (this._monitorRepo) {
      this._monitorRepo.saveFullState(state);
      if (this._notifRepo) {
        // Upsert all in-memory notifications to SQLite
        const notifs = Object.values(state.notifications || {}).filter(Boolean);
        for (const n of notifs) {
          this._notifRepo.upsert(n);
        }
        this._notifRepo.pruneToLimit(MAX_STORED_NOTIFICATIONS);
      }
    } else {
      writeJsonFileAtomic(this.statePath, state);
    }
  }
}

function shouldPollAccount(account, agents) {
  if (!account?.email || !account?.password) return false;
  const linkedAgents = agents.filter((agent) => agent.accountId === account.id && agent.status !== 'archived');
  if (!linkedAgents.length) return true;
  return linkedAgents.some((agent) => agent.notifications?.dmReplies !== false);
}

function ensureAccountState(state, account) {
  const existing = state.accounts[account.id] || {};
  state.accounts[account.id] = {
    initialized: Boolean(existing.initialized),
    mailboxUrn: existing.mailboxUrn || null,
    lastSuccessAt: existing.lastSuccessAt || null,
    lastError: existing.lastError || null,
    conversations: existing.conversations && typeof existing.conversations === 'object' ? { ...existing.conversations } : {}
  };
  return state.accounts[account.id];
}

function ensureConversationState(accountState, conversationUrn) {
  const existing = accountState.conversations[conversationUrn] || {};
  accountState.conversations[conversationUrn] = {
    lastActivityAt: Number(existing.lastActivityAt || 0),
    lastInboundDeliveredAt: Number(existing.lastInboundDeliveredAt || 0),
    lastMessageKey: existing.lastMessageKey || null,
    participantNames: Array.isArray(existing.participantNames) ? existing.participantNames : []
  };
  return accountState.conversations[conversationUrn];
}

function upsertReplyNotification(state, notificationInput = {}) {
  const notificationId = buildReplyNotificationId(notificationInput);
  const existing = state.notifications?.[notificationId] || null;
  const now = new Date().toISOString();
  const nextNotification = normalizeNotificationRecord({
    ...existing,
    ...notificationInput,
    id: notificationId,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  });

  state.notifications = state.notifications && typeof state.notifications === 'object'
    ? state.notifications
    : {};
  state.notifications[notificationId] = nextNotification;
  pruneReplyNotifications(state);
  return nextNotification;
}

function buildReplyNotificationId(notificationInput = {}) {
  const accountId = sanitizeText(notificationInput.accountId || 'account');
  const conversationUrn = sanitizeText(notificationInput.conversationUrn || 'conversation');
  const messageKey = sanitizeText(notificationInput.messageKey || notificationInput.deliveredAt || Date.now());
  return `reply:${accountId}:${conversationUrn}:${messageKey}`;
}

function normalizeNotificationMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce((accumulator, [notificationId, notification]) => {
    const normalized = normalizeNotificationRecord({
      ...notification,
      id: notificationId
    });
    if (!normalized) {
      return accumulator;
    }
    accumulator[notificationId] = normalized;
    return accumulator;
  }, {});
}

function normalizeNotificationRecord(notificationInput = {}) {
  const id = sanitizeText(notificationInput.id || '');
  if (!id) return null;

  const deliveredAt = Number(notificationInput.deliveredAt || 0);
  return {
    id,
    accountId: sanitizeText(notificationInput.accountId || '') || null,
    accountName: sanitizeText(notificationInput.accountName || '') || null,
    senderName: sanitizeText(notificationInput.senderName || '') || 'LinkedIn reply',
    text: sanitizeText(notificationInput.text || '') || 'New LinkedIn reply received.',
    deliveredAt: Number.isFinite(deliveredAt) && deliveredAt > 0 ? deliveredAt : Date.now(),
    workflowId: sanitizeText(notificationInput.workflowId || '') || null,
    workflowName: sanitizeText(notificationInput.workflowName || '') || null,
    runId: sanitizeText(notificationInput.runId || '') || null,
    agentId: sanitizeText(notificationInput.agentId || '') || null,
    agentName: sanitizeText(notificationInput.agentName || '') || null,
    conversationUrn: sanitizeText(notificationInput.conversationUrn || '') || null,
    messageKey: sanitizeText(notificationInput.messageKey || '') || null,
    senderProfileUrn: sanitizeText(notificationInput.senderProfileUrn || '') || null,
    createdAt: sanitizeText(notificationInput.createdAt || '') || new Date().toISOString(),
    updatedAt: sanitizeText(notificationInput.updatedAt || '') || new Date().toISOString(),
    readAt: sanitizeText(notificationInput.readAt || '') || null
  };
}

function pruneReplyNotifications(state) {
  const entries = Object.entries(state.notifications || {});
  if (entries.length <= MAX_STORED_NOTIFICATIONS) {
    return;
  }

  entries
    .sort((left, right) => Number(right[1]?.deliveredAt || 0) - Number(left[1]?.deliveredAt || 0))
    .slice(MAX_STORED_NOTIFICATIONS)
    .forEach(([notificationId]) => {
      delete state.notifications[notificationId];
    });
}

function sanitizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

module.exports = LinkedInReplyMonitor;
