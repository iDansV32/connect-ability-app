'use strict';

function cleanString(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeComparableText(value) {
  return cleanString(value, 240)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getProspectContactStage(prospect = {}) {
  const metrics = prospect.metrics && typeof prospect.metrics === 'object' ? prospect.metrics : {};
  const metadata = prospect.metadata && typeof prospect.metadata === 'object' ? prospect.metadata : {};
  const replyCount = Math.max(0, Number(metrics.dmReplies) || 0);
  const acceptanceCount = Math.max(0, Number(metrics.connectionAcceptances) || 0);
  const lastReplyAt = cleanString(prospect.lastReplyAt, 80) || null;
  const connectionAcceptedAt = cleanString(metadata.connectionAcceptedAt, 80) || null;

  if (replyCount > 0 || lastReplyAt || prospect.state === 'responded') {
    return {
      stage: 'responded',
      reason: 'dm_reply_received',
      engagedAt: lastReplyAt || connectionAcceptedAt || cleanString(prospect.updatedAt, 80) || null
    };
  }

  if (acceptanceCount > 0 || connectionAcceptedAt) {
    return {
      stage: 'connected',
      reason: 'connection_accepted',
      engagedAt: connectionAcceptedAt || cleanString(prospect.lastActionAt, 80) || cleanString(prospect.updatedAt, 80) || null
    };
  }

  return null;
}

function isSameHandler(prospect = {}, current = {}) {
  const currentAccountId = cleanString(current.accountId, 120) || null;
  const currentAgentId = cleanString(current.agentId, 120) || null;
  const prospectAccountId = cleanString(prospect.accountId, 120) || null;
  const prospectAgentId = cleanString(prospect.agentId, 120) || null;

  if (currentAccountId && prospectAccountId && currentAccountId !== prospectAccountId) {
    return false;
  }

  if (currentAgentId) {
    return prospectAgentId === currentAgentId && (!currentAccountId || prospectAccountId === currentAccountId);
  }

  if (currentAccountId) {
    return prospectAccountId === currentAccountId;
  }

  return false;
}

function resolveLeadIdentityKey(current = {}, relatedProspects = []) {
  if (cleanString(current.normalizedProfileUrl, 400)) {
    return `url:${cleanString(current.normalizedProfileUrl, 400)}`;
  }

  const byUrl = relatedProspects.find((prospect) => cleanString(prospect.normalizedProfileUrl, 400));
  if (byUrl?.normalizedProfileUrl) {
    return `url:${cleanString(byUrl.normalizedProfileUrl, 400)}`;
  }

  const currentName = normalizeComparableText(current.fullName);
  const currentCompany = normalizeComparableText(current.company);
  if (currentName && currentCompany) {
    return `person:${currentName}|${currentCompany}`;
  }

  const byNameAndCompany = relatedProspects.find((prospect) => {
    return normalizeComparableText(prospect.fullName) && normalizeComparableText(prospect.company);
  });
  if (byNameAndCompany) {
    return `person:${normalizeComparableText(byNameAndCompany.fullName)}|${normalizeComparableText(byNameAndCompany.company)}`;
  }

  return cleanString(current.prospectId, 160) || null;
}

function summarizeManagedElsewhere(relatedProspects = [], current = {}) {
  const normalizedRelatedProspects = Array.isArray(relatedProspects) ? relatedProspects : [];
  const currentProspectId = cleanString(current.prospectId, 160) || null;
  const handlersInContact = normalizedRelatedProspects
    .filter((prospect) => prospect && typeof prospect === 'object')
    .filter((prospect) => !currentProspectId || cleanString(prospect.id, 160) !== currentProspectId)
    .filter((prospect) => !isSameHandler(prospect, current))
    .map((prospect) => {
      const contactStage = getProspectContactStage(prospect);
      if (!contactStage) return null;
      return {
        prospectId: cleanString(prospect.id, 160) || null,
        accountId: cleanString(prospect.accountId, 120) || null,
        accountName: cleanString(prospect.accountName, 160) || null,
        agentId: cleanString(prospect.agentId, 120) || null,
        agentName: cleanString(prospect.agentName, 160) || null,
        state: cleanString(prospect.state, 40) || null,
        contactStage: contactStage.stage,
        contactReason: contactStage.reason,
        engagedAt: contactStage.engagedAt,
        connectionAcceptedAt: cleanString(prospect.metadata?.connectionAcceptedAt, 80) || null,
        lastReplyAt: cleanString(prospect.lastReplyAt, 80) || null
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const rank = (value) => (value === 'responded' ? 2 : value === 'connected' ? 1 : 0);
      const rankDiff = rank(right.contactStage) - rank(left.contactStage);
      if (rankDiff !== 0) return rankDiff;
      return new Date(right.engagedAt || 0).getTime() - new Date(left.engagedAt || 0).getTime();
    });

  const primary = handlersInContact[0] || null;
  return {
    blocked: Boolean(primary),
    blockReason: primary
      ? (primary.contactStage === 'responded' ? 'responded_elsewhere' : 'connected_elsewhere')
      : null,
    leadIdentityKey: resolveLeadIdentityKey(current, normalizedRelatedProspects),
    relatedProspectIds: normalizedRelatedProspects
      .map((prospect) => cleanString(prospect.id, 160) || null)
      .filter(Boolean),
    handlersInContact
  };
}

module.exports = {
  getProspectContactStage,
  summarizeManagedElsewhere
};
