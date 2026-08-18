'use strict';

const {
  createId,
  resolveInternalStatePath
} = require('./connect-documents');
const { randomUUID } = require('crypto');
const JsonWorkflowRepository = require('./storage/json-workflow-repository');

const STORE_VERSION = 1;
const RUN_STATUSES = new Set(['queued', 'running', 'waiting', 'completed', 'failed', 'paused', 'cancelled']);
const JOB_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'paused', 'cancelled']);
const DEFAULT_JOB_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_JOB_MAX_ATTEMPTS = 3;

class WorkflowRunManager {
  constructor(options = {}) {
    this.runsPath = options.runsPath || resolveInternalStatePath('workflow-runs.json');
    this.jobsPath = options.jobsPath || resolveInternalStatePath('workflow-step-jobs.json');
    this.repo = options.repo || new JsonWorkflowRepository({
      runsPath: this.runsPath,
      jobsPath: this.jobsPath
    });
  }

  getAllRuns() {
    return this.repo.readRuns().runs
      .map((run) => normalizeRunRecord(run))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  getRun(runId) {
    return this.getAllRuns().find((run) => run.id === runId) || null;
  }

  getJobs(runId = null) {
    return this.repo.readJobs().jobs
      .map((job) => normalizeJobRecord(job))
      .filter((job) => !runId || job.runId === runId)
      .sort((left, right) => new Date(left.scheduledFor).getTime() - new Date(right.scheduledFor).getTime());
  }

  createRun(runInput = {}) {
    return this.repo.transact((runsStore, jobsStore) => {
      const now = new Date().toISOString();
      const normalizedRun = normalizeRunForCreate(runInput, now);
      const initialStep = resolveNextExecutableStep(normalizedRun.steps, 0);
      const targetIds = [];
      const firstJobs = initialStep.step
        ? normalizedRun.targets.map((target, targetIndex) => {
          const job = normalizeJobForCreate({
            runId: normalizedRun.id,
            rootCorrelationId: normalizedRun.correlationId,
            workflowId: normalizedRun.workflowId,
            workflowName: normalizedRun.workflowName,
            accountId: normalizedRun.accountId,
            accountName: normalizedRun.accountName,
            agentId: normalizedRun.agentId,
            agentName: normalizedRun.agentName,
            targetId: createTargetId(normalizedRun.id, targetIndex),
            targetIndex,
            prospectId: target.prospectId,
            targetValue: target.profileUrl || target.value,
            targetLabel: target.label || target.value,
            stepIndex: initialStep.index,
            stepType: initialStep.step.type,
            step: initialStep.step,
            scheduledFor: addDelay(now, initialStep.delayMs)
          }, now);
          targetIds.push(job.targetId);
          return job;
        })
        : [];

      normalizedRun.targets = normalizedRun.targets.map((target, index) => ({
        ...target,
        targetId: targetIds[index],
        status: firstJobs.length ? 'queued' : 'completed',
        currentStepIndex: initialStep.index,
        lastError: null,
        nextRunAt: firstJobs[index]?.scheduledFor || null,
        completedAt: firstJobs.length ? null : now
      }));

      runsStore.runs.unshift(normalizedRun);
      jobsStore.jobs.push(...firstJobs);

      return {
        run: normalizedRun,
        jobs: firstJobs
      };
    });
  }

  claimDueJobs(options = {}) {
    const before = options.before || new Date().toISOString();
    const blockedAccountIds = new Set(Array.isArray(options.blockedAccountIds) ? options.blockedAccountIds.filter(Boolean) : []);
    const blockedRunIds = new Set(Array.isArray(options.blockedRunIds) ? options.blockedRunIds.filter(Boolean) : []);
    const prospectScores = options.prospectScores instanceof Map
      ? options.prospectScores
      : new Map(Object.entries(
        options.prospectScores && typeof options.prospectScores === 'object' && !Array.isArray(options.prospectScores)
          ? options.prospectScores
          : {}
      ));
    const limit = Math.max(1, Number(options.limit) || 1);
    const leaseMs = Math.max(60000, Number(options.leaseMs) || DEFAULT_JOB_LEASE_MS);
    const leaseOwner = cleanString(options.leaseOwner, 160) || `workflow-runner-${process.pid}`;

    // Fetch ~5× the claim limit (floor 50) so per-account-once + per-run-once
    // dedup has headroom to find an eligible job when the queue is dominated
    // by one account/run. Higher than necessary just means a slightly wider
    // SQL read; lower can cause us to claim fewer jobs than we could have.
    // The targeted SQL path uses idx_workflow_jobs_claim (see
    // SqliteWorkflowRepository.transactDueJobs) so the cost is bounded by
    // candidateFetchLimit, not by total job count.
    const candidateFetchLimit = Math.max(50, limit * 5);

    return this.repo.transactDueJobs({ before, candidateFetchLimit }, (runsStore, jobsStore) => {
      const claimed = [];
      const claimedAccounts = new Set();
      const claimedRuns = new Set();
      const affectedRunIds = new Set();
      const now = new Date().toISOString();

      for (const job of jobsStore.jobs) {
        const recovered = reclaimExpiredJob(job, now, before, leaseMs);
        if (!recovered) continue;
        affectedRunIds.add(job.runId);
        updateRunTargetStateInStore(runsStore, job.runId, job.targetId, recovered.targetUpdates);
      }

      // A workflow run is intentionally target-serial: complete the entire
      // sequence for the first non-terminal target before opening the next
      // profile. Keeping the later targets' initial jobs durable but
      // ineligible preserves crash recovery without producing breadth-first
      // behavior (view everyone, then like everyone, then connect everyone).
      const runsById = new Map(
        runsStore.runs.map((run) => {
          const normalizedRun = normalizeRunRecord(run);
          return [normalizedRun.id, normalizedRun];
        })
      );

      const eligibleJobs = jobsStore.jobs
        .filter((job) => {
          const run = runsById.get(job.runId);
          if (job.status === 'paused') return false;
          if (job.status !== 'queued') return false;
          if (new Date(job.scheduledFor).getTime() > new Date(before).getTime()) return false;
          if (run?.drainPending === true) return false;
          if (job.accountId && blockedAccountIds.has(job.accountId)) return false;
          if (blockedRunIds.has(job.runId)) return false;
          const activeTargetIndex = resolveEarliestActiveTargetIndex(run);
          if (activeTargetIndex != null && Number(job.targetIndex || 0) !== activeTargetIndex) return false;
          return true;
        })
        .sort((left, right) => compareClaimableJobs(left, right, prospectScores));

      for (const job of eligibleJobs) {
        if (claimed.length >= limit) break;
        if (job.accountId && claimedAccounts.has(job.accountId)) continue;
        if (claimedRuns.has(job.runId)) continue;

        job.status = 'running';
        job.startedAt = now;
        job.updatedAt = now;
        job.attempts = Number(job.attempts || 0) + 1;
        job.leaseOwner = leaseOwner;
        job.lastHeartbeatAt = now;
        job.leaseExpiresAt = addDelay(now, leaseMs);
        // Fresh UUID per claim. The dispatcher holds this in closure for the
        // round-trip; completeJob/failJob/heartbeatJob verify it to refuse
        // stale results from workers whose lease has been reclaimed.
        job.claimUuid = randomUUID();
        claimed.push(normalizeJobRecord(job));
        if (job.accountId) claimedAccounts.add(job.accountId);
        claimedRuns.add(job.runId);
        affectedRunIds.add(job.runId);
        updateRunTargetStateInStore(runsStore, job.runId, job.targetId, {
          status: 'running',
          currentStepIndex: job.stepIndex,
          lastError: null,
          nextRunAt: null
        });
      }

      Array.from(new Set([...affectedRunIds, ...claimedRuns])).forEach((runId) => {
        applyRunStatusRefreshInStore(runsStore, jobsStore, runId);
      });

      return claimed;
    });
  }

  heartbeatJob(jobId, options = {}) {
    return this.repo.transactJobsOnly((jobsStore) => {
      const jobIndex = jobsStore.jobs.findIndex((job) => job.id === jobId);
      if (jobIndex === -1) {
        return null;
      }

      const leaseMs = Math.max(60000, Number(options.leaseMs) || DEFAULT_JOB_LEASE_MS);
      const leaseOwner = cleanString(options.leaseOwner, 160) || null;
      const claimUuid = cleanString(options.claimUuid, 64) || null;
      const job = jobsStore.jobs[jobIndex];
      if (job.status !== 'running') {
        return null;
      }
      if (leaseOwner && job.leaseOwner && leaseOwner !== job.leaseOwner) {
        return null;
      }
      // Same shape as the leaseOwner check: only refuses when BOTH sides
      // carry a value AND they differ. Pre-migration jobs (stored uuid is
      // null) and legacy callers (no uuid passed) flow through unchanged.
      if (claimUuid && job.claimUuid && claimUuid !== job.claimUuid) {
        logStaleClaimRefusal('heartbeatJob', jobId, claimUuid, job.claimUuid);
        return null;
      }

      const now = new Date().toISOString();
      job.updatedAt = now;
      job.lastHeartbeatAt = now;
      job.leaseOwner = leaseOwner || job.leaseOwner || null;
      job.leaseExpiresAt = addDelay(now, leaseMs);
      return normalizeJobRecord(job);
    });
  }

  retryJob(jobId, options = {}) {
    return this.repo.transact((runsStore, jobsStore) => {
      const jobIndex = jobsStore.jobs.findIndex((job) => job.id === jobId);
      if (jobIndex === -1) {
        return null;
      }

      const job = jobsStore.jobs[jobIndex];
      if (job.status === 'completed' || job.status === 'cancelled') {
        return null;
      }
      if (Number(job.attempts || 0) >= resolveJobMaxAttempts(job)) {
        return null;
      }

      const now = new Date().toISOString();
      const retriedJob = requeueJobRecord(job, now, options.reason, options.delayMs);
      jobsStore.jobs[jobIndex] = retriedJob;
      updateRunTargetStateInStore(runsStore, retriedJob.runId, retriedJob.targetId, {
        status: 'waiting',
        currentStepIndex: retriedJob.stepIndex,
        lastError: null,
        nextRunAt: retriedJob.scheduledFor
      });
      applyRunStatusRefreshInStore(runsStore, jobsStore, retriedJob.runId);
      return normalizeJobRecord(retriedJob);
    });
  }

  completeJob(jobId, result = {}, options = {}) {
    return this.finishJob(jobId, 'completed', result, options);
  }

  failJob(jobId, error = {}, options = {}) {
    const status = options.cancelled ? 'cancelled' : 'failed';
    return this.finishJob(jobId, status, error, options);
  }

  // Permanently removes a run and all its jobs from the store. Refuses to
  // delete a run that is still actively executing — the caller must cancel
  // it first.
  deleteRun(runId) {
    return this.repo.transact((runsStore, jobsStore) => {
      const existing = runsStore.runs.find((run) => run.id === runId);
      if (!existing) return { deleted: false, reason: 'Run not found' };
      const status = String(existing.status || '').toLowerCase();
      if (status === 'running' || status === 'paused' || status === 'queued') {
        return { deleted: false, reason: `Run is ${status} — cancel it first` };
      }
      const beforeRuns = runsStore.runs.length;
      const beforeJobs = jobsStore.jobs.length;
      runsStore.runs = runsStore.runs.filter((run) => run.id !== runId);
      jobsStore.jobs = jobsStore.jobs.filter((job) => job.runId !== runId);
      return {
        deleted: true,
        runsRemoved: beforeRuns - runsStore.runs.length,
        jobsRemoved: beforeJobs - jobsStore.jobs.length,
      };
    });
  }

  cancelRun(runId, reason = 'Cancelled by user') {
    return this.repo.transact((runsStore, jobsStore) => {
      const now = new Date().toISOString();
      let changed = false;

      runsStore.runs = runsStore.runs.map((run) => {
        if (run.id !== runId) return run;
        changed = true;
        return {
          ...run,
          status: 'cancelled',
          updatedAt: now,
          lastError: reason
        };
      });

      jobsStore.jobs = jobsStore.jobs.map((job) => {
        if (job.runId !== runId || (job.status !== 'queued' && job.status !== 'running')) return job;
        changed = true;
        return {
          ...job,
          status: 'cancelled',
          updatedAt: now,
          errorMessage: reason
        };
      });

      return { cancelled: changed };
    });
  }

  pauseRun(runId, options = {}) {
    return this.repo.transact((runsStore, jobsStore) => {
      const runIndex = runsStore.runs.findIndex((entry) => entry.id === runId);
      if (runIndex === -1) {
        return null;
      }

      const now = new Date().toISOString();
      const pauseReason = cleanString(options.reason, 600) || 'Paused';

      jobsStore.jobs = jobsStore.jobs.map((job) => {
        if (job.runId !== runId || job.status !== 'queued') {
          return job;
        }

        return {
          ...job,
          status: 'paused',
          updatedAt: now,
          startedAt: null,
          completedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null,
          errorMessage: null,
          result: {}
        };
      });

      const existingRun = runsStore.runs[runIndex];
      runsStore.runs[runIndex] = {
        ...existingRun,
        status: 'paused',
        pauseReason,
        updatedAt: now
      };

      applyRunStatusRefreshInStore(runsStore, jobsStore, runId);
      return normalizeRunRecord(runsStore.runs[runIndex]);
    });
  }

  resumeRun(runId) {
    return this.repo.transact((runsStore, jobsStore) => {
      const runIndex = runsStore.runs.findIndex((entry) => entry.id === runId);
      if (runIndex === -1) {
        return null;
      }

      const now = new Date().toISOString();
      const hasPausedJobs = jobsStore.jobs.some((job) => job.runId === runId && job.status === 'paused');
      const existingRun = runsStore.runs[runIndex];
      if (existingRun.status !== 'paused' && !hasPausedJobs) {
        return normalizeRunRecord(existingRun);
      }

      jobsStore.jobs = jobsStore.jobs.map((job) => {
        if (job.runId !== runId || job.status !== 'paused') {
          return job;
        }

        return {
          ...job,
          status: 'queued',
          updatedAt: now,
          startedAt: null,
          completedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null,
          errorMessage: null,
          result: {}
        };
      });

      runsStore.runs[runIndex] = {
        ...existingRun,
        status: 'waiting',
        pauseReason: null,
        updatedAt: now
      };

      applyRunStatusRefreshInStore(runsStore, jobsStore, runId);
      return normalizeRunRecord(runsStore.runs[runIndex]);
    });
  }

  drainWorkflowRun(runId, reason = 'Drain requested') {
    return this.repo.transact((runsStore, jobsStore) => {
      const runIndex = runsStore.runs.findIndex((entry) => entry.id === runId);
      if (runIndex === -1) {
        return null;
      }

      const now = new Date().toISOString();
      const normalizedReason = cleanString(reason, 600) || 'Drain requested';
      const cancelledTargetIds = new Set();

      jobsStore.jobs = jobsStore.jobs.map((job) => {
        if (job.runId !== runId || job.status !== 'queued') {
          return job;
        }

        cancelledTargetIds.add(job.targetId);
        return {
          ...job,
          status: 'cancelled',
          updatedAt: now,
          completedAt: now,
          startedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null,
          errorMessage: normalizedReason,
          result: {}
        };
      });

      cancelledTargetIds.forEach((targetId) => {
        updateRunTargetStateInStore(runsStore, runId, targetId, {
          status: 'cancelled',
          completedAt: now,
          lastError: normalizedReason,
          nextRunAt: null
        });
      });

      const existingRun = runsStore.runs[runIndex];
      runsStore.runs[runIndex] = {
        ...existingRun,
        drainPending: true,
        drainReason: normalizedReason,
        drainRequestedAt: existingRun.drainRequestedAt || now,
        drainCompletedAt: null,
        updatedAt: now
      };

      applyRunStatusRefreshInStore(runsStore, jobsStore, runId);
      return normalizeRunRecord(runsStore.runs[runIndex]);
    });
  }

  queueNextStep(params = {}) {
    const {
      runId,
      targetId,
      nextStepIndex,
      scheduledFor,
      prospectId,
      targetValue,
      targetLabel
    } = params;

    return this.repo.transact((runsStore, jobsStore) => {
      const runRecord = runsStore.runs.find((entry) => entry.id === runId);
      if (!runRecord) {
        throw new Error(`Workflow run not found: ${runId}`);
      }
      const run = normalizeRunRecord(runRecord);
      if (run.drainPending) {
        return null;
      }

      const step = run.steps[nextStepIndex];
      if (!step) {
        throw new Error(`Workflow step not found at index ${nextStepIndex}`);
      }

      const now = new Date().toISOString();
      const job = normalizeJobForCreate({
        runId,
        rootCorrelationId: run.correlationId,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        accountId: run.accountId,
        accountName: run.accountName,
        agentId: run.agentId,
        agentName: run.agentName,
        targetId,
        targetIndex: resolveTargetIndex(run, targetId),
        prospectId,
        targetValue,
        targetLabel,
        stepIndex: nextStepIndex,
        stepType: step.type,
        step,
        scheduledFor: scheduledFor || now
      }, now);

      jobsStore.jobs.push(job);
      updateRunTargetStateInStore(runsStore, runId, targetId, {
        status: 'waiting',
        currentStepIndex: nextStepIndex,
        lastError: null,
        nextRunAt: job.scheduledFor
      });

      return job;
    });
  }

  markTargetCompleted(runId, targetId) {
    return this.repo.transact((runsStore, jobsStore) => {
      updateRunTargetStateInStore(runsStore, runId, targetId, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        nextRunAt: null
      });
      return applyRunStatusRefreshInStore(runsStore, jobsStore, runId);
    });
  }

