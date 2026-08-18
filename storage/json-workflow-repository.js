'use strict';
/**
 * storage/json-workflow-repository.js
 *
 * JSON-backed persistence adapter for workflow runs and jobs.
 * This is the default backend for WorkflowRunManager (Ticket 4A).
 *
 * The SQLite backend (Ticket 4B) will replace this by implementing
 * the same interface: transact(fn), transactJobsOnly(fn), readRuns(), readJobs().
 *
 * transact(fn):
 *   - Reads both stores (runsStore, jobsStore) from disk
 *   - Calls fn(runsStore, jobsStore) — fn may mutate them in-place
 *   - Flushes jobsStore FIRST, then runsStore (safe crash order: avoids
 *     leaving a cancelled run with still-claimable queued jobs)
 *   - Returns the return value of fn
 *   - If fn throws, no files are written
 *
 * transactJobsOnly(fn):
 *   - Like transact but only reads/writes jobsStore (for heartbeatJob)
 *
 * readRuns(): returns runsStore object (no flush)
 * readJobs(): returns jobsStore object (no flush)
 */

const { readJsonFile, writeJsonFileAtomic } = require('../connect-documents');

const STORE_VERSION = 1;

class JsonWorkflowRepository {
  constructor({ runsPath, jobsPath } = {}) {
    if (!runsPath) throw new Error('JsonWorkflowRepository requires runsPath');
    if (!jobsPath) throw new Error('JsonWorkflowRepository requires jobsPath');
    this.runsPath = runsPath;
    this.jobsPath = jobsPath;
  }

  _readRunsStore() {
    const fallback = { version: STORE_VERSION, runs: [] };
    const store = readJsonFile(this.runsPath, fallback);
    return {
      version: STORE_VERSION,
      runs: Array.isArray(store.runs) ? store.runs : []
    };
  }

  _readJobsStore() {
    const fallback = { version: STORE_VERSION, jobs: [] };
    const store = readJsonFile(this.jobsPath, fallback);
    return {
      version: STORE_VERSION,
      jobs: Array.isArray(store.jobs) ? store.jobs : []
    };
  }

  /**
   * Read both stores, call fn(runsStore, jobsStore), flush jobs then runs,
   * and return fn's return value. If fn throws, no files are written.
   */
  transact(fn) {
    const runsStore = this._readRunsStore();
    const jobsStore = this._readJobsStore();
    const result = fn(runsStore, jobsStore);
    writeJsonFileAtomic(this.jobsPath, jobsStore);
    writeJsonFileAtomic(this.runsPath, runsStore);
    return result;
  }

  /**
   * Read only jobsStore, call fn(jobsStore), flush jobs only.
   * If fn throws, no files are written.
   */
  transactJobsOnly(fn) {
    const jobsStore = this._readJobsStore();
    const result = fn(jobsStore);
    writeJsonFileAtomic(this.jobsPath, jobsStore);
    return result;
  }

  /**
   * Return runsStore object without flushing (read-only access).
   */
  readRuns() {
    return this._readRunsStore();
  }

  /**
   * Return jobsStore object without flushing (read-only access).
   */
  readJobs() {
    return this._readJobsStore();
  }

  /**
   * Targeted-claim variant used by WorkflowRunManager.claimDueJobs. The JSON
   * backend has no scaling problem (small datasets), so this just delegates
   * to transact(). The SQLite backend overrides this with an indexed lookup
   * — see SqliteWorkflowRepository.transactDueJobs.
   */
  transactDueJobs(_options, fn) {
    return this.transact(fn);
  }
}

module.exports = JsonWorkflowRepository;
