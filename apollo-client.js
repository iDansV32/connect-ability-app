'use strict';

class ApolloClient {
  constructor(options = {}) {
    this.apiKey = String(options.apiKey || '').trim();
    this.baseUrl = String(options.baseUrl || 'https://api.apollo.io/api/v1').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl || global.fetch;
    if (!this.apiKey) {
      throw new Error('Apollo API key is required');
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('Apollo client requires a fetch implementation');
    }
  }

  async searchSequences(params = {}) {
    const payload = {
      q: String(params.query || '').trim() || undefined,
      page: Number(params.page) > 0 ? Number(params.page) : 1,
      per_page: Math.max(1, Math.min(100, Number(params.perPage) || 100))
    };
    const response = await this.request('/emailer_campaigns/search', {
      method: 'POST',
      body: payload
    });
    const candidates = [
      ...toArray(response?.sequences),
      ...toArray(response?.emailer_campaigns),
      ...toArray(response?.campaigns)
    ];
    return candidates.map(normalizeSequence).filter(Boolean);
  }

  async searchPeople(params = {}) {
    const query = normalizeApolloQueryPayload(params);
    if (!Object.keys(query).length) {
      throw new Error('Apollo people search requires at least one search filter');
    }
    const response = await this.request('/mixed_people/api_search', {
      method: 'POST',
      query
    });
    const people = [
      ...toArray(response?.people),
      ...toArray(response?.results),
      ...toArray(response?.contacts)
    ].map(normalizeApolloPersonSearchResult).filter(Boolean);
    return {
      totalEntries: Number(response?.total_entries || response?.totalEntries || people.length) || people.length,
      page: Number(response?.page || query.page || 1) || 1,
      perPage: Number(response?.per_page || query.per_page || people.length) || people.length,
      people,
      raw: response
    };
  }

  async listEmailAccounts() {
    const response = await this.request('/email_accounts', {
      method: 'GET'
    });
    const candidates = [
      ...toArray(response?.email_accounts),
      ...toArray(response?.accounts),
      ...toArray(response)
    ];
    return candidates.map(normalizeEmailAccount).filter(Boolean);
  }

  async matchPerson(input = {}) {
    const payload = buildPersonMatchPayload(input);
    if (!payload.linkedin_url && !payload.email && !(payload.first_name && payload.last_name) && !(payload.name && payload.organization_name)) {
      return null;
    }
    const response = await this.request('/people/match', {
      method: 'POST',
      body: payload
    });
    return normalizeMatchedPerson(response);
  }

  async searchContacts(input = {}) {
    const queries = buildContactSearchQueries(input);
    const seenContactIds = new Set();
    const results = [];

    for (const query of queries) {
      const response = await this.request('/contacts/search', {
        method: 'POST',
        body: {
          q_keywords: query,
          page: 1,
          per_page: Math.max(1, Math.min(25, Number(input.limit) || 10))
        }
      });
      const candidates = [
        ...toArray(response?.contacts),
        ...toArray(response?.people),
        ...toArray(response?.results)
      ];
      for (const candidate of candidates) {
        const normalized = normalizeApolloContact(candidate);
        if (!normalized?.id || seenContactIds.has(normalized.id)) continue;
        seenContactIds.add(normalized.id);
        results.push(normalized);
      }
    }

    return results;
  }

  async createContact(input = {}) {
    const payload = buildCreateContactPayload(input);
    const response = await this.request('/contacts', {
      method: 'POST',
      body: payload
    });
    const contact = normalizeApolloContact(response?.contact || response?.contacts?.[0] || response);
    if (!contact) {
      throw new Error('Apollo create contact response did not include a contact');
    }
    return contact;
  }

  async getContact(contactId) {
    const normalizedContactId = cleanString(contactId, 160);
    if (!normalizedContactId) {
      throw new Error('Apollo contactId is required');
    }
    const response = await this.request(`/contacts/${encodeURIComponent(normalizedContactId)}`, {
      method: 'GET'
    });
    return normalizeApolloContact(response?.contact || response);
  }

