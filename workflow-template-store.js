const fs = require('fs');
const path = require('path');
const {
  createId,
  getConnectAbilityDocumentsDir,
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('./connect-documents');

const STORE_VERSION = 1;
const DEFAULT_STORE = {
  version: STORE_VERSION,
  templates: []
};

const ALLOWED_TEMPLATE_KINDS = new Set(['legacy', 'automation']);
const ALLOWED_AUTOMATION_TARGET_TYPES = new Set(['group', 'profiles', 'manual']);
const ALLOWED_AUTOMATION_STEP_TYPES = new Set(['view_profile', 'like_posts', 'send_connection', 'send_dm', 'delay']);

class WorkflowTemplateStore {
  constructor(options = {}) {
    this.storePath = options.storePath || resolveInternalStatePath('workflow-templates.json');
    this.legacyWorkflowsDir = options.legacyWorkflowsDir || path.join(getConnectAbilityDocumentsDir(), 'workflows');
  }

  getAllTemplates(options = {}) {
    const kind = cleanString(options.kind, 40).toLowerCase() || null;
    const store = this.loadStore();
    const templates = Array.isArray(store.templates) ? store.templates : [];
    return templates
      .filter((template) => !kind || template.kind === kind)
      .map(cloneJson)
      .sort(sortByUpdatedAtDesc);
  }

  getTemplate(templateId) {
    const id = cleanString(templateId, 160);
    if (!id) return null;
    return this.getAllTemplates().find((template) => template.id === id) || null;
  }

  getLegacyWorkflow(workflowId) {
    const template = this.getTemplate(workflowId);
    if (!template || template.kind !== 'legacy') {
      return null;
    }
    return toLegacyWorkflowView(template);
  }

  getLegacyWorkflows() {
    return this.getAllTemplates({ kind: 'legacy' }).map(toLegacyWorkflowView);
  }

  getAutomationWorkflows() {
    return this.getAllTemplates({ kind: 'automation' }).map(toAutomationWorkflowView);
  }

  saveLegacyWorkflow(workflowInput = {}) {
    return toLegacyWorkflowView(this.saveTemplateRecord({
      ...workflowInput,
      kind: 'legacy'
    }));
  }

  saveAutomationWorkflow(workflowInput = {}) {
    return toAutomationWorkflowView(this.saveTemplateRecord({
      ...workflowInput,
      kind: 'automation'
    }));
  }

  updateLegacyWorkflow(workflowId, updates) {
    const existing = this.getLegacyWorkflow(workflowId);
    if (!existing) return null;
    const next = typeof updates === 'function' ? updates(existing) : { ...existing, ...(updates || {}) };
    return this.saveLegacyWorkflow({
      ...existing,
      ...next,
      id: existing.id
    });
  }

  updateAutomationWorkflow(workflowId, updates) {
    const existing = this.getTemplate(workflowId);
    if (!existing || existing.kind !== 'automation') return null;
    const next = typeof updates === 'function' ? updates(existing) : { ...existing, ...(updates || {}) };
    return this.saveAutomationWorkflow({
      ...existing,
      ...next,
      id: existing.id
    });
  }

  deleteWorkflow(workflowId) {
    const id = cleanString(workflowId, 160);
    if (!id) return null;
    const store = this.loadStore();
    const existing = store.templates.find((template) => template.id === id) || null;
    if (!existing) {
      return null;
    }

    store.templates = store.templates.filter((template) => template.id !== id);
    this.writeStore(store);
    return cloneJson(existing);
  }

  addProfilesToLegacyWorkflow(workflowId, profileIds = []) {
    return this.updateLegacyWorkflow(workflowId, (existing) => {
      const mergedIds = uniqueStringArray([...(existing.profileIds || []), ...profileIds], 5000, 400);
      return {
        ...existing,
        profileIds: mergedIds,
        progress: {
          ...(existing.progress || {}),
          total: mergedIds.length
        }
      };
    });
  }

  loadStore() {
    const store = normalizeStore(readJsonFile(this.storePath, DEFAULT_STORE));
    const migrated = this.importLegacyFiles(store);
    if (migrated.changed) {
      this.writeStore(migrated.store);
      return migrated.store;
    }
    return store;
  }

  saveTemplateRecord(templateInput = {}) {
    const store = this.loadStore();
    const existing = store.templates.find((template) => template.id === cleanString(templateInput.id, 160)) || null;
    const normalized = normalizeTemplateRecord(templateInput, existing);
    if (!normalized) {
      throw new Error('Workflow template is invalid');
    }

    const nextTemplates = existing
      ? store.templates.map((template) => template.id === normalized.id ? normalized : template)
      : [normalized, ...store.templates];

    const nextStore = normalizeStore({
      ...store,
      templates: nextTemplates
    });
    this.writeStore(nextStore);
    return cloneJson(normalized);
  }

  importLegacyFiles(storeInput) {
    const store = normalizeStore(storeInput);
    if (!fs.existsSync(this.legacyWorkflowsDir)) {
      return { changed: false, store };
    }

    const existingIds = new Set(store.templates.map((template) => template.id));
    let changed = false;

    const fileNames = fs.readdirSync(this.legacyWorkflowsDir)
      .filter((fileName) => fileName.endsWith('.json'))
      .sort();

    for (const fileName of fileNames) {
      const filePath = path.join(this.legacyWorkflowsDir, fileName);
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const normalized = normalizeTemplateRecord({
          ...raw,
          kind: detectWorkflowKind(raw),
          id: raw.id || fileName.replace(/\.json$/i, '')
        });
        if (!normalized || existingIds.has(normalized.id)) {
          continue;
        }
        store.templates.push(normalized);
        existingIds.add(normalized.id);
        changed = true;
      } catch (error) {
        console.warn(`Failed to migrate legacy workflow file ${filePath}: ${error.message}`);
      }
    }

    return {
      changed,
      store: normalizeStore(store)
    };
  }

  writeStore(storeInput) {
    writeJsonFileAtomic(this.storePath, normalizeStore(storeInput));
  }
}

