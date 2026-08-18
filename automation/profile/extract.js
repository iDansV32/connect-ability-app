// profile/extract.js
const { randomDelay } = require('../human/delay');
const { logAction, logError } = require('../util/log');
const { moveMouseNaturally } = require('../mouse/move-naturally');
const path = require('path');
const fs = require('fs');

/**
 * Extract profile details from the current profile page
 * @param {Page} page - Playwright page object
 * @param {string} profileUrl - LinkedIn profile URL
 * @returns {Promise<Object>} - Profile details object
 */
async function extractProfileDetails(page, profileUrl) {
  try {
    logAction(`Starting profile extraction for ${profileUrl}`);
    
    // Make sure the profile page is fully loaded
    await page.waitForSelector('body', { timeout: 10000 });
    await randomDelay(2000, 3000);
    
    // Extract basic info using multiple selectors for redundancy
    const profileInfo = await page.evaluate(() => {
      window._debug_output = [];
      const debugLog = (msg) => { window._debug_output.push(msg); };
      
      const getTextFromSelectors = (selectors, selectorType) => {
        for (const selector of selectors) {
          try {
            const element = document.querySelector(selector);
            if (element) {
              const text = element.textContent.trim();
              debugLog(`${selectorType} found with selector "${selector}": "${text}"`);
              return text;
            }
          } catch (e) {
            debugLog(`Selector failed: ${selector} - ${e.message}`);
          }
        }
        debugLog(`No match found for any ${selectorType} selectors`);
        return '';
      };
      
      // Full name selectors — ordered from most specific/current to legacy
      const nameSelectors = [
        // Current LinkedIn (2025-2026) — the main profile h1 is inside a specific section
        'main h1',
        'main section h1',
        '[data-generated-suggestion-target] h1',
        'h1.text-heading-xlarge',
        // Profile card layouts
        '.profile-topcard-person-entity__name',
        '.pv-text-details__title h1',
        '.pv-text-details__left-panel h1',
        '.ph5 h1',
        '.artdeco-entity-lockup__title',
        // Legacy but sometimes still present
        'h1.inline.t-24',
        'h1.pv-top-card-section__name',
        '.pv-top-card--list li:first-child',
        '.profile-basic-info h1',
        '.pv-top-card-v2__list span',
        '.pv-top-card__title',
        '.profile-info-card__name-link',
        '.identity-widget__name',
        '.profile-rail-card__actor-link span',
        '.profile-topcard__title',
        '.pv-profile-card__name',
        '.presence-entity__name',
        '.identity-name',
        '.profile-overview-name',
        '.name'
      ];

      // Try primary selectors first
      let fullName = getTextFromSelectors(nameSelectors, 'FullName');

      // If nothing matched, try bare h1 but exclude known false positives
      if (!fullName) {
        const allH1 = Array.from(document.querySelectorAll('h1'));
        for (const h1 of allH1) {
          const text = (h1.textContent || '').trim();
          if (!text) continue;
          // Skip notification badges, empty, numeric-only, or very long text
          if (/^\d+\s*(notification|message|update)/i.test(text)) continue;
          if (text.length > 60) continue;
          if (text.length < 2) continue;
          // Must look like a name: contains a space, words are short
          if (text.includes(' ') && text.split(/\s+/).every(w => w.length < 25)) {
            fullName = text;
            debugLog(`FullName found via filtered h1 scan: "${text}"`);
            break;
          }
        }
      }
      
      // Fallback 1: extract from "Manage notifications about {Name}" aria-label
      if (!fullName) {
        debugLog('No name found with standard selectors, trying aria-label fallback');
        const notifBtn = document.querySelector('button[aria-label*="Manage notifications about"]');
        if (notifBtn) {
          const label = notifBtn.getAttribute('aria-label') || '';
          const match = label.match(/Manage notifications about\s+(.+)/i);
          if (match && match[1]) {
            fullName = match[1].trim();
            debugLog(`FullName found via notification button aria-label: "${fullName}"`);
          }
        }
      }

      // Fallback 2: extract from "Connect | Invite {Name} to connect" aria-label
      if (!fullName) {
        const connectBtn = document.querySelector('button[aria-label*="Invite"][aria-label*="to connect"]');
        if (connectBtn) {
          const label = connectBtn.getAttribute('aria-label') || '';
          const match = label.match(/Invite\s+(.+?)\s+to connect/i);
          if (match && match[1]) {
            fullName = match[1].trim();
            debugLog(`FullName found via connect button aria-label: "${fullName}"`);
          }
        }
      }

      // Fallback 3: broader heading scan excluding notification badges
      if (!fullName) {
        debugLog('No name found with aria-label fallbacks, trying heading scan');
        const allHeadings = Array.from(document.querySelectorAll('h1, h2, h3, .title, [class*="name"], [class*="title"]'));

        for (const heading of allHeadings) {
          if (heading.offsetWidth > 0 && heading.offsetHeight > 0) {
            const text = heading.textContent.trim();
            if (!text) continue;
            // Exclude notification/messaging badges
            if (/^\d+\s*(notification|message|update|result)/i.test(text)) continue;
            // Exclude very long strings (not names)
            if (text.length > 60) continue;
            if (text && text.includes(' ') && text.split(' ').every(word => word.length < 20)) {
              fullName = text;
              debugLog(`Found possible name via fallback: "${fullName}" from element ${heading.tagName}.${heading.className}`);
              break;
            }
          }
        }
      }
      
      // Parse full name into first and last name
      let firstName = '', lastName = '';
      if (fullName) {
        fullName = fullName.replace(/,.*$/, '')
                         .replace(/\([^)]*\)/g, '')
                         .replace(/^(Dr\.|Mr\.|Mrs\.|Ms\.|Prof\.)\s+/i, '')
                         .replace(/\s+(Jr\.|Sr\.|I|II|III|IV|V|MD|PhD|JD|DDS|CPA)$/i, '')
                         .trim();
                         
        debugLog(`Cleaned full name: "${fullName}"`);
        
        const nameParts = fullName.split(/\s+/);
        if (nameParts.length >= 1) {
          firstName = nameParts[0];
          lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
          
          debugLog(`Parsed name into firstName="${firstName}", lastName="${lastName}"`);
        }
      }
      
      // Headline/Position extraction
      const headlineSelectors = [
        // Current LinkedIn (2025-2026)
        'main .text-body-medium.break-words',
        'main section .text-body-medium',
        // Legacy/stable
        '.text-body-medium.break-words',
        '.pv-top-card-section__headline',
        '.profile-topcard-person-entity__headline',
        '.pv-text-details__secondary-text',
        '.pv-entity__subtitle',
        '.ph5 .mt1',
        '.pv-top-card-v2__list span.block',
        '.artdeco-entity-lockup__subtitle',
        '.profile-basic-info h2',
        '[data-field="headline"]',
        '.ph5 .mt1.t-18',
        '.pv-entity__headline',
        '.identity-headline',
        '.pv-top-card__headline',
        '[class*="headline"]'
      ];
      
      const headline = getTextFromSelectors(headlineSelectors, 'Headline');
      
      // Company extraction
      const companySelectors = [
        // Current LinkedIn (2025-2026) — company link in the top card
        'main section [aria-label*="Current company"]',
        'main section button[aria-label*="company"]',
        // Legacy/stable
        '.pv-text-details__right-panel .inline-show-more-text',
        '.pv-top-card-v2-section__link-text',
        '.pv-entity__secondary-title',
        '.profile-topcard-person-entity__secondary-title',
        '[aria-label*="Current company"]',
        '.pv-top-card__position-data span',
        '.pv-entity__company-summary-info h3',
        '.pv-top-card-v2__experience-company',
        '[data-field="experience"] li:first-child h3',
        '.profile-position-information .company-name',
        '.experience-item__subtitle',
        '.pv-position-entity__company-name',
        '.pv-entity__company-summary-info span:not(.visually-hidden)',
        '[class*="company-name"]',
        '[class*="employer"]',
        '.pv-top-card-section__company'
      ];
      
      // Company from a dedicated element. When the selectors miss (current
      // hashed-class profiles have no standalone company element), the node-side
      // caller derives it from the headline via parseCompanyFromHeadline — a
      // single, unit-tested helper — so the regex is not duplicated in here.
      const company = getTextFromSelectors(companySelectors, 'Company');

      // Location extraction
      const locationSelectors = [
        '.pv-top-card__location',
        '.pv-top-card-section__location',
        '.profile-topcard-person-entity__location',
        '[aria-label*="Location"]',
        '.pv-text-details__right-panel .text-body-small:not(.inline-show-more-text)',
        '.ph5 .t-16.t-black--light',
        '.pv-top-card-v2__list-item',
        '[data-field="location"]',
        '.pv-entity__location',
        '.location-information',
        '[class*="location"]'
      ];
      
      const location = getTextFromSelectors(locationSelectors, 'Location');
      
      // About section (for potential email)
      const aboutSelectors = [
        '.pv-about-section .inline-show-more-text',
        '.pv-about__summary-text',
        '#about+div .pv-shared-text-with-see-more',
        '.pv-about-section .pv-shared-text-with-see-more',
        '.about-section .display-flex',
        '.artdeco-tabpanel[aria-hidden="false"] p',
        '#about-section .pv-about__summary-text',
        '[aria-label="About"]',
        '#about ~ div',
        '[data-section="summary"]',
        '.pv-oc .about-section',
        '.about-text'
      ];
      
      const aboutText = getTextFromSelectors(aboutSelectors, 'About');
      
      const result = {
        fullName,
        firstName,
        lastName,
        headline,
        company,
        location,
        aboutText,
        debug: window._debug_output
      };
      
      console.log('FINAL EXTRACTED DATA:', JSON.stringify(result, null, 2));
      
      return result;
    });
    
    // Log all debug output from the page evaluation
    if (profileInfo.debug && profileInfo.debug.length > 0) {
      profileInfo.debug.forEach(log => logAction(`PageEval: ${log}`));
    }

    // Class-agnostic top-card recovery. Current LinkedIn profiles have no <h1>
    // and fully hashed classes, so the headline selectors miss → title/position
    // would be "Not Available" → the OCR fallback fires and GARBLES the data.
    // Recover the headline structurally (first body line after the name) and
    // derive company from it; this keeps OCR from ever running on these pages.
    if (!profileInfo.headline) {
      try {
        const fallbackHeadline = await extractHeadlineClassAgnostic(page, profileInfo.fullName || '');
        if (fallbackHeadline) {
          profileInfo.headline = fallbackHeadline;
          logAction(`Headline recovered via class-agnostic fallback (len ${fallbackHeadline.length})`);
        }
      } catch (_) { /* best-effort */ }
    }
    if ((!profileInfo.company || profileInfo.company === '') && profileInfo.headline) {
      const parsedCompany = parseCompanyFromHeadline(profileInfo.headline);
      if (parsedCompany) {
        profileInfo.company = parsedCompany;
        logAction('Company derived from headline');
      }
    }

    // Attempt to extract name from URL if still missing
    if (!profileInfo.firstName || profileInfo.firstName === '') {
      logAction('Name extraction failed, attempting to get name from URL');
      const urlNameMatch = profileUrl.match(/\/in\/([^\/]+)/);
      if (urlNameMatch && urlNameMatch[1]) {
        const { cleanLinkedInSlugName } = require('./url-utils');
        const cleanedName = cleanLinkedInSlugName(urlNameMatch[1]);
        const nameParts = cleanedName.split(' ');
        if (nameParts.length >= 1 && nameParts[0]) {
          profileInfo.firstName = nameParts[0];
          if (nameParts.length > 1) {
            profileInfo.lastName = nameParts.slice(1).join(' ');
          }
          profileInfo.fullName = cleanedName;
          logAction(`Extracted name from URL: ${profileInfo.fullName}`);
        }
      }
    }
    
    // Attempt to extract email
    let email = 'Not Available';
    try {
      const extractedEmail = await extractEmailFromProfile(page, profileUrl);
      if (extractedEmail && extractedEmail !== 'Not Available') {
        email = extractedEmail;
        logAction(`Successfully extracted email: ${email}`);
      }
    } catch (emailError) {
      logError(`Email extraction failed: ${emailError.message}`, emailError);
    }
    
    // Compile final profile details object
    const profileDetails = {
      firstName: profileInfo.firstName || 'Unknown',
      lastName: profileInfo.lastName || 'Profile',
      fullName: profileInfo.fullName || `${profileInfo.firstName || ''} ${profileInfo.lastName || ''}`.trim() || 'Unknown Profile',
      position: profileInfo.headline || 'Not Available',
      title: profileInfo.headline || 'Not Available',
      company: profileInfo.company || 'Not Available',
      location: profileInfo.location || '',
      email: email,
      profileUrl: profileUrl
    };
    
    logAction(`EXTRACTED PROFILE: ${JSON.stringify(profileDetails)}`);
    
    return profileDetails;
  } catch (error) {
    logError(`Error extracting profile details: ${error.message}`, error);
    
    // Return default profile data in case of error
    return {
      firstName: 'Unknown',
      lastName: 'Profile',
      fullName: 'Unknown Profile',
      position: 'Not Available',
      title: 'Not Available',
      company: 'Not Available',
      location: '',
      email: 'Not Available',
      profileUrl: profileUrl
    };
  }
}

