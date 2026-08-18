#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const packageJson = require('../package.json');

const DEFAULT_APP_CANDIDATES = [
  process.env.CONNECT_ABILITY_APP_PATH,
  '/Applications/Connect Ability.app',
  path.join(process.cwd(), 'dist', 'mac-arm64', 'Connect Ability.app')
].filter(Boolean);

const REQUIRED_MARKERS = [
  'export-activity-report',
  'export-diagnostics-report',
  'get-linkedin-account-health',
  'Export Diagnostics',
  'Workflow cooldown',
  'correlationAnyId'
];

const FORBIDDEN_MARKERS = [
  'probe-linkedin-full-round.js',
  'validate-linkedin-private-dry-run.js',
  'smoke-installed-app.js',
  'tests/runtime-log-store.test.js',
  'LINKEDIN_PRIVATE_API_NOTES.md'
];

function main() {
  const requireSigning = process.argv.includes('--require-signing');
  const appPath = resolveAppPath();
  const appName = path.basename(appPath);
  const contentsDir = path.join(appPath, 'Contents');
  const plistPath = path.join(contentsDir, 'Info.plist');
  const asarPath = path.join(contentsDir, 'Resources', 'app.asar');
  const executablePath = path.join(contentsDir, 'MacOS', packageJson.productName);

  const failures = [];
  const warnings = [];
  const passes = [];

  check(fs.existsSync(appPath), `App bundle exists at ${appPath}`, failures, passes);
  check(fs.existsSync(plistPath), `Info.plist exists for ${appName}`, failures, passes);
  check(fs.existsSync(asarPath), 'app.asar exists in installed bundle', failures, passes);
  check(fs.existsSync(executablePath), 'App executable exists in installed bundle', failures, passes);

  const bundleId = readPlistValue(plistPath, 'CFBundleIdentifier');
  const version = readPlistValue(plistPath, 'CFBundleShortVersionString');
  check(bundleId === packageJson.build.appId, `Bundle identifier matches ${packageJson.build.appId}`, failures, passes, `found "${bundleId || 'missing'}"`);
  check(version === packageJson.version, `Bundle version matches ${packageJson.version}`, failures, passes, `found "${version || 'missing'}"`);

  const stringsOutput = readStrings(asarPath);
  REQUIRED_MARKERS.forEach((marker) => {
    check(stringsOutput.includes(marker), `Packaged bundle contains marker "${marker}"`, failures, passes);
  });
  FORBIDDEN_MARKERS.forEach((marker) => {
    check(!stringsOutput.includes(marker), `Packaged bundle excludes dev artifact marker "${marker}"`, failures, passes);
  });

  const codesign = spawnSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    encoding: 'utf8'
  });
  if (codesign.status === 0) {
    passes.push('Code signing verification passed');
  } else if (requireSigning) {
    failures.push(`Code signing verification failed: ${firstNonEmptyLine(codesign.stderr) || firstNonEmptyLine(codesign.stdout) || 'unknown error'}`);
  } else {
    warnings.push(`Code signing verification skipped for release gate: ${firstNonEmptyLine(codesign.stderr) || firstNonEmptyLine(codesign.stdout) || 'unsigned app'}`);
  }

  passes.forEach((message) => console.log(`PASS  ${message}`));
  warnings.forEach((message) => console.warn(`WARN  ${message}`));
  failures.forEach((message) => console.error(`FAIL  ${message}`));

  if (failures.length) {
    console.error(`Smoke check failed for ${appPath}`);
    process.exit(1);
  }

  console.log(`Smoke check passed for ${appPath}`);
}

function resolveAppPath() {
  const explicitArg = process.argv.find((value, index) => index > 1 && !value.startsWith('--'));
  if (explicitArg) {
    return path.resolve(explicitArg);
  }

  const found = DEFAULT_APP_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    console.error('Could not find Connect Ability.app in default locations.');
    process.exit(1);
  }
  return found;
}

function readPlistValue(plistPath, key) {
  const result = spawnSync('plutil', ['-extract', key, 'raw', plistPath], {
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    return null;
  }
  return String(result.stdout || '').trim() || null;
}

function readStrings(filePath) {
  const result = spawnSync('strings', [filePath], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024
  });
  if (result.status !== 0) {
    console.error(`Failed to read strings from ${filePath}: ${firstNonEmptyLine(result.stderr) || 'unknown error'}`);
    process.exit(1);
  }
  return String(result.stdout || '');
}

function check(condition, successMessage, failures, passes, failureDetail = null) {
  if (condition) {
    passes.push(successMessage);
    return;
  }
  failures.push(failureDetail ? `${successMessage} (${failureDetail})` : successMessage);
}

function firstNonEmptyLine(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || null;
}

main();
