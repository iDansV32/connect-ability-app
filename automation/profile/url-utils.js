'use strict';

/**
 * Clean a LinkedIn profile URL slug into a human-readable name.
 *
 * LinkedIn slugs look like: "madison-crane-4c7a91e02" or "ivan-dans-517204886".
 * This strips:
 *   - Pure-digit parts ("517204886")
 *   - Mixed alphanumeric trailing tokens that contain both digits and letters
 *     ("4c7a91e02", "7qmzkt", "8kd3rp")
 * and title-cases the remaining parts.
 *
 * @param {string} slug - the slug portion of a LinkedIn /in/{slug} URL
 * @returns {string} cleaned, title-cased name (e.g. "Madison Crane")
 */
function cleanLinkedInSlugName(slug) {
  return String(slug || '')
    .split('-')
    .filter((part) => {
      if (!part) return false;
      // Drop pure-digit parts (e.g. "517204886")
      if (/^\d+$/.test(part)) return false;
      // Drop mixed alphanumeric parts that contain both digits AND letters
      // (e.g. "4c7a91e02", "7qmzkt", "8kd3rp")
      if (/^[a-z0-9]+$/i.test(part) && /\d/.test(part) && /[a-z]/i.test(part)) return false;
      return true;
    })
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

module.exports = { cleanLinkedInSlugName };
