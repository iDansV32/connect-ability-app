'use strict';

/**
 * storage/groups-read-source.js
 *
 * Phase C step C2b-2 of roadmap #7 (profiles/groups → SQLite migration).
 *
 * Pure decision helper for the `get-groups-data` read flip: given the raw
 * rollback flag value and the `import_state` row for the groups importer,
 * decide whether the read should be served from the SQLite spine
 * (reconstructGroups) or the legacy 3-path JSON merge.
 *
 * Pure: no env reads, no DB access, no logging. The main.js boundary reads
 * `process.env.CONNECT_USE_LEGACY_JSON_STORES` + queries the import_state row,
 * calls this, then logs the decision (and, loudly, any unknown rollback tokens
 * so a typo'd emergency rollback that silently didn't apply is visible).
 *
 * Contract:
 *   resolveGroupsReadSource({ rollbackFlag, importStateRow })
 *     -> { source: 'sqlite' | 'json', reason: string, unknownTokens: string[] }
 *
 * Rollback flag token semantics (CONNECT_USE_LEGACY_JSON_STORES):
 *   - comma-split, trimmed, lowercased.
 *   - recognized tokens: '1' (global), 'groups', 'profiles'.
 *   - unknown tokens are IGNORED (do not force JSON) but RETURNED in
 *     unknownTokens so the boundary can log them. Rationale: the rollback flag
 *     is operator ergonomics, not security policy — but because it's an
 *     emergency bail-out, a typo must be loud, not silent.
 *
 * Decision order (rollback precedence first, then readiness):
 *   1. '1'        -> json, 'rollback_global'
 *   2. 'groups'   -> json, 'rollback_targeted_groups'
 *      ('profiles' alone does NOT affect the groups surface)
 *   3. no import_state row                       -> json, 'not_ready_no_import_state'
 *   4. missing/malformed/nonzero last_run_errors -> json, 'not_ready_errors'
 *   5. row + numeric last_run_errors === 0       -> sqlite, 'sqlite_ok'
 *
 * Readiness deliberately does NOT require total_imported > 0: a clean
 * zero-group import is migration-ready.
 */

const RECOGNIZED_TOKENS = new Set(['1', 'groups', 'profiles']);

function parseRollbackTokens(rollbackFlag) {
  const raw = rollbackFlag == null ? '' : String(rollbackFlag);
  const tokens = new Set();
  const unknownTokens = [];
  for (const part of raw.split(',')) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    if (RECOGNIZED_TOKENS.has(t)) {
      tokens.add(t);
    } else if (!unknownTokens.includes(t)) {
      unknownTokens.push(t);
    }
  }
  return { tokens, unknownTokens };
}

/**
 * @param {object} [input]
 * @param {*} [input.rollbackFlag]       raw CONNECT_USE_LEGACY_JSON_STORES value
 * @param {object|null} [input.importStateRow]  import_state row for 'groups' (or null)
 * @returns {{ source:('sqlite'|'json'), reason:string, unknownTokens:string[] }}
 */
function resolveGroupsReadSource(input = {}) {
  const { tokens, unknownTokens } = parseRollbackTokens(input.rollbackFlag);

  // 1-2: rollback precedence.
  if (tokens.has('1')) {
    return { source: 'json', reason: 'rollback_global', unknownTokens };
  }
  if (tokens.has('groups')) {
    return { source: 'json', reason: 'rollback_targeted_groups', unknownTokens };
  }
  // 'profiles' alone is not a groups rollback — fall through to readiness.

  // 3: readiness — import_state row must exist.
  const row = input.importStateRow;
  if (!row || typeof row !== 'object') {
    return { source: 'json', reason: 'not_ready_no_import_state', unknownTokens };
  }

  // 4: last_run_errors must be a finite numeric zero. Guard null/undefined
  // explicitly (Number(null) === 0 would otherwise read as ready).
  const rawErrors = row.last_run_errors;
  if (rawErrors == null) {
    return { source: 'json', reason: 'not_ready_errors', unknownTokens };
  }
  const errors = Number(rawErrors);
  if (!Number.isFinite(errors) || errors !== 0) {
    return { source: 'json', reason: 'not_ready_errors', unknownTokens };
  }

  // 5: ready.
  return { source: 'sqlite', reason: 'sqlite_ok', unknownTokens };
}

module.exports = {
  resolveGroupsReadSource
};
