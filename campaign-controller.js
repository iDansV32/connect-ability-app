const CampaignRunManager = require('./campaign-run-manager');
const ApolloPollStore = require('./apollo-poll-store');
const WorkflowRunManager = require('./workflow-run-manager');
const {
  resolveApolloIdentity,
  APOLLO_IDENTITY_CONFIDENCE,
  APOLLO_IDENTITY_OUTCOMES,
  APOLLO_IDENTITY_SOURCES
} = require('./apollo-identity-resolver');
const { createWorkflowStepResult } = require('./workflow-step-result');
const {
  evaluateCrmEligibility,
  DEFAULT_CRM_ELIGIBILITY_RULES
} = require('./crm-eligibility-evaluator');
const {
  interpretPollObservation,
  DEFAULT_APOLLO_POLL_SIGNAL_RULES
} = require('./apollo-poll-signal-interpreter');

const ORPHAN_RECONCILEABLE_CAMPAIGN_STATUSES = new Set(['queued', 'running']);
const TERMINAL_CAMPAIGN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'suppressed', 'quarantined']);
const TERMINAL_WORKFLOW_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_CAMPAIGN_ORPHAN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_APOLLO_HOLD_RETRY_INTERVAL_MS = 60 * 1000;
const DEFAULT_APOLLO_HOLD_MAX_ATTEMPTS = 5;
const DEFAULT_APOLLO_POLL_LIMIT = 5;
const APOLLO_PREFLIGHT_STEP_TYPES = new Set(['apollo_enroll_sequence']);
const APOLLO_IDENTITY_INVALID_INPUT_REASON = 'apollo_identity_invalid_input';
const APOLLO_IDENTITY_UNREACHABLE_REASON = 'apollo_identity_unreachable';
const APOLLO_IDENTITY_AMBIGUOUS_REASON = 'apollo_identity_ambiguous';
const APOLLO_IDENTITY_MEDIUM_CONFIDENCE_REASON = 'apollo_identity_medium_confidence';
const APOLLO_IDENTITY_CONTACT_CREATE_FAILED_REASON = 'apollo_contact_create_failed';

class CampaignController {
  constructor(options = {}) {
    this.campaignRuns = options.campaignRuns || new CampaignRunManager();
    this.apolloPolls = options.apolloPolls || new ApolloPollStore();
    this.workflowRuns = options.workflowRuns || new WorkflowRunManager();
    this.prospects = options.prospects || null;
    this.createApolloClient = typeof options.createApolloClient === 'function'
      ? options.createApolloClient
      : null;
    this.pollApolloExecution = typeof options.pollApolloExecution === 'function'
      ? options.pollApolloExecution
      : null;
    this.crmEligibilityRules = Array.isArray(options.crmEligibilityRules) && options.crmEligibilityRules.length
      ? options.crmEligibilityRules
      : DEFAULT_CRM_ELIGIBILITY_RULES;
    this.apolloPollSignalRules = Array.isArray(options.apolloPollSignalRules) && options.apolloPollSignalRules.length
      ? options.apolloPollSignalRules
      : DEFAULT_APOLLO_POLL_SIGNAL_RULES;
  }

  async createCoordinatedWorkflowRuns(input = {}) {
    const workflowRunInput = input.workflowRunInput && typeof input.workflowRunInput === 'object'
      ? { ...input.workflowRunInput }
      : {};
    const targets = Array.isArray(workflowRunInput.targets)
      ? workflowRunInput.targets.filter((target) => target && typeof target === 'object')
      : [];

    if (!targets.length) {
      throw new Error('workflowRunInput.targets must contain at least one target');
    }

    const sharedApolloContextLoader = shouldRunApolloPreflight(workflowRunInput.steps)
      ? createLazyAsyncValue(() => this.loadApolloEligibilityContext())
      : null;

    const coordinatedRuns = [];
    for (const target of targets) {
      coordinatedRuns.push(await this.createCoordinatedWorkflowRun({
        ...input,
        workflowRunInput: {
          ...workflowRunInput,
          targets: [target]
        },
        campaignRunInput: {
          ...(input.campaignRunInput && typeof input.campaignRunInput === 'object' ? input.campaignRunInput : {}),
          prospectId: input.campaignRunInput?.prospectId || target.prospectId || null,
          prospectLabel: input.campaignRunInput?.prospectLabel || target.label || target.value || null
        },
        sharedApolloContextLoader
      }));
    }

    return {
      coordinatedRuns,
      campaignRuns: coordinatedRuns.map((entry) => entry.campaignRun),
      workflowRuns: coordinatedRuns.map((entry) => entry.workflowRun).filter(Boolean),
      jobs: coordinatedRuns.flatMap((entry) => entry.jobs || [])
    };
  }

  async createCoordinatedWorkflowRun(input = {}) {
    const campaignRunInput = input.campaignRunInput && typeof input.campaignRunInput === 'object'
      ? input.campaignRunInput
      : {};
    const workflowRunInput = input.workflowRunInput && typeof input.workflowRunInput === 'object'
      ? { ...input.workflowRunInput }
      : {};

    const campaignRun = this.campaignRuns.createRun({
      campaignTemplateId: campaignRunInput.campaignTemplateId || workflowRunInput.workflowId || null,
      campaignTemplateName: campaignRunInput.campaignTemplateName || workflowRunInput.workflowName || 'Campaign Run',
      channelType: campaignRunInput.channelType || 'multi',
      accountId: campaignRunInput.accountId || workflowRunInput.accountId || null,
      accountName: campaignRunInput.accountName || workflowRunInput.accountName || null,
      agentId: campaignRunInput.agentId || workflowRunInput.agentId || null,
      agentName: campaignRunInput.agentName || workflowRunInput.agentName || null,
      prospectId: campaignRunInput.prospectId || workflowRunInput.targets?.[0]?.prospectId || null,
      prospectLabel: campaignRunInput.prospectLabel || workflowRunInput.targets?.[0]?.label || workflowRunInput.targets?.[0]?.value || null,
      metadata: normalizeMetadata(campaignRunInput.metadata)
    });

    try {
      const preflight = await this.runApolloPreflight({
        campaignRun,
        workflowRunInput,
        sharedApolloContextLoader: input.sharedApolloContextLoader
      });
      if (!preflight.shouldCreateWorkflow) {
        return {
          campaignRun: preflight.campaignRun || this.campaignRuns.getRun(campaignRun.id) || campaignRun,
          workflowRun: null,
          jobs: []
        };
      }

      const activeCampaignRun = preflight.campaignRun || this.campaignRuns.getRun(campaignRun.id) || campaignRun;
      const createdWorkflow = this.workflowRuns.createRun({
        ...workflowRunInput,
        campaignRunId: activeCampaignRun.id
      });
      const updatedCampaignRun = this.campaignRuns.attachChildRun(activeCampaignRun.id, createdWorkflow.run.id) || activeCampaignRun;
      return {
        campaignRun: updatedCampaignRun,
        workflowRun: createdWorkflow.run,
        jobs: createdWorkflow.jobs
      };
    } catch (error) {
      const currentRun = this.campaignRuns.getRun(campaignRun.id);
      if (currentRun && !TERMINAL_CAMPAIGN_STATUSES.has(currentRun.status)) {
        this.campaignRuns.cancelRun(campaignRun.id, 'workflow_creation_failed');
      }
      throw error;
    }
  }

  reconcileOrphanedCampaignRuns(options = {}) {
    const now = normalizeNow(options.now);
    const orphanOlderThanMs = Math.max(
      0,
      Number(options.orphanOlderThanMs ?? options.olderThanMs) || DEFAULT_CAMPAIGN_ORPHAN_TTL_MS
    );

    return this.campaignRuns.getAllRuns()
      .filter((campaignRun) => ORPHAN_RECONCILEABLE_CAMPAIGN_STATUSES.has(campaignRun.status))
      .filter((campaignRun) => resolveCampaignAgeMs(campaignRun, now) >= orphanOlderThanMs)
      .filter((campaignRun) => this.isCampaignRunOrphaned(campaignRun))
      .map((campaignRun) => this.campaignRuns.cancelRun(campaignRun.id, 'orphaned_on_startup'))
      .filter(Boolean);
  }

