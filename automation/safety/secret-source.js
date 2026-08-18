'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Shared credential-source resolution.
 *
 * Two responsibilities:
 *   1. Read a secret from a file in the app-state directory, refusing files
 *      with permissive (group/world readable) modes on POSIX. This is the
 *      preferred persistent source — keytar is better but heavier to wire up
 *      everywhere; a 0600 file is a meaningful step up from `.env`.
 *   2. Gate `process.env` credential reads behind CONNECT_ALLOW_ENV_CREDENTIALS.
 *      The default is OFF: production should rely on the keychain or the secure
 *      file. The env path stays available for explicit dev workflows but stops
 *      being the silent fallback that defeats every other credential store in
 *      the codebase.
 *
 * Both helpers warn at most once per (name, source) so a misconfigured
 * environment yields a single visible line rather than a flood.
 */

const _onceWarned = new Set();
function _warnOnce(key, message) {
  if (_onceWarned.has(key)) return;
  _onceWarned.add(key);
  process.stderr.write(`${message}\n`);
}

function _resetSecretSourceWarningsForTests() {
  _onceWarned.clear();
}

/**
 * Returns true when the file mode is sufficiently restricted.
 *
 * On POSIX (mode != 0 in stat), require 0600 or stricter: no group, no world
 * bits set in either read or write. On Windows (mode reads as 0o666 typically
 * with no real meaning), the check is skipped — Windows ACLs are not visible
 * via fs.stat, and we don't want to gate behavior on a value that doesn't
 * mean what it does on POSIX.
 *
 * @param {fs.Stats} stats
 */
function _hasSecureFileMode(stats) {
  if (process.platform === 'win32') return true;
  // mode is e.g. 0o100600 for a regular file with 0600 perms; mask permissions.
  const perms = stats.mode & 0o777;
  // Reject anything with group or world bits set.
  return (perms & 0o077) === 0;
}

/**
 * Read a secret from a file. The file path is typically under the app-state
 * directory.
 *
 * Returns { value, source } when the file exists and has secure permissions.
 * Returns null when the file does not exist (caller falls through). Throws on
 * other I/O errors so a real fault doesn't get silently swallowed.
 *
 * When the file exists but has permissive permissions, the function refuses
 * to read it, warns once, and returns null. That is a deliberate fail-closed
 * choice: a token saved with the wrong mode probably means the user copied
 * it from `.env` without thinking, and we'd rather have them notice than
 * proceed pretending the security boundary holds.
 *
 * @param {string} filePath
 * @param {object} options
 * @param {string} [options.name='secret'] — identifier used in warnings
 * @returns {{ value: string, source: 'file' } | null}
 */
function readSecretFromFile(filePath, { name = 'secret' } = {}) {
  const resolvedPath = path.resolve(filePath);

  let stats;
  try {
    stats = fs.statSync(resolvedPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  if (!_hasSecureFileMode(stats)) {
    const perms = (stats.mode & 0o777).toString(8).padStart(3, '0');
    _warnOnce(
      `file-mode:${resolvedPath}`,
      `[secret-source] Refusing to load ${name} from ${resolvedPath}: `
      + `file mode is 0${perms}, expected 0600 (owner-only). Tighten with: chmod 600 "${resolvedPath}"`
    );
    return null;
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const value = String(raw || '').trim();
  if (!value) return null;
  return { value, source: 'file' };
}

/**
 * Read a credential from `process.env`, gated on CONNECT_ALLOW_ENV_CREDENTIALS.
 *
 * Default: ignore the env var entirely. When the gate is on AND the env var
 * has a value, return it and emit a once-only warning so the operator knows
 * the dev-mode escape hatch is active.
 *
 * @param {string} envVarName
 * @param {object} [options]
 * @param {string} [options.name] — identifier used in warnings
 * @param {() => string|undefined} [options.envReader] — for tests; defaults to process.env lookup
 * @returns {{ value: string, source: 'env' } | null}
 */
function readEnvCredential(envVarName, { name = envVarName, envReader = null } = {}) {
  const allow = String(process.env.CONNECT_ALLOW_ENV_CREDENTIALS || '').trim().toLowerCase();
  const gateOn = allow === '1' || allow === 'true' || allow === 'yes';
  if (!gateOn) return null;

  const value = typeof envReader === 'function'
    ? envReader()
    : process.env[envVarName];
  const normalized = String(value || '').trim();
  if (!normalized) return null;

  _warnOnce(
    `env-credential:${envVarName}`,
    `[secret-source] Using ${name} from environment (CONNECT_ALLOW_ENV_CREDENTIALS is set). `
    + `This bypass should be temporary — move the credential to keychain or a 0600 file.`
  );
  return { value: normalized, source: 'env' };
}

/**
 * Layered token resolution: explicit override wins, then secure file, then
 * env var (only if the gate is on). Returns the first hit or null.
 *
 * Intended use:
 *
 *   const resolved = resolveSecret({
 *     name: 'CONNECT_API_TOKEN',
 *     explicit: cliTokenArg,
 *     filePath: path.join(appStateDir, 'secrets', 'api-token'),
 *     envVarName: 'CONNECT_API_TOKEN'
 *   });
 *
 *   if (!resolved) throw new Error('token required');
 *
 * @param {object} options
 * @param {string} options.name
 * @param {string} [options.explicit]
 * @param {string} [options.filePath]
 * @param {string} [options.envVarName]
 * @returns {{ value: string, source: 'cli'|'file'|'env' } | null}
 */
function resolveSecret({ name, explicit, filePath, envVarName }) {
  const explicitValue = String(explicit || '').trim();
  if (explicitValue) {
    return { value: explicitValue, source: 'cli' };
  }
  if (filePath) {
    const fromFile = readSecretFromFile(filePath, { name });
    if (fromFile) return fromFile;
  }
  if (envVarName) {
    const fromEnv = readEnvCredential(envVarName, { name });
    if (fromEnv) return fromEnv;
  }
  return null;
}

module.exports = {
  readSecretFromFile,
  readEnvCredential,
  resolveSecret,
  _resetSecretSourceWarningsForTests
};
