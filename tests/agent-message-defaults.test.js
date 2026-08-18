const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAgentMessageDefaults,
  resolveAgentStepTemplate
} = require('../agent-message-defaults');

test('buildAgentMessageDefaults normalizes stored SDR agent templates', () => {
  const defaults = buildAgentMessageDefaults({
    connectionNoteTemplate: ' Hi {firstName}\r\nLet us connect. ',
    dmTemplatePrimary: '\0Primary intro',
    dmTemplateFollowUp: ' Follow up '
  });

  assert.deepEqual(defaults, {
    connectionNote: 'Hi {firstName}\nLet us connect.',
    dmPrimary: 'Primary intro',
    dmFollowUp: 'Follow up'
  });
});

test('resolveAgentStepTemplate maps connection and sequenced DM defaults', () => {
  const agent = {
    connectionNoteTemplate: 'Connect note',
    dmTemplatePrimary: 'Primary DM',
    dmTemplateFollowUp: 'Follow-up DM'
  };

  assert.deepEqual(resolveAgentStepTemplate(agent, 'send_connection', { occurrence: 1 }), {
    slot: 'connection_note',
    label: 'Connection Note',
    template: 'Connect note'
  });

  assert.deepEqual(resolveAgentStepTemplate(agent, 'send_dm', { occurrence: 1 }), {
    slot: 'dm_primary',
    label: 'Primary DM',
    template: 'Primary DM'
  });

  assert.deepEqual(resolveAgentStepTemplate(agent, 'send_dm', { occurrence: 2 }), {
    slot: 'dm_follow_up',
    label: 'Follow-up DM',
    template: 'Follow-up DM'
  });
});

test('resolveAgentStepTemplate falls back cleanly when follow-up or primary templates are missing', () => {
  assert.deepEqual(resolveAgentStepTemplate({
    dmTemplatePrimary: 'Primary only'
  }, 'send_dm', { occurrence: 3 }), {
    slot: 'dm_primary',
    label: 'Primary DM',
    template: 'Primary only'
  });

  assert.deepEqual(resolveAgentStepTemplate({
    dmTemplateFollowUp: 'Follow-up only'
  }, 'send_dm', { occurrence: 1 }), {
    slot: 'dm_follow_up',
    label: 'Follow-up DM',
    template: 'Follow-up only'
  });

  assert.deepEqual(resolveAgentStepTemplate({}, 'send_dm', { occurrence: 1 }), {
    slot: null,
    label: '',
    template: ''
  });
});