function normalizeStore(storeInput = DEFAULT_STORE) {
  const templates = Array.isArray(storeInput?.templates)
    ? storeInput.templates.map((template) => normalizeTemplateRecord(template)).filter(Boolean)
    : [];

  return {
    version: STORE_VERSION,
    templates
  };
}

function normalizeTemplateRecord(templateInput = {}, existing = null) {
  if (!templateInput || typeof templateInput !== 'object' || Array.isArray(templateInput)) {
    return null;
  }

  const kind = cleanString(templateInput.kind || existing?.kind, 40).toLowerCase();
  if (!ALLOWED_TEMPLATE_KINDS.has(kind)) {
    return null;
  }

  if (kind === 'legacy') {
    return normalizeLegacyWorkflowRecord(templateInput, existing);
  }

  return normalizeAutomationWorkflowRecord(templateInput, existing);
}

function normalizeLegacyWorkflowRecord(templateInput = {}, existing = null) {
  const now = new Date().toISOString();
  const profileIds = uniqueStringArray(
    Array.isArray(templateInput.profileIds) ? templateInput.profileIds : (existing?.profileIds || []),
    5000,
    400
  );
  const name = cleanString(templateInput.name || existing?.name, 160) || 'Untitled Workflow';
  const progressCompleted = sanitizeNonNegativeInteger(
    templateInput.progress?.completed,
    existing?.progress?.completed || 0
  );
  const progressTotal = sanitizeNonNegativeInteger(
    templateInput.progress?.total,
    profileIds.length
  );

  return {
    id: cleanString(templateInput.id || existing?.id, 160) || createId('wf'),
    kind: 'legacy',
    name,
    description: cleanMultiline(templateInput.description || existing?.description, 1000),
    profileIds,
    actions: normalizeLegacyActions(templateInput.actions || existing?.actions),
    settings: normalizePlainObject(templateInput.settings || existing?.settings),
    status: cleanString(templateInput.status || existing?.status, 40) || 'pending',
    progress: {
      completed: Math.min(progressCompleted, Math.max(progressTotal, profileIds.length)),
      total: Math.max(progressTotal, profileIds.length)
    },
    createdAt: normalizeOptionalIsoDate(
      templateInput.createdAt || templateInput.created || existing?.createdAt || existing?.created,
      now
    ),
    updatedAt: now,
    lastRunAt: normalizeOptionalIsoDate(
      templateInput.lastRunAt || templateInput.lastRun || existing?.lastRunAt || existing?.lastRun,
      null
    ),
    startedAt: normalizeOptionalIsoDate(templateInput.startedAt || existing?.startedAt, null),
    completedAt: normalizeOptionalIsoDate(templateInput.completedAt || existing?.completedAt, null),
    pausedAt: normalizeOptionalIsoDate(templateInput.pausedAt || templateInput.paused || existing?.pausedAt || existing?.paused, null)
  };
}

