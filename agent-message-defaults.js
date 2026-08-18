(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.AgentMessageDefaults = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function cleanTemplate(value, maxLength) {
    return String(value || '')
      .replace(/\r\n/g, '\n')
      .replace(/\0/g, '')
      .trim()
      .slice(0, maxLength);
  }

  function buildAgentMessageDefaults(agent) {
    return {
      connectionNote: cleanTemplate(agent?.connectionNoteTemplate, 500),
      dmPrimary: cleanTemplate(agent?.dmTemplatePrimary, 1600),
      dmFollowUp: cleanTemplate(agent?.dmTemplateFollowUp, 1600)
    };
  }

  function resolveAgentStepTemplate(agent, stepType, options) {
    const normalizedStepType = String(stepType || '').trim();
    const occurrence = Math.max(1, Number.parseInt(options?.occurrence || 1, 10) || 1);
    const defaults = buildAgentMessageDefaults(agent);

    if (normalizedStepType === 'send_connection' && defaults.connectionNote) {
      return {
        slot: 'connection_note',
        label: 'Connection Note',
        template: defaults.connectionNote
      };
    }

    if (normalizedStepType === 'send_dm') {
      if (occurrence >= 2 && defaults.dmFollowUp) {
        return {
          slot: 'dm_follow_up',
          label: 'Follow-up DM',
          template: defaults.dmFollowUp
        };
      }

      if (defaults.dmPrimary) {
        return {
          slot: 'dm_primary',
          label: 'Primary DM',
          template: defaults.dmPrimary
        };
      }

      if (defaults.dmFollowUp) {
        return {
          slot: 'dm_follow_up',
          label: 'Follow-up DM',
          template: defaults.dmFollowUp
        };
      }
    }

    return {
      slot: null,
      label: '',
      template: ''
    };
  }

  return {
    buildAgentMessageDefaults,
    resolveAgentStepTemplate
  };
});
