'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SecretReadCache } = require('../automation/runtime/secret-read-cache');

test('reuses a resolved secret without calling the native loader again', async () => {
  const cache = new SecretReadCache();
  let reads = 0;
  const loader = async () => {
    reads += 1;
    return 'secret';
  };

  assert.equal(await cache.getOrLoad('account-1', loader), 'secret');
  assert.equal(await cache.getOrLoad('account-1', loader), 'secret');
  assert.equal(reads, 1);
});

test('coalesces concurrent reads for the same account', async () => {
  const cache = new SecretReadCache();
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loader = async () => {
    reads += 1;
    await gate;
    return 'secret';
  };

  const first = cache.getOrLoad('account-1', loader);
  const second = cache.getOrLoad('account-1', loader);
  release();

  assert.deepEqual(await Promise.all([first, second]), ['secret', 'secret']);
  assert.equal(reads, 1);
});

test('invalidation prevents an in-flight stale read from repopulating the cache', async () => {
  const cache = new SecretReadCache();
  let release;
  const staleRead = cache.getOrLoad('account-1', () => new Promise((resolve) => { release = resolve; }));

  await Promise.resolve();
  cache.delete('account-1');
  release('old-secret');
  assert.equal(await staleRead, 'old-secret');
  assert.equal(cache.get('account-1'), undefined);

  assert.equal(await cache.getOrLoad('account-1', async () => 'new-secret'), 'new-secret');
});
