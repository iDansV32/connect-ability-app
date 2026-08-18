'use strict';

/**
 * Durable scheduler posting path.
 * Receives a live page from the account worker and schedules posts through the
 * shared posting transport. This file previously owned a private-API-only path;
 * DOM fallback now lives in posting-transport.js and post-publisher.js.
 */

const { traceAction } = require('../network/tracer');
const { executePostOnPage } = require('./post-publisher');
const { scheduleScheduledPost } = require('./posting-transport');
const { logAction, logError } = require('../util/log');

async function scheduleTextPost(page, options = {}) {
  return traceAction(
    page,
    'schedule_post',
    {
      scheduledAt: options.scheduledAt,
      visibilityType: options.visibilityType,
      textLength: String(options.text || '').length
    },
    async () => {
      try {
        const result = await scheduleScheduledPost(page, {
          text: options.text,
          scheduledAt: options.scheduledAt,
          scheduledDate: options.scheduledDate,
          scheduledTime: options.scheduledTime,
          visibilityType: options.visibilityType,
          visibility: options.visibility,
          allowedCommentersScope: options.allowedCommentersScope,
          origin: options.origin,
          includeImage: options.includeImage,
          imagePath: options.imagePath
        }, {
          route: options.route || 'dom',
          accountEmail: options.accountEmail || null,
          transportHealthStore: options.transportHealthStore || null,
          emitLog: options.emitLog || null,
          domScheduler: async (postConfig) => executePostOnPage(
            page,
            postConfig,
            {
              email: options.accountEmail || null,
              password: options.password || null,
              name: options.accountName || options.accountEmail || null
            },
            options.emitLog || (() => {})
          )
        });

        if (result.success) {
          logAction('Scheduled LinkedIn post via DOM automation');
          return result;
        }

        if (result.reason === 'exception' && result.error) {
          logError(`Error scheduling LinkedIn post: ${result.error}`);
        }
        return result;
      } catch (error) {
        logError(`Error scheduling LinkedIn post: ${error.message}`, error);
        return {
          success: false,
          reason: 'exception',
          transport: 'dom',
          error: error.message
        };
      }
    }
  );
}

async function deleteScheduledPost(page, resourceKey) {
  return traceAction(
    page,
    'delete_scheduled_post',
    { resourceKey },
    async () => {
      logAction('Delete scheduled post is not supported in DOM-only mode');
      return { success: false, reason: 'not_supported_dom_only' };
    }
  );
}

module.exports = {
  scheduleTextPost,
  deleteScheduledPost
};
