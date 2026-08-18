'use strict';

/**
 * tests/profile-extract.test.js
 *
 * Pins the class-agnostic profile top-card recovery added for LinkedIn's
 * current hashed-class DOM (no <h1>, no stable headline/company classes):
 *  - parseCompanyFromHeadline: derive the company token from a headline.
 *  - extractHeadlineClassAgnostic: find the headline as the first substantial
 *    body line after the name heading (run against a fake page/document).
 *
 * Pure / fake-DOM only — no Playwright, no LinkedIn, no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCompanyFromHeadline,
  extractHeadlineClassAgnostic,
  describeProfileDetailPage,
  findVisibleContactInfoHandle
} = require('../automation/profile/extract');

// ---------------------------------------------------------------------------
// parseCompanyFromHeadline
// ---------------------------------------------------------------------------

test('parseCompanyFromHeadline: extracts company, stopping at | • · separators', () => {
  assert.equal(
    parseCompanyFromHeadline('Software Engineer @ Marisol Telecom | DevOps Engineering, Northcrest University'),
    'Marisol Telecom'
  );
  assert.equal(parseCompanyFromHeadline('Senior Software Engineer at Brightloom'), 'Brightloom');
  assert.equal(parseCompanyFromHeadline('Software Engineer @ Northwind Games | SWE grad @ NCU'), 'Northwind Games');
  // "for"/"with" markers also work.
  assert.equal(parseCompanyFromHeadline('Recruiter for Acme Corp'), 'Acme Corp');
});

test('parseCompanyFromHeadline: returns null when no company marker is present', () => {
  assert.equal(parseCompanyFromHeadline('Engineering Leader'), null);
  assert.equal(parseCompanyFromHeadline('Product Designer • UX • Builder'), null);
  assert.equal(parseCompanyFromHeadline(''), null);
  assert.equal(parseCompanyFromHeadline(null), null);
  assert.equal(parseCompanyFromHeadline(undefined), null);
});

// ---------------------------------------------------------------------------
// extractHeadlineClassAgnostic — fake page/document
// ---------------------------------------------------------------------------

/**
 * Fake page modeling <main>'s descendants as a flat, document-ordered list.
 * Supports the slice of DOM the function uses: querySelector('main'),
 * main.querySelectorAll('h1, h2' | 'p, div, span'), textContent, children.length,
 * and compareDocumentPosition (FOLLOWING by document order).
 */
function makeProfileFakePage(spec, { noMain = false } = {}) {
  const nodes = spec.map((n, i) => ({
    tagName: String(n.tag).toUpperCase(),
    textContent: n.text || '',
    children: { length: n.childrenCount || 0 },
    _order: i,
    compareDocumentPosition(other) {
      return other && other._order > this._order ? 4 : 2; // 4 = DOCUMENT_POSITION_FOLLOWING
    }
  }));
  const main = {
    querySelectorAll(selectorList) {
      const tags = selectorList.split(',').map((s) => s.trim().toLowerCase());
      return nodes.filter((n) => tags.includes(n.tagName.toLowerCase()));
    }
  };
  const documentRoot = { querySelector: (sel) => (sel === 'main' && !noMain ? main : null) };
  return {
    async evaluate(fn, arg) {
      const prevDoc = global.document;
      const prevNode = global.Node;
      global.document = documentRoot;
      global.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
      try {
        return await fn(arg);
      } finally {
        global.document = prevDoc;
        global.Node = prevNode;
      }
    }
  };
}

test('extractHeadlineClassAgnostic: headline = first substantial line after the name h2, chips skipped', async () => {
  // Mirrors a live profile DOM: name in an <h2>, short chips (pronouns/degree),
  // then the headline <p>.
  const page = makeProfileFakePage([
    { tag: 'h2', text: 'Harper L.' },
    { tag: 'p', text: 'She/Her' },               // chip, < 15 chars → skipped
    { tag: 'p', text: '3rd' },                    // chip → skipped
    { tag: 'p', text: 'Software Engineer @ Marisol Telecom | DevOps Engineering' },
    { tag: 'p', text: 'Nairobi County, Kenya' }
  ]);
  const headline = await extractHeadlineClassAgnostic(page, 'Harper L.');
  assert.equal(headline, 'Software Engineer @ Marisol Telecom | DevOps Engineering');
});

test('extractHeadlineClassAgnostic: falls back to first short heading when name is not provided', async () => {
  const page = makeProfileFakePage([
    { tag: 'h2', text: 'Nils Karlsson' },
    { tag: 'p', text: 'Senior Software Engineer at Brightloom' }
  ]);
  const headline = await extractHeadlineClassAgnostic(page, '');
  assert.equal(headline, 'Senior Software Engineer at Brightloom');
});

test('extractHeadlineClassAgnostic: ignores lines BEFORE the name (document order respected)', async () => {
  const page = makeProfileFakePage([
    { tag: 'div', text: 'This long banner text appears before the name element' }, // before name
    { tag: 'h2', text: 'Harper L.' },
    { tag: 'p', text: 'Software Engineer @ Marisol Telecom' }
  ]);
  const headline = await extractHeadlineClassAgnostic(page, 'Harper L.');
  assert.equal(headline, 'Software Engineer @ Marisol Telecom', 'pre-name banner is not picked');
});

