'use strict';

/**
 * storage/sqlite-inbox-repository.js
 *
 * SQLite backend for the `inbox_conversations` table.
 * Mirrors InboxStore's conversation objects stored in inbox.json.
 */

function safeParseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function conversationToRow(c) {
  return {
    conversation_urn:        c.conversationUrn,
    account_id:              c.accountId              || null,
    account_name:            c.accountName            || null,
    mailbox_urn:             c.mailboxUrn             || null,
    participant_profile_urn: c.participantProfileUrn  || null,
    participant_names_json:  JSON.stringify(Array.isArray(c.participantNames) ? c.participantNames : []),
    workflow_id:             c.workflowId             || null,
    workflow_name:           c.workflowName           || null,
    run_id:                  c.runId                  || null,
    prospect_id:             c.prospectId             || null,
    agent_id:                c.agentId                || null,
    agent_name:              c.agentName              || null,
    last_inbound_at:         Number(c.lastInboundAt)  || 0,
    last_outbound_at:        Number(c.lastOutboundAt) || 0,
    status:                  c.status                 || 'active',
    intent_label:            c.intentLabel            || null,
    last_message_preview:    c.lastMessagePreview     || null,
    messages_json:           JSON.stringify(Array.isArray(c.messages) ? c.messages : []),
    created_at:              c.createdAt              || new Date().toISOString(),
    updated_at:              c.updatedAt              || new Date().toISOString()
  };
}

function rowToConversation(row) {
  return {
    conversationUrn:       row.conversation_urn,
    accountId:             row.account_id              || null,
    accountName:           row.account_name            || null,
    mailboxUrn:            row.mailbox_urn             || null,
    participantProfileUrn: row.participant_profile_urn || null,
    participantNames:      safeParseJson(row.participant_names_json, []),
    workflowId:            row.workflow_id             || null,
    workflowName:          row.workflow_name           || null,
    runId:                 row.run_id                  || null,
    prospectId:            row.prospect_id             || null,
    agentId:               row.agent_id                || null,
    agentName:             row.agent_name              || null,
    lastInboundAt:         Number(row.last_inbound_at)  || 0,
    lastOutboundAt:        Number(row.last_outbound_at) || 0,
    status:                row.status                  || 'active',
    intentLabel:           row.intent_label            || null,
    lastMessagePreview:    row.last_message_preview    || null,
    messages:              safeParseJson(row.messages_json, []),
    createdAt:             row.created_at,
    updatedAt:             row.updated_at
  };
}

class SqliteInboxRepository {
  constructor(db) {
    this._db = db;
  }

  /** @returns {object|null} */
  findByUrn(conversationUrn) {
    const row = this._db
      .prepare('SELECT * FROM inbox_conversations WHERE conversation_urn = ?')
      .get(conversationUrn);
    return row ? rowToConversation(row) : null;
  }

  /**
   * @param {object} [filters]
   * @param {string} [filters.accountId]
   * @param {string} [filters.workflowId]
   * @param {string[]} [filters.statuses]
   * @returns {object[]}
   */
  findAll(filters = {}) {
    const conditions = [];
    const params = [];

    if (filters.accountId) {
      conditions.push('account_id = ?');
      params.push(filters.accountId);
    }
    if (filters.statuses && filters.statuses.length) {
      conditions.push(`status IN (${filters.statuses.map(() => '?').join(', ')})`);
      params.push(...filters.statuses);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this._db
      .prepare(`SELECT * FROM inbox_conversations ${where} ORDER BY last_inbound_at DESC`)
      .all(...params);

    let conversations = rows.map(rowToConversation);

    // workflowId filter requires post-filter (stored as a scalar column)
    if (filters.workflowId) {
      conversations = conversations.filter((c) => c.workflowId === filters.workflowId);
    }
    return conversations;
  }

  /** Insert or update a conversation row. */
  upsert(conversation) {
    const row = conversationToRow(conversation);
    this._db.prepare(`
      INSERT INTO inbox_conversations (
        conversation_urn, account_id, account_name,
        mailbox_urn, participant_profile_urn, participant_names_json,
        workflow_id, workflow_name, run_id, prospect_id,
        agent_id, agent_name,
        last_inbound_at, last_outbound_at,
        status, intent_label, last_message_preview, messages_json,
        created_at, updated_at
      ) VALUES (
        @conversation_urn, @account_id, @account_name,
        @mailbox_urn, @participant_profile_urn, @participant_names_json,
        @workflow_id, @workflow_name, @run_id, @prospect_id,
        @agent_id, @agent_name,
        @last_inbound_at, @last_outbound_at,
        @status, @intent_label, @last_message_preview, @messages_json,
        @created_at, @updated_at
      )
      ON CONFLICT(conversation_urn) DO UPDATE SET
        account_id              = excluded.account_id,
        account_name            = excluded.account_name,
        mailbox_urn             = excluded.mailbox_urn,
        participant_profile_urn = excluded.participant_profile_urn,
        participant_names_json  = excluded.participant_names_json,
        workflow_id             = excluded.workflow_id,
        workflow_name           = excluded.workflow_name,
        run_id                  = excluded.run_id,
        prospect_id             = excluded.prospect_id,
        agent_id                = excluded.agent_id,
        agent_name              = excluded.agent_name,
        last_inbound_at         = excluded.last_inbound_at,
        last_outbound_at        = excluded.last_outbound_at,
        status                  = excluded.status,
        intent_label            = excluded.intent_label,
        last_message_preview    = excluded.last_message_preview,
        messages_json           = excluded.messages_json,
        created_at              = COALESCE(inbox_conversations.created_at, excluded.created_at),
        updated_at              = excluded.updated_at
    `).run(row);
  }

  /** Total count — used for idempotency guard in importer. */
  count() {
    return this._db
      .prepare('SELECT COUNT(*) AS n FROM inbox_conversations')
      .get().n;
  }

  /** Bulk-upsert an array of conversations inside a single transaction. */
  importLegacy(conversations) {
    const doImport = this._db.transaction(() => {
      for (const c of conversations) {
        this.upsert(c);
      }
    });
    doImport();
  }
}

module.exports = SqliteInboxRepository;