  markApolloHold(campaignRunId, holdCause = 'unreachable', options = {}) {
    const campaignRun = this.campaignRuns.getRun(campaignRunId);
    if (!campaignRun) {
      return null;
    }
    const childRuns = this.resolveChildRuns(campaignRun);
    return this.campaignRuns.markApolloHold(campaignRun.id, holdCause, {
      ...options,
      childRuns
    });
  }

  clearApolloHold(campaignRunId) {
    return this.campaignRuns.clearApolloHold(campaignRunId);
  }

  recordApolloEnrollment(campaignRunId, enrollment = {}, options = {}) {
    const campaignRun = this.campaignRuns.recordApolloEnrollment(campaignRunId, enrollment);
    if (!campaignRun) {
      return {
        campaignRun: null,
        pollRecord: null
      };
    }

    const apolloSequenceContactId = cleanString(
      enrollment.apolloSequenceContactId || campaignRun.apolloSequenceContactId,
      160
    ) || null;
    if (!apolloSequenceContactId) {
      return {
        campaignRun,
        pollRecord: null
      };
    }

    const pollRecord = this.apolloPolls.createPollRecord(campaignRun.id, {
      apolloSequenceContactId,
      nextPollAt: options.nextPollAt || enrollment.nextPollAt,
      maxPolls: options.maxPolls,
      pollIntervalMs: options.pollIntervalMs
    });
    const updatedCampaignRun = this.updateCampaignApolloPollingMetadata(campaignRun, pollRecord, null);
    return {
      campaignRun: updatedCampaignRun,
      pollRecord
    };
  }

  async executeApolloEnrollmentStep(input = {}) {
    const workflowRun = input.workflowRun && typeof input.workflowRun === 'object'
      ? input.workflowRun
      : input.run || {};
    const job = input.job && typeof input.job === 'object'
      ? input.job
      : {};
    const campaignRunId = cleanString(input.campaignRunId || workflowRun?.campaignRunId, 160) || null;
    const campaignRun = campaignRunId ? this.campaignRuns.getRun(campaignRunId) : null;
    const step = normalizeApolloEnrollmentStep(input.step || job.step || {});
    const profileUrl = cleanString(input.profileUrl || job.targetValue, 400) || null;
    const recipientName = cleanString(input.recipientName || job.targetLabel || job.targetValue, 200) || null;

    if (!campaignRun) {
      return {
        campaignRun: null,
        pollRecord: null,
        enrollment: null,
        stepResult: createWorkflowStepResult({
          stepType: 'apollo_enroll_sequence',
          outcomeType: 'failed_permanent',
          reason: 'Apollo enrollment step requires a coordinated campaign run.',
          profileUrl,
          recipientName,
          metadata: {
            source: 'apollo_main_process'
          }
        })
      };
    }

    const campaignSequenceId = cleanString(campaignRun.apolloSequenceId, 160) || null;
    const stepSequenceId = cleanString(step.apolloSequenceId || step.sequenceId, 160) || null;
    if (campaignSequenceId && stepSequenceId && campaignSequenceId !== stepSequenceId) {
      return {
        campaignRun,
        pollRecord: null,
        enrollment: null,
        stepResult: createWorkflowStepResult({
          stepType: 'apollo_enroll_sequence',
          outcomeType: 'failed_permanent',
          reason: 'Apollo enrollment step sequence does not match the campaign run.',
          profileUrl,
          recipientName,
          metadata: {
            source: 'apollo_main_process',
            apolloSequenceId: campaignSequenceId,
            stepSequenceId
          }
        })
      };
    }

    const apolloContactId = cleanString(campaignRun.apolloContactId, 160) || null;
    const apolloSequenceId = stepSequenceId || campaignSequenceId || null;
    const emailAccountId = cleanString(step.emailAccountId, 160) || null;
    if (!apolloContactId) {
      return {
        campaignRun,
        pollRecord: null,
        enrollment: null,
        stepResult: createWorkflowStepResult({
          stepType: 'apollo_enroll_sequence',
          outcomeType: 'failed_permanent',
          reason: 'Apollo enrollment step requires an Apollo contact id.',
          profileUrl,
          recipientName,
          metadata: {
            source: 'apollo_main_process',
            campaignRunId: campaignRun.id
          }
        })
      };
    }
    if (!apolloSequenceId) {
      return {
        campaignRun,
        pollRecord: null,
        enrollment: null,
        stepResult: createWorkflowStepResult({
          stepType: 'apollo_enroll_sequence',
          outcomeType: 'failed_permanent',
          reason: 'Apollo enrollment step requires an Apollo sequence id.',
          profileUrl,
          recipientName,
          metadata: {
            source: 'apollo_main_process',
            campaignRunId: campaignRun.id
          }
        })
      };
    }

    if (campaignRun.apolloEnrolledAt && campaignRun.apolloSequenceId === apolloSequenceId) {
      const recordedEnrollment = this.recordApolloEnrollment(campaignRun.id, {
        apolloContactId,
        apolloSequenceId,
        apolloSequenceContactId: campaignRun.apolloSequenceContactId,
        apolloEnrolledAt: campaignRun.apolloEnrolledAt,
        apolloEnrollmentStatus: campaignRun.apolloEnrollmentStatus || 'active'
      });
      return {
        campaignRun: recordedEnrollment.campaignRun,
        pollRecord: recordedEnrollment.pollRecord,
        enrollment: {
          apolloContactId,
          apolloSequenceId,
          apolloSequenceContactId: campaignRun.apolloSequenceContactId || null,
          apolloEnrolledAt: campaignRun.apolloEnrolledAt,
          apolloEnrollmentStatus: campaignRun.apolloEnrollmentStatus || 'active'
        },
        stepResult: createWorkflowStepResult({
          stepType: 'apollo_enroll_sequence',
          outcomeType: 'completed',
          profileUrl,
          recipientName,
          metadata: {
            source: 'apollo_main_process',
            duplicateAvoided: true,
            apolloContactId,
            apolloSequenceId,
            apolloSequenceContactId: campaignRun.apolloSequenceContactId || null,
            apolloEnrolledAt: campaignRun.apolloEnrolledAt,
            apolloEnrollmentStatus: campaignRun.apolloEnrollmentStatus || 'active',
            emailAccountId,
            pollRecordCreated: Boolean(recordedEnrollment.pollRecord)
          }
        })
      };
    }

    if (typeof this.createApolloClient !== 'function') {
      return {
        campaignRun,
        pollRecord: null,
        enrollment: null,
        stepResult: createWorkflowStepResult({
          stepType: 'apollo_enroll_sequence',
          outcomeType: 'failed_permanent',
          reason: 'CampaignController requires createApolloClient() for Apollo enrollment execution.',
          profileUrl,
          recipientName,
          metadata: {
            source: 'apollo_main_process',
            campaignRunId: campaignRun.id,
            apolloContactId,
            apolloSequenceId
          }
        })
      };
    }

    let client = input.apolloClient || null;
    if (!client) {
      try {
        client = await this.createApolloClient();
      } catch (error) {
        return {
          campaignRun,
          pollRecord: null,
          enrollment: null,
          stepResult: buildApolloEnrollmentFailureStepResult({
            stepType: 'apollo_enroll_sequence',
            error,
            profileUrl,
            recipientName,
            metadata: {
              source: 'apollo_main_process',
              campaignRunId: campaignRun.id,
              apolloContactId,
              apolloSequenceId,
              emailAccountId
            }
          })
        };
      }
    }

    try {
      const response = await client.addContactsToSequence({
        sequenceId: apolloSequenceId,
        emailAccountId,
        contactIds: [apolloContactId]
      });
      const enrollment = normalizeApolloEnrollmentResponse(response, {
        apolloContactId,
        apolloSequenceId
      });
      const recordedEnrollment = this.recordApolloEnrollment(campaignRun.id, enrollment);
      return {
        campaignRun: recordedEnrollment.campaignRun,
        pollRecord: recordedEnrollment.pollRecord,
        enrollment,
        stepResult: createWorkflowStepResult({
          stepType: 'apollo_enroll_sequence',
          outcomeType: 'completed',
          profileUrl,
          recipientName,
          metadata: {
            source: 'apollo_main_process',
            apolloContactId,
            apolloSequenceId,
            apolloSequenceContactId: enrollment.apolloSequenceContactId || null,
            apolloEnrollmentStatus: enrollment.apolloEnrollmentStatus || 'active',
            apolloEnrolledAt: enrollment.apolloEnrolledAt || null,
            emailAccountId,
            pollRecordCreated: Boolean(recordedEnrollment.pollRecord)
          }
        })
      };
    } catch (error) {
      return {
        campaignRun,
        pollRecord: null,
        enrollment: null,
        stepResult: buildApolloEnrollmentFailureStepResult({
          stepType: 'apollo_enroll_sequence',
          error,
          profileUrl,
          recipientName,
          metadata: {
            source: 'apollo_main_process',
            campaignRunId: campaignRun.id,
            apolloContactId,
            apolloSequenceId,
            emailAccountId
          }
        })
      };
    }
  }

