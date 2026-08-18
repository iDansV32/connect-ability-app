'use strict';

const TELEMETRY_RETENTION_DECLARATIONS = Object.freeze([
  Object.freeze({
    id: 'existing_activity_events',
    docLabel: 'Existing activity events',
    eventTypes: Object.freeze([
      'profile_viewed',
      'post_liked',
      'connection_requested',
      'connection_accepted',
      'dm_sent',
      'dm_reply_received',
      'profile_followed',
      'profile_unfollowed',
      'skill_endorsed',
      'post_commented',
      'post_published',
      'post_liked_by_others',
      'profile_view_metric_updated',
      'workflow_started',
      'workflow_step_completed',
      'workflow_step_failed',
      'workflow_completed',
      'workflow_failed',
      'legacy_direct_login_used'
    ]),
    enforcedPruneOwner: null
  }),
  Object.freeze({
    id: 'telemetry_prune_outcome_events',
    docLabel: 'Telemetry prune outcome events (`telemetry_prune_completed`, `telemetry_prune_failed`)',
    eventTypes: Object.freeze([
      'telemetry_prune_completed',
      'telemetry_prune_failed'
    ]),
    enforcedPruneOwner: null
  }),
  Object.freeze({
    id: 'scrutiny_events',
    docLabel: '`scrutiny_*` events',
    eventPrefixes: Object.freeze(['scrutiny_']),
    enforcedPruneOwner: 'activity_events'
  }),
  Object.freeze({
    id: 'login_lifecycle_events',
    docLabel: 'Login lifecycle events (`worker_spawn`, `worker_exit`, `login_attempt`, `session_verified`, `auth_failure`, `challenge_detected`, `challenge_recovery`)',
    eventTypes: Object.freeze([
      'worker_spawn',
      'worker_exit',
      'login_attempt',
      'session_verified',
      'auth_failure',
      'challenge_detected',
      'challenge_recovery'
    ]),
    enforcedPruneOwner: 'activity_events'
  }),
  Object.freeze({
    id: 'write_intents_terminal_rows',
    docLabel: '`write_intents` terminal rows',
    enforcedPruneOwner: null
  }),
  Object.freeze({
    id: 'runtime_logs',
    docLabel: 'Runtime logs',
    // pruneLogFile in runtime-log-store.js enforces 7-day age + 8 MB / 10 k
    // entry caps. See docs/telemetry-retention.md row "Runtime logs".
    enforcedPruneOwner: 'runtime_logs'
  }),
  Object.freeze({
    id: 'network_response_excerpts',
    docLabel: 'Network response excerpts',
    enforcedPruneOwner: null
  }),
  Object.freeze({
    id: 'mcp_platform_write_audit_log',
    docLabel: 'MCP platform-write audit log',
    enforcedPruneOwner: 'mcp_audit_log'
  }),
  Object.freeze({
    id: 'profile_urls_in_prospect_records',
    docLabel: 'Profile URLs in prospect records',
    enforcedPruneOwner: null
  }),
  Object.freeze({
    id: 'message_bodies_in_inbox_data',
    docLabel: 'Message bodies in inbox data',
    enforcedPruneOwner: null
  }),
  Object.freeze({
    id: 'scheduled_posts',
    docLabel: 'Scheduled posts',
    // No prune owner — scheduled posts are operator-managed state, not
    // telemetry. Declared here so the retention doc remains the state
    // lifetime contract for every persisted SQLite table.
    enforcedPruneOwner: null
  })
]);

module.exports = {
  TELEMETRY_RETENTION_DECLARATIONS
};
