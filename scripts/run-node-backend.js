#!/usr/bin/env node
'use strict';

/**
 * Run Node-only backends and tests with an ABI-specific native dependency
 * cache. This prevents `npm test` / MCP setup from rebuilding the Electron
 * copy of better-sqlite3 in the root node_modules tree.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REQUIRED_NODE_MAJOR = 24;
const DRIVER_PACKAGE = 'better-sqlite3';
const DRIVER_VERSION = require(path.join(PROJECT_ROOT, 'node_modules', DRIVER_PACKAGE, 'package.json')).version;

function inspectNode(nodeBinary) {
  if (!nodeBinary || !fs.existsSync(nodeBinary)) return null;
  const probe = spawnSync(nodeBinary, ['-p', 'JSON.stringify({version:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch})'], {
    encoding: 'utf8'
  });
  if (probe.status !== 0) return null;
  try {
    return { binary: nodeBinary, ...JSON.parse(String(probe.stdout || '').trim()) };
  } catch (_) {
    return null;
  }
}

function findNode24() {
  const candidates = [];
  if (process.env.CONNECT_NODE_BINARY) candidates.push(process.env.CONNECT_NODE_BINARY);
  if (Number(process.versions.node.split('.')[0]) === REQUIRED_NODE_MAJOR) candidates.push(process.execPath);
  if (process.env.NVM_BIN) candidates.push(path.join(process.env.NVM_BIN, 'node'));

  const nvmVersionsDir = path.join(process.env.NVM_DIR || path.join(os.homedir(), '.nvm'), 'versions', 'node');
  if (fs.existsSync(nvmVersionsDir)) {
    const versions = fs.readdirSync(nvmVersionsDir)
      .filter((name) => /^v24\./.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) candidates.push(path.join(nvmVersionsDir, version, 'bin', 'node'));
  }

  candidates.push('/opt/homebrew/opt/node@24/bin/node', '/usr/local/opt/node@24/bin/node');

  for (const candidate of [...new Set(candidates)]) {
    const info = inspectNode(candidate);
    if (info && Number(info.version.split('.')[0]) === REQUIRED_NODE_MAJOR) return info;
  }

  throw new Error(
    'Node 24 is required for Connect Ability backends. Install Node 24 or set CONNECT_NODE_BINARY to its executable.'
  );
}

function runtimeDirectory(nodeInfo) {
  return path.join(
    PROJECT_ROOT,
    '.runtime',
    `node-${nodeInfo.version}-abi-${nodeInfo.abi}-${nodeInfo.platform}-${nodeInfo.arch}`
  );
}

function driverWorks(nodeInfo, driverPath) {
  const probe = spawnSync(
    nodeInfo.binary,
    ['-e', 'const Database=require(process.argv[1]); const db=new Database(\":memory:\"); db.close();', driverPath],
    { encoding: 'utf8' }
  );
  return probe.status === 0;
}

function prepareNativeRuntime(nodeInfo) {
  const runtimeDir = runtimeDirectory(nodeInfo);
  const nativeModulesDir = path.join(runtimeDir, 'node_modules');
  const driverPath = path.join(nativeModulesDir, DRIVER_PACKAGE);
  if (driverWorks(nodeInfo, driverPath)) return nativeModulesDir;

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'package.json'), JSON.stringify({
    name: 'connect-ability-node-native-runtime',
    private: true,
    version: '1.0.0',
    dependencies: { [DRIVER_PACKAGE]: DRIVER_VERSION }
  }, null, 2) + '\n');

  const nodeBinDir = path.dirname(nodeInfo.binary);
  const npmBinary = process.platform === 'win32'
    ? path.join(nodeBinDir, 'npm.cmd')
    : path.join(nodeBinDir, 'npm');
  if (!fs.existsSync(npmBinary)) {
    throw new Error(`npm was not found beside Node 24 at ${npmBinary}`);
  }

  process.stderr.write(`[node-backend] Preparing ${DRIVER_PACKAGE} ${DRIVER_VERSION} for Node ${nodeInfo.version} (ABI ${nodeInfo.abi})\n`);
  const install = spawnSync(npmBinary, [
    'install',
    '--prefix', runtimeDir,
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--save-exact',
    `${DRIVER_PACKAGE}@${DRIVER_VERSION}`
  ], {
    stdio: 'inherit',
    env: { ...process.env, PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH || ''}` }
  });
  if (install.status !== 0 || !driverWorks(nodeInfo, driverPath)) {
    throw new Error(`Failed to prepare ${DRIVER_PACKAGE} for Node ${nodeInfo.version}`);
  }

  return nativeModulesDir;
}

function main() {
  const args = process.argv.slice(2);
  const separatorIndex = args.indexOf('--');
  const prepareOnly = args.includes('--prepare-only');
  const childArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];
  const nodeInfo = findNode24();
  const nativeModulesDir = prepareNativeRuntime(nodeInfo);

  if (prepareOnly) {
    process.stdout.write(`${nativeModulesDir}\n`);
    return;
  }
  if (childArgs.length === 0) {
    throw new Error('No Node command supplied. Put script arguments after `--`.');
  }

  const child = spawnSync(nodeInfo.binary, childArgs, {
    stdio: 'inherit',
    env: { ...process.env, CONNECT_NATIVE_MODULES_DIR: nativeModulesDir }
  });
  if (child.error) throw child.error;
  process.exitCode = child.status === null ? 1 : child.status;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[node-backend] ${error.message || String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  findNode24,
  inspectNode,
  prepareNativeRuntime,
  runtimeDirectory
};