  async updateContact(contactId, input = {}) {
    const normalizedContactId = cleanString(contactId, 160);
    if (!normalizedContactId) {
      throw new Error('Apollo contactId is required for update');
    }
    const payload = buildCreateContactPayload(input);
    delete payload.run_dedupe;
    const response = await this.request(`/contacts/${encodeURIComponent(normalizedContactId)}`, {
      method: 'PATCH',
      body: payload
    });
    return normalizeApolloContact(response?.contact || response);
  }

  async searchAccounts(params = {}) {
    const payload = {
      ...normalizeApolloQueryPayload(params.filters),
      q_keywords: cleanString(params.query, 240) || undefined,
      page: Number(params.page) > 0 ? Number(params.page) : 1,
      per_page: Math.max(1, Math.min(100, Number(params.perPage) || 25))
    };
    const response = await this.request('/accounts/search', {
      method: 'POST',
      body: payload
    });
    const accounts = [
      ...toArray(response?.accounts),
      ...toArray(response?.organizations),
      ...toArray(response?.results)
    ].map(normalizeApolloAccount).filter(Boolean);
    return {
      totalEntries: Number(response?.total_entries || response?.totalEntries || accounts.length) || accounts.length,
      page: Number(response?.page || payload.page || 1) || 1,
      perPage: Number(response?.per_page || payload.per_page || accounts.length) || accounts.length,
      accounts,
      raw: response
    };
  }

  async getAccount(accountId) {
    const normalizedAccountId = cleanString(accountId, 160);
    if (!normalizedAccountId) {
      throw new Error('Apollo accountId is required');
    }
    const response = await this.request(`/accounts/${encodeURIComponent(normalizedAccountId)}`, {
      method: 'GET'
    });
    return normalizeApolloAccount(response?.account || response);
  }

  async createAccount(input = {}) {
    return this.request('/accounts', {
      method: 'POST',
      body: normalizeApolloQueryPayload(input)
    });
  }

  async updateAccount(accountId, input = {}) {
    const normalizedAccountId = cleanString(accountId, 160);
    if (!normalizedAccountId) {
      throw new Error('Apollo accountId is required for update');
    }
    return this.request(`/accounts/${encodeURIComponent(normalizedAccountId)}`, {
      method: 'PATCH',
      body: normalizeApolloQueryPayload(input)
    });
  }

  async listUsers(params = {}) {
    const response = await this.request('/users/search', {
      method: 'GET',
      query: {
        page: Number(params.page) > 0 ? Number(params.page) : undefined,
        per_page: Number(params.perPage) > 0 ? Math.min(100, Number(params.perPage)) : undefined
      }
    });
    return [
      ...toArray(response?.users),
      ...toArray(response?.results),
      ...toArray(response)
    ].map(normalizeApolloUser).filter(Boolean);
  }

  async listLabels() {
    const response = await this.request('/labels', { method: 'GET' });
    return [
      ...toArray(response?.labels),
      ...toArray(response?.lists),
      ...toArray(response)
    ].map(normalizeApolloLabel).filter(Boolean);
  }

  async listFields() {
    const response = await this.request('/fields', { method: 'GET' });
    return [
      ...toArray(response?.fields),
      ...toArray(response)
    ].map(normalizeApolloField).filter(Boolean);
  }

  async listContactStages() {
    const response = await this.request('/contact_stages', { method: 'GET' });
    return [
      ...toArray(response?.contact_stages),
      ...toArray(response?.stages),
      ...toArray(response)
    ].map(normalizeApolloStage).filter(Boolean);
  }

  async updateContactStages(input = {}) {
    return this.request('/contacts/update_stages', {
      method: 'POST',
      body: normalizeApolloQueryPayload(input)
    });
  }

  async updateContactOwners(input = {}) {
    return this.request('/contacts/update_owners', {
      method: 'POST',
      body: normalizeApolloQueryPayload(input)
    });
  }

