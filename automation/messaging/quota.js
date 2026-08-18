const {
  canConsumeMessageQuota,
  consumeMessageQuota,
  getMessageQuota,
  resetMessageQuotaWindow
} = require('../../message-quota-store');

function checkMessageQuota(count = 1, options = {}) {
  return canConsumeMessageQuota(count, options).allowed;
}

function updateMessageQuota(count = 1, options = {}) {
  const result = consumeMessageQuota(count, options);
  return result.quota?.daily?.used ?? 0;
}

module.exports = {
  canConsumeMessageQuota,
  checkMessageQuota,
  getMessageQuota,
  resetMessageQuotaWindow,
  updateMessageQuota
};
