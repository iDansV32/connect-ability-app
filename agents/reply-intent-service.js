'use strict';

const NOT_INTERESTED_PATTERNS = [
  /\bnot interested\b/i,
  /\bno thanks\b/i,
  /\bno thank you\b/i,
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\bstop\b/i,
  /\bdo not contact\b/i
];

const INTERESTED_PATTERNS = [
  /\btell me more\b/i,
  /\binterested\b/i,
  /\blet'?s talk\b/i,
  /\bbook a call\b/i
];

function classifyIntent(messageText) {
  const normalized = String(messageText || '').trim();
  if (!normalized) {
    return 'neutral';
  }

  if (NOT_INTERESTED_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return /\bunsubscribe\b/i.test(normalized) ? 'unsubscribe' : 'not_interested';
  }

  if (INTERESTED_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return 'interested';
  }

  if (normalized.includes('?')) {
    return 'question';
  }

  return 'neutral';
}

module.exports = {
  classifyIntent
};
