'use strict';

/**
 * automation/runtime/proxy-config.js
 *
 * Shared utility for per-account proxy configuration.
 *
 * normalizeProxyConfig(proxy)
 *   Validates and normalises a raw proxy object from account config.
 *   Returns null when no proxy is configured (null, undefined, {}).
 *   Throws a clear Error when proxy fields are partially present or invalid.
 *
 * buildPlaywrightProxyOption(proxy)
 *   Converts a normalised proxy record into the object expected by
 *   chromium.launchPersistentContext({ proxy: ... }).
 *
 * formatProxyForLog(proxy)
 *   Returns a human-readable, password-redacted string for logging.
 */

const VALID_PROTOCOLS = new Set(['http', 'https', 'socks5', 'socks4']);

/**
 * Normalise and validate a raw proxy config object.
 *
 * @param {*} proxy  Raw value from account record or startup config
 * @returns {{ host:string, port:number, protocol:string, username:string|null, password:string|null }|null}
 */
function normalizeProxyConfig(proxy) {
  // null / undefined / false / non-object → no proxy
  if (!proxy || typeof proxy !== 'object') return null;

  const host     = String(proxy.host     || '').trim();
  const rawPort  = proxy.port;
  const hasHost  = host.length > 0;
  const hasPort  = rawPort !== undefined && rawPort !== null && rawPort !== '';

  // Empty object (neither host nor port) → no proxy
  if (!hasHost && !hasPort) return null;

  // Partial config — fail loudly so misconfigured accounts don't run without a proxy
  if (!hasHost) {
    throw new Error('proxy.host is required when proxy is configured');
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `proxy.port must be an integer between 1 and 65535 (got: ${JSON.stringify(rawPort)})`
    );
  }

  const protocol = String(proxy.protocol || 'http').trim().toLowerCase();
  if (!VALID_PROTOCOLS.has(protocol)) {
    throw new Error(
      `proxy.protocol must be one of: ${[...VALID_PROTOCOLS].join(', ')} (got: "${protocol}")`
    );
  }

  return {
    host,
    port,
    protocol,
    username: String(proxy.username || '').trim() || null,
    password: String(proxy.password || '').trim() || null
  };
}

/**
 * Convert a normalised proxy record into Playwright's proxy option format.
 *
 * @param {ReturnType<typeof normalizeProxyConfig>} proxy
 * @returns {{ server:string, username?:string, password?:string }|null}
 */
function buildPlaywrightProxyOption(proxy) {
  if (!proxy) return null;
  const result = { server: `${proxy.protocol}://${proxy.host}:${proxy.port}` };
  if (proxy.username) result.username = proxy.username;
  if (proxy.password) result.password = proxy.password;
  return result;
}

/**
 * Return a human-readable, password-redacted proxy string for log output.
 *
 * @param {ReturnType<typeof normalizeProxyConfig>} proxy
 * @returns {string}
 */
function formatProxyForLog(proxy) {
  if (!proxy) return 'none';
  const auth = proxy.username ? `${proxy.username}@` : '';
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}

module.exports = { normalizeProxyConfig, buildPlaywrightProxyOption, formatProxyForLog };
