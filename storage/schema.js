'use strict';

/**
 * storage/schema.js — Connect Ability SQLite schema (scaffold from Ticket 3)
 *
 * All DDL is expressed as `CREATE TABLE IF NOT EXISTS` so the statements are
 * idempotent and safe to re-run on every app startup.
 *
 * Design decisions worth noting:
 *
 *  • JSON columns (steps_json, targets_json, …)
 *    Compound objects that don't need to be queried field-by-field stay in JSON
 *    for now.  They can be normalised into child tables incrementally without
 *    a full schema rewrite.
 *
 *  • INTEGER PRIMARY KEY AUTOINCREMENT on health/transport rows
 *    These tables have natural composite-unique keys (account+subsystem,
 *    transport+action+email) but are addressed by upsert rather than by a
 *    stable external id, so a surrogate auto-increment is fine.
 *
 *  • TEXT timestamps (ISO-8601)
 *    All dates are stored as ISO-8601 strings to match the existing JSON
 *    layer.  Sorting by text works correctly for ISO-8601.
 *
 *  • Indexes
 *    A minimal set of read-path indexes is declared alongside each table.
 *    The scheduler hot-path only queries jobs by (status, scheduled_for,
 *    account_id), so that composite index is included from the start.
 */

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// workflow_runs
//
// Direct mapping of WorkflowRunManager's run records.
// The `targets` array (target state per enrollee) is kept in targets_json until
// Ticket 4 decides whether to break it into a child table.
// ---------------------------------------------------------------------------
const TABLE_WORKFLOW_RUNS = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  id                 TEXT    PRIMARY KEY,
  workflow_id        TEXT,
  workflow_name      TEXT,
  account_id         TEXT,
  account_name       TEXT,
  agent_id           TEXT,
  agent_name         TEXT,
  campaign_run_id    TEXT,
  run_status         TEXT    NOT NULL DEFAULT 'queued',
  target_type        TEXT,
  browser_profile    TEXT,
  steps_json         TEXT    NOT NULL DEFAULT '[]',
  targets_json       TEXT    NOT NULL DEFAULT '[]',
  summary_json       TEXT    NOT NULL DEFAULT '{}',
  correlation_id     TEXT,
  drain_pending      INTEGER NOT NULL DEFAULT 0,
  drain_reason       TEXT,
  drain_requested_at TEXT,
  drain_completed_at TEXT,
  last_error         TEXT,
  pause_reason       TEXT,
  headless           INTEGER NOT NULL DEFAULT 0,
  slow_mo            INTEGER NOT NULL DEFAULT 50,
  bypass_working_hours INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  completed_at       TEXT
)`;

const INDEX_WORKFLOW_RUNS_ACCOUNT = `
CREATE INDEX IF NOT EXISTS idx_workflow_runs_account_id
  ON workflow_runs (account_id)`;

const INDEX_WORKFLOW_RUNS_STATUS = `
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
  ON workflow_runs (run_status)`;

// ---------------------------------------------------------------------------
// workflow_jobs
//
// Direct mapping of WorkflowRunManager's step-job records.
// The composite index on (job_status, scheduled_for, account_id) mirrors the
// claimDueJobs hot-path filter/sort used by the durable scheduler.
// ---------------------------------------------------------------------------
const TABLE_WORKFLOW_JOBS = `
CREATE TABLE IF NOT EXISTS workflow_jobs (
  id                  TEXT    PRIMARY KEY,
  run_id              TEXT    NOT NULL REFERENCES workflow_runs (id),
  target_id           TEXT    NOT NULL,
  prospect_id         TEXT,
  target_value        TEXT,
  target_label        TEXT,
  target_index        INTEGER,
  step_index          INTEGER NOT NULL,
  step_type           TEXT    NOT NULL,
  step_json           TEXT    NOT NULL DEFAULT '{}',
  job_status          TEXT    NOT NULL DEFAULT 'queued',
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 3,
  scheduled_for       TEXT    NOT NULL,
  started_at          TEXT,
  completed_at        TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  lease_owner         TEXT,
  lease_expires_at    TEXT,
  last_heartbeat_at   TEXT,
  error_message       TEXT,
  result_json         TEXT,
  account_id          TEXT,
  account_name        TEXT,
  agent_id            TEXT,
  agent_name          TEXT,
  workflow_id         TEXT,
  workflow_name       TEXT,
  correlation_id      TEXT,
  root_correlation_id TEXT
)`;

// Hot-path: scheduler claims jobs ordered by (status, scheduled_for, account_id)
const INDEX_WORKFLOW_JOBS_CLAIM = `
CREATE INDEX IF NOT EXISTS idx_workflow_jobs_claim
  ON workflow_jobs (job_status, scheduled_for, account_id)`;

// claim_uuid: per-claim token verified by completeJob/failJob/heartbeatJob.
// Solves the stale-completion race where a worker hangs past lease expiry,
// the job gets reclaimed, the original worker eventually returns and
// overwrites the new claim's state. Each claim writes a fresh UUID; the
// dispatcher keeps it in closure for the lifetime of the round-trip. No
// index — the UUID is only compared as part of equality checks on rows
// already addressed by id.
const MIGRATE_WORKFLOW_JOBS_CLAIM_UUID = `
  ALTER TABLE workflow_jobs ADD COLUMN claim_uuid TEXT`;

// launch_source: provenance marker for a run. 'external_api' means the run was
// created via the Electron external HTTP API, which the worker treats as
// visible-only (fails closed if headless). NULL/other = native UI/automation,
// whose headless choice is honored. See external-api-safety.js +
// account-worker-process.js launch assertion.
const MIGRATE_WORKFLOW_RUNS_LAUNCH_SOURCE = `
  ALTER TABLE workflow_runs ADD COLUMN launch_source TEXT`;

// Manual UI launches are explicitly allowed to run immediately, regardless
// of the account's configured weekday/hour window. Persist the flag so a
// SQLite round-trip cannot silently turn a manual launch into a scheduled one.
const MIGRATE_WORKFLOW_RUNS_BYPASS_WORKING_HOURS = `
  ALTER TABLE workflow_runs ADD COLUMN bypass_working_hours INTEGER NOT NULL DEFAULT 0`;

const INDEX_WORKFLOW_JOBS_RUN = `
CREATE INDEX IF NOT EXISTS idx_workflow_jobs_run_id
  ON workflow_jobs (run_id)`;

// ---------------------------------------------------------------------------
// prospects
//
// Maps ProspectQueueStore records.
// Compliance fields (do_not_contact, unsubscribed_at) are first-class columns
// so they can be queried without JSON parsing.
// ---------------------------------------------------------------------------
const TABLE_PROSPECTS = `
CREATE TABLE IF NOT EXISTS prospects (
  id                      TEXT    PRIMARY KEY,
  agent_id                TEXT,
  account_id              TEXT,
  profile_url             TEXT,
  full_name               TEXT,
  headline                TEXT,
  company                 TEXT,
  prospect_state          TEXT    NOT NULL DEFAULT 'discovered',
  source                  TEXT,
  score                   INTEGER,
  score_updated_at        TEXT,
  score_breakdown_json    TEXT,
  workflow_assignment_json TEXT,
  metadata_json           TEXT,
  archived                INTEGER NOT NULL DEFAULT 0,
  do_not_contact          INTEGER NOT NULL DEFAULT 0,
  unsubscribed_at         TEXT,
  archive_reason          TEXT,
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL
)`;

const INDEX_PROSPECTS_AGENT = `
CREATE INDEX IF NOT EXISTS idx_prospects_agent_id
  ON prospects (agent_id)`;

const INDEX_PROSPECTS_DNC = `
CREATE INDEX IF NOT EXISTS idx_prospects_do_not_contact
  ON prospects (do_not_contact)`;

// Dedupe hot-path: find existing prospect by (account_id, normalized_profile_url)
const INDEX_PROSPECTS_NORMALIZED_URL = `
CREATE INDEX IF NOT EXISTS idx_prospects_normalized_url
  ON prospects (account_id, normalized_profile_url)
  WHERE normalized_profile_url IS NOT NULL`;

// Cross-account related-prospect lookups (getRelatedProspects / getContactOwnershipSummary)
const INDEX_PROSPECTS_RELATED_URL = `
CREATE INDEX IF NOT EXISTS idx_prospects_related_url
  ON prospects (normalized_profile_url)
  WHERE normalized_profile_url IS NOT NULL`;

// ---------------------------------------------------------------------------
// Prospect column migrations
// Applied with try/catch in applySchema (see sqlite-db.js) — safe to run on
// databases that already have these columns from the CREATE TABLE DDL.
// ---------------------------------------------------------------------------
const MIGRATE_PROSPECTS_ACCOUNT_NAME    = `ALTER TABLE prospects ADD COLUMN account_name TEXT`;
const MIGRATE_PROSPECTS_AGENT_NAME      = `ALTER TABLE prospects ADD COLUMN agent_name TEXT`;
const MIGRATE_PROSPECTS_NORMALIZED_URL  = `ALTER TABLE prospects ADD COLUMN normalized_profile_url TEXT`;
const MIGRATE_PROSPECTS_RAW_TARGET      = `ALTER TABLE prospects ADD COLUMN raw_target TEXT`;
const MIGRATE_PROSPECTS_SOURCE_ID       = `ALTER TABLE prospects ADD COLUMN source_id TEXT`;
const MIGRATE_PROSPECTS_SOURCE_LABEL    = `ALTER TABLE prospects ADD COLUMN source_label TEXT`;
const MIGRATE_PROSPECTS_SOURCES_JSON    = `ALTER TABLE prospects ADD COLUMN sources_json TEXT`;
const MIGRATE_PROSPECTS_DEDUPE_KEYS     = `ALTER TABLE prospects ADD COLUMN dedupe_keys_json TEXT`;
const MIGRATE_PROSPECTS_METRICS_JSON    = `ALTER TABLE prospects ADD COLUMN metrics_json TEXT`;
const MIGRATE_PROSPECTS_FIRST_SEEN_AT   = `ALTER TABLE prospects ADD COLUMN first_seen_at TEXT`;
const MIGRATE_PROSPECTS_LAST_SEEN_AT    = `ALTER TABLE prospects ADD COLUMN last_seen_at TEXT`;
const MIGRATE_PROSPECTS_LAST_ACTION_AT  = `ALTER TABLE prospects ADD COLUMN last_action_at TEXT`;
const MIGRATE_PROSPECTS_LAST_REPLY_AT   = `ALTER TABLE prospects ADD COLUMN last_reply_at TEXT`;

// ---------------------------------------------------------------------------
// Profiles → SQLite migration (Phase A, roadmap #7)
//
// Eight new columns extending `prospects` to absorb the identity + contact
// fields currently stored in profiles.json. The migration is purely additive
// per the design doc (docs/profiles-groups-sqlite-migration.md §3) — Phase B
// imports legacy data into these columns without overwriting non-NULL
// existing SQLite values.
//
// `normalized_profile_url` is NOT added here — that column already exists on
// `prospects` (see MIGRATE_PROSPECTS_NORMALIZED_URL above) and is reused for
// joins from the new tables.
// ---------------------------------------------------------------------------
const MIGRATE_PROSPECTS_FIRST_NAME           = `ALTER TABLE prospects ADD COLUMN first_name TEXT`;
const MIGRATE_PROSPECTS_LAST_NAME            = `ALTER TABLE prospects ADD COLUMN last_name TEXT`;
const MIGRATE_PROSPECTS_RAW_HEADLINE         = `ALTER TABLE prospects ADD COLUMN raw_headline TEXT`;
const MIGRATE_PROSPECTS_COMPANY_DOMAIN       = `ALTER TABLE prospects ADD COLUMN company_domain TEXT`;
const MIGRATE_PROSPECTS_PRIMARY_EMAIL        = `ALTER TABLE prospects ADD COLUMN primary_email TEXT`;
const MIGRATE_PROSPECTS_SUGGESTED_EMAILS     = `ALTER TABLE prospects ADD COLUMN suggested_emails_json TEXT`;
const MIGRATE_PROSPECTS_FIRST_INTERACTION_AT = `ALTER TABLE prospects ADD COLUMN first_interaction_at TEXT`;
const MIGRATE_PROSPECTS_LAST_INTERACTION_AT  = `ALTER TABLE prospects ADD COLUMN last_interaction_at TEXT`;

// ---------------------------------------------------------------------------
// profile_actions
//
// User-visible per-profile action log. Replaces the nested `actions: [...]`
// array in profiles.json. Kept separate from `activity_events` — they serve
// different read patterns (profile detail panel vs. analytics scans).
//
// `legacy_dedupe_key` is non-NULL only for rows imported by Phase B from
// the legacy JSON `actions[]`. The unique partial index on this column
// makes the importer's INSERT OR IGNORE produce exactly one row per
// (prospect_id, action_type, occurred_at, notes-hash, search_query) tuple,
// regardless of how many times the importer re-runs. Runtime writes leave
// the column NULL — the partial index doesn't constrain NULL values.
// ---------------------------------------------------------------------------
const TABLE_PROFILE_ACTIONS = `
CREATE TABLE IF NOT EXISTS profile_actions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id            TEXT    NOT NULL REFERENCES prospects (id),
  normalized_profile_url TEXT    NOT NULL,
  action_type            TEXT    NOT NULL,
  occurred_at            TEXT    NOT NULL,
  notes                  TEXT,
  search_query           TEXT,
  account_id             TEXT,
  legacy_dedupe_key      TEXT,
  created_at             TEXT    NOT NULL
)`;

const INDEX_PROFILE_ACTIONS_PROSPECT = `
CREATE INDEX IF NOT EXISTS idx_profile_actions_prospect
  ON profile_actions (prospect_id)`;

const INDEX_PROFILE_ACTIONS_OCCURRED = `
CREATE INDEX IF NOT EXISTS idx_profile_actions_occurred
  ON profile_actions (occurred_at)`;

const INDEX_PROFILE_ACTIONS_NORMALIZED_URL = `
CREATE INDEX IF NOT EXISTS idx_profile_actions_normalized_url
  ON profile_actions (normalized_profile_url)`;

const INDEX_PROFILE_ACTIONS_LEGACY_DEDUPE = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_actions_legacy_dedupe
  ON profile_actions (legacy_dedupe_key)
  WHERE legacy_dedupe_key IS NOT NULL`;

