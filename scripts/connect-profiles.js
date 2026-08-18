#!/usr/bin/env node
// Send connection requests to a list of LinkedIn profiles in one browser
// session. Reuses the stored login for the single account, visits each
// profile, extracts the recipient name from the page, and calls
// sendConnectionRequestDetailed — which has the safety gate + targetName
// filter that prevents sidebar/wrong-person clicks.
//
// Input sources (in priority order):
//   1. --urls-file <path>       one URL per line (blank lines and `#` comments OK)
//   2. stdin                    one URL per line (piped in)
//   3. --urls "url1,url2,..."   comma-separated
//
// Usage examples:
//   # File-based (preferred for >2 URLs)
//   node scripts/connect-profiles.js --urls-file /tmp/connect-batch.txt
//
//   # Stdin
//   printf "https://www.linkedin.com/in/foo/\nhttps://www.linkedin.com/in/bar/\n" \
//     | node scripts/connect-profiles.js
//
//   # Inline
//   node scripts/connect-profiles.js --urls "https://www.linkedin.com/in/foo/,https://www.linkedin.com/in/bar/"
//
// Optional flags / env:
//   --note "..."                  optional invite note (max ~300 chars)
//   --account <accountId>         only needed if multiple accounts exist
//   --visible                     show browser (default: headless)
//   --min-delay <seconds>         min wait between profiles (default: 25)
//   --max-delay <seconds>         max wait between profiles (default: 75)
//   --max-profiles <N>            hard cap on profiles processed in one run
//   LINKEDIN_EMAIL                override the resolved account email
//
// Output: streams a JSONL receipt to stdout (one line per profile attempted),
// then a final summary line. Exit code 0 if every attempt completed/skipped
// cleanly; non-zero if any errored out unrecoverably.

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { loginToLinkedIn } = require('../automation/core/login');
const { setupFingerprinting } = require('../automation/core/fingerprinting');
const { sendConnectionRequestDetailed } = require('../automation/connection/request');
const { getLinkedInSessionStatePath } = require('../automation/core/session-state');
const {
  getConnectAbilityAppStateDir,
  readJsonFile
} = require('../connect-documents');

// ---------- CLI parsing (same shape as schedule-post.js) ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function fail(msg) {
  console.error(`connect-profiles: ${msg}`);
  process.exit(1);
}

function readStdinSync() {
  try {
    if (process.stdin.isTTY) return null;
    return fs.readFileSync(0, 'utf8') || null;
  } catch (_) { return null; }
}

function parseUrlList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
    .filter((s) => /linkedin\.com\/in\//i.test(s));
}

function resolveUrls(args) {
  if (args['urls-file']) {
    let raw;
    try { raw = fs.readFileSync(args['urls-file'], 'utf8'); }
    catch (err) { fail(`Could not read --urls-file: ${err.message}`); }
    return parseUrlList(raw);
  }
  const piped = readStdinSync();
  if (piped && piped.trim()) return parseUrlList(piped);
  if (args.urls) return parseUrlList(args.urls);
  return [];
}

// ---------- Account ----------

function loadAccountsFile() {
  const accountsPath = path.join(getConnectAbilityAppStateDir(), 'linkedin-accounts.json');
  const data = readJsonFile(accountsPath, { accounts: [], activeAccountId: null });
  return {
    accounts: Array.isArray(data.accounts) ? data.accounts : [],
    activeAccountId: data.activeAccountId || null
  };
}

function resolveAccount(explicit) {
  const { accounts, activeAccountId } = loadAccountsFile();
  if (accounts.length === 0) fail('No LinkedIn accounts found.');
  if (explicit) {
    const match = accounts.find((a) => a.id === explicit);
    if (!match) fail(`Account "${explicit}" not found.`);
    return match;
  }
  if (accounts.length === 1) return accounts[0];
  if (activeAccountId) {
    const match = accounts.find((a) => a.id === activeAccountId);
    if (match) return match;
  }
  fail(`Multiple accounts present, no --account specified.`);
  return null;
}

