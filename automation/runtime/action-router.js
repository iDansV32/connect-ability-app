'use strict';

const { createWorkflowStepResult } = require('../../workflow-step-result');
const {
  buildConnectionAcceptedDetectionMetadata,
  buildConnectionAcceptedInferenceMetadata
} = require('../../workflow-connection-inference');
const {
  buildQuotaExceededReason,
  canConsumeActionQuota,
  consumeActionQuota
} = require('../../linkedin-action-quota-store');
const ProspectQueueStore = require('../../prospect-queue-store');
const { sendConnectionRequestDetailed } = require('../connection/request');
const { readConnectionState } = require('../connection/state');
const { processActivityPageDetailed } = require('../activity/like');
const { followProfileDetailed } = require('../follow/follow');
const { endorseSkillsDetailed } = require('../endorsement/endorse');
const { commentOnPostDetailed } = require('../comment/comment');
const { unfollowProfileDetailed } = require('../unfollow/unfollow');
const { computeVariantKey } = require('../messaging/variant-engine');
const { sendLinkedInMessage } = require('../messaging/orchestrator');
const { humanScroll } = require('../human/scroll');
const { readingDelay, thinkingPause, reactionDelay } = require('../human/delay');
const { extractProfileDetails } = require('../profile/extract');
const {
  getStoredProfileDetails,
  storeProfileAction,
  normalizeProfileUrl: _normalizeProfileUrl
} = require('../profile/storage');
const { searchForProfiles, searchAndOpenFirstProfile } = require('../search/search');
const { storeNameMapping } = require('../workflow/namelist');
const { logError } = require('../util/log');
const TransportHealthStore = require('./transport-health-store');
const { getWarmUpMultiplier } = require('../safety/warmup-schedule');
const { canConsumeActivityBudget, consumeActivityBudget } = require('../safety/daily-activity-budget');
const { isWithinWorkingHours } = require('../safety/working-hours');
const { resolveDoNotContactSummary } = require('../safety/do-not-contact');

const defaultProspectQueueStore = new ProspectQueueStore();
let defaultTransportHealthStore = null;

/**
 * Execute a single workflow step on the given page.
 *
 * @param {import('playwright').Page} page
 * @param {object} config
 * @param {object} [dependencies] - injectable overrides for testing
 * @param {object} [dependencies.prospectQueueStore]
 * @param {object} [dependencies.transportHealthStore]
 * @returns {Promise<import('../../workflow-step-result').WorkflowStepResult>}
 */
