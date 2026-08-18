'use strict';

const ApolloClient = require('./apollo-client');
const { APOLLO_API_CATALOG } = require('./apollo-api-catalog');
const {
  deleteApolloApiKey,
  getApolloApiKey,
  hasApolloApiKey,
  setApolloApiKey
} = require('./apollo-credential-store');

class ApolloSyncService {
  constructor(options = {}) {
    this.syncStore = options.syncStore;
    this.prospects = options.prospects;
    this.templates = options.templates;
    this.groups = options.groups;
    this.clientFactory = options.clientFactory || ((clientOptions) => new ApolloClient(clientOptions));
    this.credentials = {
      getApolloApiKey: options.getApolloApiKey || getApolloApiKey,
      hasApolloApiKey: options.hasApolloApiKey || hasApolloApiKey,
      setApolloApiKey: options.setApolloApiKey || setApolloApiKey,
      deleteApolloApiKey: options.deleteApolloApiKey || deleteApolloApiKey
    };
  }

  async getIntegration() {
    const config = this.syncStore.getConfig();
    const recentSyncs = this.syncStore.listSyncRecords({ limit: 25 });
    return {
      ...config,
      hasApiKey: await this.credentials.hasApolloApiKey(),
      bindings: this.syncStore.listBindings({}),
      recentSyncs,
      summary: summarizeSyncRecords(recentSyncs)
    };
  }

