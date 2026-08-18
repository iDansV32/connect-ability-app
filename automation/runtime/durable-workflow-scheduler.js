'use strict';

/**
 * Durable workflow scheduler core — extracted from main.js for testability.
 *
 * Create an instance with createDurableWorkflowScheduler(deps).
 * All Electron-specific side-effects (BrowserWindow.send, app.isReady, file-system
 * helpers that live in main.js) are supplied as injected functions so this module
 * can run in raw Node tests without booting the Electron app.
 */

const {
  createWorkflowStepResult,
  isWorkflowStepFailure,
  isWorkflowStepSkipped,
  shouldStopWorkflowAfterStepResult,
  shouldRetryWorkflowStepResult,
  didWorkflowStepPerformAction,
  getWorkflowStepEventStatus
} = require('../../workflow-step-result');
const { resolveDerivedWorkflowActivityEvents } = require('../../workflow-derived-events');
const { ACCOUNT_WORKER_MESSAGE_TYPES } = require('./account-worker-protocol');

// ---------------------------------------------------------------------------
// Pure helpers (no I/O, no injection required)
// ---------------------------------------------------------------------------

function mapWorkflowStepToEventType(stepType) {
  switch (stepType) {
    case 'view_profile':   return 'profile_viewed';
    case 'like_posts':     return 'post_liked';
    case 'send_connection': return 'connection_requested';
    case 'send_dm':        return 'dm_sent';
    case 'follow_profile':   return 'profile_followed';
    case 'unfollow_profile': return 'profile_unfollowed';
    case 'endorse_skills': return 'skill_endorsed';
    case 'comment_on_post': return 'post_commented';
    default:               return null;
  }
}

function chooseDelayMs(minDelayMs, maxDelayMs) {
  const floor = Math.max(0, Math.floor(Number(minDelayMs) || 0));
  const ceil  = Math.max(floor, Math.floor(Number(maxDelayMs) || floor));
  if (ceil <= floor) return floor;
  return floor + Math.floor(Math.random() * (ceil - floor + 1));
}

function applySchedulingJitter(delayMs) {
  const base = Math.max(0, Number(delayMs) || 0);
  if (base < 60000) return base;
  const jitterFraction = 0.85 + (Math.random() * 0.30);
  return Math.round(base * jitterFraction);
}

function addDelayToIso(isoTimestamp, delayMs) {
  const base = new Date(isoTimestamp || Date.now());
  const next = new Date(base.getTime() + Math.max(0, Number(delayMs) || 0));
  return next.toISOString();
}

function resolveNextExecutableStep(run, startingIndex) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  let accumulatedDelayMs = 0;

  for (let index = Math.max(0, Number(startingIndex) || 0); index < steps.length; index += 1) {
    const step = steps[index] || {};
    if (step.type === 'delay') {
      accumulatedDelayMs += chooseDelayMs(step.minDelayMs, step.maxDelayMs);
      continue;
    }
    return {
      nextStepIndex: index,
      nextStep: step,
      accumulatedDelayMs: applySchedulingJitter(accumulatedDelayMs)
    };
  }
  return {
    nextStepIndex: steps.length,
    nextStep: null,
    accumulatedDelayMs: applySchedulingJitter(accumulatedDelayMs)
  };
}