  markTargetFailed(runId, targetId, reason) {
    return this.repo.transact((runsStore, jobsStore) => {
      updateRunTargetStateInStore(runsStore, runId, targetId, {
        status: 'failed',
        lastError: reason || 'Unknown error',
        nextRunAt: null
      });
      return applyRunStatusRefreshInStore(runsStore, jobsStore, runId);
    });
  }

  markTargetCancelled(runId, targetId, reason = 'Cancelled') {
    return this.repo.transact((runsStore, jobsStore) => {
      updateRunTargetStateInStore(runsStore, runId, targetId, {
        status: 'cancelled',
        completedAt: new Date().toISOString(),
        lastError: reason || 'Cancelled',
        nextRunAt: null
      });
      return applyRunStatusRefreshInStore(runsStore, jobsStore, runId);
    });
  }

  refreshRunStatus(runId) {
    return this.repo.transact((runsStore, jobsStore) => {
      return applyRunStatusRefreshInStore(runsStore, jobsStore, runId);
    });
  }

  updateRunMetadata(runId, updates = {}) {
    return this.repo.transact((runsStore, jobsStore) => {
      const runIndex = runsStore.runs.findIndex((entry) => entry.id === runId);
      if (runIndex === -1) return null;
      const next = {
        ...runsStore.runs[runIndex],
        ...updates,
        updatedAt: new Date().toISOString()
      };
      runsStore.runs[runIndex] = next;
      return normalizeRunRecord(next);
    });
  }

