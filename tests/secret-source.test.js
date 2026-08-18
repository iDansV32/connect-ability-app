'use strict';

/**
 * tests/secret-source.test.js
 *
 * Unit tests for the shared credential-source module. This is safety-critical
 * code path: every site that reads a credential in this codebase goes through
 * one of its three exports (readSecretFromFile, readEnvCredential, resolveSecret).
 *
 * Properties pinned:
 *   - 0600 file is honored; 0644 file is refused and warned once
 *   - Missing file returns null (no crash)
 *   - Env credential is ignored without CONNECT_ALLOW_ENV_CREDENTIALS=1
 *   - Env credential is read WITH the gate, with a once-only warning
 *   - resolveSecret picks explicit > file > env in that order
 *   - Resolution returns the source name so callers can log/audit
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  readSecretFromFile,
  readEnvCredential,
  resolveSecret,
  _resetSecretSourceWarningsForTests
} = require('../automation/safety/secret-source');

const { createTempWorkspace } = require('./test-helpers');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return lines;
}

function withEnv(overrides, fn) {
  const before = {};
  for (const key of Object.keys(overrides)) {
    before[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

// ---------------------------------------------------------------------------
// readSecretFromFile
// ---------------------------------------------------------------------------

test('readSecretFromFile returns value when file exists with mode 0600', () => {
  const ws = createTempWorkspace('secret-file-good-');
  try {
    const p = ws.path('api-token');
    fs.writeFileSync(p, 'my-secret-token\n', { mode: 0o600 });
    const result = readSecretFromFile(p, { name: 'CONNECT_API_TOKEN' });
    assert.ok(result, 'expected a value');
    assert.equal(result.value, 'my-secret-token');
    assert.equal(result.source, 'file');
  } finally {
    ws.cleanup();
  }
});

test('readSecretFromFile returns null for missing files (no throw)', () => {
  const ws = createTempWorkspace('secret-file-missing-');
  try {
    const result = readSecretFromFile(ws.path('does-not-exist'), { name: 'X' });
    assert.equal(result, null);
  } finally {
    ws.cleanup();
  }
});

test('readSecretFromFile refuses 0644 files and warns once', { skip: process.platform === 'win32' }, () => {
  _resetSecretSourceWarningsForTests();
  const ws = createTempWorkspace('secret-file-loose-');
  try {
    const p = ws.path('api-token');
    fs.writeFileSync(p, 'leaky-token', { mode: 0o644 });
    fs.chmodSync(p, 0o644); // belt-and-suspenders: Node sometimes ignores write mode

    const warnings = captureStderr(() => {
      const a = readSecretFromFile(p, { name: 'CONNECT_API_TOKEN' });
      const b = readSecretFromFile(p, { name: 'CONNECT_API_TOKEN' });
      assert.equal(a, null);
      assert.equal(b, null);
    });

    const refusals = warnings.filter((line) => line.includes('Refusing to load'));
    assert.equal(refusals.length, 1, 'should warn exactly once for the same path');
    assert.ok(refusals[0].includes('0644'));
    assert.ok(refusals[0].includes('chmod 600'), 'message should tell the operator how to fix it');
  } finally {
    ws.cleanup();
  }
});

test('readSecretFromFile trims trailing whitespace/newlines', () => {
  const ws = createTempWorkspace('secret-file-trim-');
  try {
    const p = ws.path('api-token');
    fs.writeFileSync(p, '  padded-token  \n\n', { mode: 0o600 });
    const result = readSecretFromFile(p, { name: 'X' });
    assert.equal(result.value, 'padded-token');
  } finally {
    ws.cleanup();
  }
});

test('readSecretFromFile returns null for empty file (mode-correct but no value)', () => {
  const ws = createTempWorkspace('secret-file-empty-');
  try {
    const p = ws.path('api-token');
    fs.writeFileSync(p, '   \n', { mode: 0o600 });
    const result = readSecretFromFile(p, { name: 'X' });
    assert.equal(result, null);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// readEnvCredential
// ---------------------------------------------------------------------------

test('readEnvCredential returns null when CONNECT_ALLOW_ENV_CREDENTIALS is unset', () => {
  _resetSecretSourceWarningsForTests();
  withEnv(
    { CONNECT_ALLOW_ENV_CREDENTIALS: undefined, TEST_SECRET: 'value-that-must-not-leak' },
    () => {
      const result = readEnvCredential('TEST_SECRET');
      assert.equal(result, null, 'env credential must be ignored by default');
    }
  );
});

test('readEnvCredential returns null when gate is set to a non-truthy value', () => {
  _resetSecretSourceWarningsForTests();
  for (const value of ['0', 'false', 'no', '', 'maybe']) {
    withEnv(
      { CONNECT_ALLOW_ENV_CREDENTIALS: value, TEST_SECRET: 'should-be-ignored' },
      () => {
        const result = readEnvCredential('TEST_SECRET');
        assert.equal(result, null, `gate=${JSON.stringify(value)} should not enable env`);
      }
    );
  }
});

test('readEnvCredential returns the value when gate=1 AND env has the var', () => {
  _resetSecretSourceWarningsForTests();
  withEnv(
    { CONNECT_ALLOW_ENV_CREDENTIALS: '1', TEST_SECRET: 'enabled-value' },
    () => {
      const result = readEnvCredential('TEST_SECRET');
      assert.ok(result);
      assert.equal(result.value, 'enabled-value');
      assert.equal(result.source, 'env');
    }
  );
});

test('readEnvCredential warns exactly once per env var when gate is on', () => {
  _resetSecretSourceWarningsForTests();
  withEnv(
    { CONNECT_ALLOW_ENV_CREDENTIALS: '1', TEST_SECRET: 'warned-value' },
    () => {
      const warnings = captureStderr(() => {
        for (let i = 0; i < 5; i += 1) {
          readEnvCredential('TEST_SECRET', { name: 'TEST_SECRET' });
        }
      });
      const escapeHatch = warnings.filter((line) => line.includes('Using TEST_SECRET from environment'));
      assert.equal(escapeHatch.length, 1, 'env-fallback warning should fire exactly once');
    }
  );
});

test('readEnvCredential accepts "true" and "yes" as gate values', () => {
  _resetSecretSourceWarningsForTests();
  for (const gateValue of ['true', 'TRUE', 'yes', 'YES']) {
    withEnv(
      { CONNECT_ALLOW_ENV_CREDENTIALS: gateValue, TEST_SECRET: `via-${gateValue}` },
      () => {
        const result = readEnvCredential('TEST_SECRET');
        assert.ok(result, `gate=${gateValue} should enable env`);
        assert.equal(result.value, `via-${gateValue}`);
      }
    );
  }
});

// ---------------------------------------------------------------------------
// resolveSecret (layered resolution)
// ---------------------------------------------------------------------------

test('resolveSecret: explicit CLI value wins over file and env', () => {
  _resetSecretSourceWarningsForTests();
  const ws = createTempWorkspace('resolve-secret-explicit-');
  try {
    const filePath = ws.path('api-token');
    fs.writeFileSync(filePath, 'from-file', { mode: 0o600 });

    withEnv(
      { CONNECT_ALLOW_ENV_CREDENTIALS: '1', CONNECT_API_TOKEN: 'from-env' },
      () => {
        const result = resolveSecret({
          name: 'CONNECT_API_TOKEN',
          explicit: 'from-cli',
          filePath,
          envVarName: 'CONNECT_API_TOKEN'
        });
        assert.equal(result.value, 'from-cli');
        assert.equal(result.source, 'cli');
      }
    );
  } finally {
    ws.cleanup();
  }
});

test('resolveSecret: file is next preferred source when explicit is empty', () => {
  _resetSecretSourceWarningsForTests();
  const ws = createTempWorkspace('resolve-secret-file-');
  try {
    const filePath = ws.path('api-token');
    fs.writeFileSync(filePath, 'from-file', { mode: 0o600 });

    withEnv(
      { CONNECT_ALLOW_ENV_CREDENTIALS: '1', CONNECT_API_TOKEN: 'from-env' },
      () => {
        const result = resolveSecret({
          name: 'CONNECT_API_TOKEN',
          explicit: '',
          filePath,
          envVarName: 'CONNECT_API_TOKEN'
        });
        assert.equal(result.value, 'from-file');
        assert.equal(result.source, 'file');
      }
    );
  } finally {
    ws.cleanup();
  }
});

test('resolveSecret: env is used only when explicit is empty AND file does not exist AND gate is on', () => {
  _resetSecretSourceWarningsForTests();
  const ws = createTempWorkspace('resolve-secret-env-');
  try {
    const filePath = ws.path('does-not-exist');
    withEnv(
      { CONNECT_ALLOW_ENV_CREDENTIALS: '1', CONNECT_API_TOKEN: 'from-env' },
      () => {
        const result = resolveSecret({
          name: 'CONNECT_API_TOKEN',
          explicit: '',
          filePath,
          envVarName: 'CONNECT_API_TOKEN'
        });
        assert.ok(result);
        assert.equal(result.value, 'from-env');
        assert.equal(result.source, 'env');
      }
    );
  } finally {
    ws.cleanup();
  }
});

test('resolveSecret: returns null when no source has a value', () => {
  _resetSecretSourceWarningsForTests();
  const ws = createTempWorkspace('resolve-secret-none-');
  try {
    const filePath = ws.path('does-not-exist');
    withEnv(
      { CONNECT_ALLOW_ENV_CREDENTIALS: undefined, CONNECT_API_TOKEN: undefined },
      () => {
        const result = resolveSecret({
          name: 'CONNECT_API_TOKEN',
          explicit: '',
          filePath,
          envVarName: 'CONNECT_API_TOKEN'
        });
        assert.equal(result, null);
      }
    );
  } finally {
    ws.cleanup();
  }
});

test('resolveSecret: env is NOT used when gate is off even if file is missing', () => {
  _resetSecretSourceWarningsForTests();
  const ws = createTempWorkspace('resolve-secret-env-locked-');
  try {
    const filePath = ws.path('does-not-exist');
    withEnv(
      { CONNECT_ALLOW_ENV_CREDENTIALS: undefined, CONNECT_API_TOKEN: 'unauthorized-env-value' },
      () => {
        const result = resolveSecret({
          name: 'CONNECT_API_TOKEN',
          explicit: '',
          filePath,
          envVarName: 'CONNECT_API_TOKEN'
        });
        assert.equal(result, null, 'env must be ignored without the gate, even when no other source has a value');
      }
    );
  } finally {
    ws.cleanup();
  }
});
