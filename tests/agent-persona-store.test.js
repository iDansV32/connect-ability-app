const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const AgentPersonaStore = require('../agent-persona-store');
const { createTempWorkspace } = require('./test-helpers');

test('AgentPersonaStore.getStatus returns hasPersona:false when no directory exists', () => {
  const workspace = createTempWorkspace('persona-status-fresh-');
  try {
    const store = new AgentPersonaStore({ personasDir: workspace.path('personas') });
    const status = store.getStatus('agent-001');
    assert.equal(status.hasPersona, false);
    assert.equal(status.complete, false);
    assert.deepEqual(status.existingFiles, []);
    assert.deepEqual(status.missingFiles, AgentPersonaStore.STANDARD_FILES);
    assert.deepEqual(status.standardFiles, AgentPersonaStore.STANDARD_FILES);
  } finally {
    workspace.cleanup();
  }
});

test('AgentPersonaStore.writeFile creates directory and file; listFiles returns it', () => {
  const workspace = createTempWorkspace('persona-write-');
  try {
    const store = new AgentPersonaStore({ personasDir: workspace.path('personas') });
    const result = store.writeFile('agent-001', 'soul.md', '# Soul\n\nWarm and direct.');
    assert.equal(result.written, true);
    assert.ok(result.filePath.endsWith('soul.md'));
    assert.ok(fs.existsSync(result.filePath));

    const files = store.listFiles('agent-001');
    assert.deepEqual(files, ['soul.md']);
  } finally {
    workspace.cleanup();
  }
});

test('AgentPersonaStore.readFile returns content after write; returns null for missing file', () => {
  const workspace = createTempWorkspace('persona-read-');
  try {
    const store = new AgentPersonaStore({ personasDir: workspace.path('personas') });
    store.writeFile('agent-abc', 'personality.md', '# Personality\n\nDirect and witty.');

    const content = store.readFile('agent-abc', 'personality.md');
    assert.equal(content, '# Personality\n\nDirect and witty.');

    const missing = store.readFile('agent-abc', 'soul.md');
    assert.equal(missing, null);
  } finally {
    workspace.cleanup();
  }
});

test('AgentPersonaStore.readAll returns object with all written files', () => {
  const workspace = createTempWorkspace('persona-readall-');
  try {
    const store = new AgentPersonaStore({ personasDir: workspace.path('personas') });
    store.writeFile('agent-x', 'soul.md', '# Soul\n\nPassionate.');
    store.writeFile('agent-x', 'writing-style.md', '# Writing\n\nShort sentences.');

    const all = store.readAll('agent-x');
    assert.equal(typeof all, 'object');
    assert.equal(Object.keys(all).length, 2);
    assert.equal(all['soul.md'], '# Soul\n\nPassionate.');
    assert.equal(all['writing-style.md'], '# Writing\n\nShort sentences.');
  } finally {
    workspace.cleanup();
  }
});

test('AgentPersonaStore.getStatus returns complete:true when all 4 standard files exist', () => {
  const workspace = createTempWorkspace('persona-complete-');
  try {
    const store = new AgentPersonaStore({ personasDir: workspace.path('personas') });
    const agentId = 'agent-full';
    for (const fileName of AgentPersonaStore.STANDARD_FILES) {
      store.writeFile(agentId, fileName, `# ${fileName}\n\nContent.`);
    }

    const status = store.getStatus(agentId);
    assert.equal(status.hasPersona, true);
    assert.equal(status.complete, true);
    assert.deepEqual(status.missingFiles, []);
    assert.equal(status.existingFiles.length, 4);
  } finally {
    workspace.cleanup();
  }
});

test('AgentPersonaStore sanitizeFileName rejects path traversal attempts', () => {
  const workspace = createTempWorkspace('persona-traversal-');
  try {
    const store = new AgentPersonaStore({ personasDir: workspace.path('personas') });
    assert.throws(
      () => store.writeFile('agent-001', '../../etc/passwd.md', 'evil'),
      /invalid characters/i
    );
    assert.throws(
      () => store.writeFile('agent-001', '../soul.md', 'evil'),
      /invalid characters/i
    );
  } finally {
    workspace.cleanup();
  }
});

test('AgentPersonaStore sanitizeFileName rejects non-.md extensions', () => {
  const workspace = createTempWorkspace('persona-extension-');
  try {
    const store = new AgentPersonaStore({ personasDir: workspace.path('personas') });
    assert.throws(
      () => store.writeFile('agent-001', 'soul.txt', 'content'),
      /\.md extension/i
    );
    assert.throws(
      () => store.writeFile('agent-001', 'soul', 'content'),
      /\.md extension/i
    );
  } finally {
    workspace.cleanup();
  }
});

test('AgentPersonaStore custom .md files are supported alongside standard files', () => {
  const workspace = createTempWorkspace('persona-custom-');
  try {
    const store = new AgentPersonaStore({ personasDir: workspace.path('personas') });
    const agentId = 'agent-custom';

    store.writeFile(agentId, 'soul.md', '# Soul');
    store.writeFile(agentId, 'objection-handling.md', '# Objections');
    store.writeFile(agentId, 'niche.md', '# Niche');

    const files = store.listFiles(agentId);
    assert.equal(files.length, 3);
    assert.ok(files.includes('niche.md'));
    assert.ok(files.includes('objection-handling.md'));
    assert.ok(files.includes('soul.md'));

    const status = store.getStatus(agentId);
    assert.equal(status.hasPersona, true);
    assert.equal(status.complete, false); // still missing personality, writing-style, boundaries
    assert.equal(status.missingFiles.length, 3);
  } finally {
    workspace.cleanup();
  }
});