async function executeWorkflowStep(page, config = {}, dependencies = {}) {
  const prospectQueueStore = dependencies.prospectQueueStore || defaultProspectQueueStore;
  const transportHealthStore = dependencies.transportHealthStore || getDefaultTransportHealthStore();
  const workingHoursCheck = typeof dependencies.isWithinWorkingHours === 'function'
    ? dependencies.isWithinWorkingHours
    : isWithinWorkingHours;
  const consumeBudget = typeof dependencies.consumeActivityBudget === 'function'
    ? dependencies.consumeActivityBudget
    : consumeActivityBudget;
  const scrollPage = typeof dependencies.humanScroll === 'function'
    ? dependencies.humanScroll
    : humanScroll;
  const readProfileConnectionState = typeof dependencies.readConnectionState === 'function'
    ? dependencies.readConnectionState
    : readConnectionState;
  const dwellOnProfile = typeof dependencies.readingDelay === 'function'
    ? dependencies.readingDelay
    : readingDelay;
  const pauseBeforeAction = typeof dependencies.thinkingPause === 'function'
    ? dependencies.thinkingPause
    : thinkingPause;
  const pauseBeforeReaction = typeof dependencies.reactionDelay === 'function'
    ? dependencies.reactionDelay
    : reactionDelay;
  const likePosts = typeof dependencies.processActivityPageDetailed === 'function'
    ? dependencies.processActivityPageDetailed
    : processActivityPageDetailed;
  const sendConnectionRequest = typeof dependencies.sendConnectionRequestDetailed === 'function'
    ? dependencies.sendConnectionRequestDetailed
    : sendConnectionRequestDetailed;
  const sendMessage = typeof dependencies.sendLinkedInMessage === 'function'
    ? dependencies.sendLinkedInMessage
    : sendLinkedInMessage;
  const followProfileAction = typeof dependencies.followProfileDetailed === 'function'
    ? dependencies.followProfileDetailed
    : followProfileDetailed;
  const endorseSkillsAction = typeof dependencies.endorseSkillsDetailed === 'function'
    ? dependencies.endorseSkillsDetailed
    : endorseSkillsDetailed;
  const commentOnPostAction = typeof dependencies.commentOnPostDetailed === 'function'
    ? dependencies.commentOnPostDetailed
    : commentOnPostDetailed;
  const unfollowProfileAction = typeof dependencies.unfollowProfileDetailed === 'function'
    ? dependencies.unfollowProfileDetailed
    : unfollowProfileDetailed;
  const humanDelayOptions = buildHumanDelayOptions(config, dependencies.delayRng);
  const strictStealth = config.strictStealth === true;
  const resolveTarget = typeof dependencies.resolveWorkflowTarget === 'function'
    ? dependencies.resolveWorkflowTarget
    : resolveWorkflowTarget;

  const step = config.step || {};
  const stepType = String(step.type || '').trim();
  const messageTemplate = String(step.messageTemplate || '').trim();

  const prospect = config.prospectId
    ? prospectQueueStore.getProspect(config.prospectId)
    : null;

  const knownTarget = resolveKnownTargetFromConfig(config, prospect);
  const doNotContactProfileUrl = knownTarget?.profileUrl || null;
  const doNotContactRecipientName = knownTarget?.recipientName
    || config.targetLabel
    || prospect?.fullName
    || null;
  const doNotContactSummary = resolveDoNotContactSummary(prospect);
  if (doNotContactSummary.blocked) {
    return buildDoNotContactResult(stepType, doNotContactSummary, {
      profileUrl: doNotContactProfileUrl,
      recipientName: doNotContactRecipientName
    });
  }

  const resolvedTarget = knownTarget
    || await resolveTarget(page, config.targetValue || config.rawTarget, {
      strictStealth
    });
  const profileUrl = resolvedTarget.profileUrl;
  const recipientName =
    resolvedTarget.recipientName ||
    config.targetLabel ||
    prospect?.fullName ||
    deriveRecipientNameFromProfileUrl(profileUrl);

  const managedElsewhereSummary = stepType !== 'delay'
    ? resolveManagedElsewhereSummary(prospectQueueStore, config, prospect, resolvedTarget, recipientName)
    : null;

  try {
    if (managedElsewhereSummary?.blocked) {
      return buildManagedElsewhereResult(stepType, managedElsewhereSummary, { profileUrl, recipientName });
    }

    // Working-hours guard — skip action types that run outside the account's window.
    // Manual launches set config.bypassWorkingHours so operator-triggered runs
    // execute immediately regardless of weekday/hour.
    if (stepType !== 'delay' && !config.bypassWorkingHours) {
      const account = { timezoneId: config.timezoneId || null, workingHours: config.workingHours || null };
      if (!workingHoursCheck(account)) {
        return createWorkflowStepResult({
          stepType,
          outcomeType: 'skipped_outside_working_hours',
          reason: 'Action skipped: outside configured working hours for this account',
          profileUrl,
          recipientName
        });
      }
    }

    // Daily total-activity budget (all non-delay action types share one envelope).
    if (stepType !== 'delay') {
      const budgetResult = consumeBudget(1, buildBudgetOptions(config));
      if (!budgetResult.allowed) {
        return createWorkflowStepResult({
          stepType,
          outcomeType: 'skipped_budget_exceeded',
          reason: `Daily activity budget reached (${budgetResult.used}/${budgetResult.limit} total actions)`,
          profileUrl,
          recipientName,
          metadata: buildWorkflowStepMetadata({ used: budgetResult.used, limit: budgetResult.limit })
        });
      }
    }

    const transportHealthGuardResult = getTransportHealthGuardResult(stepType, config, transportHealthStore, {
      profileUrl,
      recipientName
    });
    if (transportHealthGuardResult) {
      return transportHealthGuardResult;
    }

    switch (stepType) {
      case 'view_profile': {
        // 1) Quota check FIRST so we don't burn a quota slot navigating to a
        //    profile we can't act on.
        const quotaOptions = buildActionQuotaOptions(config);
        const quotaState = canConsumeActionQuota('profile_viewed', 1, quotaOptions);
        if (!quotaState.allowed) {
          return getActionQuotaExceededResult(stepType, 'profile_viewed', quotaState, { profileUrl, recipientName });
        }

        // 2) Navigate to the target profile BEFORE any DOM/OCR extraction.
        //    Critical correctness fix: pulling profile details before the goto
        //    reads the previous profile's DOM, which then cross-wires bio data
        //    onto the wrong prospect record.
        const navigation = await ensureProfilePageLoaded(page, profileUrl, {
          strictStealth,
          navigationMode: resolvedTarget?.navigationMode || 'allow_direct_profile_navigation'
        });
        if (!navigation.ok) {
          return buildProfileNavigationFailure(stepType, profileUrl, recipientName, navigation.reason);
        }
        await dwellOnProfile(10, humanDelayOptions);
        await scrollPage(page);

        // 3) NOW extract bio from the freshly-loaded profile (DOM + OCR fallback).
        let profileDetails = await getWorkflowProfileDetails(page, profileUrl, recipientName);

        // Redacted fallback diagnostic for future DOM drift. If DOM extraction
        // ever misses title/company again (LinkedIn restructures its top card),
        // dump the structural shape (tags/classes/text LENGTHS only — no names,
        // text, or URLs) to stdout so the selectors can be re-derived without a
        // live spelunk. Fires only on a miss; normally silent.
        try {
          const domIncomplete = !profileDetails
            || !profileDetails.title || profileDetails.title === 'Not Available'
            || !profileDetails.company || profileDetails.company === 'Not Available';
          if (domIncomplete) {
            const { describeProfileDetailPage } = require('../profile/extract');
            const diag = await describeProfileDetailPage(page, {
              name: (profileDetails && profileDetails.fullName) || recipientName || '',
              headline: ['main .text-body-medium.break-words', 'main section .text-body-medium', '[class*="headline"]'],
              company: ['main section [aria-label*="Current company"]', 'main section button[aria-label*="company"]', '[aria-label*="Current company"]', '[class*="company-name"]', '[class*="employer"]']
            });
            console.log('[profile-diagnostic] ' + JSON.stringify(diag));
          }
        } catch (_) { /* diagnostic is best-effort */ }

        let captureResult = null;
        try {
          const { captureAndExtract } = require('../profile/screenshot-extract');
          const needsOcr =
            !profileDetails ||
            !profileDetails.title || profileDetails.title === 'Not Available' ||
            !profileDetails.company || profileDetails.company === 'Not Available' ||
            !profileDetails.fullName || profileDetails.fullName === 'Unknown Profile';
          captureResult = await captureAndExtract(page, profileUrl, {
            prospectId: prospect && prospect.id ? prospect.id : null,
            runOcr: needsOcr,
          });
          if (captureResult && captureResult.parsed) {
            const ocr = captureResult.parsed;
            profileDetails = {
              ...profileDetails,
              fullName: (profileDetails.fullName && profileDetails.fullName !== 'Unknown Profile')
                ? profileDetails.fullName
                : (ocr.name || profileDetails.fullName),
              title: (profileDetails.title && profileDetails.title !== 'Not Available')
                ? profileDetails.title
                : (ocr.title || profileDetails.title),
              position: (profileDetails.position && profileDetails.position !== 'Not Available')
                ? profileDetails.position
                : (ocr.title || profileDetails.position),
              company: (profileDetails.company && profileDetails.company !== 'Not Available')
                ? profileDetails.company
                : (ocr.company || profileDetails.company),
              location: profileDetails.location || ocr.location || '',
              screenshotPath: captureResult.screenshotPath || null,
            };
          }
        } catch (_) { /* best-effort */ }

        const connectionState = await readProfileConnectionState(page);
        const connectionAcceptedMetadata = buildConnectionAcceptedDetectionMetadata(prospect, connectionState, {
          timestamp: new Date().toISOString()
        });
        consumeActionQuota('profile_viewed', 1, quotaOptions);
        persistWorkflowProfileAction(profileUrl, profileDetails, 'Profile Viewed', 'Viewed during workflow step');
        if (connectionAcceptedMetadata.connectionAcceptedDetected) {
          persistWorkflowProfileAction(
            profileUrl,
            profileDetails,
            'Connection Accepted',
            'Detected from connected profile state after a recorded connection request'
          );
        }
        return createWorkflowStepResult({
          stepType,
          outcomeType: 'completed',
          profileUrl,
          recipientName: profileDetails.fullName || recipientName,
          metadata: buildWorkflowStepMetadata({
            connectionStateConnected: connectionState?.connected === true,
            connectionStatePending: connectionState?.pending === true,
            ...connectionAcceptedMetadata,
            // Bio captured from DOM + OCR fallback so the prospect record
            // can be enriched downstream by the scheduler.
            bio: {
              fullName: profileDetails.fullName || null,
              title: profileDetails.title && profileDetails.title !== 'Not Available' ? profileDetails.title : null,
              company: profileDetails.company && profileDetails.company !== 'Not Available' ? profileDetails.company : null,
              location: profileDetails.location || null,
            },
            screenshotPath: profileDetails.screenshotPath || (captureResult && captureResult.screenshotPath) || null,
          })
        });
      }

      case 'like_posts': {
        const navigation = await ensureProfilePageLoaded(page, profileUrl, {
          strictStealth,
          navigationMode: resolvedTarget?.navigationMode || 'allow_direct_profile_navigation'
        });
        if (!navigation.ok) {
          return buildProfileNavigationFailure(stepType, profileUrl, recipientName, navigation.reason);
        }
        const profileDetails = await getWorkflowProfileDetails(page, profileUrl, recipientName);
        const resolvedRecipientName = getUsefulProfileName(profileDetails)
          || deriveRecipientNameFromProfileUrl(profileUrl)
          || recipientName;
        await pauseBeforeReaction(humanDelayOptions);
        const likeResult = await likePosts(page, profileUrl, {
          ...buildActionQuotaOptions(config),
          strictStealth
        });
        if (likeResult.outcomeType !== 'completed') {
          return createWorkflowStepResult({ ...likeResult, stepType, profileUrl, recipientName: resolvedRecipientName });
        }
        persistWorkflowProfileAction(profileUrl, profileDetails, 'Post Liked', 'Liked post during workflow');
        return createWorkflowStepResult({ ...likeResult, stepType, profileUrl, recipientName: resolvedRecipientName });
      }

      case 'send_connection': {
        const navigation = await ensureProfilePageLoaded(page, profileUrl, {
          strictStealth,
          navigationMode: resolvedTarget?.navigationMode || 'allow_direct_profile_navigation'
        });
        if (!navigation.ok) {
          return buildProfileNavigationFailure(stepType, profileUrl, recipientName, navigation.reason);
        }
        const liveProfileDetails = await extractCurrentProfileDetails(page, profileUrl);
        const profileDetails = await getWorkflowProfileDetails(page, profileUrl, recipientName, {
          liveProfileDetails
        });
        await pauseBeforeAction(humanDelayOptions);
        // Prefer the on-page name (extracted from the DOM) over the slug-derived
        // recipientName.  This avoids mismatches when the URL slug contains
        // alphanumeric suffixes that don't appear in the aria-label. Never use
        // stored profile data for the click filter; stale storage can belong to
        // a previously-opened profile after a bad extraction.
        const connectionTargetName = getUsefulProfileName(liveProfileDetails)
          || deriveRecipientNameFromProfileUrl(profileUrl)
          || recipientName;
        const connectionResult = await sendConnectionRequest(
          page,
          profileUrl,
          messageTemplate,
          {
            ...buildActionQuotaOptions(config),
            strictStealth,
            recipientName: connectionTargetName,
            navigationMode: resolvedTarget?.navigationMode || 'allow_direct_profile_navigation',
            transportHealthStore,
            timezoneId: config.timezoneId || null
          }
        );
        if (connectionResult.outcomeType === 'completed') {
          persistWorkflowProfileAction(
            profileUrl,
            profileDetails,
            'Connection Request Sent',
            messageTemplate
              ? `Sent request with note: ${messageTemplate}`
              : 'Sent connection request without note'
          );
        }
        return createWorkflowStepResult({
          ...connectionResult,
          stepType,
          profileUrl,
          recipientName: connectionResult.recipientName || connectionTargetName,
          metadata: buildWorkflowStepMetadata({
            ...(connectionResult.metadata || {}),
            hasNote: Boolean(messageTemplate)
          })
        });
      }

      case 'send_dm': {
        if (!messageTemplate) {
          return createWorkflowStepResult({
            stepType,
            outcomeType: 'failed_permanent',
            reason: 'Message template is required for DM steps',
            profileUrl,
            recipientName
          });
        }
        // Keep the router-level thinking pause even though the sender has its own
        // pre-click dwell: this models "decide to message" at the workflow layer
        // plus "reread before send" inside the messaging executor.
        const profileDetails = await getWorkflowProfileDetails(page, profileUrl, recipientName);
        await pauseBeforeAction(humanDelayOptions);
        const dmOk = await sendMessage(page, profileUrl, messageTemplate, {
          checkHistory: false,
          useMessagingDrawer: false,
          recipientName,
          accountId: config.accountId || null,
          accountEmail: config.accountEmail || config.email || null,
          accountName: config.accountName || null,
          warmUpStartedAt: config.warmUpStartedAt || null,
          strictStealth,
          transportHealthStore,
          timezoneId: config.timezoneId || null
        });
        if (!dmOk?.success) {
          return createWorkflowStepResult({
            stepType,
            outcomeType: mapDmOutcome(dmOk),
            reason: dmOk?.reason || dmOk?.error || 'Failed to send DM',
            profileUrl,
            recipientName,
            metadata: buildWorkflowStepMetadata({
              transport: dmOk?.transport || null,
              missingFields: Array.isArray(dmOk?.missingFields) ? dmOk.missingFields : undefined
            })
          });
        }
        const connectionAcceptedMetadata = buildConnectionAcceptedInferenceMetadata(prospect, {
          timestamp: new Date().toISOString()
        });
        if (connectionAcceptedMetadata.connectionAcceptedInferred) {
          persistWorkflowProfileAction(
            profileUrl,
            profileDetails,
            'Connection Accepted',
            'Inferred from successful DM after a recorded connection request'
          );
        }
        persistWorkflowProfileAction(profileUrl, profileDetails, 'Message Sent', messageTemplate);
        return createWorkflowStepResult({
          stepType,
          outcomeType: 'completed',
          profileUrl,
          recipientName,
          verificationResult: dmOk?.verificationResult || null,
          metadata: buildWorkflowStepMetadata({
            transport: dmOk?.transport || null,
            variantKey: messageTemplate ? computeVariantKey(dmOk?.message || messageTemplate) : undefined,
            ...connectionAcceptedMetadata
          })
        });
      }

      case 'follow_profile': {
        const profileDetails = await getWorkflowProfileDetails(page, profileUrl, recipientName);
        await pauseBeforeAction(humanDelayOptions);
        const followResult = await followProfileAction(page, profileUrl, {
          ...buildActionQuotaOptions(config),
          strictStealth
        });
        if (followResult.outcomeType === 'completed') {
          persistWorkflowProfileAction(profileUrl, profileDetails, 'Profile Followed', 'Followed during workflow step');
        }
        return createWorkflowStepResult({
          ...followResult,
          stepType,
          profileUrl,
          recipientName
        });
      }

      case 'unfollow_profile': {
        const profileDetails = await getWorkflowProfileDetails(page, profileUrl, recipientName);
        await pauseBeforeAction(humanDelayOptions);
        const unfollowResult = await unfollowProfileAction(page, profileUrl, {
          ...buildActionQuotaOptions(config),
          strictStealth
        });
        if (unfollowResult.outcomeType === 'completed') {
          persistWorkflowProfileAction(profileUrl, profileDetails, 'Profile Unfollowed', 'Unfollowed during workflow step');
        }
        return createWorkflowStepResult({
          ...unfollowResult,
          stepType,
          profileUrl,
          recipientName
        });
      }

      case 'endorse_skills': {
        const profileDetails = await getWorkflowProfileDetails(page, profileUrl, recipientName);
        await pauseBeforeAction(humanDelayOptions);
        const endorseResult = await endorseSkillsAction(page, profileUrl, {
          ...buildActionQuotaOptions(config),
          strictStealth
        });
        if (endorseResult.outcomeType === 'completed') {
          const skillNames = Array.isArray(endorseResult.metadata?.endorsedSkills)
            ? endorseResult.metadata.endorsedSkills.join(', ')
            : 'skills';
          persistWorkflowProfileAction(profileUrl, profileDetails, 'Skills Endorsed', `Endorsed ${skillNames} during workflow step`);
        }
        return createWorkflowStepResult({
          ...endorseResult,
          stepType,
          profileUrl,
          recipientName
        });
      }

      case 'comment_on_post': {
        const profileDetails = await getWorkflowProfileDetails(page, profileUrl, recipientName);
        await pauseBeforeAction(humanDelayOptions);
        const commentTemplate = String(step.commentTemplate || step.messageTemplate || '').trim();
        const commentResult = await commentOnPostAction(page, profileUrl, {
          ...buildActionQuotaOptions(config),
          commentTemplate,
          strictStealth
        });
        if (commentResult.outcomeType === 'completed') {
          persistWorkflowProfileAction(profileUrl, profileDetails, 'Post Commented', `Commented during workflow step`);
        }
        const commentMeta = commentResult.outcomeType === 'completed' && commentTemplate
          ? { variantKey: computeVariantKey(commentResult.metadata?.commentText || commentTemplate) }
          : {};
        return createWorkflowStepResult({
          ...commentResult,
          stepType,
          profileUrl,
          recipientName,
          metadata: { ...commentResult.metadata, ...commentMeta }
        });
      }

      case 'delay': {
        return createWorkflowStepResult({
          stepType,
          outcomeType: 'completed',
          profileUrl,
          recipientName,
          metadata: buildWorkflowStepMetadata({
            delayValue: step.delayValue ?? step.delayAmount,
            delayUnit: step.delayUnit || null,
            minDelayMs: step.minDelayMs ?? null,
            maxDelayMs: step.maxDelayMs ?? null
          })
        });
      }

      default:
        return createWorkflowStepResult({
          stepType,
          outcomeType: 'failed_permanent',
          reason: `Unsupported workflow step type: ${stepType}`,
          profileUrl,
          recipientName
        });
    }
  } catch (error) {
    return createWorkflowStepResult({
      stepType,
      outcomeType: 'failed_transient',
      profileUrl,
      recipientName,
      reason: error.message
    });
  }
}