/**
 * Extract email from LinkedIn profile
 * @param {Page} page - Playwright page object
 * @param {string} profileUrl - LinkedIn profile URL
 * @returns {Promise<string>} - Email address or 'Not Available'
 */
async function extractEmailFromProfile(page, profileUrl) {
  try {
    await randomDelay(1500, 4000);
    
    logAction('Looking for contact information...');
    
    // Hold the actual semantic element instead of caching screen coordinates.
    // LinkedIn's top card shifts while images/content settle; a delayed
    // coordinate click can otherwise land on the profile avatar underneath.
    const contactButton = await findVisibleContactInfoHandle(page);
    if (!contactButton) {
      logAction('No contact info button found - this profile might not have shared contact details');
      return 'Not Available';
    }

    await contactButton.scrollIntoViewIfNeeded().catch(() => {});
    await moveMouseNaturally(page, contactButton);
    await contactButton.click({ delay: 40 + Math.floor(Math.random() * 80) });
    logAction(`Clicked contact info button`);
    
    await randomDelay(1500, 3000);
    
    // Extract email from modal
    const email = await page.evaluate(() => {
      const emailSelectors = [
        'a[href^="mailto:"]',
        '.pv-contact-info__contact-type a[href^="mailto:"]',
        '.pv-contact-info__ci-container a[href^="mailto:"]'
      ];
      
      for (const selector of emailSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          return element.textContent.trim() || element.href.replace('mailto:', '');
        }
      }
      
      return null;
    });
    
    // Close the modal
    await page.evaluate(() => {
      const closeButtons = [
        ...document.querySelectorAll('button[aria-label="Dismiss"], .artdeco-modal__dismiss'),
        ...document.querySelectorAll('button.artdeco-modal__close, button.pv-contact-info__close-btn')
      ];
      
      if (closeButtons.length > 0) {
        closeButtons[0].click();
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', {'key': 'Escape'}));
      }
    });
    
    if (email) {
      logAction(`Found email: ${email}`);
      return email;
    }
    
    logAction('No email found in contact info');
    return 'Not Available';
    
  } catch (error) {
    logError('Error extracting email from profile', error);
    return 'Not Available';
  }
}

