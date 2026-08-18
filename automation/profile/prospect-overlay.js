'use strict';

/**
 * automation/profile/prospect-overlay.js
 *
 * Store-consistency bridge. The legacy profiles.json store (written by the
 * worker process) can drift stale — e.g. it kept OCR-garbled title/company
 * after a re-view, while the SQLite prospect store (enriched by the
 * main-process scheduler from the clean view_profile bio) holds the correct
 * values. Per the chosen strategy, the SQLite prospect is the source of truth
 * for identity fields, so the read surfaces (getAllProfiles / getProfileData)
 * overlay the prospect's clean fullName/title/company onto each profile.
 *
 * Pure (no I/O). normalizeUrl is injected so the module has no main.js / DOM
 * dependency and is unit-testable.
 */

function cleanField(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // Treat extractor placeholders as "absent" so they never overlay real data.
  if (s === 'Not Available' || s === 'Not available' || s === 'Unknown Profile' || s === 'Unknown') return null;
  return s;
}

const PROFILE_URL_KEYS = ['url', 'originalUrl', 'linkedInUrl', 'linkedInProfileUrl', 'profileUrl'];

function firstProfileUrl(record) {
  for (const key of PROFILE_URL_KEYS) {
    if (record && record[key]) return record[key];
  }
  return '';
}

/**
 * Build a Map<normalizedUrl, {fullName, title, company}> of clean enrichment
 * from the SQLite prospect records. Only non-placeholder fields are kept; a
 * prospect with nothing usable is omitted entirely.
 *
 * @param {Array<object>} prospects  prospectQueueStore.getAllProspects(...)
 * @param {(url:string)=>string} normalizeUrl
 * @returns {Map<string, {fullName:(string|null), title:(string|null), company:(string|null)}>}
 */
function buildProspectEnrichmentIndex(prospects, normalizeUrl) {
  const index = new Map();
  if (!Array.isArray(prospects) || typeof normalizeUrl !== 'function') return index;
  for (const prospect of prospects) {
    if (!prospect || typeof prospect !== 'object') continue;
    const url = normalizeUrl(prospect.profileUrl || prospect.normalizedProfileUrl || '');
    if (!url) continue;
    const fullName = cleanField(prospect.fullName);
    let title = cleanField(prospect.title);
    let company = cleanField(prospect.company);
    // "name-as-title" (title === fullName) is the signature of a suspect/stale
    // bio extraction — the company almost certainly came from the same bad
    // parse. Treat the whole bio as untrustworthy and drop BOTH title and
    // company so neither overlays (and degrades) good profiles.json data. The
    // fullName (the person's name) is still reliable and may overlay. The
    // record self-heals on the next view now that extraction is fixed.
    if (title && fullName && title.toLowerCase() === fullName.toLowerCase()) {
      title = null;
      company = null;
    }
    const entry = {
      fullName,
      title,
      company
    };
    if (entry.fullName || entry.title || entry.company) {
      // First prospect per URL wins (stores are deduped per profile anyway).
      if (!index.has(url)) index.set(url, entry);
    }
  }
  return index;
}

/**
 * Overlay clean prospect enrichment onto profile records. For each profile with
 * a matching prospect (by normalized URL), prefer the prospect's fullName /
 * title (also mirrored to `position`) / company when present. Profiles without
 * a match are returned unchanged. Non-mutating (returns new objects).
 *
 * @param {Array<object>} profiles
 * @param {Map} enrichmentByUrl  from buildProspectEnrichmentIndex
 * @param {(url:string)=>string} normalizeUrl
 * @returns {Array<object>}
 */
function overlayProspectEnrichment(profiles, enrichmentByUrl, normalizeUrl) {
  if (!Array.isArray(profiles)) return [];
  const index = enrichmentByUrl instanceof Map ? enrichmentByUrl : new Map();
  if (typeof normalizeUrl !== 'function') return profiles;
  return profiles.map((profile) => {
    if (!profile || typeof profile !== 'object') return profile;
    const url = normalizeUrl(firstProfileUrl(profile));
    const enrich = url ? index.get(url) : null;
    if (!enrich) return profile;
    const next = { ...profile };
    if (enrich.fullName) next.fullName = enrich.fullName;
    if (enrich.title) {
      next.title = enrich.title;
      next.position = enrich.title;
    }
    if (enrich.company) next.company = enrich.company;
    next.enrichmentSource = 'prospect';
    return next;
  });
}

module.exports = {
  buildProspectEnrichmentIndex,
  overlayProspectEnrichment
};
