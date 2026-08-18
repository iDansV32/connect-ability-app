'use strict';

/**
 * tests/people-search-results.test.js
 *
 * Pins the pure People-search result module — the seam that guarantees the
 * profiles we open/like/connect are exactly the ones LinkedIn shows on its
 * People results page, in display order, with no sidebar / suggestion / ad /
 * "people also viewed" / right-rail contamination and no stale duplicates.
 *
 * Pure module — no Playwright, no LinkedIn, no credentials, no network. The
 * DOM extractor is exercised against a hand-rolled minimal fake `page` whose
 * `evaluate(fn)` runs `fn` against a fake `document`/`Element` graph.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PEOPLE_SEARCH_SOURCE,
  normalizeLinkedInProfileUrl,
  normalizeSearchProvenance,
  buildPeopleSearchProfiles,
  extractPeopleSearchCandidatesFromPage,
  waitForPeopleSearchCandidatesFromPage
} = require('../automation/search/people-search-results');

// ---------------------------------------------------------------------------
// normalizeLinkedInProfileUrl
// ---------------------------------------------------------------------------

test('normalizeLinkedInProfileUrl: accepts /in/ URLs, strips query + trailing slash', () => {
  assert.equal(
    normalizeLinkedInProfileUrl('https://www.linkedin.com/in/jane-doe/'),
    'https://www.linkedin.com/in/jane-doe'
  );
  assert.equal(
    normalizeLinkedInProfileUrl('https://www.linkedin.com/in/jane-doe?miniProfileUrn=abc&trk=xyz'),
    'https://www.linkedin.com/in/jane-doe'
  );
  // bare host (no www) is normalized to canonical www form
  assert.equal(
    normalizeLinkedInProfileUrl('https://linkedin.com/in/john_smith'),
    'https://www.linkedin.com/in/john_smith'
  );
  // percent-encoded slug preserved (real LinkedIn slugs contain these)
  assert.equal(
    normalizeLinkedInProfileUrl('https://www.linkedin.com/in/ren%C3%A9e-georges-a8635843/'),
    'https://www.linkedin.com/in/ren%C3%A9e-georges-a8635843'
  );
  // Schemeless relative input is resolved against the LinkedIn origin, so a
  // bare "in/<slug>" is a VALID profile. Pinned explicitly so this behavior
  // isn't ambiguous.
  assert.equal(
    normalizeLinkedInProfileUrl('in/jane-doe'),
    'https://www.linkedin.com/in/jane-doe'
  );
});

test('normalizeLinkedInProfileUrl: rejects company / search / post / non-LinkedIn / empty', () => {
  for (const bad of [
    'https://www.linkedin.com/company/acme/',
    'https://www.linkedin.com/search/results/people/?keywords=x',
    'https://www.linkedin.com/posts/jane-doe_activity-123',
    'https://www.linkedin.com/feed/',
    'https://example.com/in/jane-doe',          // wrong host
    'https://linkedin.com.evil.com/in/jane',     // lookalike host
    '',
    null,
    undefined,
    'not a url'
  ]) {
    assert.equal(normalizeLinkedInProfileUrl(bad), null, `${JSON.stringify(bad)} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// normalizeSearchProvenance
// ---------------------------------------------------------------------------

test('normalizeSearchProvenance: canonicalizes fields, defaults source, clamps rank', () => {
  const p = normalizeSearchProvenance({
    searchTerm: '  software engineer ',
    searchRank: '2',
    searchResultIndex: 2,
    searchPageUrl: 'https://www.linkedin.com/search/results/people/?keywords=x'
  });
  assert.equal(p.source, PEOPLE_SEARCH_SOURCE, 'defaults source when only rank/term present');
  assert.equal(p.searchSource, PEOPLE_SEARCH_SOURCE, 'clear search-specific source alias is stamped');
  assert.equal(p.searchTerm, 'software engineer');
  assert.equal(p.searchRank, 2);
  assert.equal(p.searchResultIndex, 2);
});

test('normalizeSearchProvenance: returns null when there is nothing to carry', () => {
  assert.equal(normalizeSearchProvenance(null), null);
  assert.equal(normalizeSearchProvenance({}), null);
  assert.equal(normalizeSearchProvenance({ searchRank: 0 }), null); // 0/neg rank is not provenance
  assert.equal(normalizeSearchProvenance({ searchRank: -3 }), null);
});

test('normalizeSearchProvenance: preserves an explicit non-default source', () => {
  const p = normalizeSearchProvenance({ source: 'custom_source', searchRank: 1 });
  assert.equal(p.source, 'custom_source');
  assert.equal(p.searchSource, 'custom_source');
  assert.equal(p.searchRank, 1);
});

// ---------------------------------------------------------------------------
// buildPeopleSearchProfiles
// ---------------------------------------------------------------------------

test('buildPeopleSearchProfiles: preserves People-page order + assigns rank 1..N', () => {
  const candidates = [
    { href: 'https://www.linkedin.com/in/alpha/', name: 'Alpha', searchResultIndex: 1 },
    { href: 'https://www.linkedin.com/in/bravo/', name: 'Bravo', searchResultIndex: 2 },
    { href: 'https://www.linkedin.com/in/charlie/', name: 'Charlie', searchResultIndex: 3 }
  ];
  const profiles = buildPeopleSearchProfiles(candidates, {
    searchTerm: 'software engineer',
    searchPageUrl: 'https://www.linkedin.com/search/results/people/?keywords=software%20engineer'
  });

  assert.deepEqual(profiles.map((p) => p.profileUrl), [
    'https://www.linkedin.com/in/alpha',
    'https://www.linkedin.com/in/bravo',
    'https://www.linkedin.com/in/charlie'
  ]);
  assert.deepEqual(profiles.map((p) => p.searchRank), [1, 2, 3]);
});

test('buildPeopleSearchProfiles: dedupes repeated profile URLs, keeps first occurrence', () => {
  const candidates = [
    { href: 'https://www.linkedin.com/in/alpha/' },
    { href: 'https://www.linkedin.com/in/alpha?trk=dup' }, // same profile, query noise
    { href: 'https://www.linkedin.com/in/bravo/' },
    { href: 'https://linkedin.com/in/alpha' }              // same profile, no-www
  ];
  const profiles = buildPeopleSearchProfiles(candidates, { searchTerm: 'x' });
  assert.deepEqual(profiles.map((p) => p.profileUrl), [
    'https://www.linkedin.com/in/alpha',
    'https://www.linkedin.com/in/bravo'
  ]);
  assert.deepEqual(profiles.map((p) => p.searchRank), [1, 2]);
});

test('buildPeopleSearchProfiles: drops non-profile candidates (company/search/null)', () => {
  const candidates = [
    { href: 'https://www.linkedin.com/company/acme/' },
    { href: 'https://www.linkedin.com/in/keeper/' },
    { href: 'https://www.linkedin.com/search/results/people/?keywords=x' },
    { href: null }
  ];
  const profiles = buildPeopleSearchProfiles(candidates, { searchTerm: 'x' });
  assert.deepEqual(profiles.map((p) => p.profileUrl), ['https://www.linkedin.com/in/keeper']);
});

test('buildPeopleSearchProfiles: stamps source, searchTerm, searchPageUrl + initial open fields', () => {
  const candidates = [{
    href: 'https://www.linkedin.com/in/jane/',
    name: '  Jane   Doe  ',
    headline: 'Senior Software Engineer',
    location: 'Berlin, Germany',
    searchResultIndex: 1,
    searchPageUrl: 'https://www.linkedin.com/search/results/people/?keywords=software%20engineer'
  }];
  const [p] = buildPeopleSearchProfiles(candidates, { searchTerm: 'software engineer' });
  assert.equal(p.source, PEOPLE_SEARCH_SOURCE);
  assert.equal(p.source, 'linkedin_people_search');
  assert.equal(p.searchTerm, 'software engineer');
  assert.equal(p.searchPageUrl, 'https://www.linkedin.com/search/results/people/?keywords=software%20engineer');
  assert.equal(p.profileUrl, 'https://www.linkedin.com/in/jane');
  assert.equal(p.name, 'Jane Doe');           // collapsed whitespace
  assert.equal(p.headline, 'Senior Software Engineer');
  assert.equal(p.location, 'Berlin, Germany');
  assert.equal(p.searchRank, 1);
  assert.equal(p.searchResultIndex, 1);
  // Initial open-tracking state — every profile starts unopened.
  assert.equal(p.openStatus, 'not_opened');
  assert.equal(p.openedAt, null);
  assert.equal(p.openedUrl, null);
});

test('buildPeopleSearchProfiles: respects maxResults (display order, first N)', () => {
  const candidates = Array.from({ length: 10 }, (_, i) => ({
    href: `https://www.linkedin.com/in/p${i}/`
  }));
  const profiles = buildPeopleSearchProfiles(candidates, { searchTerm: 'x', maxResults: 3 });
  assert.equal(profiles.length, 3);
  assert.deepEqual(profiles.map((p) => p.profileUrl), [
    'https://www.linkedin.com/in/p0',
    'https://www.linkedin.com/in/p1',
    'https://www.linkedin.com/in/p2'
  ]);
});

test('buildPeopleSearchProfiles: tolerates non-array / empty input', () => {
  assert.deepEqual(buildPeopleSearchProfiles(undefined, { searchTerm: 'x' }), []);
  assert.deepEqual(buildPeopleSearchProfiles([], { searchTerm: 'x' }), []);
  assert.deepEqual(buildPeopleSearchProfiles(null), []);
});

// ---------------------------------------------------------------------------
// extractPeopleSearchCandidatesFromPage — DOM-ish extractor
// ---------------------------------------------------------------------------

/**
 * Minimal fake DOM. Each node supports the small slice of the DOM API the
 * extractor touches: querySelector / querySelectorAll (by a flat selector
 * match against a node's declared `match` tags), textContent, and href.
 *
 * We model the page as: document.querySelector('main') → a container with
 * People result cards, plus aside/header links that must be ignored because
 * the extractor only scans inside `main`'s result containers.
 */
