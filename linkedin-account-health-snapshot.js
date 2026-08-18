'use strict';

function buildLinkedInAccountHealthSnapshot(accounts = [], runtimeHealthById = {}, sessionStore = {}) {
  const sessionAccounts = sessionStore?.accounts && typeof sessionStore.accounts === 'object'
    ? sessionStore.accounts
    : {};

  return (Array.isArray(accounts) ? accounts : []).reduce((accumulator, account) => {
    const accountId = cleanString(account?.id, 120);
    const accountEmail = normalizeEmail(account?.email);
    if (!accountId) {
      return accumulator;
    }

    const runtimeHealth = runtimeHealthById?.[accountId] && typeof runtimeHealthById[accountId] === 'object'
      ? runtimeHealthById[accountId]
      : {};

    accumulator[accountId] = {
      workflow: runtimeHealth.workflow || null,
      replyMonitor: runtimeHealth.replyMonitor || null,
      challenged: normalizeChallengeHealthState(runtimeHealth.challenged || null),
      session: normalizeSessionHealthState(sessionAccounts[accountEmail] || null, accountEmail)
    };
    return accumulator;
  }, {});
}

function normalizeChallengeHealthState(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const at = normalizeTimestamp(record.at || record.detectedAt);
  if (!at) {
    return null;
  }

  return {
    at,
    type: cleanString(record.type, 40).toLowerCase() || 'unknown',
    source: cleanString(record.source, 120) || null
  };
}

function normalizeSessionHealthState(record, fallbackEmail = null) {
  const email = normalizeEmail(record?.email || fallbackEmail) || null;
  const lastVerifiedAt = normalizeTimestamp(record?.lastVerifiedAt);
  const lastVerifiedBy = cleanString(record?.lastVerifiedBy, 40) || null;
  const lastAuthFailureAt = normalizeTimestamp(record?.lastAuthFailureAt);
  const lastChallengeAt = normalizeTimestamp(record?.lastChallengeAt);

  const verifiedTime = parseTime(lastVerifiedAt);
  const authFailureTime = parseTime(lastAuthFailureAt);
  const challengeTime = parseTime(lastChallengeAt);

  return {
    email,
    lastVerifiedAt,
    lastVerifiedBy,
    lastAuthFailureAt,
    lastChallengeAt,
    authFailureActive: Boolean(authFailureTime && (!verifiedTime || authFailureTime > verifiedTime)),
    challengeActive: Boolean(challengeTime && (!verifiedTime || challengeTime > verifiedTime))
  };
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeTimestamp(value) {
  const parsed = parseTime(value);
  return parsed ? new Date(parsed).toISOString() : null;
}

function parseTime(value) {
  const text = cleanString(value, 80);
  if (!text) {
    return null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
  buildLinkedInAccountHealthSnapshot,
  normalizeChallengeHealthState,
  normalizeSessionHealthState
};