test('extractHeadlineClassAgnostic: null when no <main>, no heading, or nothing qualifies', async () => {
  assert.equal(await extractHeadlineClassAgnostic(makeProfileFakePage([], { noMain: true }), 'x'), null);
  assert.equal(await extractHeadlineClassAgnostic(makeProfileFakePage([{ tag: 'p', text: 'no heading here at all' }]), ''), null);
  // name heading present but only short chips after → null
  const onlyChips = makeProfileFakePage([{ tag: 'h2', text: 'Harper L.' }, { tag: 'p', text: '3rd' }, { tag: 'p', text: 'She/Her' }]);
  assert.equal(await extractHeadlineClassAgnostic(onlyChips, 'Harper L.'), null);
  assert.equal(await extractHeadlineClassAgnostic(null, 'x'), null);
  assert.equal(await extractHeadlineClassAgnostic({}, 'x'), null);
});

// ---------------------------------------------------------------------------
// describeProfileDetailPage — must anchor on the h2 top card (not h1-only)
// ---------------------------------------------------------------------------

/** Fake page for describeProfileDetailPage: it uses querySelector('main'),
 *  main.querySelectorAll('h1, h2' | '*' | '[aria-label]'), section ancestry via
 *  parentElement, textContent, className, getAttribute. */
function makeDescribePage(spec, { noMain = false } = {}) {
  // spec: { name:{tag,text}, lines:[{tag,text,cls?}] } under a <section> card in <main>.
  const mk = (n) => ({
    tagName: String(n.tag).toUpperCase(),
    textContent: n.text || '',
    className: n.cls || '',
    children: { length: n.childrenCount || 0 },
    getAttribute: () => null,
    parentElement: null
  });
  const nameEl = mk(spec.name);
  const lineEls = (spec.lines || []).map(mk);
  const section = {
    tagName: 'SECTION', textContent: '', className: '', children: { length: 1 + lineEls.length },
    getAttribute: () => null, parentElement: null,
    querySelectorAll() { return [nameEl, ...lineEls]; }
  };
  [nameEl, ...lineEls].forEach((el) => { el.parentElement = section; });
  const allInMain = [section, nameEl, ...lineEls];
  const main = {
    tagName: 'MAIN', textContent: spec.lines.map((l) => l.text).join(' '), getAttribute: () => null,
    querySelector() { return null; },
    querySelectorAll(selectorList) {
      const tags = selectorList.split(',').map((s) => s.trim().toLowerCase());
      if (selectorList.includes('aria-label')) return [];
      return allInMain.filter((el) => tags.includes(el.tagName.toLowerCase()));
    }
  };
  const documentRoot = { querySelector: (sel) => (sel === 'main' && !noMain ? main : null), querySelectorAll: () => [] };
  return {
    async evaluate(fn, arg) {
      const prevDoc = global.document; const prevLoc = global.location;
      global.document = documentRoot;
      global.location = { pathname: '/in/harper-l-b7c395021/', href: 'https://www.linkedin.com/in/harper-l-b7c395021/' };
      try { return await fn(arg); } finally { global.document = prevDoc; global.location = prevLoc; }
    }
  };
}

test('describeProfileDetailPage: anchors on the h2 name card (cardLines non-empty when name is in an h2)', async () => {
  const page = makeDescribePage({
    name: { tag: 'h2', text: 'Harper L.', cls: '_46c4903e.de7323d5' },
    lines: [
      { tag: 'p', text: 'She/Her', cls: '_46c4903e' },
      { tag: 'p', text: 'Software Engineer @ Marisol Telecom | DevOps Engineering', cls: '_46c4903e._5eebdb21' }
    ]
  });
  const diag = await describeProfileDetailPage(page, { name: 'Harper L.', headline: [], company: [] });
  assert.equal(diag.hasMain, true);
  assert.equal(diag.hasNameHeading, true, 'finds the name even with no <h1>');
  assert.equal(diag.nameHeadingTag, 'h2');
  assert.equal(diag.cardTag, 'section');
  assert.ok(diag.cardLines.length >= 1, 'cardLines populated from the h2-anchored card (regression: was empty with h1-only anchor)');
});

test('findVisibleContactInfoHandle returns only a semantic contact control, never the avatar', async () => {
  const makeHandle = ({ href = '', aria = '', text = '', visible = true }) => ({
    isVisible: async () => visible,
    getAttribute: async (name) => name === 'href' ? href : (name === 'aria-label' ? aria : ''),
    textContent: async () => text
  });
  const avatar = makeHandle({ href: '/in/alice/overlay/photo/', aria: 'View profile photo' });
  const contact = makeHandle({ href: '/in/alice/overlay/contact-info/', text: 'Contact info' });
  const page = {
    $$: async (selector) => selector.includes('overlay/contact-info') ? [avatar, contact] : []
  };

  assert.equal(await findVisibleContactInfoHandle(page), contact);
});
