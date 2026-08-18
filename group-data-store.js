const path = require('path');

const {
  getConnectAbilityAppStateDir,
  getConnectAbilityDocumentsDir,
  readJsonFile
} = require('./connect-documents');

class GroupDataStore {
  constructor(options = {}) {
    this.paths = Array.isArray(options.paths) && options.paths.length
      ? options.paths
      : [
          path.join(getConnectAbilityDocumentsDir(), 'groups.json'),
          path.join(getConnectAbilityDocumentsDir(), 'standalone-groups.json'),
          path.join(getConnectAbilityAppStateDir(), 'groups.json')
        ];
  }

  getAllGroups() {
    const mergedGroups = new Map();
    for (const groupPath of this.paths) {
      const groups = readJsonFile(groupPath, []);
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const normalized = normalizeGroupRecord(group, mergedGroups.size);
        if (!normalized) continue;
        mergedGroups.set(normalized.id, normalized);
      }
    }
    return Array.from(mergedGroups.values())
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getGroup(groupIdOrName = null) {
    const needle = String(groupIdOrName || '').trim().toLowerCase();
    if (!needle) return null;
    return this.getAllGroups().find((group) => {
      return group.id.toLowerCase() === needle || group.name.toLowerCase() === needle;
    }) || null;
  }
}

function normalizeGroupRecord(group, index = 0) {
  if (!group || typeof group !== 'object') return null;
  const name = cleanString(group.name, 160);
  const id = cleanString(group.id, 160) || (name ? `group:${slugify(name)}` : `group-${index + 1}`);
  const members = Array.isArray(group.members)
    ? group.members.map(normalizeGroupMember).filter(Boolean)
    : [];

  return {
    id,
    name: name || id,
    description: cleanString(group.description, 500) || null,
    color: cleanString(group.color, 32) || '#0a66c2',
    createdAt: cleanString(group.createdAt, 80) || null,
    updatedAt: cleanString(group.updatedAt, 80) || null,
    members
  };
}

function normalizeGroupMember(member) {
  if (typeof member === 'string') {
    const value = cleanString(member, 400);
    if (!value) return null;
    return {
      value,
      label: value,
      profileUrl: looksLikeLinkedInProfile(value) ? value : null,
      fullName: looksLikeLinkedInProfile(value) ? null : value
    };
  }
  if (!member || typeof member !== 'object') return null;

  const profileUrl = cleanString(member.profileUrl || member.url || member.value, 400);
  const fullName = cleanString(member.fullName || member.name || member.label, 240);
  const value = profileUrl || fullName;
  if (!value) return null;

  return {
    value,
    label: cleanString(member.label, 240) || fullName || profileUrl,
    profileUrl: looksLikeLinkedInProfile(profileUrl) ? profileUrl : null,
    fullName: fullName || (looksLikeLinkedInProfile(value) ? null : value)
  };
}

function looksLikeLinkedInProfile(value = '') {
  return /linkedin\.com\/in\//i.test(String(value || ''));
}

function slugify(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cleanString(value, maxLength = 200) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = GroupDataStore;
