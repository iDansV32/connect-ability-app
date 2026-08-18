'use strict';

/**
 * storage/sqlite-activity-event-repository.js
 *
 * SQLite backend for the activity_events table.
 *
 * Public API
 *   append(event)          — INSERT OR IGNORE one normalised event
 *   findAll(filters?)      — SELECT with optional WHERE, newest-first
 *   importLegacy(events)   — bulk INSERT in one transaction (idempotent: guard in caller)
 *   pruneRetainedRawEvents — DELETE retained raw event families older than a cutoff
 */

class SqliteActivityEventRepository {
  constructor(db) {
    this.db = db;
    this._prep();
  }

  _prep() {
    this._stmtInsert = this.db.prepare(`
      INSERT OR IGNORE INTO activity_events (
        id, event_type, event_timestamp, account_id, account_name,
        agent_id, agent_name, workflow_id, workflow_name, run_id,
        target_id, prospect_id, target_value, profile_url,
        correlation_id, root_correlation_id, event_status, metadata_json
      ) VALUES (
        @id, @event_type, @event_timestamp, @account_id, @account_name,
        @agent_id, @agent_name, @workflow_id, @workflow_name, @run_id,
        @target_id, @prospect_id, @target_value, @profile_url,
        @correlation_id, @root_correlation_id, @event_status, @metadata_json
      )
    `);
  }

  append(event) {
    this._stmtInsert.run(eventToRow(event));
    return event;
  }

  importLegacy(events) {
    const insert = this.db.transaction(() => {
      for (const event of events) {
        this._stmtInsert.run(eventToRow(event));
      }
    });
    insert();
    return events.length;
  }

  /** Return events newest-first, with optional server-side filtering. */
  findAll(filters = {}) {
    const { sql, params } = buildFindAllQuery(filters);
    return this.db.prepare(sql).all(params).map(rowToEvent);
  }

  pruneRetainedRawEvents(options = {}) {
    const retainedTypes = Array.isArray(options.retainedTypes) ? options.retainedTypes.filter(Boolean) : [];
    const retainedPrefixes = Array.isArray(options.retainedPrefixes) ? options.retainedPrefixes.filter(Boolean) : [];
    const cutoffIso = String(options.cutoffIso || '').trim();

    if (!cutoffIso || (retainedTypes.length === 0 && retainedPrefixes.length === 0)) {
      return {
        pruned: false,
        removedCount: 0,
        invalidCount: 0
      };
    }

    const { sql, params } = buildPruneRetainedRawEventsQuery({
      cutoffIso,
      retainedTypes,
      retainedPrefixes
    });
    const result = this.db.prepare(sql).run(params);
    return {
      pruned: result.changes > 0,
      removedCount: result.changes,
      invalidCount: 0
    };
  }
}

// ---------------------------------------------------------------------------
// Row / object conversion
// ---------------------------------------------------------------------------

function eventToRow(event) {
  // Merge postId and any extra non-schema fields into metadata_json
  const metadata = { ...(event.metadata || {}) };
  if (event.postId) metadata.postId = event.postId;

  return {
    id:                  event.id,
    event_type:          event.type,
    event_timestamp:     event.timestamp,
    account_id:          event.accountId    || null,
    account_name:        event.accountName  || null,
    agent_id:            event.agentId      || null,
    agent_name:          event.agentName    || null,
    workflow_id:         event.workflowId   || null,
    workflow_name:       event.workflowName || null,
    run_id:              event.runId        || null,
    target_id:           event.targetId     || null,
    prospect_id:         event.prospectId   || null,
    target_value:        event.targetValue  || null,
    profile_url:         event.profileUrl   || null,
    correlation_id:      event.correlationId      || null,
    root_correlation_id: event.rootCorrelationId  || null,
    event_status:        event.status       || 'ok',
    metadata_json:       JSON.stringify(metadata)
  };
}

function rowToEvent(row) {
  let metadata = {};
  try { metadata = JSON.parse(row.metadata_json || '{}'); } catch (_) {}

  return {
    id:               row.id,
    type:             row.event_type,
    timestamp:        row.event_timestamp,
    accountId:        row.account_id    || null,
    accountName:      row.account_name  || null,
    agentId:          row.agent_id      || null,
    agentName:        row.agent_name    || null,
    workflowId:       row.workflow_id   || null,
    workflowName:     row.workflow_name || null,
    runId:            row.run_id        || null,
    targetId:         row.target_id     || null,
    prospectId:       row.prospect_id   || null,
    targetValue:      row.target_value  || null,
    profileUrl:       row.profile_url   || null,
    correlationId:    row.correlation_id      || null,
    rootCorrelationId: row.root_correlation_id || null,
    postId:           metadata.postId   || null,
    status:           row.event_status  || 'ok',
    metadata
  };
}

function buildFindAllQuery(filters = {}) {
  const conditions = [];
  const params     = {};

  if (filters.accountId) {
    conditions.push('account_id = @account_id');
    params.account_id = filters.accountId;
  }
  if (filters.agentId) {
    conditions.push('agent_id = @agent_id');
    params.agent_id = filters.agentId;
  }
  if (filters.workflowId) {
    conditions.push('workflow_id = @workflow_id');
    params.workflow_id = filters.workflowId;
  }
  if (filters.since) {
    conditions.push('event_timestamp >= @since');
    params.since = filters.since;
  }
  if (filters.until) {
    conditions.push('event_timestamp <= @until');
    params.until = filters.until;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return {
    sql:    `SELECT * FROM activity_events ${where} ORDER BY event_timestamp DESC`,
    params
  };
}

function buildPruneRetainedRawEventsQuery(options = {}) {
  const conditions = [];
  const params = {
    cutoff: options.cutoffIso
  };

  (options.retainedTypes || []).forEach((type, index) => {
    const key = `type_${index}`;
    conditions.push(`event_type = @${key}`);
    params[key] = type;
  });

  (options.retainedPrefixes || []).forEach((prefix, index) => {
    const key = `prefix_${index}`;
    conditions.push(`event_type LIKE @${key}`);
    params[key] = `${prefix}%`;
  });

  return {
    sql: `DELETE FROM activity_events WHERE event_timestamp < @cutoff AND (${conditions.join(' OR ')})`,
    params
  };
}

module.exports = SqliteActivityEventRepository;