function makeNode({ selectors = [], href = null, text = '', children = [] } = {}) {
  return {
    _selectors: new Set(selectors),
    href,
    textContent: text,
    children,
    // querySelector: first descendant (incl. self-children) matching ANY of the
    // comma-separated selector alternatives we care about.
    querySelector(selectorList) {
      const wanted = selectorList.split(',').map((s) => s.trim());
      const walk = (nodes) => {
        for (const n of nodes) {
          if (wanted.some((w) => n._selectors.has(w))) return n;
          const deep = walk(n.children);
          if (deep) return deep;
        }
        return null;
      };
      return walk(this.children);
    },
    querySelectorAll(selectorList) {
      const wanted = selectorList.split(',').map((s) => s.trim());
      const out = [];
      const walk = (nodes) => {
        for (const n of nodes) {
          if (wanted.some((w) => n._selectors.has(w))) out.push(n);
          walk(n.children);
        }
      };
      walk(this.children);
      return out;
    }
  };
}

/**
 * Fake Playwright page whose evaluate(fn) runs fn in-process with a `document`
 * global bound to our fake graph. The extractor's evaluate body only uses
 * document.querySelector('main') and container.querySelector('a[href*="/in/"]')
 * plus textContent — all supported above.
 */
function makeFakePage(documentRoot) {
  return {
    async evaluate(fn) {
      const prev = global.document;
      global.document = documentRoot;
      try {
        return await fn();
      } finally {
        global.document = prev;
      }
    }
  };
}