  async retryApolloHoldCampaignRuns(options = {}) {
    const now = normalizeNow(options.now);
    const retryIntervalMs = Math.max(
      0,
      Number(options.retryIntervalMs) || DEFAULT_APOLLO_HOLD_RETRY_INTERVAL_MS
    );
    const maxAttempts = Math.max(1, Number(options.maxAttempts) || DEFAULT_APOLLO_HOLD_MAX_ATTEMPTS);
    const checkApolloHold = typeof options.checkApolloHold === 'function'
      ? options.checkApolloHold
      : async () => ({ cleared: false, holdCause: 'unreachable' });

    const heldRuns = this.campaignRuns.getAllRuns()
      .filter((run) => run.status === 'waiting' && run.waitReason === 'apollo_hold')
      .filter((run) => isApolloHoldRetryDue(run, now, retryIntervalMs));

    const results = [];
    for (const campaignRun of heldRuns) {
      const childRuns = this.resolveChildRuns(campaignRun);
      const probeResult = normalizeApolloHoldProbeResult(await checkApolloHold(campaignRun, { now, childRuns }));
      let nextRun = null;

      if (probeResult.cleared) {
        nextRun = this.campaignRuns.clearApolloHold(campaignRun.id);
      } else {
        nextRun = this.campaignRuns.markApolloHold(campaignRun.id, probeResult.holdCause || campaignRun.holdCause || 'unreachable', {
          maxAttempts,
          childRuns
        });
      }

      results.push({
        previousRun: campaignRun,
        currentRun: nextRun || this.campaignRuns.getRun(campaignRun.id),
        probe: probeResult
      });
    }

    return results;
  }

  async processDueApolloPolls(options = {}) {
    const now = normalizeNow(options.now);
    const limit = Math.max(1, Number(options.limit) || DEFAULT_APOLLO_POLL_LIMIT);
    const duePolls = this.apolloPolls.listDuePollRecords({
      before: now.toISOString(),
      limit
    });
    if (!duePolls.length) {
      return [];
    }

    const pollApolloExecution = typeof options.pollApolloExecution === 'function'
      ? options.pollApolloExecution
      : this.pollApolloExecution || ((campaignRun, pollRecord, context) => this.pollApolloCampaignExecution(campaignRun, pollRecord, context));
    const sharedApolloContextLoader = createLazyAsyncValue(async () => {
      if (typeof options.createApolloClient === 'function') {
        return loadApolloPollingContext(await options.createApolloClient());
      }
      if (typeof this.createApolloClient === 'function') {
        return loadApolloPollingContext(await this.createApolloClient());
      }
      return {
        client: null,
        apolloUsers: [],
        dealStages: []
      };
    });

    const results = [];
    for (const pollRecord of duePolls) {
      const campaignRun = this.campaignRuns.getRun(pollRecord.campaignRunId);
      if (!campaignRun) {
        const currentPoll = this.apolloPolls.completePollRecord(pollRecord.campaignRunId, {
          outcome: 'campaign_missing',
          observedAt: now.toISOString()
        }, {
          lastPollAt: now.toISOString()
        });
        results.push({
          previousPoll: pollRecord,
          currentPoll,
          campaignRun: null,
          currentCampaignRun: null,
          observation: currentPoll?.lastPollResult || null
        });
        continue;
      }
      if (TERMINAL_CAMPAIGN_STATUSES.has(campaignRun.status)) {
        const currentPoll = this.apolloPolls.completePollRecord(pollRecord.campaignRunId, {
          outcome: 'campaign_terminal',
          campaignStatus: campaignRun.status,
          observedAt: now.toISOString()
        }, {
          lastPollAt: now.toISOString()
        });
        results.push({
          previousPoll: pollRecord,
          currentPoll,
          campaignRun,
          currentCampaignRun: campaignRun,
          observation: currentPoll?.lastPollResult || null
        });
        continue;
      }

      let observation;
      try {
        const sharedApolloContext = await sharedApolloContextLoader();
        observation = await pollApolloExecution(campaignRun, pollRecord, {
          ...sharedApolloContext,
          now
        });
      } catch (error) {
        observation = {
          outcome: 'unreachable',
          error: cleanString(error?.message || error, 600) || 'Apollo poll failed',
          apolloEnrollmentStatus: campaignRun.apolloEnrollmentStatus || null,
          observedAt: now.toISOString()
        };
      }

      const currentPoll = this.apolloPolls.recordPollResult(pollRecord.campaignRunId, observation, {
        lastPollAt: now.toISOString()
      });
      const currentCampaignRun = this.updateCampaignApolloPollingMetadata(campaignRun, currentPoll, currentPoll?.lastPollResult || observation);
      const transition = this.applyApolloPollObservationTransition(currentCampaignRun, currentPoll, observation);
      results.push({
        previousPoll: pollRecord,
        currentPoll: transition?.currentPoll || currentPoll,
        campaignRun,
        currentCampaignRun: transition?.campaignRun || currentCampaignRun,
        observation,
        transition: transition || null
      });
    }

    return results;
  }

  applyApolloPollObservationTransition(campaignRun, pollRecord, observation = null) {
    const currentRun = campaignRun?.id ? (this.campaignRuns.getRun(campaignRun.id) || campaignRun) : campaignRun;
    if (!currentRun?.id || TERMINAL_CAMPAIGN_STATUSES.has(currentRun.status)) {
      return null;
    }

    const interpreted = interpretPollObservation(observation, this.apolloPollSignalRules);
    if (!interpreted.shouldSuppress) {
      return null;
    }

    const suppressReason = cleanString(interpreted.suppressReason, 600) || 'apollo_poll:suppressed';
    const suppressedRun = this.campaignRuns.suppressRun(currentRun.id, suppressReason) || currentRun;
    const drainedChildRunIds = [];
    for (const childRunId of Array.isArray(suppressedRun.childRunIds) ? suppressedRun.childRunIds : []) {
      const drainedRun = this.workflowRuns.drainWorkflowRun(childRunId, suppressReason);
      if (drainedRun?.id) {
        drainedChildRunIds.push(drainedRun.id);
      }
    }

    let currentPoll = pollRecord || null;
    if (pollRecord?.status === 'active') {
      currentPoll = this.apolloPolls.completePollRecord(pollRecord.campaignRunId, {
        ...(pollRecord.lastPollResult && typeof pollRecord.lastPollResult === 'object' ? pollRecord.lastPollResult : {}),
        transition: 'suppressed',
        matchedSignals: interpreted.matchedSignals.map((signal) => signal.name),
        suppressReason,
        observedAt: cleanString(observation?.observedAt, 80) || pollRecord.lastPollAt || new Date().toISOString()
      }, {
        lastPollAt: pollRecord.lastPollAt || cleanString(observation?.observedAt, 80) || new Date().toISOString()
      });
    }

    const nextCampaignRun = this.updateCampaignApolloPollingMetadata(
      suppressedRun,
      currentPoll,
      currentPoll?.lastPollResult || observation
    );

    return {
      type: 'suppressed',
      reason: suppressReason,
      matchedSignals: interpreted.matchedSignals,
      drainedChildRunIds,
      campaignRun: nextCampaignRun,
      currentPoll
    };
  }