// ---------------------------------------------------------------------------
// groups + group_members
//
// Normalised replacement for groups.json (which today is triple-written to
// three filesystem paths with no cross-path transactionality). The current
// `members: [...]` is a list of bare LinkedIn URL strings; the
// `group_members` junction table preserves that semantics by keying on
// `normalized_profile_url` (so `https://www.linkedin.com/in/x/` and
// `https://linkedin.com/in/x` are the same member). `prospect_id` is
// backfilled opportunistically when a matching prospect exists.
// `member_metadata_json` is populated only when the legacy data carried
// `{ url, name, … }` object members; bare-URL members leave it NULL.
// ---------------------------------------------------------------------------
const TABLE_GROUPS = `
CREATE TABLE IF NOT EXISTS groups (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  description  TEXT,
  color        TEXT,
  account_id   TEXT,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
)`;

const TABLE_GROUP_MEMBERS = `
CREATE TABLE IF NOT EXISTS group_members (
  group_id               TEXT    NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  profile_url            TEXT    NOT NULL,
  normalized_profile_url TEXT    NOT NULL,
  prospect_id            TEXT,
  member_metadata_json   TEXT,
  added_at               TEXT    NOT NULL,
  PRIMARY KEY (group_id, normalized_profile_url)
)`;

const INDEX_GROUP_MEMBERS_PROSPECT = `
CREATE INDEX IF NOT EXISTS idx_group_members_prospect
  ON group_members (prospect_id)`;

