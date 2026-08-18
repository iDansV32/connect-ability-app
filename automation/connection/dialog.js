// connection/dialog.js
const { randomDelay } = require('../human/delay');
const { logAction } = require('../util/log');
const { stealthClick } = require('../mouse/stealth-click');

async function findFirstVisible(page, selectors, timeoutMs = 4000, options = {}) {
  const targetName = options.targetName || null;
  const normalizedTarget = targetName
    ? targetName.toLowerCase().replace(/\s+/g, ' ').trim()
    : null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const handles = await page.$$(selector);
      for (const handle of handles) {
        try {
          if (!(await handle.isVisible())) continue;
          // When a targetName is provided, only accept handles whose aria-label
          // contains that name.  LinkedIn's "More actions" and dropdown Connect
          // buttons in the right-rail "More profiles for you" sidebar otherwise
          // win the first-visible race and trigger a connect to the wrong person.
          if (normalizedTarget) {
            const ariaLabel = ((await handle.getAttribute('aria-label')) || '')
              .toLowerCase().replace(/\s+/g, ' ').trim();
            if (!ariaLabel.includes(normalizedTarget)) continue;
          }
          return handle;
        } catch (_) {}
      }
    }
    await page.waitForTimeout(150);
  }
  return null;
}

async function clickHandle(page, handle, options = {}) {
  await handle.scrollIntoViewIfNeeded().catch(() => {});
  if (options.strictStealth === true) {
    return stealthClick(page, handle, options);
  }
  await handle.click({ delay: 60 }).catch(() => handle.click().catch(() => {}));
  return true;
}

async function clickConnectInDropdown(page, options = {}) {
  const targetName = options.targetName || null;

  // ── Safety gate ──
  // The right-rail "More profiles for you" cards each render their own "More
  // actions" button inside <main>.  Without a targetName to filter by, we
  // cannot tell the hero CTA's More from a sidebar's More — and opening the
  // wrong one will surface a Connect item that sends a request to the wrong
  // person.  Mirrors the gate in clickConnectButton.
  if (!targetName) {
    logAction('clickConnectInDropdown aborted: no targetName provided — cannot safely identify the correct More button');
    return false;
  }

  const escapedName = targetName.replace(/\s+/g, ' ').trim().replace(/['"\\]/g, '\\$&');

  // Phase 0: person-specific aria-label on the More button.
  // LinkedIn renders the hero More button with aria-label like
  // "More actions for Madison Crane".  Sidebar More buttons have a different name.
  const personScopedMore = await findFirstVisible(page, [
    `main button[aria-label*="More actions" i][aria-label*="${escapedName}" i]`
  ], 3000);

  // Phase 1: fall back to generic More selectors but require targetName match
  // against aria-label via findFirstVisible's filter.
  const more = personScopedMore || await findFirstVisible(page, [
    'main button[aria-label*="More actions"]',
    'main .artdeco-dropdown__trigger:has-text("More")',
    'main button:has-text("More")'
  ], 3000, { targetName });

  if (!more) return false;

  await clickHandle(page, more, options);
  await page.waitForTimeout(500);

  // Dropdown Connect items have aria-label "Invite <Name> to connect".
  // Filter by targetName so a sibling dropdown can't trick us.
  const connect = await findFirstVisible(page, [
    '.artdeco-dropdown__content button:has-text("Connect")',
    '.artdeco-dropdown__content-inner button:has-text("Connect")',
    '[role="menu"] button:has-text("Connect")'
  ], 4000, { targetName });

  if (connect) {
    await clickHandle(page, connect, options);
    await page.waitForTimeout(500);
    return true;
  }

  return false;
}

async function handleConnectionDialog(page, note = '', options = {}) {
  const dialogSelectors = [
    '.artdeco-modal',
    'div[role="dialog"]'
  ];

  let dialogOpen = await findFirstVisible(page, dialogSelectors, 2500);
  if (!dialogOpen) {
    // Only fall back to the More-dropdown path when we have a targetName.
    // Without one, the fallback risks clicking a sidebar's "More actions" +
    // Connect item, which would send a request to the wrong person.
    if (!options.targetName) {
      logAction('handleConnectionDialog: no dialog appeared and no targetName provided — skipping More-dropdown fallback to avoid wrong-person click');
      return false;
    }
    const dropdownClicked = await clickConnectInDropdown(page, options);
    if (!dropdownClicked) return false;
    dialogOpen = await findFirstVisible(page, dialogSelectors, 2500);
  }

  const addNoteSelectors = [
    'div[role="dialog"] button[aria-label*="Add a note"]',
    'div[role="dialog"] button:has-text("Add a note")',
    'button[aria-label*="Add a note"]'
  ];
  const addNote = note ? await findFirstVisible(page, addNoteSelectors, 2500) : null;
  if (addNote && note) {
    await clickHandle(page, addNote, options);
    await page.waitForTimeout(400);
  }

  if (note) {
    const textarea = await findFirstVisible(page, [
      'div[role="dialog"] textarea',
      'textarea',
      'div[role="dialog"] [role="textbox"][contenteditable="true"]'
    ], 3000);
    if (textarea) {
      await clickHandle(page, textarea, options);
      if (typeof textarea.fill === 'function') {
        await textarea.fill(note).catch(() => {});
      }
      const currentValue = await textarea.inputValue?.().catch(() => '');
      if (!currentValue) {
        await textarea.type(note, { delay: 45 + Math.random() * 55 });
      }
      await randomDelay(400, 700);
    }
  }

  const send = await findFirstVisible(page, [
    'div[role="dialog"] button[aria-label*="Send"]',
    'div[role="dialog"] button[aria-label*="Connect"]',
    'div[role="dialog"] button:has-text("Send")',
    'div[role="dialog"] button:has-text("Connect")',
    'button[aria-label*="Send"]',
    'button:has-text("Send")',
    'button:has-text("Connect")'
  ], 4000);

  if (send) {
    await clickHandle(page, send, options);
    await randomDelay(800, 1200);
    return true;
  }

  return false;
}

module.exports = { handleConnectionDialog, clickConnectInDropdown };