  pauseCampaignFromLinkedIn(campaignRunId, reason = 'reply_received') {
    const normalizedCampaignRunId = cleanString(campaignRunId, 160);
    if (!normalizedCampaignRunId) {
      return {
        campaignRun: null,
        pollRecord: null
      };
    }

    const currentRun = this.campaignRuns.getRun(normalizedCampaignRunId);
    if (!currentRun || TERMINAL_CAMPAIGN_STATUSES.has(currentRun.status)) {
      return {
        campaignRun: currentRun,
        pollRecord: currentRun ? this.apolloPolls.getPollRecord(normalizedCampaignRunId) : null
      };
    }

    const pauseReason = buildLinkedInCampaignReason(reason || 'reply_received');
    const pausedRun = currentRun.status === 'paused'
      ? currentRun
      : this.campaignRuns.pauseRun(normalizedCampaignRunId, pauseReason);
    const pollRecord = this.apolloPolls.pausePollRecord(normalizedCampaignRunId, {
      observedAt: new Date().toISOString(),
      reason: pauseReason
    });
    const campaignRun = this.updateCampaignApolloPollingMetadata(
      pausedRun || currentRun,
      pollRecord,
      pollRecord?.lastPollResult || null
    );

    return {
      campaignRun,
      pollRecord
    };
  }

  resumeCampaignFromLinkedIn(campaignRunId) {
    const normalizedCampaignRunId = cleanString(campaignRunId, 160);
    if (!normalizedCampaignRunId) {
      return {
        campaignRun: null,
        pollRecord: null
      };
    }

    const currentRun = this.campaignRuns.getRun(normalizedCampaignRunId);
    if (!currentRun || TERMINAL_CAMPAIGN_STATUSES.has(currentRun.status)) {
      return {
        campaignRun: currentRun,
        pollRecord: currentRun ? this.apolloPolls.getPollRecord(normalizedCampaignRunId) : null
      };
    }
    if (currentRun.status !== 'paused') {
      return {
        campaignRun: currentRun,
        pollRecord: this.apolloPolls.getPollRecord(normalizedCampaignRunId)
      };
    }

    const resumedRun = this.campaignRuns.resumeRun(normalizedCampaignRunId) || currentRun;
    const pollRecord = this.apolloPolls.resumePollRecord(normalizedCampaignRunId, {
      resumedAt: new Date().toISOString()
    });
    const campaignRun = this.updateCampaignApolloPollingMetadata(
      resumedRun,
      pollRecord,
      pollRecord?.lastPollResult || null
    );

    return {
      campaignRun,
      pollRecord
    };
  }

  suppressCampaignFromLinkedIn(campaignRunId, reason = 'unsubscribe_received') {
    const normalizedCampaignRunId = cleanString(campaignRunId, 160);
    if (!normalizedCampaignRunId) {
      return {
        campaignRun: null,
        pollRecord: null
      };
    }

    const currentRun = this.campaignRuns.getRun(normalizedCampaignRunId);
    if (!currentRun || TERMINAL_CAMPAIGN_STATUSES.has(currentRun.status)) {
      return {
        campaignRun: currentRun,
        pollRecord: currentRun ? this.apolloPolls.getPollRecord(normalizedCampaignRunId) : null
      };
    }

    const suppressReason = buildLinkedInCampaignReason(reason || 'unsubscribe_received');
    const suppressedRun = this.campaignRuns.suppressRun(normalizedCampaignRunId, suppressReason) || currentRun;
    const existingPollRecord = this.apolloPolls.getPollRecord(normalizedCampaignRunId);
    const pollRecord = existingPollRecord && !['completed', 'failed'].includes(existingPollRecord.status)
      ? this.apolloPolls.completePollRecord(normalizedCampaignRunId, {
        ...(existingPollRecord.lastPollResult && typeof existingPollRecord.lastPollResult === 'object' ? existingPollRecord.lastPollResult : {}),
        outcome: 'linkedin_suppressed',
        transition: 'suppressed',
        suppressReason,
        observedAt: new Date().toISOString()
      }, {
        lastPollAt: new Date().toISOString()
      })
      : existingPollRecord;
    const campaignRun = this.updateCampaignApolloPollingMetadata(
      suppressedRun,
      pollRecord,
      pollRecord?.lastPollResult || null
    );

    return {
      campaignRun,
      pollRecord
    };
  }

  drainCampaignRun(campaignRunId, reason = 'operator_cancelled') {
    const normalizedCampaignRunId = cleanString(campaignRunId, 160);
    if (!normalizedCampaignRunId) {
      return {
        campaignRun: null,
        pollRecord: null,
        drainedChildRunIds: []
      };
    }

    const currentRun = this.campaignRuns.getRun(normalizedCampaignRunId);
    if (!currentRun) {
      return {
        campaignRun: null,
        pollRecord: null,
        drainedChildRunIds: []
      };
    }

    const cancelReason = cleanString(reason, 600) || 'operator_cancelled';
    const drainedChildRunIds = [];
    for (const childRunId of Array.isArray(currentRun.childRunIds) ? currentRun.childRunIds : []) {
      const drainedRun = this.workflowRuns.drainWorkflowRun(childRunId, cancelReason);
      if (drainedRun?.id) {
        drainedChildRunIds.push(drainedRun.id);
      }
    }

    const existingPollRecord = this.apolloPolls.getPollRecord(normalizedCampaignRunId);
    const observedAt = new Date().toISOString();
    const pollRecord = existingPollRecord && !['completed', 'failed'].includes(existingPollRecord.status)
      ? this.apolloPolls.completePollRecord(normalizedCampaignRunId, {
        ...(existingPollRecord.lastPollResult && typeof existingPollRecord.lastPollResult === 'object'
          ? existingPollRecord.lastPollResult
          : {}),
        outcome: 'operator_cancelled',
        transition: 'cancelled',
        cancelReason,
        observedAt
      }, {
        lastPollAt: observedAt
      })
      : existingPollRecord;

    const nextRun = TERMINAL_CAMPAIGN_STATUSES.has(currentRun.status)
      ? currentRun
      : (this.campaignRuns.cancelRun(normalizedCampaignRunId, cancelReason) || currentRun);
    const campaignRun = pollRecord
      ? this.updateCampaignApolloPollingMetadata(nextRun, pollRecord, pollRecord.lastPollResult || null)
      : (this.campaignRuns.getRun(normalizedCampaignRunId) || nextRun);

    return {
      campaignRun,
      pollRecord,
      drainedChildRunIds
    };
  }

  drainAllCampaignRuns(reason = 'operator_cancelled') {
    return this.campaignRuns.getAllRuns()
      .filter((campaignRun) => !TERMINAL_CAMPAIGN_STATUSES.has(campaignRun.status))
      .map((campaignRun) => this.drainCampaignRun(campaignRun.id, reason))
      .filter((result) => Boolean(result?.campaignRun?.id));
  }