function normalizeAutomationWorkflowRecord(templateInput = {}, existing = null) {
  const now = new Date().toISOString();
  const target = normalizeAutomationTarget(templateInput.target || existing?.target);
  const steps = Array.isArray(templateInput.steps)
    ? templateInput.steps.map((step) => normalizeAutomationStep(step)).filter(Boolean)
    : (Array.isArray(existing?.steps) ? existing.steps.map((step) => normalizeAutomationStep(step)).filter(Boolean) : []);

  return {
    id: cleanString(templateInput.id || existing?.id, 160) || createId('wf'),
    kind: 'automation',
    name: cleanString(templateInput.name || existing?.name, 160) || buildAutomationWorkflowName(target),
    description: cleanMultiline(templateInput.description || existing?.description, 2000),
    agentId: cleanString(templateInput.agentId || existing?.agentId, 160) || null,
    target,
    steps,
    headless: typeof templateInput.headless === 'boolean'
      ? templateInput.headless
      : Boolean(existing?.headless),
    status: cleanString(templateInput.status || existing?.status, 40) || 'draft',
    createdAt: normalizeOptionalIsoDate(templateInput.createdAt || existing?.createdAt, now),
    updatedAt: now,
    lastRunAt: normalizeOptionalIsoDate(templateInput.lastRunAt || existing?.lastRunAt, existing?.lastRunAt || null)
  };
}

function normalizeAutomationTarget(targetInput = {}) {
  if (!targetInput || typeof targetInput !== 'object' || Array.isArray(targetInput)) {
    return {
      type: 'group',
      label: 'No target selected',
      groupId: null,
      members: []
    };
  }

  const type = cleanString(targetInput.type, 40).toLowerCase();
  const normalizedType = ALLOWED_AUTOMATION_TARGET_TYPES.has(type) ? type : 'group';
  const label = cleanString(targetInput.label || targetInput.name, 200) || buildAutomationTargetLabel(normalizedType, targetInput);

  if (normalizedType === 'profiles') {
    const profileUrls = uniqueStringArray(targetInput.profileUrls, 5000, 400);
    return {
      type: normalizedType,
      label: label || `Stored Profiles (${profileUrls.length})`,
      profileUrls
    };
  }

  if (normalizedType === 'manual') {
    const names = uniqueStringArray(targetInput.names, 5000, 240);
    return {
      type: normalizedType,
      label: label || `Manual Names (${names.length})`,
      names
    };
  }

  return {
    type: 'group',
    label,
    groupId: cleanString(targetInput.groupId || targetInput.id, 160) || null,
    members: uniqueStringArray(targetInput.members, 5000, 400)
  };
}

function normalizeAutomationStep(stepInput = {}) {
  if (!stepInput || typeof stepInput !== 'object' || Array.isArray(stepInput)) {
    return null;
  }

  const type = cleanString(stepInput.type, 64).toLowerCase();
  if (!ALLOWED_AUTOMATION_STEP_TYPES.has(type)) {
    return null;
  }

  return {
    order: sanitizeNonNegativeInteger(stepInput.order, 0) || null,
    type,
    delayValue: sanitizeNonNegativeInteger(stepInput.delayValue ?? stepInput.delayAmount, 1) || 1,
    delayAmount: sanitizeNonNegativeInteger(stepInput.delayAmount ?? stepInput.delayValue, 1) || 1,
    delayUnit: cleanString(stepInput.delayUnit, 16).toLowerCase() || 'hours',
    minDelayMs: sanitizeNonNegativeInteger(stepInput.minDelayMs, type === 'delay' ? 60 * 60 * 1000 : 8000),
    maxDelayMs: sanitizeNonNegativeInteger(stepInput.maxDelayMs, type === 'delay'
      ? sanitizeNonNegativeInteger(stepInput.minDelayMs, 60 * 60 * 1000)
      : 18000),
    messageTemplate: cleanMultiline(stepInput.messageTemplate, 1600)
  };
}

function normalizeLegacyActions(actionsInput = {}) {
  return {
    viewProfile: Boolean(actionsInput?.viewProfile),
    likePosts: Boolean(actionsInput?.likePosts),
    sendConnection: Boolean(actionsInput?.sendConnection),
    sendDm: Boolean(actionsInput?.sendDm)
  };
}

function normalizePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return cloneJson(value);
}

