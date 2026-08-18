'use strict';

/**
 * storage/run-legacy-importers.js
 *
 * Phase B step 5 of roadmap #7. The seam between main.js (which owns
 * environment variables + Electron paths) and the pure importer modules
 * (storage/profile-legacy-importer + storage/group-legacy-importer). This
 * module is itself pure — no `process.env` reads, no Electron globals.
 *
 * Layering:
 *
 *   main.js                                — env check + path resolution
 *     └── runLegacyImporters({...})        — orchestration (this file)
 *           ├── importProfiles(db, ...)    — data logic (profile-legacy-importer)
 *           └── importGroups(db, ...)      — data logic (group-legacy-importer)
 *
 * Contract:
 *
 *   runLegacyImporters({
 *     db,             // open SQLite handle
 *     prospectStore,  // ProspectQueueStore instance
 *     documentsDir,   // absolute path to Documents/Connect-Ability
 *     userDataDir,    // absolute path to app.getPath('userData')
 *     disabled,       // boolean — caller-evaluated CONNECT_DISABLE_LEGACY_IMPORT
 *     logger          // optional (msg: string) => void
 *   })
 *     → { profiles: ImporterResult, groups: ImporterResult, disabled: boolean }
 *
 * When `disabled === true`: returns immediately with zero-filled results
 * and no IO. No log lines emitted.
 *
 * When `disabled === false`: runs both importers in sequence and emits one
 * log line per importer via the logger. Returns the combined result.
 */

const path = require('path');

const { importProfiles } = require('./profile-legacy-importer');
const { importGroups } = require('./group-legacy-importer');

const ZERO_PROFILES_RESULT = Object.freeze({
  read: 0, importedProspects: 0, importedActions: 0, skipped: 0, errors: 0, ranAt: null
});

const ZERO_GROUPS_RESULT = Object.freeze({
  read: 0, importedGroups: 0, importedMembers: 0, skipped: 0, errors: 0, ranAt: null
});

function runLegacyImporters({
  db,
  prospectStore,
  documentsDir,
  userDataDir,
  disabled,
  logger
} = {}) {
  const log = typeof logger === 'function' ? logger : () => {};

  if (disabled === true) {
    return {
      profiles: { ...ZERO_PROFILES_RESULT },
      groups: { ...ZERO_GROUPS_RESULT },
      disabled: true
    };
  }

  const profiles = importProfiles(db, {
    profilesPath: path.join(documentsDir, 'profiles.json'),
    prospectStore
  });
  log(formatProfilesLog(profiles));

  const groups = importGroups(db, {
    groupsPaths: [
      path.join(documentsDir, 'groups.json'),
      path.join(documentsDir, 'standalone-groups.json'),
      path.join(userDataDir, 'groups.json')
    ],
    prospectStore
  });
  log(formatGroupsLog(groups));

  return {
    profiles,
    groups,
    disabled: false
  };
}

function formatProfilesLog(r) {
  return (
    `[legacy-import] profiles: read=${r.read} ` +
    `importedProspects=${r.importedProspects} importedActions=${r.importedActions} ` +
    `skipped=${r.skipped} errors=${r.errors}`
  );
}

function formatGroupsLog(r) {
  return (
    `[legacy-import] groups: read=${r.read} ` +
    `importedGroups=${r.importedGroups} importedMembers=${r.importedMembers} ` +
    `skipped=${r.skipped} errors=${r.errors}`
  );
}

module.exports = {
  runLegacyImporters
};