  notifyChildRunFinalized(campaignRunId, workflowRunId) {
    const normalizedCampaignRunId = cleanString(campaignRunId, 160);
    const normalizedWorkflowRunId = cleanString(workflowRunId, 160);
    if (!normalizedCampaignRunId) {
      return null;
    }

    const campaignRun = this.campaignRuns.getRun(normalizedCampaignRunId);
    if (!campaignRun || TERMINAL_CAMPAIGN_STATUSES.has(campaignRun.status)) {
      return campaignRun;
    }

    const childRunIds = Array.isArray(campaignRun.childRunIds)
      ? campaignRun.childRunIds.filter(Boolean)
      : [];
    if (!childRunIds.length) {
      return campaignRun;
    }
    if (normalizedWorkflowRunId && !childRunIds.includes(normalizedWorkflowRunId)) {
      return campaignRun;
    }

    const childRuns = childRunIds
      .map((childRunId) => this.workflowRuns.getRun(childRunId))
      .filter(Boolean);
    if (childRuns.length !== childRunIds.length) {
      return campaignRun;
    }
    if (!childRuns.every((childRun) => TERMINAL_WORKFLOW_RUN_STATUSES.has(childRun.status))) {
      return campaignRun;
    }

    if (childRuns.every((childRun) => childRun.status === 'cancelled')) {
      return this.campaignRuns.cancelRun(normalizedCampaignRunId, 'child_runs_cancelled');
    }
    if (childRuns.some((childRun) => childRun.status === 'failed')) {
      return this.campaignRuns.failRun(normalizedCampaignRunId, 'child_run_failed');
    }
    return this.campaignRuns.completeRun(normalizedCampaignRunId);
  }

  isCampaignRunOrphaned(campaignRun) {
    const childRunIds = Array.isArray(campaignRun?.childRunIds)
      ? campaignRun.childRunIds.filter(Boolean)
      : [];
    if (!childRunIds.length) {
      return true;
    }
    return childRunIds.every((childRunId) => !this.workflowRuns.getRun(childRunId));
  }

  resolveChildRuns(campaignRun) {
    const childRunIds = Array.isArray(campaignRun?.childRunIds)
      ? campaignRun.childRunIds.filter(Boolean)
      : [];
    return childRunIds
      .map((childRunId) => this.workflowRuns.getRun(childRunId))
      .filter(Boolean);
  }

  async runApolloPreflight({ campaignRun, workflowRunInput, sharedApolloContextLoader = null }) {
    if (!shouldRunApolloPreflight(workflowRunInput.steps)) {
      return {
        shouldCreateWorkflow: true,
        campaignRun
      };
    }

    const target = Array.isArray(workflowRunInput.targets) ? workflowRunInput.targets[0] || null : null;
    const prospect = this.resolveCampaignProspect(target, workflowRunInput, campaignRun);
    const enrollmentTarget = resolveApolloEnrollmentTarget(workflowRunInput.steps);
    const preflightMetadata = {
      ...buildApolloPreflightMetadataBase(prospect),
      apolloSequenceId: enrollmentTarget.apolloSequenceId
    };

    let apolloContext;
    try {
      apolloContext = await this.resolveApolloEligibilityContext(sharedApolloContextLoader);
    } catch (error) {
      const heldRun = this.markApolloHold(campaignRun.id, 'unreachable');
      return {
        shouldCreateWorkflow: false,
        campaignRun: this.updateCampaignApolloPreflightMetadata(heldRun || campaignRun, {
          ...preflightMetadata,
          status: 'held',
          holdCause: 'unreachable',
          phase: 'context',
          reason: APOLLO_IDENTITY_UNREACHABLE_REASON,
          error: cleanString(error?.message || error, 600) || null
        })
      };
    }

    const identity = await resolveApolloIdentity(prospect, apolloContext.client);
    const identityMetadata = {
      ...preflightMetadata,
      phase: 'identity',
      identityOutcome: identity.outcome,
      identitySource: identity.source,
      identityConfidence: identity.confidence,
      apolloContactId: identity.contactId,
      apolloPersonId: identity.personId
    };

    if (identity.outcome === APOLLO_IDENTITY_OUTCOMES.UNREACHABLE) {
      const heldRun = this.markApolloHold(campaignRun.id, 'unreachable');
      return {
        shouldCreateWorkflow: false,
        campaignRun: this.updateCampaignApolloPreflightMetadata(heldRun || campaignRun, {
          ...identityMetadata,
          status: 'held',
          holdCause: 'unreachable',
          reason: APOLLO_IDENTITY_UNREACHABLE_REASON
        })
      };
    }

    if (identity.outcome === APOLLO_IDENTITY_OUTCOMES.AMBIGUOUS) {
      const heldRun = this.markApolloHold(campaignRun.id, 'freshness_unknown');
      return {
        shouldCreateWorkflow: false,
        campaignRun: this.updateCampaignApolloPreflightMetadata(heldRun || campaignRun, {
          ...identityMetadata,
          status: 'held',
          holdCause: 'freshness_unknown',
          reason: APOLLO_IDENTITY_AMBIGUOUS_REASON
        })
      };
    }

    if (identity.outcome === APOLLO_IDENTITY_OUTCOMES.INVALID_INPUT) {
      const failedRun = this.campaignRuns.failRun(campaignRun.id, APOLLO_IDENTITY_INVALID_INPUT_REASON);
      return {
        shouldCreateWorkflow: false,
        campaignRun: this.updateCampaignApolloPreflightMetadata(failedRun || campaignRun, {
          ...identityMetadata,
          status: 'failed',
          reason: APOLLO_IDENTITY_INVALID_INPUT_REASON
        })
      };
    }

    let resolvedContactId = cleanString(identity.contactId, 160) || null;
    let resolvedContact = identity.contact || null;
    let resolvedPersonId = cleanString(identity.personId, 160) || null;
    let resolvedSource = identity.source;
    let resolvedConfidence = identity.confidence;

    if (identity.outcome === APOLLO_IDENTITY_OUTCOMES.NOT_FOUND) {
      try {
        const createdContact = await this.createApolloContactForProspect(prospect, apolloContext.client);
        resolvedContactId = cleanString(createdContact?.id, 160) || null;
        resolvedContact = createdContact || null;
        resolvedSource = 'created_contact';
        resolvedConfidence = APOLLO_IDENTITY_CONFIDENCE.HIGH;
        await this.persistProspectApolloIdentity(prospect.id, {
          apolloContactId: resolvedContactId,
          apolloPersonId: resolvedPersonId,
          identitySource: resolvedSource,
          lastIdentityOutcome: APOLLO_IDENTITY_OUTCOMES.RESOLVED,
          lastIdentityResolvedAt: new Date().toISOString()
        });
      } catch (error) {
        const heldRun = this.markApolloHold(campaignRun.id, 'unreachable');
        return {
          shouldCreateWorkflow: false,
          campaignRun: this.updateCampaignApolloPreflightMetadata(heldRun || campaignRun, {
            ...identityMetadata,
            status: 'held',
            holdCause: 'unreachable',
            phase: 'contact_create',
            reason: APOLLO_IDENTITY_CONTACT_CREATE_FAILED_REASON,
            error: cleanString(error?.message || error, 600) || null
          })
        };
      }
    } else if (resolvedContactId && resolvedConfidence === APOLLO_IDENTITY_CONFIDENCE.HIGH && identity.source !== APOLLO_IDENTITY_SOURCES.STORED_CONTACT_ID) {
      await this.persistProspectApolloIdentity(prospect.id, {
        apolloContactId: resolvedContactId,
        apolloPersonId: resolvedPersonId,
        identitySource: identity.source,
        lastIdentityOutcome: APOLLO_IDENTITY_OUTCOMES.RESOLVED,
        lastIdentityResolvedAt: new Date().toISOString()
      });
    }

    if (resolvedConfidence !== APOLLO_IDENTITY_CONFIDENCE.HIGH) {
      const heldRun = this.markApolloHold(campaignRun.id, 'freshness_unknown');
      return {
        shouldCreateWorkflow: false,
        campaignRun: this.updateCampaignApolloPreflightMetadata(heldRun || campaignRun, {
          ...identityMetadata,
          status: 'held',
          holdCause: 'freshness_unknown',
          reason: APOLLO_IDENTITY_MEDIUM_CONFIDENCE_REASON
        })
      };
    }

    const eligibility = await evaluateCrmEligibility(
      resolvedContactId,
      apolloContext.client,
      this.crmEligibilityRules,
      {
        apolloUsers: apolloContext.apolloUsers,
        contactStages: apolloContext.contactStages,
        dealStages: apolloContext.dealStages,
        contact: resolvedContact
      }
    );

    if (eligibility.holdCause) {
      const heldRun = this.markApolloHold(campaignRun.id, eligibility.holdCause);
      return {
        shouldCreateWorkflow: false,
        campaignRun: this.updateCampaignApolloPreflightMetadata(heldRun || campaignRun, {
          ...identityMetadata,
          status: 'held',
          holdCause: eligibility.holdCause,
          phase: 'eligibility',
          apolloContactId: resolvedContactId,
          apolloPersonId: resolvedPersonId
        })
      };
    }

    if (!eligibility.eligible) {
      const suppressReason = cleanString(eligibility.suppressionReasons[0], 600) || 'crm_suppressed';
      const suppressedRun = this.campaignRuns.suppressRun(campaignRun.id, suppressReason);
      return {
        shouldCreateWorkflow: false,
        campaignRun: this.updateCampaignApolloPreflightMetadata(suppressedRun || campaignRun, {
          ...identityMetadata,
          status: 'suppressed',
          phase: 'eligibility',
          apolloContactId: resolvedContactId,
          apolloPersonId: resolvedPersonId,
          suppressionReasons: eligibility.suppressionReasons,
          evaluatedAt: eligibility.evaluatedAt
        })
      };
    }

    return {
      shouldCreateWorkflow: true,
      campaignRun: this.updateCampaignApolloPreflightMetadata(campaignRun, {
        ...identityMetadata,
        status: 'eligible',
        phase: 'eligibility',
        apolloContactId: resolvedContactId,
        apolloPersonId: resolvedPersonId,
        suppressionReasons: [],
        evaluatedAt: eligibility.evaluatedAt
      })
    };
  }

