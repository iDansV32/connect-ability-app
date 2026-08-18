const test = require('node:test');
const assert = require('node:assert/strict');

const ApolloSyncService = require('../apollo-sync-service');
const ApolloSyncStore = require('../apollo-sync-store');
const ProspectQueueStore = require('../prospect-queue-store');
const WorkflowTemplateStore = require('../workflow-template-store');
const GroupDataStore = require('../group-data-store');
const { createTempWorkspace, writeJson } = require('./test-helpers');

test('ApolloSyncService configures secure settings without exposing the API key', async () => {
  const workspace = createTempWorkspace('apollo-sync-service-config-');
  let storedApiKey = null;
  try {
    const service = new ApolloSyncService({
      syncStore: new ApolloSyncStore({ storePath: workspace.path('apollo-sync.json') }),
      prospects: new ProspectQueueStore({ storePath: workspace.path('prospects.json') }),
      templates: new WorkflowTemplateStore({
        storePath: workspace.path('workflow-templates.json'),
        legacyWorkflowsDir: workspace.path('legacy-workflows')
      }),
      groups: new GroupDataStore({ paths: [workspace.path('groups.json')] }),
      clientFactory: () => {
        throw new Error('Apollo client should not be created in this config test');
      },
      getApolloApiKey: async () => storedApiKey,
      hasApolloApiKey: async () => Boolean(storedApiKey),
      setApolloApiKey: async (apiKey) => {
        storedApiKey = String(apiKey || '');
        return true;
      },
      deleteApolloApiKey: async () => {
        storedApiKey = null;
        return true;
      }
    });

    const config = await service.configureIntegration({
      apiKey: 'apollo-secret',
      defaultSequenceId: 'seq-1',
      defaultSequenceName: 'Default Apollo Sequence',
      enabled: true
    });

    assert.equal(config.hasApiKey, true);
    assert.equal(config.defaultSequenceId, 'seq-1');

    const integration = await service.getIntegration();
    assert.equal(integration.hasApiKey, true);
    assert.equal(Object.prototype.hasOwnProperty.call(integration, 'apiKey'), false);
  } finally {
    workspace.cleanup();
  }
});

test('ApolloSyncService enrolls workflow prospects and patches prospect metadata', async () => {
  const workspace = createTempWorkspace('apollo-sync-service-workflow-');
  let addToSequenceCalls = 0;
  try {
    const syncStore = new ApolloSyncStore({ storePath: workspace.path('apollo-sync.json') });
    const prospectStore = new ProspectQueueStore({ storePath: workspace.path('prospects.json') });
    const templateStore = new WorkflowTemplateStore({
      storePath: workspace.path('workflow-templates.json'),
      legacyWorkflowsDir: workspace.path('legacy-workflows')
    });

    templateStore.saveAutomationWorkflow({
      id: 'wf-1',
      name: 'Head of AI Sequence',
      agentId: 'agent-1',
      target: { type: 'profiles', label: 'Imported prospects', profileUrls: [] },
      steps: [{ type: 'send_dm', order: 1, messageTemplate: 'Hello there' }]
    });
    prospectStore.upsertWorkflowTargets({
      accountId: 'account-1',
      agentId: 'agent-1',
      workflowId: 'wf-1',
      workflowName: 'Head of AI Sequence',
      targetType: 'profiles',
      targets: [{
        value: 'https://www.linkedin.com/in/jane-doe/',
        label: 'Jane Doe',
        title: 'Head of AI',
        company: 'Acme'
      }]
    });

    syncStore.saveBinding({
      targetType: 'workflow',
      targetId: 'wf-1',
      sequenceId: 'seq-1',
      sequenceName: 'Apollo Outbound'
    });

    const service = new ApolloSyncService({
      syncStore,
      prospects: prospectStore,
      templates: templateStore,
      groups: new GroupDataStore({ paths: [workspace.path('groups.json')] }),
      clientFactory: () => ({
        matchPerson: async (payload) => ({
          id: 'person-1',
          email: 'jane@acme.com',
          name: payload.prospect.fullName,
          linkedinUrl: payload.prospect.profileUrl,
          organizationName: payload.prospect.company
        }),
        createContact: async () => ({
          id: 'contact-1',
          email: 'jane@acme.com',
          name: 'Jane Doe'
        }),
        addContactsToSequence: async () => {
          addToSequenceCalls += 1;
          return { success: true };
        }
      }),
      getApolloApiKey: async () => 'apollo-secret',
      hasApolloApiKey: async () => true,
      setApolloApiKey: async () => true,
      deleteApolloApiKey: async () => true
    });

    const result = await service.syncWorkflowToSequence({ workflowId: 'wf-1' });

    assert.equal(result.enrolled, 1);
    assert.equal(addToSequenceCalls, 1);

    const [prospect] = prospectStore.getAllProspects({ workflowId: 'wf-1' });
    assert.equal(prospect.metadata.integrations.apollo.apolloContactId, 'contact-1');
    assert.equal(prospect.metadata.integrations.apollo.lastSequenceId, 'seq-1');

    const [record] = syncStore.listSyncRecords({ workflowId: 'wf-1' });
    assert.equal(record.status, 'enrolled');
    assert.equal(record.apolloContactId, 'contact-1');
  } finally {
    workspace.cleanup();
  }
});

