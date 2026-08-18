'use strict';

const crypto = require('crypto');
const { parseRetryAfterMs } = require('../safety/retry-after');

// LinkedIn Voyager web client version — update when LinkedIn ships a new
// build (visible in page source as `clientVersion`).
const CLIENT_VERSION = '1.13.16069';

// Messaging-only query IDs (inlined — no more query-catalog dependency)
const MESSAGING_QUERY_IDS = Object.freeze({
  inboxBootstrap: 'messengerConversations.0d5e6781bbee71c3e51c8843c6519f48',
  inboxPaged: 'messengerConversations.9501074288a12f3ae9e3c7ea243bccbf',
  mailboxCounts: 'messengerMailboxCounts.fc528a5a81a76dff212a4a3d2d48e84b',
  conversationMessages: 'messengerMessages.5846eeb71c981f11e0134cb6626cc314',
  conversationMessagesDelta: 'messengerMessages.d8ea76885a52fd5dc5c317078ab7c977',
  seenReceipts: 'messengerSeenReceipts.dc29d9bcecad524b9dd264acbbde3b5c',
  composeViewContext: 'voyagerMessagingDashComposeViewContexts.e15a66a8288033ed20e84acb49714a78'
});

const DEFAULT_HEADERS = {
  accept: 'application/vnd.linkedin.normalized+json+2.1',
  'content-type': 'application/json; charset=UTF-8',
  'x-li-deco-include-micro-schema': 'true',
  'x-li-lang': 'en_US',
  'x-restli-protocol-version': '2.0.0'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveTimezoneOffset(timezoneId) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezoneId,
      timeZoneName: 'shortOffset'
    }).formatToParts(new Date());
    const tzPart = parts.find((p) => p.type === 'timeZoneName');
    if (!tzPart) return 0;
    const match = tzPart.value.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!match) return 0;
    const sign = match[1] === '+' ? 1 : -1;
    const hours = parseInt(match[2], 10);
    const minutes = parseInt(match[3] || '0', 10);
    return sign * (hours + minutes / 60);
  } catch (_) {
    return 0;
  }
}

