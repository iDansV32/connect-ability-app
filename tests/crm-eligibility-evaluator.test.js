const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateCrmEligibility,
  DEFAULT_CRM_ELIGIBILITY_RULES,
  CRM_ELIGIBILITY_RULE_NAMES
} = require('../crm-eligibility-evaluator');

const FIXED_NOW = '2026-03-27T12:00:00.000Z';

test('evaluateCrmEligibility suppresses when contact lifecycle stage is already in active sales process', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    getContact: async () => ({
      id: 'contact-1',
      stageName: 'Opportunity'
    }),
    listContactStages: async () => []
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.CONTACT_STAGE_ACTIVE_SALES_PROCESS)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, false);
  assert.deepEqual(result.suppressionReasons, [CRM_ELIGIBILITY_RULE_NAMES.CONTACT_STAGE_ACTIVE_SALES_PROCESS]);
  assert.equal(result.holdCause, null);
});

test('evaluateCrmEligibility passes contact lifecycle rule when contact stage is not sales-owned', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    getContact: async () => ({
      id: 'contact-1',
      stageName: 'Lead'
    }),
    listContactStages: async () => []
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.CONTACT_STAGE_ACTIVE_SALES_PROCESS)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.suppressionReasons, []);
  assert.equal(result.holdCause, null);
});

test('evaluateCrmEligibility holds when contact stage lookup is unreachable', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    getContact: async () => ({
      id: 'contact-1',
      stageId: 'stage-1'
    }),
    listContactStages: async () => {
      throw new Error('Apollo API error (503): unavailable');
    }
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.CONTACT_STAGE_ACTIVE_SALES_PROCESS)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, false);
  assert.equal(result.holdCause, 'unreachable');
});

test('evaluateCrmEligibility suppresses when any deal is not closed lost', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    searchDeals: async () => ([
      {
        id: 'deal-1',
        stageName: 'Negotiation'
      }
    ]),
    listDealStages: async () => []
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.DEAL_STAGE_NOT_CLOSED_LOST)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, false);
  assert.deepEqual(result.suppressionReasons, [CRM_ELIGIBILITY_RULE_NAMES.DEAL_STAGE_NOT_CLOSED_LOST]);
});

test('evaluateCrmEligibility passes deal-stage rule when only closed-lost deals exist', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    searchDeals: async () => ([
      {
        id: 'deal-1',
        stageName: 'Closed Lost'
      }
    ]),
    listDealStages: async () => []
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.DEAL_STAGE_NOT_CLOSED_LOST)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.suppressionReasons, []);
});

test('evaluateCrmEligibility holds when deal lookup is unreachable', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    searchDeals: async () => {
      throw new Error('Apollo API error (503): unavailable');
    },
    listDealStages: async () => []
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.DEAL_STAGE_NOT_CLOSED_LOST)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, false);
  assert.equal(result.holdCause, 'unreachable');
});

test('evaluateCrmEligibility suppresses when a recent meeting or call was completed', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    searchTasks: async () => ([
      {
        id: 'task-1',
        type: 'meeting',
        status: 'completed',
        completedAt: '2026-03-20T12:00:00.000Z'
      }
    ])
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.MEETING_BOOKED_RECENTLY)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, false);
  assert.deepEqual(result.suppressionReasons, [CRM_ELIGIBILITY_RULE_NAMES.MEETING_BOOKED_RECENTLY]);
});

test('evaluateCrmEligibility passes meeting rule when no recent completed meetings exist', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    searchTasks: async () => []
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.MEETING_BOOKED_RECENTLY)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.suppressionReasons, []);
});

test('evaluateCrmEligibility holds when meeting lookup is unreachable', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    searchTasks: async () => {
      throw new Error('Apollo API error (503): unavailable');
    }
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.MEETING_BOOKED_RECENTLY)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, false);
  assert.equal(result.holdCause, 'unreachable');
});

test('evaluateCrmEligibility suppresses when an open sales-owned task shows an active conversation', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    listUsers: async () => ([
      { id: 'user-1', role: 'Sales' }
    ]),
    searchTasks: async () => ([
      {
        id: 'task-1',
        ownerId: 'user-1',
        status: 'open',
        updatedAt: '2026-03-22T12:00:00.000Z'
      }
    ])
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.ACTIVE_SALES_CONVERSATION)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, false);
  assert.deepEqual(result.suppressionReasons, [CRM_ELIGIBILITY_RULE_NAMES.ACTIVE_SALES_CONVERSATION]);
});

test('evaluateCrmEligibility passes active sales conversation rule when open tasks are not sales-owned', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    listUsers: async () => ([
      { id: 'user-1', role: 'Customer Success' }
    ]),
    searchTasks: async () => ([
      {
        id: 'task-1',
        ownerId: 'user-1',
        status: 'open',
        updatedAt: '2026-03-22T12:00:00.000Z'
      }
    ])
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.ACTIVE_SALES_CONVERSATION)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.suppressionReasons, []);
});

test('evaluateCrmEligibility holds when sales-user lookup is unreachable', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    listUsers: async () => {
      throw new Error('Apollo API error (503): unavailable');
    }
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.ACTIVE_SALES_CONVERSATION)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, false);
  assert.equal(result.holdCause, 'unreachable');
});