test('ApolloSyncService resolves saved group members to existing prospects and skips contacts without email', async () => {
  const workspace = createTempWorkspace('apollo-sync-service-group-');
  try {
    const syncStore = new ApolloSyncStore({ storePath: workspace.path('apollo-sync.json') });
    const prospectStore = new ProspectQueueStore({ storePath: workspace.path('prospects.json') });
    writeJson(workspace.path('groups.json'), [
      {
        id: 'group-1',
        name: 'Target Accounts',
        members: ['https://www.linkedin.com/in/jordan-lee/']
      }
    ]);

    const prospect = prospectStore.upsertProspect({
      accountId: 'account-1',
      fullName: 'Jordan Lee',
      profileUrl: 'https://www.linkedin.com/in/jordan-lee/',
      title: 'Chief of Staff',
      company: 'Globex'
    });
    syncStore.saveBinding({
      targetType: 'group',
      targetId: 'group-1',
      sequenceId: 'seq-2',
      sequenceName: 'Group Sync'
    });

    const service = new ApolloSyncService({
      syncStore,
      prospects: prospectStore,
      templates: new WorkflowTemplateStore({
        storePath: workspace.path('workflow-templates.json'),
        legacyWorkflowsDir: workspace.path('legacy-workflows')
      }),
      groups: new GroupDataStore({ paths: [workspace.path('groups.json')] }),
      clientFactory: () => ({
        matchPerson: async () => ({
          id: 'person-2',
          email: null,
          name: 'Jordan Lee'
        }),
        createContact: async () => {
          throw new Error('createContact should not run when Apollo match has no email');
        },
        addContactsToSequence: async () => {
          throw new Error('addContactsToSequence should not run when Apollo match has no email');
        }
      }),
      getApolloApiKey: async () => 'apollo-secret',
      hasApolloApiKey: async () => true,
      setApolloApiKey: async () => true,
      deleteApolloApiKey: async () => true
    });

    const result = await service.syncGroupToSequence({ groupId: 'group-1' });

    assert.equal(result.skipped, 1);
    assert.equal(result.failed, 0);
    assert.match(result.results[0].reason, /did not provide an email address/i);

    const refreshedProspect = prospectStore.getProspect(prospect.id);
    assert.equal(refreshedProspect.metadata.integrations.apollo.status, 'skipped');
  } finally {
    workspace.cleanup();
  }
});

