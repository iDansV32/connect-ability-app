const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function getUserHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

function getConnectAbilityDocumentsDir() {
  return path.join(getUserHomeDir(), 'Documents', 'Connect-Ability');
}

function getAppSupportRootDir() {
  const homeDir = getUserHomeDir();
  if (process.platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support');
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
  }
  return process.env.XDG_STATE_HOME || path.join(homeDir, '.local', 'state');
}

function getConnectAbilityAppStateDir() {
  const stateDir = path.join(getAppSupportRootDir(), 'Connect Ability');
  ensureDirectoryExists(stateDir);
  return stateDir;
}

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureParentDirectory(filePath) {
  ensureDirectoryExists(path.dirname(filePath));
}

function createTempPath(filePath) {
  const suffix = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return `${filePath}.${suffix}.tmp`;
}

function readJsonFile(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return cloneFallback(fallbackValue);
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return cloneFallback(fallbackValue);
    }
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`Failed to read JSON from ${filePath}: ${error.message}`);
    return cloneFallback(fallbackValue);
  }
}

function writeJsonFileAtomic(filePath, data, spacing = 2) {
  ensureParentDirectory(filePath);
  const tempPath = createTempPath(filePath);
  const payload = JSON.stringify(data, null, spacing);
  fs.writeFileSync(tempPath, payload, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function appendJsonLine(filePath, data) {
  ensureParentDirectory(filePath);
  const payload = `${JSON.stringify(data)}\n`;
  fs.writeFileSync(filePath, payload, { flag: 'a', mode: 0o600 });
}

function migrateFileIfNeeded(nextPath, legacyPath) {
  if (!nextPath || !legacyPath || nextPath === legacyPath) {
    return nextPath;
  }

  if (fs.existsSync(nextPath) || !fs.existsSync(legacyPath)) {
    return nextPath;
  }

  try {
    ensureParentDirectory(nextPath);
    fs.copyFileSync(legacyPath, nextPath);
  } catch (error) {
    console.warn(`Failed to migrate ${legacyPath} to ${nextPath}: ${error.message}`);
  }

  return nextPath;
}

function resolveInternalStatePath(fileName) {
  const safeName = String(fileName || '').trim();
  if (!safeName) {
    throw new Error('resolveInternalStatePath requires a file name');
  }

  const nextPath = path.join(getConnectAbilityAppStateDir(), safeName);
  const legacyPath = path.join(getConnectAbilityDocumentsDir(), safeName);
  return migrateFileIfNeeded(nextPath, legacyPath);
}

function createId(prefix = 'id') {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

function cloneFallback(value) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === 'object') return { ...value };
  return value;
}

module.exports = {
  appendJsonLine,
  createId,
  getConnectAbilityAppStateDir,
  ensureDirectoryExists,
  ensureParentDirectory,
  getConnectAbilityDocumentsDir,
  getUserHomeDir,
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
};
