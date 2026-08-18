'use strict';

/**
 * storage/group-reconstruction.js
 *
 * Phase C step C2a of roadmap #7 (profiles/groups → SQLite migration).
 *
 * Pure reconstruction helper: rebuilds the legacy `get-groups-data` group
 * shape (PRE-enrichment) from the SQLite spine (`groups` + `group_members`).
 * This is the machinery the C2b read-flip will install in place of the 3-path
 * JSON merge in main.js's `get-groups-data` handler. C2a builds and proves it
 * in isolation — NO runtime wiring, no profile-read changes.
 *
 * Today `get-groups-data` (main.js) does:
 *   1. merge 3 groups.json paths into a Map keyed by id (last path wins);
 *   2. for each group, `members` = bare URL strings (filtered truthy);
 *   3. enrich on read via enrichGroupMembers(getEnrichedStoredProfiles(...))
 *      → attaches a parallel `memberProfiles[]`. `members` is left unchanged.
 *
 * C2 flips only step 1+2 (the groups/members SPINE) to SQLite. Step 3 (the
 * enrichment, which IS the profile read) stays exactly as-is until C3. So this
 * helper reconstructs the PRE-enrichment group object; the caller still pipes
 * it through the unchanged `enrichGroupMembers`.
 *
 * Reconstructed shape (matches the merged group before enrichment):
 *
 *     { id, name, description?, color?, accountId?, createdAt, updatedAt,
 *       members: [profileUrlString, ...] }
 *
 * Ordering: `ORDER BY rowid` for both groups and members reproduces import
 * insertion order, which mirrors the legacy first-encountered/array order
 * (the importer inserts groups + members in source order). group_members is
 * NOT declared WITHOUT ROWID, so the implicit rowid is a stable insertion key.
 *
 * Known, INTENTIONAL narrowings vs the legacy 3-path JSON merge (documented +
 * pinned by tests, not bugs):
 *   - Empty-string group fields (description/color) collapse to absent — the
 *     importer stored them as NULL (`pickString(...) || null`), so '' isn't
 *     recoverable. Equivalence holds for the common case of non-empty fields.
 *   - Arbitrary ad-hoc group fields not in the schema (id/name/description/
 *     color/account_id/created_at/updated_at) are dropped — only the known
 *     columns were imported.
 *   - Duplicate member URL-variants within one group collapse to one row
 *     (composite PK on normalized_profile_url). The legacy read kept every
 *     truthy member string verbatim.
 *   - Multi-path merge tie-break differs: the legacy READ handler is
 *     "last path wins"; the importer (and therefore this spine) is "newest
 *     updatedAt wins". Identical for single-source data; documented for the
 *     3-replica case (the importer's rule is the more correct one).
 *
 * Purity: `reconstructGroupRecord` is pure. `reconstructGroups(db)` takes an
 * open better-sqlite3 handle only — no Electron, no process.env, no app paths.
 */

/**
 * Build a single pre-enrichment group object from a `groups` row + its ordered
 * member URL strings.
 *
 * @param {object} groupRow            a `groups` table row
 * @param {Array<string>} memberUrls   profile_url strings, pre-ordered (rowid)
 * @returns {object} legacy-shaped group (pre-enrichment)
 */
function reconstructGroupRecord(groupRow, memberUrls) {
  const g = groupRow || {};
  const record = {
    id: g.id,
    name: g.name
  };
  // Optional descriptive fields: present only when non-null, matching what the
  // legacy merge carried for populated groups (and the empty→null narrowing).
  if (g.description != null) record.description = g.description;
  if (g.color != null) record.color = g.color;
  if (g.account_id != null) record.accountId = g.account_id;

  // The importer guarantees non-null created_at/updated_at (defaults to run
  // time when the source omitted them), and real groups.json always carries
  // both — so they are always emitted.
  record.createdAt = g.created_at;
  record.updatedAt = g.updated_at;

  record.members = Array.isArray(memberUrls) ? memberUrls.slice() : [];
  return record;
}

/**
 * Reconstruct the full pre-enrichment groups list from the SQLite spine.
 *
 * Groups are returned in `rowid` order (import/first-encountered order); each
 * group's members are its `group_members.profile_url` strings in `rowid`
 * (insertion) order. No account filtering — `get-groups-data` shows all groups
 * regardless of account, same as the legacy 3-path merge.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<object>} pre-enrichment group objects
 */
function reconstructGroups(db) {
  const groupRows = db.prepare('SELECT * FROM groups ORDER BY rowid').all();
  if (!groupRows.length) return [];

  // One ordered pass over members, grouped by group_id while preserving the
  // global rowid order within each group.
  const membersByGroup = new Map();
  const memberRows = db
    .prepare('SELECT group_id, profile_url FROM group_members ORDER BY rowid')
    .all();
  for (const row of memberRows) {
    if (!membersByGroup.has(row.group_id)) {
      membersByGroup.set(row.group_id, []);
    }
    membersByGroup.get(row.group_id).push(row.profile_url);
  }

  return groupRows.map((groupRow) =>
    reconstructGroupRecord(groupRow, membersByGroup.get(groupRow.id) || [])
  );
}

module.exports = {
  reconstructGroupRecord,
  reconstructGroups
};
