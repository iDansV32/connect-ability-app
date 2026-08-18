'use strict';

const PEOPLE_SEARCH_SOURCE = 'linkedin_people_search';

function normalizeLinkedInProfileUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let parsed = null;
  try {
    parsed = new URL(raw.startsWith('http') ? raw : `https://www.linkedin.com${raw.startsWith('/') ? '' : '/'}${raw}`);
  } catch (_) {
    return null;
  }

  const host = String(parsed.hostname || '').toLowerCase();
  if (host !== 'linkedin.com' && host !== 'www.linkedin.com') {
    return null;
  }

  const match = parsed.pathname.match(/^\/in\/([^/?#]+)/i);
  if (!match || !match[1]) {
    return null;
  }

  return `https://www.linkedin.com/in/${match[1]}`;
}

function cleanText(value, maxLength = 240) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength) || null;
}

/**
 * Normalize a search-provenance descriptor into the canonical shape that is
 * threaded from a People-search receipt through workflow targets, prospect
 * metadata, and activity events. Accepts either a flat object carrying the
 * fields directly or a full profile receipt entry.
 *
 * Returns null when there is no usable provenance (no source and no rank),
 * so callers can omit it cleanly rather than storing an empty husk.
 *
 * @param {object} input
 * @returns {{source:string, searchTerm:(string|null), searchRank:(number|null),
 *            searchSource:string, searchResultIndex:(number|null),
 *            searchPageUrl:(string|null)}|null}
 */
function normalizeSearchProvenance(input) {
  if (!input || typeof input !== 'object') return null;

  const source = cleanText(input.source, 60);
  const searchTerm = cleanText(input.searchTerm, 160);
  const searchPageUrl = cleanText(input.searchPageUrl, 1000);
  const rankRaw = Number(input.searchRank);
  const idxRaw = Number(input.searchResultIndex);
  const searchRank = Number.isFinite(rankRaw) && rankRaw > 0 ? Math.floor(rankRaw) : null;
  const searchResultIndex = Number.isFinite(idxRaw) && idxRaw > 0 ? Math.floor(idxRaw) : null;

  // Nothing worth carrying — neither a source tag nor a rank.
  if (!source && searchRank == null && searchResultIndex == null && !searchTerm && !searchPageUrl) {
    return null;
  }

  return {
    source: source || PEOPLE_SEARCH_SOURCE,
    searchSource: source || PEOPLE_SEARCH_SOURCE,
    searchTerm,
    searchRank,
    searchResultIndex,
    searchPageUrl
  };
}

function buildPeopleSearchProfiles(candidates = [], options = {}) {
  const maxResults = Math.max(1, Math.min(50, Number(options.maxResults) || 50));
  const searchTerm = cleanText(options.searchTerm, 160);
  const defaultSearchPageUrl = cleanText(options.searchPageUrl, 1000);
  const profiles = [];
  const seen = new Set();

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const profileUrl = normalizeLinkedInProfileUrl(
      candidate?.profileUrl || candidate?.url || candidate?.href || candidate?.originalUrl
    );
    if (!profileUrl || seen.has(profileUrl)) {
      continue;
    }

    seen.add(profileUrl);
    profiles.push({
      source: PEOPLE_SEARCH_SOURCE,
      searchTerm,
      searchRank: profiles.length + 1,
      searchResultIndex: Number.isFinite(Number(candidate?.searchResultIndex))
        ? Number(candidate.searchResultIndex)
        : profiles.length + 1,
      searchPageUrl: cleanText(candidate?.searchPageUrl, 1000) || defaultSearchPageUrl,
      profileUrl,
      originalUrl: cleanText(candidate?.href || candidate?.originalUrl || candidate?.profileUrl || profileUrl, 1000),
      name: cleanText(candidate?.name, 160),
      headline: cleanText(candidate?.headline || candidate?.title, 240),
      location: cleanText(candidate?.location, 160),
      openStatus: 'not_opened',
      openedAt: null,
      openedUrl: null
    });

    if (profiles.length >= maxResults) {
      break;
    }
  }

  return profiles;
}