// ---- helpers ----

/**
 * Derive a human-readable name from a LinkedIn profile URL slug.
 *
 * Strips:
 *  - pure-digit parts           (e.g. "517204886")
 *  - mixed alphanumeric tokens  (e.g. "4c7a91e02", "a1b2c3")
 *    that LinkedIn appends as uniqueness suffixes
 *
 * "madison-crane-4c7a91e02" → "Madison Crane"
 * "ivan-dans-517204886"     → "Ivan Dans"
 * "john-smith"              → "John Smith"
 */
function deriveRecipientNameFromProfileUrl(profileUrl) {
  const raw = String(profileUrl || '');
  const m = raw.match(/\/in\/([^/?]+)/);
  if (!m || !m[1]) return '';
  const { cleanLinkedInSlugName } = require('../profile/url-utils');
  return cleanLinkedInSlugName(m[1]);
}

function normalizeLinkedInProfilePath(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    const match = parsed.pathname.match(/^\/in\/([^/?#]+)/i);
    if (!match || !match[1]) {
      return null;
    }
    return `/in/${match[1].toLowerCase()}`;
  } catch (_) {
    return null;
  }
}

function isSameLinkedInProfilePage(currentUrl, targetUrl) {
  const currentPath = normalizeLinkedInProfilePath(currentUrl);
  const targetPath = normalizeLinkedInProfilePath(targetUrl);
  return Boolean(currentPath && targetPath && currentPath === targetPath);
}

async function getCurrentPageUrl(page) {
  if (!page || typeof page.url !== 'function') {
    return '';
  }
  try {
    return await Promise.resolve(page.url());
  } catch (_) {
    return '';
  }
}

async function ensureProfilePageLoaded(page, profileUrl, options = {}) {
  const currentUrl = await getCurrentPageUrl(page);
  const alreadyOnProfile = isSameLinkedInProfilePage(currentUrl, profileUrl);
  if (alreadyOnProfile) {
    if (page && typeof page.waitForSelector === 'function') {
      await page.waitForSelector('main', { timeout: 10000 }).catch(() => {});
    }
    return { ok: true, alreadyOnProfile: true };
  }

  const navigationMode = String(options.navigationMode || 'allow_direct_profile_navigation').trim();
  if (options.strictStealth === true && navigationMode === 'context_click_only') {
    return {
      ok: false,
      alreadyOnProfile: false,
      reason: 'Strict stealth mode requires the profile to remain open from the natural search click path'
    };
  }

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs || 30000 });
  if (page && typeof page.waitForSelector === 'function') {
    await page.waitForSelector('main', { timeout: 10000 }).catch(() => {});
  }
  return { ok: true, alreadyOnProfile: false };
}

