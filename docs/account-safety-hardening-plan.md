# Account Safety Hardening Plan

**Status:** Frozen for implementation
**Date:** 2026-04-19
**Scope:** Internal vendor-mode pilot on one aged LinkedIn account, with a path to small-scale use (`<=15` accounts)

---

## Summary

This plan treats the current LinkedIn risk profile as an account-safety problem, not a generic "stealth" problem.

The observed challenge triggers on the pilot account are:

- very high login frequency in a single day
- sending too many invites in a single day

There is currently no evidence that browser fingerprinting, reply-monitor poll cadence, or behavioral realism is the primary bottleneck for this account. The highest-leverage work is therefore:

1. eliminate avoidable login churn
2. tighten invite and total-action discipline
3. add enough observability to attribute the next scrutiny event correctly

---

## Facts Grounded In The Current Repo

- The durable scheduler already blocks challenged and cooling workflow accounts before claim and again before dispatch in `automation/runtime/durable-workflow-scheduler.js`.
- The router itself still has no account-health guard in `automation/runtime/action-router.js`.
- The reply monitor defaults to a 3-minute cadence in `linkedin-reply-monitor.js`; `main.js` does not override it.
- Per-account persistent Chromium profiles already exist via `launchPersistentContext(...)` in `automation/runtime/account-worker-process.js`.
- Session verification defaults to a 4-hour freshness window in `automation/runtime/account-session-registry.js`, which is too infrequent to explain dozens of credential logins per day by itself.
- The repo still contains legacy direct-login paths outside the long-lived worker model, including a live scheduled-messaging path in `main.js`.
- Invite quotas and DM quotas are enforced by different stores:
  - `linkedin-action-quota-store.js` for invites, views, likes, follows, comments, and related workflow actions
  - `message-quota-store.js` for DMs
- Both quota stores already randomize the effective daily window to `60%-95%` of the configured daily base limit.

These facts change the priority order: session churn and invite-volume discipline come before deeper browser-surface changes.

---

## Operating Mode

The implementation target for this plan is:

- **Mode:** `vendor`
- **Account type:** aged, already usable, no warm-up ramp required
- **Resume policy after scrutiny:** human-confirmed only

Customer installs should keep stricter defaults. Nothing in this plan should require customer accounts to participate in experiments.

---

## Goals

- Reduce credential-login frequency to a small, explainable number.
- Eliminate automatic writes after scrutiny signals until a human clears the account.
- Lower invite-volume-triggered scrutiny without degrading the rest of the product unnecessarily.
- Make the next scrutiny event attributable from logs and retained events instead of guesswork.
- Remove or fence legacy direct-login paths that bypass the long-lived worker/session model.

---

## Non-Goals

- No detector-demo optimization program.
- No canary-fleet or A/B experimentation framework in this phase.
- No full browser-fingerprint library swap.
- No anti-CDP patch migration.
- No behavior-model retraining or noise-action sequencing.
- No full Voyager retirement in this phase.

Those may become relevant later, but they are explicitly deferred until the pilot has baseline data that points in that direction.

---

## Primary Workstreams

### 1. Session Churn Elimination

This is the most important workstream in the plan.

The account already uses persistent browser profiles. If login counts are still extremely high, the likely causes are:

- worker churn
- legacy direct-login paths
- incorrect session invalidation decisions

#### Week 1 deliverables

- Add login lifecycle events:
  - `worker_spawn`
  - `worker_exit`
  - `login_attempt`
  - `session_verified`
  - `auth_failure`
  - `challenge_recovery`
- Give each worker lifetime a correlation ID.
- Emit these events from:
  - `automation/runtime/account-worker-process.js`
  - `automation/runtime/account-session-registry.js`
  - every surviving direct-login path

#### Legacy path inventory

Search for:

- `loginToLinkedIn`
- `chromium.launch(`
- `browser.newContext(`
- direct credential reads outside the account-worker flow

