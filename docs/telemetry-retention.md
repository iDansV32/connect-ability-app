# Telemetry Retention Policy

**Status:** Proposed implementation policy
**Date:** 2026-04-19
**Applies to:** account-safety hardening work introduced after 2026-04-19

---

## Purpose

This document defines how long each telemetry class may live, where it may be stored, and what redaction rules apply.

It exists to prevent retention drift while adding new observability for account-safety work.

---

## Rules

1. No cookies, session tokens, passwords, or raw secret material may be persisted in telemetry.
2. Message bodies must not be duplicated into general-purpose activity events or runtime diagnostics.
3. Any new telemetry table, event family, or log file must add a row to this document in the same PR.
4. Any new retention class must land its prune mechanism in the same PR as the data producer.
5. Customer mode may only use this policy or stricter. Vendor mode may only retain more data if a new row is added here explicitly.

---

## Data Classes

| Data class | Storage | Retention target | Status | Notes |
|---|---|---:|---|---|
| Existing activity events | SQLite `activity_events` or JSONL fallback | Unlimited for now | Existing | Revisit once retention pressure is known at larger scale |
| Telemetry prune outcome events (`telemetry_prune_completed`, `telemetry_prune_failed`) | SQLite `activity_events` or JSONL fallback | Unlimited for now | Enforced producer | Low-volume operational events; excluded from retained-raw pruning |
| `scrutiny_*` events | SQLite `activity_events` or JSONL fallback | 180 days raw | Enforced | Startup prune path is implemented in `ActivityEventStore`; no aggregate table exists yet |
| Login lifecycle events (`worker_spawn`, `worker_exit`, `login_attempt`, `session_verified`, `auth_failure`, `challenge_detected`, `challenge_recovery`) | SQLite `activity_events` or JSONL fallback | 180 days raw | Enforced | Startup prune path is implemented in `ActivityEventStore` |
| `write_intents` terminal rows | SQLite `write_intents` | 90 days raw | New | Non-terminal rows live until resolved |
| Runtime logs | `runtime-logs.jsonl` | 7 days max age plus existing byte/count limits | Enforced | Age pruning enforced by `RuntimeLogStore` via throttled on-append sweeps; 4-hour default was too aggressive for overnight-failure debugging |
| Network response excerpts | Runtime log only, never SQLite | 4 hours max age, 400-char cap | New | Must be redacted and excerpt-only |
| MCP platform-write audit log | Dedicated append-only JSONL | 365 days | New | Security-grade operational log; currently enforced by MCP-server startup sweep with atomic rewrite |
| Profile URLs in prospect records | Prospect/inbox stores | Existing record lifetime | Existing | No duplicate copies in generalized telemetry if avoidable |
| Message bodies in inbox data | Inbox/conversation store only | Existing record lifetime | Existing | Must not leak into events or diagnostics |
| Scheduled posts | SQLite `scheduled_posts` (or JSONL fallback) | Existing record lifetime | Existing | Lifecycle is operator-managed: replaced by `save_scheduled_posts` / removed by `replacePostsForAccount`. No age sweep — not telemetry. Row included here so this doc remains the "state lifetime contract" for every persisted table; future tables that genuinely need pruning declare it the same way. |

---

## Required Implementation Changes

### 1. Activity Event Pruning

Current implementation:

- the canonical main-process SQLite-backed `ActivityEventStore` runs a startup sweep for retained raw event families
- SQLite-backed stores delete matching rows in place
- JSONL fallback rewrites the file atomically and drops malformed lines so the rewritten file stays valid JSONL

Families currently covered:

- `scrutiny_*`
- login lifecycle events

When rows age out:

- delete raw rows older than 180 days
- no aggregate table exists yet, so there is nothing additional to preserve today

### 2. Write Intent Pruning

Add a prune job for `write_intents`:

- retain unresolved rows until they resolve
- delete terminal rows older than 90 days

### 3. Runtime Log Pruning

Extend `runtime-log-store.js` so pruning is based on:

- maximum file size (8 MB default)
- maximum entry count (10 000 default)
- maximum age of 7 days

Age-based pruning is required even if the file stays under size limits. To
avoid scanning the full file on every append, the age sweep is throttled per
store instance (default: at most once every 10 minutes). Byte/count caps
continue to fire on every append.

Operator note: network response excerpts (see row below) sit in the same
`runtime-logs.jsonl` file but have a stricter 4-hour bound. When that class
is implemented, its 4-hour limit must be enforced at write/read time (or via
a dedicated sub-store) rather than by relying on file-level pruning, since
the host file's retention is now longer.

### 4. Network Tracer Constraint

`automation/network/tracer.js` must not become a raw body archive.

Allowed behavior:

- redact secrets
- keep short excerpts only
- write only to short-lived runtime diagnostics

Forbidden behavior:

- writing raw LinkedIn response bodies to SQLite
- writing full message content to persistent traces
- storing cookies or CSRF/session headers in retained telemetry

### 5. MCP Audit Pruning

Add pruning for the platform-write audit JSONL:

- retain 365 days
- prune on a rolling basis
- preserve append-only semantics between prune runs

Current implementation:

- startup sweep when MCP HTTP/stdio policy is initialized
- atomic tmp-file rewrite + rename
- malformed JSONL lines are dropped during prune so the rewritten file stays valid JSONL

---

## Redaction Requirements

### Always redact

- passwords
- cookies
- session tokens
- CSRF tokens
- API keys
- bearer tokens
- authorization headers

### Never duplicate into general telemetry

- message body text
- inbox reply text
- note/comment/post body content beyond a redacted excerpt policy

### Prefer hashed or normalized identifiers when possible

- profile URLs when stored for diagnostics instead of product data
- caller fingerprints in MCP audit entries

---

## PR Checklist

Any PR that adds telemetry must answer these questions:

1. What is the data class name?
2. Where is it stored?
3. What is the retention target?
4. What prune path enforces that target?
5. What redaction rules apply?
6. Does it duplicate data that already exists elsewhere?

If any answer is missing, the telemetry addition is incomplete.

---

## Follow-Up Test Requirement

Add one automated test that validates declared retention classes against implemented producers and prune hooks.

Current implementation:

- `telemetry-retention-policy.js` declares the retention classes used by the coverage test
- `tests/telemetry-retention-policy.test.js` cross-checks those declarations against `ALLOWED_EVENT_TYPES`, the live prune owners, and this document

The test should fail if:

- a new event family or table is introduced without a declared retention class
- a declared retention class has no prune path

This keeps the policy coupled to the implementation instead of becoming stale documentation.