function toLegacyWorkflowView(template) {
  return {
    id: template.id,
    kind: 'legacy',
    name: template.name,
    description: template.description,
    profileIds: [...(template.profileIds || [])],
    actions: normalizeLegacyActions(template.actions),
    settings: normalizePlainObject(template.settings),
    status: template.status,
    progress: {
      ...(template.progress || { completed: 0, total: template.profileIds?.length || 0 })
    },
    created: template.createdAt,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    lastRun: template.lastRunAt,
    lastRunAt: template.lastRunAt,
    startedAt: template.startedAt || null,
    completedAt: template.completedAt || null,
    pausedAt: template.pausedAt || null
  };
}

function toAutomationWorkflowView(template) {
  return cloneJson(template);
}

function detectWorkflowKind(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.kind && ALLOWED_TEMPLATE_KINDS.has(String(raw.kind).trim().toLowerCase())) {
      return String(raw.kind).trim().toLowerCase();
    }
    if (raw.target || Array.isArray(raw.steps)) {
      return 'automation';
    }
  }
  return 'legacy';
}

function buildAutomationWorkflowName(target) {
  if (!target) return 'New Workflow';
  if (target.type === 'group') return `${target.label || 'Group'} Workflow`;
  if (target.type === 'profiles') return `Profile Workflow (${(target.profileUrls || []).length})`;
  if (target.type === 'manual') return `Manual Name Workflow (${(target.names || []).length})`;
  return 'New Workflow';
}

function buildAutomationTargetLabel(type, targetInput) {
  if (type === 'profiles') {
    return `Stored Profiles (${uniqueStringArray(targetInput?.profileUrls, 5000, 400).length})`;
  }
  if (type === 'manual') {
    return `Manual Names (${uniqueStringArray(targetInput?.names, 5000, 240).length})`;
  }
  return cleanString(targetInput?.label || targetInput?.name, 200) || 'Group Target';
}

function sortByUpdatedAtDesc(left, right) {
  return Date.parse(right.updatedAt || right.createdAt || 0) - Date.parse(left.updatedAt || left.createdAt || 0);
}

function uniqueStringArray(value, maxItems, maxLength) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  const normalized = [];
  for (const entry of value) {
    const text = cleanString(entry, maxLength);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(text);
    if (normalized.length >= maxItems) {
      break;
    }
  }
  return normalized;
}

function sanitizeNonNegativeInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeOptionalIsoDate(value, fallback = null) {
  const text = cleanString(value, 80);
  if (!text) {
    return fallback;
  }
  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) {
    return fallback;
  }
  return new Date(timestamp).toISOString();
}

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanMultiline(value, maxLength) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\0/g, '')
    .trim()
    .slice(0, maxLength);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Merge a partial legacy-workflow update onto an existing workflow record.
 * Pure (no I/O). Null-guarded: a null / array / non-object `actions` or
 * `settings` in the partial must NOT clobber the existing value — the malformed
 * field is ignored and the existing value is preserved. A valid object partial
 * is deep-merged onto the existing object so omitted keys are kept.
 *
 * Returns the merged record (id and other top-level fields preserved); the
 * caller is responsible for sanitizing the result before persisting.
 */
function mergeLegacyWorkflowUpdate(existingWorkflow, updates) {
  if (!existingWorkflow || typeof existingWorkflow !== 'object' || Array.isArray(existingWorkflow)) {
    throw new Error('Existing workflow is required');
  }
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('Workflow update payload must be an object');
  }

  const isPlainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const merged = { ...existingWorkflow, ...updates };

  // Identity is immutable across an update: a stray `updates.id` must never
  // change which workflow this is. Force the existing id back over the spread.
  merged.id = existingWorkflow.id;

  if ('actions' in updates) {
    merged.actions = isPlainObject(updates.actions)
      ? { ...(isPlainObject(existingWorkflow.actions) ? existingWorkflow.actions : {}), ...updates.actions }
      : (existingWorkflow.actions || {});
  }

  if ('settings' in updates) {
    merged.settings = isPlainObject(updates.settings)
      ? { ...(isPlainObject(existingWorkflow.settings) ? existingWorkflow.settings : {}), ...updates.settings }
      : (existingWorkflow.settings || {});
  }

  return merged;
}

module.exports = WorkflowTemplateStore;
module.exports.mergeLegacyWorkflowUpdate = mergeLegacyWorkflowUpdate;