async function findVisibleContactInfoHandle(page) {
  if (!page || typeof page.$$ !== 'function') return null;
  const contactSelectors = [
    'a[href*="overlay/contact-info"]',
    'a[data-control-name="contact_see_more"]',
    'button[aria-label*="Contact info"]',
    'a[aria-label*="Contact info"]',
    'button:has-text("Contact info")'
  ];

  for (const selector of contactSelectors) {
    const handles = await page.$$(selector).catch(() => []);
    for (const handle of handles) {
      const visible = await handle.isVisible().catch(() => false);
      if (!visible) continue;
      const [href, ariaLabel, text] = await Promise.all([
        handle.getAttribute('href').catch(() => ''),
        handle.getAttribute('aria-label').catch(() => ''),
        handle.textContent().catch(() => '')
      ]);
      const semanticText = `${href || ''} ${ariaLabel || ''} ${text || ''}`;
      if (/overlay\/contact-info|contact\s*info/i.test(semanticText)) {
        return handle;
      }
    }
  }
  return null;
}

/**
 * Parse a company name from a LinkedIn headline. Headlines commonly read
 * "Software Engineer @ Acme | extra" or "Title at Acme, Other". Returns the
 * company token (stopping at | • · , and end-of-string) or null when the
 * headline carries no company marker. Pure — unit-testable.
 */
