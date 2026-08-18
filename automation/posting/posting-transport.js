'use strict';

const { verifyPostScheduled } = require('../runtime/verification');

async function scheduleScheduledPost(page, postConfig = {}, options = {}) {
  const normalizedPost = normalizeScheduledPostConfig(postConfig);
  const emitLog = typeof options.emitLog === 'function' ? options.emitLog : () => {};
  const domScheduler = typeof options.domScheduler === 'function' ? options.domScheduler : null;

  return scheduleViaDom(domScheduler, normalizedPost, options, emitLog);
}

async function scheduleViaDom(domScheduler, postConfig = {}, options = {}, emitLog = () => {}) {
  if (!domScheduler) {
    return {
      success: false,
      reason: 'dom_scheduler_unavailable',
      transport: 'dom'
    };
  }

  const domResult = await domScheduler(buildDomSchedulerInput(postConfig));
  const succeeded = String(domResult?.outcome || '').trim() === 'scheduled';
  const resourceKey = String(domResult?.linkedInResourceKey || '').trim() || null;
  const scheduledAt = String(domResult?.linkedInScheduledAt || postConfig.scheduledAt || '').trim() || null;

  if (!succeeded) {
    return {
      success: false,
      reason: 'dom_schedule_failed',
      transport: 'dom',
      response: domResult || null
    };
  }

  emitLog({ message: 'LinkedIn post scheduled successfully via UI flow.', type: 'success' });
  return {
    success: true,
    resourceKey,
    scheduledAt,
    transport: 'dom',
    response: domResult || null,
    verificationResult: verifyPostScheduled({
      resourceKey,
      method: 'dom',
      action: 'schedule_post',
      accountEmail: options.accountEmail || null,
      transportHealthStore: options.transportHealthStore || null
    })
  };
}

function normalizeScheduledPostConfig(postConfig = {}) {
  const content = String(postConfig.content ?? postConfig.text ?? '').trim();
  const includeImage = Boolean(postConfig.includeImage || postConfig.imagePath);
  const imagePath = String(postConfig.imagePath || '').trim() || null;
  const visibilityType = mapVisibilityType(postConfig.visibilityType || postConfig.visibility);
  const allowedCommentersScope = String(postConfig.allowedCommentersScope || 'ALL').trim() || 'ALL';
  const origin = String(postConfig.origin || 'FEED').trim() || 'FEED';
  const scheduledAt = normalizeScheduledAt(postConfig);
  const domDateTime = normalizeDomScheduleDateTime(postConfig, scheduledAt);

  return {
    content,
    scheduledAt,
    includeImage,
    imagePath,
    visibilityType,
    allowedCommentersScope,
    origin,
    scheduledDate: domDateTime.scheduledDate,
    scheduledTime: domDateTime.scheduledTime
  };
}

function buildDomSchedulerInput(postConfig) {
  return {
    content: postConfig.content,
    immediate: false,
    includeImage: postConfig.includeImage,
    imagePath: postConfig.imagePath,
    scheduledDate: postConfig.scheduledDate,
    scheduledTime: postConfig.scheduledTime,
    visibility: postConfig.visibilityType === 'CONNECTIONS' ? 'connections' : 'anyone'
  };
}

function normalizeScheduledAt(postConfig = {}) {
  const directValue = String(postConfig.scheduledAt || '').trim();
  if (directValue) {
    return directValue;
  }
  return toScheduledTimestamp(postConfig.scheduledDate, postConfig.scheduledTime);
}

function normalizeDomScheduleDateTime(postConfig = {}, scheduledAt) {
  const scheduledDate = String(postConfig.scheduledDate || '').trim();
  const scheduledTime = String(postConfig.scheduledTime || '').trim();
  if (scheduledDate && scheduledTime) {
    return { scheduledDate, scheduledTime };
  }

  const date = new Date(Number(scheduledAt));
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Scheduled date/time is required for scheduled posts');
  }

  return {
    scheduledDate: formatDatePart(date),
    scheduledTime: formatTimePart(date)
  };
}

function toScheduledTimestamp(scheduledDate, scheduledTime) {
  const candidate = new Date(`${scheduledDate}T${scheduledTime}:00`);
  if (!Number.isFinite(candidate.getTime())) {
    throw new Error('Scheduled date/time could not be converted to a timestamp');
  }
  return String(candidate.getTime());
}

function mapVisibilityType(visibility) {
  const normalized = String(visibility || '').trim().toLowerCase();
  if (normalized === 'connections' || normalized === 'connections_only') {
    return 'CONNECTIONS';
  }
  return 'ANYONE';
}

function formatDatePart(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimePart(value) {
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

module.exports = {
  scheduleScheduledPost,
  _private: {
    normalizeScheduledPostConfig,
    toScheduledTimestamp
  }
};