  finishJob(jobId, finalStatus, payload = {}, options = {}) {
    return this.repo.transact((runsStore, jobsStore) => {
      const jobIndex = jobsStore.jobs.findIndex((job) => job.id === jobId);
      if (jobIndex === -1) {
        return null;
      }

      // Claim-UUID verification.
      //   • Operator cancellation (options.cancelled) bypasses the check —
      //     cancellation intent wins over claim ownership.
      //   • Otherwise: refuse the operation when BOTH sides carry a uuid AND
      //     they differ. This is the stale-completion-after-reclaim race the
      //     UUID was added to prevent.
      //   • Pre-migration in-flight jobs (stored uuid null) and legacy
      //     callers (no uuid provided) flow through unchanged for
      //     backward compat.
      const storedClaimUuid = jobsStore.jobs[jobIndex].claimUuid || null;
      const expectedClaimUuid = cleanString(options.claimUuid, 64) || null;
      if (
        options.cancelled !== true
        && expectedClaimUuid
        && storedClaimUuid
        && expectedClaimUuid !== storedClaimUuid
      ) {
        logStaleClaimRefusal(`finishJob:${finalStatus}`, jobId, expectedClaimUuid, storedClaimUuid);
        return null;
      }

      const now = new Date().toISOString();
      const nextJob = {
        ...jobsStore.jobs[jobIndex],
        status: JOB_STATUSES.has(finalStatus) ? finalStatus : 'failed',
        updatedAt: now,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        // Clear claim_uuid on terminal state. Lingering tokens on
        // completed/failed/cancelled rows would just be debugging noise —
        // the terminal status itself proves ownership history is over.
        claimUuid: null,
        result: payload && typeof payload === 'object' ? { ...payload } : {},
        errorMessage: cleanString(payload?.reason || payload?.message, 600) || null
      };
      jobsStore.jobs[jobIndex] = nextJob;

      updateRunTargetStateInStore(runsStore, nextJob.runId, nextJob.targetId, {
        status: finalStatus === 'completed' ? 'running' : finalStatus,
        currentStepIndex: nextJob.stepIndex,
        lastError: nextJob.errorMessage,
        nextRunAt: null
      });

      applyRunStatusRefreshInStore(runsStore, jobsStore, nextJob.runId);
      return normalizeJobRecord(nextJob);
    });
  }

