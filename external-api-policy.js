'use strict';

/**
 * external-api-policy.js
 *
 * Pure policy for the local HTTP API (main.js startExternalApiServer). Three
 * decisions live here so they can be reviewed + tested in one place:
 *
 *  1. resolveServerBindDecision({ tokenConfigured, devUnauth })
 *     — should the server bind at all?
 *       - tokenConfigured: bind in 'token' mode (production-safe)
 *       - !tokenConfigured && devUnauth: bind in 'dev_unauth' mode
 *         (intentional bypass for local debugging only)
 *       - neither: do NOT bind. This is the safe default — a fresh install
 *         with no token configured silently exposed an authentic API surface
 *         to any loopback caller, including any browser tab the user happened
 *         to have open. The bind gate closes that exposure.
 *
 *  2. buildCorsHeaders(origin, allowedOrigins)
 *     — echo Access-Control-Allow-Origin ONLY when the request's Origin is on
 *       the explicit allowlist. Empty allowlist (the default) emits no CORS
 *       headers; the wildcard `*` is never used. Non-browser callers (CLI,
 *       MCP, curl without -H Origin) send no Origin header and are unaffected
 *       — CORS is a browser-only enforcement. Includes `Vary: Origin` so
 *       intermediaries don't cache a header that depends on a request header.
 *
 *  3. compareTokenSafely(provided, expected)
 *     — constant-time compare via crypto.timingSafeEqual. Pads the provided
 *       buffer to the expected length so a length mismatch doesn't throw and
 *       doesn't short-circuit the comparison either. Standard pattern.
 *
 * Also: parseAllowedOrigins(raw) — comma-separated string → trimmed,
 * deduplicated array. Tolerates undefined / empty / weird whitespace.
 *
 * Nothing in here imports Node http or main.js state. Pure.
 */

const crypto = require('crypto');

/**
 * Parse a CONNECT_API_ALLOWED_ORIGINS-style string into an array.
 *
 * "https://app.example, http://localhost:3000,, https://app.example "
 *   → ["https://app.example", "http://localhost:3000"]
 *
 * @param {*} raw
 * @returns {string[]}
 */
function parseAllowedOrigins(raw) {
  if (raw === null || raw === undefined) return [];
  const text = typeof raw === 'string' ? raw : String(raw);
  const seen = new Set();
  const out = [];
  for (const piece of text.split(',')) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Is this Origin header value on the allowlist?
 * Case-sensitive (per the Origin spec — origins are compared byte-for-byte).
 *
 * @param {string} origin
 * @param {string[]} allowedOrigins
 * @returns {boolean}
 */
function isOriginAllowed(origin, allowedOrigins) {
  if (!origin || typeof origin !== 'string') return false;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return false;
  return allowedOrigins.includes(origin);
}

/**
 * Build the CORS response header set for a request. Returns an empty object
 * (no CORS headers at all) when the origin is not allowlisted — that's
 * intentional: a browser with no Access-Control-Allow-Origin in the response
 * blocks the request, while a non-browser client doesn't care.
 *
 * @param {string} origin            — req.headers.origin
 * @param {string[]} allowedOrigins  — from parseAllowedOrigins
 * @returns {object}
 */
function buildCorsHeaders(origin, allowedOrigins) {
  if (!isOriginAllowed(origin, allowedOrigins)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Token',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    Vary: 'Origin'
  };
}

/**
 * Decide whether and how to bind the local HTTP API.
 *
 * @param {object} params
 * @param {boolean} params.tokenConfigured   — a non-empty CONNECT_API_TOKEN resolved
 * @param {boolean} params.devUnauth         — CONNECT_API_DEV_UNAUTH=1
 * @returns {{ start: boolean, mode: 'token'|'dev_unauth'|'disabled', reason: string }}
 */
function resolveServerBindDecision({ tokenConfigured, devUnauth } = {}) {
  if (tokenConfigured) {
    return {
      start: true,
      mode: 'token',
      reason: 'API token configured; binding with authenticated mode.'
    };
  }
  if (devUnauth) {
    return {
      start: true,
      mode: 'dev_unauth',
      reason:
        'CONNECT_API_DEV_UNAUTH=1 — binding without a token. DEV ONLY. ' +
        'Browser origins are still controlled by CONNECT_API_ALLOWED_ORIGINS; ' +
        'this override does NOT relax CORS.'
    };
  }
  return {
    start: false,
    mode: 'disabled',
    // Phrased for skimmability so a future operator debugging "why is port
    // 3030 dead?" sees the cause + both remediations on one line.
    reason:
      'no API token configured. Create <appState>/secrets/api-token, or set ' +
      'CONNECT_API_DEV_UNAUTH=1 for local-only development.'
  };
}

/**
 * Constant-time compare for HTTP API tokens. Returns false for non-strings,
 * empty inputs, length mismatch (after a still-constant compare to avoid the
 * `if (a.length !== b.length)` early-return timing leak), and any inequality.
 *
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
function compareTokenSafely(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (expected.length === 0) return false;
  const expectedBuf = Buffer.from(expected, 'utf8');
  // Allocate a fixed-length buffer for the provided value so timingSafeEqual
  // never throws and the comparison work is constant per request.
  const providedBuf = Buffer.alloc(expectedBuf.length);
  Buffer.from(provided, 'utf8').copy(providedBuf);
  const equalBytes = crypto.timingSafeEqual(providedBuf, expectedBuf);
  // Only after the constant-time compare do we admit the length check.
  return equalBytes && provided.length === expected.length;
}

module.exports = {
  parseAllowedOrigins,
  isOriginAllowed,
  buildCorsHeaders,
  resolveServerBindDecision,
  compareTokenSafely
};