  resolveCampaignProspect(target = null, workflowRunInput = {}, campaignRun = {}) {
    const prospectId = cleanString(target?.prospectId || campaignRun.prospectId, 160) || null;
    const storedProspect = prospectId && this.prospects && typeof this.prospects.getProspect === 'function'
      ? this.prospects.getProspect(prospectId)
      : null;
    if (storedProspect) {
      return storedProspect;
    }

    const targetValue = cleanString(target?.value || target?.profileUrl || target?.url, 400) || null;
    const targetProfileUrl = normalizeProfileUrl(target?.profileUrl || target?.url || targetValue);

    return {
      id: prospectId,
      prospectId,
      accountId: workflowRunInput.accountId || campaignRun.accountId || null,
      accountName: workflowRunInput.accountName || campaignRun.accountName || null,
      agentId: workflowRunInput.agentId || campaignRun.agentId || null,
      agentName: workflowRunInput.agentName || campaignRun.agentName || null,
      fullName: cleanString(target?.fullName || target?.label || campaignRun.prospectLabel, 240) || null,
      profileUrl: targetProfileUrl,
      title: cleanString(target?.title, 200) || null,
      company: cleanString(target?.company, 200) || null,
      email: cleanString(target?.email, 240) || null,
      metadata: {}
    };
  }

  async loadApolloEligibilityContext() {
    if (typeof this.createApolloClient !== 'function') {
      throw new Error('CampaignController requires createApolloClient() for Apollo-managed workflows');
    }

    const client = await this.createApolloClient();
    const apolloUsers = typeof client.listUsers === 'function'
      ? await client.listUsers({ page: 1, perPage: 100 })
      : [];

    return {
      client,
      apolloUsers: Array.isArray(apolloUsers) ? apolloUsers.filter(Boolean) : []
    };
  }

  async resolveApolloEligibilityContext(sharedApolloContextLoader = null) {
    if (typeof sharedApolloContextLoader === 'function') {
      return sharedApolloContextLoader();
    }
    return this.loadApolloEligibilityContext();
  }

  async createApolloContactForProspect(prospect = {}, apolloClient) {
    if (!apolloClient || typeof apolloClient.createContact !== 'function') {
      throw new Error('Apollo client must implement createContact(input) for net-new coordinated campaigns');
    }
    const createdContact = await apolloClient.createContact({
      prospect,
      runDedupe: true
    });
    if (!createdContact?.id) {
      throw new Error('Apollo contact creation did not return a contact id');
    }
    return createdContact;
  }

  async persistProspectApolloIdentity(prospectId, apolloPatch = {}) {
    const normalizedProspectId = cleanString(prospectId, 160);
    if (!normalizedProspectId || !this.prospects || typeof this.prospects.updateProspectMetadata !== 'function') {
      return null;
    }
    try {
      return this.prospects.updateProspectMetadata(normalizedProspectId, {
        integrations: {
          apollo: {
            ...apolloPatch
          }
        }
      });
    } catch (_error) {
      return null;
    }
  }

  updateCampaignApolloPreflightMetadata(campaignRun, patch = {}) {
    const currentRun = campaignRun?.id ? (this.campaignRuns.getRun(campaignRun.id) || campaignRun) : campaignRun;
    if (!currentRun?.id) {
      return campaignRun || null;
    }
    const nextMetadata = mergeObjects(currentRun.metadata || {}, {
      apolloPreflight: normalizeMetadata(patch)
    });
    const nextApolloContactId = cleanString(patch.apolloContactId, 160) || currentRun.apolloContactId || null;
    const nextApolloSequenceId = cleanString(patch.apolloSequenceId, 160) || currentRun.apolloSequenceId || null;
    return this.campaignRuns.updateRun(currentRun.id, {
      metadata: nextMetadata,
      apolloContactId: nextApolloContactId,
      apolloSequenceId: nextApolloSequenceId
    }) || currentRun;
  }

  updateCampaignApolloPollingMetadata(campaignRun, pollRecord, observation = null) {
    const currentRun = campaignRun?.id ? (this.campaignRuns.getRun(campaignRun.id) || campaignRun) : campaignRun;
    if (!currentRun?.id) {
      return campaignRun || null;
    }
    const currentPollingMetadata = currentRun.metadata?.apolloPolling && typeof currentRun.metadata.apolloPolling === 'object'
      ? currentRun.metadata.apolloPolling
      : {};
    const nextPollingMetadata = {
      ...currentPollingMetadata,
      pollStatus: pollRecord?.status || currentPollingMetadata.pollStatus || null,
      pollCount: Number(pollRecord?.pollCount) || 0,
      maxPolls: Number(pollRecord?.maxPolls) || 0,
      nextPollAt: pollRecord?.nextPollAt || null,
      lastPollAt: pollRecord?.lastPollAt || null,
      lastPollResult: normalizeMetadata(observation)
    };
    const nextMetadata = mergeObjects(currentRun.metadata || {}, {
      apolloPolling: nextPollingMetadata
    });
    const nextApolloEnrollmentStatus = cleanString(observation?.apolloEnrollmentStatus, 120) || currentRun.apolloEnrollmentStatus || null;
    return this.campaignRuns.updateRun(currentRun.id, {
      metadata: nextMetadata,
      apolloEnrollmentStatus: nextApolloEnrollmentStatus,
      apolloLastPolledAt: pollRecord?.lastPollAt || currentRun.apolloLastPolledAt || null
    }) || currentRun;
  }

