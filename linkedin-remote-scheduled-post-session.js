'use strict';

// Stub: the remote scheduled-post session previously used LinkedIn's private
// API (Voyager GraphQL) for scheduling and deleting posts. That path has been
// removed in favour of DOM-only automation through the worker-backed posting
// transport. Callers that still reference this module get a safe no-op session
// that rejects with an explanatory error.

async function createLinkedInScheduledPostSession(_credentials, _emitLog) {
  return {
    async schedulePost(_post) {
      throw new Error(
        'Remote scheduled-post session is no longer available. Posts are now scheduled through the worker-backed DOM transport.'
      );
    },
    async deletePost(_resourceKey) {
      throw new Error(
        'Remote scheduled-post deletion is no longer available. The private API path has been removed.'
      );
    },
    async close() {}
  };
}

module.exports = {
  createLinkedInScheduledPostSession
};
