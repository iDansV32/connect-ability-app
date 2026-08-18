'use strict';

/**
 * automation/url/normalize.js
 *
 * Canonical LinkedIn profile URL normalizer for **SQL storage join keys**.
 *
 * One purpose only: produce the value written to and read from
 * `prospects.normalized_profile_url` (and analogous columns added by the
 * profiles/groups SQLite migration: `profile_actions.normalized_profile_url`,
 * `group_members.normalized_profile_url`). Two profile URLs that should be
 * considered the same prospect must normalize to the same string here.
 *
 * Examples:
 *
 *   https://www.linkedin.com/in/john-doe/          → https://www.linkedin.com/in/john-doe
 *   https://linkedin.com/in/JOHN-DOE               → https://www.linkedin.com/in/john-doe
 *   https://www.linkedin.com/in/john-doe/?trk=x    → https://www.linkedin.com/in/john-doe
 *   https://www.linkedin.com/in/john-doe/details/  → https://www.linkedin.com/in/john-doe
 *   https://www.linkedin.com/in/john-doe/recent-activity/all → https://www.linkedin.com/in/john-doe
 *   ''                                              → ''
 *   null / undefined / non-string                   → ''
 *
 * NOTE: this is NOT the same as the navigation-form normalizers found in
 * automation/connection/request.js and automation/activity/navigate.js,
 * which produce a `page.goto()`-ready URL with a TRAILING slash. Those
 * have a different consumer (Playwright navigation) and a different
 * contract (must be a fully-qualified URL the browser can resolve).
 *
 * It's also not the loose comparison helpers in main.js or
 * automation/profile/storage.js, which strip the same suffixes but may
 * apply additional heuristics (e.g. the `ID_BASED:` prefix for hashed
 * profile slugs in storage.js). Those serve in-memory lookups, not SQL.
 *
 * Migration history:
 *   - Originally inlined as `normalizeProfileUrl` in
 *     prospect-queue-store.js:1077 and storage/prospect-legacy-importer.js:111
 *     (character-equivalent implementations).
 *   - Extracted here as the first step of roadmap #7 Phase B so the
 *     legacy importer + the runtime write path share one source of truth
 *     for the SQL join key.
 */

const MAX_URL_LENGTH = 400;

/**
 * Normalize a LinkedIn profile URL for use as a SQL join key. See module
 * docblock for the contract.
 *
 * @param {*} value
 * @returns {string}
 */
function normalizeProfileUrl(value) {
  const raw = String(value == null ? '' : value).trim().slice(0, MAX_URL_LENGTH);
  if (!raw) return '';

  let normalized = raw
    .replace(/https?:\/\/(www\.)?/i, 'https://www.')
    .split('?')[0]
    .split('#')[0]
    .replace(/\/recent-activity.*$/i, '')
    .replace(/\/details.*$/i, '')
    .replace(/\/+$/, '');

  // If the URL was provided without any protocol (e.g. "linkedin.com/in/x"),
  // the protocol-replace above didn't match. Add a bare https:// prefix so
  // the result is at least parseable. We intentionally do NOT inject www.
  // here — preserving the original host shape lets a caller spot URLs that
  // were provided in non-canonical form.
  if (/linkedin\.com\/in\//i.test(normalized) && !/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  return normalized.toLowerCase();
}

module.exports = {
  normalizeProfileUrl,
  MAX_URL_LENGTH
};