test('extractPeopleSearchCandidatesFromPage: returns only profile links inside People result containers, in order', async () => {
  // Result cards inside <main>, each a `.entity-result` with an /in/ link.
  const card = (slug, name, idxText) => makeNode({
    selectors: ['.entity-result', '[data-chameleon-result-urn]'],
    children: [
      makeNode({ selectors: ['a[href*="/in/"]'], href: `https://www.linkedin.com/in/${slug}?trk=results` }),
      makeNode({ selectors: ['.entity-result__title-text'], text: name }),
      makeNode({ selectors: ['.entity-result__primary-subtitle'], text: 'Software Engineer' }),
      makeNode({ selectors: ['.entity-result__secondary-subtitle'], text: idxText })
    ]
  });

  const main = makeNode({
    selectors: ['main'],
    children: [
      card('alpha', 'Alpha', 'Berlin'),
      card('bravo', 'Bravo', 'London'),
      // A NON-result profile link directly under main but NOT inside a result
      // container — must be ignored (extractor only scans result containers).
      makeNode({ selectors: ['a[href*="/in/"]'], href: 'https://www.linkedin.com/in/sidebar-suggestion' })
    ]
  });

  // document.querySelector('main') must return `main`.
  const documentRoot = {
    querySelector(sel) { return sel === 'main' ? main : null; }
  };

  const page = makeFakePage(documentRoot);
  const candidates = await extractPeopleSearchCandidatesFromPage(page);

  assert.equal(candidates.length, 2, 'only the two result-container profiles, not the loose sidebar link');
  assert.deepEqual(candidates.map((c) => c.href), [
    'https://www.linkedin.com/in/alpha',
    'https://www.linkedin.com/in/bravo'
  ]);
  assert.deepEqual(candidates.map((c) => c.searchResultIndex), [1, 2]);
  assert.equal(candidates[0].name, 'Alpha');
});

