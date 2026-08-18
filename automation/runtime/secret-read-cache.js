'use strict';

/**
 * Small process-local cache for secrets that have already been loaded into a
 * long-lived runtime. It also coalesces concurrent reads so native credential
 * stores are never asked for the same value twice at the same time.
 */
class SecretReadCache {
  constructor() {
    this.values = new Map();
    this.pending = new Map();
    this.generations = new Map();
  }

  get(key) {
    const normalizedKey = String(key || '').trim();
    return normalizedKey && this.values.has(normalizedKey)
      ? this.values.get(normalizedKey)
      : undefined;
  }

  set(key, value) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return value;
    this.values.set(normalizedKey, value);
    return value;
  }

  delete(key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return false;
    this.generations.set(normalizedKey, (this.generations.get(normalizedKey) || 0) + 1);
    this.pending.delete(normalizedKey);
    return this.values.delete(normalizedKey);
  }

  clear() {
    const keys = new Set([...this.values.keys(), ...this.pending.keys()]);
    for (const key of keys) this.delete(key);
  }

  async getOrLoad(key, loader) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return loader();

    if (this.values.has(normalizedKey)) {
      return this.values.get(normalizedKey);
    }
    if (this.pending.has(normalizedKey)) {
      return this.pending.get(normalizedKey);
    }

    const generation = this.generations.get(normalizedKey) || 0;
    const pendingRead = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (value != null && (this.generations.get(normalizedKey) || 0) === generation) {
          this.values.set(normalizedKey, value);
        }
        return value;
      })
      .finally(() => {
        if (this.pending.get(normalizedKey) === pendingRead) {
          this.pending.delete(normalizedKey);
        }
      });

    this.pending.set(normalizedKey, pendingRead);
    return pendingRead;
  }
}

module.exports = { SecretReadCache };
