'use strict';

const { createWorkflowStepResult } = require('../../workflow-step-result');
const {
  buildQuotaExceededReason,
  canConsumeActionQuota,
  consumeActionQuota
} = require('../../linkedin-action-quota-store');
const { traceAction } = require('../network/tracer');
const { logAction, logError } = require('../util/log');
const { randomDelay } = require('../human/delay');

// ---------------------------------------------------------------------------
// DOM selectors for the Skills section on a LinkedIn profile page.
//
// LinkedIn renders skills in a dedicated "Skills" section.  Each skill has
// an "Endorse" button (a + icon or "Endorse" text) if the viewer can endorse
// it.  Already-endorsed skills show a filled state / checkmark.
//
// The skills section is identified by its id `skills` or by an anchor with
// that hash, or by heading text.  Individual skill items live inside list
// elements.
// ---------------------------------------------------------------------------

const SKILLS_SECTION_SELECTORS = [
  '#skills',
  'section[id*="skills" i]',
  'section:has(> div > div > h2:is([id*="skill" i]))',
  '[data-section="skills"]'
].join(', ');

const ENDORSE_BUTTON_SELECTORS = [
  'button[aria-label*="Endorse" i]:not([aria-label*="Endorsed" i])',
  'button.endorse-button:not(.endorsed)',
  'button[data-control-name="endorse"]',
  'button svg[data-test-icon="add-small"]'
].join(', ');

const ENDORSED_INDICATOR_SELECTORS = [
  'button[aria-label*="Endorsed" i]',
  'button.endorse-button.endorsed',
  'button[aria-pressed="true"][aria-label*="ndorse" i]'
].join(', ');

/**
 * Read the endorsement state from the current profile page.
 *
 * Returns the count of endorseable skills, already-endorsed skills,
 * and the skill names visible on the page.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{
 *   endorseableCount: number,
 *   endorsedCount: number,
 *   totalSkills: number,
 *   endorseableSkills: string[],
 *   alreadyEndorsedSkills: string[]
 * }>}
 */
async function readEndorsementState(page) {
  return page.evaluate((selectors) => {
    const { sectionSel, endorseSel, endorsedSel } = selectors;
    const root = document.querySelector('main') || document.body;

    // Find the skills section
    const skillsSection = root.querySelector(sectionSel);
    if (!skillsSection) {
      return {
        endorseableCount: 0,
        endorsedCount: 0,
        totalSkills: 0,
        endorseableSkills: [],
        alreadyEndorsedSkills: []
      };
    }

    // Collect endorseable buttons and their associated skill names
    const endorseButtons = skillsSection.querySelectorAll(endorseSel);
    const endorseableSkills = [];
    for (const btn of endorseButtons) {
      // Try to extract skill name from aria-label or nearby text
      const ariaLabel = (btn.getAttribute('aria-label') || '').trim();
      const nameMatch = ariaLabel.match(/Endorse\s+(.+?)(?:\s+for)?/i);
      const skillName = nameMatch
        ? nameMatch[1].trim()
        : (btn.closest('li, [class*="skill"]')?.querySelector('[class*="name"], span')?.textContent || '').trim();
      if (skillName) {
        endorseableSkills.push(skillName);
      } else {
        endorseableSkills.push('(unnamed skill)');
      }
    }

    // Collect already-endorsed indicators
    const endorsedButtons = skillsSection.querySelectorAll(endorsedSel);
    const alreadyEndorsedSkills = [];
    for (const btn of endorsedButtons) {
      const ariaLabel = (btn.getAttribute('aria-label') || '').trim();
      const nameMatch = ariaLabel.match(/Endorsed?\s+(.+?)(?:\s+for)?/i);
      const skillName = nameMatch
        ? nameMatch[1].trim()
        : (btn.closest('li, [class*="skill"]')?.querySelector('[class*="name"], span')?.textContent || '').trim();
      if (skillName) {
        alreadyEndorsedSkills.push(skillName);
      } else {
        alreadyEndorsedSkills.push('(unnamed skill)');
      }
    }

    return {
      endorseableCount: endorseButtons.length,
      endorsedCount: endorsedButtons.length,
      totalSkills: endorseButtons.length + endorsedButtons.length,
      endorseableSkills,
      alreadyEndorsedSkills
    };
  }, {
    sectionSel: SKILLS_SECTION_SELECTORS,
    endorseSel: ENDORSE_BUTTON_SELECTORS,
    endorsedSel: ENDORSED_INDICATOR_SELECTORS
  }).catch(() => ({
    endorseableCount: 0,
    endorsedCount: 0,
    totalSkills: 0,
    endorseableSkills: [],
    alreadyEndorsedSkills: []
  }));
}

