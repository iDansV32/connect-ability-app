#!/usr/bin/env node
// Test script: search LinkedIn for a title, visit the first real result,
// extract the person's name, and send a connection request to them.
//
// Exercises the connection-request fixes:
//   • candidate scoping (search-screenshot-like.js fix — main + result containers)
//   • clickConnectButton safety gate (request.js — refuses without targetName)
//   • dialog.js targetName threading (handleConnectionDialog/clickConnectInDropdown)
//
// Usage:
//   LINKEDIN_SEARCH_TERM="Head of People" node scripts/search-and-connect.js
//
// Optional env:
//   LINKEDIN_EMAIL      — required
//   PROFILE_INDEX       — pick a different candidate (default 0 = first)
//   CONNECTION_NOTE     — optional note text (default: none, just plain invite)
//   HEADLESS            — "true" runs headless (default visible so user can watch)

'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { loginToLinkedIn } = require('../automation/core/login');
const { setupFingerprinting } = require('../automation/core/fingerprinting');
const { humanLikeSearch } = require('../automation/search/search');
const { sendConnectionRequestDetailed } = require('../automation/connection/request');
const { getLinkedInSessionStatePath } = require('../automation/core/session-state');

const SEARCH_TERM = process.env.LINKEDIN_SEARCH_TERM || 'Head of People';
const PROFILE_INDEX = parseInt(process.env.PROFILE_INDEX || '0', 10);
const CONNECTION_NOTE = process.env.CONNECTION_NOTE || '';
const HEADLESS = (process.env.HEADLESS || 'false').toLowerCase() === 'true';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function getProfileUrlsFromSearchPage(page) {
  // Mirrors the fixed scoping from search-screenshot-like.js
  return page.evaluate(() => {
    const urls = new Set();
    const main = document.querySelector('main');
    if (!main) return [];
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

async function extractProfileName(page) {
  // Multi-strategy name extraction.
  return page.evaluate(() => {
    // 1) <title> tag is usually "Name | Headline | LinkedIn"
    const titleTag = (document.title || '').trim();
    if (titleTag) {
      const stripped = titleTag.replace(/\s*[|\-]\s*LinkedIn\s*$/i, '').trim();
      const parts = stripped.split(/\s*\|\s*/);
      if (parts.length >= 1 && parts[0].length > 2 && parts[0].length < 80) {
        const candidate = parts[0]
          .replace(/\s*\(.*?\)\s*/g, ' ')   // strip parentheticals like "(He/Him)"
          .replace(/\s+/g, ' ')
          .trim();
        if (candidate) return candidate;
      }
    }
    // 2) First h1/h2 with a plausible-name shape
    const candidates = Array.from(document.querySelectorAll('main h1, main h2'));
    for (const el of candidates) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 2 && t.length < 80 && !/notification/i.test(t)) {
        return t.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
    return null;
  });
}

async function main() {
  const email = process.env.LINKEDIN_EMAIL || '';
  const password = process.env.LINKEDIN_PASSWORD || '';
  if (!email) {
    throw new Error('LINKEDIN_EMAIL is required. Set it in the environment or .env.');
  }

  const sessionPath = getLinkedInSessionStatePath(email);
  if (!fs.existsSync(sessionPath)) {
    console.error(`No stored session for ${email} at ${sessionPath}. Log in via the app first.`);
    process.exit(1);
  }

  console.log(`\nSearching for "${SEARCH_TERM}" (picking index ${PROFILE_INDEX}, headless=${HEADLESS})\n`);

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: HEADLESS ? 0 : 40 });
  const context = await browser.newContext({
    storageState: sessionPath,
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  try {
    await setupFingerprinting(page);
    await loginToLinkedIn(page, email, password);

    const ok = await humanLikeSearch(page, SEARCH_TERM, {});
    if (!ok) throw new Error('Search failed');

    await sleep(jitter(2000, 3000));

    const urls = await getProfileUrlsFromSearchPage(page);
    console.log(`Search returned ${urls.length} real result candidates.`);
    if (urls.length === 0) throw new Error('No candidates found in search results');

    const target = urls[Math.min(PROFILE_INDEX, urls.length - 1)];
    console.log(`Target profile: ${target}`);

    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(jitter(2500, 4000));

    const recipientName = await extractProfileName(page);
    console.log(`Extracted name: ${recipientName || '(none)'}`);
    if (!recipientName) {
      throw new Error('Could not extract recipient name from profile — sendConnectionRequestDetailed would refuse without it (safety gate).');
    }

    console.log('\nSending connection request via sendConnectionRequestDetailed...\n');
    const result = await sendConnectionRequestDetailed(page, target, CONNECTION_NOTE, {
      recipientName,
      accountEmail: email,
      navigationMode: 'allow_direct_profile_navigation'
    });

    console.log('\n=== Result ===');
    console.log(JSON.stringify({
      profileUrl: target,
      recipientName,
      outcomeType: result.outcomeType,
      stepType: result.stepType,
      reason: result.reason,
      metadata: result.metadata,
      verificationResult: result.verificationResult
    }, null, 2));
  } finally {
    await sleep(2000);
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