  updateRunTargetState(runId, targetId, updates = {}) {
    return this.repo.transact((runsStore, jobsStore) => {
      updateRunTargetStateInStore(runsStore, runId, targetId, updates);
      return normalizeRunRecord(runsStore.runs.find((r) => r.id === runId));
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level pure helper — extracted from refreshRunStatus, no I/O.
// Mutates runsStore in-place and returns the normalized run (or null).
// ---------------------------------------------------------------------------

function applyRunStatusRefreshInStore(runsStore, jobsStore, runId) {
  const run = runsStore.runs.find((entry) => entry.id === runId);
  if (!run) return null;
  const jobs = jobsStore.jobs.filter((job) => job.runId === runId);
  const activeQueued = jobs.filter((job) => job.status === 'queued' || job.status === 'running');
  const totalTargets = Array.isArray(run.targets) ? run.targets.length : 0;
  const completedTargets = Array.isArray(run.targets) ? run.targets.filter((target) => target.status === 'completed').length : 0;
  const failedTargets = Array.isArray(run.targets) ? run.targets.filter((target) => target.status === 'failed').length : 0;
  const cancelledTargets = Array.isArray(run.targets) ? run.targets.filter((target) => target.status === 'cancelled').length : 0;

  run.summary = {
    totalTargets,
    completedTargets,
    failedTargets,
    cancelledTargets
  };

  if (run.drainPending === true) {
    if (!activeQueued.length && completedTargets + failedTargets + cancelledTargets >= totalTargets) {
      run.status = 'cancelled';
      run.completedAt = run.completedAt || new Date().toISOString();
      run.drainPending = false;
      run.drainCompletedAt = run.drainCompletedAt || new Date().toISOString();
      run.lastError = run.drainReason || run.lastError || null;
    } else if (jobs.some((job) => job.status === 'running')) {
      run.status = 'running';
    } else if (jobs.some((job) => job.status === 'queued')) {
      run.status = 'waiting';
    }
  } else if (run.status !== 'cancelled' && run.status !== 'paused') {
    if (!activeQueued.length && completedTargets + failedTargets + cancelledTargets >= totalTargets) {
      run.status = failedTargets > 0 ? 'failed' : 'completed';
      run.completedAt = new Date().toISOString();
    } else if (jobs.some((job) => job.status === 'running')) {
      run.status = 'running';
    } else if (jobs.some((job) => job.status === 'queued')) {
      run.status = 'waiting';
    }
  }

  run.updatedAt = new Date().toISOString();
  return normalizeRunRecord(run);
}

// ---------------------------------------------------------------------------
// Pure helper functions (no I/O)
// ---------------------------------------------------------------------------

function normalizeRunForCreate(runInput = {}, now = new Date().toISOString()) {
  const steps = Array.isArray(runInput.steps) ? runInput.steps.map((step) => normalizeStep(step)) : [];
  if (!steps.length) {
    throw new Error('Workflow run requires at least one step');
  }

  const targets = normalizeTargets(runInput.targets || runInput.groupMembers || []);
  if (!targets.length) {
    throw new Error('Workflow run requires at least one target');
  }

  return {
    id: cleanString(runInput.id, 160) || createId('run'),
    correlationId: cleanString(runInput.correlationId, 160) || createId('corr_run'),
    campaignRunId: cleanString(runInput.campaignRunId, 160) || null,
    workflowId: cleanString(runInput.workflowId, 160) || null,
    workflowName: cleanString(runInput.workflowName, 160) || 'Workflow Run',
    accountId: cleanString(runInput.accountId, 120) || null,
    accountName: cleanString(runInput.accountName, 160) || null,
    agentId: cleanString(runInput.agentId, 120) || null,
    agentName: cleanString(runInput.agentName, 160) || null,
    targetType: cleanString(runInput.targetType, 40) || 'group',
    bypassWorkingHours: Boolean(runInput.bypassWorkingHours),
    headless: Boolean(runInput.headless),
    // Provenance marker. 'external_api' makes the worker treat this run as
    // visible-only (fails closed if headless). Defaults null for native runs.
    launchSource: cleanString(runInput.launchSource, 40) || null,
    browserProfile: cleanString(runInput.browserProfile, 80) || 'random',
    slowMo: Math.max(0, Number(runInput.slowMo) || 50),
    steps,
    targets,
    status: 'queued',
    summary: {
      totalTargets: targets.length,
      completedTargets: 0,
      failedTargets: 0,
      cancelledTargets: 0
    },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    lastError: null,
    drainPending: false,
    drainReason: null,
    drainRequestedAt: null,
    drainCompletedAt: null
  };
}

function normalizeJobForCreate(jobInput = {}, now = new Date().toISOString()) {
  return {
    id: cleanString(jobInput.id, 160) || createId('job'),
    correlationId: cleanString(jobInput.correlationId, 160) || createId('corr_job'),
    rootCorrelationId:
      cleanString(jobInput.rootCorrelationId, 160)
      || cleanString(jobInput.correlationId, 160)
      || null,
    runId: cleanString(jobInput.runId, 160),
    workflowId: cleanString(jobInput.workflowId, 160) || null,
    workflowName: cleanString(jobInput.workflowName, 160) || null,
    accountId: cleanString(jobInput.accountId, 120) || null,
    accountName: cleanString(jobInput.accountName, 160) || null,
    agentId: cleanString(jobInput.agentId, 120) || null,
    agentName: cleanString(jobInput.agentName, 160) || null,
    targetId: cleanString(jobInput.targetId, 160),
    targetIndex: Math.max(0, Number(jobInput.targetIndex) || 0),
    prospectId: cleanString(jobInput.prospectId, 160) || null,
    targetValue: cleanString(jobInput.targetValue, 400),
    targetLabel: cleanString(jobInput.targetLabel, 240) || cleanString(jobInput.targetValue, 240),
    stepIndex: Math.max(0, Number(jobInput.stepIndex) || 0),
    stepType: cleanString(jobInput.stepType, 80),
    step: normalizeStep(jobInput.step || {}),
    scheduledFor: cleanString(jobInput.scheduledFor, 80) || now,
    status: 'queued',
    attempts: 0,
    maxAttempts: Math.max(1, Number(jobInput.maxAttempts) || DEFAULT_JOB_MAX_ATTEMPTS),
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastHeartbeatAt: null,
    errorMessage: null,
    result: {}
  };
}

function normalizeRunRecord(run = {}) {
  return {
    ...run,
    status: RUN_STATUSES.has(run.status) ? run.status : 'queued',
    campaignRunId: cleanString(run.campaignRunId, 160) || null,
    pauseReason: cleanString(run.pauseReason, 600) || null,
    drainPending: run.drainPending === true,
    drainReason: cleanString(run.drainReason, 600) || null,
    drainRequestedAt: cleanString(run.drainRequestedAt, 80) || null,
    drainCompletedAt: cleanString(run.drainCompletedAt, 80) || null,
    steps: Array.isArray(run.steps) ? run.steps.map((step) => normalizeStep(step)) : [],
    targets: Array.isArray(run.targets) ? run.targets.map((target) => ({
      targetId: cleanString(target.targetId, 160),
      prospectId: cleanString(target.prospectId, 160) || null,
      value: cleanString(target.value, 400),
      label: cleanString(target.label, 240) || cleanString(target.value, 240),
      profileUrl: cleanString(target.profileUrl, 400) || null,
      // Preserve search provenance across read-normalization so the scheduler
      // can stamp searchRank/source onto activity events (carried in targets_json).
      searchProvenance: normalizeTargetSearchProvenance(target.searchProvenance),
      status: cleanString(target.status, 40) || 'queued',
      currentStepIndex: Math.max(0, Number(target.currentStepIndex) || 0),
      lastError: cleanString(target.lastError, 600) || null,
      nextRunAt: cleanString(target.nextRunAt, 80) || null,
      completedAt: cleanString(target.completedAt, 80) || null
    })) : []
  };
}

function normalizeJobRecord(job = {}) {
  return {
    ...job,
    status: JOB_STATUSES.has(job.status) ? job.status : 'queued',
    prospectId: cleanString(job.prospectId, 160) || null,
    maxAttempts: Math.max(1, Number(job.maxAttempts) || DEFAULT_JOB_MAX_ATTEMPTS),
    step: normalizeStep(job.step || {})
  };
}

function compareClaimableJobs(left, right, prospectScores) {
  const scoreDifference = resolveProspectScore(right, prospectScores) - resolveProspectScore(left, prospectScores);
  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  const scheduledDifference = compareIsoAsc(left.scheduledFor, right.scheduledFor);
  if (scheduledDifference !== 0) {
    return scheduledDifference;
  }

  const targetDifference = (Number(left.targetIndex) || 0) - (Number(right.targetIndex) || 0);
  if (targetDifference !== 0) {
    return targetDifference;
  }

  const createdDifference = compareIsoAsc(left.createdAt, right.createdAt);
  if (createdDifference !== 0) {
    return createdDifference;
  }

  return String(left.id || '').localeCompare(String(right.id || ''));
}

function resolveEarliestActiveTargetIndex(run) {
  if (!run || !Array.isArray(run.targets)) {
    return null;
  }

  const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
  for (let index = 0; index < run.targets.length; index += 1) {
    const status = String(run.targets[index]?.status || 'queued').trim().toLowerCase();
    if (!terminalStatuses.has(status)) {
      return index;
    }
  }
  return null;
}

function resolveProspectScore(job, prospectScores) {
  const prospectId = cleanString(job?.prospectId, 160);
  if (!prospectId) {
    return 0;
  }
  const rawScore = prospectScores instanceof Map
    ? prospectScores.get(prospectId)
    : null;
  const numeric = Number(rawScore);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return numeric;
}

function compareIsoAsc(leftIso, rightIso) {
  const left = new Date(leftIso).getTime();
  const right = new Date(rightIso).getTime();
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return 0;
  }
  return left - right;
}

function updateRunTargetStateInStore(runsStore, runId, targetId, updates = {}) {
  const runIndex = runsStore.runs.findIndex((entry) => entry.id === runId);
  if (runIndex === -1) {
    return;
  }

  const run = runsStore.runs[runIndex];
  run.targets = Array.isArray(run.targets) ? run.targets.map((target) => {
    if (target.targetId !== targetId) return target;
    return {
      ...target,
      ...updates
    };
  }) : [];
  run.updatedAt = new Date().toISOString();
  runsStore.runs[runIndex] = run;
}

function reclaimExpiredJob(job, now, before, leaseMs) {
  if (job.status !== 'running' || !isJobLeaseExpired(job, before, leaseMs)) {
    return null;
  }

  const reason = Number(job.attempts || 0) >= resolveJobMaxAttempts(job)
    ? 'Workflow step lease expired after maximum retry attempts'
    : 'Recovered interrupted workflow step after lease expiration';

  if (Number(job.attempts || 0) >= resolveJobMaxAttempts(job)) {
    job.status = 'failed';
    job.updatedAt = now;
    job.completedAt = now;
    job.errorMessage = cleanString(reason, 600) || reason;
    job.result = {};
    clearJobLease(job);
    return {
      targetUpdates: {
        status: 'failed',
        currentStepIndex: job.stepIndex,
        lastError: job.errorMessage,
        nextRunAt: null
      }
    };
  }

  const retriedJob = requeueJobRecord(job, now, reason, 0);
  Object.assign(job, retriedJob);
  return {
    targetUpdates: {
      status: 'waiting',
      currentStepIndex: job.stepIndex,
      lastError: null,
      nextRunAt: job.scheduledFor
    }
  };
}

function requeueJobRecord(job, now, reason = null, delayMs = 0) {
  return {
    ...job,
    status: 'queued',
    scheduledFor: addDelay(now, Math.max(0, Number(delayMs) || 0)),
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    errorMessage: cleanString(reason, 600) || null,
    result: {},
    leaseOwner: null,
    leaseExpiresAt: null,
    lastHeartbeatAt: null,
    // Clear the old token. Next claim cycle generates a fresh UUID so the
    // previous worker's late results can no longer overwrite the new claim.
    claimUuid: null
  };
}

function clearJobLease(job) {
  job.leaseOwner = null;
  job.leaseExpiresAt = null;
  job.lastHeartbeatAt = null;
  // Match requeueJobRecord: clearing the lease without a fresh claim
  // means subsequent in-flight results from the old worker should be refused.
  job.claimUuid = null;
}

// Stale-claim refusal log. Logs jobId, operation, and 8-char hex prefixes of
// the two UUIDs so an operator can grep without exposing the full token.
// Format intentionally machine-parseable for future telemetry promotion.
function logStaleClaimRefusal(op, jobId, expected, stored) {
  const expPrefix = String(expected || '').slice(0, 8) || '(empty)';
  const storedPrefix = String(stored || '').slice(0, 8) || '(empty)';
  process.stderr.write(
    `[workflow-run-manager] ${op} refused stale claim for job ${jobId}: `
    + `expected=${expPrefix}… stored=${storedPrefix}…\n`
  );
}

function resolveJobMaxAttempts(job = {}) {
  return Math.max(1, Number(job.maxAttempts) || DEFAULT_JOB_MAX_ATTEMPTS);
}

function isJobLeaseExpired(job = {}, beforeIso = new Date().toISOString(), leaseMs = DEFAULT_JOB_LEASE_MS) {
  const expiryCandidate = cleanString(job.leaseExpiresAt, 80)
    || (job.startedAt ? addDelay(job.startedAt, leaseMs) : null);
  if (!expiryCandidate) {
    return false;
  }

  const expiryTime = new Date(expiryCandidate).getTime();
  const beforeTime = new Date(beforeIso).getTime();
  if (Number.isNaN(expiryTime) || Number.isNaN(beforeTime)) {
    return false;
  }

  return expiryTime <= beforeTime;
}

function normalizeTargets(values) {
  return values
    .map((value) => {
      const raw = typeof value === 'string' ? value : value?.value || value?.url || value?.name || '';
      const cleaned = cleanString(raw, 400);
      if (!cleaned) return null;
      return {
        prospectId: cleanString(value?.prospectId, 160) || null,
        value: cleaned,
        label: cleanString(value?.label, 240) || cleaned,
        profileUrl: cleanString(value?.profileUrl, 400) || null,
        // Provenance object passes through opaquely (already normalized
        // upstream by people-search-results.normalizeSearchProvenance). Stored
        // in the run's free-form targets_json so it survives SQLite round-trips
        // and is readable by the scheduler at activity-event time.
        searchProvenance: normalizeTargetSearchProvenance(value?.searchProvenance)
      };
    })
    .filter(Boolean);
}

/**
 * Pass-through guard for a target's search provenance. Keeps WorkflowRunManager
 * decoupled from the search module: it does not re-derive the shape, only
 * accepts a plain object (or null). The canonical shape is produced upstream.
 */
function normalizeTargetSearchProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = cleanString(value.source || value.searchSource, 80) || null;
  return {
    ...value,
    ...(source ? { source, searchSource: source } : {})
  };
}

function normalizeStep(step = {}) {
  const sequenceId = cleanString(
    step.sequenceId
    || step.apolloSequenceId
    || step.sequence?.id,
    160
  ) || null;
  return {
    order: Math.max(1, Number(step.order) || 1),
    type: cleanString(step.type, 80),
    delayValue: Math.max(1, Number(step.delayValue) || 1),
    delayUnit: cleanString(step.delayUnit, 40) || 'hours',
    minDelayMs: Math.max(0, Number(step.minDelayMs) || 0),
    maxDelayMs: Math.max(0, Number(step.maxDelayMs) || Number(step.minDelayMs) || 0),
    messageTemplate: cleanString(step.messageTemplate, 1200),
    sequenceId,
    apolloSequenceId: sequenceId,
    sequenceName: cleanString(step.sequenceName || step.sequence?.name, 200) || null,
    emailAccountId: cleanString(step.emailAccountId, 160) || null,
    metadata: normalizeStepMetadata(step.metadata)
  };
}

function normalizeStepMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return { ...value };
}

function resolveNextExecutableStep(steps, startIndex) {
  let delayMs = 0;
  for (let index = Math.max(0, Number(startIndex) || 0); index < steps.length; index += 1) {
    const step = normalizeStep(steps[index]);
    if (step.type === 'delay') {
      delayMs += Math.max(0, Number(step.maxDelayMs || step.minDelayMs) || 0);
      continue;
    }
    return { index, step, delayMs };
  }
  return { index: steps.length, step: null, delayMs };
}

function addDelay(baseIso, delayMs) {
  const base = new Date(baseIso);
  const next = new Date(base.getTime() + Math.max(0, Number(delayMs) || 0));
  return next.toISOString();
}

function resolveTargetIndex(run, targetId) {
  const index = Array.isArray(run.targets) ? run.targets.findIndex((target) => target.targetId === targetId) : -1;
  return index >= 0 ? index : 0;
}

function createTargetId(runId, targetIndex) {
  return `${runId}_target_${targetIndex + 1}`;
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = WorkflowRunManager;