test('extractPeopleSearchCandidatesFromPage: supports current li-only People cards and ignores mutual links', async () => {
  const card = (slug, name, mutualSlug) => makeNode({
    selectors: ['li'],
    children: [
      // Image/avatar link: same candidate URL, often no useful text.
      makeNode({ selectors: ['a[href*="/in/"]'], href: `https://www.linkedin.com/in/${slug}?miniProfileUrn=abc` }),
      // Name link: same candidate URL, useful text.
      makeNode({ selectors: ['a[href*="/in/"]'], href: `https://www.linkedin.com/in/${slug}?trk=people`, text: name }),
      // Mutual connection link: a different /in/ URL inside the same card. This
      // must NOT become the action target.
      makeNode({ selectors: ['a[href*="/in/"]'], href: `https://www.linkedin.com/in/${mutualSlug}`, text: 'Mutual Connection' })
    ]
  });
  const main = makeNode({
    selectors: ['main'],
    children: [
      card('dana-whitfield', 'Dana Whitfield', 'jamie-alcott'),
      card('mira-tolvanen-koski', 'Mira Tolvanen (Koski)', 'another-mutual')
    ]
  });
  const documentRoot = { querySelector: (sel) => (sel === 'main' ? main : null) };

  const candidates = await extractPeopleSearchCandidatesFromPage(makeFakePage(documentRoot));

  assert.deepEqual(candidates.map((c) => c.href), [
    'https://www.linkedin.com/in/dana-whitfield',
    'https://www.linkedin.com/in/mira-tolvanen-koski'
  ]);
  assert.deepEqual(candidates.map((c) => c.name), [
    'Dana Whitfield',
    'Mira Tolvanen (Koski)'
  ]);
  assert.deepEqual(candidates.map((c) => c.searchResultIndex), [1, 2]);
});

test('extractPeopleSearchCandidatesFromPage: feeds buildPeopleSearchProfiles cleanly (right-rail link excluded end-to-end)', async () => {
  const card = (slug) => makeNode({
    selectors: ['.entity-result'],
    children: [makeNode({ selectors: ['a[href*="/in/"]'], href: `https://www.linkedin.com/in/${slug}/` })]
  });
  const main = makeNode({
    selectors: ['main'],
    children: [card('rank1'), card('rank2')]
  });
  const documentRoot = { querySelector: (sel) => (sel === 'main' ? main : null) };

  const candidates = await extractPeopleSearchCandidatesFromPage(makeFakePage(documentRoot));
  const profiles = buildPeopleSearchProfiles(candidates, {
    searchTerm: 'software engineer',
    searchPageUrl: 'https://www.linkedin.com/search/results/people/?keywords=software%20engineer',
    maxResults: 5
  });

  assert.deepEqual(profiles.map((p) => p.profileUrl), [
    'https://www.linkedin.com/in/rank1',
    'https://www.linkedin.com/in/rank2'
  ]);
  assert.deepEqual(profiles.map((p) => p.searchRank), [1, 2]);
  assert.ok(profiles.every((p) => p.source === 'linkedin_people_search'));
  assert.ok(profiles.every((p) => p.searchTerm === 'software engineer'));
});

