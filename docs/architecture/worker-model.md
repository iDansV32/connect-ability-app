# Worker/Process Model Decision Record

**Status:** Decided
**Ticket:** P1-0
**Blocks:** P1-1, P1-2, P1-3, P1-4

---

## Problem

The current durable workflow scheduler (`main.js:startDueDurableWorkflowJobs`) spawns one child
process per step (`spawnNodeRuntime(automation.js, [configPath])`). Each child calls
`chromium.launch()` and performs a full login before executing one action, then exits. This means:

- No `BrowserContext` is reused across steps for the same account.
- Reply monitoring (`linkedin-reply-monitor.js`) and posting (`linkedin-posting.js`) each launch
  their own independent browsers on every cycle.
- A shared persistent `BrowserContext` (required by P1-2 through P1-4) cannot be passed across
  an OS process boundary.

---

## Options Considered

### Option A — In-process execution

Move durable workflow step execution into the Electron main process. Steps run inside
`executeDurableWorkflowJob` directly (or in a `worker_thread`). The account worker holds
a `BrowserContext` that steps borrow via a leased page.

**Tradeoffs:**
- Simpler: no IPC protocol needed.
- Playwright already runs Chromium as a separate OS process, so browser crashes do not kill Node.
- However: a badly behaved step can corrupt shared state in the main process. A LinkedIn challenge
  that triggers an unhandled exception in a `worker_thread` can bring down the Electron UI.
- Current child-process isolation exists for a reason; removing it trades safety for simplicity.

### Option B — Long-lived per-account worker processes (chosen)

Replace one-child-per-step with one persistent Node.js child process per LinkedIn account.
The child process owns the `BrowserContext` for its account and processes jobs serially.
The main process dispatches job descriptors over IPC and receives outcome results as JSON.

Reply monitoring and posting move into the same worker process, sharing the `BrowserContext`
at zero cost — no page handles cross a process boundary.

**Tradeoffs:**
- Requires a small IPC protocol (job descriptor in, result JSON out, heartbeat signals).
- Better crash isolation: a step crash kills the worker process, not the Electron UI. Main
  process detects `close` and marks the job failed; the worker is restarted on the next job.
- Maps cleanly to P1-2 through P1-4: shared context, dedicated named pages per subsystem,
  and lease-based serialization all live inside one process per account.

---

## Decision: Option B

One persistent Node.js child process per LinkedIn account.

### Rationale

1. **Crash isolation is preserved.** The existing per-step child model exists because LinkedIn
   automation can fail in uncontrolled ways (challenges, unexpected DOM state, API errors).
   Moving execution in-process would give that risk back.

2. **Shared `BrowserContext` falls out naturally.** The worker process owns the browser.
   Workflow steps, reply polling, and posting all run in the same process and share context
   without any serialization.

3. **IPC complexity is bounded.** Job descriptors are small JSON objects. Results are small
   JSON objects. Heartbeat is a periodic empty message. No Playwright objects cross the boundary.

4. **Per-account serialization is already required.** LinkedIn rate limits make parallel
   actions per account unsafe. The worker processes jobs one at a time, which enforces this
   constraint structurally.

---

## Architecture

```
main process (Electron)
  AccountWorkerProcessManager
    ├── AccountWorkerProcess (account: alice@example.com)
    │     BrowserContext (persistent profile)
    │       ├── workflowPage   ← leased by workflow steps
    │       ├── messagingPage  ← held by reply monitor
    │       └── postingPage    ← leased by posting tasks
    │     Job queue (serial)
    │     IPC channel ← job descriptors from main
    │
    └── AccountWorkerProcess (account: bob@example.com)
          ...
```

### IPC protocol (main → worker)

```json
{ "type": "execute_step", "jobId": "...", "runId": "...", "step": { ... }, "credentials": { ... } }
{ "type": "shutdown" }
```

### IPC protocol (worker → main)

```json
{ "type": "step_result", "jobId": "...", "outcome": "completed|failed|skipped", "metadata": { ... } }
{ "type": "heartbeat", "jobId": "..." }
{ "type": "worker_ready" }
```

---

## Impact on P1-2 through P1-4

| Ticket | Change from original backlog |
|--------|------------------------------|
| P1-2 (`account-worker.js`) | Worker is a child process entrypoint, not a main-process class. Holds `BrowserContext` and named pages. Exports nothing to main — communicates only via IPC. |
| P1-3 (reply monitor migration) | Reply monitor moves into the worker process. Calls `messagingPage` directly. Main process receives reply events over IPC. |
| P1-4 (posting migration) | Posting moves into the worker process. `postingPage` is leased within the worker. Main process sends a post-step job descriptor; worker executes and reports outcome. |
| P1-1 (worker manager) | `AccountWorkerProcessManager` in the main process. Spawns and tracks one child per account. Handles worker crash/restart. Routes job claims to the correct worker. |

---

## Files to touch

| File | Change |
|------|--------|
| `main.js:5956` | Replace `spawnNodeRuntime(automation.js, ...)` with `accountWorkerProcessManager.dispatch(job)` |
| `main.js:6052` | `startDueDurableWorkflowJobs` claims jobs then dispatches to manager instead of spawning child |
| `automation.js` | Remains frozen (legacy). Not the worker process entrypoint. |
| `automation/runtime/account-worker-process.js` | New: child process entrypoint. Receives jobs over IPC, holds browser, executes steps. |
| `automation/runtime/account-worker-process-manager.js` | New: main-process manager. Spawns, tracks, and communicates with worker processes. |
| `linkedin-reply-monitor.js` | Reply poll logic moves into the worker process. Main process receives events via IPC. |
| `linkedin-posting.js` | Posting task execution moves into the worker process. |

---

## What does not change

- `workflowRunManager` — still owns job state, lease management, and heartbeat tracking.
  Worker processes heartbeat via IPC; main process forwards to `workflowRunManager`.
- `linkedInAccountHealthStore` — still lives in main process. Worker reports health events
  over IPC; main process updates the store and broadcasts to the UI.
- The durable scheduler loop (`startDueDurableWorkflowJobs`) — still claims jobs and enforces
  account-level blocking. It dispatches to the manager instead of spawning a child directly.
