'use strict';

/**
 * Pure helper for building child-process environments via spawn.
 *
 * Default policy is allowlist-first: nothing from process.env is forwarded
 * unless it's on DEFAULT_FORWARDED_ENV_KEYS. This stops secrets (anything
 * in CONNECT_API_TOKEN, LINKEDIN_PASSWORD, etc.) from silently leaking into
 * children that don't need them.
 *
 * Per-spawn `additions` overlay on top: callers that know a specific child
 * does need a specific variable opt in explicitly at the call site. That
 * makes credential flow visible in the spawn call rather than implicit in
 * the parent's environment.
 *
 * The allowlist intentionally contains:
 *   - POSIX basics that breaking would brick almost any process
 *     (PATH, HOME, USER, LOGNAME, SHELL, TMPDIR/TMP/TEMP, LANG/LC_ALL)
 *   - Proxy vars (upper- and lowercase — different tools read different cases)
 *   - NODE_ENV (runtime conventions) and ELECTRON_RUN_AS_NODE (Electron-as-Node)
 *   - CONNECT_TRACE_NETWORK — opt-in tracing flag
 *   - CONNECT_ALLOW_ENV_CREDENTIALS — the credentials gate itself, NOT a
 *     credential. Children that use the legacy automation path may need to
 *     know whether env credentials are allowed; the gate flag has to propagate
 *     so their internal readEnvCredential calls see the same policy as the
 *     parent. If you remove this from the list, a child running automation.js
 *     in a developer's gated-env workflow stops being able to authenticate.
 *
 * Credentials (LINKEDIN_PASSWORD, CONNECT_API_TOKEN, CONNECT_PLATFORM_WRITE_TOKEN)
 * are NOT on this list by design. Spawn sites that genuinely need them pass
 * them via the per-spawn `additions` map.
 */

const DEFAULT_FORWARDED_ENV_KEYS = Object.freeze([
  // POSIX basics
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  // Locale
  'LANG',
  'LC_ALL',
  // Proxies (upper- and lowercase variants — Node, curl, npm read different forms)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // Node / Electron
  'NODE_ENV',
  'ELECTRON_RUN_AS_NODE',
  // App-specific opt-in flags
  'CONNECT_TRACE_NETWORK',
  'CONNECT_ALLOW_ENV_CREDENTIALS',
  // Crash telemetry log directory — set by the main process so spawned
  // workers write process-level crash records to the same dir as main.
  // Not a credential; just a path. See automation/runtime/crash-telemetry.js.
  'CONNECT_CRASH_LOG_DIR'
]);

/**
 * Build the env map for a child process.
 *
 * @param {object} [opts]
 * @param {object} [opts.processEnv=process.env] — parent environment to filter
 * @param {object} [opts.additions={}] — per-spawn additions (override allowlisted keys)
 * @param {readonly string[]} [opts.allowlist=DEFAULT_FORWARDED_ENV_KEYS] — overrideable for tests/special cases
 * @param {boolean} [opts.packaged=false] — when true, ensure ELECTRON_RUN_AS_NODE=1
 * @returns {object} env map ready to pass to child_process.spawn
 */
function buildSpawnEnv({
  processEnv = process.env,
  additions = {},
  allowlist = DEFAULT_FORWARDED_ENV_KEYS,
  packaged = false
} = {}) {
  const env = {};
  for (const key of allowlist) {
    if (Object.prototype.hasOwnProperty.call(processEnv, key) && processEnv[key] !== undefined) {
      env[key] = processEnv[key];
    }
  }

  // Per-spawn additions overlay AFTER the allowlist. This means a call site
  // can also override an allowlisted value (e.g. NODE_ENV=production for a
  // specific child) without changing the allowlist itself.
  if (additions && typeof additions === 'object') {
    for (const key of Object.keys(additions)) {
      if (additions[key] !== undefined) {
        env[key] = additions[key];
      }
    }
  }

  if (packaged && env.ELECTRON_RUN_AS_NODE === undefined) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }

  return env;
}

module.exports = {
  buildSpawnEnv,
  DEFAULT_FORWARDED_ENV_KEYS
};
