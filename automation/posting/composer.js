const START_POST_SELECTORS = [
  'button.share-box-feed-entry__trigger',
  'button[aria-label*="Start a post"]',
  'button[aria-label*="Create a post"]',
  'button[aria-label*="write with AI"]',
  'div[role="button"][aria-label*="Start a post"]',
  'div[role="button"][aria-label*="Create a post"]',
  'button:has-text("Start a post")',
  'button:has-text("Create a post")',
  'div[role="button"]:has-text("Start a post")',
  'div[role="button"]:has-text("Create a post")',
  '.share-box-feed-entry__closed-share-box',
  '.share-box-feed-entry'
];

const EDITOR_SELECTORS = [
  'div[role="dialog"] div[role="textbox"][contenteditable="true"]',
  'div[role="dialog"] div.ql-editor[contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
  'div.ql-editor[contenteditable="true"]'
];

const COMPOSER_DIALOG_SELECTORS = [
  'div[role="dialog"]',
  '.share-box_actions',
  '.share-box_feed-entry__dialog'
];

async function findVisible(page, selectors, timeoutMs = 15000, matcher = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const handles = await page.$$(selector);
      for (const handle of handles) {
        try {
          if (!await handle.isVisible()) continue;
          if (typeof handle.isEnabled === 'function' && !await handle.isEnabled()) continue;
          if (matcher && !(await matcher(handle))) continue;
          return handle;
        } catch (_) {}
      }
    }
    await page.waitForTimeout(200);
  }
  return null;
}

async function clickSlow(page, handle) {
  await handle.scrollIntoViewIfNeeded().catch(() => {});
  const box = await handle.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 16 });
  }
  await page.waitForTimeout(250);
  await handle.click({ delay: 70 });
  await page.waitForTimeout(450);
}

async function isComposerOpen(page, timeoutMs = 1000) {
  const editor = await findVisible(page, EDITOR_SELECTORS, timeoutMs);
  if (editor) return true;
  const dialog = await findVisible(page, COMPOSER_DIALOG_SELECTORS, timeoutMs, async (handle) => {
    const text = ((await handle.textContent().catch(() => '')) || '').toLowerCase();
    return text.includes('create a post') || text.includes('post to');
  });
  return !!dialog;
}

async function findStartPostHandle(page, timeoutMs = 10000) {
  const direct = await findVisible(page, START_POST_SELECTORS, timeoutMs);
  if (direct) return direct;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fallback = await page.evaluateHandle(() => {
      const candidates = Array.from(
        document.querySelectorAll('button, div[role="button"], span[role="button"], a[role="button"]')
      );

      const match = candidates.find((el) => {
        const text = (el.textContent || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
        const combined = `${text} ${aria}`;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        return style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          rect.width > 0 &&
          rect.height > 0 &&
          (
            combined.includes('start a post') ||
            combined.includes('create a post') ||
            combined.includes('write a post') ||
            combined.includes('share a post') ||
            combined.includes('write with ai')
          );
      });

      return match || null;
    });

    const asElement = fallback.asElement();
    if (asElement) return asElement;
    await page.waitForTimeout(300);
  }

  return null;
}

async function tryOpenComposerOnCurrentPage(page, timeoutMs = 8000) {
  if (await isComposerOpen(page, 800)) return true;

  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }).catch(() => {});
  await page.waitForTimeout(400);

  const trigger = await findStartPostHandle(page, timeoutMs);
  if (!trigger) return false;

  await clickSlow(page, trigger);
  return isComposerOpen(page, 5000);
}

async function openComposer(page, { timeoutMs = 25000 } = {}) {
  if (!page || page.isClosed?.()) return false;
  if (await isComposerOpen(page, 800)) return true;

  const attempts = [
    'https://www.linkedin.com/feed/?shareActive=true',
    'https://www.linkedin.com/feed/'
  ];
  const perAttemptTimeout = Math.max(6000, Math.floor(timeoutMs / attempts.length));

  for (const url of attempts) {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    }).catch(() => {});

    await page.waitForTimeout(1800);
    if (await isComposerOpen(page, 1200)) return true;

    const opened = await tryOpenComposerOnCurrentPage(page, perAttemptTimeout);
    if (opened) return true;
  }

  return false;
}

module.exports = {
  START_POST_SELECTORS,
  EDITOR_SELECTORS,
  findVisible,
  clickSlow,
  findStartPostHandle,
  isComposerOpen,
  openComposer
};
