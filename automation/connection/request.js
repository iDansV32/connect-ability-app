// ============================================
// FIXED connection/request.js
// ============================================
const { randomDelay } = require('../human/delay');
const { logAction, logError } = require('../util/log');
const { handleConnectionDialog } = require('./dialog');
const { traceAction } = require('../network/tracer');
const { createWorkflowStepResult } = require('../../workflow-step-result');
const { verifyConnectionSent } = require('../runtime/verification');
const { readConnectionState } = require('./state');
const { maybeSweepPendingInvites } = require('../safety/pending-invite-manager');
const { stealthClick } = require('../mouse/stealth-click');
const {
  buildQuotaExceededReason,
  canConsumeActionQuota,
  consumeActionQuota
} = require('../../linkedin-action-quota-store');

// ---------------------------------------------------------------------------
// Connect-button selectors, ordered from most-specific → least-specific.
//
// CRITICAL: Sidebar recommendation cards (inside `aside` or the scaffold
// aside column) also contain "Connect" buttons for other people.
// `findVisibleHandle` returns the first visible match, so we must either:
//   (a) scope to the profile hero CTA container, or
//   (b) explicitly exclude the sidebar via `:not(aside *)`.
//
// Strategy: try known profile-hero containers first, then exclude-sidebar
// selectors, then last-resort broad selectors (which CAN hit sidebar —
// only reached if everything else failed).
// ---------------------------------------------------------------------------

const PROFILE_ACTION_CONTAINER_SELECTORS = Object.freeze([
  '.pv-top-card-v2-ctas',
  '.pvs-profile-actions',
  '.pv-top-card__cta-container',
  '.pv-top-card-v2-ctas__action-btns'
]);

const CONNECTION_SELECTORS = Object.freeze([
  // 1. Aria-label based — works for both <a> and <button> elements.
  //    LinkedIn 2026 renders the Connect CTA as an <a> tag, not <button>.
  'main a[aria-label*="Invite"][aria-label*="connect" i]',
  'main button[aria-label*="Invite"][aria-label*="connect" i]',
  'main a[aria-label*="Connect with" i]',
  'main button[aria-label*="Connect with" i]',
  // 2. Profile-header-scoped selectors (fragile to class renames)
  '.pv-top-card-v2-ctas :is(button, a):has-text("Connect")',
  '.pvs-profile-actions :is(button, a):has-text("Connect")',
  '.pv-top-card__cta-container :is(button, a):has-text("Connect")',
  // 3. Broad fallbacks — only reach these if nothing scoped matched
  'main a:has-text("Connect")',
  'main button:has-text("Connect")',
  'main div[role="button"]:has-text("Connect")'
]);

