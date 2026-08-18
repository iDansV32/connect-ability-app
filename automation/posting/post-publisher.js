'use strict';

/**
 * post-publisher.js
 *
 * Core posting DOM logic that runs on a live Playwright page.
 * Used by account-worker-process.js (postingPage) to publish/schedule
 * LinkedIn posts without launching a new browser per post.
 *
 * executePostOnPage() is functionally equivalent to publishLinkedInPostTask()
 * in linkedin-posting.js, but without the browser lifecycle (launch/close).
 * The caller owns the page and context.
 */

const fs = require('fs');
const path = require('path');

const { randomDelay } = require('../human/delay');
const { moveMouseNaturally } = require('../mouse/move-naturally');
const { loginToLinkedIn } = require('../core/login');
const { handleSecurityChallenges } = require('../core/challenges');
const { openComposer } = require('./composer');
const { scheduleViaPrivateApi } = require('./posting-transport');

// ─── Selectors ────────────────────────────────────────────────────────────────

const EDITOR_SELECTORS = [
  'div[role="dialog"] div[role="textbox"][contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
  'div.ql-editor[contenteditable="true"]'
];

const POST_BUTTON_SELECTORS = [
  'div[role="dialog"] button:has-text("Post")',
  'button[aria-label="Post"]',
  'button.share-actions__primary-action'
];

const OPEN_SCHEDULE_SELECTORS = [
  'div[role="dialog"] button[aria-label*="Schedule"]',
  'div[role="dialog"] button:has-text("Schedule")',
  'button[aria-label*="clock"]'
];

const DATE_INPUT_SELECTORS = [
  'input[name*="date"]',
  'input[aria-label*="Date"]',
  'input[type="date"]'
];

const TIME_INPUT_SELECTORS = [
  'input[name*="time"]',
  'input[aria-label*="Time"]',
  'input[type="time"]'
];

const SCHEDULE_CONFIRM_SELECTORS = [
  'div[role="dialog"] button:has-text("Next")',
  'div[role="dialog"] button:has-text("Done")',
  'div[role="dialog"] button:has-text("Schedule")'
];

const SCHEDULE_NEXT_SELECTORS = [
  'div[role="dialog"] button:has-text("Next")',
  'button[aria-label*="Next"]'
];

const SCHEDULE_FINAL_SELECTORS = [
  'div[role="dialog"] button:has-text("Schedule")',
  'button[aria-label*="Schedule"]',
  'button:has-text("Schedule post")'
];

const SCHEDULE_DIALOG_SELECTORS = [
  'div[role="dialog"]:has-text("Schedule post")',
  'div[role="dialog"] h2:has-text("Schedule post")',
  'div[role="dialog"] input[placeholder*="mm/dd"]'
];

const SUCCESS_TOAST_SELECTORS = [
  '[role="alert"]:has-text("shared")',
  '[role="alert"]:has-text("posted")',
  '[role="alert"]:has-text("scheduled")',
  '.artdeco-toast-item:has-text("shared")',
  '.artdeco-toast-item:has-text("scheduled")'
];

const ERROR_TOAST_SELECTORS = [
  '[role="alert"]:has-text("failed")',
  '[role="alert"]:has-text("try again")',
  '[role="alert"]:has-text("error")',
  '.artdeco-inline-feedback--error'
];

const ACCOUNT_CHOOSER_HEADING_SELECTORS = [
  'h1:has-text("Choose an account")',
  'h2:has-text("Choose an account")',
  'text="Choose an account"'
];

const USE_ANOTHER_ACCOUNT_SELECTORS = [
  'a:has-text("Sign in using another account")',
  'button:has-text("Sign in using another account")',
  'a:has-text("Use another account")',
  'button:has-text("Use another account")',
  'text="Sign in using another account"',
  'text="Use another account"'
];

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function isLinkedInLoginInterstitialUrl(url) {
  return /linkedin\.com\/(?:uas\/login|login|checkpoint\/)/i.test(String(url || '').trim());
}

function buildAccountChooserTokens(credentials = {}) {
  const tokens = new Set();
  const addToken = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized.length >= 3) {
      tokens.add(normalized);
    }
  };

  addToken(credentials.name);
  addToken(credentials.email);
  addToken(String(credentials.email || '').split('@')[0]);

  const normalizedName = String(credentials.name || '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  addToken(normalizedName);

  return Array.from(tokens).sort((left, right) => right.length - left.length);
}

