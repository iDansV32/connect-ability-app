'use strict';

/**
 * storage/repository.js — storage-backend interface (scaffold from Ticket 3)
 *
 * Defines the method contract each repository must satisfy and provides a
 * factory `createStorageRepository(db)` that returns NOT_IMPLEMENTED stubs
 * for every method.  Ticket 4 replaces each stub with actual SQL.
 *
 * Architecture overview
 * ─────────────────────
 *
 *  ┌─────────────────────┐
 *  │   store modules      │  WorkflowRunManager, ProspectQueueStore, …
 *  │   (current owners)   │
 *  └────────┬────────────┘
 *           │  today: calls readJsonFile / writeJsonFileAtomic directly
 *           │  after Ticket 4: calls methods on StorageRepository
 *           ▼
 *  ┌─────────────────────┐
 *  │  StorageRepository   │  createStorageRepository(db) — this file
 *  │  (interface / seam)  │
 *  └────────┬────────────┘
 *           │  Ticket 4: SQLite implementation
 *           ▼
 *  ┌─────────────────────┐
 *  │  better-sqlite3 db   │  opened by storage/sqlite-db.js
 *  └─────────────────────┘
 *
 * Each sub-repository (workflowRuns, workflowJobs, …) mirrors the access
 * patterns of its corresponding store class so the migration diff is minimal.
 *
 * Naming convention
 * ─────────────────
 *  insert(record)           — create a new row, return the normalised record
 *  update(id, fields)       — partial update by primary key, return updated record or null
 *  upsert(record)           — insert-or-replace by natural key
 *  findById(id)             — return one record or null
 *  findAll(filters?)        — return array (sorted newest-first unless noted)
 *  findByXxx(value)         — targeted lookup helpers
 */

// Sentinel used by stubs — unique symbol so callers can distinguish
// NOT_IMPLEMENTED from a legitimate null return.
const NOT_IMPLEMENTED = Symbol('NOT_IMPLEMENTED');

/**
 * Throw a consistent error for any stub that is called before Ticket 4
 * fills in the implementation.
 *
 * @param {string} repo   Sub-repository name (e.g. 'workflowRuns')
 * @param {string} method Method name (e.g. 'insert')
 */
function notImplemented(repo, method) {
  throw new Error(
    `StorageRepository.${repo}.${method} is not implemented yet. ` +
    `Complete Ticket 4 (SQLite migration) to use this method.`
  );
}

// ---------------------------------------------------------------------------
// workflowRuns
// ---------------------------------------------------------------------------

/**
 * @typedef {object} WorkflowRunRecord
 * @property {string}   id
 * @property {string}   [workflowId]
 * @property {string}   [workflowName]
 * @property {string}   [accountId]
 * @property {string}   [accountName]
 * @property {string}   [agentId]
 * @property {string}   [agentName]
 * @property {string}   [campaignRunId]
 * @property {string}   status         — queued|running|waiting|completed|failed|paused|cancelled
 * @property {Array}    steps
 * @property {Array}    targets
 * @property {object}   summary
 * @property {string}   createdAt
 * @property {string}   updatedAt
 * @property {string}   [completedAt]
 */

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {object}  workflowRuns sub-repository
 */
function createWorkflowRunsRepo(db) {
  return {
    /** @param {WorkflowRunRecord} run @returns {WorkflowRunRecord} */
    insert(run) { return notImplemented('workflowRuns', 'insert'); },

    /**
     * Partial update.  Only the supplied fields are changed.
     * @param {string} id
     * @param {object} fields
     * @returns {WorkflowRunRecord|null}
     */
    update(id, fields) { return notImplemented('workflowRuns', 'update'); },

    /** @param {string} id @returns {WorkflowRunRecord|null} */
    findById(id) { return notImplemented('workflowRuns', 'findById'); },

    /** @returns {WorkflowRunRecord[]} newest-first */
    findAll() { return notImplemented('workflowRuns', 'findAll'); },

    /**
     * Recompute and persist the derived run status from its jobs.
     * Mirrors WorkflowRunManager.refreshRunStatus.
     * @param {string} id
     * @returns {WorkflowRunRecord|null}
     */
    refreshStatus(id) { return notImplemented('workflowRuns', 'refreshStatus'); }
  };
}

// ---------------------------------------------------------------------------
// workflowJobs
// ---------------------------------------------------------------------------

/**
 * @typedef {object} WorkflowJobRecord
 * @property {string}  id
 * @property {string}  runId
 * @property {string}  targetId
 * @property {string}  [prospectId]
 * @property {number}  stepIndex
 * @property {string}  stepType
 * @property {object}  step
 * @property {string}  status   — queued|running|completed|failed|paused|cancelled
 * @property {number}  attempts
 * @property {string}  scheduledFor
 * @property {string}  createdAt
 * @property {string}  updatedAt
 */

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {object}  workflowJobs sub-repository
 */
