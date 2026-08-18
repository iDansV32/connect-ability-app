'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildImmediateOneShotRunInput } = require('../mcp-one-shot-run');

test('MCP one-shot actions bypass working hours and always run visibly', () => {
  const input = buildImmediateOneShotRunInput({
    actionType: 'send_dm',
    message: 'Hello from the operator',
    accountId: 'account-1',
    accountName: 'Primary Account',
    agentId: 'agent-1',
    agentName: 'Remy',
    profileUrl: 'https://www.linkedin.com/in/example'
  });

  assert.equal(input.bypassWorkingHours, true);
  assert.equal(input.headless, false);
  assert.equal(input.launchSource, 'mcp_one_shot');
  assert.equal(input.workflowName, 'One-shot send_dm');
  assert.deepEqual(input.targets, [{
    value: 'https://www.linkedin.com/in/example',
    label: 'https://www.linkedin.com/in/example'
  }]);
  assert.deepEqual(input.steps, [{
    type: 'send_dm',
    messageTemplate: 'Hello from the operator'
  }]);
});