const INDEX_GROUP_MEMBERS_NORMALIZED_URL = `
CREATE INDEX IF NOT EXISTS idx_group_members_normalized_url
  ON group_members (normalized_profile_url)`;

// ---------------------------------------------------------------------------
// import_state
//
// Observability marker for one-time and idempotent legacy importers
// (profiles, groups). One row per importer name. Cheap "has this been
// imported?" check that's separate from per-row dedup — lets us distinguish
// "ran but found 0 new rows" from "disabled / failed."
// ---------------------------------------------------------------------------
const TABLE_IMPORT_STATE = `
CREATE TABLE IF NOT EXISTS import_state (
  importer_name      TEXT    PRIMARY KEY,
  last_run_at        TEXT    NOT NULL,
  last_run_imported  INTEGER NOT NULL DEFAULT 0,
  last_run_skipped   INTEGER NOT NULL DEFAULT 0,
  last_run_errors    INTEGER NOT NULL DEFAULT 0,
  total_imported     INTEGER NOT NULL DEFAULT 0
)`;

// ---------------------------------------------------------------------------
// activity_events
//
// Append-only log replacing the activity-events.jsonl file.
// The event id is external (generated by ActivityEventStore.append).
// No UPDATE/DELETE expected on this table — analytics are read-only scans.
// ---------------------------------------------------------------------------
const TABLE_ACTIVITY_EVENTS = `
CREATE TABLE IF NOT EXISTS activity_events (
  id                  TEXT    PRIMARY KEY,
  event_type          TEXT    NOT NULL,
  event_timestamp     TEXT    NOT NULL,
  account_id          TEXT,
  account_name        TEXT,
  agent_id            TEXT,
  agent_name          TEXT,
  workflow_id         TEXT,
  workflow_name       TEXT,
  run_id              TEXT,
  target_id           TEXT,
  prospect_id         TEXT,
  target_value        TEXT,
  profile_url         TEXT,
  correlation_id      TEXT,
  root_correlation_id TEXT,
  event_status        TEXT,
  metadata_json       TEXT
)`;