function createWorkflowJobsRepo(db) {
  return {
    /** @param {WorkflowJobRecord} job @returns {WorkflowJobRecord} */
    insert(job) { return notImplemented('workflowJobs', 'insert'); },

    /** @param {string} id @param {object} fields @returns {WorkflowJobRecord|null} */
    update(id, fields) { return notImplemented('workflowJobs', 'update'); },

    /** @param {string} id @returns {WorkflowJobRecord|null} */
    findById(id) { return notImplemented('workflowJobs', 'findById'); },

    /** @param {string} runId @returns {WorkflowJobRecord[]} scheduledFor-asc */
    findByRunId(runId) { return notImplemented('workflowJobs', 'findByRunId'); },

    /**
     * Claim up to `limit` jobs that are due now and not blocked.
     * Mirrors WorkflowRunManager.claimDueJobs.
     *
     * @param {object} opts
     * @param {string}   opts.before            ISO timestamp upper bound for scheduledFor
     * @param {number}   [opts.limit=1]          Max jobs to claim
     * @param {number}   [opts.leaseMs]          Lease duration in ms
     * @param {string}   [opts.leaseOwner]
     * @param {string[]} [opts.blockedAccountIds]
     * @param {string[]} [opts.blockedRunIds]
     * @param {Map}      [opts.prospectScores]
     * @returns {WorkflowJobRecord[]}
     */
    claimDue(opts) { return notImplemented('workflowJobs', 'claimDue'); },

    /**
     * Transition a running job to queued with a future scheduledFor.
     * Mirrors WorkflowRunManager.retryJob.
     * Returns null when max attempts exceeded.
     * @param {string} id
     * @param {object} opts
     * @param {string} [opts.reason]
     * @param {number} [opts.delayMs]
     * @returns {WorkflowJobRecord|null}
     */
    retry(id, opts) { return notImplemented('workflowJobs', 'retry'); },

    /** @param {string} id @param {object} result @returns {WorkflowJobRecord|null} */
    complete(id, result) { return notImplemented('workflowJobs', 'complete'); },

    /**
     * @param {string} id
     * @param {object} error
     * @param {object} [opts]
     * @param {boolean} [opts.cancelled=false]
     * @returns {WorkflowJobRecord|null}
     */
    fail(id, error, opts) { return notImplemented('workflowJobs', 'fail'); },

    /**
     * Heartbeat — extend the lease on a running job.
     * @param {string} id
     * @param {object} opts
     * @returns {WorkflowJobRecord|null}
     */
    heartbeat(id, opts) { return notImplemented('workflowJobs', 'heartbeat'); }
  };
}

// ---------------------------------------------------------------------------
// prospects
// ---------------------------------------------------------------------------

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {object}  prospects sub-repository
 */
function createProspectsRepo(db) {
  return {
    /**
     * Insert-or-update by profile URL + agent combination.
     * Mirrors ProspectQueueStore.upsertProspect.
     * @param {object} input
     * @returns {object}  normalised prospect record
     */
    upsert(input) { return notImplemented('prospects', 'upsert'); },

    /** @param {string} id @returns {object|null} */
    findById(id) { return notImplemented('prospects', 'findById'); },

    /** @param {object} [filters] @returns {object[]} newest-updated-first */
    findAll(filters) { return notImplemented('prospects', 'findAll'); },

    /**
     * Write lead scores in bulk without touching other fields.
     * Mirrors ProspectQueueStore.applyLeadScores.
     * @param {Array<{id:string, score:number, scoreBreakdown:object}>} entries
     * @returns {object[]}  updated prospect records
     */
    applyLeadScores(entries) { return notImplemented('prospects', 'applyLeadScores'); },

    /**
     * Mark a prospect as archived + do-not-contact.
     * Mirrors ProspectQueueStore.archiveProspect.
     * @param {string} id
     * @param {object} [opts]
     * @returns {object|null}
     */
    archive(id, opts) { return notImplemented('prospects', 'archive'); }
  };
}

// ---------------------------------------------------------------------------
// activityEvents
// ---------------------------------------------------------------------------

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {object}  activityEvents sub-repository
 */
function createActivityEventsRepo(db) {
  return {
    /**
     * Append one event.  Mirrors ActivityEventStore.append.
     * @param {object} event
     * @returns {object}  normalised event
     */
    append(event) { return notImplemented('activityEvents', 'append'); },

    /**
     * Aggregate step outcomes for analytics.
     * Mirrors activity-analytics.js getStepOutcomeBreakdown.
     * @param {object} [filters]  { accountId, agentId, since, until }
     * @returns {object}  breakdown result
     */
    getStepOutcomeBreakdown(filters) { return notImplemented('activityEvents', 'getStepOutcomeBreakdown'); },

    /**
     * Page-friendly raw event fetch.
     * @param {object} [filters]
     * @returns {object[]}
     */
    findAll(filters) { return notImplemented('activityEvents', 'findAll'); }
  };
}

