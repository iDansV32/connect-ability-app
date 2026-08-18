const { logError } = require('../util/log');
const { verifyMessageSent } = require('../messaging/sender');
const { readConnectionState } = require('../connection/state');

function createVerificationResult(input = {}) {
  const result = {
    verified: input.verified === true,
    method: normalizeVerificationMethod(input.method),
    at: input.at || new Date().toISOString()
  };

  const reason = cleanString(input.reason, 200);
  if (reason) {
    result.reason = reason;
  }

  if (input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)) {
    result.metadata = { ...input.metadata };
  }

  return result;
}

async function verifyConnectionSent(page, options = {}) {
  if (options.dryRun) {
    const result = createVerificationResult({
      verified: false,
      method: 'dom',
      reason: 'dry_run_no_write'
    });
    recordTransportHealth(options, result);
    return result;
  }

  try {
    let state = options.state || await readConnectionState(page);
    let verified = Boolean(state?.pending || state?.connected);

    if (!verified && !options.state && options.reloadOnUnconfirmed !== false && typeof page?.reload === 'function') {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      state = await readConnectionState(page);
      verified = Boolean(state?.pending || state?.connected);
    }

    const result = createVerificationResult({
      verified,
      method: 'dom',
      reason: verified ? null : 'connection_state_unconfirmed',
      metadata: {
        pending: Boolean(state?.pending),
        connected: Boolean(state?.connected),
        canConnect: Boolean(state?.canConnect)
      }
    });
    recordTransportHealth(options, result);
    return result;
  } catch (error) {
    logError(`Connection verification failed: ${error.message}`, error);
    const result = createVerificationResult({
      verified: false,
      method: 'dom',
      reason: error.message || 'connection_verification_failed'
    });
    recordTransportHealth(options, result);
    return result;
  }
}

async function verifyDmSent(page, options = {}) {
  const method = normalizeVerificationMethod(options.transport);

  if (options.dryRun) {
    const result = createVerificationResult({
      verified: false,
      method,
      reason: 'dry_run_no_write',
      metadata: {
        conversationUrn: cleanString(options.conversationUrn, 200) || null
      }
    });
    recordTransportHealth(options, result);
    return result;
  }

  try {
    const verifyDomMessageSent = typeof options.verifyDomMessageSent === 'function'
      ? options.verifyDomMessageSent
      : verifyMessageSent;
    const verified = await verifyDomMessageSent(page);
    const result = createVerificationResult({
      verified,
      method: 'dom',
      reason: verified ? null : 'dom_message_not_confirmed'
    });
    recordTransportHealth(options, result);
    return result;
  } catch (error) {
    logError(`DOM DM verification failed: ${error.message}`, error);
    const result = createVerificationResult({
      verified: false,
      method: 'dom',
      reason: error.message || 'dom_dm_verification_failed'
    });
    recordTransportHealth(options, result);
    return result;
  }
}

function verifyPostScheduled(result = {}) {
  const method = normalizeVerificationMethod(result?.method || 'dom');
  if (result?.dryRun) {
    const verificationResult = createVerificationResult({
      verified: false,
      method,
      reason: 'dry_run_no_write'
    });
    recordTransportHealth(result, verificationResult);
    return verificationResult;
  }

  const resourceKey = cleanString(result?.resourceKey, 240);
  const verificationResult = createVerificationResult({
    verified: Boolean(resourceKey),
    method,
    reason: resourceKey ? null : 'missing_resource_key',
    metadata: {
      resourceKey: resourceKey || null
    }
  });
  recordTransportHealth(result, verificationResult);
  return verificationResult;
}

function normalizeVerificationMethod(method) {
  return 'dom';
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeMessageText(value) {
  return cleanString(value, 1000).toLowerCase();
}

function extractConversationMessages(payload, conversationUrn) {
  const matches = [];
  visit(payload?.json || payload, (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;

    const foundConversationUrn = findFirstMatchingString(
      value,
      /urn:li:msg_conversation:[A-Za-z0-9_:-]+/i
    );
    const deliveredAt = extractTimestamp(value);
    if (!foundConversationUrn || foundConversationUrn !== conversationUrn || !deliveredAt) return;

    const text = extractMessageText(value);
    if (!text) return;

    matches.push({
      conversationUrn,
      deliveredAt,
      messageKey: findFirstMatchingString(value, /urn:li:[A-Za-z0-9_:-]*message:[A-Za-z0-9_:-]+/i)
        || `${conversationUrn}_${deliveredAt}`,
      text
    });
  });

  return uniqueBy(matches, (message) => message.messageKey);
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

function extractMessageText(value) {
  let found = null;
  visit(value, (node, key) => {
    if (found || typeof node !== 'string') return;
    if (!/text|body|snippet|preview/i.test(String(key || ''))) return;
    const cleaned = cleanString(node, 1000);
    if (!cleaned || /^urn:li:/i.test(cleaned) || cleaned.length > 400) return;
    found = cleaned;
  });
  return found || '';
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

function uniqueBy(values, getKey) {
  const seen = new Set();
  return values.filter((value) => {
    const key = getKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recordTransportHealth(options = {}, result = {}) {
  const store = options.transportHealthStore;
  const action = cleanString(options.action, 80).toLowerCase();
  const accountEmail = cleanString(options.accountEmail, 240).toLowerCase();
  if (!store || !action || !accountEmail || options.dryRun) {
    return;
  }

  const transport = normalizeVerificationMethod(options.transport || result.method);
  if (!transport) {
    return;
  }

  if (result.verified === true && typeof store.recordSuccess === 'function') {
    store.recordSuccess(transport, action, accountEmail, {
      timestamp: result.at
    });
    return;
  }

  if (result.verified === false && typeof store.recordFailure === 'function') {
    store.recordFailure(transport, action, accountEmail, {
      timestamp: result.at,
      reason: result.reason || 'verification_failed'
    });
  }
}

module.exports = {
  createVerificationResult,
  verifyConnectionSent,
  verifyDmSent,
  verifyPostScheduled,
  _private: {
    normalizeVerificationMethod,
    normalizeMessageText,
    extractConversationMessages,
    recordTransportHealth
  }
};
