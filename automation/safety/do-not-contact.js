'use strict';

/**
 * Do-not-contact policy — shared between the action-router (canonical
 * workflow execution) and the MCP server (one-shot run_linkedin_action).
 *
 * Whenever a prospect is suppressed, both paths must agree on the rule.
 * Keeping the rule in one place removes the drift risk: if we ever decide
 * that, say, a `metadata.complianceHold` flag should also block, only this
 * file changes.
 *
 * Inputs are a single prospect record (normalized or raw). The function does
 * not look up related prospects — callers do that lookup themselves and may
 * pass each candidate in turn. See ProspectQueueStore.getRelatedProspects.
 */

/**
 * @typedef {object} DoNotContactSummary
 * @property {boolean} blocked
 * @property {string|null} [prospectId]
 * @property {boolean} [doNotContact]
 * @property {boolean} [archived]
 * @property {string|null} [archiveReason]
 * @property {'prospect_archived'|'do_not_contact'} [reason]
 */

/**
 * Evaluate a single prospect against the DNC policy.
 *
 * Block conditions (either is sufficient):
 *   - state === 'archived'          → reason: 'prospect_archived'
 *   - metadata.doNotContact === true → reason: 'do_not_contact'
 *
 * The 'archived' state takes precedence in the reason field because archived
 * implies doNotContact (archiveProspect always sets both) but not vice versa;
 * the more specific signal wins.
 *
 * @param {object|null} prospect
 * @returns {DoNotContactSummary}
 */
function resolveDoNotContactSummary(prospect = null) {
  if (!prospect || typeof prospect !== 'object') {
    return { blocked: false };
  }

  const metadata = prospect.metadata && typeof prospect.metadata === 'object' ? prospect.metadata : {};
  const doNotContact = metadata.doNotContact === true;
  const archived = String(prospect.state || '').trim().toLowerCase() === 'archived';
  if (!doNotContact && !archived) {
    return { blocked: false };
  }

  return {
    blocked: true,
    prospectId: prospect.id || null,
    doNotContact,
    archived,
    archiveReason: typeof metadata.archiveReason === 'string' ? metadata.archiveReason : null,
    reason: archived ? 'prospect_archived' : 'do_not_contact'
  };
}

module.exports = {
  resolveDoNotContactSummary
};