  async configureIntegration(input = {}) {
    const currentConfig = this.syncStore.getConfig();
    if (input.clearApiKey) {
      await this.credentials.deleteApolloApiKey();
    } else if (Object.prototype.hasOwnProperty.call(input, 'apiKey')) {
      await this.credentials.setApolloApiKey(input.apiKey);
    }

    const configPatch = {};
    if (Object.prototype.hasOwnProperty.call(input, 'enabled')) {
      configPatch.enabled = normalizeBoolean(input.enabled, currentConfig.enabled);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'defaultSequenceId')) {
      configPatch.defaultSequenceId = input.defaultSequenceId;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'defaultSequenceName')) {
      configPatch.defaultSequenceName = input.defaultSequenceName;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'defaultEmailAccountId')) {
      configPatch.defaultEmailAccountId = input.defaultEmailAccountId;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'defaultEmailAccountLabel')) {
      configPatch.defaultEmailAccountLabel = input.defaultEmailAccountLabel;
    }

    const config = this.syncStore.saveConfig(configPatch);

    return {
      ...config,
      hasApiKey: await this.credentials.hasApolloApiKey()
    };
  }

  async listSequences(args = {}) {
    const client = await this.createClient();
    const sequences = await client.searchSequences({
      query: args.query,
      page: args.page,
      perPage: args.limit
    });
    return args.limit ? sequences.slice(0, Number(args.limit)) : sequences;
  }

  async listEmailAccounts() {
    const client = await this.createClient();
    return client.listEmailAccounts();
  }

  listApiCapabilities() {
    return APOLLO_API_CATALOG;
  }

  async callApi(input = {}) {
    const client = await this.createClient();
    const method = cleanString(input.method, 20).toUpperCase() || 'GET';
    return client.apiRequest({
      method,
      path: input.path,
      query: sanitizeApolloPayload(input.query),
      body: sanitizeApolloPayload(input.body)
    });
  }

  async searchPeople(input = {}) {
    const client = await this.createClient();
    const baseFilters = sanitizeApolloPayload(input.filters) || {};
    const filters = {
      ...baseFilters,
      page: normalizePositiveInteger(input.page) || baseFilters.page || 1,
      per_page: normalizeApolloPerPage(input.limit)
    };
    if (input.query) {
      filters.q_keywords = cleanString(input.query, 240);
    }
    if (Array.isArray(input.personTitles)) {
      filters.person_titles = input.personTitles;
    }
    if (Array.isArray(input.personLocations)) {
      filters.person_locations = input.personLocations;
    }
    if (Array.isArray(input.organizationNames)) {
      filters.organization_names = input.organizationNames;
    }
    if (Array.isArray(input.organizationLocations)) {
      filters.organization_locations = input.organizationLocations;
    }
    if (Array.isArray(input.personSeniorities)) {
      filters.person_seniorities = input.personSeniorities;
    }
    return client.searchPeople(filters);
  }

  async searchContacts(input = {}) {
    const client = await this.createClient();
    return client.searchContacts({
      query: input.query,
      email: input.email,
      linkedinUrl: input.linkedinUrl,
      limit: normalizeApolloPerPage(input.limit),
      prospect: {
        fullName: input.name,
        company: input.company,
        profileUrl: input.linkedinUrl,
        email: input.email
      }
    });
  }

  async searchAccounts(input = {}) {
    const client = await this.createClient();
    return client.searchAccounts({
      query: input.query,
      page: input.page,
      perPage: input.limit,
      filters: sanitizeApolloPayload(input.filters)
    });
  }

  async getAccount(input = {}) {
    const client = await this.createClient();
    return client.getAccount(input.accountId);
  }

  async createAccount(input = {}) {
    const client = await this.createClient();
    return client.createAccount(sanitizeApolloPayload(input.account || input));
  }

  async updateAccount(input = {}) {
    const client = await this.createClient();
    return client.updateAccount(input.accountId, sanitizeApolloPayload(input.account || input.patch || {}));
  }

  async listUsers(input = {}) {
    const client = await this.createClient();
    return client.listUsers({
      page: input.page,
      perPage: input.limit
    });
  }

  async listLabels() {
    const client = await this.createClient();
    return client.listLabels();
  }

  async listFields() {
    const client = await this.createClient();
    return client.listFields();
  }

  async listContactStages() {
    const client = await this.createClient();
    return client.listContactStages();
  }

  async updateContactStages(input = {}) {
    const client = await this.createClient();
    return client.updateContactStages(sanitizeApolloPayload(input));
  }

  async updateContactOwners(input = {}) {
    const client = await this.createClient();
    return client.updateContactOwners(sanitizeApolloPayload(input));
  }

  async bulkCreateContacts(input = {}) {
    const client = await this.createClient();
    return client.bulkCreateContacts(sanitizeApolloPayload(input));
  }

  async bulkUpdateContacts(input = {}) {
    const client = await this.createClient();
    return client.bulkUpdateContacts(sanitizeApolloPayload(input));
  }

  async searchDeals(input = {}) {
    const client = await this.createClient();
    return client.searchDeals(sanitizeApolloPayload(input));
  }

  async getDeal(input = {}) {
    const client = await this.createClient();
    return client.getDeal(input.opportunityId || input.dealId);
  }

  async createDeal(input = {}) {
    const client = await this.createClient();
    return client.createDeal(sanitizeApolloPayload(input.deal || input));
  }

  async updateDeal(input = {}) {
    const client = await this.createClient();
    return client.updateDeal(input.opportunityId || input.dealId, sanitizeApolloPayload(input.deal || input.patch || {}));
  }

  async listDealStages() {
    const client = await this.createClient();
    return client.listDealStages();
  }

  async searchTasks(input = {}) {
    const client = await this.createClient();
    return client.searchTasks({
      filters: sanitizeApolloPayload(input.filters),
      page: input.page,
      perPage: input.limit
    });
  }

  async createTask(input = {}) {
    const client = await this.createClient();
    return client.createTask(sanitizeApolloPayload(input.task || input));
  }

  async bulkCreateTasks(input = {}) {
    const client = await this.createClient();
    return client.bulkCreateTasks(sanitizeApolloPayload(input));
  }

  async createCallRecord(input = {}) {
    const client = await this.createClient();
    return client.createCallRecord(sanitizeApolloPayload(input.call || input));
  }

  async searchCalls(input = {}) {
    const client = await this.createClient();
    return client.searchCalls(sanitizeApolloPayload(input));
  }

  async updateCallRecord(input = {}) {
    const client = await this.createClient();
    return client.updateCallRecord(input.callId, sanitizeApolloPayload(input.call || input.patch || {}));
  }

  async updateSequenceContactStatus(input = {}) {
    const client = await this.createClient();
    return client.updateSequenceContactStatus(sanitizeApolloPayload(input));
  }

  async activateSequence(input = {}) {
    const client = await this.createClient();
    return client.activateSequence(input.sequenceId);
  }

  listBindings(args = {}) {
    return this.syncStore.listBindings(args || {});
  }

  saveBinding(input = {}) {
    return this.syncStore.saveBinding(input);
  }

  deleteBinding({ bindingId } = {}) {
    return { deleted: this.syncStore.deleteBinding(bindingId) };
  }

  listSyncStatus(args = {}) {
    return this.syncStore.listSyncRecords(args || {});
  }

  async syncProspectsToSequence(input = {}) {
    const sequenceConfig = this.resolveSequenceConfig(input, {
      targetType: cleanString(input.targetType, 40) || null,
      targetId: cleanString(input.targetId, 160) || null,
      targetName: cleanString(input.targetName, 240) || null
    });
    const prospects = this.resolveProspectsFromInput(input);
    if (!prospects.length) {
      throw new Error('No prospects found for Apollo sync');
    }

    const limit = Math.max(1, Math.min(200, Number(input.limit) || prospects.length));
    const selectedProspects = prospects.slice(0, limit);
    const dryRun = normalizeBoolean(input.dryRun, false);

    let client = null;
    if (!dryRun) {
      client = await this.createClient();
    }

    const results = [];
    for (const prospect of selectedProspects) {
      const result = dryRun
        ? this.buildDryRunResult(prospect, sequenceConfig, input)
        : await this.syncSingleProspect(prospect, sequenceConfig, client, input);
      results.push(result);
    }

    return buildSyncSummary(results, sequenceConfig, dryRun);
  }

  async syncWorkflowToSequence(input = {}) {
    const workflowId = cleanString(input.workflowId, 160) || null;
    if (!workflowId) {
      throw new Error('workflowId is required');
    }
    const template = this.templates?.getTemplate(workflowId);
    if (!template) {
      throw new Error(`Workflow template not found: ${workflowId}`);
    }
    return this.syncProspectsToSequence({
      ...input,
      targetType: 'workflow',
      targetId: workflowId,
      targetName: template.name || workflowId,
      agentId: template.agentId || input.agentId || null,
      prospectIds: [],
      workflowId
    });
  }

  async syncGroupToSequence(input = {}) {
    const groupId = cleanString(input.groupId, 160) || null;
    if (!groupId) {
      throw new Error('groupId is required');
    }
    const group = this.groups?.getGroup(groupId);
    if (!group) {
      throw new Error(`Group not found: ${groupId}`);
    }

    const groupProspects = this.resolveProspectsForGroup(group);
    if (!groupProspects.length) {
      throw new Error(`No prospects matched members of group "${group.name}"`);
    }

    return this.syncProspectsToSequence({
      ...input,
      targetType: 'group',
      targetId: group.id,
      targetName: group.name,
      prospectIds: groupProspects.map((prospect) => prospect.id)
    });
  }

  async createClient() {
    const apiKey = await this.credentials.getApolloApiKey();
    if (!apiKey) {
      throw new Error('Apollo integration is not configured. Save an Apollo API key first.');
    }
    return this.clientFactory({ apiKey });
  }

  resolveSequenceConfig(input = {}, explicitTarget = null) {
    const config = this.syncStore.getConfig();
    const targetBinding = explicitTarget?.targetType && explicitTarget?.targetId
      ? this.syncStore.getBinding(explicitTarget.targetType, explicitTarget.targetId)
      : null;
    const agentBinding = input.agentId
      ? this.syncStore.getBinding('agent', input.agentId)
      : null;

    const sequenceId = cleanString(input.sequenceId, 160)
      || targetBinding?.sequenceId
      || agentBinding?.sequenceId
      || config.defaultSequenceId
      || null;
    if (!sequenceId) {
      throw new Error('Apollo sequenceId is required or must be configured as a default/binding');
    }

    return {
      sequenceId,
      sequenceName: cleanString(input.sequenceName, 240)
        || targetBinding?.sequenceName
        || agentBinding?.sequenceName
        || config.defaultSequenceName
        || null,
      emailAccountId: cleanString(input.emailAccountId, 160)
        || targetBinding?.emailAccountId
        || agentBinding?.emailAccountId
        || config.defaultEmailAccountId
        || null,
      targetType: explicitTarget?.targetType || cleanString(input.targetType, 40) || null,
      targetId: explicitTarget?.targetId || cleanString(input.targetId, 160) || null,
      targetName: explicitTarget?.targetName || cleanString(input.targetName, 240) || null
    };
  }

  resolveProspectsFromInput(input = {}) {
    const explicitProspects = [];
    const storeProspects = this.prospects.getAllProspects({
      agentId: input.agentId || null,
      workflowId: input.workflowId || null
    });
    const byId = new Map(storeProspects.map((prospect) => [prospect.id, prospect]));

    for (const prospectId of toArray(input.prospectIds)) {
      const normalizedProspectId = cleanString(prospectId, 160);
      if (!normalizedProspectId) continue;
      const prospect = byId.get(normalizedProspectId) || this.prospects.getProspect(normalizedProspectId);
      if (prospect) {
        explicitProspects.push(prospect);
      }
    }

    for (const profileUrl of toArray(input.profileUrls)) {
      const normalizedProfileUrl = normalizeComparableProfileUrl(profileUrl);
      if (!normalizedProfileUrl) continue;
      const prospect = storeProspects.find((candidate) => normalizeComparableProfileUrl(candidate.profileUrl) === normalizedProfileUrl);
      if (prospect) {
        explicitProspects.push(prospect);
      }
    }

    for (const name of toArray(input.names)) {
      const normalizedName = normalizeComparableText(name);
      if (!normalizedName) continue;
      const prospect = storeProspects.find((candidate) => normalizeComparableText(candidate.fullName) === normalizedName);
      if (prospect) {
        explicitProspects.push(prospect);
      }
    }

    const baseline = explicitProspects.length
      ? explicitProspects
      : ((input.workflowId || input.agentId) ? storeProspects : []);

    return dedupeProspects(baseline);
  }

  resolveProspectsForGroup(group) {
    const allProspects = this.prospects.getAllProspects();
    const resolved = [];

    for (const member of toArray(group?.members)) {
      const normalizedUrl = normalizeComparableProfileUrl(member.profileUrl || member.value);
      const normalizedName = normalizeComparableText(member.fullName || member.label || member.value);
      const match = allProspects.find((prospect) => {
        if (normalizedUrl && normalizeComparableProfileUrl(prospect.profileUrl) === normalizedUrl) {
          return true;
        }
        if (normalizedName && normalizeComparableText(prospect.fullName) === normalizedName) {
          return true;
        }
        return false;
      });
      if (match) {
        resolved.push(match);
      }
    }

    return dedupeProspects(resolved);
  }

  buildDryRunResult(prospect, sequenceConfig, input = {}) {
    return {
      prospectId: prospect.id,
      fullName: prospect.fullName || null,
      profileUrl: prospect.profileUrl || null,
      status: 'dry_run',
      sequenceId: sequenceConfig.sequenceId,
      sequenceName: sequenceConfig.sequenceName,
      targetType: sequenceConfig.targetType || cleanString(input.targetType, 40) || 'workflow',
      targetId: sequenceConfig.targetId || cleanString(input.targetId, 160) || null,
      targetName: sequenceConfig.targetName || cleanString(input.targetName, 240) || null,
      reason: 'Dry run only. No Apollo API calls were made.'
    };
  }

  async syncSingleProspect(prospect, sequenceConfig, client, input = {}) {
    const existingRecord = this.syncStore.getSyncRecord(prospect.id, sequenceConfig.sequenceId);
    if (existingRecord?.status === 'enrolled' && !normalizeBoolean(input.force, false)) {
      return {
        prospectId: prospect.id,
        fullName: prospect.fullName || null,
        profileUrl: prospect.profileUrl || null,
        status: 'skipped',
        reason: 'Prospect is already recorded as enrolled in this Apollo sequence.',
        sequenceId: sequenceConfig.sequenceId,
        sequenceName: sequenceConfig.sequenceName
      };
    }

    const matchedPerson = await client.matchPerson({ prospect });
    if (!matchedPerson) {
      return this.persistSyncFailure(prospect, sequenceConfig, {
        status: 'failed',
        reason: 'Apollo could not match this prospect.',
        targetType: sequenceConfig.targetType,
        targetId: sequenceConfig.targetId,
        targetName: sequenceConfig.targetName
      });
    }

    const matchedEmail = cleanString(matchedPerson.email, 240) || null;
    if (!matchedEmail) {
      return this.persistSyncFailure(prospect, sequenceConfig, {
        status: 'skipped',
        reason: 'Apollo matched the prospect but did not provide an email address.',
        apolloPersonId: matchedPerson.id,
        targetType: sequenceConfig.targetType,
        targetId: sequenceConfig.targetId,
        targetName: sequenceConfig.targetName
      });
    }

    const existingContactId = cleanString(prospect?.metadata?.integrations?.apollo?.apolloContactId, 160) || null;
    let contact = null;
    let dedupeSource = 'create_contact';

    if (existingContactId) {
      if (typeof client.updateContact === 'function') {
        contact = await client.updateContact(existingContactId, {
          prospect,
          matchedPerson
        }).catch(() => ({ id: existingContactId, email: matchedEmail, name: matchedPerson.name || prospect.fullName || null }));
      } else {
        contact = { id: existingContactId, email: matchedEmail, name: matchedPerson.name || prospect.fullName || null };
      }
      dedupeSource = 'prospect_metadata';
    }

    if (!contact) {
      const matchedContact = await this.findExistingApolloContact(client, prospect, matchedPerson);
      if (matchedContact) {
        if (typeof client.updateContact === 'function') {
          contact = await client.updateContact(matchedContact.id, {
            prospect,
            matchedPerson
          }).catch(() => matchedContact);
        } else {
          contact = matchedContact;
        }
        dedupeSource = 'search_contacts';
      }
    }

    if (!contact) {
      contact = await client.createContact({
        prospect,
        matchedPerson,
        runDedupe: true
      });
      dedupeSource = 'create_contact';
    }

    await client.addContactsToSequence({
      sequenceId: sequenceConfig.sequenceId,
      emailAccountId: sequenceConfig.emailAccountId,
      contactIds: [contact.id]
    });

    const now = new Date().toISOString();
    const record = this.syncStore.upsertSyncRecord({
      prospectId: prospect.id,
      accountId: prospect.accountId,
      agentId: prospect.agentId,
      workflowId: prospect.workflowAssignment?.workflowId || null,
      groupId: sequenceConfig.targetType === 'group' ? sequenceConfig.targetId : null,
      targetType: sequenceConfig.targetType || 'workflow',
      targetId: sequenceConfig.targetId,
      targetName: sequenceConfig.targetName,
      sequenceId: sequenceConfig.sequenceId,
      sequenceName: sequenceConfig.sequenceName,
      emailAccountId: sequenceConfig.emailAccountId,
      status: 'enrolled',
      reason: null,
      apolloPersonId: matchedPerson.id,
      apolloContactId: contact.id,
      apolloEmail: matchedEmail,
      dryRun: false,
      lastSyncedAt: now,
      metadata: {
        linkedInProfileUrl: prospect.profileUrl || null,
        dedupeSource
      }
    });

    this.patchProspectApolloMetadata(prospect.id, {
      enabled: true,
      status: 'enrolled',
      lastSequenceId: sequenceConfig.sequenceId,
      lastSequenceName: sequenceConfig.sequenceName,
      lastSyncedAt: now,
      apolloPersonId: matchedPerson.id,
      apolloContactId: contact.id,
      email: matchedEmail,
      dedupeSource,
      targetType: sequenceConfig.targetType || 'workflow',
      targetId: sequenceConfig.targetId || null
    });

    return {
      prospectId: prospect.id,
      fullName: prospect.fullName || null,
      profileUrl: prospect.profileUrl || null,
      status: record.status,
      sequenceId: sequenceConfig.sequenceId,
      sequenceName: sequenceConfig.sequenceName,
      apolloPersonId: matchedPerson.id,
      apolloContactId: contact.id,
      email: matchedEmail,
      dedupeSource
    };
  }

  persistSyncFailure(prospect, sequenceConfig, recordInput = {}) {
    const now = new Date().toISOString();
    const record = this.syncStore.upsertSyncRecord({
      prospectId: prospect.id,
      accountId: prospect.accountId,
      agentId: prospect.agentId,
      workflowId: prospect.workflowAssignment?.workflowId || null,
      groupId: sequenceConfig.targetType === 'group' ? sequenceConfig.targetId : null,
      targetType: sequenceConfig.targetType || 'workflow',
      targetId: sequenceConfig.targetId,
      targetName: sequenceConfig.targetName,
      sequenceId: sequenceConfig.sequenceId,
      sequenceName: sequenceConfig.sequenceName,
      emailAccountId: sequenceConfig.emailAccountId,
      dryRun: false,
      lastSyncedAt: now,
      ...recordInput
    });

    this.patchProspectApolloMetadata(prospect.id, {
      enabled: true,
      status: record.status,
      lastSequenceId: sequenceConfig.sequenceId,
      lastSequenceName: sequenceConfig.sequenceName,
      lastSyncedAt: now,
      apolloPersonId: record.apolloPersonId || null,
      apolloContactId: record.apolloContactId || null,
      error: record.reason || null,
      targetType: sequenceConfig.targetType || 'workflow',
      targetId: sequenceConfig.targetId || null
    });

    return {
      prospectId: prospect.id,
      fullName: prospect.fullName || null,
      profileUrl: prospect.profileUrl || null,
      status: record.status,
      reason: record.reason,
      sequenceId: sequenceConfig.sequenceId,
      sequenceName: sequenceConfig.sequenceName,
      apolloPersonId: record.apolloPersonId || null,
      apolloContactId: record.apolloContactId || null
    };
  }

  patchProspectApolloMetadata(prospectId, apolloPatch = {}) {
    if (!prospectId || typeof this.prospects.updateProspectMetadata !== 'function') {
      return null;
    }
    return this.prospects.updateProspectMetadata(prospectId, {
      integrations: {
        apollo: {
          ...apolloPatch
        }
      }
    });
  }

  async findExistingApolloContact(client, prospect, matchedPerson) {
    if (typeof client.searchContacts !== 'function') {
      return null;
    }
    const contacts = await client.searchContacts({
      prospect,
      matchedPerson,
      limit: 10
    }).catch(() => []);
    if (!Array.isArray(contacts) || !contacts.length) {
      return null;
    }

    const targetEmail = cleanString(matchedPerson?.email, 240).toLowerCase();
    const targetLinkedIn = normalizeComparableProfileUrl(matchedPerson?.linkedinUrl || prospect?.profileUrl);
    const targetName = normalizeComparableText(matchedPerson?.name || prospect?.fullName);
    const targetCompany = normalizeComparableText(matchedPerson?.organizationName || prospect?.company);

    return contacts.find((contact) => {
      if (targetEmail && cleanString(contact.email, 240).toLowerCase() === targetEmail) {
        return true;
      }
      if (targetLinkedIn && normalizeComparableProfileUrl(contact.linkedinUrl) === targetLinkedIn) {
        return true;
      }
      if (
        targetName
        && normalizeComparableText(contact.name) === targetName
        && (!targetCompany || normalizeComparableText(contact.organizationName) === targetCompany)
      ) {
        return true;
      }
      return false;
    }) || null;
  }
}