// Analytics filters most commonly applied together
const INDEX_ACTIVITY_EVENTS_ACCOUNT_TS = `
CREATE INDEX IF NOT EXISTS idx_activity_events_account_ts
  ON activity_events (account_id, event_timestamp)`;

const INDEX_ACTIVITY_EVENTS_TYPE_TS = `
CREATE INDEX IF NOT EXISTS idx_activity_events_type_ts
  ON activity_events (event_type, event_timestamp)`;

const INDEX_ACTIVITY_EVENTS_RUN = `
CREATE INDEX IF NOT EXISTS idx_activity_events_run_id
  ON activity_events (run_id)`;

// ---------------------------------------------------------------------------
// linkedin_account_health
//
// Maps LinkedInAccountHealthStore per-account / per-subsystem state.
// UNIQUE (account_id, subsystem) enforces one row per logical key; the
// scheduler uses UPSERT on this constraint.
// ---------------------------------------------------------------------------
const TABLE_LINKEDIN_ACCOUNT_HEALTH = `
CREATE TABLE IF NOT EXISTS linkedin_account_health (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id            TEXT    NOT NULL,
  subsystem             TEXT    NOT NULL,
  health_status         TEXT    NOT NULL DEFAULT 'healthy',
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_success_at       TEXT,
  last_failure_at       TEXT,
  last_failure_reason   TEXT,
  cooldown_until        TEXT,
  cooldown_reason       TEXT,
  challenged            INTEGER NOT NULL DEFAULT 0,
  challenge_type        TEXT,
  challenge_detected_at TEXT,
  challenge_resolved_at TEXT,
  updated_at            TEXT    NOT NULL,
  UNIQUE (account_id, subsystem)
)`;

