const path = require('path');
const {
  createId,
  getConnectAbilityAppStateDir,
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('./connect-documents');

const STORE_VERSION = 1;
const ALLOWED_STATUSES = new Set(['active', 'paused', 'draft', 'archived']);

class SdrAgentManager {
  constructor(options = {}) {
    this.documentsDir = options.documentsDir || getConnectAbilityAppStateDir();
    this.storePath = options.storePath || resolveInternalStatePath('sdr-agents.json');
  }

  getAllAgents() {
    const store = this.readStore();
    return store.agents
      .map((agent) => this.normalizeExistingAgent(agent))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getAgent(agentId) {
    if (!agentId) return null;
    return this.getAllAgents().find((agent) => agent.id === agentId) || null;
  }

  saveAgent(agentInput = {}) {
    const store = this.readStore();
    const now = new Date().toISOString();
    const existingIndex = store.agents.findIndex((agent) => agent.id === agentInput.id);
    const existingAgent = existingIndex >= 0 ? store.agents[existingIndex] : null;
    const normalized = this.normalizeForSave(agentInput, existingAgent, now);

    if (existingIndex >= 0) {
      store.agents[existingIndex] = normalized;
    } else {
      store.agents.push(normalized);
    }

    writeJsonFileAtomic(this.storePath, store);
    return normalized;
  }

  deleteAgent(agentId) {
    if (!agentId) {
      return { deleted: false };
    }
    const store = this.readStore();
    const nextAgents = store.agents.filter((agent) => agent.id !== agentId);
    const deleted = nextAgents.length !== store.agents.length;
    if (deleted) {
      store.agents = nextAgents;
      writeJsonFileAtomic(this.storePath, store);
    }
    return { deleted };
  }

  readStore() {
    const fallback = { version: STORE_VERSION, agents: [] };
    const store = readJsonFile(this.storePath, fallback);
    return {
      version: STORE_VERSION,
      agents: Array.isArray(store.agents) ? store.agents : []
    };
  }

  normalizeExistingAgent(agent = {}) {
    return this.normalizeForSave(agent, agent, agent.updatedAt || new Date().toISOString());
  }

  normalizeForSave(agentInput = {}, existingAgent = null, now = new Date().toISOString()) {
    const name = cleanString(agentInput.name, 120);
    if (!name) {
      throw new Error('Agent name is required');
    }

    const accountId = cleanString(agentInput.accountId, 120) || null;
    const status = normalizeStatus(agentInput.status || existingAgent?.status || 'active');

    return {
      id: existingAgent?.id || cleanString(agentInput.id, 160) || createId('agent'),
      name,
      accountId,
      accountName: cleanString(agentInput.accountName, 160) || null,
      niche: cleanString(agentInput.niche, 240),
      personaTitles: normalizeStringList(agentInput.personaTitles, 30, 120),
      searchKeywords: normalizeStringList(agentInput.searchKeywords, 40, 120),
      connectionNoteTemplate: cleanString(agentInput.connectionNoteTemplate, 500),
      dmTemplatePrimary: cleanString(agentInput.dmTemplatePrimary, 1200),
      dmTemplateFollowUp: cleanString(agentInput.dmTemplateFollowUp, 1200),
      contentPillars: normalizeStringList(agentInput.contentPillars, 20, 120),
      postCadence: cleanString(agentInput.postCadence, 40) || 'daily',
      timezone: cleanString(agentInput.timezone, 80) || 'America/Chicago',
      notifications: {
        dmReplies: normalizeBoolean(agentInput.notifications?.dmReplies, existingAgent?.notifications?.dmReplies, true),
        workflowFailures: normalizeBoolean(agentInput.notifications?.workflowFailures, existingAgent?.notifications?.workflowFailures, true)
      },
      status,
      metadata: normalizeMetadata(agentInput.metadata, existingAgent?.metadata),
      createdAt: existingAgent?.createdAt || now,
      updatedAt: now
    };
  }
}

function normalizeStatus(status) {
  const normalized = cleanString(status, 40).toLowerCase() || 'active';
  return ALLOWED_STATUSES.has(normalized) ? normalized : 'active';
}

function normalizeStringList(value, maxItems, maxLength) {
  if (Array.isArray(value)) {
    return dedupeStrings(value, maxItems, maxLength);
  }
  if (typeof value === 'string') {
    return dedupeStrings(value.split(/[\n,]/g), maxItems, maxLength);
  }
  return [];
}

function dedupeStrings(values, maxItems, maxLength) {
  const seen = new Set();
  return values
    .map((value) => cleanString(value, maxLength))
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

function normalizeMetadata(value, fallback) {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? { ...candidate } : {};
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeBoolean(value, fallback, defaultValue) {
  if (typeof value === 'boolean') return value;
  if (typeof fallback === 'boolean') return fallback;
  return defaultValue;
}

module.exports = SdrAgentManager;
