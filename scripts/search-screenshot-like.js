// Search for profiles matching a title, screenshot each, and like their latest post.
// Skips profiles whose visible headline doesn't contain the title keyword.
const path = require('path');
const { chromium } = require('playwright');
const { loginToLinkedIn } = require('../automation/core/login');
const { setupFingerprinting } = require('../automation/core/fingerprinting');
const { humanLikeSearch, extractProfileUrls } = require('../automation/search/search');
const { getLinkedInSessionStatePath } = require('../automation/core/session-state');
const { processActivityPageDetailed } = require('../automation/activity/like');

const OUTPUT_DIR = process.env.SCREENSHOT_DIR || '/tmp/connect-screenshots';
const SEARCH_TERM = process.env.LINKEDIN_SEARCH_TERM || 'Head of People';
// Words that must appear in the headline to count as a match (case-insensitive, any one matches)
const TITLE_KEYWORDS = (process.env.TITLE_KEYWORDS || SEARCH_TERM).toLowerCase().split(',').map(s => s.trim());
const PROFILE_COUNT = parseInt(process.env.PROFILE_COUNT || '5', 10);
// How many search result pages to try before giving up
const MAX_PAGES = parseInt(process.env.MAX_SEARCH_PAGES || '3', 10);

// Session storage path is resolved from the LINKEDIN_EMAIL env var via the
// cross-platform helper. Set LINKEDIN_EMAIL to whichever account's session
// you want to reuse. The actual validation happens inside main().
const LINKEDIN_EMAIL = process.env.LINKEDIN_EMAIL || '';
const SESSION_PATH = LINKEDIN_EMAIL ? getLinkedInSessionStatePath(LINKEDIN_EMAIL) : null;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function extractProfileInfo(page) {
  return page.evaluate(() => {
    // --- Name: h1 on the profile page ---
    const candidates = Array.from(document.querySelectorAll('h1, h2'));
    const nameEl = candidates.find(el => {
      const t = (el.textContent || '').trim();
      return t.length > 3 && t.length < 80 && !/^\d+$/.test(t) && !t.toLowerCase().includes('notification');
    });
    let name = nameEl ? nameEl.textContent.trim() : null;

    // --- Headline: DOM selectors (multiple LinkedIn generations) ---
    const headlineSelectors = [
      '.text-body-medium.break-words',
      '[data-field="headline"]',
      '.ph5 .mt2 .text-body-medium',
      '.pv-text-details__left-panel .text-body-medium',
      'div[data-view-name="profile-card"] .text-body-medium',
      // newer React-based LinkedIn
      '[data-generated-suggestion-target] .text-body-medium',
      'section.artdeco-card .text-body-medium',
    ];
    let headline = null;
    for (const sel of headlineSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 3) { headline = el.textContent.trim(); break; }
    }

    // --- Fallback: parse <title> tag ("Name | Title at Company | LinkedIn") ---
    if (!headline || !name) {
      const titleTag = document.title || '';
      // Strip trailing " | LinkedIn" or " - LinkedIn"
      const stripped = titleTag.replace(/\s*[|\-]\s*LinkedIn\s*$/i, '').trim();
      const parts = stripped.split(/\s*\|\s*/);
      if (parts.length >= 2) {
        if (!name && parts[0].length > 2) name = parts[0].trim();
        if (!headline && parts[1].length > 2) headline = parts[1].trim();
      } else if (parts.length === 1 && !name) {
        name = parts[0].trim();
      }
    }

    // --- Company: parse from headline "Title at Company" or DOM ---
    let company = null;
    if (headline) {
      const atMatch = headline.match(/\bat\s+(.+)$/i);
      if (atMatch) company = atMatch[1].trim();
    }
    if (!company) {
      const companyEl = document.querySelector(
        '.pv-entity__secondary-title, ' +
        '.inline-show-more-text--is-collapsed-with-line-clamp, ' +
        '[data-field="experience"] .t-14.t-normal'
      );
      if (companyEl) company = companyEl.textContent.trim();
    }

    // --- Location ---
    const locationSelectors = [
      '.text-body-small.inline.t-black--light.break-words',
      '[data-field="location"]',
      '.pv-text-details__left-panel span.t-black--light',
      '.mt2 span.t-black--light',
    ];
    let location = null;
    for (const sel of locationSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 1) { location = el.textContent.trim(); break; }
    }

    return { name, headline, company, location };
  });
}

function titleMatches(headline) {
  // Headline DOM extraction is currently flaky on LinkedIn's React profile pages.
  // When we can't read a headline, don't skip — let the profile through and rely
  // on the screenshot for downstream review. If the headline IS readable, the
  // env-var-driven TITLE_KEYWORDS filter still applies.
  if (!headline) return true;
  const h = headline.toLowerCase();
  return TITLE_KEYWORDS.some(kw => h.includes(kw));
}