/**
 * Click up to `maxEndorsements` endorse buttons on the current profile page.
 *
 * @param {import('playwright').Page} page
 * @param {number} maxEndorsements
 * @returns {Promise<{ endorsed: number, errors: number, skills: string[] }>}
 */
async function clickEndorseButtons(page, maxEndorsements) {
  return page.evaluate((args) => {
    const { sectionSel, endorseSel, max } = args;
    const root = document.querySelector('main') || document.body;
    const skillsSection = root.querySelector(sectionSel);
    if (!skillsSection) {
      return { endorsed: 0, errors: 0, skills: [] };
    }

    const buttons = skillsSection.querySelectorAll(endorseSel);
    let endorsed = 0;
    let errors = 0;
    const skills = [];

    for (let i = 0; i < buttons.length && endorsed < max; i++) {
      try {
        const btn = buttons[i];
        const ariaLabel = (btn.getAttribute('aria-label') || '').trim();
        const nameMatch = ariaLabel.match(/Endorse\s+(.+?)(?:\s+for)?/i);
        const skillName = nameMatch
          ? nameMatch[1].trim()
          : (btn.closest('li, [class*="skill"]')?.querySelector('[class*="name"], span')?.textContent || '').trim();

        btn.click();
        endorsed++;
        skills.push(skillName || '(unnamed skill)');
      } catch (_) {
        errors++;
      }
    }

    return { endorsed, errors, skills };
  }, {
    sectionSel: SKILLS_SECTION_SELECTORS,
    endorseSel: ENDORSE_BUTTON_SELECTORS,
    max: maxEndorsements
  }).catch((err) => ({
    endorsed: 0,
    errors: 1,
    skills: [],
    error: err.message || 'click_error'
  }));
}

/**
 * Verify endorsements were applied by re-reading the page state and comparing
 * against the pre-click snapshot.
 *
 * @param {import('playwright').Page} page
 * @param {number} expectedCount - how many endorsements we attempted
 * @param {{ endorsedCount: number, endorseableCount: number }} preClickState - state before clicking
 * @returns {Promise<{ verified: boolean, method: string, at: string, reason?: string, metadata?: object }>}
 */
async function verifyEndorsements(page, expectedCount, preClickState) {
  const at = new Date().toISOString();
  try {
    await randomDelay(1500, 3000);
    const state = await readEndorsementState(page);

    const endorsedDelta = state.endorsedCount - (preClickState ? preClickState.endorsedCount : 0);
    const endorseableDelta = (preClickState ? preClickState.endorseableCount : 0) - state.endorseableCount;

    // Require either an increase in endorsed count or a decrease in
    // endorseable count relative to the pre-click snapshot.  This prevents
    // false-positive verification on profiles that already had endorsed
    // skills before we clicked anything.
    if (endorsedDelta > 0 || endorseableDelta > 0) {
      return {
        verified: true,
        method: 'dom',
        at,
        metadata: {
          endorsedCount: state.endorsedCount,
          endorseableCount: state.endorseableCount,
          endorsedDelta,
          endorseableDelta
        }
      };
    }

    return {
      verified: false,
      method: 'dom',
      at,
      reason: 'No change in endorsement state after clicking',
      metadata: {
        endorsedCount: state.endorsedCount,
        endorseableCount: state.endorseableCount,
        preClickEndorsedCount: preClickState ? preClickState.endorsedCount : 0,
        preClickEndorseableCount: preClickState ? preClickState.endorseableCount : 0
      }
    };
  } catch (err) {
    return {
      verified: false,
      method: 'dom',
      at,
      reason: err.message || 'verification_error'
    };
  }
}

/**
 * Maximum number of skills to endorse per step execution.
 * Keeps the action bounded and human-like.
 */
const MAX_ENDORSEMENTS_PER_STEP = 3;

/**
 * Execute an endorse_skills action on the given page.
 *
 * Expects the page to already be on the target's LinkedIn profile URL.
 *
 * @param {import('playwright').Page} page
 * @param {string} profileUrl
 * @param {object} [options]
 * @param {boolean} [options.strictStealth]
 * @param {string}  [options.quotaPath]
 * @param {string}  [options.accountId]
 * @param {string}  [options.accountEmail]
 * @param {number}  [options.warmUpMultiplier]
 * @param {number}  [options.maxEndorsements]
 * @returns {Promise<import('../../workflow-step-result').WorkflowStepResult>}
 */
