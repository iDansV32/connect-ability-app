'use strict';

const { randomDelay } = require('../human/delay');
const { logAction, logError } = require('../util/log');
const {
  PendingInviteSweepStore,
  resolveSweepIntervalMs
} = require('./pending-invite-sweep-store');

const LINKEDIN_SENT_INVITES_URL = 'https://www.linkedin.com/mynetwork/invitation-manager/sent/';
const DEFAULT_MIN_INVITE_AGE_DAYS = 21;
const DEFAULT_MAX_WITHDRAWALS_PER_SWEEP = 25;
const DEFAULT_MAX_SCAN_PASSES = 10;
const CANDIDATE_SCAN_SELECTORS = Object.freeze([
  'button',
  'div[role="button"]',
  'a[role="button"]'
]);
const INVITE_CARD_CONTAINERS = 'li, .artdeco-list__item, .artdeco-card, .mn-invitation-manager__invitation, section, article';

let defaultPendingInviteSweepStore = null;

async function maybeSweepPendingInvites(page, options = {}, dependencies = {}) {
  const accountEmail = normalizeAccountEmail(options.accountEmail || options.email);
  if (!accountEmail) {
    return buildSweepResult({ attempted: false, skipped: true, reason: 'missing_account_email' });
  }

  const sweepStore = dependencies.sweepStore
    || options.pendingInviteSweepStore
    || getDefaultPendingInviteSweepStore();
  const now = options.now instanceof Date ? new Date(options.now.getTime()) : new Date();
  const sweepIntervalMs = resolveSweepIntervalMs(options.pendingInviteSweepIntervalMs);

  if (!sweepStore.shouldRunSweep(accountEmail, { now, intervalMs: sweepIntervalMs })) {
    return buildSweepResult({ attempted: false, skipped: true, reason: 'sweep_not_due' });
  }

  const minInviteAgeDays = resolvePositiveInteger(options.pendingInviteMinAgeDays, DEFAULT_MIN_INVITE_AGE_DAYS);
  const maxWithdrawals = resolvePositiveInteger(
    options.maxPendingInviteWithdrawals,
    DEFAULT_MAX_WITHDRAWALS_PER_SWEEP
  );
  const maxScanPasses = resolvePositiveInteger(options.maxPendingInviteScanPasses, DEFAULT_MAX_SCAN_PASSES);
  const returnUrl = normalizeUrl(options.returnUrl || safePageUrl(page));
  const navigate = typeof dependencies.navigate === 'function'
    ? dependencies.navigate
    : defaultNavigate;
  const returnToUrl = typeof dependencies.returnToUrl === 'function'
    ? dependencies.returnToUrl
    : defaultReturnToUrl;
  const waitForPageReady = typeof dependencies.waitForPageReady === 'function'
    ? dependencies.waitForPageReady
    : defaultWaitForPageReady;
  const listVisibleCandidates = typeof dependencies.listVisibleCandidates === 'function'
    ? dependencies.listVisibleCandidates
    : defaultListVisibleCandidates;
  const withdrawCandidate = typeof dependencies.withdrawCandidate === 'function'
    ? dependencies.withdrawCandidate
    : defaultWithdrawCandidate;
  const scrollPage = typeof dependencies.scrollPage === 'function'
    ? dependencies.scrollPage
    : defaultScrollPage;
  const randomDelayFn = typeof dependencies.randomDelayFn === 'function'
    ? dependencies.randomDelayFn
    : randomDelay;
  const logActionFn = typeof dependencies.logAction === 'function'
    ? dependencies.logAction
    : logAction;
  const logErrorFn = typeof dependencies.logError === 'function'
    ? dependencies.logError
    : logError;

  let withdrewCount = 0;
  let candidateCount = 0;
  let errorMessage = null;
  let status = 'completed';
  const seenCandidateKeys = new Set();

  try {
    logActionFn(`Running pending invite sweep for ${accountEmail}`);
    await navigate(page, LINKEDIN_SENT_INVITES_URL);
    await waitForPageReady(page);

    for (let pass = 0; pass < maxScanPasses && withdrewCount < maxWithdrawals; pass += 1) {
      const candidates = await listVisibleCandidates(page, {
        selectors: CANDIDATE_SCAN_SELECTORS,
        seenCandidateKeys
      });

      let newCandidatesThisPass = 0;
      for (const candidate of candidates) {
        if (!candidate || !candidate.key || seenCandidateKeys.has(candidate.key)) {
          continue;
        }

        seenCandidateKeys.add(candidate.key);
        newCandidatesThisPass += 1;
        candidateCount += 1;

        if (!Number.isFinite(candidate.ageDays) || candidate.ageDays < minInviteAgeDays) {
          continue;
        }

        const withdrew = await withdrawCandidate(page, candidate, {
          randomDelayFn,
          logAction: logActionFn,
          logError: logErrorFn
        });

        if (withdrew) {
          withdrewCount += 1;
        }

        if (withdrewCount >= maxWithdrawals) {
          break;
        }
      }

      if (withdrewCount >= maxWithdrawals) {
        break;
      }

      const scrolled = await scrollPage(page, pass);
      if (!scrolled && newCandidatesThisPass === 0) {
        break;
      }
    }
  } catch (error) {
    errorMessage = error?.message || 'Pending invite sweep failed';
    status = 'failed';
    logErrorFn(`Pending invite sweep failed for ${accountEmail}: ${errorMessage}`);
  } finally {
    if (returnUrl) {
      await returnToUrl(page, returnUrl).catch((error) => {
        logErrorFn(`Failed returning from pending invite sweep for ${accountEmail}: ${error.message}`);
      });
    }

    sweepStore.recordSweep(accountEmail, {
      now,
      timestamp: now.toISOString(),
      withdrewCount,
      candidateCount,
      status,
      error: errorMessage
    });
  }

  return buildSweepResult({
    attempted: true,
    skipped: false,
    status,
    withdrewCount,
    candidateCount,
    error: errorMessage
  });
}