Each hit gets one disposition:

- `retire` if unused
- `migrate` if the feature is still live
- `emergency_only` if it must exist but should never run automatically

#### Known paths to inventory immediately

- `main.js` scheduled messaging path
- `automation/messaging/automation.js`
- `automation.js`

#### Acceptance

- By the end of week 2, normal product paths no longer call `loginToLinkedIn(...)` outside the account-worker flow.
- Login lifecycle events can explain every credential-login occurrence during the pilot window.

### 2. Quota And Action-Rate Discipline

The account has already shown invite-volume-triggered scrutiny. That makes quota work an immediate P0 item.

Important implementation detail: the configured daily limit is not the same as the effective daily limit. Both quota stores randomize the actual daily window to `60%-95%` of the configured base limit.

#### Week 1 changes

- Lower `connection_requested` in `linkedin-action-quota-store.js`:
  - reduce the configured daily base limit from `30` to `22`
  - reduce the configured weekly limit from `150` to `100`
- Lower `DEFAULT_DAILY_BUDGET` in `automation/safety/daily-activity-budget.js`:
  - reduce from `150` to `120`

These changes produce a materially safer invite posture without unnecessarily tightening every other action type on day one.

#### Deferred quota changes

Do not tighten DM quotas, profile-view quotas, or follow/like quotas in week 1 unless the new telemetry shows they are actually contributing to scrutiny or crowding the total daily budget.

If needed after the first baseline review:

- revisit `message-quota-store.js` for DMs
- revisit non-invite action caps in `linkedin-action-quota-store.js`

#### Acceptance

- Invite pressure is reduced immediately.
- Total daily action usage is capped below the current default envelope.
- Any later quota tightening is driven by observed pilot data, not competitor marketing claims.

### 3. Unified Write Suspension

The scheduler already blocks challenged or cooling workflow accounts. The missing work is to unify that logic so every write path uses the same predicate.

#### New predicate

Add `accountWritesAllowed(accountId, now)` to `linkedin-account-health-store.js`.

This predicate becomes the single source of truth for whether LinkedIn writes are permitted.

#### Call sites

- durable scheduler claim path
- durable scheduler pre-dispatch path
- `automation/runtime/action-router.js` immediately after the do-not-contact guard
- any surviving manual or legacy write path

#### State changes

Extend `recordChallenge(...)` to set:

- `writesSuspendedUntil`
- `writesSuspendedReason`

Suspension is cleared only through the existing human action that clears the LinkedIn challenge state.

#### Acceptance

- A challenged account cannot continue sending invites, DMs, follows, comments, or posts through any surviving entry point.
- Human-confirmed resume is required before writes return.

### 4. Scrutiny Attribution

The repo still lacks a unified scrutiny event family and always-on classifier path.

#### New module

Create `automation/runtime/scrutiny-classifier.js` as a pure classifier that can consume:

- response status
- URL
- redacted body excerpt
- DOM state
- action name
- transport

#### New event family

Add these event families to `activity-event-store.js`:

- `scrutiny_captcha`
- `scrutiny_checkpoint_redirect`
- `scrutiny_unusual_activity_banner`
- `scrutiny_invite_limit_warning`
- `scrutiny_rate_limit_429`
- `scrutiny_blocked_999`
- `scrutiny_signed_out_unexpected`
- `scrutiny_session_expired`
- login lifecycle events from Workstream 1

#### Routing points

- `automation/network/tracer.js`
- `automation/runtime/verification.js`
- `linkedin-reply-monitor.js`
- posting paths
- worker challenge emission path

#### Acceptance

- A single scrutiny incident appears as a retained activity event with account, action, transport, and timestamp.
- The event is precise enough to drive write suspension and later postmortem review.

### 5. Write Idempotency

This is not a stealth feature, but it is part of account safety because duplicate writes are irreversible once sent.

#### New persistence