// Migration: add cooldown_reason to databases created before this column existed.
// Applied with try/catch in applySchema (see sqlite-db.js) so it is safe to run
// on new databases that already have the column from the CREATE TABLE DDL above.
const MIGRATE_ACCOUNT_HEALTH_COOLDOWN_REASON = `
ALTER TABLE linkedin_account_health ADD COLUMN cooldown_reason TEXT`;

// ---------------------------------------------------------------------------
// transport_health
//
// Maps TransportHealthStore per (transport, action, account_email) tuples.
// `transport` is one of: 'private_api', 'dom'.
// `action`    is a LinkedIn action slug: 'send_connection', 'send_dm', etc.
// ---------------------------------------------------------------------------
const TABLE_TRANSPORT_HEALTH = `
CREATE TABLE IF NOT EXISTS transport_health (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  transport           TEXT    NOT NULL,
  action              TEXT    NOT NULL,
  account_email       TEXT    NOT NULL,
  failure_count       INTEGER NOT NULL DEFAULT 0,
  success_count       INTEGER NOT NULL DEFAULT 0,
  disabled            INTEGER NOT NULL DEFAULT 0,
  disabled_until      TEXT,
  last_success_at     TEXT,
  last_failure_at     TEXT,
  last_failure_reason TEXT,
  last_updated_at     TEXT    NOT NULL,
  UNIQUE (transport, action, account_email)
)`;

const INDEX_TRANSPORT_HEALTH_LOOKUP = `
CREATE INDEX IF NOT EXISTS idx_transport_health_lookup
  ON transport_health (transport, action, account_email)`;

// ---------------------------------------------------------------------------
// notifications
//
// Maps dm-reply-monitor.json notifications dict.
// `delivered_at` is stored as INTEGER (Unix ms) to match the existing format.
// ---------------------------------------------------------------------------
const TABLE_NOTIFICATIONS = `
CREATE TABLE IF NOT EXISTS notifications (
  id               TEXT    PRIMARY KEY,
  account_id       TEXT,
  account_name     TEXT,
  sender_name      TEXT,
  message_text     TEXT,
  workflow_id      TEXT,
  workflow_name    TEXT,
  run_id           TEXT,
  agent_id         TEXT,
  agent_name       TEXT,
  conversation_urn TEXT,
  delivered_at     INTEGER,
  read_at          TEXT,
  created_at       TEXT    NOT NULL
)`;

const INDEX_NOTIFICATIONS_ACCOUNT = `
CREATE INDEX IF NOT EXISTS idx_notifications_account_id
  ON notifications (account_id)`;

const INDEX_NOTIFICATIONS_UNREAD = `
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (account_id, read_at)
  WHERE read_at IS NULL`;

// Notification column migrations — columns absent from the original DDL.
const MIGRATE_NOTIFICATIONS_MESSAGE_KEY       = `ALTER TABLE notifications ADD COLUMN message_key TEXT`;
const MIGRATE_NOTIFICATIONS_SENDER_PROFILE_URN = `ALTER TABLE notifications ADD COLUMN sender_profile_urn TEXT`;
const MIGRATE_NOTIFICATIONS_UPDATED_AT        = `ALTER TABLE notifications ADD COLUMN updated_at TEXT`;