// ---------- Helpers ----------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function jitter(minSec, maxSec) {
  const min = Math.max(1, Number(minSec) || 1) * 1000;
  const max = Math.max(min, Number(maxSec) * 1000 || min);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function extractProfileName(page) {
  return page.evaluate(() => {
    const titleTag = (document.title || '').trim();
    if (titleTag) {
      const stripped = titleTag.replace(/\s*[|\-]\s*LinkedIn\s*$/i, '').trim();
      const parts = stripped.split(/\s*\|\s*/);
      if (parts.length >= 1 && parts[0].length > 2 && parts[0].length < 80) {
        return parts[0].replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
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

// ---------- Main ----------

async function main() {
  const args = parseArgs(process.argv);
  const urls = resolveUrls(args);
  if (urls.length === 0) {
    fail('No LinkedIn profile URLs found. Provide via --urls-file <path>, stdin, or --urls "u1,u2".');
  }

  const maxProfiles = args['max-profiles']
    ? Math.max(1, parseInt(args['max-profiles'], 10) || urls.length)
    : urls.length;
  const targets = urls.slice(0, maxProfiles);

  const minDelay = args['min-delay'] != null ? Number(args['min-delay']) : 25;
  const maxDelay = args['max-delay'] != null ? Number(args['max-delay']) : 75;
  const note = String(args.note || '').slice(0, 300);
  const visible = Boolean(args.visible);
  const account = resolveAccount(args.account);
  const email = process.env.LINKEDIN_EMAIL || account.email;
  const password = process.env.LINKEDIN_PASSWORD || '';

  const sessionPath = getLinkedInSessionStatePath(email);
  if (!fs.existsSync(sessionPath)) fail(`No stored session for ${email}.`);

  console.error(`connect-profiles: starting (${targets.length} target${targets.length === 1 ? '' : 's'}, account=${email}, visible=${visible})`);

  const browser = await chromium.launch({ headless: !visible, slowMo: visible ? 40 : 0 });
  const context = await browser.newContext({
    storageState: sessionPath,
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  const results = [];
  let hadError = false;

  try {
    await setupFingerprinting(page);
    await loginToLinkedIn(page, email, password);

    for (let i = 0; i < targets.length; i += 1) {
      const url = targets[i];
      const entry = { index: i + 1, profileUrl: url, recipientName: null, outcomeType: null, reason: null, error: null };

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(jitter(2, 4));

        const recipientName = await extractProfileName(page);
        entry.recipientName = recipientName;
        if (!recipientName) {
          entry.outcomeType = 'skipped_name_missing';
          entry.reason = 'Could not extract recipient name from profile DOM';
          console.log(JSON.stringify(entry));
          continue;
        }

        const result = await sendConnectionRequestDetailed(page, url, note, {
          recipientName,
          accountEmail: email,
          navigationMode: 'allow_direct_profile_navigation'
        });
        entry.outcomeType = result.outcomeType || null;
        entry.reason = result.reason || null;
      } catch (err) {
        entry.error = err.message || String(err);
        hadError = true;
      }

      results.push(entry);
      console.log(JSON.stringify(entry));

      // Random pause before next profile (skip for the last one).
      if (i < targets.length - 1) {
        const waitMs = jitter(minDelay, maxDelay);
        console.error(`connect-profiles: sleeping ${(waitMs / 1000).toFixed(0)}s before next profile…`);
        await sleep(waitMs);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const summary = {
    summary: true,
    attempted: results.length,
    completed: results.filter((r) => r.outcomeType === 'completed').length,
    alreadyConnected: results.filter((r) => r.outcomeType === 'skipped_already_connected').length,
    invitePending: results.filter((r) => r.outcomeType === 'skipped_invite_pending').length,
    quotaExceeded: results.filter((r) => r.outcomeType === 'skipped_quota_exceeded').length,
    nameMissing: results.filter((r) => r.outcomeType === 'skipped_name_missing').length,
    errored: results.filter((r) => r.error).length
  };
  console.log(JSON.stringify(summary));

  if (hadError) process.exit(2);
}

main().catch((err) => {
  console.error(`connect-profiles: fatal: ${err.message || String(err)}`);
  process.exit(1);
});