  async bulkCreateContacts(input = {}) {
    return this.request('/contacts/bulk_create', {
      method: 'POST',
      body: normalizeApolloQueryPayload(input)
    });
  }

  async bulkUpdateContacts(input = {}) {
    return this.request('/contacts/bulk_update', {
      method: 'POST',
      body: normalizeApolloQueryPayload(input)
    });
  }

  async searchDeals(params = {}) {
    const response = await this.request('/opportunities/search', {
      method: 'GET',
      query: normalizeApolloQueryPayload(params)
    });
    return [
      ...toArray(response?.opportunities),
      ...toArray(response?.deals),
      ...toArray(response?.results)
    ].map(normalizeApolloDeal).filter(Boolean);
  }

  async getDeal(opportunityId) {
    const normalizedOpportunityId = cleanString(opportunityId, 160);
    if (!normalizedOpportunityId) {
      throw new Error('Apollo opportunityId is required');
    }
    const response = await this.request(`/opportunities/${encodeURIComponent(normalizedOpportunityId)}`, {
      method: 'GET'
    });
    return normalizeApolloDeal(response?.opportunity || response?.deal || response);
  }

  async createDeal(input = {}) {
    return this.request('/opportunities', {
      method: 'POST',
      body: normalizeApolloQueryPayload(input)
    });
  }

  async updateDeal(opportunityId, input = {}) {
    const normalizedOpportunityId = cleanString(opportunityId, 160);
    if (!normalizedOpportunityId) {
      throw new Error('Apollo opportunityId is required for update');
    }
    return this.request(`/opportunities/${encodeURIComponent(normalizedOpportunityId)}`, {
      method: 'PATCH',
      body: normalizeApolloQueryPayload(input)
    });
  }

  async listDealStages() {
    const response = await this.request('/opportunity_stages', { method: 'GET' });
    return [
      ...toArray(response?.opportunity_stages),
      ...toArray(response?.stages),
      ...toArray(response)
    ].map(normalizeApolloStage).filter(Boolean);
  }

  async searchTasks(params = {}) {
    const payload = {
      ...normalizeApolloQueryPayload(params.filters),
      page: Number(params.page) > 0 ? Number(params.page) : 1,
      per_page: Math.max(1, Math.min(100, Number(params.perPage) || 25))
    };
    const response = await this.request('/tasks/search', {
      method: 'POST',
      body: payload
    });
    return [
      ...toArray(response?.tasks),
      ...toArray(response?.results)
    ].map(normalizeApolloTask).filter(Boolean);
  }

  async createTask(input = {}) {
    return this.request('/tasks', {
      method: 'POST',
      body: normalizeApolloQueryPayload(input)
    });
  }

  async bulkCreateTasks(input = {}) {
    return this.request('/tasks/bulk_create', {
      method: 'POST',
      body: normalizeApolloQueryPayload(input)
    });
  }

  async createCallRecord(input = {}) {
    return this.request('/phone_calls', {
      method: 'POST',
      body: normalizeApolloQueryPayload(input)
    });
  }

  async searchCalls(params = {}) {
    return this.request('/phone_calls/search', {
      method: 'GET',
      query: normalizeApolloQueryPayload(params)
    });
  }

  async updateCallRecord(callId, input = {}) {
    const normalizedCallId = cleanString(callId, 160);
    if (!normalizedCallId) {
      throw new Error('Apollo callId is required for update');
    }
    return this.request(`/phone_calls/${encodeURIComponent(normalizedCallId)}`, {
      method: 'PUT',
      body: normalizeApolloQueryPayload(input)
    });
  }

  async addContactsToSequence(input = {}) {
    const sequenceId = String(input.sequenceId || '').trim();
    const contactIds = toArray(input.contactIds).map((value) => String(value || '').trim()).filter(Boolean);
    if (!sequenceId) {
      throw new Error('Apollo sequenceId is required');
    }
    if (!contactIds.length) {
      throw new Error('Apollo contactIds are required');
    }
    const payload = {
      contact_ids: contactIds
    };
    const emailAccountId = String(input.emailAccountId || '').trim();
    if (emailAccountId) {
      payload.email_account_id = emailAccountId;
    }
    return this.request(`/emailer_campaigns/${encodeURIComponent(sequenceId)}/add_contact_ids`, {
      method: 'POST',
      body: payload
    });
  }

