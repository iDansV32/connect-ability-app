const {
  createId,
  getConnectAbilityAppStateDir,
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('./connect-documents');

const STORE_VERSION = 1;
const ALLOWED_BINDING_TARGET_TYPES = new Set(['agent', 'workflow', 'group']);
const ALLOWED_SYNC_STATUSES = new Set([
  'pending',
  'matched',
  'contact_created',
  'enrolled',
  'skipped',
  'failed',
  'dry_run'
]);

class ApolloSyncStore {
  constructor(options = {}) {
    this.documentsDir = options.documentsDir || getConnectAbilityAppStateDir();
    this.storePath = options.storePath || resolveInternalStatePath('apollo-sync.json');
  }

  getConfig() {
    return this.readStore().config;
  }

  saveConfig(configInput = {}) {
    const store = this.readStore();
    store.config = normalizeConfig(mergeDefined(store.config, configInput));
    writeJsonFileAtomic(this.storePath, store);
    return store.config;
  }

  listBindings(filters = {}) {
    const normalizedFilters = normalizeBindingFilters(filters);
    return this.readStore().bindings
      .map(normalizeBindingRecord)
      .filter((binding) => matchesBindingFilters(binding, normalizedFilters))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  getBinding(targetType = null, targetId = null) {
    const normalizedTargetType = normalizeBindingTargetType(targetType);
    const normalizedTargetId = cleanString(targetId, 160) || null;
    if (!normalizedTargetType || !normalizedTargetId) return null;
    return this.listBindings({
      targetType: normalizedTargetType,
      targetId: normalizedTargetId,
      enabled: true
    })[0] || null;
  }

  saveBinding(bindingInput = {}) {
    const now = new Date().toISOString();
    const store = this.readStore();
    const binding = normalizeBindingRecord(bindingInput, now);
    if (!binding) {
      throw new Error('Apollo binding requires targetType and targetId');
    }
    const existingIndex = findBindingIndex(store.bindings, binding);
    if (existingIndex >= 0) {
      const existing = normalizeBindingRecord(store.bindings[existingIndex], now);
      store.bindings[existingIndex] = {
        ...existing,
        ...binding,
        id: existing.id || binding.id,
        createdAt: existing.createdAt || binding.createdAt || now,
        updatedAt: now
      };
    } else {
      store.bindings.unshift(binding);
    }
    writeJsonFileAtomic(this.storePath, store);
    return normalizeBindingRecord(
      existingIndex >= 0 ? store.bindings[existingIndex] : store.bindings[0],
      now
    );
  }

  deleteBinding(bindingId = null) {
    const normalizedBindingId = cleanString(bindingId, 160) || null;
    if (!normalizedBindingId) return false;
    const store = this.readStore();
    const nextBindings = store.bindings.filter((binding) => {
      const normalized = normalizeBindingRecord(binding);
      return normalized ? normalized.id !== normalizedBindingId : false;
    });
    if (nextBindings.length === store.bindings.length) {
      return false;
    }
    store.bindings = nextBindings;
    writeJsonFileAtomic(this.storePath, store);
    return true;
  }

  listSyncRecords(filters = {}) {
    const normalizedFilters = normalizeRecordFilters(filters);
    return this.readStore().records
      .map(normalizeSyncRecord)
      .filter((record) => matchesRecordFilters(record, normalizedFilters))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
      .slice(0, normalizedFilters.limit);
  }

  getSyncRecord(prospectId = null, sequenceId = null) {
    const normalizedProspectId = cleanString(prospectId, 160) || null;
    const normalizedSequenceId = cleanString(sequenceId, 160) || null;
    if (!normalizedProspectId || !normalizedSequenceId) return null;
    return this.listSyncRecords({ prospectId: normalizedProspectId, sequenceId: normalizedSequenceId })[0] || null;
  }

  upsertSyncRecord(recordInput = {}) {
    const now = new Date().toISOString();
    const store = this.readStore();
    const record = normalizeSyncRecord(recordInput, now);
    if (!record.prospectId || !record.sequenceId) {
      throw new Error('Apollo sync record requires prospectId and sequenceId');
    }
    const existingIndex = findRecordIndex(store.records, record);
    if (existingIndex >= 0) {
      const existing = normalizeSyncRecord(store.records[existingIndex], now);
      store.records[existingIndex] = {
        ...existing,
        ...record,
        id: existing.id || record.id,
        createdAt: existing.createdAt || record.createdAt || now,
        updatedAt: now
      };
    } else {
      store.records.unshift(record);
    }
    writeJsonFileAtomic(this.storePath, store);
    return this.getSyncRecord(record.prospectId, record.sequenceId);
  }

  readStore() {
    const fallback = {
      version: STORE_VERSION,
      config: normalizeConfig({}),
      bindings: [],
      records: []
    };
    const store = readJsonFile(this.storePath, fallback);
    return {
      version: STORE_VERSION,
      config: normalizeConfig(store.config),
      bindings: Array.isArray(store.bindings) ? store.bindings : [],
      records: Array.isArray(store.records) ? store.records : []
    };
  }
}

function normalizeConfig(input = {}) {
  return {
    enabled: normalizeBoolean(input.enabled, true),
    defaultSequenceId: cleanString(input.defaultSequenceId, 160) || null,
    defaultSequenceName: cleanString(input.defaultSequenceName, 240) || null,
    defaultEmailAccountId: cleanString(input.defaultEmailAccountId, 160) || null,
    defaultEmailAccountLabel: cleanString(input.defaultEmailAccountLabel, 240) || null,
    updatedAt: cleanString(input.updatedAt, 80) || new Date().toISOString()
  };
}

function normalizeBindingRecord(binding = {}, now = new Date().toISOString()) {
  const targetType = normalizeBindingTargetType(binding.targetType);
  const targetId = cleanString(binding.targetId, 160) || null;
  if (!targetType || !targetId) {
    return null;
  }
  return {
    id: cleanString(binding.id, 160) || createId('apollo_binding'),
    targetType,
    targetId,
    targetName: cleanString(binding.targetName, 240) || null,
    sequenceId: cleanString(binding.sequenceId, 160) || null,
    sequenceName: cleanString(binding.sequenceName, 240) || null,
    emailAccountId: cleanString(binding.emailAccountId, 160) || null,
    enabled: normalizeBoolean(binding.enabled, true),
    createdAt: cleanString(binding.createdAt, 80) || now,
    updatedAt: cleanString(binding.updatedAt, 80) || now
  };
}

function normalizeSyncRecord(record = {}, now = new Date().toISOString()) {
  return {
    id: cleanString(record.id, 160) || createId('apollo_sync'),
    prospectId: cleanString(record.prospectId, 160) || null,
    accountId: cleanString(record.accountId, 120) || null,
    agentId: cleanString(record.agentId, 120) || null,
    workflowId: cleanString(record.workflowId, 160) || null,
    groupId: cleanString(record.groupId, 160) || null,
    targetType: normalizeBindingTargetType(record.targetType) || 'workflow',
    targetId: cleanString(record.targetId, 160) || null,
    targetName: cleanString(record.targetName, 240) || null,
    sequenceId: cleanString(record.sequenceId, 160) || null,
    sequenceName: cleanString(record.sequenceName, 240) || null,
    emailAccountId: cleanString(record.emailAccountId, 160) || null,
    status: normalizeSyncStatus(record.status),
    reason: cleanString(record.reason, 500) || null,
    apolloPersonId: cleanString(record.apolloPersonId, 160) || null,
    apolloContactId: cleanString(record.apolloContactId, 160) || null,
    apolloEmail: cleanString(record.apolloEmail, 240) || null,
    dryRun: normalizeBoolean(record.dryRun, false),
    metadata: normalizeMetadata(record.metadata),
    createdAt: cleanString(record.createdAt, 80) || now,
    updatedAt: cleanString(record.updatedAt, 80) || now,
    lastSyncedAt: cleanString(record.lastSyncedAt, 80) || null
  };
}

function findBindingIndex(bindings = [], binding = null) {
  if (!binding) return -1;
  return bindings.findIndex((candidate) => {
    const normalized = normalizeBindingRecord(candidate);
    if (!normalized) return false;
    if (binding.id && normalized.id === binding.id) return true;
    return normalized.targetType === binding.targetType && normalized.targetId === binding.targetId;
  });
}

function findRecordIndex(records = [], record = null) {
  if (!record) return -1;
  return records.findIndex((candidate) => {
    const normalized = normalizeSyncRecord(candidate);
    if (record.id && normalized.id === record.id) return true;
    return normalized.prospectId === record.prospectId && normalized.sequenceId === record.sequenceId;
  });
}

function normalizeBindingFilters(filters = {}) {
  return {
    targetType: normalizeBindingTargetType(filters.targetType),
    targetId: cleanString(filters.targetId, 160) || null,
    enabled: typeof filters.enabled === 'boolean' ? filters.enabled : null
  };
}

function normalizeRecordFilters(filters = {}) {
  return {
    prospectId: cleanString(filters.prospectId, 160) || null,
    accountId: cleanString(filters.accountId, 120) || null,
    sequenceId: cleanString(filters.sequenceId, 160) || null,
    status: normalizeSyncStatus(filters.status, true),
    targetType: normalizeBindingTargetType(filters.targetType),
    targetId: cleanString(filters.targetId, 160) || null,
    workflowId: cleanString(filters.workflowId, 160) || null,
    groupId: cleanString(filters.groupId, 160) || null,
    agentId: cleanString(filters.agentId, 120) || null,
    limit: Math.max(1, Math.min(500, Number(filters.limit) || 100))
  };
}

function matchesBindingFilters(binding, filters) {
  if (!binding) return false;
  if (filters.targetType && binding.targetType !== filters.targetType) return false;
  if (filters.targetId && binding.targetId !== filters.targetId) return false;
  if (filters.enabled !== null && binding.enabled !== filters.enabled) return false;
  return true;
}

function matchesRecordFilters(record, filters) {
  if (!record) return false;
  if (filters.prospectId && record.prospectId !== filters.prospectId) return false;
  if (filters.accountId && record.accountId !== filters.accountId) return false;
  if (filters.sequenceId && record.sequenceId !== filters.sequenceId) return false;
  if (filters.status && record.status !== filters.status) return false;
  if (filters.targetType && record.targetType !== filters.targetType) return false;
  if (filters.targetId && record.targetId !== filters.targetId) return false;
  if (filters.workflowId && record.workflowId !== filters.workflowId) return false;
  if (filters.groupId && record.groupId !== filters.groupId) return false;
  if (filters.agentId && record.agentId !== filters.agentId) return false;
  return true;
}

function normalizeBindingTargetType(value = null) {
  const normalized = cleanString(value, 40).toLowerCase();
  return ALLOWED_BINDING_TARGET_TYPES.has(normalized) ? normalized : null;
}

function normalizeSyncStatus(value = null, allowNull = false) {
  const normalized = cleanString(value, 40).toLowerCase();
  if (ALLOWED_SYNC_STATUSES.has(normalized)) {
    return normalized;
  }
  return allowNull ? null : 'pending';
}

function normalizeMetadata(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  const next = {};
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = cleanString(key, 120);
    if (!normalizedKey) continue;
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      next[normalizedKey] = value;
      continue;
    }
    if (Array.isArray(value)) {
      next[normalizedKey] = value
        .filter((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))
        .slice(0, 50);
      continue;
    }
    if (typeof value === 'object') {
      next[normalizedKey] = JSON.parse(JSON.stringify(value));
    }
  }
  return next;
}

function normalizeBoolean(value, fallbackValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return fallbackValue;
}

function cleanString(value, maxLength = 200) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function mergeDefined(base = {}, patch = {}) {
  const next = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

module.exports = ApolloSyncStore;
