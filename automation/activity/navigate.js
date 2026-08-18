const { randomDelay } = require('../human/delay');
const { humanScroll } = require('../human/scroll');
const { logAction, logError } = require('../util/log');
const { stealthClick } = require('../mouse/stealth-click');

const POST_CONTENT_SELECTORS = [
  '.feed-shared-update-v2',
  '.occludable-update',
  '.update-components-actor',
  '.profile-creator-shared-feed__container',
  '.feed-shared-actor',
  '.social-details-social-activity',
  'article[data-urn]',
  '[data-urn*="activity"]'
];

function normalizeProfileUrl(profileUrl) {
  if (!profileUrl) return '';

  try {
    const parsed = new URL(profileUrl.startsWith('http') ? profileUrl : `https://www.linkedin.com${profileUrl}`);
    const match = parsed.pathname.match(/^\/in\/([^/?#]+)/i);
    if (!match) return parsed.toString();
    parsed.pathname = `/in/${match[1]}/`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch (_) {
    return String(profileUrl).split('?')[0].split('#')[0].replace(/\/recent-activity.*$/i, '').replace(/\/details.*$/i, '');
  }
}

async function inspectActivitySurface(page) {
  return page.evaluate((selectors) => {
    const rootText = (document.body?.textContent || '').toLowerCase();
    const count = (selector) => {
      try {
        return document.querySelectorAll(selector).length;
      } catch (_) {
        return 0;
      }
    };

    const postCount = selectors.reduce((sum, selector) => sum + count(selector), 0);
    const activityHeaderCount = Array.from(document.querySelectorAll('h1, h2, h3, span, div'))
      .filter((element) => {
        const text = (element.textContent || '').trim().toLowerCase();
        return text === 'all activity' || text === 'activity' || text === 'posts';
      }).length;
    const likeButtonCount = count('button[aria-label*="Like"], button[aria-label*="React"], button[data-control-name="react_toggle"], .react-button__trigger, .social-action-button');
    const tabCount = count('.artdeco-pill, [role="tab"], .pvs-navigation__text');
    const emptyState = Boolean(
      document.querySelector('.empty-state-illustration') ||
      document.querySelector('.artdeco-empty-state') ||
      Array.from(document.querySelectorAll('h2, h3, span, div')).some((element) => {
        const text = (element.textContent || '').trim().toLowerCase();
        return text.includes('no activity') || text.includes('hasn\'t posted yet') || text.includes('nothing to show');
      })
    );

    return {
      url: window.location.href,
      activityHeaderCount,
      postCount,
      tabCount,
      likeButtonCount,
      hasActivityText: rootText.includes('all activity') || rootText.includes('recent activity'),
      emptyState
    };
  }, POST_CONTENT_SELECTORS).catch(() => ({
    url: '',
    activityHeaderCount: 0,
    postCount: 0,
    tabCount: 0,
    likeButtonCount: 0,
    hasActivityText: false,
    emptyState: false
  }));
}

async function hasDirectPostContent(page) {
  return page.evaluate((selectors) => {
    return selectors.some((selector) => {
      try {
        return document.querySelector(selector) !== null;
      } catch (_) {
        return false;
      }
    });
  }, POST_CONTENT_SELECTORS).catch(() => false);
}

async function waitForPostContentAfterShowAll(page) {
  try {
    await page.waitForFunction(() => {
      if (document.querySelectorAll('.feed-shared-update-v2, .occludable-update').length > 0) {
        return true;
      }

      if (document.querySelectorAll([
        'button[aria-label*="Like"]',
        'button[aria-label*="React"]',
        'button[data-control-name="react_toggle"]',
        '.react-button__trigger',
        '.social-action-button'
      ].join(',')).length > 0) {
        return true;
      }

      const headings = document.querySelectorAll('h1, h2, h3, span, div');
      for (const el of headings) {
        const text = el.textContent?.trim().toLowerCase();
        if (text === 'all activity' || text === 'activity' || text === 'posts') {
          return true;
        }
      }

      return false;
    }, {
      timeout: 8000
    });
    return true;
  } catch (_) {
    logAction('Post content did not appear after Show all click');
    return false;
  }
}

async function findVisibleHandleByIntent(page, selectors = [], matcher) {
  for (const selector of selectors) {
    const handles = await page.$$(selector);
    for (const handle of handles) {
      try {
        if (!(await handle.isVisible())) {
          continue;
        }

        const text = ((await handle.textContent()) || '').trim().toLowerCase();
        const aria = ((await handle.getAttribute('aria-label')) || '').trim().toLowerCase();
        const href = ((await handle.getAttribute('href')) || '').trim().toLowerCase();
        if (matcher({ text, aria, href })) {
          return {
            handle,
            text: ((await handle.textContent()) || (await handle.getAttribute('aria-label')) || '').trim()
          };
        }
      } catch (_) {}
    }
  }
  return null;
}

async function collectIntentDiagnostics(page, selectors = [], matcher, options = {}) {
  const closeMatchTerms = Array.isArray(options.closeMatchTerms) ? options.closeMatchTerms : [];
  const selectorCounts = {};
  const closeCandidates = [];
  const matchedCandidates = [];

  for (const selector of selectors) {
    let handles = [];
    try {
      handles = await page.$$(selector);
    } catch (_) {
      handles = [];
    }

    selectorCounts[selector] = handles.length;

    for (const handle of handles) {
      try {
        if (!(await handle.isVisible())) {
          continue;
        }

        const text = ((await handle.textContent()) || '').trim().replace(/\s+/g, ' ');
        const aria = ((await handle.getAttribute('aria-label')) || '').trim().replace(/\s+/g, ' ');
        const href = ((await handle.getAttribute('href')) || '').trim();
        const combined = `${text} ${aria} ${href}`.trim().toLowerCase();
        const record = { selector, text, aria, href };

        if (typeof matcher === 'function' && matcher({
          text: text.toLowerCase(),
          aria: aria.toLowerCase(),
          href: href.toLowerCase()
        })) {
          matchedCandidates.push(record);
          continue;
        }

        if (closeMatchTerms.some((term) => combined.includes(term))) {
          closeCandidates.push(record);
        }
      } catch (_) {}
    }
  }

  return {
    selectorCounts,
    matchedCandidates: matchedCandidates.slice(0, 8),
    closeCandidates: closeCandidates.slice(0, 8)
  };
}

async function findShowPostsCandidate(page) {
  const labels = ['show all posts', 'show all', 'see all posts', 'show posts', 'see more', 'show more'];
  return findVisibleHandleByIntent(page, [
    'a[aria-label*="Show all posts"]',
    'button[aria-label*="Show all posts"]',
    'a[href*="recent-activity/posts"]',
    'a[href*="recent-activity/all"]',
    'button',
    'a'
  ], ({ text, aria, href }) => {
    const combined = `${text} ${aria} ${href}`;
    return (
      labels.some((label) => combined.includes(label))
      || href.includes('recent-activity/posts')
      || href.includes('recent-activity/all')
    );
  });
}

async function clickActivityTabFromProfile(page, options = {}) {
  const selectors = [
    'nav a',
    'nav button',
    'a[href*="recent-activity"]',
    '[role="tab"]',
    '[role="link"]',
    'button[aria-label*="Activity"]',
    'button[aria-label*="Posts"]',
    'button[aria-label*="Articles"]'
  ];
  const matcher = ({ text, aria, href }) => {
    const combined = `${text} ${aria} ${href}`;
    return (
      combined.includes('activity')
      || combined.includes('posts')
      || combined.includes('articles')
      || href.includes('recent-activity')
    );
  };
  const candidate = await findVisibleHandleByIntent(page, [
    ...selectors
  ], matcher);

  if (!candidate?.handle) {
    const diagnostics = await collectIntentDiagnostics(page, selectors, matcher, {
      closeMatchTerms: ['post', 'activity', 'article', 'recent']
    });
    logAction(`Activity tab not found from profile. Diagnostics: ${JSON.stringify(diagnostics)}`);
    return false;
  }

  logAction(`Activity tab candidate selected: "${candidate.text}"`);
  if (options.strictStealth === true) {
    await stealthClick(page, candidate.handle);
  } else {
    await candidate.handle.scrollIntoViewIfNeeded().catch(() => {});
    await candidate.handle.click({ delay: 60 }).catch(() => candidate.handle.click().catch(() => {}));
  }
  await randomDelay(3200, 5200);
  return true;
}

async function checkForShowPostsButton(page, options = {}) {
  try {
    const candidate = await findShowPostsCandidate(page);
    if (!candidate?.handle) {
      const diagnostics = await collectIntentDiagnostics(page, [
        'a[aria-label*="Show all posts"]',
        'button[aria-label*="Show all posts"]',
        'a[href*="recent-activity/posts"]',
        'a[href*="recent-activity/all"]',
        'button',
        'a'
      ], ({ text, aria, href }) => {
        const combined = `${text} ${aria} ${href}`;
        return (
          combined.includes('show all')
          || combined.includes('show all posts')
          || combined.includes('see all posts')
          || combined.includes('show posts')
          || combined.includes('see more')
          || combined.includes('show more')
          || href.includes('recent-activity/posts')
          || href.includes('recent-activity/all')
        );
      }, {
        closeMatchTerms: ['post', 'recent-activity', 'more', 'activity', 'show all']
      });
      logAction(`Show-posts button not found. Diagnostics: ${JSON.stringify(diagnostics)}`);
      return false;
    }

    logAction(`Found "Show all posts" button with text: "${candidate.text}"`);
    if (options.strictStealth === true) {
      await stealthClick(page, candidate.handle);
    } else {
      await candidate.handle.scrollIntoViewIfNeeded().catch(() => {});
      await candidate.handle.click({ delay: 60 }).catch(() => candidate.handle.click().catch(() => {}));
    }
    logAction('Clicked on "Show all posts" button');
    await waitForPostContentAfterShowAll(page);
    await humanScroll(page);
    return true;
  } catch (error) {
    logAction(`Error checking for show posts button: ${error.message}`);
    return false;
  }
}

async function navigateToActivityPage(page, profileUrl, options = {}) {
  const cleanProfileUrl = normalizeProfileUrl(profileUrl);
  if (!cleanProfileUrl) {
    return false;
  }

  logAction(`Attempting to access activity for ${cleanProfileUrl}`);
  const strictStealth = options.strictStealth === true;

  try {
    if (strictStealth) {
      const currentUrl = normalizeProfileUrl(page.url());
      if (currentUrl !== cleanProfileUrl) {
        await page.goto(cleanProfileUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000
        });
        await randomDelay(2600, 4400);
      }

      if (await checkForShowPostsButton(page, { strictStealth })) {
        logAction('Found activity content after clicking "Show all posts" from profile in strict stealth mode');
        return true;
      }

      if (await clickActivityTabFromProfile(page, { strictStealth })) {
        await checkForShowPostsButton(page, { strictStealth });
        if (await hasDirectPostContent(page)) {
          logAction('Found activity content after clicking from profile in strict stealth mode');
          return true;
        }
      }

      if (await hasDirectPostContent(page)) {
        logAction('Found posts directly on profile page in strict stealth mode');
        return true;
      }

      logAction('Strict stealth mode could not reach activity naturally; using direct recent-activity URL as emergency fallback');
    }

    await page.goto(`${cleanProfileUrl.replace(/\/$/, '')}/recent-activity/all/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }).catch(() => logAction('Activity navigation timed out, continuing to inspect page'));

    await randomDelay(4200, 6200);

    const directInspection = await inspectActivitySurface(page);
    logAction(`Page debug: ${JSON.stringify(directInspection)}`);

    if (
      /recent-activity/i.test(directInspection.url) &&
      (
        directInspection.hasActivityText ||
        directInspection.activityHeaderCount > 0 ||
        directInspection.postCount > 0 ||
        directInspection.likeButtonCount > 0
      )
    ) {
      logAction('Successfully detected activity page content');
      await checkForShowPostsButton(page, { strictStealth });
      return true;
    }

    if (directInspection.emptyState) {
      logAction('Found empty activity page - user has no visible posts');
      return false;
    }

    logAction('Could not verify activity page. Trying profile page approach...');
    await page.goto(cleanProfileUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await randomDelay(2600, 4400);

    if (await checkForShowPostsButton(page, { strictStealth })) {
      if (await hasDirectPostContent(page)) {
        logAction('Found posts after clicking "Show all posts"');
        return true;
      }
    }

    if (await clickActivityTabFromProfile(page, { strictStealth })) {
      await checkForShowPostsButton(page, { strictStealth });
      if (await hasDirectPostContent(page)) {
        logAction('Found activity content after clicking from profile');
        return true;
      }
    }

    if (await hasDirectPostContent(page)) {
      logAction('Found posts directly on profile page');
      return true;
    }

    logAction('No activity content found through any method');
    return false;
  } catch (error) {
    logError('Error navigating to activity page', error);
    return false;
  }
}

module.exports = {
  navigateToActivityPage,
  checkForShowPostsButton
};
