const test = require('node:test');
const assert = require('node:assert/strict');

const SdrAgentManager = require('../sdr-agent-manager');
const { createTempWorkspace } = require('./test-helpers');

test('SdrAgentManager saves, normalizes, and deletes agents', () => {
  const workspace = createTempWorkspace('sdr-agent-manager-');
  try {
    const manager = new SdrAgentManager({
      storePath: workspace.path('sdr-agents.json')
    });

    const savedAgent = manager.saveAgent({
      name: '  CS Agent  ',
      niche: 'Customer Success',
      personaTitles: ['Chief of Staff', 'chief of staff', 'Head of People'],
      searchKeywords: 'customer success, onboarding, Customer Success',
      notifications: { dmReplies: false }
    });

    assert.equal(savedAgent.name, 'CS Agent');
    assert.deepEqual(savedAgent.personaTitles, ['Chief of Staff', 'Head of People']);
    assert.deepEqual(savedAgent.searchKeywords, ['customer success', 'onboarding']);
    assert.equal(savedAgent.notifications.dmReplies, false);
    assert.equal(manager.getAllAgents().length, 1);

    const deleteResult = manager.deleteAgent(savedAgent.id);
    assert.equal(deleteResult.deleted, true);
    assert.equal(manager.getAllAgents().length, 0);
  } finally {
    workspace.cleanup();
  }
});

test('SdrAgentManager requires an agent name', () => {
  const workspace = createTempWorkspace('sdr-agent-manager-error-');
  try {
    const manager = new SdrAgentManager({
      storePath: workspace.path('sdr-agents.json')
    });

    assert.throws(() => manager.saveAgent({ niche: 'No Name' }), /Agent name is required/);
  } finally {
    workspace.cleanup();
  }
});
