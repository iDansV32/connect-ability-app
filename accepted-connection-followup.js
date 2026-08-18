'use strict';

const { resolveAgentStepTemplate } = require('./agent-message-defaults');

const ACTIVE_DM_JOB_STATUSES = new Set(['queued', 'running', 'paused']);

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeMetricCount(value) {
  return Math.max(0, Number(value) || 0);
}

function hasActiveDmJobForProspect(jobs = [], prospectId) {
  const normalizedProspectId = cleanString(prospectId, 160);
  if (!normalizedProspectId) {
    return false;
  }

  return (Array.isArray(jobs) ? jobs : []).some((job) => {
    return (
      cleanString(job?.prospectId, 160) === normalizedProspectId
      && cleanString(job?.stepType, 80) === 'send_dm'
      && ACTIVE_DM_JOB_STATUSES.has(cleanString(job?.status, 40))
    );
  });
}

function resolveAcceptedConnectionFollowUpPlan(input = {}) {
  const event = input.event && typeof input.event === 'object' ? input.event : {};
  const prospect = input.prospect && typeof input.prospect === 'object' ? input.prospect : {};
  const agent = input.agent && typeof input.agent === 'object' ? input.agent : {};
  const jobs = Array.isArray(input.jobs) ? input.jobs : [];

  const eventType = cleanString(event.type, 80);
  if (eventType !== 'connection_accepted') {
    return { shouldQueue: false, reason: 'unsupported_event' };
  }

  const prospectId = cleanString(prospect.id || prospect.prospectId || event.prospectId, 160);
  if (!prospectId) {
    return { shouldQueue: false, reason: 'missing_prospect' };
  }

  if (cleanString(prospect.state, 40) === 'archived' || prospect?.metadata?.doNotContact === true) {
    return { shouldQueue: false, reason: 'do_not_contact' };
  }

  const accountId = cleanString(prospect.accountId || event.accountId, 120);
  if (!accountId) {
    return { shouldQueue: false, reason: 'missing_account' };
  }

  const agentId = cleanString(prospect.agentId || event.agentId || agent.id, 120);
  if (!agentId) {
    return { shouldQueue: false, reason: 'missing_agent' };
  }

  const dmsSent = normalizeMetricCount(prospect?.metrics?.dmsSent);
  if (dmsSent > 0 || cleanString(prospect.lastReplyAt, 80)) {
    return { shouldQueue: false, reason: 'outreach_already_started' };
  }

  if (cleanString(prospect?.metadata?.acceptedConnectionFollowUpQueuedAt, 80)) {
    return { shouldQueue: false, reason: 'follow_up_already_queued' };
  }

  if (hasActiveDmJobForProspect(jobs, prospectId)) {
    return { shouldQueue: false, reason: 'active_dm_job_exists' };
  }

  const templateInfo = resolveAgentStepTemplate(agent, 'send_dm', { occurrence: 1 });
  if (!templateInfo?.template) {
    return { shouldQueue: false, reason: 'missing_dm_template' };
  }

  const profileUrl = cleanString(prospect.profileUrl || event.profileUrl || event.targetValue, 400);
  if (!profileUrl) {
    return { shouldQueue: false, reason: 'missing_profile_url' };
  }

  const workflowId = cleanString(`accepted-follow-up-${agentId}`, 160);
  const workflowName = cleanString(
    `${agent.name || prospect.agentName || 'Agent'} Accepted Connection Follow-up`,
    160
  ) || 'Accepted Connection Follow-up';

  return {
    shouldQueue: true,
    reason: 'queue_follow_up',
    templateInfo,
    metadataPatch: {
      acceptedConnectionFollowUpQueuedAt: cleanString(event.timestamp, 80) || new Date().toISOString(),
      acceptedConnectionFollowUpEventId: cleanString(event.id, 160) || null,
      acceptedConnectionFollowUpTemplateSlot: cleanString(templateInfo.slot, 80) || null
    },
    runInput: {
      workflowId,
      workflowName,
      accountId,
      accountName: cleanString(prospect.accountName || event.accountName, 160) || null,
      agentId,
      agentName: cleanString(agent.name || prospect.agentName || event.agentName, 160) || null,
      targetType: 'profiles',
      headless: false,
      browserProfile: 'random',
      slowMo: 50,
      steps: [{
        type: 'send_dm',
        messageTemplate: templateInfo.template,
        minDelayMs: 0,
        maxDelayMs: 0,
        metadata: {
          autoAcceptedConnectionFollowUp: true,
          triggerEventType: 'connection_accepted',
          triggerEventId: cleanString(event.id, 160) || null,
          templateSlot: cleanString(templateInfo.slot, 80) || null
        }
      }],
      targets: [{
        prospectId,
        value: profileUrl,
        label: cleanString(prospect.fullName || event.targetValue, 240) || profileUrl
      }]
    }
  };
}

module.exports = {
  hasActiveDmJobForProspect,
  resolveAcceptedConnectionFollowUpPlan
};