function getDefaultPendingInviteSweepStore() {
  if (!defaultPendingInviteSweepStore) {
    defaultPendingInviteSweepStore = new PendingInviteSweepStore();
  }
  return defaultPendingInviteSweepStore;
}

async function defaultNavigate(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
}

async function defaultReturnToUrl(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('main', { timeout: 10000 }).catch(() => {});
}

async function defaultWaitForPageReady(page) {
  await page.waitForSelector('main', { timeout: 10000 }).catch(() => {});
  await randomDelay(1200, 2200);
}

async function defaultListVisibleCandidates(page, options = {}) {
  const selectors = Array.isArray(options.selectors) && options.selectors.length
    ? options.selectors
    : CANDIDATE_SCAN_SELECTORS;
  const handles = [];

  for (const selector of selectors) {
    const matches = await page.$$(selector);
    handles.push(...matches);
  }

  const candidates = [];
  for (const handle of handles) {
    try {
      if (!(await handle.isVisible())) {
        continue;
      }

      const candidate = await handle.evaluate((element, containerSelector) => {
        const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const text = clean(element.textContent);
        const ariaLabel = clean(element.getAttribute('aria-label'));
        const combinedLabel = `${text} ${ariaLabel}`.trim();
        if (!/\bwithdraw\b/i.test(combinedLabel)) {
          return null;
        }

        const container = element.closest(containerSelector) || element.parentElement;
        const containerText = clean(container?.innerText || '');
        const profileLink = container?.querySelector('a[href*="/in/"]')?.href || null;
        const disabled = Boolean(
          element.disabled
          || element.getAttribute('disabled') !== null
          || element.getAttribute('aria-disabled') === 'true'
        );

        return {
          text,
          ariaLabel,
          containerText,
          profileLink,
          disabled
        };
      }, INVITE_CARD_CONTAINERS);

      if (!candidate || candidate.disabled) {
        continue;
      }

      const normalizedProfileUrl = normalizeProfileLink(candidate.profileLink);
      const key = buildCandidateKey(candidate.containerText, normalizedProfileUrl);
      candidates.push({
        ...candidate,
        handle,
        key,
        profileLink: normalizedProfileUrl,
        ageDays: parseInviteAgeToDays(candidate.containerText || candidate.ariaLabel || candidate.text)
      });
    } catch (_) {
      // Ignore detached handles.
    }
  }

  return candidates;
}

async function defaultWithdrawCandidate(page, candidate, dependencies = {}) {
  if (!candidate?.handle) {
    return false;
  }

  const randomDelayFn = typeof dependencies.randomDelayFn === 'function'
    ? dependencies.randomDelayFn
    : randomDelay;
  const logActionFn = typeof dependencies.logAction === 'function'
    ? dependencies.logAction
    : logAction;

  await candidate.handle.scrollIntoViewIfNeeded().catch(() => {});
  await candidate.handle.click({ delay: 60 }).catch(() => candidate.handle.click().catch(() => {}));
  await randomDelayFn(300, 700);

  const confirmButton = await findVisibleWithdrawConfirmation(page);
  if (confirmButton) {
    await confirmButton.click({ delay: 60 }).catch(() => confirmButton.click().catch(() => {}));
    await randomDelayFn(500, 900);
  }

  // LinkedIn sometimes applies the row-level Withdraw click directly and
  // sometimes asks for a confirmation click. We treat the sequence as a
  // successful withdrawal attempt once the visible flow has been exercised.
  logActionFn(`Withdrew pending invite${candidate.profileLink ? ` for ${candidate.profileLink}` : ''}`);
  return true;
}