test('ApolloSyncService reuses an existing Apollo contact before creating a new one', async () => {
  const workspace = createTempWorkspace('apollo-sync-service-dedupe-');
  let createContactCalls = 0;
  let updateContactCalls = 0;
  try {
    const syncStore = new ApolloSyncStore({ storePath: workspace.path('apollo-sync.json') });
    const prospectStore = new ProspectQueueStore({ storePath: workspace.path('prospects.json') });
    const templateStore = new WorkflowTemplateStore({
      storePath: workspace.path('workflow-templates.json'),
      legacyWorkflowsDir: workspace.path('legacy-workflows')
    });

    templateStore.saveAutomationWorkflow({
      id: 'wf-2',
      name: 'Apollo Dedupe Sequence',
      agentId: 'agent-2',
      target: { type: 'profiles', label: 'Imported prospects', profileUrls: [] },
      steps: [{ type: 'send_dm', order: 1, messageTemplate: 'Hello there' }]
    });
    prospectStore.upsertWorkflowTargets({
      accountId: 'account-2',
      agentId: 'agent-2',
      workflowId: 'wf-2',
      workflowName: 'Apollo Dedupe Sequence',
      targetType: 'profiles',
      targets: [{
        value: 'https://www.linkedin.com/in/alex-taylor/',
        label: 'Alex Taylor',
        title: 'Head of People',
        company: 'Initech'
      }]
    });

    syncStore.saveBinding({
      targetType: 'workflow',
      targetId: 'wf-2',
      sequenceId: 'seq-3',
      sequenceName: 'Existing Contact Sequence'
    });

    const service = new ApolloSyncService({
      syncStore,
      prospects: prospectStore,
      templates: templateStore,
      groups: new GroupDataStore({ paths: [workspace.path('groups.json')] }),
      clientFactory: () => ({
        matchPerson: async (payload) => ({
          id: 'person-3',
          email: 'alex@initech.com',
          name: payload.prospect.fullName,
          linkedinUrl: payload.prospect.profileUrl,
          organizationName: payload.prospect.company
        }),
        searchContacts: async () => [{
          id: 'contact-existing',
          email: 'alex@initech.com',
          name: 'Alex Taylor',
          linkedinUrl: 'https://www.linkedin.com/in/alex-taylor/',
          organizationName: 'Initech'
        }],
        updateContact: async () => {
          updateContactCalls += 1;
          return {
            id: 'contact-existing',
            email: 'alex@initech.com',
            name: 'Alex Taylor'
          };
        },
        createContact: async () => {
          createContactCalls += 1;
          return {
            id: 'contact-created',
            email: 'alex@initech.com',
            name: 'Alex Taylor'
          };
        },
        addContactsToSequence: async () => ({ success: true })
      }),
      getApolloApiKey: async () => 'apollo-secret',
      hasApolloApiKey: async () => true,
      setApolloApiKey: async () => true,
      deleteApolloApiKey: async () => true
    });

    const result = await service.syncWorkflowToSequence({ workflowId: 'wf-2' });

    assert.equal(result.enrolled, 1);
    assert.equal(createContactCalls, 0);
    assert.equal(updateContactCalls, 1);
    assert.equal(result.results[0].apolloContactId, 'contact-existing');
    assert.equal(result.results[0].dedupeSource, 'search_contacts');
  } finally {
    workspace.cleanup();
  }
});