test('extractPeopleSearchCandidatesFromPage: hashed-class fallback — dedupes avatar+name, skips <span> mutual links, preserves order', async () => {
  // Current LinkedIn People layout: no class-findable result containers, just
  // profile links in <main>. Result links are block-level (parent div=avatar,
  // p=name); inline "X is a mutual connection" links have a <span> parent and
  // must be excluded. This harness wires parentElement.tagName, which the
  // fallback inspects.
  const link = (slug, parentTag, text) => {
    const node = {
      _selectors: new Set(['a[href*="/in/"]']),
      href: `https://www.linkedin.com/in/${slug}`,
      textContent: text,
      children: [],
      parentElement: { tagName: parentTag.toUpperCase() },
      querySelector: () => null,
      querySelectorAll: () => []
    };
    return node;
  };

  // Document order mirrors the live dump: avatar, name, [mutual], avatar, name…
  const links = [
    link('theo-marchetti', 'div', 'Theo Marchetti • 2ndSoftware Engineer @ Northwind Games'),
    link('theo-marchetti', 'p', 'Theo Marchetti'),
    link('casey--brennan', 'span', 'Casey Brennan'),            // mutual connection — skip
    link('nkarlsson', 'div', 'Nils Karlsson • 2ndSenior Software Engineer'),
    link('nkarlsson', 'p', 'Nils Karlsson'),
    link('alex-lindqvist', 'span', 'Alex Lindqvist')         // mutual connection — skip
  ];
  const main = {
    _selectors: new Set(['main']),
    children: links,
    querySelector: () => null,
    // Container selectors find nothing (no entity-result/li); only the /in/
    // link query returns the links, triggering the fallback path.
    querySelectorAll: (sel) => (sel.includes('a[href*="/in/"]') ? links : [])
  };
  const documentRoot = { querySelector: (sel) => (sel === 'main' ? main : null) };

  const candidates = await extractPeopleSearchCandidatesFromPage(makeFakePage(documentRoot));

  assert.deepEqual(candidates.map((c) => c.href), [
    'https://www.linkedin.com/in/theo-marchetti',
    'https://www.linkedin.com/in/nkarlsson'
  ], 'only result profiles, mutual-connection links excluded, deduped + in order');
  assert.deepEqual(candidates.map((c) => c.name), ['Theo Marchetti', 'Nils Karlsson'], 'clean name from the <p> name-link');
  assert.deepEqual(candidates.map((c) => c.searchResultIndex), [1, 2]);
});

test('extractPeopleSearchCandidatesFromPage: no <main> → empty; non-evaluatable page → empty', async () => {
  const documentRoot = { querySelector: () => null };
  assert.deepEqual(await extractPeopleSearchCandidatesFromPage(makeFakePage(documentRoot)), []);
  assert.deepEqual(await extractPeopleSearchCandidatesFromPage(null), []);
  assert.deepEqual(await extractPeopleSearchCandidatesFromPage({}), []);
});

test('waitForPeopleSearchCandidatesFromPage: polls until result cards appear', async () => {
  let calls = 0;
  const emptyDocument = { querySelector: () => null };
  const card = makeNode({
    selectors: ['li'],
    children: [makeNode({ selectors: ['a[href*="/in/"]'], href: 'https://www.linkedin.com/in/delayed-result', text: 'Delayed Result' })]
  });
  const main = makeNode({ selectors: ['main'], children: [card] });
  const readyDocument = { querySelector: (sel) => (sel === 'main' ? main : null) };
  const page = {
    async evaluate(fn) {
      calls += 1;
      const prev = global.document;
      global.document = calls < 3 ? emptyDocument : readyDocument;
      try {
        return await fn();
      } finally {
        global.document = prev;
      }
    },
    async waitForTimeout() {}
  };

  const candidates = await waitForPeopleSearchCandidatesFromPage(page, {
    timeoutMs: 1000,
    intervalMs: 1
  });

  assert.equal(calls, 3);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].href, 'https://www.linkedin.com/in/delayed-result');
});
