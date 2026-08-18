const fs = require('fs');
const path = require('path');
const { logAction, logError, LOG_DIR } = require('../util/log');

const TRACE_FILE = path.join(LOG_DIR, 'network-trace.jsonl');
const PAGE_STATE = new WeakMap();
const REDACTED = '<redacted>';
const SENSITIVE_HEADER_NAME_PATTERN = /^(authorization|proxy-authorization|cookie|set-cookie|x-csrf-token|csrf-token|x-xsrf-token|x-api-key)$/i;
const SENSITIVE_METADATA_KEY_PATTERN = /(password|token|cookie|secret|authorization|auth|session|csrf|message|text|body|content|note|subject)/i;

function isTraceEnabled() {
  const raw = String(process.env.CONNECT_TRACE_NETWORK || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function truncate(value, maxLength = 4000) {
  if (value == null) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...<truncated>`;
}

function ensureTraceDir() {
  fs.mkdirSync(path.dirname(TRACE_FILE), { recursive: true });
}

function appendTrace(event) {
  if (!isTraceEnabled()) return;
  try {
    ensureTraceDir();
    fs.appendFileSync(TRACE_FILE, `${JSON.stringify(event)}\n`);
  } catch (error) {
    logError('Failed to append network trace event', error);
  }
}

function getPageState(page) {
  let state = PAGE_STATE.get(page);
  if (!state) {
    state = {
      installed: false,
      stack: [],
      nextId: 1,
      requestMeta: new WeakMap()
    };
    PAGE_STATE.set(page, state);
  }
  return state;
}

function getActiveContext(page) {
  const state = getPageState(page);
  return state.stack[state.stack.length - 1] || null;
}

function serializeHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }
  return Object.fromEntries(
    Object.entries(headers)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [
        key,
        isSensitiveHeaderName(key) ? REDACTED : truncate(String(value || ''), 300)
      ])
  );
}

function isSensitiveHeaderName(name) {
  return SENSITIVE_HEADER_NAME_PATTERN.test(String(name || '').trim());
}

function sanitizeMetadata(value, depth = 0) {
  if (value == null || depth > 4) {
    return value == null ? value : REDACTED;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeMetadata(entry, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, entry]) => [
          key,
          SENSITIVE_METADATA_KEY_PATTERN.test(String(key || '').trim())
            ? REDACTED
            : sanitizeMetadata(entry, depth + 1)
        ])
    );
  }

  if (typeof value === 'string') {
    return truncate(value, 300);
  }

  return value;
}

function summarizePayload(value, options = {}) {
  if (value == null) {
    return null;
  }

  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const normalized = String(text || '').trim();
  if (!normalized) {
    return null;
  }

  const json = tryParseJson(normalized);
  if (json !== undefined) {
    return {
      format: 'json',
      length: normalized.length,
      redacted: true,
      shape: summarizeStructuredValue(json)
    };
  }

  const form = tryParseForm(normalized);
  if (form) {
    return {
      format: 'form',
      length: normalized.length,
      redacted: true,
      keys: form
    };
  }

  return {
    format: inferPayloadFormat(options.contentType),
    length: normalized.length,
    redacted: true
  };
}

function summarizeStructuredValue(value) {
  if (Array.isArray(value)) {
    const first = value[0];
    return {
      type: 'array',
      length: value.length,
      itemShape: first === undefined ? null : summarizeStructuredValue(first)
    };
  }

  if (value && typeof value === 'object') {
    return {
      type: 'object',
      keys: Object.keys(value).sort().slice(0, 40)
    };
  }

  return {
    type: typeof value
  };
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return undefined;
  }
}

function tryParseForm(value) {
  if (!value.includes('=')) {
    return null;
  }

  try {
    const params = new URLSearchParams(value);
    const keys = [...new Set(Array.from(params.keys()).map((key) => String(key || '').trim()).filter(Boolean))];
    return keys.length ? keys.slice(0, 40) : null;
  } catch (_) {
    return null;
  }
}

function inferPayloadFormat(contentType = '') {
  const normalized = String(contentType || '').toLowerCase();
  if (normalized.includes('application/json')) return 'json';
  if (normalized.includes('application/x-www-form-urlencoded')) return 'form';
  if (normalized.startsWith('text/')) return 'text';
  return 'text';
}

function instrumentPage(page) {
  if (!page || typeof page.on !== 'function' || !isTraceEnabled()) {
    return;
  }

  const state = getPageState(page);
  if (state.installed) {
    return;
  }

  page.on('request', async (request) => {
    const context = getActiveContext(page);
    if (!context) return;

    const requestId = state.nextId++;
    const startedAt = new Date().toISOString();
    let postData = null;

    try {
      postData = request.postData();
    } catch (_) {
      postData = null;
    }

    const meta = {
      requestId,
      action: context.name,
      actionRunId: context.runId,
      startedAt
    };

    state.requestMeta.set(request, meta);

    appendTrace({
      type: 'request',
      requestId,
      action: context.name,
      actionRunId: context.runId,
      startedAt,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      headers: serializeHeaders(request.headers()),
      postData: summarizePayload(postData),
      metadata: sanitizeMetadata(context.metadata || {})
    });
  });

  page.on('response', async (response) => {
    const request = response.request();
    const meta = state.requestMeta.get(request);
    if (!meta) return;

    let responseBody = null;
    const headers = serializeHeaders(response.headers());
    const contentType = String(headers['content-type'] || '').toLowerCase();

    try {
      if (contentType.includes('application/json') || contentType.includes('text/')) {
        responseBody = await response.text();
      }
    } catch (_) {
      responseBody = null;
    }

    appendTrace({
      type: 'response',
      requestId: meta.requestId,
      action: meta.action,
      actionRunId: meta.actionRunId,
      startedAt: meta.startedAt,
      finishedAt: new Date().toISOString(),
      method: request.method(),
      url: request.url(),
      status: response.status(),
      ok: response.ok(),
      headers,
      body: summarizePayload(responseBody, { contentType })
    });
  });

  state.installed = true;
  logAction(`Network tracer attached to page; writing to ${TRACE_FILE}`);
}

async function traceAction(page, name, metadata, fn) {
  if (!page || typeof fn !== 'function') {
    return fn();
  }

  if (!isTraceEnabled()) {
    return fn();
  }

  instrumentPage(page);

  const state = getPageState(page);
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const context = {
    name,
    metadata: sanitizeMetadata(metadata || {}),
    runId
  };

  state.stack.push(context);
  appendTrace({
    type: 'action_start',
    action: name,
    actionRunId: runId,
    startedAt: new Date().toISOString(),
    metadata: context.metadata
  });

  try {
    const result = await fn();
    appendTrace({
      type: 'action_end',
      action: name,
      actionRunId: runId,
      finishedAt: new Date().toISOString(),
      success: true
    });
    return result;
  } catch (error) {
    appendTrace({
      type: 'action_end',
      action: name,
      actionRunId: runId,
      finishedAt: new Date().toISOString(),
      success: false,
      error: {
        name: error?.name || 'Error',
        message: error?.message || String(error)
      }
    });
    throw error;
  } finally {
    const current = state.stack[state.stack.length - 1];
    if (current === context) {
      state.stack.pop();
    } else {
      state.stack = state.stack.filter((entry) => entry !== context);
    }
  }
}

module.exports = {
  TRACE_FILE,
  instrumentPage,
  traceAction
};