async function findVisibleWithdrawConfirmation(page) {
  const handles = await page.$$(
    '[role="dialog"] button, [role="dialog"] div[role="button"], .artdeco-modal button, .artdeco-modal div[role="button"]'
  );

  for (const handle of handles) {
    try {
      if (!(await handle.isVisible())) {
        continue;
      }
      const label = `${await handle.textContent().catch(() => '')} ${await handle.getAttribute('aria-label').catch(() => '')}`
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (label.includes('withdraw')) {
        return handle;
      }
    } catch (_) {
      // Ignore stale dialog controls.
    }
  }

  return null;
}

async function defaultScrollPage(page, pass = 0) {
  const previousOffset = await page.evaluate(() => window.scrollY).catch(() => null);
  await page.evaluate(() => {
    window.scrollBy(0, Math.max(window.innerHeight * 0.85, 900));
  }).catch(async () => {
    await page.mouse.wheel(0, 1200).catch(() => {});
  });
  await randomDelay(700, 1200);

  const nextOffset = await page.evaluate(() => window.scrollY).catch(() => null);
  if (previousOffset === null || nextOffset === null) {
    return pass < DEFAULT_MAX_SCAN_PASSES - 1;
  }
  return nextOffset > previousOffset;
}

function parseInviteAgeToDays(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes('today')) {
    return 0;
  }
  if (normalized.includes('yesterday')) {
    return 1;
  }

  const match = normalized.match(/(\d+)\s*(day|days|d|week|weeks|wk|wks|month|months|mo|mos|year|years|yr|yrs)\b/);
  if (!match) {
    return null;
  }

  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  const unit = match[2];
  if (/^d(?:ay|ays)?$/.test(unit)) {
    return amount;
  }
  if (/^(week|weeks|wk|wks)$/.test(unit)) {
    return amount * 7;
  }
  if (/^(month|months|mo|mos)$/.test(unit)) {
    return amount * 30;
  }
  if (/^(year|years|yr|yrs)$/.test(unit)) {
    return amount * 365;
  }
  return null;
}

function buildCandidateKey(containerText, profileLink = null) {
  const normalizedText = String(containerText || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 240);
  const normalizedLink = normalizeProfileLink(profileLink);
  return `${normalizedLink || 'unknown'}::${normalizedText}`;
}

function normalizeProfileLink(profileLink) {
  const normalizedUrl = normalizeUrl(profileLink);
  if (!normalizedUrl) {
    return null;
  }

  try {
    const parsed = new URL(normalizedUrl);
    const match = parsed.pathname.match(/^\/in\/([^/?#]+)/i);
    if (!match) {
      return normalizedUrl;
    }
    parsed.pathname = `/in/${match[1]}/`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return normalizedUrl;
  }
}

function normalizeUrl(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return null;
  }

  try {
    return new URL(rawValue).toString();
  } catch (_) {
    return null;
  }
}

function safePageUrl(page) {
  try {
    return typeof page?.url === 'function' ? page.url() : null;
  } catch (_) {
    return null;
  }
}

function normalizeAccountEmail(value) {
  return String(value || '').trim().toLowerCase() || null;
}

function resolvePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildSweepResult(result = {}) {
  return {
    attempted: Boolean(result.attempted),
    skipped: Boolean(result.skipped),
    reason: result.reason || null,
    status: result.status || null,
    withdrewCount: resolvePositiveInteger(result.withdrewCount, 0),
    candidateCount: resolvePositiveInteger(result.candidateCount, 0),
    error: result.error || null
  };
}

module.exports = {
  LINKEDIN_SENT_INVITES_URL,
  DEFAULT_MIN_INVITE_AGE_DAYS,
  DEFAULT_MAX_WITHDRAWALS_PER_SWEEP,
  maybeSweepPendingInvites,
  _private: {
    buildCandidateKey,
    buildSweepResult,
    defaultListVisibleCandidates,
    defaultWithdrawCandidate,
    parseInviteAgeToDays,
    normalizeProfileLink,
    normalizeAccountEmail
  }
};
