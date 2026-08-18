# Legacy Direct-Login Inventory

This inventory tracks non-worker LinkedIn login paths discovered during the
session-churn hardening work. The goal is to make dispositions explicit:
`migrate`, `emergency-only`, `retire`, or `leave`.

## Live product paths

These are reachable from the shipped app runtime and now fenced behind
`CONNECT_ALLOW_LEGACY_DIRECT_LOGIN`.

| File | Entry point | Override token | Disposition | Notes |
| --- | --- | --- | --- | --- |
| `main.js` | `send-messages-now` | `main.send-messages-now` | `emergency-only` | Spawns `automation.js` in send-messages mode |
| `main.js` | `start-automation` | `main.start-automation` | `emergency-only` | Spawns legacy search-engage automation |
| `main.js` | `start-name-list-automation` | `main.start-name-list-automation` | `emergency-only` | Spawns legacy name-list automation |
| `main.js` | `startMessagingAutomationForScheduledMessage` | `main.start-scheduled-message` | `emergency-only` | Direct browser launch + login |
| `automation.js` | `main()` | `legacy.automation-cli` | `emergency-only` | Legacy CLI/runtime adapter path |
| `automation.js` | `runEnhancedAutomation()` | `legacy.runenhancedautomation` | `emergency-only` | Legacy search/name-list automation |
| `automation.js` | `createEnhancedBrowser()` | `legacy.createenhancedbrowser` | `emergency-only` | Used by older messaging handlers |
| `automation/messaging/automation.js` | `executeSendNow()` | `messaging.executesendnow` | `emergency-only` | Direct message-send automation |
| `automation/messaging/automation.js` | `searchAndMessage()` | `messaging.searchandmessage` | `emergency-only` | Legacy search + message flow |

## Retired

These legacy artifacts were confirmed dead and removed from the tree.

| File | Previous disposition | Notes |
| --- | --- | --- |
| `automation/messaging/messageHandler.js` | `retire or repair first` | Not in the live require graph and failed `node -c`; removed instead of repaired |
| `linkedin-automation.js` | `retire` | No live require/import references outside docs |
| `automation/workflow/runner.js` | `retire or dev-only` | No live require/import references outside docs |
| `visible-workflow.js` | `dev-only` | No live require/import references outside docs |
| `workflow.js` | `dev-only` | Loaded by `app.html`, but none of its legacy DOM IDs exist in the current renderer; removed with its inert script tag |

## Intentionally left alone

| File | Reason |
| --- | --- |
| `automation/posting/post-publisher.js` | Calls `loginToLinkedIn(...)` only as in-session recovery on an existing page; it is not a cold-start direct-login entry point |
| `scripts/*` | Probes / validators only; not part of the product runtime |

## Emergency override

- `CONNECT_ALLOW_LEGACY_DIRECT_LOGIN=1` allows all fenced legacy direct-login paths.
- `CONNECT_ALLOW_LEGACY_DIRECT_LOGIN=main.start-automation` allows only one named entry point.
- Tokens are case-insensitive; this doc shows the normalized form.

Use the override only for emergency recovery while the worker-owned runtime
replacement is unavailable.