// ---------------------------------------------------------------------------
// inbox_conversations
//
// Persists InboxStore conversation records across restarts.
// `last_inbound_at` and `last_outbound_at` are stored as INTEGER (Unix ms)
// to match the in-memory representation used by InboxStore.
// ---------------------------------------------------------------------------
const TABLE_INBOX_CONVERSATIONS = `
CREATE TABLE IF NOT EXISTS inbox_conversations (
  conversation_urn        TEXT    PRIMARY KEY,
  account_id              TEXT,
  account_name            TEXT,
  mailbox_urn             TEXT,
  participant_profile_urn TEXT,
  participant_names_json  TEXT,
  workflow_id             TEXT,
  workflow_name           TEXT,
  run_id                  TEXT,
  prospect_id             TEXT,
  agent_id                TEXT,
  agent_name              TEXT,
  last_inbound_at         INTEGER NOT NULL DEFAULT 0,
  last_outbound_at        INTEGER NOT NULL DEFAULT 0,
  status                  TEXT    NOT NULL DEFAULT 'active',
  intent_label            TEXT,
  last_message_preview    TEXT,
  messages_json           TEXT,
  created_at              TEXT    NOT NULL,
  updated_at              TEXT    NOT NULL
)`;

const INDEX_INBOX_CONVERSATIONS_ACCOUNT = `
CREATE INDEX IF NOT EXISTS idx_inbox_conversations_account_id
  ON inbox_conversations (account_id)`;

const INDEX_INBOX_CONVERSATIONS_STATUS = `
CREATE INDEX IF NOT EXISTS idx_inbox_conversations_status
  ON inbox_conversations (status)`;

// ---------------------------------------------------------------------------
// reply_monitor_state
//
// Per-account poll state for LinkedInReplyMonitor.
// A special row with account_id = '_global_' stores the lastPolledAt timestamp
// in the `last_success_at` column.
// ---------------------------------------------------------------------------
const TABLE_REPLY_MONITOR_STATE = `
CREATE TABLE IF NOT EXISTS reply_monitor_state (
  account_id       TEXT    PRIMARY KEY,
  initialized      INTEGER NOT NULL DEFAULT 0,
  mailbox_urn      TEXT,
  last_success_at  TEXT,
  last_error       TEXT,
  updated_at       TEXT    NOT NULL
)`;

// ---------------------------------------------------------------------------
// reply_monitor_cursors
//
// Per-conversation poll cursors for LinkedInReplyMonitor.
// `last_activity_at` and `last_inbound_delivered_at` are INTEGER (Unix ms).
// UNIQUE (account_id, conversation_urn) supports UPSERT.
// ---------------------------------------------------------------------------
const TABLE_REPLY_MONITOR_CURSORS = `
CREATE TABLE IF NOT EXISTS reply_monitor_cursors (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id                  TEXT    NOT NULL,
  conversation_urn            TEXT    NOT NULL,
  last_activity_at            INTEGER NOT NULL DEFAULT 0,
  last_inbound_delivered_at   INTEGER NOT NULL DEFAULT 0,
  last_message_key            TEXT,
  participant_names_json      TEXT,
  updated_at                  TEXT    NOT NULL,
  UNIQUE (account_id, conversation_urn)
)`;

const INDEX_REPLY_MONITOR_CURSORS_ACCOUNT = `
CREATE INDEX IF NOT EXISTS idx_reply_monitor_cursors_account
  ON reply_monitor_cursors (account_id)`;

// ---------------------------------------------------------------------------
// scheduled_posts
//
// Mirrors ScheduledPostStore's normalizePostRecord shape. Posts are
// addressed as a whole set: replaceAllPosts / replacePostsForAccount are the
// only write entry points, so there's no UPSERT path here — the SQLite repo
// wraps a DELETE+INSERT in a single transaction to preserve atomic
// "replace-as-a-set" semantics.
//
// Index choice: only `account_id`. The actual access patterns are
// full-table reads with JS-side filtering, or per-account DELETE in the
// replace path. There is no production query that filters by status or
// scheduled_date at the SQL level — the renderer's polling lives in
// post-scheduler.js against an in-memory cache and never queries the store.
// If a server-side due-post poll is ever introduced, that's the moment to
// add a composite index, not now.
//
// hashtags_json / mentions_json hold short normalized string lists; they
// are never queried independently, so JSON storage matches the precedent
// set by workflow_runs.steps_json.
// ---------------------------------------------------------------------------
const TABLE_SCHEDULED_POSTS = `
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id                       TEXT    PRIMARY KEY NOT NULL,
  account_id               TEXT,
  account_name             TEXT,
  agent_id                 TEXT,
  agent_name               TEXT,
  status                   TEXT    NOT NULL,
  scheduled_date           TEXT,
  scheduled_time           TEXT,
  created_at               TEXT    NOT NULL,
  published_at             TEXT,
  post_type                TEXT    NOT NULL,
  visibility               TEXT    NOT NULL,
  content                  TEXT    NOT NULL,
  error                    TEXT,
  delivery_strategy        TEXT,
  linkedin_resource_key    TEXT,
  linkedin_scheduled_at    TEXT,
  linkedin_last_synced_at  TEXT,
  linkedin_sync_error      TEXT,
  hashtags_json            TEXT,
  mentions_json            TEXT,
  include_image            INTEGER NOT NULL DEFAULT 0,
  image_path               TEXT,
  source_type              TEXT,
  plan_id                  TEXT,
  plan_name                TEXT,
  timezone                 TEXT,
  content_pillar           TEXT,
  content_angle            TEXT,
  content_theme            TEXT,
  content_brief            TEXT,
  content_day              INTEGER
)`;