function randomBetween(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function encodeGraphQlScalar(value) {
  return encodeURIComponent(String(value ?? ''));
}

function buildGraphQlList(values = []) {
  return `List(${values.map((value) => encodeGraphQlScalar(value)).join(',')})`;
}

function buildGraphQlVariables(parts = []) {
  return `(${parts.filter(Boolean).map(renderGraphQlVariable).join(',')})`;
}

function renderGraphQlVariable(part) {
  if (typeof part === 'string') return part;
  const key = String(part?.key || '').trim();
  if (!key) throw new Error('GraphQL variable key is required');
  const rawValue = part.raw ? String(part.value ?? '') : encodeGraphQlScalar(part.value ?? '');
  return `${key}:${rawValue}`;
}

function escapeGraphQlString(raw) {
  return String(raw || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function deriveCsrfToken(cookies) {
  const jsessionId = cookies.find((cookie) => cookie.name === 'JSESSIONID');
  return jsessionId?.value ? jsessionId.value.replace(/^"|"$/g, '') : '';
}

function buildCookieHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function makeTrackingIdBytes() {
  return crypto.randomBytes(16).toString('latin1');
}

function escapeHeaderValue(value) {
  return String(value || '').replace(/"/g, '\\"');
}

async function probeClientVersionFromPage(page) {
  try {
    return await page.evaluate(() => {
      try {
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const text = script.textContent || '';
          const match = text.match(/clientVersion['":\s]+['"](\d+\.\d+\.\d+)['"]/);
          if (match) return match[1];
        }
        const metaVersion = document.querySelector('meta[name="clientVersion"]');
        if (metaVersion?.content) return metaVersion.content.trim();
      } catch {}
      return null;
    });
  } catch {
    return null;
  }
}

function normalizeFingerprintProfile(profile) {
  if (!profile || typeof profile !== 'object') return { clientHints: null };
  return { clientHints: normalizeClientHints(profile.clientHints) };
}

function normalizeClientHints(clientHints) {
  if (!clientHints || typeof clientHints !== 'object') return null;
  const brands = Array.isArray(clientHints.brands)
    ? clientHints.brands
        .map((entry) => ({ brand: String(entry?.brand || '').trim(), version: String(entry?.version || '').trim() }))
        .filter((entry) => entry.brand && entry.version)
    : [];
  const platform = String(clientHints.platform || '').trim();
  if (!brands.length || !platform) return null;
  return { brands, mobile: clientHints.mobile === true, platform, fullVersion: String(clientHints.fullVersion || '').trim() };
}

function buildClientHintHeaders(clientHints) {
  const normalized = normalizeClientHints(clientHints);
  if (!normalized) return {};
  return {
    'sec-ch-ua': normalized.brands.map((entry) => `"${escapeHeaderValue(entry.brand)}";v="${escapeHeaderValue(entry.version)}"`).join(', '),
    'sec-ch-ua-mobile': normalized.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${escapeHeaderValue(normalized.platform)}"`
  };
}

// ---------------------------------------------------------------------------
// LinkedInPrivateApiClient — messaging-only (connections, posting, profile
// queries removed; DOM automation handles those actions instead)
// ---------------------------------------------------------------------------
class LinkedInPrivateApiClient {
  constructor(options = {}) {
    this.page = options.page;
    this.context = options.context || this.page?.context?.();
    this.minDelayMs = options.minDelayMs ?? 2400;
    this.maxDelayMs = options.maxDelayMs ?? 7600;
    this.timezoneId = String(options.timezoneId || this.page?.__connectTimezoneId || '').trim() || null;
    this.fingerprintProfile = normalizeFingerprintProfile(
      options.fingerprintProfile || this.page?.__connectFingerprintProfile || null
    );
    this.cachedHeaders = null;
    this.resolvedClientVersion = null;
  }

  async naturalPause(minMs = this.minDelayMs, maxMs = this.maxDelayMs) {
    await sleep(randomBetween(minMs, maxMs));
  }

  async refreshSessionHeaders() {
    if (!this.context || !this.page) {
      throw new Error('LinkedInPrivateApiClient requires a live Playwright page/context');
    }
    const cookies = await this.context.cookies('https://www.linkedin.com');
    const csrfToken = deriveCsrfToken(cookies);
    const cookieHeader = buildCookieHeader(cookies);
    const pageInstance = await this.page.evaluate(() => {
      const meta = document.querySelector('meta[name="clientPageInstanceId"]');
      if (meta?.content) return meta.content;
      return document.documentElement.getAttribute('data-page-instance') || '';
    }).catch(() => '');

    if (!this.resolvedClientVersion) {
      this.resolvedClientVersion = await probeClientVersionFromPage(this.page);
    }
    const clientVersion = this.resolvedClientVersion || CLIENT_VERSION;
    const timezoneId = this.timezoneId;
    if (!timezoneId) {
      throw new Error('LinkedInPrivateApiClient requires timezoneId to be set');
    }

    this.cachedHeaders = {
      ...DEFAULT_HEADERS,
      ...buildClientHintHeaders(this.fingerprintProfile?.clientHints || null),
      cookie: cookieHeader,
      'csrf-token': csrfToken,
      'x-li-page-instance': pageInstance || undefined,
      'x-li-track': JSON.stringify({
        clientVersion,
        mpVersion: clientVersion,
        osName: 'web',
        timezoneOffset: resolveTimezoneOffset(timezoneId),
        timezone: timezoneId,
        deviceFormFactor: 'DESKTOP',
        mpName: 'voyager-web'
      })
    };
    return this.cachedHeaders;
  }

  async getHeaders(extra = {}) {
    const base = this.cachedHeaders || await this.refreshSessionHeaders();
    return { ...base, ...extra };
  }

  async request(method, url, options = {}) {
    const headers = await this.getHeaders(options.headers || {});
    await this.naturalPause(options.minDelayMs, options.maxDelayMs);
    const response = await fetch(url, {
      method,
      headers,
      body: options.json ? JSON.stringify(options.json) : options.body
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (!response.ok) {
      // Preserve the existing message format so regex consumers (account
      // health classifier, post-publish-retry patterns) keep working. The
      // structured fields are additive — new code reads them; old code
      // ignores them.
      const bodyPreview = text.slice(0, 300);
      const err = new Error(`LinkedIn API ${method} ${url} failed: ${response.status} ${bodyPreview}`);
      err.httpStatus = response.status;
      err.responseBodyPreview = bodyPreview;
      // Retry-After is only meaningful on 429 / 503, but we parse opportunistically
      // — a present header on any status is still useful information to surface.
      const retryAfterHeader = typeof response.headers?.get === 'function'
        ? response.headers.get('Retry-After')
        : null;
      if (retryAfterHeader) {
        err.retryAfterHeader = retryAfterHeader;
        const parsedMs = parseRetryAfterMs(retryAfterHeader);
        if (parsedMs !== null) err.retryAfterMs = parsedMs;
      }
      throw err;
    }
    return { response, text, json };
  }

  // --- Messaging context (DOM hybrid — reads URNs from page HTML) ---

  async extractMessagingContextFromPage() {
    if (!this.page) return {};
    return this.page.evaluate(() => {
      const html = document.documentElement?.outerHTML || '';
      const pick = (pattern) => { const match = html.match(pattern); return match ? match[0] : null; };
      return {
        conversationUrn: pick(/urn:li:msg_conversation:[A-Za-z0-9_:-]+/),
        mailboxUrn: pick(/urn:li:fsd_profile:[A-Za-z0-9_-]+/),
        recipientProfileUrn: pick(/urn:li:fsd_profile:[A-Za-z0-9_-]+/)
      };
    }).catch(() => ({}));
  }

  // --- Inbox polling ---

  async listInboxConversations({ mailboxUrn, count = 20, nextCursor, lastUpdatedBefore } = {}) {
    const rawVariables = buildGraphQlVariables([
      { key: 'query', value: '(predicateUnions:List((conversationCategoryPredicate:(category:INBOX))))', raw: true },
      { key: 'count', value: count, raw: true },
      { key: 'mailboxUrn', value: mailboxUrn },
      nextCursor ? { key: 'nextCursor', value: nextCursor } : null,
      !nextCursor && lastUpdatedBefore ? { key: 'lastUpdatedBefore', value: lastUpdatedBefore, raw: true } : null
    ]);
    return this.request('GET', `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${MESSAGING_QUERY_IDS.inboxPaged}&variables=${rawVariables}`);
  }

  async bootstrapInbox(mailboxUrn) {
    const variables = buildGraphQlVariables([{ key: 'mailboxUrn', value: mailboxUrn }]);
    const conversationsUrl = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${MESSAGING_QUERY_IDS.inboxBootstrap}&variables=${variables}`;
    const countsUrl = `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${MESSAGING_QUERY_IDS.mailboxCounts}&variables=${variables}`;
    let conversations = null;
    let counts = null;
    let countsError = null;
    try {
      conversations = await this.request('GET', conversationsUrl, { minDelayMs: 800, maxDelayMs: 2000 });
    } catch (bootstrapError) {
      try {
        conversations = await this.listInboxConversations({ mailboxUrn, count: 20 });
      } catch (fallbackError) {
        throw new Error(`Inbox bootstrap failed: ${bootstrapError.message}. Fallback: ${fallbackError.message}`);
      }
    }
    try {
      counts = await this.request('GET', countsUrl, { minDelayMs: 800, maxDelayMs: 2000 });
    } catch (error) {
      countsError = error.message;
    }
    return { conversations, counts, countsError };
  }

  async getConversationMessages(conversationUrn, syncToken) {
    const rawVariables = buildGraphQlVariables([
      { key: 'conversationUrn', value: conversationUrn },
      syncToken ? { key: 'syncToken', value: syncToken } : null
    ]);
    return this.request('GET', `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${MESSAGING_QUERY_IDS.conversationMessages}&variables=${rawVariables}`);
  }

  async getConversationMessagesDelta({ conversationUrn, deliveredAt, countBefore = 20, countAfter = 0 }) {
    const rawVariables = buildGraphQlVariables([
      { key: 'deliveredAt', value: deliveredAt, raw: true },
      { key: 'conversationUrn', value: conversationUrn },
      { key: 'countBefore', value: countBefore, raw: true },
      { key: 'countAfter', value: countAfter, raw: true }
    ]);
    return this.request('GET', `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${MESSAGING_QUERY_IDS.conversationMessagesDelta}&variables=${rawVariables}`);
  }

  async getSeenReceipts(conversationUrn) {
    const variables = buildGraphQlVariables([{ key: 'conversationUrn', value: conversationUrn }]);
    return this.request('GET', `https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${MESSAGING_QUERY_IDS.seenReceipts}&variables=${variables}`);
  }

  async getComposeViewContext({ recipientProfileUrn, contextEntityUrn }) {
    const rawVariables = buildGraphQlVariables([
      { key: 'recipients', value: buildGraphQlList([recipientProfileUrn]), raw: true },
      { key: 'type', value: 'REPLY', raw: true },
      { key: 'contextEntityUrn', value: contextEntityUrn }
    ]);
    return this.request('GET', `https://www.linkedin.com/voyager/api/graphql?variables=${rawVariables}&queryId=${MESSAGING_QUERY_IDS.composeViewContext}`);
  }

  async sendTypingIndicator(conversationUrn) {
    return this.request('POST', 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerConversations?action=typing', {
      json: { conversationUrn }
    });
  }

  async sendMessage({ mailboxUrn, conversationUrn, text, originToken, trackingId, dedupeByClientGeneratedToken = false }) {
    return this.request('POST', 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage', {
      json: {
        message: {
          body: { attributes: [], text },
          renderContentUnions: [],
          conversationUrn,
          originToken: originToken || crypto.randomUUID()
        },
        mailboxUrn,
        trackingId: trackingId || makeTrackingIdBytes(),
        dedupeByClientGeneratedToken
      },
      headers: { 'x-li-pem-metadata': 'Voyager - Messaging - Compose=message-send' }
    });
  }
}

module.exports = {
  LinkedInPrivateApiClient,
  MESSAGING_QUERY_IDS,
  _private: {
    buildClientHintHeaders,
    normalizeClientHints,
    probeClientVersionFromPage
  }
};
