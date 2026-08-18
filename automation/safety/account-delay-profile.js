'use strict';

const crypto = require('crypto');

function normalizeDelayProfileSeed(value, fallbackIdentity = '') {
  const explicitValue = String(value || '').trim();
  if (explicitValue) {
    return explicitValue.slice(0, 120);
  }

  const normalizedIdentity = String(fallbackIdentity || '').trim().toLowerCase();
  if (!normalizedIdentity) {
    return 'li-delay-default';
  }

  const digest = crypto
    .createHash('sha256')
    .update(normalizedIdentity)
    .digest('hex')
    .slice(0, 20);

  return `li-delay-${digest}`;
}

module.exports = {
  normalizeDelayProfileSeed
};
