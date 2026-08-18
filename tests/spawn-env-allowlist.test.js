'use strict';

/**
 * tests/spawn-env-allowlist.test.js
 *
 * Unit tests for the shared spawn-env allowlist helper. Every child process
 * the Electron main spawns goes through buildSpawnEnv, so the contract here
 * is safety-critical: credentials that aren't on the allowlist must not
 * appear in the child env unless a per-spawn addition explicitly opts in.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSpawnEnv,
  DEFAULT_FORWARDED_ENV_KEYS
} = require('../automation/safety/spawn-env-allowlist');

// ---------------------------------------------------------------------------
// Default policy: secrets do not leak
// ---------------------------------------------------------------------------

test('credentials and non-allowlisted keys are dropped by default', () => {
  const processEnv = {
    PATH: '/usr/bin',
    HOME: '/Users/test',
    // These must NOT propagate:
    LINKEDIN_PASSWORD: 'super-secret',
    LINKEDIN_EMAIL: 'me@example.com',
    CONNECT_API_TOKEN: 'token-shh',
    CONNECT_PLATFORM_WRITE_TOKEN: 'write-shh',
    APOLLO_API_KEY: 'apollo-shh',
    AWS_SECRET_ACCESS_KEY: 'aws-shh',
    SOME_RANDOM_VAR: 'whatever'
  };

  const env = buildSpawnEnv({ processEnv });

  // Allowlisted keys present
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/Users/test');

  // Credentials are dropped — even LINKEDIN_EMAIL (the dev convenience var
  // is not "free" because it's not on the default allowlist; spawn sites
  // that need it pass it via additions).
  assert.equal(env.LINKEDIN_PASSWORD, undefined);
  assert.equal(env.LINKEDIN_EMAIL, undefined);
  assert.equal(env.CONNECT_API_TOKEN, undefined);
  assert.equal(env.CONNECT_PLATFORM_WRITE_TOKEN, undefined);
  assert.equal(env.APOLLO_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.SOME_RANDOM_VAR, undefined);
});

test('every allowlisted key is forwarded when present in processEnv', () => {
  const processEnv = {};
  for (const key of DEFAULT_FORWARDED_ENV_KEYS) {
    processEnv[key] = `value-${key}`;
  }

  const env = buildSpawnEnv({ processEnv });

  for (const key of DEFAULT_FORWARDED_ENV_KEYS) {
    assert.equal(env[key], `value-${key}`, `expected allowlisted key ${key} to be forwarded`);
  }
});

test('missing or undefined allowlisted keys are skipped (not set to undefined)', () => {
  const processEnv = {
    PATH: '/usr/bin',
    HOME: undefined,
    USER: ''
  };

  const env = buildSpawnEnv({ processEnv });

  assert.equal(env.PATH, '/usr/bin');
  // HOME=undefined and entries not present in processEnv at all should NOT
  // appear as undefined keys in the result.
  assert.equal('HOME' in env, false, 'undefined values should not leak as undefined keys');
  assert.equal('TMPDIR' in env, false, 'absent keys should not appear at all');
  // Empty string is a defined value and should be forwarded as-is — an
  // operator who set USER='' presumably did so intentionally.
  assert.equal(env.USER, '');
});

// ---------------------------------------------------------------------------
// Allowlist composition
// ---------------------------------------------------------------------------

test('lowercase proxy variants are forwarded alongside uppercase', () => {
  const processEnv = {
    HTTP_PROXY: 'http://upper.proxy:3128',
    http_proxy: 'http://lower.proxy:3128',
    HTTPS_PROXY: 'https://upper.proxy:3128',
    https_proxy: 'https://lower.proxy:3128',
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1'
  };

  const env = buildSpawnEnv({ processEnv });

  assert.equal(env.HTTP_PROXY, 'http://upper.proxy:3128');
  assert.equal(env.http_proxy, 'http://lower.proxy:3128');
  assert.equal(env.HTTPS_PROXY, 'https://upper.proxy:3128');
  assert.equal(env.https_proxy, 'https://lower.proxy:3128');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(env.no_proxy, 'localhost,127.0.0.1');
});

test('CONNECT_ALLOW_ENV_CREDENTIALS gate flag IS forwarded (it is policy, not a secret)', () => {
  // Children running legacy automation.js need to know whether env credentials
  // are allowed so their internal readEnvCredential gate sees the same policy
  // as the parent.
  const env = buildSpawnEnv({
    processEnv: { CONNECT_ALLOW_ENV_CREDENTIALS: '1' }
  });
  assert.equal(env.CONNECT_ALLOW_ENV_CREDENTIALS, '1');
});

test('CONNECT_TRACE_NETWORK flag IS forwarded', () => {
  const env = buildSpawnEnv({
    processEnv: { CONNECT_TRACE_NETWORK: 'false' }
  });
  assert.equal(env.CONNECT_TRACE_NETWORK, 'false');
});

test('CONNECT_CRASH_LOG_DIR IS forwarded (crash telemetry path, not a credential)', () => {
  const env = buildSpawnEnv({
    processEnv: { CONNECT_CRASH_LOG_DIR: '/tmp/crash-logs' }
  });
  assert.equal(env.CONNECT_CRASH_LOG_DIR, '/tmp/crash-logs');
});

// ---------------------------------------------------------------------------
// Per-spawn additions
// ---------------------------------------------------------------------------

test('per-spawn additions are overlaid on top of the allowlisted base', () => {
  const env = buildSpawnEnv({
    processEnv: { PATH: '/usr/bin', HOME: '/h' },
    additions: {
      LINKEDIN_PASSWORD: 'opted-in-secret',
      LINKEDIN_EMAIL: 'opted-in@example.com'
    }
  });

  // Allowlisted base
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/h');
  // Per-spawn explicit opt-in for a credential
  assert.equal(env.LINKEDIN_PASSWORD, 'opted-in-secret');
  assert.equal(env.LINKEDIN_EMAIL, 'opted-in@example.com');
});

test('per-spawn additions can override allowlisted values', () => {
  // A specific child may want NODE_ENV=production regardless of the parent.
  const env = buildSpawnEnv({
    processEnv: { NODE_ENV: 'development' },
    additions: { NODE_ENV: 'production' }
  });
  assert.equal(env.NODE_ENV, 'production');
});

test('per-spawn additions with undefined values do not appear', () => {
  // Sometimes additions are computed from process.env || '' — an explicit
  // undefined should be treated like "nothing to add" for that key.
  const env = buildSpawnEnv({
    processEnv: { PATH: '/usr/bin' },
    additions: { LINKEDIN_PASSWORD: undefined, LINKEDIN_EMAIL: '' }
  });
  assert.equal('LINKEDIN_PASSWORD' in env, false, 'undefined additions are skipped');
  // Empty string is a real value and gets forwarded — the legacy spawn-site
  // helper relies on this to forward LINKEDIN_PASSWORD='' so the child's
  // gate sees "no env password" rather than "missing var".
  assert.equal(env.LINKEDIN_EMAIL, '');
});

// ---------------------------------------------------------------------------
// Packaged-app behavior
// ---------------------------------------------------------------------------

test('packaged=true ensures ELECTRON_RUN_AS_NODE=1 even when parent does not set it', () => {
  const env = buildSpawnEnv({
    processEnv: { PATH: '/usr/bin' },
    packaged: true
  });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
});

test('packaged=true preserves an explicit ELECTRON_RUN_AS_NODE from additions', () => {
  // Someone who passes ELECTRON_RUN_AS_NODE=0 intentionally (unusual) should
  // see that value, not get clobbered by packaged-mode default.
  const env = buildSpawnEnv({
    processEnv: { PATH: '/usr/bin' },
    additions: { ELECTRON_RUN_AS_NODE: '0' },
    packaged: true
  });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '0');
});

test('packaged=false does not inject ELECTRON_RUN_AS_NODE', () => {
  const env = buildSpawnEnv({
    processEnv: { PATH: '/usr/bin' },
    packaged: false
  });
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false);
});

// ---------------------------------------------------------------------------
// Allowlist hygiene
// ---------------------------------------------------------------------------

test('DEFAULT_FORWARDED_ENV_KEYS does not contain credential-shaped names', () => {
  // Future-proof check: if someone adds 'CONNECT_API_TOKEN' or similar to the
  // allowlist, this test catches it.
  const forbidden = [
    'CONNECT_API_TOKEN',
    'CONNECT_PLATFORM_WRITE_TOKEN',
    'LINKEDIN_PASSWORD',
    'APOLLO_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY_ID',
    'GITHUB_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY'
  ];
  for (const name of forbidden) {
    assert.equal(
      DEFAULT_FORWARDED_ENV_KEYS.includes(name),
      false,
      `${name} must not be on the default spawn allowlist`
    );
  }
});

test('DEFAULT_FORWARDED_ENV_KEYS is frozen (cannot be mutated at runtime)', () => {
  assert.throws(() => {
    DEFAULT_FORWARDED_ENV_KEYS.push('LINKEDIN_PASSWORD');
  });
});