function parseCompanyFromHeadline(headline) {
  const text = String(headline || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const patterns = [
    /(?:\bat\b|@|\bwith\b|\bfor\b)\s+([\w&.,'\-/ ]+?)\s*(?:[|•·]|$)/i,
    /(?:\bat\b|@|\bwith\b|\bfor\b)\s+([^,|•·.]+)/i,
    /^[^@]+@\s*([^|•·.]+)/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1] && m[1].trim()) {
      return m[1].trim();
    }
  }
  return null;
}

/**
 * Class-agnostic headline extraction for the current hashed-class profile DOM
 * (no <h1>, no stable headline class). Finds the name heading (the heading whose
 * text equals the resolved name, else the first short h1/h2 in <main>) and
 * returns the first substantial body-text line that follows it in document
 * order — skipping short chips (pronouns, connection degree). Returns null when
 * nothing qualifies. Runs read-only in the page context; safe with a fake page.
 */
async function extractHeadlineClassAgnostic(page, fullName = '') {
  if (!page || typeof page.evaluate !== 'function') return null;
  return page.evaluate((name) => {
    const main = document.querySelector('main');
    if (!main) return null;
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const target = clean(name);

    const headings = Array.from(main.querySelectorAll('h1, h2'));
    let nameEl = null;
    if (target) nameEl = headings.find((h) => clean(h.textContent) === target) || null;
    if (!nameEl) nameEl = headings.find((h) => { const t = clean(h.textContent); return t && t.length <= 60; }) || null;
    if (!nameEl) return null;

    const FOLLOWING = (typeof Node !== 'undefined' && Node.DOCUMENT_POSITION_FOLLOWING)
      ? Node.DOCUMENT_POSITION_FOLLOWING : 4;
    for (const el of Array.from(main.querySelectorAll('p, div, span'))) {
      if (el.children && el.children.length > 2) continue;
      if (!(nameEl.compareDocumentPosition(el) & FOLLOWING)) continue;
      const t = clean(el.textContent);
      if (t.length >= 15 && t.length <= 220 && t !== target) {
        return t;
      }
    }
    return null;
  }, fullName).catch(() => null);
}

/**
 * Redacted diagnostic for the profile top-card DOM. Reports WHICH of the
 * existing headline/company selectors still match and the structural shape of
 * the top-card text lines — WITHOUT logging any names, headlines, company
 * names, URLs, or visible text. Per element it emits only: tag, up-to-2 class
 * tokens, text LENGTH, and booleans for company-ish aria-labels. Used to design
 * class-agnostic selectors when DOM extraction returns "Not Available" and the
 * OCR fallback would otherwise garble the data. Read-only.
 */
async function describeProfileDetailPage(page, selectors = {}) {
  if (!page || typeof page.evaluate !== 'function') {
    return { error: 'no-page' };
  }
  const headlineSelectors = Array.isArray(selectors.headline) ? selectors.headline : [];
  const companySelectors = Array.isArray(selectors.company) ? selectors.company : [];
  return page.evaluate((sel) => {
    const shape = (el) => {
      if (!el) return null;
      const cls = String(el.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      const aria = String(el.getAttribute && el.getAttribute('aria-label') || '');
      return {
        tag: el.tagName.toLowerCase(),
        cls,
        textLen: String(el.textContent || '').replace(/\s+/g, ' ').trim().length,
        ariaCompany: /company|current/i.test(aria)
      };
    };
    const testSelectors = (list) => list.map((s) => {
      let el = null;
      try { el = document.querySelector(s); } catch (_) { el = null; }
      return { selector: s, matched: !!el, textLen: el ? String(el.textContent || '').replace(/\s+/g, ' ').trim().length : 0 };
    });

    const main = document.querySelector('main');
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    // Anchor on the NAME heading using the same logic as the real extractor:
    // current LinkedIn puts the name in an <h2> (no <h1>), so an h1-only anchor
    // would leave cardLines empty exactly when the diagnostic is needed. Prefer
    // the heading whose text equals the resolved name, else the first short h1/h2.
    const headings = main ? Array.from(main.querySelectorAll('h1, h2')) : [];
    const targetName = clean(sel.name || '');
    let nameEl = null;
    if (targetName) nameEl = headings.find((h) => clean(h.textContent) === targetName) || null;
    if (!nameEl) nameEl = headings.find((h) => { const t = clean(h.textContent); return t && t.length <= 60; }) || null;
    // Walk up to the nearest <section> ancestor of the name — the top card.
    let card = nameEl;
    for (let i = 0; i < 6 && card && card.tagName.toLowerCase() !== 'section'; i++) card = card.parentElement;
    const cardEls = card ? Array.from(card.querySelectorAll('*')) : [];
    const lines = cardEls
      .filter((el) => {
        const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        return t.length > 0 && t.length < 140 && el.children.length <= 2;
      })
      .slice(0, 22)
      .map(shape);

    // Broader page signals to distinguish: not-loaded/degraded (tiny mainTextLen,
    // no headings) vs. content-present-but-restructured (large mainTextLen, lines
    // under non-h1 anchors). All redacted — counts + lengths only.
    const mainTextLen = main ? String(main.textContent || '').replace(/\s+/g, ' ').trim().length : 0;
    const mainShortLines = main
      ? Array.from(main.querySelectorAll('*'))
          .filter((el) => {
            const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            return t.length > 0 && t.length < 140 && el.children.length <= 2;
          })
          .slice(0, 18)
          .map(shape)
      : [];
    return {
      path: String((location && location.pathname) || '').slice(0, 80),
      hasMain: !!main,
      hasNameHeading: !!nameEl,
      nameHeadingTag: nameEl ? nameEl.tagName.toLowerCase() : null,
      cardTag: card ? card.tagName.toLowerCase() : null,
      mainTextLen,
      headingCounts: {
        h1: main ? main.querySelectorAll('h1').length : 0,
        h2: main ? main.querySelectorAll('h2').length : 0,
        h3: main ? main.querySelectorAll('h3').length : 0
      },
      ariaCount: main ? main.querySelectorAll('[aria-label]').length : 0,
      headlineSelectorMatchCount: testSelectors(sel.headline).filter((x) => x.matched).length,
      companySelectorMatchCount: testSelectors(sel.company).filter((x) => x.matched).length,
      cardLines: lines,
      mainShortLines
    };
  }, { headline: headlineSelectors, company: companySelectors, name: String(selectors.name || '') }).catch((e) => ({ error: String(e && e.message || e) }));
}

module.exports = {
  extractProfileDetails,
  extractEmailFromProfile,
  describeProfileDetailPage,
  parseCompanyFromHeadline,
  extractHeadlineClassAgnostic,
  findVisibleContactInfoHandle
};