function buildProfileNavigationFailure(stepType, profileUrl, recipientName, reason) {
  return createWorkflowStepResult({
    stepType,
    outcomeType: 'failed_permanent',
    reason: reason || 'Could not load target profile before workflow step',
    profileUrl,
    recipientName
  });
}

async function resolveWorkflowTarget(page, rawTarget, options = {}) {
  const target = String(rawTarget || '').trim();
  if (!target) {
    throw new Error('Workflow target is empty');
  }

  if (/linkedin\.com\/in\//i.test(target)) {
    return {
      profileUrl: target.split('?')[0],
      recipientName: deriveRecipientNameFromProfileUrl(target),
      navigationMode: 'allow_direct_profile_navigation'
    };
  }

  if (options.strictStealth === true) {
    const openProfileFromSearch = typeof options.searchAndOpenFirstProfile === 'function'
      ? options.searchAndOpenFirstProfile
      : searchAndOpenFirstProfile;
    const openedProfile = await openProfileFromSearch(page, target, {
      strictStealth: true
    });
    if (!openedProfile?.profileUrl) {
      throw new Error(`Could not find and open a LinkedIn profile naturally for "${target}"`);
    }

    storeNameMapping(target, openedProfile.profileUrl);
    return {
      profileUrl: openedProfile.profileUrl,
      recipientName: openedProfile.recipientName || target,
      navigationMode: 'context_click_only'
    };
  }

  const runSearchForProfiles = typeof options.searchForProfiles === 'function'
    ? options.searchForProfiles
    : searchForProfiles;
  const matches = await runSearchForProfiles(page, target, options);
  const profileUrl = Array.isArray(matches)
    ? matches.find((url) => /linkedin\.com\/in\//i.test(url || ''))
    : null;

  if (!profileUrl) {
    throw new Error(`Could not find a LinkedIn profile for "${target}"`);
  }

  storeNameMapping(target, profileUrl);

  return {
    profileUrl,
    recipientName: target,
    navigationMode: 'allow_direct_profile_navigation'
  };
}

async function extractCurrentProfileDetails(page, profileUrl) {
  try {
    const details = await extractProfileDetails(page, profileUrl);
    if (details && (details.firstName || details.fullName)) {
      return details;
    }
  } catch (_) {
    // best-effort extraction; caller can fall back to stored/default details
  }
  return null;
}

async function getWorkflowProfileDetails(page, profileUrl, recipientName = '', options = {}) {
  const hasProvidedLiveDetails = Object.prototype.hasOwnProperty.call(options, 'liveProfileDetails');
  const liveDetails = hasProvidedLiveDetails
    ? options.liveProfileDetails
    : await extractCurrentProfileDetails(page, profileUrl);
  if (liveDetails) {
    return liveDetails;
  }

  const stored = await getStoredProfileDetails(profileUrl).catch(() => null);
  if (stored) {
    return {
      firstName: stored.firstName || recipientName.split(' ')[0] || 'Unknown',
      lastName: stored.lastName || recipientName.split(' ').slice(1).join(' ') || 'Profile',
      fullName: stored.fullName || recipientName || 'Unknown Profile',
      position: stored.title || stored.position || 'Not Available',
      company: stored.company || 'Not Available',
      email: stored.email || 'Not Available',
      profileUrl
    };
  }

  return buildDefaultProfileDetails(profileUrl, recipientName);
}

function buildDefaultProfileDetails(profileUrl, recipientName = '') {
  return {
    firstName: recipientName.split(' ')[0] || 'Unknown',
    lastName: recipientName.split(' ').slice(1).join(' ') || 'Profile',
    fullName: recipientName || 'Unknown Profile',
    position: 'Not Available',
    company: 'Not Available',
    email: 'Not Available',
    profileUrl
  };
}

function getUsefulProfileName(details) {
  const fullName = String(details?.fullName || '').trim();
  if (fullName && fullName !== 'Unknown Profile') {
    return fullName;
  }
  const firstName = String(details?.firstName || '').trim();
  const lastName = String(details?.lastName || '').trim();
  const combined = `${firstName} ${lastName}`.trim();
  if (combined && combined !== 'Unknown Profile') {
    return combined;
  }
  return '';
}

function resolveKnownTargetFromConfig(config = {}, prospect = null) {
  const explicit = config.resolvedTarget && typeof config.resolvedTarget === 'object'
    ? config.resolvedTarget
    : null;
  const rawTarget = String(config.targetValue || config.rawTarget || '').trim();
  const explicitProfileUrl = explicit?.profileUrl ? _normalizeProfileUrl(explicit.profileUrl) : '';
  const prospectProfileUrl = _normalizeProfileUrl(prospect?.profileUrl || prospect?.normalizedProfileUrl || '');
  const rawProfileUrl = /linkedin\.com\/in\//i.test(rawTarget) ? _normalizeProfileUrl(rawTarget) : '';
  const profileUrl = explicitProfileUrl || prospectProfileUrl || rawProfileUrl || null;
  const recipientName = String(
    explicit?.recipientName
      || prospect?.fullName
      || config.targetLabel
      || (profileUrl ? deriveRecipientNameFromProfileUrl(profileUrl) : '')
  ).trim();

  if (!profileUrl && !recipientName) {
    return null;
  }

  const navigationMode = String(explicit?.navigationMode || '').trim() || null;

  return {
    profileUrl,
    recipientName,
    ...(navigationMode ? { navigationMode } : {})
  };
}

function persistWorkflowProfileAction(profileUrl, profileDetails, actionType, notes) {
  try {
    storeProfileAction(profileUrl, profileDetails, actionType, notes || '');
  } catch (err) {
    // Best-effort: never fail the step over a persistence error. But the
    // pre-Rule-0a / pre-atomic-write version of this swallow was completely
    // silent, which is the failure mode the senior review flagged. The
    // underlying storeProfileAction now uses writeJsonFileAtomic, so disk
    // corruption is no longer possible — but transient persistence errors
    // (EROFS, ENOSPC, etc.) can still occur and need to be visible.
    const reason = (err && err.message) ? err.message : String(err);
    console.warn(`[persistWorkflowProfileAction] best-effort write failed for ${profileUrl}: ${reason}`);
  }
}

function buildWorkflowStepMetadata(extra = {}) {
  return Object.entries(extra).reduce((accumulator, [key, value]) => {
    if (value !== undefined) {
      accumulator[key] = value;
    }
    return accumulator;
  }, {});
}

function buildActionQuotaOptions(config = {}) {
  return {
    accountId: config.accountId || null,
    accountEmail: config.accountEmail || config.email || null,
    accountName: config.accountName || null,
    quotaPath: config.quotaPath || null,
    warmUpMultiplier: getWarmUpMultiplier({ warmUpStartedAt: config.warmUpStartedAt || null })
  };
}

function buildBudgetOptions(config = {}) {
  return {
    accountId:    config.accountId    || null,
    accountEmail: config.accountEmail || config.email || null,
    budgetPath:   config.budgetPath   || null,
    dailyBudget:  config.dailyBudget  || null
  };
}

function buildHumanDelayOptions(config = {}, delayRng) {
  const delayProfile = config.delayProfile || config.delayProfileSeed || null;
  return typeof delayRng === 'function'
    ? { delayProfile, rng: delayRng }
    : { delayProfile };
}

function getTransportHealthGuardResult(
  stepType,
  config = {},
  transportHealthStore = getDefaultTransportHealthStore(),
  options = {}
) {
  if (!transportHealthStore || typeof transportHealthStore.isTransportDisabled !== 'function') {
    return null;
  }

  const accountEmail = cleanAccountEmail(config.accountEmail || config.email || null);
  if (!accountEmail) {
    return null;
  }

  const context = resolveTransportHealthContext(stepType, config, transportHealthStore, options);
  if (!context) {
    return null;
  }

  if (!transportHealthStore.isTransportDisabled(context.transport, context.action, accountEmail)) {
    return null;
  }

  return createWorkflowStepResult({
    stepType,
    outcomeType: 'skipped_transport_unhealthy',
    reason: `Action skipped: ${context.transport} transport is temporarily unhealthy for ${context.action}`,
    profileUrl: options.profileUrl || null,
    recipientName: options.recipientName || null,
    metadata: buildWorkflowStepMetadata({
      transport: context.transport,
      action: context.action
    })
  });
}

function resolveTransportHealthContext(
  stepType,
  config = {},
  transportHealthStore = getDefaultTransportHealthStore(),
  options = {}
) {
  const normalizedStepType = String(stepType || '').trim();
  switch (normalizedStepType) {
    case 'send_connection':
    case 'send_dm':
      return {
        transport: 'dom',
        action: mapStepTypeToPrivateApiAction(normalizedStepType)
      };
    default:
      return null;
  }
}

function cleanAccountEmail(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
}

function mapStepTypeToPrivateApiAction(stepType) {
  const normalized = String(stepType || '').trim();
  switch (normalized) {
    case 'send_connection':
      return 'send_connection';
    case 'send_dm':
      return 'send_dm';
    default:
      return normalized;
  }
}

function getDefaultTransportHealthStore() {
  if (!defaultTransportHealthStore) {
    defaultTransportHealthStore = new TransportHealthStore();
  }
  return defaultTransportHealthStore;
}

function getActionQuotaExceededResult(stepType, actionType, quotaState, extra = {}) {
  return createWorkflowStepResult({
    stepType,
    outcomeType: 'skipped_quota_exceeded',
    reason: buildQuotaExceededReason(actionType, quotaState),
    profileUrl: extra.profileUrl || null,
    recipientName: extra.recipientName || null,
    metadata: buildWorkflowStepMetadata({
      actionType,
      exceeded: Array.isArray(quotaState?.exceeded) ? quotaState.exceeded : undefined,
      quota: quotaState?.quota || undefined
    })
  });
}

function buildManagedElsewhereResult(stepType, summary, extra = {}) {
  const primary = summary?.handlersInContact?.[0] || null;
  const reason = primary
    ? primary.contactStage === 'responded'
      ? `Prospect already replied to ${formatContactOwnerLabel(primary)} and is being handled there`
      : `Prospect already has an accepted connection with ${formatContactOwnerLabel(primary)} and is being handled there`
    : 'Prospect is already being handled by another SDR account';

  return createWorkflowStepResult({
    stepType,
    outcomeType: 'skipped_managed_elsewhere',
    reason,
    profileUrl: extra.profileUrl || null,
    recipientName: extra.recipientName || null,
    metadata: buildWorkflowStepMetadata({
      blockReason: summary?.blockReason || null,
      leadIdentityKey: summary?.leadIdentityKey || null,
      blockingProspectId: primary?.prospectId || null,
      blockingAccountId: primary?.accountId || null,
      blockingAccountName: primary?.accountName || null,
      blockingAgentId: primary?.agentId || null,
      blockingAgentName: primary?.agentName || null,
      blockingContactStage: primary?.contactStage || null,
      relatedProspectCount: Array.isArray(summary?.relatedProspectIds)
        ? summary.relatedProspectIds.length
        : undefined
    })
  });
}

function buildDoNotContactResult(stepType, summary = {}, extra = {}) {
  const reason = summary.reason === 'prospect_archived'
    ? 'Prospect is archived and marked do not contact'
    : 'Prospect is marked do not contact';

  return createWorkflowStepResult({
    stepType,
    outcomeType: 'skipped_do_not_contact',
    reason,
    profileUrl: extra.profileUrl || null,
    recipientName: extra.recipientName || null,
    metadata: buildWorkflowStepMetadata({
      prospectId: summary.prospectId || null,
      doNotContact: summary.doNotContact === true,
      archived: summary.archived === true,
      archiveReason: summary.archiveReason || null
    })
  });
}

function formatContactOwnerLabel(entry = {}) {
  const agentName = String(entry.agentName || '').trim();
  const accountName = String(entry.accountName || '').trim();
  if (agentName && accountName) return `${agentName} (${accountName})`;
  return agentName || accountName || 'another SDR account';
}

function resolveManagedElsewhereSummary(prospectQueueStore, config = {}, prospect, resolvedTarget, recipientName) {
  return prospectQueueStore.getContactOwnershipSummary({
    prospectId: config.prospectId || prospect?.id || null,
    accountId: config.accountId || prospect?.accountId || null,
    agentId: config.agentId || prospect?.agentId || null,
    fullName: prospect?.fullName || recipientName || null,
    company: prospect?.company || null,
    profileUrl: prospect?.profileUrl || resolvedTarget?.profileUrl || null
  });
}

function mapDmOutcome(result = {}) {
  switch (result.reason) {
    case 'recent_message_exists':
      return 'skipped_thread_exists';
    case 'missing_template_fields':
    case 'missing_recipient_name':
      return 'failed_permanent';
    case 'conversation_not_found':
      return 'skipped_not_connected';
    case 'navigation_failed':
    case 'profile_extraction_failed':
    case 'message_interface_failed':
    case 'send_failed':
    case 'quota_exceeded':
      return 'skipped_quota_exceeded';
    case 'private_api_dry_run_failed':
    case 'missing_messaging_context':
    case 'missing_recipient_profile_urn':
    case 'missing_message_response':
    case 'exception':
    default:
      return 'failed_transient';
  }
}

module.exports = {
  executeWorkflowStep,
  _private: {
    deriveRecipientNameFromProfileUrl,
    normalizeLinkedInProfilePath,
    isSameLinkedInProfilePage,
    resolveKnownTargetFromConfig,
    resolveWorkflowTarget,
    buildWorkflowStepMetadata,
    buildActionQuotaOptions,
    buildBudgetOptions,
    buildHumanDelayOptions,
    getTransportHealthGuardResult,
    resolveTransportHealthContext,
    mapStepTypeToPrivateApiAction,
    getDefaultTransportHealthStore,
    mapDmOutcome,
    resolveDoNotContactSummary,
    buildDoNotContactResult,
    getActionQuotaExceededResult,
    buildManagedElsewhereResult,
    formatContactOwnerLabel
  }
};
