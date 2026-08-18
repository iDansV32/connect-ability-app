'use strict';

/**
 * storage/sqlite-account-health-repository.js
 *
 * SQLite backend for the linkedin_account_health table.
 *
 * Row layout (UNIQUE on account_id, subsystem):
 *   subsystem = 'workflow'      — workflow-subsystem health fields
 *   subsystem = 'replyMonitor'  — reply-monitor-subsystem health fields
 *   subsystem = '_account'      — account-level challenge state
 *
 * Public API
 *   upsertSubsystem(accountId, subsystem, state)  — upsert one subsystem row
 *   upsertChallenge(accountId, challenged, now)    — upsert _account row
 *   readAll()                                      — reconstruct accounts map
 *   importLegacy(accountsMap)                      — bulk import (idempotent guard in caller)
 */

const SUBSYSTEMS = ['workflow', 'replyMonitor'];

class SqliteAccountHealthRepository {
  constructor(db) {
    this.db = db;
    this._prep();
  }

  _prep() {
    this._stmtUpsert = this.db.prepare(`
      INSERT INTO linkedin_account_health (
        account_id, subsystem, health_status, consecutive_failures,
        last_success_at, last_failure_at, last_failure_reason,
        cooldown_until, cooldown_reason,
        challenged, challenge_type, challenge_detected_at, challenge_resolved_at,
        updated_at
      ) VALUES (
        @account_id, @subsystem, @health_status, @consecutive_failures,
        @last_success_at, @last_failure_at, @last_failure_reason,
        @cooldown_until, @cooldown_reason,
        @challenged, @challenge_type, @challenge_detected_at, @challenge_resolved_at,
        @updated_at
      ) ON CONFLICT (account_id, subsystem) DO UPDATE SET
        health_status         = excluded.health_status,
        consecutive_failures  = excluded.consecutive_failures,
        last_success_at       = excluded.last_success_at,
        last_failure_at       = excluded.last_failure_at,
        last_failure_reason   = excluded.last_failure_reason,
        cooldown_until        = excluded.cooldown_until,
        cooldown_reason       = excluded.cooldown_reason,
        challenged            = excluded.challenged,
        challenge_type        = excluded.challenge_type,
        challenge_detected_at = excluded.challenge_detected_at,
        challenge_resolved_at = excluded.challenge_resolved_at,
        updated_at            = excluded.updated_at
    `);

    this._stmtFindAll = this.db.prepare(
      'SELECT * FROM linkedin_account_health ORDER BY account_id, subsystem'
    );
  }

  upsertSubsystem(accountId, subsystem, state) {
    this._stmtUpsert.run(subsystemStateToRow(accountId, subsystem, state));
  }

  upsertChallenge(accountId, challenged) {
    const now = new Date().toISOString();
    this._stmtUpsert.run({
      account_id:           accountId,
      subsystem:            '_account',
      health_status:        challenged ? 'challenged' : 'healthy',
      consecutive_failures: 0,
      last_success_at:      null,
      last_failure_at:      null,
      last_failure_reason:  null,
      cooldown_until:       null,
      cooldown_reason:      null,
      challenged:           challenged ? 1 : 0,
      challenge_type:       challenged ? (challenged.type || 'unknown') : null,
      challenge_detected_at: challenged ? (challenged.at || now) : null,
      challenge_resolved_at: null,
      updated_at:            now
    });
  }

  /** Reconstruct the accounts map in the same shape used by LinkedInAccountHealthStore. */
  readAll() {
    const rows = this._stmtFindAll.all();
    return rowsToAccountsMap(rows);
  }

  /** Bulk import from the existing JSON store's accounts object. One transaction. */
  importLegacy(accountsMap) {
    const doImport = this.db.transaction(() => {
      for (const [accountId, accountState] of Object.entries(accountsMap || {})) {
        for (const subsystem of SUBSYSTEMS) {
          const subState = accountState[subsystem];
          if (subState) {
            this.upsertSubsystem(accountId, subsystem, subState);
          }
        }
        this.upsertChallenge(accountId, accountState.challenged || null);
      }
    });
    doImport();
  }
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function subsystemStateToRow(accountId, subsystem, state) {
  return {
    account_id:           accountId,
    subsystem,
    health_status:        state.status || 'healthy',
    consecutive_failures: Math.max(0, Number(state.consecutiveFailures) || 0),
    last_success_at:      state.lastSuccessAt  || null,
    last_failure_at:      state.lastErrorAt    || null,
    last_failure_reason:  state.lastError      || null,
    cooldown_until:       state.cooldownUntil  || null,
    cooldown_reason:      state.cooldownReason || null,
    challenged:           0,
    challenge_type:       null,
    challenge_detected_at: null,
    challenge_resolved_at: null,
    updated_at:           state.lastUpdatedAt || new Date().toISOString()
  };
}

function rowsToAccountsMap(rows) {
  const accounts = {};

  for (const row of rows) {
    const accountId = row.account_id;
    if (!accounts[accountId]) {
      accounts[accountId] = { updatedAt: null };
    }

    if (row.subsystem === '_account') {
      accounts[accountId].challenged = row.challenged
        ? {
            at:     row.challenge_detected_at || null,
            type:   row.challenge_type || 'unknown',
            source: null
          }
        : null;
      if (row.updated_at) {
        accounts[accountId].updatedAt = row.updated_at;
      }
    } else {
      accounts[accountId][row.subsystem] = {
        status:              row.health_status || 'healthy',
        lastSuccessAt:       row.last_success_at    || null,
        lastErrorAt:         row.last_failure_at    || null,
        lastError:           row.last_failure_reason || null,
        consecutiveFailures: Number(row.consecutive_failures) || 0,
        cooldownUntil:       row.cooldown_until  || null,
        cooldownReason:      row.cooldown_reason || null,
        lastUpdatedAt:       row.updated_at      || null
      };
      if (!accounts[accountId].updatedAt) {
        accounts[accountId].updatedAt = row.updated_at || null;
      }
    }
  }

  return accounts;
}

module.exports = SqliteAccountHealthRepository;