async function endorseSkillsDetailed(page, profileUrl, options = {}) {
  const maxEndorsements = Math.min(
    Math.max(1, Number(options.maxEndorsements) || MAX_ENDORSEMENTS_PER_STEP),
    MAX_ENDORSEMENTS_PER_STEP
  );

  return traceAction(
    page,
    'endorse_skills',
    { profileUrl, maxEndorsements },
    async () => {
      try {
        // Quota check
        const quotaState = canConsumeActionQuota('skill_endorsed', 1, options);
        if (!quotaState.allowed) {
          return createWorkflowStepResult({
            stepType: 'endorse_skills',
            outcomeType: 'skipped_quota_exceeded',
            reason: buildQuotaExceededReason('skill_endorsed', quotaState),
            profileUrl,
            metadata: {
              actionType: 'skill_endorsed',
              exceeded: quotaState.exceeded,
              quota: quotaState.quota
            }
          });
        }

        // Read current endorsement state
        const state = await readEndorsementState(page);

        if (state.totalSkills === 0) {
          logAction(`No skills section found on profile: ${profileUrl}`);
          return createWorkflowStepResult({
            stepType: 'endorse_skills',
            outcomeType: 'skipped_no_endorseable_skills',
            reason: 'No skills section found on profile page',
            profileUrl,
            metadata: { totalSkills: 0, endorseableCount: 0 }
          });
        }

        if (state.endorseableCount === 0) {
          if (state.endorsedCount > 0) {
            logAction(`All visible skills already endorsed on profile: ${profileUrl}`);
            return createWorkflowStepResult({
              stepType: 'endorse_skills',
              outcomeType: 'skipped_already_endorsed',
              reason: 'All visible skills are already endorsed',
              profileUrl,
              metadata: {
                alreadyEndorsed: true,
                endorsedCount: state.endorsedCount,
                alreadyEndorsedSkills: state.alreadyEndorsedSkills
              }
            });
          }

          logAction(`No endorseable skills available on profile: ${profileUrl}`);
          return createWorkflowStepResult({
            stepType: 'endorse_skills',
            outcomeType: 'skipped_no_endorseable_skills',
            reason: 'No endorseable skills available on profile page',
            profileUrl,
            metadata: {
              endorseableCount: 0,
              endorsedCount: state.endorsedCount,
              totalSkills: state.totalSkills
            }
          });
        }

        // Click endorse buttons
        const clickResult = await clickEndorseButtons(page, maxEndorsements);

        if (clickResult.endorsed === 0) {
          logAction(`Failed to endorse any skills: ${clickResult.error || 'unknown'}`);
          return createWorkflowStepResult({
            stepType: 'endorse_skills',
            outcomeType: 'failed_transient',
            reason: `Could not click any endorse buttons: ${clickResult.error || 'no buttons responded'}`,
            profileUrl,
            metadata: { clickResult }
          });
        }

        // Verify the endorsements took effect
        const verification = await verifyEndorsements(page, clickResult.endorsed, state);

        if (verification.verified) {
          consumeActionQuota('skill_endorsed', 1, options);
          logAction(`Successfully endorsed ${clickResult.endorsed} skill(s) on profile: ${profileUrl}`);
          return createWorkflowStepResult({
            stepType: 'endorse_skills',
            outcomeType: 'completed',
            profileUrl,
            verificationResult: verification,
            metadata: {
              endorsedSkills: clickResult.skills,
              endorsedCount: clickResult.endorsed,
              errors: clickResult.errors
            }
          });
        }

        // Clicks succeeded but verification failed — still count as transient
        logAction(`Endorse clicks succeeded but verification failed: ${verification.reason}`);
        return createWorkflowStepResult({
          stepType: 'endorse_skills',
          outcomeType: 'failed_transient',
          reason: `Endorsed ${clickResult.endorsed} skill(s) but could not verify: ${verification.reason}`,
          profileUrl,
          verificationResult: verification,
          metadata: {
            endorsed: clickResult.endorsed,
            skills: clickResult.skills,
            verified: false
          }
        });
      } catch (error) {
        logError('Error during endorse_skills', error);
        return createWorkflowStepResult({
          stepType: 'endorse_skills',
          outcomeType: 'failed_transient',
          reason: error.message || 'Error during endorse_skills',
          profileUrl
        });
      }
    }
  );
}

module.exports = {
  readEndorsementState,
  clickEndorseButtons,
  verifyEndorsements,
  endorseSkillsDetailed,
  MAX_ENDORSEMENTS_PER_STEP
};