function buildSyncSummary(results = [], sequenceConfig = {}, dryRun = false) {
  const summary = {
    sequenceId: sequenceConfig.sequenceId,
    sequenceName: sequenceConfig.sequenceName || null,
    emailAccountId: sequenceConfig.emailAccountId || null,
    dryRun: Boolean(dryRun),
    attempted: results.length,
    enrolled: 0,
    skipped: 0,
    failed: 0,
    results
  };
  for (const result of results) {
    if (result.status === 'enrolled') {
      summary.enrolled += 1;
    } else if (result.status === 'failed') {
      summary.failed += 1;
    } else {
      summary.skipped += 1;
    }
  }
  return summary;
}

function summarizeSyncRecords(records = []) {
  const summary = {
    total: 0,
    enrolled: 0,
    skipped: 0,
    failed: 0,
    dryRun: 0
  };
  for (const record of records) {
    summary.total += 1;
    if (record.status === 'enrolled') {
      summary.enrolled += 1;
    } else if (record.status === 'failed') {
      summary.failed += 1;
    } else if (record.status === 'dry_run') {
      summary.dryRun += 1;
    } else {
      summary.skipped += 1;
    }
  }
  return summary;
}

function dedupeProspects(prospects = []) {
  const seen = new Set();
  const next = [];
  for (const prospect of prospects) {
    if (!prospect || !prospect.id || seen.has(prospect.id)) continue;
    seen.add(prospect.id);
    next.push(prospect);
  }
  return next;
}

function normalizeComparableProfileUrl(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, '')
    .replace(/\/(recent-activity|details)\/.*$/, '/')
    .replace(/\/+$/, '/');
}

function normalizeComparableText(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
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

function sanitizeApolloPayload(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const next = value.map((item) => sanitizeApolloPayload(item)).filter((item) => item !== undefined);
    return next.length ? next : undefined;
  }
  if (typeof value === 'object') {
    const next = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const normalizedKey = cleanString(key, 120);
      const normalizedValue = sanitizeApolloPayload(nestedValue);
      if (normalizedKey && normalizedValue !== undefined) {
        next[normalizedKey] = normalizedValue;
      }
    }
    return Object.keys(next).length ? next : undefined;
  }
  if (typeof value === 'string') {
    const normalized = cleanString(value, 500);
    return normalized || undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  return cleanString(value, 500) || undefined;
}

function normalizePositiveInteger(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return Math.floor(normalized);
}

function normalizeApolloPerPage(value) {
  return Math.max(1, Math.min(100, normalizePositiveInteger(value) || 25));
}

module.exports = ApolloSyncService;
