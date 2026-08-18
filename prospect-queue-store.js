const {
  createId,
  getConnectAbilityAppStateDir,
  readJsonFile,
  resolveInternalStatePath,
  writeJsonFileAtomic
} = require('./connect-documents');
const { summarizeManagedElsewhere } = require('./prospect-contact-policy');
const SqliteProspectRepository = require('./storage/sqlite-prospect-repository');
const { normalizeSearchProvenance } = require('./automation/search/people-search-results');
const { normalizeProfileUrl } = require('./automation/url/normalize');

const STORE_VERSION = 1;
const ALLOWED_PROSPECT_STATES = new Set([
  'discovered',
  'queued',
  'active',
  'completed',
  'failed',
  'responded',
  'paused',
  'archived'
]);
const ALLOWED_SOURCE_TYPES = new Set(['group', 'profiles', 'manual', 'search', 'activity', 'workflow', 'unknown']);

class ProspectQueueStore {
  constructor(options = {}) {
    this.documentsDir = options.documentsDir || getConnectAbilityAppStateDir();
    this.storePath = options.storePath || resolveInternalStatePath('prospect-queue.json');
    this._repo = options.db ? new SqliteProspectRepository(options.db) : null;
  }

  getAllProspects(filters = {}) {
    const normalizedFilters = normalizeFilters(filters);
    if (this._repo) {
      return this._repo
        .findAll(normalizedFilters)
        .map((p) => normalizeProspectRecord(p));
    }
    return this.readStore().prospects
      .map((prospect) => normalizeProspectRecord(prospect))
      .filter((prospect) => matchesFilters(prospect, normalizedFilters))
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  getProspect(prospectId) {
    const id = cleanString(prospectId, 160);
    if (!id) return null;
    if (this._repo) {
      const found = this._repo.findById(id);
      return found ? normalizeProspectRecord(found) : null;
    }
    return this.getAllProspects().find((prospect) => prospect.id === id) || null;
  }

  upsertProspect(input = {}, options = {}) {
    const now = new Date().toISOString();
    if (this._repo) {
      const prospect = upsertProspectWithRepo(this._repo, input, now, options);
      return normalizeProspectRecord(prospect);
    }
    const store = this.readStore();
    const result = upsertProspectInStore(store, input, now, options);
    if (result.changed) {
      writeJsonFileAtomic(this.storePath, store);
    }
    return result.prospect;
  }

  upsertWorkflowTargets(params = {}) {
    const targets = Array.isArray(params.targets) ? params.targets : [];
    if (!targets.length) {
      return [];
    }

    const now = new Date().toISOString();

    // Build the prospect-upsert input for one target, threading any search
    // provenance into sourceType + metadata.search so the prospect record can
    // be traced back to the exact People-search rank that produced it. A
    // search-sourced target overrides the generic 'workflow' sourceType.
    const buildProspectInput = (normalizedTarget) => {
      const provenance = normalizedTarget.searchProvenance || null;
      return {
        accountId: params.accountId,
        accountName: params.accountName,
        agentId: params.agentId,
        agentName: params.agentName,
        fullName: normalizedTarget.fullName || normalizedTarget.label,
        profileUrl: normalizedTarget.profileUrl,
        title: normalizedTarget.title,
        company: normalizedTarget.company,
        rawTarget: normalizedTarget.value,
        state: 'queued',
        sourceType: provenance ? 'search' : (params.targetType || params.sourceType || 'workflow'),
        sourceId: params.sourceId || null,
        sourceLabel: params.sourceLabel || params.workflowName || null,
        workflowAssignment: {
          workflowId: params.workflowId || null,
          workflowName: params.workflowName || null,
          runId: params.runId || null,
          targetType: params.targetType || null,
          assignedAt: now
        },
        metadata: {
          targetType: params.targetType || null,
          ...(provenance ? { search: provenance } : {})
        }
      };
    };

    const buildResolvedTarget = (normalizedTarget, prospect) => ({
      value: normalizedTarget.value,
      label: prospect.fullName || normalizedTarget.label || normalizedTarget.value,
      prospectId: prospect.id,
      profileUrl: prospect.profileUrl || normalizedTarget.profileUrl || null,
      title: prospect.title || null,
      company: prospect.company || null,
      ...(normalizedTarget.searchProvenance ? { searchProvenance: normalizedTarget.searchProvenance } : {})
    });

    if (this._repo) {
      return targets.map((target) => {
        const normalizedTarget = normalizeTargetInput(target);
        const prospect = upsertProspectWithRepo(this._repo, buildProspectInput(normalizedTarget), now);
        return buildResolvedTarget(normalizedTarget, prospect);
      });
    }

    const store = this.readStore();
    let changed = false;
    const resolvedTargets = targets.map((target) => {
      const normalizedTarget = normalizeTargetInput(target);
      const result = upsertProspectInStore(store, buildProspectInput(normalizedTarget), now);
      changed = changed || result.changed;
      return buildResolvedTarget(normalizedTarget, result.prospect);
    });

    if (changed) {
      writeJsonFileAtomic(this.storePath, store);
    }

    return resolvedTargets;
  }

  recordActivity(eventInput = {}) {
    const prospectId = cleanString(eventInput.prospectId, 160);
    if (!prospectId) return null;

    const now = cleanString(eventInput.timestamp, 80) || new Date().toISOString();

    if (this._repo) {
      const existing = this._repo.findById(prospectId);
      if (!existing) return null;
      const enrichedBase = mergeProspectRecord(
        normalizeProspectRecord(existing),
        normalizeProspectCandidate(buildProspectInputFromEvent(eventInput), now),
        now
      );
      const updated = applyActivityEventToProspect(enrichedBase, eventInput, now);
      this._repo.upsert(updated);
      return normalizeProspectRecord(updated);
    }

    const store = this.readStore();
    const prospectIndex = store.prospects.findIndex((prospect) => {
      return cleanString(prospect.id, 160) === prospectId;
    });
    if (prospectIndex === -1) {
      return null;
    }

    const enrichedBase = mergeProspectRecord(
      normalizeProspectRecord(store.prospects[prospectIndex]),
      normalizeProspectCandidate(buildProspectInputFromEvent(eventInput), now),
      now
    );
    const updatedProspect = applyActivityEventToProspect(enrichedBase, eventInput, now);
    store.prospects[prospectIndex] = updatedProspect;
    writeJsonFileAtomic(this.storePath, store);
    return updatedProspect;
  }

  updateWorkflowProgress(prospectId, progress = {}) {
    const normalizedProspectId = cleanString(prospectId, 160);
    if (!normalizedProspectId) return null;

    const now = cleanString(progress.timestamp, 80) || new Date().toISOString();

    if (this._repo) {
      const existing = this._repo.findById(normalizedProspectId);
      if (!existing) return null;
      const next = mergeProspectRecord(
        normalizeProspectRecord(existing),
        normalizeProspectCandidate({
          prospectId: normalizedProspectId,
          accountId: progress.accountId,
          accountName: progress.accountName,
          agentId: progress.agentId,
          agentName: progress.agentName,
          fullName: progress.fullName,
          profileUrl: progress.profileUrl,
          title: progress.title,
          company: progress.company,
          state: progress.state,
          workflowAssignment: progress.workflowAssignment,
          metadata: progress.metadata
        }, now),
        now
      );
      const requestedState = normalizeProspectState(progress.state, true);
      if (requestedState === 'completed') {
        next.metrics.workflowsCompleted += 1;
      } else if (requestedState === 'failed') {
        next.metrics.workflowsFailed += 1;
      }
      this._repo.upsert(next);
      return normalizeProspectRecord(next);
    }

    const store = this.readStore();
    const prospectIndex = store.prospects.findIndex((prospect) => {
      return cleanString(prospect.id, 160) === normalizedProspectId;
    });
    if (prospectIndex === -1) {
      return null;
    }

    const next = mergeProspectRecord(
      normalizeProspectRecord(store.prospects[prospectIndex]),
      normalizeProspectCandidate({
        prospectId: normalizedProspectId,
        accountId: progress.accountId,
        accountName: progress.accountName,
        agentId: progress.agentId,
        agentName: progress.agentName,
        fullName: progress.fullName,
        profileUrl: progress.profileUrl,
        state: progress.state,
        workflowAssignment: progress.workflowAssignment,
        metadata: progress.metadata
      }, now),
      now
    );
    const requestedState = normalizeProspectState(progress.state, true);
    if (requestedState === 'completed') {
      next.metrics.workflowsCompleted += 1;
    } else if (requestedState === 'failed') {
      next.metrics.workflowsFailed += 1;
    }
    store.prospects[prospectIndex] = next;
    writeJsonFileAtomic(this.storePath, store);
    return next;
  }

  updateProspectMetadata(prospectId, metadataPatch = {}) {
    const normalizedProspectId = cleanString(prospectId, 160);
    if (!normalizedProspectId) return null;
    if (!metadataPatch || typeof metadataPatch !== 'object' || Array.isArray(metadataPatch)) {
      return this.getProspect(normalizedProspectId);
    }

    if (this._repo) {
      const existing = this._repo.findById(normalizedProspectId);
      if (!existing) return null;
      const current = normalizeProspectRecord(existing);
      const updated = {
        ...current,
        metadata: mergeNestedObjects(current.metadata || {}, metadataPatch),
        updatedAt: new Date().toISOString()
      };
      this._repo.upsert(updated);
      return normalizeProspectRecord(updated);
    }

    const store = this.readStore();
    const prospectIndex = store.prospects.findIndex((prospect) => {
      return cleanString(prospect.id, 160) === normalizedProspectId;
    });
    if (prospectIndex === -1) {
      return null;
    }

    const current = normalizeProspectRecord(store.prospects[prospectIndex]);
    store.prospects[prospectIndex] = {
      ...current,
      metadata: mergeNestedObjects(current.metadata || {}, metadataPatch),
      updatedAt: new Date().toISOString()
    };
    writeJsonFileAtomic(this.storePath, store);
    return store.prospects[prospectIndex];
  }

  applyLeadScores(entries = []) {
    const normalizedEntries = dedupeLeadScoreEntries(entries);
    if (!normalizedEntries.length) {
      return [];
    }

    if (this._repo) {
      const results = new Map();
      for (const entry of normalizedEntries) {
        const existing = this._repo.findById(entry.prospectId);
        if (!existing) continue;
        const current = normalizeProspectRecord(existing);
        const sameScore = current.score === entry.score;
        const sameBreakdown = JSON.stringify(current.scoreBreakdown || null) === JSON.stringify(entry.scoreBreakdown || null);
        if (sameScore && sameBreakdown) {
          results.set(current.id, current);
          continue;
        }
        const next = {
          ...current,
          score: entry.score,
          scoreBreakdown: entry.scoreBreakdown,
          scoreUpdatedAt: entry.scoreUpdatedAt
        };
        this._repo.upsert(next);
        results.set(current.id, normalizeProspectRecord(next));
      }
      return normalizedEntries
        .map((entry) => results.get(entry.prospectId) || null)
        .filter(Boolean);
    }

    const store = this.readStore();
    const entryByProspectId = new Map(normalizedEntries.map((entry) => [entry.prospectId, entry]));
    const results = new Map();
    let changed = false;

    store.prospects = store.prospects.map((prospect) => {
      const current = normalizeProspectRecord(prospect);
      const entry = entryByProspectId.get(current.id);
      if (!entry) {
        return prospect;
      }

      const sameScore = current.score === entry.score;
      const sameBreakdown = JSON.stringify(current.scoreBreakdown || null) === JSON.stringify(entry.scoreBreakdown || null);
      if (sameScore && sameBreakdown) {
        results.set(current.id, current);
        return prospect;
      }

      changed = true;
      const next = {
        ...current,
        score: entry.score,
        scoreBreakdown: entry.scoreBreakdown,
        scoreUpdatedAt: entry.scoreUpdatedAt
      };
      results.set(current.id, next);
      return next;
    });

    if (changed) {
      writeJsonFileAtomic(this.storePath, store);
    }

    return normalizedEntries
      .map((entry) => results.get(entry.prospectId) || null)
      .filter(Boolean);
  }

  archiveProspect(prospectId, options = {}) {
    const normalizedProspectId = cleanString(prospectId, 160);
    if (!normalizedProspectId) return null;

    const now = cleanString(options.timestamp, 80) || new Date().toISOString();
    const archiveReason = cleanString(options.reason, 200) || null;
    const metadataPatch = { archivedAt: now, doNotContact: true };
    if (archiveReason) metadataPatch.archiveReason = archiveReason;
    if (archiveReason === 'unsubscribe_received') metadataPatch.unsubscribedAt = now;

    if (this._repo) {
      const existing = this._repo.findById(normalizedProspectId);
      if (!existing) return null;
      const current = normalizeProspectRecord(existing);
      const updated = {
        ...current,
        state: 'archived',
        workflowAssignment: mergeWorkflowAssignment(current.workflowAssignment, options.workflowAssignment),
        metadata: mergeNestedObjects(current.metadata || {}, metadataPatch),
        updatedAt: now,
        lastSeenAt: now,
        lastReplyAt: archiveReason === 'unsubscribe_received'
          ? (current.lastReplyAt || now)
          : current.lastReplyAt
      };
      this._repo.upsert(updated);
      return normalizeProspectRecord(updated);
    }

    const store = this.readStore();
    const prospectIndex = store.prospects.findIndex((prospect) => {
      return cleanString(prospect.id, 160) === normalizedProspectId;
    });
    if (prospectIndex === -1) {
      return null;
    }

    const current = normalizeProspectRecord(store.prospects[prospectIndex]);
    store.prospects[prospectIndex] = {
      ...current,
      state: 'archived',
      workflowAssignment: mergeWorkflowAssignment(current.workflowAssignment, options.workflowAssignment),
      metadata: mergeNestedObjects(current.metadata || {}, metadataPatch),
      updatedAt: now,
      lastSeenAt: now,
      lastReplyAt: archiveReason === 'unsubscribe_received'
        ? (current.lastReplyAt || now)
        : current.lastReplyAt
    };
    writeJsonFileAtomic(this.storePath, store);
    return normalizeProspectRecord(store.prospects[prospectIndex]);
  }

  getRelatedProspects(input = {}) {
    const current = input?.prospectId ? this.getProspect(input.prospectId) : null;
    const candidate = current || normalizeProspectCandidate(input, new Date().toISOString());
    if (this._repo) {
      return findRelatedProspectsFromRepo(this._repo, candidate)
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
    }
    return findRelatedProspects(this.readStore().prospects, candidate)
      .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  }

  getContactOwnershipSummary(input = {}) {
    const current = input?.prospectId ? this.getProspect(input.prospectId) : null;
    const candidate = current || normalizeProspectCandidate(input, new Date().toISOString());
    const relatedProspects = this._repo
      ? findRelatedProspectsFromRepo(this._repo, candidate)
      : findRelatedProspects(this.readStore().prospects, candidate);
    return summarizeManagedElsewhere(relatedProspects, {
      prospectId: current?.id || cleanString(input?.prospectId, 160) || null,
      accountId: cleanString(input?.accountId, 120) || current?.accountId || null,
      agentId: cleanString(input?.agentId, 120) || current?.agentId || null,
      normalizedProfileUrl: candidate.normalizedProfileUrl || null,
      fullName: candidate.fullName || null,
      company: candidate.company || null
    });
  }

  readStore() {
    const fallback = {
      version: STORE_VERSION,
      prospects: []
    };
    const store = readJsonFile(this.storePath, fallback);
    return {
      version: STORE_VERSION,
      prospects: Array.isArray(store.prospects) ? store.prospects : []
    };
  }
}

// ---------------------------------------------------------------------------
// SQLite repo helpers
// ---------------------------------------------------------------------------

/**
 * Find-or-create + merge using a SqliteProspectRepository.
 * Mirrors the logic in upsertProspectInStore but reads/writes individual rows.
 */
function upsertProspectWithRepo(repo, input, now, options = {}) {
  const candidate = normalizeProspectCandidate(input, now);

  // 1. Exact ID match
  let existing = candidate.id ? repo.findById(candidate.id) : null;

  // 2. URL match — primary dedupe key
  if (!existing && candidate.normalizedProfileUrl) {
    existing = repo.findByNormalizedUrl(candidate.accountId, candidate.normalizedProfileUrl);
  }

  // 3. Name/key match — scan per-account dedupe keys
  if (!existing && candidate.dedupeKeys.length) {
    const accountKey = candidate.accountId || '__global__';
    const candidateKeySet = new Set(candidate.dedupeKeys);
    const accountDedupeKeys = repo.findDedupeKeysByAccount(accountKey);
    const match = accountDedupeKeys.find((row) =>
      row.dedupeKeys.some((k) => candidateKeySet.has(k))
    );
    if (match) {
      existing = repo.findById(match.id);
    }
  }

  if (!existing) {
    repo.upsert(candidate);
    return candidate;
  }

  const merged = mergeProspectRecord(normalizeProspectRecord(existing), candidate, now, options);
  repo.upsert(merged);
  return merged;
}

/**
 * findRelatedProspects equivalent using the SQLite repo.
 */
function findRelatedProspectsFromRepo(repo, candidate) {
  const candidateUrl = cleanString(candidate.normalizedProfileUrl, 400) || null;
  if (candidateUrl) {
    return repo.findByRelatedUrl(candidateUrl).map((p) => normalizeProspectRecord(p));
  }

  const candidateName = normalizeComparableText(candidate.fullName);
  const candidateCompany = normalizeComparableText(candidate.company);
  if (candidateName && candidateCompany) {
    return repo.findByNameAndCompany(candidateName, candidateCompany).map((p) => normalizeProspectRecord(p));
  }

  return [];
}

// ---------------------------------------------------------------------------
// JSON store helpers
// ---------------------------------------------------------------------------

function upsertProspectInStore(store, input, now, options = {}) {
  const candidate = normalizeProspectCandidate(input, now);
  const prospectIndex = findProspectIndex(store.prospects, candidate);

  if (prospectIndex === -1) {
    store.prospects.unshift(candidate);
    return {
      changed: true,
      prospect: candidate
    };
  }

  const merged = mergeProspectRecord(normalizeProspectRecord(store.prospects[prospectIndex]), candidate, now, options);
  const previous = JSON.stringify(normalizeProspectRecord(store.prospects[prospectIndex]));
  const next = JSON.stringify(merged);
  store.prospects[prospectIndex] = merged;
  return {
    changed: previous !== next,
    prospect: merged
  };
}

function findProspectIndex(prospects, candidate) {
  const normalizedProspects = Array.isArray(prospects) ? prospects.map((prospect) => normalizeProspectRecord(prospect)) : [];
  if (candidate.id) {
    const exactIdIndex = normalizedProspects.findIndex((prospect) => prospect.id === candidate.id);
    if (exactIdIndex >= 0) return exactIdIndex;
  }

  const candidateAccountId = candidate.accountId || '__global__';
  const candidateUrlKey = candidate.normalizedProfileUrl ? `url:${candidate.normalizedProfileUrl}` : null;
  if (candidateUrlKey) {
    const urlMatchIndex = normalizedProspects.findIndex((prospect) => {
      const prospectAccountId = prospect.accountId || '__global__';
      return prospectAccountId === candidateAccountId && prospect.dedupeKeys.includes(candidateUrlKey);
    });
    if (urlMatchIndex >= 0) return urlMatchIndex;
  }

  const candidateKeySet = new Set(candidate.dedupeKeys);
  return normalizedProspects.findIndex((prospect) => {
    const prospectAccountId = prospect.accountId || '__global__';
    if (prospectAccountId !== candidateAccountId) {
      return false;
    }
    return prospect.dedupeKeys.some((key) => candidateKeySet.has(key));
  });
}

function findRelatedProspects(prospects, candidate) {
  const normalizedProspects = Array.isArray(prospects)
    ? prospects.map((prospect) => normalizeProspectRecord(prospect))
    : [];
  const candidateUrl = cleanString(candidate.normalizedProfileUrl, 400) || null;
  if (candidateUrl) {
    return normalizedProspects.filter((prospect) => prospect.normalizedProfileUrl === candidateUrl);
  }

  const candidateName = normalizeComparableText(candidate.fullName);
  const candidateCompany = normalizeComparableText(candidate.company);
  if (candidateName && candidateCompany) {
    return normalizedProspects.filter((prospect) => {
      return normalizeComparableText(prospect.fullName) === candidateName
        && normalizeComparableText(prospect.company) === candidateCompany;
    });
  }

  return [];
}

function normalizeProspectCandidate(input = {}, now = new Date().toISOString()) {
  const normalizedProfileUrl = normalizeProfileUrl(input.profileUrl || input.normalizedProfileUrl);
  const fullName = cleanString(input.fullName || input.name || input.label, 240) || null;
  const rawTarget = cleanString(input.rawTarget || input.profileUrl || input.fullName || input.name, 400) || null;
  const dedupeKeys = normalizeStringList([
    ...(Array.isArray(input.dedupeKeys) ? input.dedupeKeys : []),
    normalizedProfileUrl ? `url:${normalizedProfileUrl}` : null,
    fullName ? `name:${normalizeComparableText(fullName)}` : null,
    rawTarget ? `raw:${normalizeComparableText(rawTarget)}` : null
  ], 24, 300);

  // Phase A profile-identity fields. Sourced primarily by the legacy
  // profile importer (Phase B step 3), but also writable from any caller
  // that has these values. `suggestedEmails` accepts an array OR a JSON
  // string; canonicalized to a JSON string for storage so the SQL column
  // round-trips cleanly.
  const suggestedEmailsInput = Array.isArray(input.suggestedEmails)
    ? input.suggestedEmails
    : (typeof input.suggestedEmailsJson === 'string'
      ? safeParseEmailList(input.suggestedEmailsJson)
      : null);

  return {
    id: cleanString(input.prospectId || input.id, 160) || createId('prospect'),
    accountId: cleanString(input.accountId, 120) || null,
    accountName: cleanString(input.accountName, 160) || null,
    agentId: cleanString(input.agentId, 120) || null,
    agentName: cleanString(input.agentName, 160) || null,
    fullName,
    profileUrl: cleanString(input.profileUrl, 400) || null,
    normalizedProfileUrl: normalizedProfileUrl || null,
    title: cleanString(input.title, 200) || null,
    company: cleanString(input.company, 200) || null,
    state: normalizeProspectState(input.state),
    sourceType: normalizeSourceType(input.sourceType),
    sourceId: cleanString(input.sourceId, 160) || null,
    sourceLabel: cleanString(input.sourceLabel, 240) || null,
    sources: normalizeSources(input.sources, input, now),
    workflowAssignment: normalizeWorkflowAssignment(input.workflowAssignment, now),
    dedupeKeys,
    metrics: normalizeMetrics(input.metrics),
    metadata: normalizeMetadata(input.metadata),
    score: normalizeScore(input.score),
    scoreBreakdown: normalizeScoreBreakdown(input.scoreBreakdown || input.breakdown),
    scoreUpdatedAt: cleanString(input.scoreUpdatedAt, 80) || null,
    createdAt: cleanString(input.createdAt, 80) || now,
    updatedAt: cleanString(input.updatedAt, 80) || now,
    firstSeenAt: cleanString(input.firstSeenAt, 80) || now,
    lastSeenAt: cleanString(input.lastSeenAt, 80) || now,
    lastActionAt: cleanString(input.lastActionAt, 80) || null,
    lastReplyAt: cleanString(input.lastReplyAt, 80) || null,
    // Phase A profile-identity columns
    firstName: cleanString(input.firstName, 120) || null,
    lastName: cleanString(input.lastName, 120) || null,
    rawHeadline: cleanString(input.rawHeadline, 400) || null,
    companyDomain: cleanString(input.companyDomain, 200) || null,
    primaryEmail: cleanString(input.primaryEmail || input.email, 200) || null,
    suggestedEmails: Array.isArray(suggestedEmailsInput) ? suggestedEmailsInput : null,
    firstInteractionAt: cleanString(input.firstInteractionAt, 80) || null,
    lastInteractionAt: cleanString(input.lastInteractionAt, 80) || null
  };
}

function safeParseEmailList(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function normalizeProspectRecord(prospect = {}) {
  return normalizeProspectCandidate(prospect, new Date().toISOString());
}

function mergeProspectRecord(existing, candidate, now, options = {}) {
  const mergedState = resolvePreferredState(existing.state, candidate.state);
  // additive=true: existing non-NULL values win (used by the profiles legacy
  // importer to ensure runtime-written SQLite values are never overwritten).
  // additive=false (default): candidate-wins-when-set (historic runtime
  // behavior — UI/IPC updates overwrite stale fields).
  const additive = options.additive === true;
  const pick = additive
    ? (cand, exist) => (exist || cand)
    : (cand, exist) => (cand || exist);
  return {
    ...existing,
    ...candidate,
    id: existing.id || candidate.id,
    accountId: pick(candidate.accountId, existing.accountId) || null,
    accountName: pick(candidate.accountName, existing.accountName) || null,
    agentId: pick(candidate.agentId, existing.agentId) || null,
    agentName: pick(candidate.agentName, existing.agentName) || null,
    fullName: pick(candidate.fullName, existing.fullName) || null,
    profileUrl: pick(candidate.profileUrl, existing.profileUrl) || null,
    normalizedProfileUrl: pick(candidate.normalizedProfileUrl, existing.normalizedProfileUrl) || null,
    title: pick(candidate.title, existing.title) || null,
    company: pick(candidate.company, existing.company) || null,
    state: mergedState,
    // sourceType: 'unknown' is the "no info" sentinel; never let it overwrite
    // a more-specific existing value. Additive mode also prefers existing.
    sourceType: (additive || candidate.sourceType === 'unknown')
      ? (existing.sourceType !== 'unknown' ? existing.sourceType : candidate.sourceType)
      : candidate.sourceType,
    sourceId: pick(candidate.sourceId, existing.sourceId) || null,
    sourceLabel: pick(candidate.sourceLabel, existing.sourceLabel) || null,
    sources: mergeSources(existing.sources, candidate.sources),
    workflowAssignment: mergeWorkflowAssignment(existing.workflowAssignment, candidate.workflowAssignment),
    dedupeKeys: normalizeStringList([...(existing.dedupeKeys || []), ...(candidate.dedupeKeys || [])], 32, 300),
    metrics: mergeMetrics(existing.metrics, candidate.metrics),
    metadata: {
      ...(existing.metadata || {}),
      ...(candidate.metadata || {})
    },
    score: candidate.score !== null ? candidate.score : existing.score,
    scoreBreakdown: candidate.scoreBreakdown || existing.scoreBreakdown || null,
    scoreUpdatedAt: candidate.score !== null
      ? (candidate.scoreUpdatedAt || existing.scoreUpdatedAt || now)
      : (existing.scoreUpdatedAt || null),
    createdAt: existing.createdAt || candidate.createdAt || now,
    updatedAt: now,
    firstSeenAt: existing.firstSeenAt || candidate.firstSeenAt || now,
    lastSeenAt: candidate.lastSeenAt || now,
    lastActionAt: pick(candidate.lastActionAt, existing.lastActionAt) || null,
    lastReplyAt: pick(candidate.lastReplyAt, existing.lastReplyAt) || null,
    // Phase A profile-identity columns. Both modes respect the `pick` rule
    // so the importer (additive=true) preserves runtime-written values.
    firstName: pick(candidate.firstName, existing.firstName) || null,
    lastName: pick(candidate.lastName, existing.lastName) || null,
    rawHeadline: pick(candidate.rawHeadline, existing.rawHeadline) || null,
    companyDomain: pick(candidate.companyDomain, existing.companyDomain) || null,
    primaryEmail: pick(candidate.primaryEmail, existing.primaryEmail) || null,
    suggestedEmails: pick(candidate.suggestedEmails, existing.suggestedEmails) || null,
    firstInteractionAt: pick(candidate.firstInteractionAt, existing.firstInteractionAt) || null,
    lastInteractionAt: pick(candidate.lastInteractionAt, existing.lastInteractionAt) || null
  };
}

function applyActivityEventToProspect(prospect, eventInput, now) {
  const eventType = cleanString(eventInput.type, 80);
  const timestamp = cleanString(eventInput.timestamp, 80) || now;
  const metadata = eventInput.metadata && typeof eventInput.metadata === 'object' ? eventInput.metadata : {};
  const next = {
    ...prospect,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
    workflowAssignment: mergeWorkflowAssignment(prospect.workflowAssignment, {
      workflowId: cleanString(eventInput.workflowId, 160) || null,
      workflowName: cleanString(eventInput.workflowName, 160) || null,
      runId: cleanString(eventInput.runId, 160) || null,
      targetId: cleanString(eventInput.targetId, 160) || null,
      targetType: cleanString(metadata.targetType, 40) || null,
      assignedAt: timestamp
    }),
    metadata: {
      ...(prospect.metadata || {}),
      lastEventType: eventType || null,
      lastEventStatus: cleanString(eventInput.status, 40) || null,
      lastOutcomeType: cleanString(metadata.outcomeType, 80) || null,
      lastReason: cleanString(metadata.reason, 600) || null
    }
  };

  switch (eventType) {
    case 'workflow_started':
      next.metrics.workflowsStarted += 1;
      next.state = resolvePreferredState(next.state, 'queued');
      break;
    case 'profile_viewed':
      next.metrics.views += 1;
      next.lastActionAt = timestamp;
      next.state = resolvePreferredState(next.state, 'active');
      break;
    case 'post_liked':
      next.metrics.postLikes += 1;
      next.lastActionAt = timestamp;
      next.state = resolvePreferredState(next.state, 'active');
      break;
    case 'connection_requested':
      next.metrics.connectionRequests += 1;
      next.lastActionAt = timestamp;
      next.state = resolvePreferredState(next.state, 'active');
      break;
    case 'connection_accepted':
      next.metrics.connectionAcceptances += 1;
      next.lastActionAt = timestamp;
      next.state = resolvePreferredState(next.state, 'active');
      next.metadata.connectionAcceptedAt = timestamp;
      break;
    case 'dm_sent':
      next.metrics.dmsSent += 1;
      next.lastActionAt = timestamp;
      next.state = resolvePreferredState(next.state, 'active');
      break;
    case 'dm_reply_received':
      next.metrics.dmReplies += 1;
      next.lastReplyAt = timestamp;
      next.state = resolvePreferredState(next.state, 'responded');
      break;
    case 'workflow_step_failed':
      next.state = resolvePreferredState(next.state, 'failed');
      break;
    case 'workflow_completed':
      next.metrics.workflowsCompleted += 1;
      next.state = resolvePreferredState(next.state, 'completed');
      break;
    case 'workflow_failed':
      next.metrics.workflowsFailed += 1;
      next.state = resolvePreferredState(next.state, 'failed');
      break;
    default:
      break;
  }

  return next;
}

function buildProspectInputFromEvent(eventInput = {}) {
  const metadata = eventInput.metadata && typeof eventInput.metadata === 'object' ? eventInput.metadata : {};
  return {
    prospectId: eventInput.prospectId || null,
    accountId: eventInput.accountId,
    accountName: eventInput.accountName,
    agentId: eventInput.agentId,
    agentName: eventInput.agentName,
    fullName: metadata.recipientName || metadata.senderName || eventInput.targetValue || null,
    profileUrl: eventInput.profileUrl || null,
    sourceType: resolveEventSourceType(eventInput),
    sourceLabel: metadata.searchQuery || metadata.source || eventInput.workflowName || eventInput.type || null,
    workflowAssignment: {
      workflowId: eventInput.workflowId || null,
      workflowName: eventInput.workflowName || null,
      runId: eventInput.runId || null,
      targetId: eventInput.targetId || null,
      targetType: metadata.targetType || null,
      assignedAt: eventInput.timestamp || new Date().toISOString()
    },
    metadata: {
      lastEventType: eventInput.type || null
    }
  };
}

function normalizeTargetInput(target) {
  const rawValue = typeof target === 'string'
    ? target
    : target?.value || target?.profileUrl || target?.url || target?.name || target?.fullName || '';
  const value = cleanString(rawValue, 400);
  if (!value) {
    throw new Error('Prospect workflow target requires a value');
  }

  const profileUrl = normalizeProfileUrl(
    target?.profileUrl
    || target?.url
    || (/linkedin\.com\/in\//i.test(value) ? value : '')
  );
  const fullName = cleanString(target?.fullName || target?.name, 240) || null;
  const label = cleanString(target?.label || fullName || value, 240) || value;

  // Search provenance: accept either a nested `searchProvenance` object or the
  // flat fields straight off a People-search receipt entry. Null when absent.
  const searchProvenance = (target && typeof target === 'object')
    ? normalizeSearchProvenance(target.searchProvenance || target)
    : null;

  return {
    value,
    label,
    fullName: fullName || (!profileUrl ? label : null),
    profileUrl: profileUrl || null,
    title: cleanString(target?.title, 200) || null,
    company: cleanString(target?.company, 200) || null,
    searchProvenance
  };
}

function normalizeFilters(filters = {}) {
  return {
    accountId: cleanString(filters.accountId, 120) || null,
    agentId: cleanString(filters.agentId, 120) || null,
    state: normalizeProspectState(filters.state, true),
    workflowId: cleanString(filters.workflowId, 160) || null
  };
}

function matchesFilters(prospect, filters) {
  if (filters.accountId && prospect.accountId !== filters.accountId) return false;
  if (filters.agentId && prospect.agentId !== filters.agentId) return false;
  if (filters.state && prospect.state !== filters.state) return false;
  if (filters.workflowId && prospect.workflowAssignment?.workflowId !== filters.workflowId) return false;
  return true;
}

function normalizeProspectState(value, allowNull = false) {
  const state = cleanString(value, 40).toLowerCase();
  if (!state) return allowNull ? null : 'discovered';
  return ALLOWED_PROSPECT_STATES.has(state) ? state : (allowNull ? null : 'discovered');
}

function normalizeSourceType(value) {
  const type = cleanString(value, 40).toLowerCase();
  return ALLOWED_SOURCE_TYPES.has(type) ? type : 'unknown';
}

function normalizeSources(value, input, now) {
  const sources = Array.isArray(value) ? value : [];
  const normalizedDirectType = normalizeSourceType(input?.sourceType);
  const directSource = (
    normalizedDirectType !== 'unknown'
    || input?.sourceId
    || input?.sourceLabel
    || input?.workflowAssignment?.workflowId
    || input?.workflowAssignment?.runId
  ) ? [{
    type: normalizedDirectType,
    sourceId: cleanString(input?.sourceId, 160) || null,
    label: cleanString(input?.sourceLabel, 240) || null,
    workflowId: cleanString(input?.workflowAssignment?.workflowId, 160) || null,
    workflowName: cleanString(input?.workflowAssignment?.workflowName, 160) || null,
    capturedAt: now
  }] : [];

  const seen = new Set();
  return [...sources, ...directSource]
    .map((source) => ({
      type: normalizeSourceType(source?.type),
      sourceId: cleanString(source?.sourceId, 160) || null,
      label: cleanString(source?.label, 240) || null,
      workflowId: cleanString(source?.workflowId, 160) || null,
      workflowName: cleanString(source?.workflowName, 160) || null,
      capturedAt: cleanString(source?.capturedAt, 80) || now
    }))
    .filter((source) => {
      const key = [
        source.type,
        source.sourceId || '',
        source.label || '',
        source.workflowId || '',
        source.workflowName || ''
      ].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 24);
}

function mergeSources(existing, next) {
  return normalizeSources([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(next) ? next : [])], {}, new Date().toISOString());
}

function normalizeWorkflowAssignment(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const workflowId = cleanString(value.workflowId, 160) || null;
  const workflowName = cleanString(value.workflowName, 160) || null;
  const runId = cleanString(value.runId, 160) || null;
  const targetId = cleanString(value.targetId, 160) || null;
  const targetType = cleanString(value.targetType, 40) || null;

  if (!workflowId && !workflowName && !runId && !targetId) {
    return null;
  }

  return {
    workflowId,
    workflowName,
    runId,
    targetId,
    targetType,
    assignedAt: cleanString(value.assignedAt, 80) || now
  };
}

function mergeWorkflowAssignment(existing, next) {
  const normalizedExisting = normalizeWorkflowAssignment(existing, new Date().toISOString());
  const normalizedNext = normalizeWorkflowAssignment(next, new Date().toISOString());
  if (!normalizedExisting) return normalizedNext;
  if (!normalizedNext) return normalizedExisting;
  return {
    ...normalizedExisting,
    ...normalizedNext,
    workflowId: normalizedNext.workflowId || normalizedExisting.workflowId || null,
    workflowName: normalizedNext.workflowName || normalizedExisting.workflowName || null,
    runId: normalizedNext.runId || normalizedExisting.runId || null,
    targetId: normalizedNext.targetId || normalizedExisting.targetId || null,
    targetType: normalizedNext.targetType || normalizedExisting.targetType || null,
    assignedAt: normalizedNext.assignedAt || normalizedExisting.assignedAt || null
  };
}

function normalizeMetrics(value) {
  return {
    views: Math.max(0, Number(value?.views) || 0),
    postLikes: Math.max(0, Number(value?.postLikes) || 0),
    connectionRequests: Math.max(0, Number(value?.connectionRequests) || 0),
    connectionAcceptances: Math.max(0, Number(value?.connectionAcceptances) || 0),
    dmsSent: Math.max(0, Number(value?.dmsSent) || 0),
    dmReplies: Math.max(0, Number(value?.dmReplies) || 0),
    workflowsStarted: Math.max(0, Number(value?.workflowsStarted) || 0),
    workflowsCompleted: Math.max(0, Number(value?.workflowsCompleted) || 0),
    workflowsFailed: Math.max(0, Number(value?.workflowsFailed) || 0)
  };
}

function mergeMetrics(existing, next) {
  const left = normalizeMetrics(existing);
  const right = normalizeMetrics(next);
  return {
    views: Math.max(left.views, right.views),
    postLikes: Math.max(left.postLikes, right.postLikes),
    connectionRequests: Math.max(left.connectionRequests, right.connectionRequests),
    connectionAcceptances: Math.max(left.connectionAcceptances, right.connectionAcceptances),
    dmsSent: Math.max(left.dmsSent, right.dmsSent),
    dmReplies: Math.max(left.dmReplies, right.dmReplies),
    workflowsStarted: Math.max(left.workflowsStarted, right.workflowsStarted),
    workflowsCompleted: Math.max(left.workflowsCompleted, right.workflowsCompleted),
    workflowsFailed: Math.max(left.workflowsFailed, right.workflowsFailed)
  };
}

function resolvePreferredState(existingState, candidateState) {
  const rank = {
    archived: 0,
    discovered: 10,
    queued: 20,
    paused: 25,
    active: 30,
    completed: 40,
    failed: 45,
    responded: 50
  };
  const left = normalizeProspectState(existingState);
  const right = normalizeProspectState(candidateState);
  return (rank[right] || 0) >= (rank[left] || 0) ? right : left;
}

function normalizeMetadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeScore(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeScoreBreakdown(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const factors = value.factors && typeof value.factors === 'object' && !Array.isArray(value.factors)
    ? Object.fromEntries(Object.entries(value.factors).map(([key, factor]) => [
      cleanString(key, 80),
      normalizeScoreFactor(factor)
    ]).filter(([key]) => Boolean(key)))
    : {};

  return {
    total: normalizeFraction(value.total),
    factors
  };
}

function normalizeScoreFactor(value) {
  return {
    score: normalizeFraction(value?.score),
    weight: normalizeFraction(value?.weight),
    weighted: normalizeFraction(value?.weighted),
    matchedKeyword: cleanString(value?.matchedKeyword, 160) || null,
    value: cleanString(value?.value, 120) || null,
    reason: cleanString(value?.reason, 120) || null
  };
}

function normalizeFraction(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(1, numeric));
  return Math.round(clamped * 10000) / 10000;
}

function dedupeLeadScoreEntries(entries) {
  const byProspectId = new Map();
  const now = new Date().toISOString();

  for (const entry of Array.isArray(entries) ? entries : []) {
    const prospectId = cleanString(entry?.prospectId, 160);
    const score = normalizeScore(entry?.score);
    if (!prospectId || score === null) {
      continue;
    }

    byProspectId.set(prospectId, {
      prospectId,
      score,
      scoreBreakdown: normalizeScoreBreakdown(entry?.scoreBreakdown || entry?.breakdown),
      scoreUpdatedAt: cleanString(entry?.scoreUpdatedAt, 80) || now
    });
  }

  return Array.from(byProspectId.values());
}

function mergeNestedObjects(left, right) {
  const base = left && typeof left === 'object' && !Array.isArray(left) ? left : {};
  const patch = right && typeof right === 'object' && !Array.isArray(right) ? right : {};
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && base[key]
      && typeof base[key] === 'object'
      && !Array.isArray(base[key])
    ) {
      next[key] = mergeNestedObjects(base[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

// Canonical SQL-join-key normalizer lives in automation/url/normalize.js so
// the legacy importer (storage/prospect-legacy-importer.js) + the runtime
// write path (this file) share one source of truth. See that module's
// docblock for the contract.

function normalizeComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/(www\.)?/g, '')
    .replace(/linkedin\.com\/in\//g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolveEventSourceType(eventInput) {
  const source = cleanString(eventInput?.metadata?.source, 80).toLowerCase();
  if (source === 'store-profile-batch' || source === 'search' || source === 'dashboard') {
    return 'search';
  }
  if (eventInput?.workflowId || eventInput?.runId) {
    return 'workflow';
  }
  return 'activity';
}

function normalizeStringList(values, maxItems, maxLength) {
  if (!Array.isArray(values)) {
    return [];
  }

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

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = ProspectQueueStore;