  async updateSequenceContactStatus(input = {}) {
    return this.request('/emailer_campaigns/remove_or_stop_contact_ids', {
      method: 'POST',
      body: normalizeApolloQueryPayload(input)
    });
  }

  async activateSequence(sequenceId) {
    const normalizedSequenceId = cleanString(sequenceId, 160);
    if (!normalizedSequenceId) {
      throw new Error('Apollo sequenceId is required');
    }
    return this.request(`/emailer_campaigns/${encodeURIComponent(normalizedSequenceId)}/approve`, {
      method: 'POST'
    });
  }

  async apiRequest(input = {}) {
    return this.request(input.path, {
      method: input.method,
      query: input.query,
      body: input.body
    });
  }

  async request(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const normalizedPath = normalizeApolloApiPath(path);
    const url = buildApolloUrl(this.baseUrl, normalizedPath, options.query);
    const headers = {
      Accept: 'application/json',
      'X-Api-Key': this.apiKey
    };
    const requestOptions = {
      method,
      headers
    };
    if ((method === 'GET' || method === 'HEAD') && options.body !== undefined) {
      throw new Error(`Apollo ${method} requests cannot include a JSON body`);
    }
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestOptions.body = JSON.stringify(options.body);
    }

    const response = await this.fetchImpl(url, requestOptions);
    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch (_error) {
      payload = rawText;
    }

    if (!response.ok) {
      const message = resolveApolloErrorMessage(payload) || `${response.status} ${response.statusText || 'Apollo API request failed'}`;
      throw new Error(`Apollo API error (${response.status}): ${message}`);
    }

    return payload;
  }
}

function buildPersonMatchPayload(input = {}) {
  const prospect = input.prospect || {};
  const matched = input.matchedPerson || {};
  const name = cleanString(matched.name || prospect.fullName, 240);
  const [firstName, lastName] = splitFullName(name);
  return {
    linkedin_url: cleanString(matched.linkedinUrl || matched.linkedin_url || prospect.profileUrl, 400) || undefined,
    email: cleanString(matched.email || prospect.email, 240) || undefined,
    first_name: cleanString(matched.firstName || firstName, 120) || undefined,
    last_name: cleanString(matched.lastName || lastName, 120) || undefined,
    name: name || undefined,
    organization_name: cleanString(matched.organizationName || prospect.company, 200) || undefined,
    title: cleanString(matched.title || prospect.title, 200) || undefined
  };
}

function buildCreateContactPayload(input = {}) {
  const prospect = input.prospect || {};
  const matched = input.matchedPerson || {};
  const name = cleanString(matched.name || prospect.fullName, 240);
  const [firstName, lastName] = splitFullName(name);
  return {
    first_name: cleanString(matched.firstName || firstName, 120) || undefined,
    last_name: cleanString(matched.lastName || lastName, 120) || undefined,
    name: name || undefined,
    email: cleanString(matched.email, 240) || undefined,
    linkedin_url: cleanString(matched.linkedinUrl || prospect.profileUrl, 400) || undefined,
    title: cleanString(matched.title || prospect.title, 200) || undefined,
    organization_name: cleanString(matched.organizationName || prospect.company, 200) || undefined,
    run_dedupe: input.runDedupe !== false
  };
}