const INDEX_SCHEDULED_POSTS_ACCOUNT = `
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_account_id
  ON scheduled_posts (account_id)`;

// ---------------------------------------------------------------------------
// Ordered list of all DDL statements to run at database initialisation.
// Tables first, then indexes.  Order within each group matches dependency
// (workflow_runs before workflow_jobs because of the FK reference).
// ---------------------------------------------------------------------------
const ALL_DDL = [
  TABLE_WORKFLOW_RUNS,
  TABLE_WORKFLOW_JOBS,
  TABLE_PROSPECTS,
  TABLE_ACTIVITY_EVENTS,
  TABLE_LINKEDIN_ACCOUNT_HEALTH,
  MIGRATE_ACCOUNT_HEALTH_COOLDOWN_REASON,
  TABLE_TRANSPORT_HEALTH,
  INDEX_TRANSPORT_HEALTH_LOOKUP,
  TABLE_NOTIFICATIONS,
  TABLE_INBOX_CONVERSATIONS,
  TABLE_REPLY_MONITOR_STATE,
  TABLE_REPLY_MONITOR_CURSORS,
  TABLE_SCHEDULED_POSTS,
  // Profiles/groups → SQLite migration (Phase A, roadmap #7)
  // Tables in FK-dependency order: profile_actions references prospects;
  // group_members references groups. prospects already exists above.
  TABLE_PROFILE_ACTIONS,
  TABLE_GROUPS,
  TABLE_GROUP_MEMBERS,
  TABLE_IMPORT_STATE,
  // Notification column migrations (safe try/catch in applySchema)
  MIGRATE_NOTIFICATIONS_MESSAGE_KEY,
  MIGRATE_NOTIFICATIONS_SENDER_PROFILE_URN,
  MIGRATE_NOTIFICATIONS_UPDATED_AT,
  // Prospect column migrations (safe try/catch in applySchema)
  MIGRATE_PROSPECTS_ACCOUNT_NAME,
  MIGRATE_PROSPECTS_AGENT_NAME,
  MIGRATE_PROSPECTS_NORMALIZED_URL,
  MIGRATE_PROSPECTS_RAW_TARGET,
  MIGRATE_PROSPECTS_SOURCE_ID,
  MIGRATE_PROSPECTS_SOURCE_LABEL,
  MIGRATE_PROSPECTS_SOURCES_JSON,
  MIGRATE_PROSPECTS_DEDUPE_KEYS,
  MIGRATE_PROSPECTS_METRICS_JSON,
  MIGRATE_PROSPECTS_FIRST_SEEN_AT,
  MIGRATE_PROSPECTS_LAST_SEEN_AT,
  MIGRATE_PROSPECTS_LAST_ACTION_AT,
  MIGRATE_PROSPECTS_LAST_REPLY_AT,
  // Phase A prospect column migrations (8 identity/contact columns from profiles.json)
  MIGRATE_PROSPECTS_FIRST_NAME,
  MIGRATE_PROSPECTS_LAST_NAME,
  MIGRATE_PROSPECTS_RAW_HEADLINE,
  MIGRATE_PROSPECTS_COMPANY_DOMAIN,
  MIGRATE_PROSPECTS_PRIMARY_EMAIL,
  MIGRATE_PROSPECTS_SUGGESTED_EMAILS,
  MIGRATE_PROSPECTS_FIRST_INTERACTION_AT,
  MIGRATE_PROSPECTS_LAST_INTERACTION_AT,
  INDEX_WORKFLOW_RUNS_ACCOUNT,
  INDEX_WORKFLOW_RUNS_STATUS,
  INDEX_WORKFLOW_JOBS_CLAIM,
  INDEX_WORKFLOW_JOBS_RUN,
  INDEX_PROSPECTS_AGENT,
  INDEX_PROSPECTS_DNC,
  INDEX_PROSPECTS_NORMALIZED_URL,
  INDEX_PROSPECTS_RELATED_URL,
  INDEX_ACTIVITY_EVENTS_ACCOUNT_TS,
  INDEX_ACTIVITY_EVENTS_TYPE_TS,
  INDEX_ACTIVITY_EVENTS_RUN,
  INDEX_TRANSPORT_HEALTH_LOOKUP,
  INDEX_NOTIFICATIONS_ACCOUNT,
  INDEX_NOTIFICATIONS_UNREAD,
  INDEX_INBOX_CONVERSATIONS_ACCOUNT,
  INDEX_INBOX_CONVERSATIONS_STATUS,
  INDEX_REPLY_MONITOR_CURSORS_ACCOUNT,
  INDEX_SCHEDULED_POSTS_ACCOUNT,
  // Phase A new-table indexes
  INDEX_PROFILE_ACTIONS_PROSPECT,
  INDEX_PROFILE_ACTIONS_OCCURRED,
  INDEX_PROFILE_ACTIONS_NORMALIZED_URL,
  INDEX_PROFILE_ACTIONS_LEGACY_DEDUPE,
  INDEX_GROUP_MEMBERS_PROSPECT,
  INDEX_GROUP_MEMBERS_NORMALIZED_URL,
  // workflow_jobs column migrations (safe try/catch in applySchema)
  MIGRATE_WORKFLOW_JOBS_CLAIM_UUID,
  // workflow_runs column migrations
  MIGRATE_WORKFLOW_RUNS_LAUNCH_SOURCE
];

