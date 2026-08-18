const ACCOUNT_WORKER_MESSAGE_TYPES = Object.freeze({
  EXECUTE_STEP: 'execute_step',
  STEP_RESULT: 'step_result',
  POLL_REPLIES: 'poll_replies',
  POLL_REPLIES_RESULT: 'poll_replies_result',
  FETCH_INBOX_THREAD: 'fetch_inbox_thread',
  FETCH_INBOX_THREAD_RESULT: 'fetch_inbox_thread_result',
  SEND_INBOX_REPLY: 'send_inbox_reply',
  SEND_INBOX_REPLY_RESULT: 'send_inbox_reply_result',
  VERIFY_SESSION: 'verify_session',
  VERIFY_SESSION_RESULT: 'verify_session_result',
  PUBLISH_POST: 'publish_post',
  PUBLISH_POST_RESULT: 'publish_post_result',
  DISCOVER_BY_SEARCH: 'discover_by_search',
  DISCOVER_BY_SEARCH_RESULT: 'discover_by_search_result',
  SEND_NEW_DM: 'send_new_dm',
  SEND_NEW_DM_RESULT: 'send_new_dm_result',
  LIFECYCLE_EVENT: 'lifecycle_event',
  CHALLENGE_DETECTED: 'challenge_detected',
  HEARTBEAT: 'heartbeat',
  LOG: 'log',
  WORKER_READY: 'worker_ready',
  SHUTDOWN: 'shutdown'
});

module.exports = {
  ACCOUNT_WORKER_MESSAGE_TYPES
};
