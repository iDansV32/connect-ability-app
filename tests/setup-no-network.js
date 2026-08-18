'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const playwright = require('playwright');

const BLOCKED_NETWORK_MESSAGE = 'Network access blocked in offline tests';
const BLOCKED_BROWSER_MESSAGE = 'Browser launch blocked in offline tests';

// Redirect HOME to a temp directory so tests that call storeProfileAction
// (via action-router → persistWorkflowProfileAction) write to a throwaway
// location instead of polluting ~/Documents/Connect-Ability/profiles.json.
const _testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-test-home-'));
process.env.HOME = _testHome;
process.env.USERPROFILE = _testHome;

const blockedFetch = async () => {
  throw new Error(BLOCKED_NETWORK_MESSAGE);
};

const blockedRequest = () => {
  throw new Error(BLOCKED_NETWORK_MESSAGE);
};

const blockedConnection = () => {
  throw new Error(BLOCKED_NETWORK_MESSAGE);
};

const blockedBrowserLaunch = () => {
  throw new Error(BLOCKED_BROWSER_MESSAGE);
};

globalThis.fetch = blockedFetch;
http.request = blockedRequest;
https.request = blockedRequest;
net.createConnection = blockedConnection;
playwright.chromium.launch = blockedBrowserLaunch;
playwright.chromium.launchPersistentContext = blockedBrowserLaunch;