function normalizeProfileUrl(profileUrl) {
  const rawUrl = profileUrl.startsWith('http')
    ? profileUrl
    : `https://www.linkedin.com${profileUrl.startsWith('/') ? '' : '/'}${profileUrl}`;

  try {
    const parsed = new URL(rawUrl);
    const profileMatch = parsed.pathname.match(/^\/in\/([^/?#]+)/i);
    if (!profileMatch) {
      return rawUrl;
    }

    parsed.pathname = `/in/${profileMatch[1]}/`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return rawUrl;
  }
}

function isCanonicalProfileView(currentUrl, targetUrl) {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    const targetMatch = target.pathname.match(/^\/in\/([^/?#]+)/i);
    const currentMatch = current.pathname.match(/^\/in\/([^/?#]+)(\/.*)?$/i);

    if (!targetMatch || !currentMatch) {
      return false;
    }

    const currentIdentifier = currentMatch[1].toLowerCase();
    const targetIdentifier = targetMatch[1].toLowerCase();
    if (currentIdentifier !== targetIdentifier) {
      return false;
    }

    return current.pathname === `/in/${targetMatch[1]}` || current.pathname === `/in/${targetMatch[1]}/`;
  } catch (_) {
    return false;
  }
}

/**
 * Check whether a Connect button's aria-label matches the target person.
 *
 * LinkedIn Connect buttons typically have:
 *   aria-label="Invite Madison Crane to connect"
 *
 * When a targetName is provided, only buttons whose aria-label contains the
 * target name (case-insensitive) are accepted.  This prevents clicking a
 * sidebar recommendation card's Connect button for a different person.
 *
 * When no targetName is provided, the check is skipped (all buttons pass).
 *
 * @param {import('playwright').ElementHandle} handle
 * @param {string|null} targetName
 * @returns {Promise<boolean>}  true if the button belongs to the target (or no name filter)
 */
async function matchesTargetPerson(handle, targetName) {
  if (!targetName) return true;
  try {
    // Collapse whitespace so extracted names like "Mikhail  Sychov" (double
    // space from parenthetical removal) still match "Mikhail Sychov" in the
    // aria-label.
    const ariaLabel = ((await handle.getAttribute('aria-label')) || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const normalizedTarget = targetName.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalizedTarget) return true;

    // Full name match — strongest signal
    if (ariaLabel.includes(normalizedTarget)) return true;

    // Do NOT fall back to first-name-only matching here.
    // A first-name match would accept sidebar buttons for any person who
    // shares the same first name (e.g., "Madison X" in sidebar when the
    // target is "Madison Crane").  Phase 0 in clickConnectButton already
    // tried a person-specific selector, so if we're here, we should only
    // accept an exact full-name match.
    return false;
  } catch (_) {
    return false;  // on error, reject — safer than accidentally clicking wrong person
  }
}

async function findVisibleHandle(page, selectors, timeoutMs = 5000, options = {}) {
  const targetName = options.targetName || null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const handles = await page.$$(selector);
      for (const handle of handles) {
        try {
          if (!(await handle.isVisible())) continue;
          if (targetName && !(await matchesTargetPerson(handle, targetName))) continue;
          return handle;
        } catch (_) {}
      }
    }
    await page.waitForTimeout(150);
  }
  return null;
}

async function findVisibleHandleByText(page, selectors, {
  exactTexts = [],
  includesTexts = [],
  ariaIncludes = [],
  targetName = null
} = {}, timeoutMs = 5000) {
  const normalizedExactTexts = exactTexts.map((value) => String(value).trim().toLowerCase());
  const normalizedIncludesTexts = includesTexts.map((value) => String(value).trim().toLowerCase());
  const normalizedAriaIncludes = ariaIncludes.map((value) => String(value).trim().toLowerCase());
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const handles = await page.$$(selector);
      for (const handle of handles) {
        try {
          if (!(await handle.isVisible())) {
            continue;
          }

          if (targetName && !(await matchesTargetPerson(handle, targetName))) {
            continue;
          }

          const text = ((await handle.textContent()) || '').trim().toLowerCase();
          const ariaLabel = ((await handle.getAttribute('aria-label')) || '').trim().toLowerCase();
          const matchesExactText = normalizedExactTexts.some((value) => text === value);
          const matchesText = normalizedIncludesTexts.some((value) => text.includes(value));
          const matchesAria = normalizedAriaIncludes.some((value) => ariaLabel.includes(value));

          if (matchesExactText || matchesText || matchesAria) {
            return handle;
          }
        } catch (_) {}
      }
    }
    await page.waitForTimeout(150);
  }

  return null;
}

async function clickVisibleHandle(page, handle, options = {}) {
  await handle.scrollIntoViewIfNeeded().catch(() => {});
  if (options.strictStealth === true) {
    return stealthClick(page, handle, options);
  }
  const box = await handle.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 });
  }
  await handle.click({ delay: 60 }).catch(() => handle.click().catch(() => {}));
  return true;
}

async function captureVisibleActionLabels(page) {
  return page.evaluate(() => {
    const root = document.querySelector('main') || document.body;
    const selectors = ['button', 'a', 'div[role="button"]', 'span[role="button"]'];
    const labels = [];

    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0;
    };

    for (const selector of selectors) {
      for (const element of root.querySelectorAll(selector)) {
        if (!isVisible(element)) continue;
        const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
        const ariaLabel = (element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const combined = [text, ariaLabel].filter(Boolean).join(' | ');
        if (!combined) continue;
        if (!labels.includes(combined)) {
          labels.push(combined);
        }
      }
    }

    return labels.slice(0, 40);
  }).catch(() => []);
}

async function clickConnectButton(page, timeoutMs = 3000, options = {}) {
  const secondaryTimeoutMs = Math.max(50, Math.floor((timeoutMs * 2) / 3));
  const targetName = options.targetName || null;

  // ── Safety gate: refuse to click without a target name ──
  // Without knowing who we're targeting, any Connect button on the page could
  // be clicked — including sidebar recommendation cards for unrelated people.
  // This has caused wrong-person connection requests in production.
  if (!targetName) {
    logAction('clickConnectButton aborted: no targetName provided — cannot safely identify the correct button');
    return false;
  }

  // ── Phase 0: Person-specific aria-label selector ──
  // When we know the target name, build a selector that can ONLY match their
  // Connect button.  LinkedIn's hero CTA uses:
  //   aria-label="Invite Madison Crane to connect"
  // This is the strongest signal and avoids sidebar recommendation cards entirely.
  if (targetName) {
    const escapedName = targetName.replace(/\s+/g, ' ').trim().replace(/['"\\]/g, '\\$&');
    const personSelectors = [
      `main a[aria-label*="Invite ${escapedName}" i]`,
      `main button[aria-label*="Invite ${escapedName}" i]`,
      `main a[aria-label*="Connect with ${escapedName}" i]`,
      `main button[aria-label*="Connect with ${escapedName}" i]`
    ];
    const personMatch = await findVisibleHandle(page, personSelectors, timeoutMs);
    if (personMatch) {
      logAction(`Found person-specific Connect button for "${targetName}"`);
      await clickVisibleHandle(page, personMatch, options);
      return true;
    }
    logAction(`No person-specific Connect button for "${targetName}", trying generic selectors with name filter`);
  }

  // ── Phase 1: Generic selectors with targetName filter ──
  // Falls back to broad selectors but still filtered by matchesTargetPerson.
  const primaryConnect = await findVisibleHandle(
    page, CONNECTION_SELECTORS, Math.max(50, timeoutMs / 2), { targetName }
  ) || await findVisibleHandleByText(page, [
    'main button',
    'main a',
    'main div[role="button"]',
    'main span[role="button"]'
  ], {
    exactTexts: ['connect'],
    includesTexts: ['connect'],
    ariaIncludes: ['invite', 'connect with', 'connect'],
    targetName
  }, Math.max(50, timeoutMs / 2));

  if (primaryConnect) {
    await clickVisibleHandle(page, primaryConnect, options);
    return true;
  }

  // ── Phase 2: "More" dropdown fallback ──
  // The More button itself does NOT contain the target name in its aria-label,
  // so we don't filter by targetName on the More button.  But we DO filter
  // the Connect item inside the dropdown — it may have an aria-label like
  // "Invite Madison Crane to connect" that we can match.
  //
  // We also try person-specific More selectors first when targetName is
  // available: LinkedIn sometimes renders "More actions for [Name]".
  const moreSelectors = [];
  if (targetName) {
    const escapedName = targetName.replace(/\s+/g, ' ').trim().replace(/['"\\]/g, '\\$&');
    moreSelectors.push(
      `main button[aria-label*="More actions" i][aria-label*="${escapedName}" i]`
    );
  }
  moreSelectors.push(
    ...PROFILE_ACTION_CONTAINER_SELECTORS.flatMap((c) => [
      `${c} button[aria-label*="More actions"]`,
      `${c} .artdeco-dropdown__trigger:has-text("More")`,
      `${c} button:has-text("More")`,
      `${c} div[role="button"]:has-text("More")`
    ]),
    'main button[aria-label*="More actions"]',
    'main .artdeco-dropdown__trigger:has-text("More")',
    'main button:has-text("More")',
    'main div[role="button"]:has-text("More")'
  );

  const moreButton = await findVisibleHandle(page, moreSelectors, secondaryTimeoutMs) || await findVisibleHandleByText(page, [
    'main button',
    'main a',
    'main div[role="button"]',
    'main span[role="button"]'
  ], {
    exactTexts: ['more'],
    includesTexts: ['more'],
    ariaIncludes: ['more actions']
  }, timeoutMs);

  if (!moreButton) return false;

  await clickVisibleHandle(page, moreButton, options);
  await randomDelay(500, 1000);

  // Filter dropdown Connect items by targetName when available.
  const dropdownConnect = await findVisibleHandle(page, [
    '.artdeco-dropdown__content button:has-text("Connect")',
    '.artdeco-dropdown__content-inner button:has-text("Connect")',
    '[role="menu"] button:has-text("Connect")'
  ], secondaryTimeoutMs, { targetName }) || await findVisibleHandleByText(page, [
    '.artdeco-dropdown__content button',
    '.artdeco-dropdown__content-inner button',
    '.artdeco-dropdown__content a',
    '[role="menu"] button',
    '[role="menu"] div[role="button"]'
  ], {
    exactTexts: ['connect'],
    includesTexts: ['connect'],
    ariaIncludes: ['connect', 'invite'],
    targetName
  }, timeoutMs);

  if (!dropdownConnect) return false;

  await clickVisibleHandle(page, dropdownConnect, options);
  return true;
}

async function sendConnectionRequestDetailed(page, profileUrl, note = '', quotaOptions = {}) {
  return traceAction(
    page,
    'send_connection',
    {
      profileUrl,
      hasNote: Boolean(note && note.trim())
    },
    async () => {
      try {
        logAction(`sendConnectionRequest called with profileUrl: ${profileUrl}`);
        const quotaState = canConsumeActionQuota('connection_requested', 1, quotaOptions);
        if (!quotaState.allowed) {
          return createWorkflowStepResult({
            stepType: 'send_connection',
            outcomeType: 'skipped_quota_exceeded',
            reason: buildQuotaExceededReason('connection_requested', quotaState),
            profileUrl: normalizeProfileUrl(profileUrl),
            metadata: {
              actionType: 'connection_requested',
              exceeded: quotaState.exceeded,
              quota: quotaState.quota
            }
          });
        }
        
        const strictStealth = quotaOptions.strictStealth === true;
        const navigationMode = String(quotaOptions.navigationMode || 'allow_direct_profile_navigation').trim();

        // Check if we need to navigate to the profile
        const currentUrl = page.url();
        const targetUrl = normalizeProfileUrl(profileUrl);
        
        // Navigate to profile if not already there
        const needsNavigation = !isCanonicalProfileView(currentUrl, targetUrl);
        
        if (needsNavigation) {
          if (strictStealth && navigationMode === 'context_click_only') {
            logError('Strict stealth mode lost profile context before connection step');
            return createWorkflowStepResult({
              stepType: 'send_connection',
              outcomeType: 'failed_permanent',
              reason: 'Strict stealth mode requires profile navigation to happen by clicking from the current context',
              profileUrl: targetUrl
            });
          }

          logAction(`Navigating to canonical profile page: ${targetUrl}`);
          try {
            await page.goto(targetUrl, { 
              waitUntil: 'domcontentloaded', 
              timeout: 30000 
            });
            await randomDelay(3000, 5000);
            
            // Verify we're on a profile page
            const isProfilePage = await page.evaluate(() => {
              return window.location.href.includes('/in/') && 
                     document.querySelector('main') !== null;
            });
            
            if (!isProfilePage) {
              logError('Failed to navigate to profile page');
              return createWorkflowStepResult({
                stepType: 'send_connection',
                outcomeType: 'failed_transient',
                reason: 'Failed to navigate to profile page',
                profileUrl: targetUrl
              });
            }
          } catch (navError) {
            logError(`Navigation failed: ${navError.message}`);
            return createWorkflowStepResult({
              stepType: 'send_connection',
              outcomeType: 'failed_transient',
              reason: navError.message || 'Navigation failed',
              profileUrl: targetUrl
            });
          }
        }
        
        // Wait for the profile to load
        await page.waitForSelector('main', { timeout: 10000 }).catch(() => {
          logAction('Main element not found, continuing anyway');
        });

        await handleConnectionPopups(page);

        const initialState = await readConnectionState(page);
        const initialActionLabels = await captureVisibleActionLabels(page);
        if (initialActionLabels.length) {
          logAction(`Visible profile actions before connect: ${initialActionLabels.join(' || ')}`);
        }
        if (initialState.pending) {
          logAction('Connection request already pending');
          return createWorkflowStepResult({
            stepType: 'send_connection',
            outcomeType: 'skipped_invite_pending',
            reason: 'Connection request already pending',
            profileUrl: targetUrl
          });
        }
        if (initialState.connected) {
          logAction('Already connected with this user');
          return createWorkflowStepResult({
            stepType: 'send_connection',
            outcomeType: 'skipped_already_connected',
            reason: 'Already connected with this user',
            profileUrl: targetUrl
          });
        }

        const managePendingInvites = typeof quotaOptions.managePendingInvites === 'function'
          ? quotaOptions.managePendingInvites
          : maybeSweepPendingInvites;

        const pendingInviteSweepResult = await managePendingInvites(page, {
          accountEmail: quotaOptions.accountEmail || null,
          returnUrl: targetUrl,
          pendingInviteSweepStore: quotaOptions.pendingInviteSweepStore || null,
          pendingInviteSweepIntervalMs: quotaOptions.pendingInviteSweepIntervalMs,
          pendingInviteMinAgeDays: quotaOptions.pendingInviteMinAgeDays,
          maxPendingInviteWithdrawals: quotaOptions.maxPendingInviteWithdrawals,
          maxPendingInviteScanPasses: quotaOptions.maxPendingInviteScanPasses
        }).catch((error) => {
          logError(`Pending invite sweep failed before connection send: ${error.message}`);
          return null;
        });

        if (pendingInviteSweepResult?.attempted) {
          logAction(
            `Pending invite sweep finished with status=${pendingInviteSweepResult.status || 'unknown'} `
            + `withdrawn=${pendingInviteSweepResult.withdrewCount || 0} `
            + `candidates=${pendingInviteSweepResult.candidateCount || 0}`
          );

          if (!isCanonicalProfileView(page.url(), targetUrl)) {
            await page.goto(targetUrl, {
              waitUntil: 'domcontentloaded',
              timeout: 30000
            });
            await randomDelay(2200, 4200);
          }

          await page.waitForSelector('main', { timeout: 10000 }).catch(() => {});
          await handleConnectionPopups(page);

          const afterSweepState = await readConnectionState(page);
          if (afterSweepState.pending) {
            logAction('Connection request already pending after invite sweep');
            return createWorkflowStepResult({
              stepType: 'send_connection',
              outcomeType: 'skipped_invite_pending',
              reason: 'Connection request already pending',
              profileUrl: targetUrl
            });
          }
          if (afterSweepState.connected) {
            logAction('Already connected with this user after invite sweep');
            return createWorkflowStepResult({
              stepType: 'send_connection',
              outcomeType: 'skipped_already_connected',
              reason: 'Already connected with this user',
              profileUrl: targetUrl
            });
          }
        }

        const connectButtonTimeoutMs = typeof quotaOptions.connectButtonTimeoutMs === 'number'
          ? Math.max(50, quotaOptions.connectButtonTimeoutMs)
          : 3000;

        const connectButtonClicked = await clickConnectButton(page, connectButtonTimeoutMs, {
          strictStealth,
          targetName: quotaOptions.recipientName || null
        });
        if (connectButtonClicked) {
          logAction('Clicked Connect button on main profile');
          await randomDelay(1000, 2000);
          const dialogHandled = await handleConnectionDialog(page, note, {
            strictStealth,
            // Thread targetName through so the dialog's fallback path
            // (clickConnectInDropdown) can filter More + Connect items by
            // aria-label, preventing wrong-person clicks on sidebar profiles.
            targetName: quotaOptions.recipientName || null
          });
          if (dialogHandled) {
            consumeActionQuota('connection_requested', 1, quotaOptions);
            return createWorkflowStepResult({
              stepType: 'send_connection',
              outcomeType: 'completed',
              profileUrl: targetUrl,
              verificationResult: await verifyConnectionSent(page, {
                action: 'send_connection',
                transport: 'dom',
                accountEmail: quotaOptions.accountEmail || null,
                transportHealthStore: quotaOptions.transportHealthStore || null
              }),
              metadata: {
                hasNote: Boolean(note && note.trim()),
                transport: 'dom'
              }
            });
          }

          const afterDialogState = await readConnectionState(page);
          if (afterDialogState.pending) {
            logAction('Connection request now appears pending');
            consumeActionQuota('connection_requested', 1, quotaOptions);
            return createWorkflowStepResult({
              stepType: 'send_connection',
              outcomeType: 'completed',
              profileUrl: targetUrl,
              verificationResult: await verifyConnectionSent(page, {
                state: afterDialogState,
                action: 'send_connection',
                transport: 'dom',
                accountEmail: quotaOptions.accountEmail || null,
                transportHealthStore: quotaOptions.transportHealthStore || null
              }),
              metadata: {
                hasNote: Boolean(note && note.trim()),
                transport: 'dom'
              }
            });
          }
        }

        const finalState = await readConnectionState(page);
        const finalActionLabels = await captureVisibleActionLabels(page);
        if (finalActionLabels.length) {
          logAction(`Visible profile actions after connect attempt: ${finalActionLabels.join(' || ')}`);
        }
        if (finalState.pending) {
          logAction('Connection request already pending');
          return createWorkflowStepResult({
            stepType: 'send_connection',
            outcomeType: 'skipped_invite_pending',
            reason: 'Connection request already pending',
            profileUrl: targetUrl
          });
        }
        if (finalState.connected) {
          logAction('Already connected with this user');
          return createWorkflowStepResult({
            stepType: 'send_connection',
            outcomeType: 'skipped_already_connected',
            reason: 'Already connected with this user',
            profileUrl: targetUrl
          });
        }

        // Distinguish between identity-resolution failure (no targetName → refused
        // to click) and genuine selector drift (targetName was present but no
        // matching button found).  Only record transport health failure for the
        // latter — the former is an upstream data problem, not a DOM issue.
        const hadTargetName = Boolean(quotaOptions.recipientName);
        if (!hadTargetName) {
          logError('Could not find Connect button: no target name available — identity resolution failed upstream');
          return createWorkflowStepResult({
            stepType: 'send_connection',
            outcomeType: 'failed_transient',
            reason: 'Could not identify target person — no recipientName available for safe button selection',
            profileUrl: targetUrl,
            metadata: { failureClass: 'identity_resolution', hadTargetName: false }
          });
        }

        logError('Could not find Connect button on profile');
        recordConnectionTransportFailure(quotaOptions, 'connect_button_not_found');
        return createWorkflowStepResult({
          stepType: 'send_connection',
          outcomeType: 'failed_transient',
          reason: 'Could not find Connect button on profile',
          profileUrl: targetUrl,
          metadata: { failureClass: 'selector_drift', hadTargetName: true }
        });
        
      } catch (error) {
        logError(`Error sending connection request: ${error.message}`, error);
        recordConnectionTransportFailure(quotaOptions, 'connection_request_exception');
        return createWorkflowStepResult({
          stepType: 'send_connection',
          outcomeType: 'failed_transient',
          reason: error.message || 'Error sending connection request',
          profileUrl: normalizeProfileUrl(profileUrl)
        });
      }
    }
  );
}

function recordConnectionTransportFailure(quotaOptions = {}, reason) {
  const transportHealthStore = quotaOptions.transportHealthStore || null;
  const accountEmail = String(quotaOptions.accountEmail || '').trim().toLowerCase() || null;
  if (!transportHealthStore || !accountEmail || typeof transportHealthStore.recordFailure !== 'function') {
    return;
  }

  transportHealthStore.recordFailure('dom', 'send_connection', accountEmail, {
    reason,
    timestamp: new Date().toISOString()
  });
}

async function sendConnectionRequest(page, profileUrl, note = '', quotaOptions = {}) {
  const result = await sendConnectionRequestDetailed(page, profileUrl, note, quotaOptions);
  return result?.outcomeType === 'completed';
}

async function handleConnectionPopups(page) {
  try {
    const dismissSelectors = [
      'button[aria-label="Dismiss"]',
      '.artdeco-toast-item__dismiss',
      'button[aria-label*="Dismiss"]',
      '.artdeco-toast__dismiss'
    ];
    
    for (const selector of dismissSelectors) {
      const dismiss = await page.$(selector);
      if (dismiss && await dismiss.isVisible().catch(() => false)) {
        await dismiss.click();
        logAction('Dismissed popup notification');
        await randomDelay(300, 500);
      }
    }
  } catch (error) {
    // Silently handle popup dismissal errors
  }
}

module.exports = {
  CONNECTION_SELECTORS,
  sendConnectionRequest,
  sendConnectionRequestDetailed,
  handleConnectionPopups,
  _private: {
    clickConnectButton,
    matchesTargetPerson,
    findVisibleHandle
  }
};