async function extractPeopleSearchCandidatesFromPage(page) {
  if (!page || typeof page.evaluate !== 'function') {
    return [];
  }

  return page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return [];

    const normalizeHref = (href) => {
      const clean = String(href || '').split('?')[0].replace(/\/+$/, '');
      return clean.includes('linkedin.com/in/') ? clean : null;
    };
    const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

    const selectors = [
      '.reusable-search__result-container',
      '.entity-result',
      '[data-chameleon-result-urn]',
      '[data-view-name*="search-entity-result"]',
      'li.search-result',
      // Current LinkedIn People results can render as plain list items with
      // dynamic classes. Scoped to <main> and filtered for /in/ links below.
      'li'
    ];

    const seenContainers = new Set();
    const containers = [];
    for (const selector of selectors) {
      for (const container of Array.from(main.querySelectorAll(selector))) {
        if (seenContainers.has(container)) continue;
        seenContainers.add(container);
        containers.push(container);
      }
    }

    const results = [];
    for (const container of containers) {
      const links = Array.from(container.querySelectorAll('a[href*="/in/"]'));
      if (!links.length) continue;

      // The first unique /in/ URL in a result card is the candidate profile.
      // Later /in/ links are often mutual connections ("X is a mutual…") and
      // must not become action targets.
      let profileUrl = null;
      for (const link of links) {
        const normalized = normalizeHref(link.href);
        if (normalized) {
          profileUrl = normalized;
          break;
        }
      }
      if (!profileUrl) continue;

      const sameProfileLinks = links.filter((link) => normalizeHref(link.href) === profileUrl);
      const linkText = cleanText(
        (sameProfileLinks.find((link) => cleanText(link.textContent)) || sameProfileLinks[0] || {}).textContent
      );

      const nameNode = container.querySelector(
        '.entity-result__title-text a span[aria-hidden="true"], .entity-result__title-text span[aria-hidden="true"], .entity-result__title-text, .app-aware-link span[aria-hidden="true"], [dir="ltr"] span[aria-hidden="true"]'
      );
      const headlineNode = container.querySelector(
        '.entity-result__primary-subtitle, .entity-result__summary, .subline-level-1'
      );
      const locationNode = container.querySelector(
        '.entity-result__secondary-subtitle, .subline-level-2'
      );

      results.push({
        href: profileUrl,
        name: cleanText(nameNode ? nameNode.textContent : '') || linkText,
        headline: headlineNode ? headlineNode.textContent : '',
        location: locationNode ? locationNode.textContent : '',
        searchResultIndex: results.length + 1
      });
    }

    if (results.length) return results;

    // Fallback for the current hashed-class layout: People result cards have no
    // class-findable container, but the profile links are still in <main>.
    // Observed structure: a result's avatar link (parent <div>, has <img>) and
    // name link (parent <p>) are BLOCK-level; an inline "X is a mutual
    // connection" link has a <span> parent. So: skip <span>-parented links
    // (mutual-connection insights), then dedupe by profile URL in document
    // order — collapsing each card's avatar+name links into one ranked result.
    const byUrl = new Map();
    for (const link of Array.from(main.querySelectorAll('a[href*="/in/"]'))) {
      const parentTag = link.parentElement ? String(link.parentElement.tagName || '').toLowerCase() : '';
      if (parentTag === 'span') continue;
      const profileUrl = normalizeHref(link.href);
      if (!profileUrl) continue;
      const text = cleanText(link.textContent);
      if (!byUrl.has(profileUrl)) {
        byUrl.set(profileUrl, { href: profileUrl, name: '', order: byUrl.size });
      }
      const entry = byUrl.get(profileUrl);
      // Prefer the short, clean name-link text (parent <p>); else the first
      // chunk of the avatar link's longer "Name • degree+headline" string.
      if (parentTag === 'p' && text) entry.name = text;
      else if (!entry.name && text) entry.name = text.split('•')[0].trim();
    }
    return Array.from(byUrl.values())
      .sort((a, b) => a.order - b.order)
      .map((entry, index) => ({
        href: entry.href,
        name: entry.name,
        headline: '',
        location: '',
        searchResultIndex: index + 1
      }));
  }).catch(() => []);
}

/**
 * Diagnostic: describe the live People-results DOM so we can see why extraction
 * found nothing — WITHOUT logging anyone's identity. Returns the page path
 * (query string stripped), whether <main> exists, how many /in/ links live in
 * the document vs inside <main>, and per-link STRUCTURAL signals only
 * (parentTag, grandparentTag, hasImg, textLen, index). No profile slugs/URLs
 * and no visible text are emitted, so app logs never store people's names or
 * profiles. Read-only; tolerates a non-evaluatable page.
 */
async function describePeopleSearchPage(page) {
  if (!page || typeof page.evaluate !== 'function') {
    return { path: null, hasMain: false, docProfileLinks: 0, mainProfileLinks: 0, links: [] };
  }
  return page.evaluate(() => {
    const main = document.querySelector('main');
    const docLinks = Array.from(document.querySelectorAll('a[href*="/in/"]'));
    const mainLinks = main ? Array.from(main.querySelectorAll('a[href*="/in/"]')) : [];
    const links = (main ? mainLinks : docLinks).slice(0, 12).map((link, index) => {
      const parent = link.parentElement;
      return {
        index,
        parentTag: parent ? parent.tagName.toLowerCase() : null,
        grandparentTag: parent && parent.parentElement ? parent.parentElement.tagName.toLowerCase() : null,
        hasImg: !!link.querySelector('img'),
        // Length only — never the text itself (would leak names).
        textLen: String(link.textContent || '').replace(/\s+/g, ' ').trim().length
      };
    });
    return {
      // Pathname only — drops the ?keywords=… query so the search term isn't logged.
      path: String((location && location.pathname) || '').slice(0, 120),
      hasMain: Boolean(main),
      docProfileLinks: docLinks.length,
      mainProfileLinks: mainLinks.length,
      links
    };
  }).catch((err) => ({ error: String(err && err.message || err) }));
}

async function waitForPeopleSearchCandidatesFromPage(page, options = {}) {
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 12000);
  const intervalMs = Math.max(100, Number(options.intervalMs) || 500);
  const deadline = Date.now() + timeoutMs;
  let last = [];

  while (Date.now() <= deadline) {
    last = await extractPeopleSearchCandidatesFromPage(page);
    if (last.length) {
      return last;
    }
    if (page && typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(intervalMs).catch(() => {});
    } else {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return last;
}

module.exports = {
  PEOPLE_SEARCH_SOURCE,
  normalizeLinkedInProfileUrl,
  normalizeSearchProvenance,
  buildPeopleSearchProfiles,
  extractPeopleSearchCandidatesFromPage,
  waitForPeopleSearchCandidatesFromPage,
  describePeopleSearchPage
};