function buildContactSearchQueries(input = {}) {
  const prospect = input.prospect || {};
  const matched = input.matchedPerson || {};
  const candidates = [
    cleanString(input.query, 240),
    cleanString(input.email || matched.email || prospect.email, 240),
    cleanString(input.linkedinUrl || matched.linkedinUrl || prospect.profileUrl, 400),
    [cleanString(matched.name || prospect.fullName, 240), cleanString(matched.organizationName || prospect.company, 200)].filter(Boolean).join(' '),
    cleanString(matched.name || prospect.fullName, 240)
  ];
  const seen = new Set();
  return candidates.filter(Boolean).filter((candidate) => {
    const key = candidate.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeMatchedPerson(response = {}) {
  const candidate = response?.person || response?.matched_person || response?.people?.[0] || response;
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }
  const normalized = {
    id: cleanString(candidate.id || candidate.person_id, 160) || null,
    contactId: cleanString(
      candidate.contact_id
      || candidate.contactId
      || candidate.contact?.id,
      160
    ) || null,
    email: cleanString(
      candidate.email
      || candidate.email_address
      || candidate.work_email
      || candidate.organization_email,
      240
    ) || null,
    name: cleanString(candidate.name || [candidate.first_name, candidate.last_name].filter(Boolean).join(' '), 240) || null,
    firstName: cleanString(candidate.first_name, 120) || null,
    lastName: cleanString(candidate.last_name, 120) || null,
    linkedinUrl: cleanString(candidate.linkedin_url, 400) || null,
    title: cleanString(candidate.title || candidate.headline, 200) || null,
    organizationName: cleanString(candidate.organization_name || candidate.organization?.name || candidate.company, 200) || null,
    raw: candidate
  };
  return normalized.id || normalized.email || normalized.linkedinUrl || normalized.name ? normalized : null;
}

function normalizeApolloContact(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const normalized = {
    id: cleanString(candidate.id || candidate.contact_id, 160) || null,
    personId: cleanString(candidate.person_id || candidate.person?.id, 160) || null,
    email: cleanString(candidate.email || candidate.email_address, 240) || null,
    name: cleanString(candidate.name || [candidate.first_name, candidate.last_name].filter(Boolean).join(' '), 240) || null,
    firstName: cleanString(candidate.first_name, 120) || null,
    lastName: cleanString(candidate.last_name, 120) || null,
    linkedinUrl: cleanString(candidate.linkedin_url, 400) || null,
    title: cleanString(candidate.title || candidate.headline, 200) || null,
    organizationName: cleanString(candidate.organization_name || candidate.organization?.name || candidate.company, 200) || null,
    ownerId: cleanString(candidate.owner_id || candidate.user_id || candidate.contact_owner_id, 160) || null,
    stageId: cleanString(candidate.contact_stage_id || candidate.stage_id, 160) || null,
    stageName: cleanString(
      candidate.contact_stage_name
      || candidate.contact_stage?.name
      || candidate.stage_name
      || candidate.lifecycle_stage_name
      || candidate.lifecycle_stage,
      200
    ) || null,
    lifecycleStage: cleanString(candidate.lifecycle_stage || candidate.lifecycle_stage_name, 200) || null,
    updatedAt: cleanString(candidate.updated_at || candidate.modified_at, 80) || null,
    raw: candidate
  };
  return normalized.id ? normalized : null;
}

function normalizeApolloPersonSearchResult(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const firstName = cleanString(candidate.first_name, 120);
  const lastName = cleanString(candidate.last_name || candidate.last_name_obfuscated, 120);
  const normalized = {
    id: cleanString(candidate.id || candidate.person_id, 160) || null,
    name: cleanString(candidate.name || [firstName, lastName].filter(Boolean).join(' '), 240) || null,
    firstName: firstName || null,
    lastName: lastName || null,
    title: cleanString(candidate.title || candidate.headline, 200) || null,
    email: cleanString(candidate.email || candidate.email_address, 240) || null,
    linkedinUrl: cleanString(candidate.linkedin_url, 400) || null,
    organizationName: cleanString(candidate.organization?.name || candidate.organization_name || candidate.company, 200) || null,
    location: cleanString(
      candidate.location
      || [candidate.city, candidate.state, candidate.country].filter(Boolean).join(', '),
      240
    ) || null,
    hasEmail: candidate.has_email === true || candidate.has_email === 'true',
    raw: candidate
  };
  return normalized.id || normalized.name ? normalized : null;
}

function normalizeSequence(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = cleanString(candidate.id || candidate.sequence_id || candidate.emailer_campaign_id, 160);
  if (!id) return null;
  return {
    id,
    name: cleanString(candidate.name || candidate.sequence_name, 240) || id,
    status: cleanString(candidate.status || candidate.state, 80) || null,
    raw: candidate
  };
}

function normalizeApolloAccount(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = cleanString(candidate.id || candidate.account_id || candidate.organization_id, 160);
  if (!id) return null;
  return {
    id,
    name: cleanString(candidate.name || candidate.organization_name, 240) || id,
    domain: cleanString(candidate.domain || candidate.website_url, 240) || null,
    ownerId: cleanString(candidate.owner_id, 160) || null,
    stageId: cleanString(candidate.account_stage_id || candidate.stage_id, 160) || null,
    raw: candidate
  };
}

function normalizeApolloUser(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = cleanString(candidate.id || candidate.user_id, 160);
  if (!id) return null;
  return {
    id,
    name: cleanString(candidate.name || [candidate.first_name, candidate.last_name].filter(Boolean).join(' '), 240) || id,
    email: cleanString(candidate.email, 240) || null,
    title: cleanString(candidate.title, 200) || null,
    role: cleanString(
      candidate.role
      || candidate.user_role
      || candidate.role_name
      || candidate.department
      || candidate.team_name
      || candidate.team,
      200
    ) || null,
    raw: candidate
  };
}

function normalizeApolloLabel(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = cleanString(candidate.id || candidate.label_id || candidate.list_id, 160);
  if (!id) return null;
  return {
    id,
    name: cleanString(candidate.name || candidate.label_name, 240) || id,
    type: cleanString(candidate.type || candidate.label_type, 80) || null,
    raw: candidate
  };
}

function normalizeApolloField(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = cleanString(candidate.id || candidate.field_id, 160);
  if (!id) return null;
  return {
    id,
    name: cleanString(candidate.name || candidate.api_name, 240) || id,
    entityType: cleanString(candidate.entity_type || candidate.object_type, 120) || null,
    fieldType: cleanString(candidate.field_type || candidate.data_type || candidate.type, 120) || null,
    raw: candidate
  };
}

function normalizeApolloStage(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = cleanString(candidate.id || candidate.stage_id, 160);
  if (!id) return null;
  return {
    id,
    name: cleanString(candidate.name || candidate.stage_name, 240) || id,
    raw: candidate
  };
}

function normalizeApolloDeal(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = cleanString(candidate.id || candidate.opportunity_id, 160);
  if (!id) return null;
  return {
    id,
    name: cleanString(candidate.name || candidate.opportunity_name, 240) || id,
    accountId: cleanString(candidate.account_id || candidate.organization_id, 160) || null,
    contactId: cleanString(candidate.contact_id || candidate.person_id || candidate.contact?.id, 160) || null,
    ownerId: cleanString(candidate.owner_id, 160) || null,
    stageId: cleanString(candidate.opportunity_stage_id || candidate.stage_id, 160) || null,
    stageName: cleanString(
      candidate.opportunity_stage_name
      || candidate.stage_name
      || candidate.stage?.name,
      200
    ) || null,
    status: cleanString(candidate.status || candidate.state, 80) || null,
    amount: candidate.amount ?? candidate.value ?? null,
    updatedAt: cleanString(candidate.updated_at || candidate.modified_at, 80) || null,
    closedAt: cleanString(candidate.closed_at || candidate.closed_date, 80) || null,
    raw: candidate
  };
}

function normalizeApolloTask(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = cleanString(candidate.id || candidate.task_id, 160);
  if (!id) return null;
  return {
    id,
    type: cleanString(candidate.type || candidate.task_type, 120) || null,
    subject: cleanString(candidate.subject || candidate.title || candidate.description, 240) || id,
    status: cleanString(candidate.status, 80) || null,
    contactId: cleanString(candidate.contact_id, 160) || null,
    ownerId: cleanString(candidate.user_id || candidate.owner_id, 160) || null,
    dueAt: cleanString(candidate.due_at || candidate.due_date, 80) || null,
    createdAt: cleanString(candidate.created_at, 80) || null,
    updatedAt: cleanString(candidate.updated_at || candidate.modified_at, 80) || null,
    completedAt: cleanString(candidate.completed_at || candidate.completed_date || candidate.done_at, 80) || null,
    raw: candidate
  };
}

function normalizeEmailAccount(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = cleanString(candidate.id || candidate.email_account_id, 160);
  if (!id) return null;
  return {
    id,
    email: cleanString(candidate.email || candidate.address, 240) || null,
    label: cleanString(candidate.label || candidate.email || candidate.address, 240) || id,
    raw: candidate
  };
}

function resolveApolloErrorMessage(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload.trim();
  return cleanString(
    payload.error
    || payload.message
    || payload.errors?.[0]?.message
    || payload.errors?.[0]
    || payload.detail,
    500
  );
}

function splitFullName(name = '') {
  const normalized = cleanString(name, 240);
  if (!normalized) return ['', ''];
  const parts = normalized.split(' ').filter(Boolean);
  if (parts.length === 1) {
    return [parts[0], ''];
  }
  return [parts[0], parts.slice(1).join(' ')];
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanString(value, maxLength = 200) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeApolloApiPath(value = '') {
  const input = cleanString(value, 500);
  if (!input) {
    throw new Error('Apollo path is required');
  }

  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (url.hostname !== 'api.apollo.io') {
      throw new Error('Apollo API requests must target api.apollo.io');
    }
    return normalizeApolloApiPath(`${url.pathname}${url.search}`);
  }

  const normalized = input.startsWith('/') ? input : `/${input}`;
  if (!normalized.startsWith('/api/v1/') && normalized !== '/api/v1') {
    return normalized;
  }
  const trimmed = normalized.replace(/^\/api\/v1/, '') || '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function buildApolloUrl(baseUrl, path, query) {
  const url = new URL(`${baseUrl}${path}`);
  appendApolloQuery(url.searchParams, normalizeApolloQueryPayload(query));
  return url.toString();
}

function appendApolloQuery(searchParams, query = {}) {
  for (const [key, value] of Object.entries(query || {})) {
    const normalizedKey = cleanString(key, 120);
    if (!normalizedKey || value === undefined || value === null || value === '') {
      continue;
    }
    if (Array.isArray(value)) {
      const arrayKey = normalizedKey.endsWith('[]') ? normalizedKey : `${normalizedKey}[]`;
      for (const item of value) {
        appendApolloQueryValue(searchParams, arrayKey, item);
      }
      continue;
    }
    appendApolloQueryValue(searchParams, normalizedKey, value);
  }
}

function appendApolloQueryValue(searchParams, key, value) {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      appendApolloQueryValue(searchParams, key, item);
    }
    return;
  }
  if (typeof value === 'object') {
    searchParams.append(key, JSON.stringify(value));
    return;
  }
  searchParams.append(key, String(value));
}

function normalizeApolloQueryPayload(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const next = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = cleanString(key, 120);
    if (!normalizedKey) continue;
    const normalizedValue = normalizeApolloQueryValue(rawValue);
    if (normalizedValue === undefined) continue;
    next[normalizedKey] = normalizedValue;
  }
  return next;
}

function normalizeApolloQueryValue(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) {
    const next = value.map(normalizeApolloQueryValue).filter((item) => item !== undefined);
    return next.length ? next : undefined;
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
  if (typeof value === 'object') {
    const next = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const normalizedKey = cleanString(key, 120);
      const normalizedNestedValue = normalizeApolloQueryValue(nestedValue);
      if (normalizedKey && normalizedNestedValue !== undefined) {
        next[normalizedKey] = normalizedNestedValue;
      }
    }
    return Object.keys(next).length ? next : undefined;
  }
  return cleanString(value, 500) || undefined;
}

module.exports = ApolloClient;
