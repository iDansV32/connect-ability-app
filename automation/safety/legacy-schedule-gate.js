'use strict';

const { isWithinWorkingHours } = require('./working-hours');

/**
 * Safety gate for the legacy scheduled-message path
 * (main.js executeScheduledMessage → automation.js child process).
 *
 * The durable-workflow scheduler blocks cooling/challenged/out-of-hours
 * accounts before dispatching any step. The legacy path historically had no
 * screening at all: a 60-second timer spawned a cold-login browser against a
 * possibly-challenged account. This gate applies the same three checks so the
 * two execution paths share one safety posture.
 *
 * Pure and injectable: the health store and working-hours predicate are
 * dependencies so the decision is unit-testable offline.
 *
 * @param {object} input
 * @param {object} input.account       — account record; needs id plus the
 *                                       timezoneId/workingHours fields the
 *                                       working-hours check consumes
 * @param {object} [input.healthStore] — LinkedInAccountHealthStore-shaped
 *                                       (isChallenged, isCoolingDown)
 * @param {Date}   [input.now]
 * @param {Function} [input.workingHoursCheck] — (account, now) => boolean
 * @returns {{allowed: boolean, code: string, reason: string|null}}
 */
function evaluateLegacyScheduledMessageGate(input = {}) {
  const account = input.account || {};
  const healthStore = input.healthStore || null;
  const now = input.now instanceof Date ? input.now : new Date();
  const workingHoursCheck = typeof input.workingHoursCheck === 'function'
    ? input.workingHoursCheck
    : isWithinWorkingHours;

  const accountId = account.id || account.accountId || null;

  if (healthStore && accountId) {
    if (typeof healthStore.isChallenged === 'function' && healthStore.isChallenged(accountId)) {
      return {
        allowed: false,
        code: 'account_challenged',
        reason: 'Account has an unresolved LinkedIn challenge; scheduled message blocked'
      };
    }
    if (
      typeof healthStore.isCoolingDown === 'function'
      && healthStore.isCoolingDown(accountId, 'workflow', now)
    ) {
      return {
        allowed: false,
        code: 'account_cooling_down',
        reason: 'Account is cooling down after automation failures; scheduled message blocked'
      };
    }
  }

  if (!workingHoursCheck(account, now)) {
    return {
      allowed: false,
      code: 'outside_working_hours',
      reason: "Outside the account's configured working hours; scheduled message blocked"
    };
  }

  return { allowed: true, code: 'ok', reason: null };
}

module.exports = { evaluateLegacyScheduledMessageGate };