module.exports = {
  SCHEMA_VERSION,
  ALL_DDL,
  TABLE_WORKFLOW_RUNS,
  TABLE_WORKFLOW_JOBS,
  TABLE_PROSPECTS,
  TABLE_ACTIVITY_EVENTS,
  TABLE_LINKEDIN_ACCOUNT_HEALTH,
  MIGRATE_ACCOUNT_HEALTH_COOLDOWN_REASON,
  TABLE_TRANSPORT_HEALTH,
  INDEX_TRANSPORT_HEALTH_LOOKUP,
  TABLE_NOTIFICATIONS,
  TABLE_INBOX_CONVERSATIONS,
  TABLE_REPLY_MONITOR_STATE,
  TABLE_REPLY_MONITOR_CURSORS,
  TABLE_SCHEDULED_POSTS,
  INDEX_SCHEDULED_POSTS_ACCOUNT,
  MIGRATE_WORKFLOW_JOBS_CLAIM_UUID,
  MIGRATE_WORKFLOW_RUNS_LAUNCH_SOURCE,
  MIGRATE_WORKFLOW_RUNS_BYPASS_WORKING_HOURS,
  MIGRATE_NOTIFICATIONS_MESSAGE_KEY,
  MIGRATE_NOTIFICATIONS_SENDER_PROFILE_URN,
  MIGRATE_NOTIFICATIONS_UPDATED_AT,
  MIGRATE_PROSPECTS_ACCOUNT_NAME,
  MIGRATE_PROSPECTS_AGENT_NAME,
  MIGRATE_PROSPECTS_NORMALIZED_URL,
  MIGRATE_PROSPECTS_RAW_TARGET,
  MIGRATE_PROSPECTS_SOURCE_ID,
  MIGRATE_PROSPECTS_SOURCE_LABEL,
  MIGRATE_PROSPECTS_SOURCES_JSON,
  MIGRATE_PROSPECTS_DEDUPE_KEYS,
  MIGRATE_PROSPECTS_METRICS_JSON,
  MIGRATE_PROSPECTS_FIRST_SEEN_AT,
  MIGRATE_PROSPECTS_LAST_SEEN_AT,
  MIGRATE_PROSPECTS_LAST_ACTION_AT,
  MIGRATE_PROSPECTS_LAST_REPLY_AT,
  // Phase A — profiles/groups → SQLite (roadmap #7)
  TABLE_PROFILE_ACTIONS,
  TABLE_GROUPS,
  TABLE_GROUP_MEMBERS,
  TABLE_IMPORT_STATE,
  MIGRATE_PROSPECTS_FIRST_NAME,
  MIGRATE_PROSPECTS_LAST_NAME,
  MIGRATE_PROSPECTS_RAW_HEADLINE,
  MIGRATE_PROSPECTS_COMPANY_DOMAIN,
  MIGRATE_PROSPECTS_PRIMARY_EMAIL,
  MIGRATE_PROSPECTS_SUGGESTED_EMAILS,
  MIGRATE_PROSPECTS_FIRST_INTERACTION_AT,
  MIGRATE_PROSPECTS_LAST_INTERACTION_AT,
  INDEX_PROFILE_ACTIONS_PROSPECT,
  INDEX_PROFILE_ACTIONS_OCCURRED,
  INDEX_PROFILE_ACTIONS_NORMALIZED_URL,
  INDEX_PROFILE_ACTIONS_LEGACY_DEDUPE,
  INDEX_GROUP_MEMBERS_PROSPECT,
  INDEX_GROUP_MEMBERS_NORMALIZED_URL
};
