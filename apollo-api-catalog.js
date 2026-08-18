'use strict';

const APOLLO_API_CATALOG = {
  docsBaseUrl: 'https://docs.apollo.io/',
  apiBaseUrl: 'https://api.apollo.io/api/v1',
  verifiedOn: '2026-03-21',
  notes: [
    'This catalog summarizes the Apollo public API capabilities we expose through MCP.',
    'Use call_apollo_api to reach any Apollo public REST endpoint under /api/v1 with the saved API key.',
    'Not every Apollo UI feature is necessarily available as a public API endpoint.'
  ],
  categories: [
    {
      name: 'Search',
      description: 'Find people, contacts, and sequences.',
      examples: [
        { method: 'POST', path: '/mixed_people/api_search', label: 'People API Search' },
        { method: 'POST', path: '/contacts/search', label: 'Search Contacts' },
        { method: 'POST', path: '/emailer_campaigns/search', label: 'Search Sequences' }
      ]
    },
    {
      name: 'Contacts',
      description: 'Create, update, and look up Apollo contacts.',
      examples: [
        { method: 'POST', path: '/contacts', label: 'Create Contact' },
        { method: 'PATCH', path: '/contacts/{contact_id}', label: 'Update Contact' },
        { method: 'POST', path: '/contacts/search', label: 'Search Contacts' },
        { method: 'POST', path: '/contacts/bulk_create', label: 'Bulk Create Contacts' },
        { method: 'POST', path: '/contacts/update_stages', label: 'Update Contact Stages' },
        { method: 'POST', path: '/contacts/update_owners', label: 'Update Contact Owners' }
      ]
    },
    {
      name: 'Accounts',
      description: 'Search, create, and update Apollo accounts/organizations.',
      examples: [
        { method: 'POST', path: '/accounts/search', label: 'Search Accounts' },
        { method: 'POST', path: '/accounts', label: 'Create Account' },
        { method: 'PATCH', path: '/accounts/{account_id}', label: 'Update Account' }
      ]
    },
    {
      name: 'Sequences',
      description: 'Search sequences and enroll contacts.',
      examples: [
        { method: 'POST', path: '/emailer_campaigns/search', label: 'Search for Sequences' },
        { method: 'POST', path: '/emailer_campaigns/{sequence_id}/add_contact_ids', label: 'Add Contacts to a Sequence' },
        { method: 'POST', path: '/emailer_campaigns/remove_or_stop_contact_ids', label: 'Update Contact Status in a Sequence' },
        { method: 'POST', path: '/emailer_campaigns/{sequence_id}/approve', label: 'Activate Sequence' }
      ]
    },
    {
      name: 'Deals',
      description: 'Search, create, and update Apollo deals/opportunities.',
      examples: [
        { method: 'GET', path: '/opportunities/search', label: 'Search Deals' },
        { method: 'POST', path: '/opportunities', label: 'Create Deal' },
        { method: 'PATCH', path: '/opportunities/{opportunity_id}', label: 'Update Deal' },
        { method: 'GET', path: '/opportunity_stages', label: 'List Deal Stages' }
      ]
    },
    {
      name: 'Tasks',
      description: 'Search and create Apollo tasks.',
      examples: [
        { method: 'POST', path: '/tasks/search', label: 'Search Tasks' },
        { method: 'POST', path: '/tasks', label: 'Create Task' },
        { method: 'POST', path: '/tasks/bulk_create', label: 'Bulk Create Tasks' }
      ]
    },
    {
      name: 'Calls',
      description: 'Create and inspect Apollo call records.',
      examples: [
        { method: 'POST', path: '/phone_calls', label: 'Create Call Record' },
        { method: 'GET', path: '/phone_calls/search', label: 'Search Calls' },
        { method: 'PUT', path: '/phone_calls/{call_id}', label: 'Update Call Record' }
      ]
    },
    {
      name: 'Enrichment',
      description: 'Match or enrich people before converting them into contacts.',
      examples: [
        { method: 'POST', path: '/people/match', label: 'People Match' }
      ]
    },
    {
      name: 'Workspace Metadata',
      description: 'Inspect workspace users, fields, labels, and sending accounts.',
      examples: [
        { method: 'GET', path: '/email_accounts', label: 'List Email Accounts' },
        { method: 'GET', path: '/users/search', label: 'List Users' },
        { method: 'GET', path: '/fields', label: 'List Fields' },
        { method: 'GET', path: '/labels', label: 'List Labels' }
      ]
    },
    {
      name: 'Generic Access',
      description: 'Use the generic MCP passthrough for any other Apollo public API endpoint your workspace key can access.',
      examples: [
        { method: 'GET|POST|PUT|PATCH|DELETE', path: '/<public-endpoint>', label: 'call_apollo_api' }
      ]
    }
  ]
};

module.exports = {
  APOLLO_API_CATALOG
};
