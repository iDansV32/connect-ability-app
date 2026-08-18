'use strict';

function buildImmediateOneShotRunInput({
  actionType,
  message,
  accountId,
  accountName,
  agentId,
  agentName,
  profileUrl
} = {}) {
  return {
    workflowName: `One-shot ${actionType}`,
    accountId,
    accountName,
    agentId,
    agentName,
    targetType: 'profiles',
    // An MCP one-shot is an explicit operator command, not unattended
    // campaign automation. Match the GUI's manual-launch semantics so
    // "send now" cannot sit behind the account's working-hours gate.
    bypassWorkingHours: true,
    // Browser actions are always observable for operator-triggered runs.
    headless: false,
    launchSource: 'mcp_one_shot',
    targets: [{ value: profileUrl, label: profileUrl }],
    steps: [{ type: actionType, messageTemplate: message || '' }]
  };
}

module.exports = { buildImmediateOneShotRunInput };
