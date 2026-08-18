'use strict';

/**
 * storage/sqlite-group-repository.js
 *
 * Phase C step C2b-1 of roadmap #7 (profiles/groups → SQLite migration).
 *
 * The shared SQLite WRITE side for groups. Used by the `save-groups-data`
 * dual-write so main.js never duplicates group INSERT SQL inline. The read
 * side lives in storage/group-reconstruction.js (used by the C2b-2 read flip).
 *
 * `saveGroups` mirrors the semantics of `save-groups-data`: the renderer sends
 * the COMPLETE desired set of groups, so this is a transactional full-state
 * REPLACE (not the additive INSERT-OR-IGNORE the legacy importer uses):
 *   - groups present in the payload are upserted (created_at preserved on
 *     update, updated_at refreshed);
 *   - groups absent from the payload are deleted (cascading their members);
 *   - each group's members are reconciled by delete-then-reinsert in payload
 *     order, so group_members.rowid order == the renderer's display order
 *     (which group-reconstruction reads back via ORDER BY rowid).
 *
 * Fields are stored verbatim from the sanitized payload (e.g. description ''
 * stays '') so the SQLite copy mirrors exactly what the JSON files just got —
 * this keeps the C2b-2 read flip field-for-field equivalent for UI-saved
 * groups. (account_id is intentionally NULL: the save-groups-data sanitizer
 * drops accountId, same as the legacy JSON path.)
 *
 * Purity: takes an open better-sqlite3 handle + the sanitized groups array +
 * an optional injected prospect lookup / clock. No Electron, no process.env,
 * no app paths. The main.js boundary owns those and calls this best-effort.
 */

const { normalizeProfileUrl } = require('../automation/url/normalize');

class SqliteGroupRepository {
  constructor(db) {
    this._db = db;
  }

  /**
   * Full-state replace of the groups + group_members tables to match the
   * given sanitized payload. Runs in a single transaction.
   *
   * @param {Array<object>} groups  sanitized group records
   *        ({ id, name, description, members:[urlString], color, createdAt, updatedAt })
   * @param {object} [options]
   * @param {Map<string,string>} [options.prospectIdByUrl]  normalizedUrl -> prospectId backfill
   * @param {() => Date} [options.now]  clock injection
   * @returns {{ groups:number, members:number }} counts written
   */
  saveGroups(groups, options = {}) {
    const list = Array.isArray(groups) ? groups : [];
    const prospectIdByUrl = options.prospectIdByUrl instanceof Map ? options.prospectIdByUrl : new Map();
    const clock = typeof options.now === 'function' ? options.now : () => new Date();
    const nowIso = clock().toISOString();
    const db = this._db;

    const selectAllIds = db.prepare('SELECT id FROM groups');
    const selectCreatedAt = db.prepare('SELECT created_at FROM groups WHERE id = ?');
    const deleteGroup = db.prepare('DELETE FROM groups WHERE id = ?');
    const upsertGroup = db.prepare(`
      INSERT INTO groups (id, name, description, color, account_id, created_at, updated_at)
      VALUES (@id, @name, @description, @color, @account_id, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        name        = excluded.name,
        description = excluded.description,
        color       = excluded.color,
        account_id  = excluded.account_id,
        created_at  = excluded.created_at,
        updated_at  = excluded.updated_at
    `);
    const deleteMembers = db.prepare('DELETE FROM group_members WHERE group_id = ?');
    const insertMember = db.prepare(`
      INSERT OR IGNORE INTO group_members
        (group_id, profile_url, normalized_profile_url, prospect_id, member_metadata_json, added_at)
      VALUES
        (@group_id, @profile_url, @normalized_profile_url, @prospect_id, @member_metadata_json, @added_at)
    `);

    const counts = { groups: 0, members: 0 };

    const run = db.transaction(() => {
      const keepIds = new Set(list.map((g) => String(g.id)));

      // 1. Remove groups no longer present (members cascade via FK).
      for (const row of selectAllIds.all()) {
        if (!keepIds.has(String(row.id))) {
          deleteGroup.run(row.id);
        }
      }

      // 2. Upsert each present group + reconcile its members.
      for (const group of list) {
        const id = String(group.id);
        const existing = selectCreatedAt.get(id);
        const createdAt = group.createdAt || (existing && existing.created_at) || nowIso;
        const updatedAt = group.updatedAt || nowIso;

        upsertGroup.run({
          id,
          name: group.name != null ? String(group.name) : id,
          description: group.description != null ? String(group.description) : null,
          color: group.color != null ? String(group.color) : null,
          account_id: null,
          created_at: createdAt,
          updated_at: updatedAt
        });
        counts.groups += 1;

        // Members: delete-then-reinsert in payload order so rowid == order.
        deleteMembers.run(id);
        const seen = new Set();
        const members = Array.isArray(group.members) ? group.members : [];
        for (const rawMember of members) {
          const url = typeof rawMember === 'string' ? rawMember.trim() : '';
          if (!url) continue;
          const normalized = normalizeProfileUrl(url);
          if (!normalized || seen.has(normalized)) continue;
          seen.add(normalized);
          const result = insertMember.run({
            group_id: id,
            profile_url: url,
            normalized_profile_url: normalized,
            prospect_id: prospectIdByUrl.get(normalized) || null,
            member_metadata_json: null,
            added_at: nowIso
          });
          if (result.changes === 1) counts.members += 1;
        }
      }
    });

    run();
    return counts;
  }
}

module.exports = SqliteGroupRepository;