test('ApolloSyncService exposes generic Apollo API passthrough and search helpers', async () => {
  const workspace = createTempWorkspace('apollo-sync-service-api-tools-');
  const apiCalls = [];
  try {
    const service = new ApolloSyncService({
      syncStore: new ApolloSyncStore({ storePath: workspace.path('apollo-sync.json') }),
      prospects: new ProspectQueueStore({ storePath: workspace.path('prospects.json') }),
      templates: new WorkflowTemplateStore({
        storePath: workspace.path('workflow-templates.json'),
        legacyWorkflowsDir: workspace.path('legacy-workflows')
      }),
      groups: new GroupDataStore({ paths: [workspace.path('groups.json')] }),
      clientFactory: () => ({
        apiRequest: async (input = {}) => {
          apiCalls.push({ type: 'apiRequest', input });
          return { ok: true, ...input };
        },
        searchPeople: async (filters = {}) => {
          apiCalls.push({ type: 'searchPeople', filters });
          return {
            totalEntries: 1,
            people: [{ id: 'person-1', name: 'Jane Doe', title: 'Head of AI' }],
            raw: { people: [{ id: 'person-1' }] }
          };
        },
        searchContacts: async (filters = {}) => {
          apiCalls.push({ type: 'searchContacts', filters });
          return [{ id: 'contact-1', name: 'Jane Doe', email: 'jane@example.com' }];
        },
        searchAccounts: async (filters = {}) => {
          apiCalls.push({ type: 'searchAccounts', filters });
          return {
            totalEntries: 1,
            accounts: [{ id: 'account-1', name: 'Acme' }],
            raw: { accounts: [{ id: 'account-1' }] }
          };
        },
        createDeal: async (payload = {}) => {
          apiCalls.push({ type: 'createDeal', payload });
          return { id: 'deal-1', ...payload };
        },
        createTask: async (payload = {}) => {
          apiCalls.push({ type: 'createTask', payload });
          return { id: 'task-1', ...payload };
        },
        updateSequenceContactStatus: async (payload = {}) => {
          apiCalls.push({ type: 'updateSequenceContactStatus', payload });
          return { ok: true, ...payload };
        }
      }),
      getApolloApiKey: async () => 'apollo-secret',
      hasApolloApiKey: async () => true,
      setApolloApiKey: async () => true,
      deleteApolloApiKey: async () => true
    });

    const capabilities = service.listApiCapabilities();
    assert.equal(capabilities.apiBaseUrl, 'https://api.apollo.io/api/v1');
    assert.ok(Array.isArray(capabilities.categories));
    assert.ok(capabilities.categories.some((category) => category.name === 'Search'));

    const apiResult = await service.callApi({
      method: 'PATCH',
      path: '/contacts/contact-1',
      body: { first_name: 'Jane' }
    });
    assert.equal(apiResult.ok, true);

    const peopleResult = await service.searchPeople({
      query: 'Head of AI',
      personTitles: ['Head of AI'],
      personLocations: ['Austin, US'],
      limit: 10
    });
    assert.equal(peopleResult.totalEntries, 1);
    assert.equal(peopleResult.people[0].title, 'Head of AI');

    const contactsResult = await service.searchContacts({
      name: 'Jane Doe',
      email: 'jane@example.com',
      company: 'Acme',
      limit: 5
    });
    assert.equal(contactsResult[0].id, 'contact-1');

    const accountsResult = await service.searchAccounts({
      query: 'Acme',
      limit: 10
    });
    assert.equal(accountsResult.accounts[0].id, 'account-1');

    const dealResult = await service.createDeal({
      deal: { name: 'Expansion', amount: 5000 }
    });
    assert.equal(dealResult.id, 'deal-1');

    const taskResult = await service.createTask({
      task: { subject: 'Follow up', type: 'email' }
    });
    assert.equal(taskResult.id, 'task-1');

    const sequenceStatusResult = await service.updateSequenceContactStatus({
      sequence_id: 'seq-1',
      contact_ids: ['contact-1'],
      status: 'stop'
    });
    assert.equal(sequenceStatusResult.ok, true);

    assert.equal(apiCalls[0].type, 'apiRequest');
    assert.equal(apiCalls[0].input.method, 'PATCH');
    assert.equal(apiCalls[1].type, 'searchPeople');
    assert.deepEqual(apiCalls[1].filters.person_titles, ['Head of AI']);
    assert.equal(apiCalls[1].filters.per_page, 10);
    assert.equal(apiCalls[2].type, 'searchContacts');
    assert.equal(apiCalls[2].filters.email, 'jane@example.com');
    assert.equal(apiCalls[3].type, 'searchAccounts');
    assert.equal(apiCalls[4].type, 'createDeal');
    assert.equal(apiCalls[5].type, 'createTask');
    assert.equal(apiCalls[6].type, 'updateSequenceContactStatus');
  } finally {
    workspace.cleanup();
  }
});