async function getProfileUrlsFromCurrentPage(page) {
  return page.evaluate(() => {
    const urls = new Set();
    const main = document.querySelector('main');
    if (!main) return [];

    // LinkedIn's people-search result containers across recent UI generations.
    // Scoping to these (inside <main>) excludes global nav, sidebars
    // ("People also searched for", "People you may know"), recent-search
    // dropdown, sponsored cards, and footer links.
    const containerSelectors = [
      '.reusable-search__result-container',
      '.entity-result',
      '[data-chameleon-result-urn]',
      'li.search-result'
    ].join(', ');

    for (const container of main.querySelectorAll(containerSelectors)) {
      const link = container.querySelector('a[href*="/in/"]');
      if (!link) continue;
      const href = (link.href || '').split('?')[0];
      if (href.includes('linkedin.com/in/')) urls.add(href);
    }

    // Fallback if LinkedIn changes container classes again: still scope to
    // <main> and explicitly exclude chrome regions.
    if (urls.size === 0) {
      for (const a of main.querySelectorAll('a[href*="/in/"]')) {
        if (a.closest('aside, nav, header, footer')) continue;
        const href = (a.href || '').split('?')[0];
        if (href.includes('linkedin.com/in/')) urls.add(href);
      }
    }
    return [...urls];
  });
}

async function main() {
  const email = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD || '';
  if (!email) throw new Error('Missing LINKEDIN_EMAIL');

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({ storageState: SESSION_PATH, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await setupFingerprinting(page);
  await loginToLinkedIn(page, email, password);

  console.log(`\nSearching for: "${SEARCH_TERM}" (title filter: [${TITLE_KEYWORDS.join(', ')}])`);
  const searchOk = await humanLikeSearch(page, SEARCH_TERM, {});
  if (!searchOk) throw new Error('Search failed');

  await sleep(jitter(2000, 3000));

  // Collect candidate URLs across pages until we have enough
  const seenUrls = new Set();
  const candidateUrls = [];
  let currentPage = 1;

  while (candidateUrls.length < PROFILE_COUNT * 3 && currentPage <= MAX_PAGES) {
    const pageUrls = await getProfileUrlsFromCurrentPage(page);
    for (const u of pageUrls) {
      if (!seenUrls.has(u)) { seenUrls.add(u); candidateUrls.push(u); }
    }
    console.log(`Search page ${currentPage}: ${pageUrls.length} profiles found (${candidateUrls.length} total candidates)`);

    if (currentPage < MAX_PAGES && candidateUrls.length < PROFILE_COUNT * 3) {
      // Try to go to next page
      const nextBtn = await page.$('button[aria-label="Next"]');
      if (nextBtn) {
        await nextBtn.click();
        await sleep(jitter(2500, 4000));
        currentPage++;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  console.log(`\nTotal candidates: ${candidateUrls.length}. Now visiting and filtering by title...`);

  const results = [];
  let screenshotIndex = 1;

  for (const profileUrl of candidateUrls) {
    if (results.length >= PROFILE_COUNT) break;

    console.log(`\nChecking: ${profileUrl}`);
    const result = { profileUrl, name: null, headline: null, company: null, location: null, likeResult: null, screenshotPath: null, skipped: false };

    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(jitter(2000, 3500));

      const info = await extractProfileInfo(page);
      Object.assign(result, info);

      // Title filter: skip if headline doesn't match
      if (!titleMatches(result.headline)) {
        console.log(`  ⏭  Skipping — headline "${result.headline}" doesn't match title filter`);
        result.skipped = true;
        continue;
      }

      console.log(`  ✓ Match: ${result.name} — ${result.headline}`);
      console.log(`  Company: ${result.company} | Location: ${result.location}`);

      // Screenshot
      const screenshotPath = path.join(OUTPUT_DIR, `profile-${screenshotIndex}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      result.screenshotPath = screenshotPath;
      screenshotIndex++;
      console.log(`  Screenshot: ${screenshotPath}`);

      // Like latest post
      await sleep(jitter(1500, 2500));
      try {
        const likeResult = await processActivityPageDetailed(page, profileUrl, {});
        result.likeResult = likeResult;
        const liked = likeResult?.success;
        console.log(`  Like: ${liked ? '✅' : '⚠️  ' + (likeResult?.reason || 'no result')}`);
      } catch (likeErr) {
        result.likeResult = { error: likeErr.message };
        console.log(`  Like error: ${likeErr.message}`);
      }

      results.push(result);

    } catch (err) {
      result.error = err.message;
      console.error(`  Error: ${err.message}`);
    }

    if (results.length < PROFILE_COUNT) {
      await sleep(jitter(3000, 5000));
    }
  }

  await browser.close();

  console.log(`\n\nDone. Found ${results.length}/${PROFILE_COUNT} matching profiles.`);
  console.log('\n--- RESULTS JSON ---');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
