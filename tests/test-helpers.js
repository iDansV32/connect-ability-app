const fs = require('fs');
const os = require('os');
const path = require('path');

function createTempWorkspace(prefix = 'connect-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    root,
    path: (...segments) => path.join(root, ...segments),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeJsonLines(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = values.map((value) => JSON.stringify(value)).join('\n');
  fs.writeFileSync(filePath, payload ? `${payload}\n` : '');
}

module.exports = {
  createTempWorkspace,
  readJson,
  writeJson,
  writeJsonLines
};