async function getCurrentPageUrl(page) {
  if (!page || typeof page.url !== 'function') return '';
  try {
    const value = page.url();
    if (value && typeof value.then === 'function') {
      return String(await value);
    }
    return String(value || '');
  } catch (_) {
    return '';
  }
}

function resolveImagePath(imagePath) {
  if (!imagePath) return null;
  const candidate = path.isAbsolute(imagePath)
    ? imagePath
    : path.join(process.cwd(), imagePath);
  return fs.existsSync(candidate) ? candidate : null;
}

function toLinkedInDateFormat(scheduledDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(scheduledDate || '').trim());
  if (!match) return scheduledDate;
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function toLinkedInTimeFormat(scheduledTime, useAmPm) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(scheduledTime || '').trim());
  if (!match) return scheduledTime;
  if (!useAmPm) return `${match[1]}:${match[2]}`;

  let hours = Number(match[1]);
  const minutes = match[2];
  const suffix = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${suffix}`;
}

function toScheduledTimestamp(scheduledDate, scheduledTime) {
  const candidate = new Date(`${scheduledDate}T${scheduledTime}:00`);
  if (!Number.isFinite(candidate.getTime())) {
    throw new Error('Scheduled date/time could not be converted to a timestamp');
  }
  return String(candidate.getTime());
}

function mapVisibilityType(visibility) {
  const normalized = String(visibility || '').trim().toLowerCase();
  if (normalized === 'connections' || normalized === 'connections_only') {
    return 'CONNECTIONS';
  }
  return 'ANYONE';
}

function buildScheduledPostResult(postConfig = {}, result = {}) {
  let linkedInScheduledAt = String(result?.scheduledAt || '').trim() || null;
  if (!linkedInScheduledAt && postConfig?.scheduledDate && postConfig?.scheduledTime) {
    // toScheduledTimestamp throws on an unparseable date. This builder is
    // called immediately after a resourceKey is captured — proof LinkedIn
    // already accepted the schedule. A failure to reconstruct the local
    // timestamp must NOT throw: in the private fast path a throw here would
    // bubble into the catch and fall through to a duplicate composer publish.
    // The timestamp is audit/display metadata; null is the honest fallback.
    // resourceKey is the idempotency/control field and is set below regardless.
    try {
      linkedInScheduledAt = toScheduledTimestamp(postConfig.scheduledDate, postConfig.scheduledTime);
    } catch (_) {
      linkedInScheduledAt = null;
    }
  }

  return {
    outcome: 'scheduled',
    deliveryStrategy: 'linkedin_scheduled',
    linkedInResourceKey: String(result?.resourceKey || '').trim() || null,
    linkedInScheduledAt
  };
}

// ─── DOM interaction helpers ──────────────────────────────────────────────────

async function findVisibleElement(page, selectors, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const handles = await page.$$(selector);
      for (const handle of handles) {
        try {
          const visible = await handle.isVisible();
          if (!visible) continue;
          const enabled = typeof handle.isEnabled === 'function'
            ? await handle.isEnabled()
            : true;
          if (!enabled) continue;
          return { handle, selector };
        } catch (_) {
          // Ignore stale elements and continue probing.
        }
      }
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function clickHumanized(page, selectors, label, timeoutMs = 20000) {
  const found = await findVisibleElement(page, selectors, timeoutMs);
  if (!found) {
    throw new Error(`Could not find clickable element for: ${label}`);
  }

  await found.handle.scrollIntoViewIfNeeded().catch(() => {});
  await moveMouseNaturally(page, found.handle);
  await randomDelay(140, 380);
  await found.handle.click({ delay: 40 + Math.floor(Math.random() * 120) });
  await randomDelay(250, 700);
  return found;
}

// Click a handle, falling back when LinkedIn's <interop-outlet> shadow DOM
// (or any other overlay) intercepts pointer events on the underlying button.
// 1) Normal Playwright click with human delay.
// 2) If intercepted, try Playwright's force: true.
// 3) If still intercepted, dispatch a synthetic JS click via element.click().
async function clickHandleResilient(page, handle, label = 'element') {
  await handle.scrollIntoViewIfNeeded().catch(() => {});
  await moveMouseNaturally(page, handle);
  await randomDelay(120, 320);

  try {
    await handle.click({ delay: 35 + Math.floor(Math.random() * 90), timeout: 6000 });
    await randomDelay(220, 520);
    return true;
  } catch (err) {
    const msg = String(err && err.message || '');
    const intercepted = /intercepts pointer events|element is outside of the viewport|outside the visible viewport/i.test(msg);
    if (!intercepted) {
      // Not the overlay problem — propagate.
      throw err;
    }
  }

  // Step 2: force click. This bypasses the actionability checks (visibility,
  // pointer interception) and dispatches the click at the element's box.
  try {
    await handle.click({ force: true, delay: 25 + Math.floor(Math.random() * 60), timeout: 6000 });
    await randomDelay(220, 520);
    return true;
  } catch (err) { /* fall through */ }

  // Step 3: JS click. Dispatches a click event directly on the element so
  // the overlay can't physically block it.
  try {
    await handle.evaluate((el) => el.click());
    await randomDelay(220, 520);
    return true;
  } catch (err) {
    throw new Error(`Could not click ${label} (pointer events were intercepted and all fallbacks failed)`);
  }
}

async function tryClickHumanized(page, selectors, label, timeoutMs = 3500) {
  const found = await findVisibleElement(page, selectors, timeoutMs);
  if (!found) return false;
  try {
    await clickHandleResilient(page, found.handle, label);
    return true;
  } catch (_) {
    return false;
  }
}

async function clickElementHandleHumanized(page, handle) {
  await clickHandleResilient(page, handle, 'handle');
}

async function typePostBody(page, content) {
  const editorFound = await findVisibleElement(page, EDITOR_SELECTORS, 20000);
  if (!editorFound) {
    throw new Error('Post editor could not be located');
  }

  await editorFound.handle.click();
  await randomDelay(150, 350);
  try {
    await page.keyboard.press('ControlOrMeta+A');
  } catch (_) {
    try {
      await page.keyboard.press('Meta+A');
    } catch (_) {
      await page.keyboard.press('Control+A');
    }
  }
  await page.keyboard.press('Backspace').catch(() => {});
  await randomDelay(120, 260);

  const lines = String(content || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      await page.keyboard.type(ch, { delay: 40 + Math.floor(Math.random() * 95) });
      if (Math.random() < 0.05) {
        await randomDelay(180, 550);
      }
    }
    if (i < lines.length - 1) {
      await page.keyboard.press('Shift+Enter');
      await randomDelay(120, 300);
    }
  }
}

async function attachImageIfNeeded(page, imagePath) {
  const resolvedImagePath = resolveImagePath(imagePath);
  if (!resolvedImagePath) {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  const inputFound = await findVisibleElement(page, ['input[type="file"]'], 10000);
  if (!inputFound) {
    throw new Error('Image upload input was not found');
  }

  await inputFound.handle.setInputFiles(resolvedImagePath);
  await randomDelay(1500, 2600);
}

async function humanSelectAll(page) {
  try {
    await page.keyboard.press('ControlOrMeta+A');
    return;
  } catch (_) {}
  try {
    await page.keyboard.press('Meta+A');
    return;
  } catch (_) {}
  await page.keyboard.press('Control+A').catch(() => {});
}

async function focusFieldForTyping(page, elementHandle, dependencies = {}) {
  const movePointer = dependencies.moveMouseNaturally || moveMouseNaturally;
  const wait = dependencies.randomDelay || randomDelay;

  await elementHandle.scrollIntoViewIfNeeded().catch(() => {});
  await movePointer(page, elementHandle);
  await wait(110, 260);

  // One visible click only. If LinkedIn's date-picker overlay steals focus,
  // restore it programmatically instead of clicking the field two more times.
  await elementHandle.click({ clickCount: 1, delay: 35 + Math.floor(Math.random() * 95) });
  await wait(90, 220);

  let focused = await elementHandle.evaluate((el) => document.activeElement === el).catch(() => false);
  if (!focused && typeof elementHandle.focus === 'function') {
    await elementHandle.focus().catch(() => {});
    focused = await elementHandle.evaluate((el) => document.activeElement === el).catch(() => false);
  }
  return focused;
}

async function readFieldValue(elementHandle) {
  return elementHandle.evaluate((el) => {
    if ('value' in el) return el.value || '';
    return el.textContent || '';
  }).catch(() => '');
}

async function humanTypeIntoField(page, elementHandle, value, opts = {}) {
  const targetValue = String(value || '');
  await elementHandle.scrollIntoViewIfNeeded().catch(() => {});
  await focusFieldForTyping(page, elementHandle);

  if (opts.refocusAfterOverlay) {
    await randomDelay(90, 180);
    // Do not click again just because opening the picker moved focus.
    await elementHandle.focus().catch(() => {});
  }

  await randomDelay(120, 240);
  // Target the select-all command at the field itself so the existing date is
  // selected on the first focus rather than relying on ambient page focus.
  await elementHandle.press('ControlOrMeta+A').catch(() => humanSelectAll(page));
  await randomDelay(90, 180);
  await page.keyboard.press('Backspace').catch(() => {});
  await randomDelay(80, 200);

  for (const ch of targetValue) {
    await page.keyboard.type(ch, { delay: 55 + Math.floor(Math.random() * 95) });
    if (Math.random() < 0.08) {
      await randomDelay(120, 380);
    }
  }

  if (opts.blurWithTab) {
    await randomDelay(80, 180);
    await page.keyboard.press('Tab').catch(() => {});
  }

  if (opts.verifyValueOnly) {
    await readFieldValue(elementHandle);
  }
}

async function setScheduleFieldValue(page, elementHandle, value, opts = {}) {
  const type = String(await elementHandle.getAttribute('type').catch(() => '') || '').toLowerCase();
  const targetValue = String(value || '');
  const useDirectFill = type === 'date' || type === 'time';

  if (!useDirectFill) {
    await humanTypeIntoField(page, elementHandle, targetValue, opts);
    return;
  }

  await elementHandle.scrollIntoViewIfNeeded().catch(() => {});
  await focusFieldForTyping(page, elementHandle);
  await randomDelay(100, 220);
  await elementHandle.fill(targetValue).catch(() => {});
  await elementHandle.evaluate((el, nextValue) => {
    if ('value' in el) {
      el.value = nextValue;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, targetValue).catch(() => {});
  await randomDelay(90, 180);

  const currentValue = await readFieldValue(elementHandle);
  if (String(currentValue) !== targetValue) {
    await humanTypeIntoField(page, elementHandle, targetValue, opts);
    return;
  }

  if (opts.blurWithTab) {
    await page.keyboard.press('Tab').catch(() => {});
  }
}

async function closeDatePickerIfOpen(page) {
  const datePickerSelectors = [
    '[role="dialog"] [aria-label*="calendar"]',
    '[role="dialog"] [class*="calendar"]',
    '[class*="date-picker"]',
    '[class*="react-datepicker"]'
  ];

  const picker = await findVisibleElement(page, datePickerSelectors, 600);
  if (!picker) return;

  await randomDelay(120, 260);
  await page.keyboard.press('Escape').catch(() => {});
  await randomDelay(120, 260);
}

async function fillScheduleFields(page, scheduledDate, scheduledTime) {
  const dateFound = await findVisibleElement(page, DATE_INPUT_SELECTORS, 10000);
  const timeFound = await findVisibleElement(page, TIME_INPUT_SELECTORS, 10000);
  if (!dateFound || !timeFound) {
    throw new Error('LinkedIn schedule controls were not found');
  }

  const dateType = String(await dateFound.handle.getAttribute('type').catch(() => '') || '').toLowerCase();
  const timeType = String(await timeFound.handle.getAttribute('type').catch(() => '') || '').toLowerCase();
  const timeAria = (await timeFound.handle.getAttribute('aria-label').catch(() => '')) || '';
  const timePlaceholder = (await timeFound.handle.getAttribute('placeholder').catch(() => '')) || '';
  const useAmPm = /AM|PM|am|pm/.test(`${timeAria} ${timePlaceholder}`);

  const formattedDate = dateType === 'date'
    ? String(scheduledDate || '')
    : toLinkedInDateFormat(scheduledDate);
  const formattedTime = timeType === 'time'
    ? String(scheduledTime || '')
    : toLinkedInTimeFormat(scheduledTime, useAmPm);

  await setScheduleFieldValue(page, dateFound.handle, formattedDate, {
    blurWithTab: true,
    refocusAfterOverlay: true,
    verifyValueOnly: true
  });
  await closeDatePickerIfOpen(page);
  await randomDelay(200, 500);

  await setScheduleFieldValue(page, timeFound.handle, formattedTime, {
    blurWithTab: true,
    refocusAfterOverlay: true,
    verifyValueOnly: true
  });
  await randomDelay(220, 520);
}

async function isScheduleDialogOpen(page) {
  const found = await findVisibleElement(page, SCHEDULE_DIALOG_SELECTORS, 500);
  return !!found;
}

async function confirmScheduleFlow(page, emitLog = () => {}) {
  let clickedSomething = false;

  const clickedNext = await tryClickHumanized(page, SCHEDULE_NEXT_SELECTORS, 'schedule next', 5000);
  if (clickedNext) {
    clickedSomething = true;
    emitLog({ message: 'Schedule step 1 confirmed (Next).', type: 'info' });
    await randomDelay(350, 850);
  }

  let clickedSchedule = await tryClickHumanized(page, SCHEDULE_FINAL_SELECTORS, 'final schedule', 5000);
  if (!clickedSchedule) {
    await randomDelay(450, 950);
    clickedSchedule = await tryClickHumanized(page, SCHEDULE_FINAL_SELECTORS, 'final schedule retry', 5000);
  }

  if (clickedSchedule) {
    clickedSomething = true;
    emitLog({ message: 'Schedule step 2 confirmed (Schedule).', type: 'info' });
  }

  if (!clickedSomething) {
    const genericClick = await tryClickHumanized(page, SCHEDULE_CONFIRM_SELECTORS, 'generic schedule confirm', 5000);
    if (!genericClick) {
      throw new Error('Could not find schedule confirmation button');
    }
  }
}

async function performSmoothWarmupScroll(page) {
  const steps = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < steps; i++) {
    const delta = 80 + Math.floor(Math.random() * 120);
    await page.evaluate((d) => {
      window.scrollBy({ top: d, behavior: 'smooth' });
    }, delta);
    await randomDelay(280, 560);
  }

  await randomDelay(260, 520);
  await page.evaluate(() => {
    window.scrollBy({ top: -40, behavior: 'smooth' });
  });
  await randomDelay(220, 460);
}

async function waitForPublishOutcome(page, mode, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const errorToast = await findVisibleElement(page, ERROR_TOAST_SELECTORS, 500);
    if (errorToast) {
      const text = (await errorToast.handle.textContent()) || 'Unknown LinkedIn error';
      throw new Error(text.trim());
    }

    const successToast = await findVisibleElement(page, SUCCESS_TOAST_SELECTORS, 500);
    if (successToast) return true;

    if (mode === 'schedule') {
      const dialogOpen = await isScheduleDialogOpen(page);
      if (!dialogOpen) return true;
    }

    await page.waitForTimeout(350);
  }

  const postButtonLeft = await findVisibleElement(page, POST_BUTTON_SELECTORS, 1000);
  if (!postButtonLeft) return true;

  throw new Error(
    mode === 'schedule'
      ? 'Schedule action timed out waiting for LinkedIn confirmation'
      : 'Publish action timed out waiting for LinkedIn confirmation'
  );
}

async function scheduleTextPostViaPrivateFallback(page, postConfig, emitLog = () => {}) {
  emitLog({ message: 'Retrying scheduled post with browser-backed direct request...', type: 'info' });
  const result = await scheduleViaPrivateApi(page, {
    content: postConfig.content,
    scheduledDate: postConfig.scheduledDate,
    scheduledTime: postConfig.scheduledTime,
    visibility: postConfig.visibility,
    origin: 'FEED'
  }, {}, emitLog);

  if (result.success) {
    return {
      resourceKey: result.resourceKey,
      scheduledAt: result.scheduledAt
    };
  }

  const responseMessage =
    result?.response?.errors?.[0]?.message ||
    result?.response?.data?.errors?.[0]?.message ||
    result?.response?.message ||
    result?.error ||
    result?.reason ||
    'Direct scheduled-post request did not return a resource key';
  throw new Error(responseMessage);
}

// ─── Session recovery helpers ─────────────────────────────────────────────────

async function isLinkedInAccountChooserVisible(page, timeoutMs = 1200) {
  const heading = await findVisibleElement(page, ACCOUNT_CHOOSER_HEADING_SELECTORS, timeoutMs);
  if (heading) return true;

  const currentUrl = await getCurrentPageUrl(page);
  if (!isLinkedInLoginInterstitialUrl(currentUrl)) {
    return false;
  }

  const switchAccount = await findVisibleElement(page, USE_ANOTHER_ACCOUNT_SELECTORS, 500);
  if (switchAccount) return true;

  const hasAccountOptions = await page.evaluate(() => {
    const isVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 40 && rect.height > 20;
    };

    return Array.from(
      document.querySelectorAll('button, a, div[role="button"], li, [role="listitem"], article, section')
    ).some((element) => {
      if (!isVisible(element)) return false;
      const text = String(element.textContent || '').toLowerCase();
      return text.includes('@') || text.includes('gmail.com') || text.includes('linkedin user');
    });
  }).catch(() => false);

  return hasAccountOptions;
}

async function findLinkedInAccountChooserOption(page, credentials, timeoutMs = 4000) {
  const tokens = buildAccountChooserTokens(credentials);
  if (!tokens.length) {
    return null;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handle = await page.evaluateHandle((candidateTokens) => {
      const isVisible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 40 && rect.height > 20;
      };

      const candidates = Array.from(
        document.querySelectorAll('button, a, div[role="button"], li, [role="listitem"], article, section')
      )
        .filter((element) => isVisible(element))
        .map((element) => {
          const text = `${element.textContent || ''} ${element.getAttribute('aria-label') || ''}`
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
          if (!text) return null;

          let score = 0;
          for (const token of candidateTokens) {
            if (text.includes(token)) {
              score = Math.max(score, token.length);
            }
          }

          if (!score) return null;
          return { element, score, textLength: text.length };
        })
        .filter(Boolean)
        .sort((left, right) => right.score - left.score || left.textLength - right.textLength);

      return candidates[0]?.element || null;
    }, tokens);

    const elementHandle = handle.asElement();
    if (elementHandle) {
      return elementHandle;
    }

    await page.waitForTimeout(200);
  }

  return null;
}

async function recoverFromLinkedInAccountChooser(page, credentials, emitLog = () => {}) {
  if (!await isLinkedInAccountChooserVisible(page, 1200)) {
    return false;
  }

  emitLog({
    message: 'LinkedIn account selector detected. Recovering the requested profile before retrying...',
    type: 'warning'
  });

  const matchingOption = await findLinkedInAccountChooserOption(page, credentials, 5000);
  if (matchingOption) {
    emitLog({
      message: `Selecting LinkedIn account "${credentials?.name || credentials?.email || 'saved account'}"...`,
      type: 'info'
    });
    await clickElementHandleHumanized(page, matchingOption);
    await randomDelay(1600, 2800);
    await handleSecurityChallenges(page).catch(() => false);
    return true;
  }

  if (await tryClickHumanized(page, USE_ANOTHER_ACCOUNT_SELECTORS, 'use another LinkedIn account', 4000)) {
    emitLog({
      message: 'Falling back to credential login from the LinkedIn account selector...',
      type: 'warning'
    });
    await loginToLinkedIn(page, credentials?.email || '', credentials?.password || '');
    await randomDelay(1000, 1800);
    await handleSecurityChallenges(page).catch(() => false);
    return true;
  }

  return false;
}

async function ensureLinkedInPublishingContext(page, credentials, emitLog = () => {}) {
  let recovered = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const chooserRecovered = await recoverFromLinkedInAccountChooser(page, credentials, emitLog);
    recovered = recovered || chooserRecovered;

    const currentUrl = await getCurrentPageUrl(page);
    if (!isLinkedInLoginInterstitialUrl(currentUrl)) {
      break;
    }

    emitLog({
      message: 'LinkedIn requested re-authentication while publishing. Retrying login...',
      type: 'warning'
    });
    await loginToLinkedIn(page, credentials?.email || '', credentials?.password || '');
    await randomDelay(1000, 1800);
    await handleSecurityChallenges(page).catch(() => false);
    recovered = true;
  }

  return recovered;
}

// ─── Core posting logic ───────────────────────────────────────────────────────

/**
 * Execute a LinkedIn post or schedule operation on a live Playwright page.
 *
 * The caller is responsible for providing an authenticated page that is already
 * navigated to a LinkedIn page (e.g. the LinkedIn feed). The function handles
 * session recovery, composer interaction, and scheduling flows without touching
 * the browser lifecycle.
 *
 * @param {import('playwright').Page} page - Live Playwright page owned by caller
 * @param {object} postConfig - Post configuration (content, scheduledDate, scheduledTime, etc.)
 * @param {object} credentials - Account credentials {email, password, name}
 * @param {function} emitLog - Log emitter: emitLog({ message, type }) or emitLog(string)
 * @returns {Promise<{outcome: string, deliveryStrategy?: string, linkedInResourceKey?: string, linkedInScheduledAt?: string}>}
 */
async function executePostOnPage(page, postConfig, credentials, emitLog = () => {}) {
  const immediate = !!postConfig.immediate;
  const mode = immediate ? 'post' : 'schedule';

  // Recover from any session/chooser state before starting.
  await ensureLinkedInPublishingContext(page, credentials, emitLog);

  // Fast path: text-only scheduled posts go via the private API first.
  if (!immediate && !postConfig.includeImage && !postConfig.imagePath) {
    emitLog({ message: 'Scheduling LinkedIn post directly via browser-backed request...', type: 'info' });
    let directResult = null;
    try {
      await page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }).catch(() => {});
      await randomDelay(1200, 2200);
      await ensureLinkedInPublishingContext(page, credentials, emitLog);
      directResult = await scheduleTextPostViaPrivateFallback(page, postConfig, emitLog);
    } catch (directScheduleError) {
      // Only a genuine scheduling failure (no resourceKey captured) reaches
      // here — scheduleTextPostViaPrivateFallback throws when LinkedIn did
      // NOT accept the post. In that case it's safe to fall through to the
      // composer-UI path below.
      emitLog({
        message: `Direct LinkedIn scheduling failed, falling back to UI flow: ${directScheduleError.message || String(directScheduleError)}`,
        type: 'warning'
      });
    }

    // A captured resourceKey is proof LinkedIn accepted the scheduled post.
    // Return here unconditionally — NEVER fall through to the composer-UI
    // path below, which would publish a SECOND time (the worker-internal
    // resourceKey-then-throw duplicate bug). buildScheduledPostResult is
    // no-throw and the success log is best-effort, so nothing between
    // capture and return can divert control into a duplicate publish.
    if (directResult && directResult.resourceKey) {
      const scheduledResult = buildScheduledPostResult(postConfig, directResult);
      try {
        emitLog({
          message: `LinkedIn post scheduled successfully (${directResult.resourceKey}).`,
          type: 'success'
        });
      } catch (_) { /* logging is best-effort; never let it cause a duplicate publish */ }
      return scheduledResult;
    }
  }

  // Composer UI path.
  const requiresComposer = immediate || Boolean(postConfig.includeImage && postConfig.imagePath);
  let composerOpened = false;
  const composerAttemptLimit = requiresComposer ? 3 : 2;

  for (let attempt = 1; attempt <= composerAttemptLimit; attempt++) {
    const currentUrl = await getCurrentPageUrl(page);

    if (/linkedin\.com\/feed/.test(currentUrl)) {
      if (attempt === 1) {
        emitLog({ message: 'Already on LinkedIn feed, keeping current page...', type: 'info' });
      }
    } else {
      emitLog({
        message: attempt === 1
          ? 'Navigating to LinkedIn feed...'
          : `Restoring LinkedIn feed before composer retry ${attempt}/${composerAttemptLimit}...`,
        type: 'info'
      });
      await page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }).catch(() => {});
      await randomDelay(1400, 2600);
    }

    await ensureLinkedInPublishingContext(page, credentials, emitLog);

    const refreshedUrl = await getCurrentPageUrl(page);
    if (/linkedin\.com\/feed/.test(refreshedUrl)) {
      await performSmoothWarmupScroll(page);
    }

    emitLog({
      message: attempt === 1
        ? 'Opening post composer...'
        : `Retrying LinkedIn post composer (${attempt}/${composerAttemptLimit})...`,
      type: attempt === 1 ? 'info' : 'warning'
    });
    composerOpened = await openComposer(page, { timeoutMs: 25000 });
    if (composerOpened) {
      break;
    }

    const recovered = await ensureLinkedInPublishingContext(page, credentials, emitLog);
    if (!recovered && attempt < composerAttemptLimit) {
      emitLog({
        message: 'LinkedIn composer did not open. Retrying the publish flow...',
        type: 'warning'
      });
    }
    if (attempt < composerAttemptLimit) {
      await randomDelay(1200, 2400);
    }
  }

  if (!composerOpened && requiresComposer) {
    throw new Error('Could not open LinkedIn post composer');
  }

  if (composerOpened) {
    await randomDelay(800, 1600);

    emitLog({ message: 'Typing post content with humanized input...', type: 'info' });
    await typePostBody(page, postConfig.content);

    if (postConfig.includeImage && postConfig.imagePath) {
      emitLog({ message: 'Uploading post image...', type: 'info' });
      await attachImageIfNeeded(page, postConfig.imagePath);
    }
  } else {
    emitLog({
      message: 'Composer UI was unavailable. Continuing with direct scheduled-post request.',
      type: 'info'
    });
  }

  // Immediate publish path.
  if (immediate) {
    emitLog({ message: 'Publishing post now...', type: 'info' });
    await clickHumanized(page, POST_BUTTON_SELECTORS, 'publish post');
    emitLog({ message: 'Waiting for LinkedIn publish confirmation...', type: 'info' });
    await waitForPublishOutcome(page, mode);

    emitLog({ message: 'LinkedIn post published successfully.', type: 'success' });
    return { outcome: 'published' };
  }

  if (!postConfig.scheduledDate || !postConfig.scheduledTime) {
    throw new Error('Scheduled date and time are required for scheduled posts');
  }

  if (!composerOpened) {
    const fallbackResult = await scheduleTextPostViaPrivateFallback(page, postConfig, emitLog);
    emitLog({
      message: `LinkedIn post scheduled successfully (${fallbackResult.resourceKey}).`,
      type: 'success'
    });
    return buildScheduledPostResult(postConfig, fallbackResult);
  }

  // Scheduled post via UI.
  try {
    emitLog({ message: 'Opening LinkedIn schedule dialog...', type: 'info' });
    await clickHumanized(page, OPEN_SCHEDULE_SELECTORS, 'open schedule');

    emitLog({ message: 'Setting schedule date/time...', type: 'info' });
    await fillScheduleFields(page, postConfig.scheduledDate, postConfig.scheduledTime);

    emitLog({ message: 'Confirming scheduled post...', type: 'info' });
    await confirmScheduleFlow(page, emitLog);

    emitLog({ message: 'Waiting for LinkedIn schedule confirmation...', type: 'info' });
    await waitForPublishOutcome(page, mode);

    emitLog({ message: 'LinkedIn post scheduled successfully.', type: 'success' });
    return buildScheduledPostResult(postConfig);
  } catch (scheduleError) {
    if (postConfig.includeImage && postConfig.imagePath) {
      throw scheduleError;
    }

    try {
      const fallbackResult = await scheduleTextPostViaPrivateFallback(page, postConfig, emitLog);
      emitLog({
        message: `LinkedIn post scheduled successfully (${fallbackResult.resourceKey}).`,
        type: 'success'
      });
      return buildScheduledPostResult(postConfig, fallbackResult);
    } catch (fallbackError) {
      throw new Error(
        `UI scheduling failed: ${scheduleError.message}. Direct scheduling fallback failed: ${fallbackError.message}`
      );
    }
  }
}

module.exports = {
  executePostOnPage,
  buildScheduledPostResult,
  // Exported for focused unit testing of formatting and interaction helpers.
  _private: {
    isLinkedInLoginInterstitialUrl,
    buildAccountChooserTokens,
    toLinkedInDateFormat,
    toLinkedInTimeFormat,
    toScheduledTimestamp,
    mapVisibilityType,
    focusFieldForTyping
  }
};
