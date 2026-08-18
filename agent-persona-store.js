'use strict';

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 64 * 1024; // 64 KB per persona file
const MAX_FILENAME_LENGTH = 80;

const STANDARD_FILES = ['soul.md', 'personality.md', 'writing-style.md', 'boundaries.md'];

class AgentPersonaStore {
  constructor(options = {}) {
    this.personasDir = options.personasDir || path.join(__dirname, 'personas');
  }

  static get STANDARD_FILES() {
    return STANDARD_FILES;
  }

  // ─── Status ──────────────────────────────────────────────────────────────────

  getStatus(agentId) {
    const id = requireAgentId(agentId);
    const existingFiles = this.listFiles(id);
    const missingFiles = STANDARD_FILES.filter((f) => !existingFiles.includes(f));
    return {
      hasPersona: existingFiles.length > 0,
      complete: missingFiles.length === 0,
      existingFiles,
      missingFiles,
      standardFiles: STANDARD_FILES
    };
  }

  // ─── List ─────────────────────────────────────────────────────────────────────

  listFiles(agentId) {
    const id = requireAgentId(agentId);
    const dir = this.agentDir(id);
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir)
        .filter((name) => name.endsWith('.md'))
        .sort();
    } catch (error) {
      console.warn(`[agent-persona-store] Failed to list ${dir}: ${error.message}`);
      return [];
    }
  }

  // ─── Read ─────────────────────────────────────────────────────────────────────

  readFile(agentId, fileName) {
    const id = requireAgentId(agentId);
    const name = sanitizeFileName(fileName);
    const filePath = path.join(this.agentDir(id), name);
    if (!fs.existsSync(filePath)) return null;
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      console.warn(`[agent-persona-store] Failed to read ${filePath}: ${error.message}`);
      return null;
    }
  }

  readAll(agentId) {
    const id = requireAgentId(agentId);
    const files = this.listFiles(id);
    const result = {};
    for (const name of files) {
      const content = this.readFile(id, name);
      if (content !== null) result[name] = content;
    }
    return result;
  }

  // ─── Write ────────────────────────────────────────────────────────────────────

  writeFile(agentId, fileName, content) {
    const id = requireAgentId(agentId);
    const name = sanitizeFileName(fileName);
    const text = String(content || '');

    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      throw new Error(`Persona file exceeds maximum size of ${MAX_FILE_BYTES / 1024} KB`);
    }

    const dir = this.agentDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, text, { encoding: 'utf8', mode: 0o644 });
    return { written: true, filePath };
  }

  // ─── Delete ───────────────────────────────────────────────────────────────────

  deleteFile(agentId, fileName) {
    const id = requireAgentId(agentId);
    const name = sanitizeFileName(fileName);
    const filePath = path.join(this.agentDir(id), name);
    if (!fs.existsSync(filePath)) return { deleted: false };
    try {
      fs.unlinkSync(filePath);
      return { deleted: true };
    } catch (error) {
      console.warn(`[agent-persona-store] Failed to delete ${filePath}: ${error.message}`);
      return { deleted: false };
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────────

  agentDir(agentId) {
    return path.join(this.personasDir, agentId);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireAgentId(agentId) {
  const id = String(agentId || '').trim();
  if (!id) throw new Error('agentId is required');
  return id;
}

function sanitizeFileName(fileName) {
  const raw = String(fileName || '').trim().slice(0, MAX_FILENAME_LENGTH);
  if (!raw) throw new Error('fileName is required');

  // Reject any path separators or traversal sequences upfront
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) {
    throw new Error(
      `Persona file name "${raw}" contains invalid characters. Use letters, numbers, hyphens, and underscores only.`
    );
  }

  // Must end with .md
  if (!raw.endsWith('.md')) {
    throw new Error(`Persona files must have a .md extension (got: ${raw})`);
  }

  // Allow alphanumeric, hyphens, underscores only in the stem
  const stem = raw.slice(0, -3);
  if (!/^[a-zA-Z0-9_-]+$/.test(stem)) {
    throw new Error(
      `Persona file name "${raw}" contains invalid characters. Use letters, numbers, hyphens, and underscores only.`
    );
  }

  return raw;
}

module.exports = AgentPersonaStore;