  async pollApolloCampaignExecution(campaignRun, pollRecord, context = {}) {
    const observedAt = normalizeNow(context.now).toISOString();
    const client = context.client || (typeof this.createApolloClient === 'function' ? await this.createApolloClient() : null);
    if (!client) {
      throw new Error('CampaignController requires createApolloClient() for Apollo execution polling');
    }

    const apolloContactId = cleanString(campaignRun?.apolloContactId, 160) || null;
    const apolloSequenceContactId = cleanString(pollRecord?.apolloSequenceContactId, 160) || null;
    const apolloEnrollmentStatus = cleanString(campaignRun?.apolloEnrollmentStatus, 120) || 'active';
    const result = {
      outcome: 'ok',
      observedAt,
      apolloEnrollmentStatus,
      apolloContactId,
      apolloSequenceContactId,
      sequenceContactStatus: null,
      contact: null,
      dealSnapshot: null,
      taskSnapshot: null
    };

    if (!apolloContactId) {
      return {
        ...result,
        outcome: 'missing_contact'
      };
    }

    const contact = typeof client.getContact === 'function'
      ? await client.getContact(apolloContactId).catch((error) => {
        if (isApolloNotFoundError(error)) {
          return null;
        }
        throw error;
      })
      : null;
    const deals = typeof client.searchDeals === 'function'
      ? await client.searchDeals({ contact_id: apolloContactId })
      : [];
    const tasks = typeof client.searchTasks === 'function'
      ? await client.searchTasks({
        filters: { contact_id: apolloContactId },
        limit: 100
      })
      : [];

    return {
      ...result,
      outcome: contact ? 'ok' : 'contact_missing',
      contact: summarizeApolloPollingContact(contact),
      dealSnapshot: summarizeApolloDealsForPolling(deals, {
        dealStages: context.dealStages
      }),
      taskSnapshot: summarizeApolloTasksForPolling(tasks, {
        apolloUsers: context.apolloUsers,
        contactOwnerId: contact?.ownerId || contact?.raw?.owner_id || null
      })
    };
  }
}

function shouldRunApolloPreflight(steps = []) {
  return Array.isArray(steps) && steps.some((step) => APOLLO_PREFLIGHT_STEP_TYPES.has(cleanString(step?.type, 80)));
}

function buildApolloPreflightMetadataBase(prospect = {}) {
  return {
    prospectId: cleanString(prospect?.id || prospect?.prospectId, 160) || null,
    profileUrl: cleanString(prospect?.profileUrl || prospect?.linkedinUrl, 400) || null,
    fullName: cleanString(prospect?.fullName || prospect?.name, 240) || null
  };
}

function resolveApolloEnrollmentTarget(steps = []) {
  const apolloStep = Array.isArray(steps)
    ? steps.find((step) => APOLLO_PREFLIGHT_STEP_TYPES.has(cleanString(step?.type, 80)))
    : null;
  return {
    apolloSequenceId: cleanString(
      apolloStep?.apolloSequenceId
      || apolloStep?.sequenceId
      || apolloStep?.sequence?.id,
      160
    ) || null
  };
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return JSON.parse(JSON.stringify(value));
}