test('evaluateCrmEligibility suppresses when the contact owner has recent activity', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    getContact: async () => ({
      id: 'contact-1',
      ownerId: 'owner-1'
    }),
    searchTasks: async () => ([
      {
        id: 'task-1',
        ownerId: 'owner-1',
        status: 'open',
        updatedAt: '2026-03-25T12:00:00.000Z'
      }
    ])
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.RECENT_OWNER_ACTIVITY)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, false);
  assert.deepEqual(result.suppressionReasons, [CRM_ELIGIBILITY_RULE_NAMES.RECENT_OWNER_ACTIVITY]);
});

test('evaluateCrmEligibility passes recent owner activity rule when the owner has no recent tasks', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    getContact: async () => ({
      id: 'contact-1',
      ownerId: 'owner-1'
    }),
    searchTasks: async () => ([
      {
        id: 'task-1',
        ownerId: 'owner-1',
        status: 'completed',
        completedAt: '2026-03-01T12:00:00.000Z'
      }
    ])
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.RECENT_OWNER_ACTIVITY)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.suppressionReasons, []);
});

test('evaluateCrmEligibility holds when owner activity lookup is unreachable', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    getContact: async () => ({
      id: 'contact-1',
      ownerId: 'owner-1'
    }),
    searchTasks: async () => {
      throw new Error('Apollo API error (503): unavailable');
    }
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.RECENT_OWNER_ACTIVITY)], {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, false);
  assert.equal(result.holdCause, 'unreachable');
});

test('evaluateCrmEligibility uses injected Apollo users instead of refetching them', async () => {
  let searchTaskCalls = 0;
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    listUsers: async () => {
      throw new Error('listUsers should not be called when apolloUsers is preloaded');
    },
    searchTasks: async () => {
      searchTaskCalls += 1;
      return [
        {
          id: 'task-1',
          ownerId: 'sales-1',
          status: 'open',
          updatedAt: '2026-03-22T12:00:00.000Z'
        }
      ];
    }
  }), [rule(CRM_ELIGIBILITY_RULE_NAMES.ACTIVE_SALES_CONVERSATION)], {
    now: FIXED_NOW,
    apolloUsers: [
      { id: 'sales-1', role: 'Sales' }
    ]
  });

  assert.equal(searchTaskCalls, 1);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.suppressionReasons, [CRM_ELIGIBILITY_RULE_NAMES.ACTIVE_SALES_CONVERSATION]);
});

test('evaluateCrmEligibility collects every suppression reason when multiple rules match', async () => {
  const result = await evaluateCrmEligibility('contact-1', buildApolloClient({
    getContact: async () => ({
      id: 'contact-1',
      stageName: 'Customer',
      ownerId: 'owner-1'
    }),
    searchDeals: async () => ([
      {
        id: 'deal-1',
        stageName: 'Negotiation'
      }
    ]),
    listDealStages: async () => [],
    listUsers: async () => ([
      { id: 'sales-1', role: 'Sales' }
    ]),
    searchTasks: async ({ filters = {} }) => {
      if (filters.type) {
        return [
          {
            id: 'meeting-1',
            type: 'call',
            status: 'completed',
            completedAt: '2026-03-25T12:00:00.000Z'
          }
        ];
      }
      if (filters.owner_id) {
        return [
          {
            id: 'owner-task-1',
            ownerId: 'owner-1',
            status: 'open',
            updatedAt: '2026-03-26T12:00:00.000Z'
          }
        ];
      }
      return [
        {
          id: 'sales-task-1',
          ownerId: 'sales-1',
          status: 'open',
          updatedAt: '2026-03-24T12:00:00.000Z'
        }
      ];
    }
  }), undefined, {
    now: FIXED_NOW
  });

  assert.equal(result.eligible, false);
  assert.deepEqual(result.suppressionReasons, [
    CRM_ELIGIBILITY_RULE_NAMES.CONTACT_STAGE_ACTIVE_SALES_PROCESS,
    CRM_ELIGIBILITY_RULE_NAMES.DEAL_STAGE_NOT_CLOSED_LOST,
    CRM_ELIGIBILITY_RULE_NAMES.MEETING_BOOKED_RECENTLY,
    CRM_ELIGIBILITY_RULE_NAMES.ACTIVE_SALES_CONVERSATION,
    CRM_ELIGIBILITY_RULE_NAMES.RECENT_OWNER_ACTIVITY
  ]);
  assert.equal(result.holdCause, null);
});

function rule(name, extra = {}) {
  const defaults = DEFAULT_CRM_ELIGIBILITY_RULES.find((candidate) => candidate.name === name) || {};
  return {
    ...defaults,
    name,
    enabled: true,
    ...extra
  };
}

function buildApolloClient(overrides = {}) {
  return {
    getContact: overrides.getContact || (async () => ({ id: 'contact-1' })),
    listContactStages: overrides.listContactStages || (async () => []),
    searchDeals: overrides.searchDeals || (async () => []),
    listDealStages: overrides.listDealStages || (async () => []),
    searchTasks: overrides.searchTasks || (async () => []),
    listUsers: overrides.listUsers || (async () => [])
  };
}
