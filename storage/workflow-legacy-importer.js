'use strict';

/**
 * storage/workflow-legacy-importer.js
 *
 * One-time migration from legacy JSON files into SQLite for workflow_runs
 * and workflow_jobs.
 *
 * Idempotency: if either table already contains rows, the import is skipped
 * and { imported: false } is returned.
 *
 * Atomicity: all rows are inserted in a single SQLite transaction.  If any
 * INSERT fails the entire transaction is rolled back — no partial state.
 *
 * Legacy JSON files are NOT deleted (Ticket 4B constraint).  They remain as
 * a fallback / audit trail until an explicit clean-up ticket.
 */

const { readJsonFile } = require('../connect-documents');
const SqliteWorkflowRepository = require('./sqlite-workflow-repository');

/**
 * Import workflow runs and jobs from legacy JSON into the SQLite database.
 *
 * @param {import('better-sqlite3').Database} db      Open SQLite db handle
 * @param {{ runsPath: string, jobsPath: string }} paths  Legacy JSON file paths
 * @returns {{ imported: boolean, runsCount?: number, jobsCount?: number, reason?: string }}
 */
function importLegacyWorkflowData(db, { runsPath, jobsPath } = {}) {
  if (!runsPath || !jobsPath) {
    throw new Error('importLegacyWorkflowData requires runsPath and jobsPath');
  }

  // Idempotency guard — skip if either table already has rows
  const existingRuns = db.prepare('SELECT COUNT(*) AS cnt FROM workflow_runs').get().cnt;
  const existingJobs = db.prepare('SELECT COUNT(*) AS cnt FROM workflow_jobs').get().cnt;

  if (existingRuns > 0 || existingJobs > 0) {
    return { imported: false, reason: 'tables already have data' };
  }

  // Read legacy JSON files (safe fallback to empty stores if files are absent)
  const runsStore = readJsonFile(runsPath, { runs: [] });
  const jobsStore = readJsonFile(jobsPath, { jobs: [] });

  const runs = Array.isArray(runsStore.runs) ? runsStore.runs : [];
  const jobs = Array.isArray(jobsStore.jobs) ? jobsStore.jobs : [];

  if (runs.length === 0 && jobs.length === 0) {
    return { imported: false, reason: 'no legacy data to import' };
  }

  // Reuse the repository's transact() so all row-conversion logic is in one place.
  // transact() loads both stores (empty at this point), the fn pushes all legacy
  // records, then transact() upserts everything in a single SQLite transaction.
  const repo = new SqliteWorkflowRepository(db);
  repo.transact((runsInStore, jobsInStore) => {
    for (const run of runs) { runsInStore.runs.push(run); }
    for (const job of jobs) { jobsInStore.jobs.push(job); }
  });

  return { imported: true, runsCount: runs.length, jobsCount: jobs.length };
}

module.exports = { importLegacyWorkflowData };