function mergeObjects(left, right) {
  const base = left && typeof left === 'object' && !Array.isArray(left) ? left : {};
  const patch = right && typeof right === 'object' && !Array.isArray(right) ? right : {};
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && base[key]
      && typeof base[key] === 'object'
      && !Array.isArray(base[key])
    ) {
      next[key] = mergeObjects(base[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function resolveCampaignAgeMs(campaignRun = {}, now = new Date()) {
  const reference = Date.parse(campaignRun.updatedAt || campaignRun.createdAt || campaignRun.enrolledAt || '');
  if (Number.isNaN(reference)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, now.getTime() - reference);
}

function normalizeNow(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  const timestamp = Date.parse(String(value || ''));
  if (Number.isNaN(timestamp)) {
    return new Date();
  }
  return new Date(timestamp);
}

function isApolloHoldRetryDue(campaignRun = {}, now = new Date(), retryIntervalMs = DEFAULT_APOLLO_HOLD_RETRY_INTERVAL_MS) {
  const lastAttemptTimestamp = Date.parse(String(campaignRun.holdLastAttemptAt || ''));
  if (Number.isNaN(lastAttemptTimestamp)) {
    return true;
  }
  return now.getTime() - lastAttemptTimestamp >= retryIntervalMs;
}

function normalizeApolloHoldProbeResult(value) {
  if (value === true) {
    return { cleared: true, holdCause: null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { cleared: false, holdCause: 'unreachable' };
  }
  const holdCause = cleanString(value.holdCause, 80).toLowerCase();
  return {
    cleared: value.cleared === true || value.reachable === true,
    holdCause: holdCause || 'unreachable'
  };
}

function normalizeApolloEnrollmentStep(step = {}) {
  const sequenceId = cleanString(
    step.apolloSequenceId
    || step.sequenceId
    || step.sequence?.id,
    160
  ) || null;
  return {
    apolloSequenceId: sequenceId,
    sequenceId,
    sequenceName: cleanString(step.sequenceName || step.sequence?.name, 200) || null,
    emailAccountId: cleanString(step.emailAccountId, 160) || null
  };
}

function normalizeApolloEnrollmentResponse(response = {}, defaults = {}) {
  const now = new Date().toISOString();
  return {
    apolloContactId: cleanString(defaults.apolloContactId, 160) || null,
    apolloSequenceId: cleanString(defaults.apolloSequenceId, 160) || null,
    apolloSequenceContactId: resolveApolloSequenceContactId(response),
    apolloEnrollmentStatus: resolveApolloEnrollmentStatus(response) || 'active',
    apolloEnrolledAt: resolveApolloEnrollmentTimestamp(response) || now
  };
}

function resolveApolloSequenceContactId(response = {}) {
  return resolveApolloFieldValue(response, new Set([
    'sequencecontactid',
    'sequencecontactids',
    'campaigncontactid',
    'campaigncontactids',
    'emailercampaigncontactid',
    'emailercampaigncontactids'
  ]), 160);
}

function resolveApolloEnrollmentStatus(response = {}) {
  return resolveApolloFieldValue(response, new Set([
    'sequencecontactstatus',
    'enrollmentstatus',
    'status'
  ]), 120);
}

function resolveApolloEnrollmentTimestamp(response = {}) {
  return resolveApolloFieldValue(response, new Set([
    'enrolledat',
    'createdat',
    'updatedat'
  ]), 80);
}

function resolveApolloFieldValue(value, keySet, maxLength) {
  const queue = [value];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') {
      continue;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    for (const [key, entry] of Object.entries(current)) {
      const normalizedKey = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (keySet.has(normalizedKey)) {
        if (Array.isArray(entry)) {
          const candidate = entry
            .map((item) => (item && typeof item === 'object' ? null : cleanString(item, maxLength)))
            .find(Boolean);
          if (candidate) {
            return candidate;
          }
          queue.push(...entry.filter((item) => item && typeof item === 'object'));
        } else if (entry && typeof entry === 'object') {
          queue.unshift(entry);
        } else {
          const candidate = cleanString(entry, maxLength);
          if (candidate) {
            return candidate;
          }
        }
      }
      if (entry && typeof entry === 'object') {
        queue.push(entry);
      }
    }
  }
  return null;
}

function buildApolloEnrollmentFailureStepResult(input = {}) {
  const classified = classifyApolloEnrollmentError(input.error);
  return createWorkflowStepResult({
    stepType: input.stepType || 'apollo_enroll_sequence',
    outcomeType: classified.outcomeType,
    reason: classified.reason,
    profileUrl: input.profileUrl,
    recipientName: input.recipientName,
    metadata: {
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
      apolloErrorCode: classified.code,
      apolloStatus: classified.status
    }
  });
}

function classifyApolloEnrollmentError(error) {
  const status = parseApolloApiStatus(error);
  const reason = cleanString(error?.message || error, 400) || 'Apollo enrollment failed';
  if (status === null) {
    return {
      outcomeType: 'failed_transient',
      code: 'unreachable',
      status: null,
      reason
    };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return {
      outcomeType: 'failed_transient',
      code: 'unreachable',
      status,
      reason
    };
  }
  return {
    outcomeType: 'failed_permanent',
    code: 'api_error',
    status,
    reason
  };
}

function parseApolloApiStatus(error) {
  const message = cleanString(error?.message || error, 400);
  const match = message.match(/apollo api error \((\d{3})\)/i);
  if (!match) {
    return null;
  }
  return Number(match[1]) || null;
}

function isApolloNotFoundError(error) {
  const message = cleanString(error?.message || error, 400).toLowerCase();
  return message.includes('apollo api error (404)');
}

function buildLinkedInCampaignReason(reason) {
  const normalizedReason = cleanString(reason, 160) || 'unknown';
  return `linkedin_reply:${normalizedReason}`;
}

async function loadApolloPollingContext(client) {
  if (!client) {
    return {
      client: null,
      apolloUsers: [],
      dealStages: []
    };
  }

  const [apolloUsers, dealStages] = await Promise.all([
    typeof client.listUsers === 'function'
      ? client.listUsers({ page: 1, perPage: 100 })
      : [],
    typeof client.listDealStages === 'function'
      ? client.listDealStages()
      : []
  ]);

  return {
    client,
    apolloUsers: Array.isArray(apolloUsers) ? apolloUsers.filter(Boolean) : [],
    dealStages: Array.isArray(dealStages) ? dealStages.filter(Boolean) : []
  };
}

function createLazyAsyncValue(loader) {
  let promise = null;
  return async () => {
    if (!promise) {
      promise = Promise.resolve().then(() => loader());
    }
    return promise;
  };
}

function summarizeApolloPollingContact(contact = null) {
  if (!contact || typeof contact !== 'object') {
    return null;
  }
  return {
    id: cleanString(contact.id, 160) || null,
    ownerId: cleanString(contact.ownerId, 160) || null,
    stageName: cleanString(contact.stageName, 200) || null,
    lifecycleStage: cleanString(contact.lifecycleStage, 200) || null,
    updatedAt: cleanString(contact.updatedAt, 80) || null
  };
}

function summarizeApolloDealsForPolling(deals = [], options = {}) {
  const normalizedDeals = Array.isArray(deals) ? deals.filter(Boolean) : [];
  const dealStageNameById = new Map(
    (Array.isArray(options.dealStages) ? options.dealStages : [])
      .map((stage) => {
        const stageId = cleanString(stage?.id, 160) || null;
        const stageName = cleanString(stage?.name, 200) || null;
        return stageId && stageName ? [stageId, stageName] : null;
      })
      .filter(Boolean)
  );
  const stageNames = Array.from(new Set(normalizedDeals
    .map((deal) => (
      cleanString(deal?.stageName, 200)
      || cleanString(dealStageNameById.get(cleanString(deal?.stageId, 160)), 200)
    ))
    .filter(Boolean)))
    .slice(0, 10);
  const nonClosedLostStageNames = stageNames.filter((stageName) => !isClosedLostStageName(stageName));
  return {
    count: normalizedDeals.length,
    openCount: normalizedDeals.filter((deal) => !isClosedDealForPolling(deal, dealStageNameById)).length,
    stageNames,
    nonClosedLostStageNames
  };
}

function summarizeApolloTasksForPolling(tasks = [], options = {}) {
  const normalizedTasks = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  const salesUserIds = buildApolloSalesUserIdSet(options.apolloUsers);
  const contactOwnerId = cleanString(options.contactOwnerId, 160) || null;
  return {
    count: normalizedTasks.length,
    openCount: normalizedTasks.filter((task) => isTaskOpenForPolling(task)).length,
    completedCount: normalizedTasks.filter((task) => isTaskCompletedForPolling(task)).length,
    recentTypes: Array.from(new Set(normalizedTasks.map((task) => cleanString(task?.type, 120)).filter(Boolean))).slice(0, 10),
    latestMeetingOrCallCompletedAt: maxTimestamp(normalizedTasks
      .filter((task) => ['meeting', 'call'].includes(normalizeComparableText(task?.type || task?.raw?.task_type)))
      .map((task) => task?.completedAt || task?.raw?.completed_at || task?.raw?.done_at)),
    latestSalesOwnedOpenTaskUpdatedAt: maxTimestamp(normalizedTasks
      .filter((task) => (
        isTaskOpenForPolling(task)
        && salesUserIds.has(cleanString(task?.ownerId || task?.raw?.owner_id || task?.raw?.user_id, 160))
      ))
      .map((task) => task?.updatedAt || task?.raw?.updated_at || task?.raw?.modified_at)),
    latestOwnerActivityAt: maxTimestamp(normalizedTasks
      .filter((task) => contactOwnerId && cleanString(task?.ownerId || task?.raw?.owner_id || task?.raw?.user_id, 160) === contactOwnerId)
      .flatMap((task) => [task?.updatedAt || task?.raw?.updated_at || task?.raw?.modified_at, task?.completedAt || task?.raw?.completed_at || task?.raw?.done_at]))
  };
}

function buildApolloSalesUserIdSet(users = []) {
  return new Set((Array.isArray(users) ? users : [])
    .filter((user) => isSalesApolloUser(user))
    .map((user) => cleanString(user?.id, 160))
    .filter(Boolean));
}

function isSalesApolloUser(user = {}) {
  const candidates = [
    user.role,
    user.team,
    user.title,
    user.raw?.role,
    user.raw?.user_role,
    user.raw?.role_name,
    user.raw?.department,
    user.raw?.team,
    user.raw?.team_name,
    user.raw?.title
  ]
    .map((value) => normalizeComparableText(value))
    .filter(Boolean);
  return candidates.some((value) => value.includes('sales'));
}

function isClosedDealForPolling(deal = {}, dealStageNameById = new Map()) {
  const statusName = normalizeComparableText(deal?.status);
  if (['closed_won', 'closed won', 'won', 'closed_lost', 'closed lost', 'lost'].includes(statusName)) {
    return true;
  }
  const stageName = normalizeComparableText(
    deal?.stageName
    || dealStageNameById.get(cleanString(deal?.stageId, 160))
  );
  return ['closed_won', 'closed won', 'closed_lost', 'closed lost'].includes(stageName);
}

function isClosedLostStageName(value) {
  const normalized = normalizeComparableText(value);
  return normalized === 'closed lost' || normalized === 'closed_lost';
}

function isTaskCompletedForPolling(task = {}) {
  if (cleanString(task?.completedAt || task?.raw?.completed_at || task?.raw?.done_at, 80)) {
    return true;
  }
  const status = normalizeComparableText(task?.status || task?.raw?.status);
  return ['completed', 'complete', 'done', 'closed'].includes(status);
}

function isTaskOpenForPolling(task = {}) {
  if (isTaskCompletedForPolling(task)) {
    return false;
  }
  const status = normalizeComparableText(task?.status || task?.raw?.status);
  if (!status) {
    return true;
  }
  return !['completed', 'complete', 'done', 'closed', 'cancelled', 'canceled'].includes(status);
}

function maxTimestamp(values = []) {
  let latest = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeTimestampForPolling(value);
    if (!normalized) {
      continue;
    }
    const timestamp = Date.parse(normalized);
    if (Number.isNaN(timestamp) || timestamp <= latestTimestamp) {
      continue;
    }
    latest = normalized;
    latestTimestamp = timestamp;
  }
  return latest;
}

function normalizeTimestampForPolling(value) {
  const normalized = cleanString(value, 80);
  if (!normalized) {
    return null;
  }
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function normalizeComparableText(value) {
  return cleanString(value, 240).toLowerCase();
}

function normalizeProfileUrl(value) {
  const normalized = cleanString(value, 400);
  return /linkedin\.com\/in\//i.test(normalized) ? normalized : null;
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = CampaignController;