function buildWorkflowCorrelationContext(run = {}, job = {}, extra = {}) {
  const correlationId     = extra.correlationId     || job?.correlationId     || run?.correlationId     || null;
  const rootCorrelationId = extra.rootCorrelationId || job?.rootCorrelationId || run?.correlationId || correlationId || null;
  return {
    accountId:      extra.accountId      || job?.accountId      || run?.accountId      || null,
    accountName:    extra.accountName    || job?.accountName    || run?.accountName    || null,
    workflowId:     extra.workflowId     || job?.workflowId     || run?.workflowId     || run?.id  || null,
    workflowName:   extra.workflowName   || job?.workflowName   || run?.workflowName   || null,
    runId:          extra.runId          || job?.runId          || run?.id             || null,
    targetId:       extra.targetId       || job?.targetId       || null,
    prospectId:     extra.prospectId     || job?.prospectId     || null,
    stepIndex:      Number.isFinite(Number(extra.stepIndex)) ? Number(extra.stepIndex) : job?.stepIndex,
    stepType:       extra.stepType       || job?.stepType       || null,
    correlationId,
    rootCorrelationId,
    source:         extra.source         || 'workflow-runtime',
    metadata:       extra.metadata && typeof extra.metadata === 'object' ? extra.metadata : {}
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAIN_PROCESS_WORKFLOW_STEP_TYPES = new Set(['apollo_enroll_sequence']);
const DURABLE_WORKFLOW_JOB_LEASE_MS   = 5  * 60 * 1000;
const DURABLE_WORKFLOW_RETRY_DELAY_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * @param {object} deps
 * @param {object}   deps.workflowRunManager
 * @param {object}   deps.accountWorkerProcessManager
 * @param {object}   deps.linkedInAccountHealthStore
 * @param {object}   deps.prospectQueueStore
 * @param {object}   deps.sdrAgentManager
 * @param {object}   deps.campaignController
 * @param {Function} deps.isWithinWorkingHours        (account, now) => bool
 * @param {Function} deps.scoreProspect               (prospect, agent) => {score}
 * @param {Function} deps.loadLinkedInCredentials     async (accountId) => credentials|null
 * @param {Function} deps.ensureLinkedInAccountsStore () => {accounts:[]}
 * @param {Function} deps.recordActivityEvent         (eventInput) => void
 * @param {Function} deps.updateProspectWorkflowProgress (prospectId, progress) => prospect|null
 * @param {Function} deps.emitWorkflowLog             (message, type, extra) => void
 * @param {Function} deps.onRunStatusChange           (status:'completed'|'failed', runId) => void
 * @param {Function} deps.broadcastWorkflowRunsUpdated (accountId?) => void
 * @param {Function} deps.broadcastCampaignRunsUpdated (accountId?) => void
 * @param {Function} deps.broadcastProspectsUpdated   (accountId?) => void
 * @param {Function} deps.retryApolloHeldRuns         async () => void
 * @param {Function} deps.processApolloCampaignPolls  async () => void
 * @param {Function} deps.registerRuntimeJob          ({jobId, type, accountId, accountName, process, meta}) => void
 * @param {Function} deps.unregisterRuntimeJob        (jobId) => void
 * @param {Function} deps.createRuntimeJobId          (type, accountId) => string
 * @param {Function} deps.recordWorkflowHealthSuccess (accountId) => void
 * @param {Function} deps.recordWorkflowHealthFailure (accountId, reasonOrError, meta?) => void
 *     `reasonOrError` may be a string or an Error/payload object with
 *     `.httpStatus` / `.retryAfterMs` / `.retryAfterHeader` for 429-aware
 *     cooldown handling. See main.js#recordLinkedInWorkflowHealthFailure.
 * @param {Function} [deps.isAppReady]                () => bool  (defaults to () => true)
 */
function createDurableWorkflowScheduler(deps) {
  const {
    workflowRunManager,
    accountWorkerProcessManager,
    linkedInAccountHealthStore,
    prospectQueueStore,
    sdrAgentManager,
    campaignController,
    isWithinWorkingHours,
    scoreProspect,
    loadLinkedInCredentials,
    ensureLinkedInAccountsStore,
    recordActivityEvent,
    updateProspectWorkflowProgress,
    emitWorkflowLog,
    onRunStatusChange,
    broadcastWorkflowRunsUpdated,
    broadcastCampaignRunsUpdated,
    broadcastProspectsUpdated,
    retryApolloHeldRuns,
    processApolloCampaignPolls,
    registerRuntimeJob,
    unregisterRuntimeJob,
    createRuntimeJobId,
    recordWorkflowHealthSuccess,
    recordWorkflowHealthFailure,
    isAppReady = () => true
  } = deps;

  // Active job registry: jobId → runtimeMeta
  const activeJobs = new Map();
  let schedulerBusy = false;

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function emitStructuredLog(payload = {}) {
    const message = typeof payload.message === 'string' ? payload.message : null;
    if (message) {
      emitWorkflowLog(message, payload.type || 'info', payload);
    }
  }

  function shouldRunInMainProcess(stepType) {
    return MAIN_PROCESS_WORKFLOW_STEP_TYPES.has(String(stepType || '').trim().slice(0, 80));
  }

  function shouldTrackLinkedInHealth(stepType) {
    return !shouldRunInMainProcess(stepType);
  }

  // Pull bio fields out of a step result's metadata.bio (set by action-router
  // on view_profile steps) so we can persist them onto the prospect record.
  function extractBioFromStepResult(stepResult) {
    const bio = stepResult && stepResult.metadata && stepResult.metadata.bio;
    if (!bio || typeof bio !== 'object') return null;
    const fullName = typeof bio.fullName === 'string' ? bio.fullName.trim() : null;
    const title = typeof bio.title === 'string' ? bio.title.trim() : null;
    const company = typeof bio.company === 'string' ? bio.company.trim() : null;
    const location = typeof bio.location === 'string' ? bio.location.trim() : null;
    if (!fullName && !title && !company && !location) return null;
    return { fullName, title, company, location };
  }

  function scheduleNextStep(run, job, stepResult) {
    if (run?.drainPending) {
      workflowRunManager.markTargetCancelled(run.id, job.targetId, run.drainReason || 'Drain requested');
      emitWorkflowLog(
        `Skipped remaining steps for ${job.targetLabel || job.targetValue} because "${run.workflowName}" is draining.`,
        'warning',
        buildWorkflowCorrelationContext(run, job, { metadata: { drainReason: run.drainReason || null } })
      );
      return null;
    }

    const bio = extractBioFromStepResult(stepResult);
    const screenshotPath = stepResult && stepResult.metadata && stepResult.metadata.screenshotPath || null;

    const nextAction = resolveNextExecutableStep(run, job.stepIndex + 1);
    if (!nextAction.nextStep) {
      workflowRunManager.markTargetCompleted(run.id, job.targetId);
      updateProspectWorkflowProgress(job.prospectId, {
        accountId:   run.accountId,
        accountName: run.accountName,
        agentId:     run.agentId,
        agentName:   run.agentName,
        fullName:    (bio && bio.fullName) || stepResult?.recipientName || job.targetLabel || job.targetValue,
        title:       bio && bio.title || undefined,
        company:     bio && bio.company || undefined,
        profileUrl:  stepResult?.profileUrl    || job.targetValue,
        state: 'completed',
        workflowAssignment: {
          workflowId:   run.workflowId || run.id,
          workflowName: run.workflowName,
          runId:        run.id,
          targetId:     job.targetId,
          targetType:   run.targetType || null,
          assignedAt:   new Date().toISOString()
        },
        metadata: {
          completedAt:     new Date().toISOString(),
          lastOutcomeType: stepResult?.outcomeType || 'completed',
          ...(screenshotPath ? { lastScreenshotPath: screenshotPath } : {}),
          ...(bio && bio.location ? { location: bio.location } : {})
        }
      });
      emitWorkflowLog(
        `Completed target ${job.targetLabel || job.targetValue} in "${run.workflowName}".`,
        'success',
        buildWorkflowCorrelationContext(run, job)
      );
      return null;
    }

    // Mid-sequence success: also enrich the prospect record so later steps
    // (and the UI) immediately see the captured bio.
    if (bio || screenshotPath) {
      updateProspectWorkflowProgress(job.prospectId, {
        accountId:   run.accountId,
        accountName: run.accountName,
        agentId:     run.agentId,
        agentName:   run.agentName,
        fullName:    (bio && bio.fullName) || stepResult?.recipientName || job.targetLabel || job.targetValue,
        title:       bio && bio.title || undefined,
        company:     bio && bio.company || undefined,
        profileUrl:  stepResult?.profileUrl    || job.targetValue,
        workflowAssignment: {
          workflowId:   run.workflowId || run.id,
          workflowName: run.workflowName,
          runId:        run.id,
          targetId:     job.targetId,
          targetType:   run.targetType || null,
          assignedAt:   new Date().toISOString()
        },
        metadata: {
          ...(screenshotPath ? { lastScreenshotPath: screenshotPath } : {}),
          ...(bio && bio.location ? { location: bio.location } : {})
        }
      });
    }

    const scheduledFor = addDelayToIso(new Date().toISOString(), nextAction.accumulatedDelayMs);
    const nextJob = workflowRunManager.queueNextStep({
      runId:         run.id,
      targetId:      job.targetId,
      prospectId:    job.prospectId,
      nextStepIndex: nextAction.nextStepIndex,
      scheduledFor,
      targetValue: stepResult?.profileUrl    || job.targetValue,
      targetLabel: stepResult?.recipientName || job.targetLabel || job.targetValue
    });

    if (!nextJob) {
      workflowRunManager.markTargetCancelled(run.id, job.targetId, run.drainReason || 'Drain requested');
      emitWorkflowLog(
        `Skipped remaining steps for ${job.targetLabel || job.targetValue} because "${run.workflowName}" is draining.`,
        'warning',
        buildWorkflowCorrelationContext(run, job, { metadata: { drainReason: run.drainReason || null } })
      );
      return null;
    }

    const relativeDelay = nextAction.accumulatedDelayMs > 0
      ? ` after ${Math.round(nextAction.accumulatedDelayMs / 3600000 * 10) / 10}h`
      : '';
    emitWorkflowLog(
      `Queued step ${nextJob.stepIndex + 1} (${nextJob.stepType}) for ${nextJob.targetLabel || nextJob.targetValue}${relativeDelay}.`,
      'info',
      buildWorkflowCorrelationContext(run, nextJob, {
        metadata: { previousStepCorrelationId: job?.correlationId || null }
      })
    );
    return nextJob;
  }

  function recordStepEvents(run, job, stepResult, success, reason = null) {
    const normalizedStepResult = createWorkflowStepResult({
      ...stepResult,
      stepType:      stepResult?.stepType      || job.stepType,
      profileUrl:    stepResult?.profileUrl    || job.targetValue,
      recipientName: stepResult?.recipientName || job.targetLabel || job.targetValue,
      reason:        reason || stepResult?.reason || stepResult?.error || null
    });
    const baseEvent = {
      accountId:      run.accountId,
      accountName:    run.accountName,
      agentId:        run.agentId,
      agentName:      run.agentName,
      workflowId:     run.workflowId || run.id,
      workflowName:   run.workflowName,
      runId:          run.id,
      correlationId:     job.correlationId     || run.correlationId || null,
      rootCorrelationId: job.rootCorrelationId || run.correlationId || null,
      targetId:   job.targetId,
      prospectId: job.prospectId || null,
      targetValue: normalizedStepResult.recipientName || job.targetLabel || job.targetValue,
      profileUrl:  normalizedStepResult.profileUrl    || null
    };

    // Search provenance for this target — looked up from the run's targets
    // (carried in targets_json) by the job's targetId. Spread flat into action
    // event metadata so a like/connect event can be traced back to the exact
    // People-search rank that produced the target. {} when the target was not
    // search-sourced.
    const matchedTarget = Array.isArray(run.targets)
      ? run.targets.find((t) => t && t.targetId === job.targetId)
      : null;
    const searchProvenanceMeta = (matchedTarget && matchedTarget.searchProvenance && typeof matchedTarget.searchProvenance === 'object')
      ? { ...matchedTarget.searchProvenance }
      : {};

    recordActivityEvent({
      ...baseEvent,
      type:   success ? 'workflow_step_completed' : 'workflow_step_failed',
      status: getWorkflowStepEventStatus(normalizedStepResult),
      metadata: {
        correlationId:     job.correlationId     || run.correlationId || null,
        rootCorrelationId: job.rootCorrelationId || run.correlationId || null,
        stepIndex:  job.stepIndex,
        stepType:   job.stepType,
        targetType: run.targetType || null,
        recipientName: normalizedStepResult.recipientName || job.targetLabel || null,
        reason:        normalizedStepResult.reason        || null,
        outcomeType:   normalizedStepResult.outcomeType,
        ...searchProvenanceMeta,
        ...normalizedStepResult.metadata
      }
    });

    const derivedEvents = resolveDerivedWorkflowActivityEvents(run, job, normalizedStepResult);
    derivedEvents.forEach((eventInput) => recordActivityEvent(eventInput));

    const activityType = mapWorkflowStepToEventType(job.stepType);
    if (success && activityType && didWorkflowStepPerformAction(normalizedStepResult)) {
      recordActivityEvent({
        ...baseEvent,
        type:   activityType,
        status: 'ok',
        metadata: {
          correlationId:     job.correlationId     || run.correlationId || null,
          rootCorrelationId: job.rootCorrelationId || run.correlationId || null,
          stepIndex:  job.stepIndex,
          stepType:   job.stepType,
          targetType: run.targetType || null,
          recipientName: normalizedStepResult.recipientName || job.targetLabel || null,
          outcomeType:   normalizedStepResult.outcomeType,
          ...searchProvenanceMeta,
          ...normalizedStepResult.metadata
        }
      });
    }
  }

  function finalizeRun(run, previousStatus) {
    const refreshedRun = workflowRunManager.refreshRunStatus(run.id);
    if (!refreshedRun) return null;

    if (refreshedRun.campaignRunId) {
      try {
        campaignController.notifyChildRunFinalized(refreshedRun.campaignRunId, refreshedRun.id);
        broadcastCampaignRunsUpdated(refreshedRun.accountId || null);
      } catch (error) {
        console.error(`Failed to reconcile campaign run ${refreshedRun.campaignRunId} after child finalization:`, error);
      }
    }

    if (previousStatus !== refreshedRun.status) {
      if (refreshedRun.status === 'completed') {
        recordActivityEvent({
          type:        'workflow_completed',
          accountId:   refreshedRun.accountId,
          accountName: refreshedRun.accountName,
          agentId:     refreshedRun.agentId,
          agentName:   refreshedRun.agentName,
          workflowId:  refreshedRun.workflowId || refreshedRun.id,
          workflowName: refreshedRun.workflowName,
          runId:       refreshedRun.id,
          correlationId:     refreshedRun.correlationId || null,
          rootCorrelationId: refreshedRun.correlationId || null,
          status: 'ok',
          metadata: {
            ...refreshedRun.summary,
            correlationId:     refreshedRun.correlationId || null,
            rootCorrelationId: refreshedRun.correlationId || null
          }
        });
        onRunStatusChange('completed', refreshedRun.id);
      } else if (refreshedRun.status === 'failed') {
        recordActivityEvent({
          type:        'workflow_failed',
          accountId:   refreshedRun.accountId,
          accountName: refreshedRun.accountName,
          agentId:     refreshedRun.agentId,
          agentName:   refreshedRun.agentName,
          workflowId:  refreshedRun.workflowId || refreshedRun.id,
          workflowName: refreshedRun.workflowName,
          runId:       refreshedRun.id,
          correlationId:     refreshedRun.correlationId || null,
          rootCorrelationId: refreshedRun.correlationId || null,
          status: 'failed',
          metadata: {
            ...refreshedRun.summary,
            lastError:         refreshedRun.lastError    || null,
            correlationId:     refreshedRun.correlationId || null,
            rootCorrelationId: refreshedRun.correlationId || null
          }
        });
        onRunStatusChange('failed', refreshedRun.id);
      }
    }

    broadcastWorkflowRunsUpdated();
    return refreshedRun;
  }

  /**
   * Build the error-like object recordWorkflowHealthFailure consumes when
   * a step ends in failure. Combines the textual reason with optional
   * structured fields (httpStatus, retryAfterMs, retryAfterHeader) from
   * the worker IPC payload so the wrapper can resolve a Retry-After-aware
   * cooldown instead of taking the policy default 6-hour severeCooldownMs.
   *
   * Returns a plain string when no structured fields are present — that
   * keeps backward compat with the legacy signature for the trivial case.
   */
  function buildHealthFailurePayload(reasonText, errorMeta) {
    if (!errorMeta || typeof errorMeta !== 'object') return reasonText;
    const payload = { message: reasonText || null };
    if (Number.isFinite(Number(errorMeta.httpStatus))) payload.httpStatus = Number(errorMeta.httpStatus);
    if (Number.isFinite(Number(errorMeta.retryAfterMs)) && Number(errorMeta.retryAfterMs) > 0) {
      payload.retryAfterMs = Number(errorMeta.retryAfterMs);
    }
    if (typeof errorMeta.retryAfterHeader === 'string' && errorMeta.retryAfterHeader.trim()) {
      payload.retryAfterHeader = errorMeta.retryAfterHeader;
    }
    return payload;
  }

  async function handleJobClose(job, runtimeMeta, stepResult, exitCode, errorMeta = null) {
    const run = workflowRunManager.getRun(job.runId);
    if (!run) {
      activeJobs.delete(job.id);
      unregisterRuntimeJob(runtimeMeta.runtimeJobId);
      return;
    }

    let refreshedRun = null;
    const workflowAccountId = job.accountId || run.accountId || runtimeMeta.accountId || null;
    const trackHealth = shouldTrackLinkedInHealth(job.stepType);

    try {
      const previousStatus = run.status;
      const normalizedStepResult = stepResult
        ? createWorkflowStepResult({
            ...stepResult,
            stepType:      stepResult.stepType      || job.stepType,
            profileUrl:    stepResult.profileUrl    || job.targetValue,
            recipientName: stepResult.recipientName || job.targetLabel || job.targetValue,
            metadata: {
              ...(stepResult.metadata && typeof stepResult.metadata === 'object' ? stepResult.metadata : {}),
              correlationId:     job.correlationId     || run.correlationId || null,
              rootCorrelationId: job.rootCorrelationId || run.correlationId || null
            }
          })
        : null;

      const cancelled = runtimeMeta.cancelled || workflowRunManager.getRun(job.runId)?.status === 'cancelled';
      const reason = cancelled
        ? 'Cancelled by user'
        : (normalizedStepResult?.reason || stepResult?.error
            || (exitCode === 0 ? 'Workflow step did not return a result' : `Workflow step exited with code ${exitCode}`));

      const shouldRetry = !cancelled && (
        !normalizedStepResult || shouldRetryWorkflowStepResult(normalizedStepResult)
      );
      const retriedJob = shouldRetry
        ? workflowRunManager.retryJob(job.id, { reason, delayMs: DURABLE_WORKFLOW_RETRY_DELAY_MS })
        : null;

      if (cancelled) {
        workflowRunManager.failJob(job.id, { reason }, { cancelled: true });
        workflowRunManager.markTargetFailed(run.id, job.targetId, reason);
        updateProspectWorkflowProgress(job.prospectId, {
          accountId:   run.accountId,
          accountName: run.accountName,
          agentId:     run.agentId,
          agentName:   run.agentName,
          fullName:    job.targetLabel || job.targetValue,
          profileUrl:  job.targetValue,
          state: 'failed',
          workflowAssignment: {
            workflowId:   run.workflowId || run.id,
            workflowName: run.workflowName,
            runId:        run.id,
            targetId:     job.targetId,
            targetType:   run.targetType || null,
            assignedAt:   new Date().toISOString()
          },
          metadata: { lastReason: reason, cancelled: true }
        });
        emitWorkflowLog(
          `Cancelled step ${job.stepIndex + 1} (${job.stepType}) for ${job.targetLabel || job.targetValue}.`,
          'warning',
          buildWorkflowCorrelationContext(run, job)
        );
      } else if (normalizedStepResult && !isWorkflowStepFailure(normalizedStepResult)) {
        workflowRunManager.completeJob(job.id, normalizedStepResult, { claimUuid: job.claimUuid });
        recordStepEvents(run, job, normalizedStepResult, true);
        if (trackHealth) recordWorkflowHealthSuccess(workflowAccountId);

        const drainedRun = workflowRunManager.getRun(run.id);
        const isDraining = drainedRun?.drainPending === true;

        if (isWorkflowStepSkipped(normalizedStepResult)) {
          emitWorkflowLog(
            `Skipped step ${job.stepIndex + 1} (${job.stepType}) for ${job.targetLabel || job.targetValue}: ${normalizedStepResult.reason || normalizedStepResult.outcomeType}.`,
            'warning',
            buildWorkflowCorrelationContext(run, job)
          );
        }

        if (isDraining) {
          workflowRunManager.markTargetCancelled(run.id, job.targetId, drainedRun?.drainReason || 'Drain requested');
          emitWorkflowLog(
            `Stopped remaining steps for ${job.targetLabel || job.targetValue} because "${run.workflowName}" is draining.`,
            'warning',
            buildWorkflowCorrelationContext(run, job, { metadata: { drainReason: drainedRun?.drainReason || null } })
          );
        } else if (shouldStopWorkflowAfterStepResult(normalizedStepResult)) {
          workflowRunManager.markTargetCompleted(run.id, job.targetId);
          updateProspectWorkflowProgress(job.prospectId, {
            accountId:   run.accountId,
            accountName: run.accountName,
            agentId:     run.agentId,
            agentName:   run.agentName,
            fullName:    normalizedStepResult.recipientName || job.targetLabel || job.targetValue,
            profileUrl:  normalizedStepResult.profileUrl    || job.targetValue,
            state: 'completed',
            workflowAssignment: {
              workflowId:   run.workflowId || run.id,
              workflowName: run.workflowName,
              runId:        run.id,
              targetId:     job.targetId,
              targetType:   run.targetType || null,
              assignedAt:   new Date().toISOString()
            },
            metadata: {
              completedAt:               new Date().toISOString(),
              lastOutcomeType:           normalizedStepResult.outcomeType              || null,
              duplicateAvoided:          true,
              duplicateAvoidanceReason:  normalizedStepResult.reason                  || null,
              blockingAgentId:           normalizedStepResult.metadata?.blockingAgentId   || null,
              blockingAccountId:         normalizedStepResult.metadata?.blockingAccountId  || null,
              blockingContactStage:      normalizedStepResult.metadata?.blockingContactStage || null
            }
          });
          emitWorkflowLog(
            `Stopped remaining steps for ${job.targetLabel || job.targetValue}: ${normalizedStepResult.reason || normalizedStepResult.outcomeType}.`,
            'info',
            buildWorkflowCorrelationContext(run, job)
          );
        } else {
          scheduleNextStep(run, job, normalizedStepResult);
        }
      } else if (retriedJob) {
        if (trackHealth) recordWorkflowHealthFailure(workflowAccountId, buildHealthFailurePayload(reason, errorMeta));
        emitWorkflowLog(
          `Step ${job.stepIndex + 1} (${job.stepType}) for ${job.targetLabel || job.targetValue} will retry: ${reason}.`,
          'warning',
          buildWorkflowCorrelationContext(run, job)
        );
      } else {
        workflowRunManager.failJob(job.id, { reason }, { claimUuid: job.claimUuid });
        workflowRunManager.markTargetFailed(run.id, job.targetId, reason);
        updateProspectWorkflowProgress(job.prospectId, {
          accountId:   run.accountId,
          accountName: run.accountName,
          agentId:     run.agentId,
          agentName:   run.agentName,
          fullName:    job.targetLabel || job.targetValue,
          profileUrl:  job.targetValue,
          state: 'failed',
          workflowAssignment: {
            workflowId:   run.workflowId || run.id,
            workflowName: run.workflowName,
            runId:        run.id,
            targetId:     job.targetId,
            targetType:   run.targetType || null,
            assignedAt:   new Date().toISOString()
          },
          metadata: { lastReason: reason }
        });
        recordStepEvents(run, job, normalizedStepResult || {
          stepType:      job.stepType,
          profileUrl:    job.targetValue,
          recipientName: job.targetLabel || job.targetValue,
          outcomeType:   'failed_permanent',
          reason
        }, false, reason);
        if (trackHealth) recordWorkflowHealthFailure(workflowAccountId, buildHealthFailurePayload(reason, errorMeta));
        emitWorkflowLog(
          `Step ${job.stepIndex + 1} failed for ${job.targetLabel || job.targetValue}: ${reason}`,
          'error',
          buildWorkflowCorrelationContext(run, job)
        );
      }

      refreshedRun = finalizeRun(run, previousStatus);
    } catch (error) {
      console.error('Failed to finalize durable workflow step:', error);
      workflowRunManager.failJob(job.id, { reason: error.message }, { claimUuid: job.claimUuid });
      workflowRunManager.markTargetFailed(run.id, job.targetId, error.message);
      updateProspectWorkflowProgress(job.prospectId, {
        accountId:   run.accountId,
        accountName: run.accountName,
        agentId:     run.agentId,
        agentName:   run.agentName,
        fullName:    job.targetLabel || job.targetValue,
        profileUrl:  job.targetValue,
        state: 'failed',
        workflowAssignment: {
          workflowId:   run.workflowId || run.id,
          workflowName: run.workflowName,
          runId:        run.id,
          targetId:     job.targetId,
          targetType:   run.targetType || null,
          assignedAt:   new Date().toISOString()
        },
        metadata: { lastReason: error.message }
      });
      if (trackHealth) recordWorkflowHealthFailure(workflowAccountId, error);
      refreshedRun = finalizeRun(run, run.status);
    } finally {
      if (runtimeMeta.heartbeatInterval) {
        clearInterval(runtimeMeta.heartbeatInterval);
      }
      activeJobs.delete(job.id);
      unregisterRuntimeJob(runtimeMeta.runtimeJobId);

      try {
        if (runtimeMeta.configPath) {
          const fs = require('fs');
          if (fs.existsSync(runtimeMeta.configPath)) {
            fs.unlinkSync(runtimeMeta.configPath);
          }
        }
      } catch (cleanupError) {
        console.error('Failed to clean durable workflow config:', cleanupError);
      }
    }

    if (refreshedRun?.status === 'waiting' || refreshedRun?.status === 'running') {
      setTimeout(() => {
        startDueDurableWorkflowJobs().catch((error) => {
          console.error('Failed to continue durable workflow processing:', error);
        });
      }, 250);
    }
  }

  async function executeMainProcessApolloJob(job, run) {
    const runtimeJobId = createRuntimeJobId('durable-workflow-step', job.accountId || run.accountId || 'apollo');
    const runtimeMeta = {
      runId:             run.id,
      accountId:         job.accountId || run.accountId || null,
      runtimeJobId,
      configPath:        null,
      leaseOwner:        job.leaseOwner || `durable-scheduler-${process.pid}`,
      heartbeatInterval: null,
      worker:            null,
      cancelled:         false
    };

    activeJobs.set(job.id, runtimeMeta);
    registerRuntimeJob({
      jobId:       runtimeJobId,
      type:        'durable-workflow-step',
      accountId:   job.accountId  || run.accountId  || null,
      accountName: job.accountName || run.accountName || null,
      process:     null,
      meta: {
        runId:        run.id,
        workflowId:   run.workflowId || run.id,
        stepIndex:    job.stepIndex,
        stepType:     job.stepType,
        targetId:     job.targetId,
        executionMode: 'main-process'
      }
    });

    emitWorkflowLog(
      `Running step ${job.stepIndex + 1} (${job.stepType}) for ${job.targetLabel || job.targetValue} in "${run.workflowName}".`,
      'info',
      buildWorkflowCorrelationContext(run, job, { metadata: { executionMode: 'main-process' } })
    );

    let stepResult = null;
    let exitCode   = 0;

    try {
      const execution = await campaignController.executeApolloEnrollmentStep({
        campaignRunId: run.campaignRunId,
        workflowRun:   run,
        job
      });
      stepResult = execution?.stepResult || null;
      exitCode   = stepResult && isWorkflowStepFailure(stepResult) ? 1 : 0;
    } catch (error) {
      stepResult = createWorkflowStepResult({
        stepType:      job.stepType,
        outcomeType:   'failed_transient',
        reason:        error.message || String(error),
        profileUrl:    job.targetValue,
        recipientName: job.targetLabel || job.targetValue,
        metadata: { source: 'apollo_main_process', unexpectedError: true }
      });
      exitCode = 1;
    }

    await handleJobClose(job, runtimeMeta, stepResult, exitCode).catch((error) => {
      console.error('Failed handling durable Apollo workflow job close:', error);
    });
  }

  async function executeDurableWorkflowJob(job) {
    const run = workflowRunManager.getRun(job.runId);
    if (!run) {
      workflowRunManager.failJob(job.id, { reason: 'Workflow run not found' }, { claimUuid: job.claimUuid });
      return;
    }

    if (shouldRunInMainProcess(job.stepType)) {
      await executeMainProcessApolloJob(job, run);
      return;
    }

    const credentials = await loadLinkedInCredentials(job.accountId || run.accountId || null);
    if (!credentials?.email || !credentials?.password) {
      const reason = 'LinkedIn credentials not found for workflow account';
      recordWorkflowHealthFailure(job.accountId || run.accountId || null, reason);
      workflowRunManager.failJob(job.id, { reason }, { claimUuid: job.claimUuid });
      workflowRunManager.markTargetFailed(run.id, job.targetId, reason);
      updateProspectWorkflowProgress(job.prospectId, {
        accountId:   run.accountId,
        accountName: run.accountName,
        agentId:     run.agentId,
        agentName:   run.agentName,
        fullName:    job.targetLabel || job.targetValue,
        profileUrl:  job.targetValue,
        state: 'failed',
        workflowAssignment: {
          workflowId:   run.workflowId || run.id,
          workflowName: run.workflowName,
          runId:        run.id,
          targetId:     job.targetId,
          targetType:   run.targetType || null,
          assignedAt:   new Date().toISOString()
        },
        metadata: { lastReason: reason }
      });
      finalizeRun(run, run.status);
      return;
    }

    // Recheck cooldown right before spawning a worker.  A parallel job may
    // have triggered cooldown between claim time and now.  Returning early
    // lets the retry scheduler pick this job up after cooldown expires.
    const preDispatchAccountId = job.accountId || run.accountId || null;
    const cooldownIds = new Set(linkedInAccountHealthStore.getCoolingDownAccountIds('workflow'));
    const challengedIds = new Set(linkedInAccountHealthStore.getChallengedAccountIds());
    if (cooldownIds.has(preDispatchAccountId) || challengedIds.has(preDispatchAccountId)) {
      const reason = cooldownIds.has(preDispatchAccountId)
        ? 'Account entered cooldown before worker dispatch'
        : 'Account has an active challenge before worker dispatch';
      workflowRunManager.retryJob(job.id, { reason, delayMs: DURABLE_WORKFLOW_RETRY_DELAY_MS });
      emitWorkflowLog(
        `Deferred step ${job.stepIndex + 1} (${job.stepType}) for ${job.targetLabel || job.targetValue}: ${reason}.`,
        'warning',
        buildWorkflowCorrelationContext(run, job)
      );
      activeJobs.delete(job.id);
      return;
    }

    const worker = accountWorkerProcessManager.getOrCreate({
      accountId:            credentials.id            || run.accountId || null,
      accountName:          credentials.name          || credentials.email,
      id:                   credentials.id            || run.accountId || null,
      name:                 credentials.name          || credentials.email,
      email:                credentials.email,
      password:             credentials.password,
      timezoneId:           credentials.timezoneId         || null,
      workingHours:         credentials.workingHours        || null,
      warmUpStartedAt:      credentials.warmUpStartedAt     || null,
      fingerprintProfileSeed: credentials.fingerprintProfileSeed || null,
      delayProfileSeed:     credentials.delayProfileSeed    || null,
      strictStealth:        credentials.strictStealth === true,
      headless:             !!run.headless,
      launchSource:         run.launchSource || null,
      slowMo:               run.slowMo || 50
    });

    const runtimeJobId = createRuntimeJobId('durable-workflow-step', credentials.id || run.accountId || 'default');
    const leaseOwner   = job.leaseOwner || `durable-scheduler-${process.pid}`;
    const runtimeMeta  = {
      runId:             run.id,
      accountId:         credentials.id || run.accountId || null,
      runtimeJobId,
      configPath:        null,
      leaseOwner,
      heartbeatInterval: null,
      worker,
      cancelled:         false
    };

    activeJobs.set(job.id, runtimeMeta);
    registerRuntimeJob({
      jobId:       runtimeJobId,
      type:        'durable-workflow-step',
      accountId:   credentials.id    || run.accountId  || null,
      accountName: credentials.name  || credentials.email,
      process:     null,
      meta: {
        runId:      run.id,
        workflowId: run.workflowId || run.id,
        stepIndex:  job.stepIndex,
        stepType:   job.stepType,
        targetId:   job.targetId
      }
    });

    emitWorkflowLog(
      `Running step ${job.stepIndex + 1} (${job.stepType}) for ${job.targetLabel || job.targetValue} in "${run.workflowName}".`,
      'info',
      buildWorkflowCorrelationContext(run, job)
    );

    const handleWorkerHeartbeat = (payload) => {
      if (payload?.type !== ACCOUNT_WORKER_MESSAGE_TYPES.HEARTBEAT || payload.jobId !== job.id) return;
      try {
        workflowRunManager.heartbeatJob(job.id, {
          leaseMs: DURABLE_WORKFLOW_JOB_LEASE_MS,
          leaseOwner,
          claimUuid: job.claimUuid
        });
      } catch (error) {
        console.error(`Failed to heartbeat durable workflow job ${job.id}:`, error);
      }
    };

    const handleWorkerLog = (payload) => {
      if (payload?.type !== ACCOUNT_WORKER_MESSAGE_TYPES.LOG || payload.jobId !== job.id) return;
      const level   = String(payload.level || 'info').trim().toLowerCase();
      const message = typeof payload.message === 'string' ? payload.message.trim() : '';
      if (!message) return;
      emitStructuredLog({
        ...buildWorkflowCorrelationContext(run, job, {
          source: payload.source || 'workflow-child',
          metadata: {
            processType: 'durable-workflow-step',
            ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {})
          }
        }),
        type: level,
        message
      });
    };

    worker.on('message', handleWorkerHeartbeat);
    worker.on('message', handleWorkerLog);

    let dispatchedResult = null;
    let dispatchError    = null;

    try {
      dispatchedResult = await accountWorkerProcessManager.dispatchAndAwaitResult(
        {
          accountId:   credentials.id   || run.accountId || null,
          accountName: credentials.name || credentials.email,
          id:          credentials.id   || run.accountId || null,
          name:        credentials.name || credentials.email,
          email:       credentials.email,
          password:    credentials.password,
          fingerprintProfileSeed: credentials.fingerprintProfileSeed || null,
          delayProfileSeed:       credentials.delayProfileSeed       || null,
          strictStealth: credentials.strictStealth === true,
          headless:      !!run.headless,
          launchSource:  run.launchSource || null,
          slowMo:        run.slowMo || 50
        },
        {
          type:       ACCOUNT_WORKER_MESSAGE_TYPES.EXECUTE_STEP,
          jobId:      job.id,
          runId:      run.id,
          workflowId: run.workflowId || run.id,
          workflowName: run.workflowName,
          accountId:   credentials.id   || run.accountId  || null,
          accountName: credentials.name || credentials.email,
          agentId:     run.agentId      || null,
          agentName:   run.agentName    || null,
          targetId:    job.targetId,
          prospectId:  job.prospectId   || null,
          targetValue: job.targetValue,
          targetLabel: job.targetLabel,
          correlationId:     job.correlationId     || null,
          rootCorrelationId: job.rootCorrelationId || run.correlationId || null,
          stepIndex: job.stepIndex,
          stepType:  job.stepType,
          step:      job.step,
          // Manual-launch runs ignore the working-hours guard at the action
          // router so steps run immediately even on weekends / off-hours.
          bypassWorkingHours: !!run.bypassWorkingHours
        },
        DURABLE_WORKFLOW_JOB_LEASE_MS
      );
    } catch (error) {
      dispatchError = error;
      if (!runtimeMeta.cancelled) {
        emitWorkflowLog(
          `Workflow step worker error: ${error.message}`,
          'error',
          buildWorkflowCorrelationContext(run, job, { source: 'workflow-worker' })
        );

        // Worker readiness / dispatch failures indicate a broken browser
        // session.  Record a health failure immediately so the cooldown system
        // blocks further retries against this account, and kill the stuck
        // worker so the next attempt (if any) spawns a fresh process.
        const isWorkerInfraFailure =
          /timed out waiting for account worker/i.test(error.message) ||
          /closed before ready/i.test(error.message) ||
          /closed before step result/i.test(error.message) ||
          /is not available/i.test(error.message);
        if (isWorkerInfraFailure) {
          recordWorkflowHealthFailure(preDispatchAccountId, error);
          try {
            accountWorkerProcessManager.killWorker(credentials.email);
          } catch (_) { /* best-effort cleanup */ }
        }
      }
    } finally {
      worker.off('message', handleWorkerHeartbeat);
      worker.off('message', handleWorkerLog);
    }

    await handleJobClose(
      job,
      runtimeMeta,
      dispatchedResult?.stepResult ?? null,
      dispatchError ? 1 : 0,
      // Worker IPC carries optional structured error fields (httpStatus,
      // retryAfterMs, retryAfterHeader) when the step failure originated
      // from a LinkedIn API throw. Plumb them through so the health-
      // failure recorder can honor Retry-After.
      dispatchedResult?.errorMeta ?? null
    ).catch((error) => {
      console.error('Failed handling durable workflow job close:', error);
    });
  }

  function buildDurableWorkflowLeadScores(options = {}) {
    const beforeIso        = String(options.before || new Date().toISOString()).trim().slice(0, 80) || new Date().toISOString();
    const blockedAccountIds = new Set(Array.isArray(options.blockedAccountIds) ? options.blockedAccountIds.filter(Boolean) : []);
    const blockedRunIds     = new Set(Array.isArray(options.blockedRunIds)     ? options.blockedRunIds.filter(Boolean)     : []);

    const dueQueuedJobs = workflowRunManager.getJobs().filter((job) => {
      if (job.status !== 'queued') return false;
      if (new Date(job.scheduledFor).getTime() > new Date(beforeIso).getTime()) return false;
      if (job.accountId && blockedAccountIds.has(job.accountId)) return false;
      if (blockedRunIds.has(job.runId)) return false;
      return true;
    });

    if (!dueQueuedJobs.length) return new Map();

    const agentCache   = new Map();
    const scoreEntries = [];
    const fallbackScores = new Map();

    for (const job of dueQueuedJobs) {
      const prospectId = String(job.prospectId || '').trim().slice(0, 160) || null;
      if (!prospectId) continue;

      const prospect = prospectQueueStore.getProspect(prospectId);
      if (!prospect) continue;

      const agentId = String(job.agentId || prospect.agentId || '').trim().slice(0, 120) || null;
      if (agentId && !agentCache.has(agentId)) {
        agentCache.set(agentId, sdrAgentManager.getAgent(agentId) || null);
      }
      const agent       = agentId ? agentCache.get(agentId) : null;
      const scoreResult = scoreProspect(prospect, agent || {});
      scoreEntries.push(scoreResult);
      fallbackScores.set(prospectId, scoreResult.score);
    }

    if (!scoreEntries.length) return fallbackScores;

    const storedProspects = prospectQueueStore.applyLeadScores(scoreEntries);
    if (storedProspects.length) {
      const accountIds = [
        ...new Set(storedProspects.map((p) => String(p?.accountId || '').trim().slice(0, 120)).filter(Boolean))
      ];
      if (accountIds.length === 1) {
        broadcastProspectsUpdated(accountIds[0]);
      } else {
        broadcastProspectsUpdated();
      }
    }

    const persistedScores = new Map(fallbackScores);
    for (const prospect of storedProspects) {
      const pid = String(prospect.id || prospect.prospectId || '').trim().slice(0, 160) || null;
      if (!pid) continue;
      persistedScores.set(pid, Math.max(0, Number(prospect.score) || 0));
    }
    return persistedScores;
  }

  /**
   * Canonical automation entry point.
   * Mirrors the original startDueDurableWorkflowJobs from main.js.
   */
  async function startDueDurableWorkflowJobs() {
    if (!isAppReady()) return;
    if (schedulerBusy) return;
    schedulerBusy = true;

    try {
      await retryApolloHeldRuns();
      await processApolloCampaignPolls();

      // Accounts whose configured working hours forbid running right now —
      // EXCEPT any account that has an active manual-launch run flagged with
      // bypassWorkingHours. Manual launches are operator-initiated and should
      // start immediately regardless of weekday/hour.
      const outsideHoursAccountIds = (() => {
        try {
          const now = new Date();
          const accounts = ensureLinkedInAccountsStore().accounts;
          const bypassAccountIds = new Set();
          try {
            workflowRunManager.getAllRuns().forEach((run) => {
              const status = String(run && run.status || '').toLowerCase();
              if (status === 'completed' || status === 'failed' || status === 'cancelled') return;
              if (run && run.bypassWorkingHours && run.accountId) {
                bypassAccountIds.add(run.accountId);
              }
            });
          } catch (_) { /* ignore */ }
          return accounts
            .filter((account) => !bypassAccountIds.has(account.id) && !isWithinWorkingHours(account, now))
            .map((account) => account.id)
            .filter(Boolean);
        } catch (_) {
          return [];
        }
      })();

      const blockedAccountIds = Array.from(new Set([
        ...Array.from(activeJobs.values()).map((meta) => meta.accountId).filter(Boolean),
        ...linkedInAccountHealthStore.getCoolingDownAccountIds('workflow'),
        ...linkedInAccountHealthStore.getChallengedAccountIds(),
        ...outsideHoursAccountIds
      ]));
      const blockedRunIds = Array.from(activeJobs.values())
        .map((meta) => meta.runId)
        .filter(Boolean);

      const prospectScores = buildDurableWorkflowLeadScores({
        before: new Date().toISOString(),
        blockedAccountIds,
        blockedRunIds
      });
      // Claim ONE job per tick instead of a batch of 3. Paired with the
      // tail-recursive re-trigger below, throughput is preserved while the
      // cooldown / working-hours / blocked-account gates are re-evaluated
      // between every job. A cooldown (e.g. from a 429 Retry-After) then
      // takes effect on the very next claim instead of after a 3-job batch.
      const dueJobs = workflowRunManager.claimDueJobs({
        before:         new Date().toISOString(),
        limit:          1,
        leaseMs:        DURABLE_WORKFLOW_JOB_LEASE_MS,
        leaseOwner:     `durable-scheduler-${process.pid}`,
        blockedAccountIds,
        blockedRunIds,
        prospectScores
      });

      if (dueJobs.length) {
        broadcastWorkflowRunsUpdated();
      }

      for (const job of dueJobs) {
        await executeDurableWorkflowJob(job);
      }

      // After a productive tick, immediately re-trigger another claim cycle
      // instead of waiting 15s for the setInterval. With limit:1, this keeps
      // per-target execution tight. setImmediate defers past the current
      // callstack so schedulerBusy resets before re-entry.
      if (dueJobs.length > 0) {
        setImmediate(() => {
          startDueDurableWorkflowJobs().catch((err) => {
            console.error('Tail-recursive scheduler tick failed:', err);
          });
        });
      }
    } finally {
      schedulerBusy = false;
    }
  }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  return {
    /**
     * Main scheduler tick — claims and executes due workflow jobs.
     * Called on a setInterval from main.js and on app startup.
     */
    startDueDurableWorkflowJobs,

    /**
     * Execute a single claimed workflow job.
     * Exported separately so IPC handlers can trigger immediate execution.
     */
    executeDurableWorkflowJob,

    /**
     * Access the live active-jobs map.
     * Callers can read .values() to find running jobs by runId/accountId,
     * and can mutate runtimeMeta.cancelled = true to signal cancellation.
     */
    getActiveJobs: () => activeJobs,

    /**
     * Mark all active jobs belonging to a run as cancelled.
     * Called by cancel-sdr-workflow-run IPC handler.
     */
    markRunCancelled(runId) {
      for (const runtimeMeta of activeJobs.values()) {
        if (runtimeMeta.runId === runId) {
          runtimeMeta.cancelled = true;
        }
      }
    },

    /**
     * Mark active jobs matching optional runId and/or accountId as cancelled.
     * Called by stop-group-workflow IPC handler.
     */
    markJobsCancelled({ runId, accountId } = {}) {
      let count = 0;
      for (const runtimeMeta of activeJobs.values()) {
        const matchesRun     = !runId     || runtimeMeta.runId     === runId;
        const matchesAccount = !accountId || runtimeMeta.accountId === accountId;
        if (matchesRun && matchesAccount) {
          runtimeMeta.cancelled = true;
          count += 1;
        }
      }
      return count;
    }
  };
}

module.exports = { createDurableWorkflowScheduler };