Add a `write_intents` table with an idempotency key derived from:

- run ID
- target ID
- step index
- action hash

#### Behavior

- pre-dispatch: reject duplicates or ambiguous replays
- post-verify: mark completed outcome
- crash recovery: verify by observation before deciding whether to retry

#### Acceptance

- A crash between successful send and local commit does not send the action twice on restart.

### 6. MCP And Renderer Hardening

The account is only useful if accidental or unauthorized local writes are hard to trigger.

#### MCP server

In `connect-mcp-server.js`:

- classify tools by write capability
- require a distinct platform-write gate for account-affecting operations
- add a platform-write audit log
- keep read-only tools usable without widening write access

#### Preload surface

In `preload.js`:

- add an allowlist discipline for `invoke(...)` calls, not only `send()` and `on()`

#### Acceptance

- Accidental local loops or unauthorized callers cannot trigger LinkedIn writes without hitting the explicit write gate.

### 7. Targeted Browser-Surface Hygiene

This is intentionally small in this phase.

#### Keep

- disable WebRTC local ICE leakage at worker context creation
- sessionize plugin-pack selection in `automation/safety/account-fingerprint-profile.js`

#### Defer

- canvas/WebGL/audio rewrites
- fingerprint library swaps
- anti-CDP patching
- detector-demo score gating

These are not rejected forever; they are deferred until the pilot shows that session churn and invite volume are no longer the dominant sources of risk.

### 8. Voyager Surface Reduction

Voyager is not the first bottleneck for this account, so the plan stays conservative.

#### Week 5 change

- remove the Voyager posting fallback

#### Deferred

- keep Voyager reads for inbox and threads in this phase
- revisit broader retirement only after baseline scrutiny data exists

---

## Implementation Sequence

### Week 1

- Add login lifecycle telemetry.
- Inventory and classify legacy direct-login paths.
- Lower invite base limits and total daily budget.
- Add MCP platform-write gate and audit log.
- Add preload `invoke(...)` allowlist discipline.

### Week 2

- Retire or migrate surviving legacy direct-login paths.
- Ship scrutiny classifier and `scrutiny_*` event family in passive-observe mode.
- Implement unified `accountWritesAllowed(...)`.
- Add working-hours coherence boot check.
- Begin new retention mechanisms described in `docs/telemetry-retention.md`.

### Week 3

- Flip stop-after-scrutiny on by default.
- Land write-intent schema and observe-only idempotency checks.
- Disable WebRTC local ICE leakage.
- Review two weeks of login-lifecycle data and confirm the session-churn root cause.

### Week 4

- Enforce idempotency with verify-by-observation recovery.
- Turn on event retention pruning for new data classes.
- Review the first scrutiny baseline and decide whether any more quota tightening is needed.

### Week 5

- Remove Voyager posting fallback.
- Sessionize plugin-pack selection.
- Add a minimal account-safety dashboard:
  - scrutiny rate trend
  - logins per day
  - quota usage
  - suspension state

### Week 6

- Write the runbook from observed pilot data.
- Add a small idle tail on session close.
- Review whether further investment is warranted and where.

---

## Success Criteria

The phase is successful if, by the end of week 6:

- login counts are low and explainable
- invite-volume-triggered scrutiny is materially reduced
- challenged accounts stop writing immediately until a human clears them
- duplicate writes are prevented across crash/restart scenarios
- every surviving LinkedIn write path is accounted for and gated
- future decisions can be made from retained evidence instead of inference alone

---

## Explicit Deferrals

The following are intentionally deferred until the pilot data proves they matter:

- fleet-level experimentation
- detector-demo release gates
- full Voyager retirement
- behavior-modeling work
- extension or browser-version fleet management
- anti-CDP patch migrations
- deep fingerprint-surface rewrites

If session churn and invite pressure stop being the primary drivers of risk, revisit these after the first pilot baseline review.
