'use strict';

/**
 * automation/profile/group-member-enrichment.js
 *
 * Groups store members as bare LinkedIn URL strings (backward-compatible, not
 * migrated). For UI display we enrich on READ: join each member URL against the
 * already-source-of-truth enriched profile list (getEnrichedStoredProfiles,
 * which itself overlays the SQLite prospect over profiles.json) and attach a
 * parallel `memberProfiles` array of { url, name, title, company }.
 *
 * The original `members` string array is left UNCHANGED so every existing
 * consumer (and saveGroupsData, whose sanitizer only keeps known fields) keeps
 * working — no storage migration, no risk to existing groups.
 *
 * Pure (no I/O). normalizeUrl is injected; unit-testable.
 */

function cleanField(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!s || s === 'Not Available' || s === 'Not available' || s === 'Unknown Profile' || s === 'Unknown') {
    return null;
  }
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
 * Build Map<normalizedUrl, {profileUrl, fullName, title, company}> from the
 * (already enriched) profile list. First record per URL wins.
 */
function buildProfileLookupIndex(profiles, normalizeUrl) {
  const index = new Map();
  if (!Array.isArray(profiles) || typeof normalizeUrl !== 'function') return index;
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue;
    const raw = firstProfileUrl(profile);
    const url = normalizeUrl(raw);
    if (!url || index.has(url)) continue;
    index.set(url, {
      profileUrl: raw || null,
      fullName: cleanField(profile.fullName),
      title: cleanField(profile.title || profile.position),
      company: cleanField(profile.company)
    });
  }
  return index;
}

function memberUrlOf(member) {
  if (typeof member === 'string') return member;
  if (member && typeof member === 'object') return member.url || member.profileUrl || member.value || '';
  return '';
}

/**
 * Attach a `memberProfiles` array to each group by joining its member URLs
 * against the profile lookup. `members` is preserved unchanged. Groups without
 * a matching profile still get a memberProfiles entry (url + nulls / any inline
 * name on an object member).
 */
function enrichGroupMembers(groups, lookupByUrl, normalizeUrl) {
  if (!Array.isArray(groups)) return [];
  const index = lookupByUrl instanceof Map ? lookupByUrl : new Map();
  const norm = typeof normalizeUrl === 'function' ? normalizeUrl : (x) => String(x || '');
  return groups.map((group) => {
    if (!group || typeof group !== 'object') return group;
    const members = Array.isArray(group.members) ? group.members : [];
    const memberProfiles = members.map((member) => {
      const rawUrl = memberUrlOf(member);
      const enrich = rawUrl ? index.get(norm(rawUrl)) : null;
      const inlineName = (member && typeof member === 'object')
        ? cleanField(member.name || member.fullName || member.label)
        : null;
      return {
        url: rawUrl || null,
        name: (enrich && enrich.fullName) || inlineName || null,
        title: (enrich && enrich.title) || null,
        company: (enrich && enrich.company) || null
      };
    });
    return { ...group, memberProfiles };
  });
}

module.exports = {
  buildProfileLookupIndex,
  enrichGroupMembers
};