// ---------------------------------------------------------------------------
// linkedInAccountHealth
// ---------------------------------------------------------------------------

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {object}  linkedInAccountHealth sub-repository
 */
function createLinkedInAccountHealthRepo(db) {
  return {
    /** @param {string} accountId @param {string} subsystem @returns {object|null} */
    findByKey(accountId, subsystem) { return notImplemented('linkedInAccountHealth', 'findByKey'); },

    /** @returns {object}  map of accountId → health state */
    findAll() { return notImplemented('linkedInAccountHealth', 'findAll'); },

    /**
     * Insert-or-update by (account_id, subsystem).
     * @param {string} accountId
     * @param {string} subsystem
     * @param {object} fields
     * @returns {object}
     */
    upsert(accountId, subsystem, fields) { return notImplemented('linkedInAccountHealth', 'upsert'); },

    /** @param {string} subsystem @returns {string[]}  accountIds currently in cooldown */
    getCoolingDownIds(subsystem) { return notImplemented('linkedInAccountHealth', 'getCoolingDownIds'); },

    /** @returns {string[]}  accountIds with an active challenge */
    getChallengedIds() { return notImplemented('linkedInAccountHealth', 'getChallengedIds'); }
  };
}

// ---------------------------------------------------------------------------
// transportHealth
// ---------------------------------------------------------------------------

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {object}  transportHealth sub-repository
 */
function createTransportHealthRepo(db) {
  return {
    /**
     * @param {string} transport
     * @param {string} action
     * @param {string} accountEmail
     * @returns {object|null}
     */
    findByKey(transport, action, accountEmail) { return notImplemented('transportHealth', 'findByKey'); },

    /**
     * Insert-or-update by (transport, action, account_email).
     * @param {string} transport
     * @param {string} action
     * @param {string} accountEmail
     * @param {object} fields
     * @returns {object}
     */
    upsert(transport, action, accountEmail, fields) { return notImplemented('transportHealth', 'upsert'); }
  };
}

// ---------------------------------------------------------------------------
// notifications
// ---------------------------------------------------------------------------

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {object}  notifications sub-repository
 */
function createNotificationsRepo(db) {
  return {
    /** @param {object} notification @returns {object} */
    insert(notification) { return notImplemented('notifications', 'insert'); },

    /** @param {string} id @param {object} fields @returns {object|null} */
    update(id, fields) { return notImplemented('notifications', 'update'); },

    /** @param {string} id @returns {object|null} */
    findById(id) { return notImplemented('notifications', 'findById'); },

    /**
     * @param {object} [filters]  { accountId, unreadOnly }
     * @returns {object[]}
     */
    findAll(filters) { return notImplemented('notifications', 'findAll'); },

    /**
     * Mark a notification as read.
     * @param {string} id
     * @returns {object|null}
     */
    markRead(id) { return notImplemented('notifications', 'markRead'); },

    /**
     * Mark all unread notifications read, optionally scoped to an account.
     * @param {object} [filters]  { accountId }
     * @returns {number}  rows updated
     */
    markAllRead(filters) { return notImplemented('notifications', 'markAllRead'); }
  };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a StorageRepository from an open better-sqlite3 `db` handle.
 *
 * All sub-repositories share the same `db` instance so transactions that
 * span multiple tables can be wrapped with `db.transaction(fn)()` by the
 * caller (e.g. WorkflowRunManager writing jobs + runs atomically in Ticket 4).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{
 *   db:                     import('better-sqlite3').Database,
 *   workflowRuns:           ReturnType<typeof createWorkflowRunsRepo>,
 *   workflowJobs:           ReturnType<typeof createWorkflowJobsRepo>,
 *   prospects:              ReturnType<typeof createProspectsRepo>,
 *   activityEvents:         ReturnType<typeof createActivityEventsRepo>,
 *   linkedInAccountHealth:  ReturnType<typeof createLinkedInAccountHealthRepo>,
 *   transportHealth:        ReturnType<typeof createTransportHealthRepo>,
 *   notifications:          ReturnType<typeof createNotificationsRepo>
 * }}
 */
function createStorageRepository(db) {
  return {
    /** Raw db handle — for transactions that span sub-repositories */
    db,

    workflowRuns:          createWorkflowRunsRepo(db),
    workflowJobs:          createWorkflowJobsRepo(db),
    prospects:             createProspectsRepo(db),
    activityEvents:        createActivityEventsRepo(db),
    linkedInAccountHealth: createLinkedInAccountHealthRepo(db),
    transportHealth:       createTransportHealthRepo(db),
    notifications:         createNotificationsRepo(db)
  };
}

module.exports = {
  NOT_IMPLEMENTED,
  createStorageRepository
};
