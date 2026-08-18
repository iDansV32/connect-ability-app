#!/usr/bin/env node
// Schedule a single LinkedIn post directly from the CLI.
//
// By DEFAULT this drives LinkedIn's real composer UI via Playwright, types
// the post, picks the date/time, clicks Schedule, and persists the LinkedIn
// resource key locally. The Connect Ability app's scheduler can also publish
// from the local store, so passing --local-only skips the browser flow and
// only persists to disk.
//
// Auto-picks the LinkedIn account when only one exists (or when
// linkedin-accounts.json has an activeAccountId).
//
// Usage — content sources (in priority order):
//   1. --content-file <path>     read post body from a file (best for multi-line)
//   2. stdin                     pipe body in: `cat post.txt | node scripts/schedule-post.js ...`
//   3. --content "..."           inline (single-line or shell-escaped multi-line)
//   4. POST_CONTENT env var      fallback
//
// Example (preferred for multi-line):
//   node scripts/schedule-post.js --content-file /tmp/draft.txt --date 2026-05-18 --time 09:00
//
// Optional flags:
//   --visibility public|connections|private   default: public
//   --agent <agentId>                         optional
//   --account <accountId>                     only needed if multiple accounts exist
//   --timezone <IANA tz>                      optional metadata
//   --local-only                              skip browser; just persist to local store
//   --visible                                 show the browser window (default: headless)
//                                             only use for debugging — typing the post
//                                             takes ~60–90s and a visible window is
//                                             easy to accidentally close/click into.
//
// Notes:
//  • Date must be YYYY-MM-DD, time must be HH:MM (24h).
//  • If multiple accounts exist and none specified, the script errors —
//    pass --account or set activeAccountId in linkedin-accounts.json.
//  • Post is appended; existing posts (this account + others) are preserved.
//  • If LinkedIn UI scheduling fails, the post is saved locally as pending
//    with the error in `linkedInSyncError`, exit code 2.

'use strict';

const fs = require('fs');
const path = require('path');
const ScheduledPostStore = require('../scheduled-post-store');
const {
  createId,
  getConnectAbilityAppStateDir,
  readJsonFile
} = require('../connect-documents');

// ---------- CLI / env parsing ----------

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

function pickValue(...candidates) {
  for (const value of candidates) {
    if (value === undefined || value === null) continue;
    const trimmed = String(value).trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function readStdinSync() {
  try {
    // stdin is a TTY when no pipe is attached — return null in that case.
    if (process.stdin.isTTY) return null;
    const chunk = fs.readFileSync(0, 'utf8');
    return chunk || null;
  } catch (_) {
    return null;
  }
}

function resolveContent({ flagContent, flagContentFile, envContent }) {
  // Priority: --content-file > stdin > --content > $POST_CONTENT
  if (flagContentFile) {
    let raw;
    try {
      raw = fs.readFileSync(flagContentFile, 'utf8');
    } catch (err) {
      fail(`Could not read --content-file "${flagContentFile}": ${err.message}`);
    }
    const trimmed = raw.replace(/^﻿/, '').trim();
    if (!trimmed) fail(`--content-file "${flagContentFile}" is empty.`);
    return trimmed;
  }

  const piped = readStdinSync();
  if (piped) {
    const trimmed = piped.replace(/^﻿/, '').trim();
    if (trimmed) return trimmed;
  }

  if (flagContent && String(flagContent).trim()) return String(flagContent).trim();
  if (envContent && String(envContent).trim()) return String(envContent).trim();
  return null;
}

function fail(message) {
  console.error(`schedule-post: ${message}`);
  process.exit(1);
}

// ---------- Account resolution ----------

function loadAccountsFile() {
  const accountsPath = path.join(getConnectAbilityAppStateDir(), 'linkedin-accounts.json');
  const data = readJsonFile(accountsPath, { accounts: [], activeAccountId: null });
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  return { accounts, activeAccountId: data.activeAccountId || null, accountsPath };
}

function resolveAccount({ accounts, activeAccountId, explicitAccountId }) {
  if (accounts.length === 0) {
    fail('No LinkedIn accounts found in linkedin-accounts.json. Add one via the app first.');
  }

  if (explicitAccountId) {
    const match = accounts.find((acc) => acc.id === explicitAccountId);
    if (!match) {
      fail(`Account "${explicitAccountId}" not found. Available: ${accounts.map((a) => a.id).join(', ')}`);
    }
    return match;
  }

  if (accounts.length === 1) {
    return accounts[0];
  }

  if (activeAccountId) {
    const match = accounts.find((acc) => acc.id === activeAccountId);
    if (match) return match;
  }

  fail(`Multiple accounts present and no --account specified. Available: ${accounts.map((a) => `${a.id} (${a.email})`).join(', ')}`);
  return null; // unreachable
}

// ---------- Validation ----------

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(`--date must be YYYY-MM-DD, got "${value}"`);
  }
}

function validateTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) {
    fail(`--time must be HH:MM (24h), got "${value}"`);
  }
}

function validateFuture(date, time) {
  const target = new Date(`${date}T${time}`);
  if (Number.isNaN(target.getTime())) {
    fail(`Could not parse scheduledDate + scheduledTime as a valid Date: ${date}T${time}`);
  }
  if (target.getTime() < Date.now() - 60_000) {
    console.warn(`schedule-post: warning — scheduled time ${date} ${time} is in the past. Continuing anyway.`);
  }
}

// ---------- LinkedIn DOM scheduling ----------

async function scheduleOnLinkedIn({ account, postConfig, headless, emitLog }) {
  // Lazy-require these so --local-only runs don't pull in Playwright.
  const { chromium } = require('playwright');
  const { loginToLinkedIn } = require('../automation/core/login');
  const { setupFingerprinting } = require('../automation/core/fingerprinting');
  const { getLinkedInSessionStatePath } = require('../automation/core/session-state');
  const { executePostOnPage } = require('../automation/posting/post-publisher');

  const sessionPath = getLinkedInSessionStatePath(account.email);
  if (!fs.existsSync(sessionPath)) {
    throw new Error(`No stored LinkedIn session for ${account.email} at ${sessionPath}. Log in via the app first.`);
  }

  const browser = await chromium.launch({ headless: Boolean(headless), slowMo: headless ? 0 : 50 });
  const context = await browser.newContext({
    storageState: sessionPath,
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();

  try {
    await setupFingerprinting(page);

    // Use stored session; password is only required if session is invalid.
    const password = process.env.LINKEDIN_PASSWORD || '';
    await loginToLinkedIn(page, account.email, password);

    const credentials = {
      email: account.email,
      password,
      name: account.name || ''
    };

    const result = await executePostOnPage(page, postConfig, credentials, emitLog);
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- Main ----------

async function main() {
  const args = parseArgs(process.argv);

  const content = resolveContent({
    flagContent: args.content,
    flagContentFile: args['content-file'],
    envContent: process.env.POST_CONTENT
  });
  const scheduledDate = pickValue(args.date, process.env.SCHEDULED_DATE);
  const scheduledTime = pickValue(args.time, process.env.SCHEDULED_TIME);
  const visibility = pickValue(args.visibility, process.env.POST_VISIBILITY) || 'public';
  const explicitAccountId = pickValue(args.account, process.env.LINKEDIN_ACCOUNT_ID);
  const agentId = pickValue(args.agent, process.env.AGENT_ID);
  const timezone = pickValue(args.timezone, process.env.POST_TIMEZONE);
  const localOnly = Boolean(args['local-only']);
  // Default to headless — typing the post takes ~60–90s during which a visible
  // browser is easy to close/click. Pass --visible to watch the flow.
  const headless = !args.visible;

  if (!content) fail('Missing content. Provide one of: --content-file <path>, piped stdin, --content "...", or POST_CONTENT env.');
  if (!scheduledDate) fail('Missing --date (or SCHEDULED_DATE env). Example: --date 2026-05-20');
  if (!scheduledTime) fail('Missing --time (or SCHEDULED_TIME env). Example: --time 09:00');

  validateDate(scheduledDate);
  validateTime(scheduledTime);
  validateFuture(scheduledDate, scheduledTime);

  const { accounts, activeAccountId } = loadAccountsFile();
  const account = resolveAccount({ accounts, activeAccountId, explicitAccountId });

  const newPostId = createId('post');
  const basePost = {
    id: newPostId,
    content,
    scheduledDate,
    scheduledTime,
    status: 'pending',
    visibility,
    postType: 'text',
    accountId: account.id,
    accountName: account.name || null,
    agentId: agentId || null,
    timezone: timezone || null,
    sourceType: 'cli'
  };

  // ── Path 1: --local-only — just persist to the store ──
  if (localOnly) {
    persistPost({ account, newPost: basePost });
    emitReceipt({ account, savedFinder: (p) => p.id === newPostId, schedulingResult: { mode: 'local-only' } });
    return;
  }

  // ── Path 2: default — drive LinkedIn UI, then persist with resourceKey ──
  console.error('schedule-post: launching browser to schedule on LinkedIn UI...');
  const postConfig = {
    content,
    scheduledDate,
    scheduledTime,
    visibilityType: visibility === 'connections' ? 'CONNECTIONS' : 'PUBLIC',
    immediate: false,
    includeImage: false,
    imagePath: null
  };

  const stderrLog = (entry) => {
    const msg = typeof entry === 'string' ? entry : (entry?.message || '');
    if (msg) console.error(`[linkedin] ${msg}`);
  };

  let schedulingResult;
  try {
    schedulingResult = await scheduleOnLinkedIn({ account, postConfig, headless, emitLog: stderrLog });
  } catch (err) {
    // Persist as pending with the error captured, exit non-zero.
    const persisted = persistPost({
      account,
      newPost: {
        ...basePost,
        status: 'pending',
        deliveryStrategy: 'local_queue',
        linkedInSyncError: err.message || String(err)
      }
    });
    console.log(JSON.stringify({
      ok: false,
      mode: 'fallback-local',
      error: err.message || String(err),
      account: { id: account.id, email: account.email },
      post: {
        id: persisted.id,
        scheduledDate: persisted.scheduledDate,
        scheduledTime: persisted.scheduledTime,
        status: persisted.status
      }
    }, null, 2));
    process.exit(2);
  }

  const outcome = String(schedulingResult?.outcome || '').trim();
  const succeeded = outcome === 'scheduled';
  const linkedInResourceKey = schedulingResult?.linkedInResourceKey || null;
  const linkedInScheduledAt = schedulingResult?.linkedInScheduledAt || null;

  const finalPost = succeeded
    ? {
        ...basePost,
        status: 'scheduled',
        deliveryStrategy: schedulingResult?.deliveryStrategy || 'linkedin_scheduled',
        linkedInResourceKey,
        linkedInScheduledAt,
        linkedInLastSyncedAt: new Date().toISOString(),
        linkedInSyncError: null
      }
    : {
        ...basePost,
        status: 'pending',
        deliveryStrategy: 'local_queue',
        linkedInSyncError: schedulingResult?.reason || `Unexpected outcome: ${outcome || 'unknown'}`
      };

  const persisted = persistPost({ account, newPost: finalPost });

  console.log(JSON.stringify({
    ok: succeeded,
    mode: succeeded ? 'linkedin-ui' : 'fallback-local',
    account: { id: account.id, name: account.name, email: account.email },
    post: {
      id: persisted.id,
      content: persisted.content,
      scheduledDate: persisted.scheduledDate,
      scheduledTime: persisted.scheduledTime,
      visibility: persisted.visibility,
      status: persisted.status,
      deliveryStrategy: persisted.deliveryStrategy,
      linkedInResourceKey: persisted.linkedInResourceKey,
      linkedInScheduledAt: persisted.linkedInScheduledAt,
      linkedInSyncError: persisted.linkedInSyncError
    }
  }, null, 2));

  if (!succeeded) process.exit(2);
}

// ---------- Persistence helper ----------

function persistPost({ account, newPost }) {
  const store = new ScheduledPostStore();
  const existing = store.getAllPosts({ accountId: account.id });
  const merged = [...existing, newPost];
  store.replacePostsForAccount(account.id, merged, { accountName: account.name || null });
  const final = store.getAllPosts({ accountId: account.id });
  return final.find((p) => p.id === newPost.id) || final[final.length - 1];
}

function emitReceipt({ account, savedFinder, schedulingResult }) {
  const store = new ScheduledPostStore();
  const final = store.getAllPosts({ accountId: account.id });
  const saved = final.find(savedFinder) || final[final.length - 1];
  console.log(JSON.stringify({
    ok: true,
    mode: schedulingResult.mode,
    account: { id: account.id, name: account.name, email: account.email },
    post: {
      id: saved.id,
      content: saved.content,
      scheduledDate: saved.scheduledDate,
      scheduledTime: saved.scheduledTime,
      visibility: saved.visibility,
      status: saved.status,
      createdAt: saved.createdAt
    },
    postsForThisAccount: final.length
  }, null, 2));
}

main().catch((err) => {
  console.error(`schedule-post: unexpected error: ${err.message || String(err)}`);
  process.exit(1);
});
