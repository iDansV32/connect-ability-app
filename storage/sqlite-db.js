'use strict';

/**
 * storage/sqlite-db.js — SQLite connection helper (scaffold from Ticket 3)
 *
 * This module wraps the installed `better-sqlite3` package. Electron uses the
 * root dependency, while Node backends may use an ABI-specific runtime cache.
 *
 * The lazy require pattern (require inside openDatabase rather than at module
 * load) means importing this file never throws, even without the package.
 * Only calling openDatabase() throws when the dependency is absent.
 *
 * Usage:
 *
 *   const { openDatabase } = require('./storage/sqlite-db');
 *   const db = openDatabase('/path/to/connect-ability.db');
 *   // db is a better-sqlite3 Database instance, already migrated.
 *
 * After openDatabase returns:
 *   - All tables and indexes from schema.js exist (IF NOT EXISTS).
 *   - WAL journal mode is enabled for safe concurrent reads during writes.
 *   - Busy timeout is set to 5 000 ms to handle writer contention gracefully.
 *   - Foreign key enforcement is on.
 */

const { ALL_DDL, SCHEMA_VERSION } = require('./schema');
const path = require('path');

/**
 * The expected npm package name, centralised so the runtime launcher and
 * connection helper share one driver identity.
 */
const DRIVER_PACKAGE = 'better-sqlite3';

/**
 * Load the SQLite driver without forcing Node and Electron to share one
 * native binary. The desktop app intentionally uses the package in the root
 * node_modules tree. Node-based backends/tests may point at an ABI-specific
 * cache through CONNECT_NATIVE_MODULES_DIR.
 */
function loadDatabaseDriver() {
  const nativeModulesDir = String(process.env.CONNECT_NATIVE_MODULES_DIR || '').trim();
  const candidates = nativeModulesDir
    ? [path.join(nativeModulesDir, DRIVER_PACKAGE), DRIVER_PACKAGE]
    : [DRIVER_PACKAGE];
  const errors = [];

  for (const candidate of candidates) {
    try {
      return require(candidate); // eslint-disable-line global-require, import/no-dynamic-require
    } catch (error) {
      errors.push(`${candidate}: ${error.message || String(error)}`);
    }
  }

  throw new Error(
    `SQLite driver unavailable for this runtime (ABI ${process.versions.modules || 'unknown'}). ` +
    `Run \`npm run rebuild:node\` for Node backends or \`npm run rebuild:electron\` ` +
    `for the desktop app. Attempts: ${errors.join(' | ')}`
  );
}

/**
 * Open (or create) the SQLite database at `dbPath`, run all schema DDL,
 * and return the initialised `better-sqlite3` Database instance.
 *
 * @param {string} dbPath  Absolute path to the .db file.
 * @param {object} [options]
 * @param {boolean} [options.readonly=false]  Open in read-only mode.
 * @param {boolean} [options.verbose=false]   Log every SQL statement.
 * @returns {import('better-sqlite3').Database}
 * @throws {Error} If better-sqlite3 is not installed.
 */
function openDatabase(dbPath, options = {}) {
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new TypeError('openDatabase: dbPath must be a non-empty string');
  }

  // Lazy load — fails only here, not at module import time.
  const Database = loadDatabaseDriver();

  const verboseLog = options.verbose
    ? (sql) => console.debug('[sqlite]', sql)
    : undefined;

  const db = new Database(dbPath.trim(), {
    readonly: Boolean(options.readonly),
    verbose:  verboseLog
  });

  if (!options.readonly) {
    applyPragmas(db);
    applySchema(db);
  }

  return db;
}

/**
 * Apply connection-level PRAGMAs.  Called once immediately after opening.
 *
 * WAL mode:   Readers never block writers and writers never block readers.
 *             Critical for the Electron main process + renderer concurrent access.
 * busy_timeout: Retry for up to 5 s instead of throwing SQLITE_BUSY immediately.
 * foreign_keys: Enforce FK constraints (off by default in SQLite).
 * synchronous NORMAL: Safe with WAL; fsync only at WAL checkpoints, not every write.
 *
 * @param {import('better-sqlite3').Database} db
 */
function applyPragmas(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
}

/**
 * Run all CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS statements.
 * Wrapped in a transaction so the entire schema is applied atomically.
 *
 * @param {import('better-sqlite3').Database} db
 */
function applySchema(db) {
  const migrate = db.transaction(() => {
    for (const ddl of ALL_DDL) {
      const trimmed = ddl.trim().toUpperCase();
      if (trimmed.startsWith('ALTER TABLE')) {
        // ALTER TABLE ADD COLUMN throws when the column already exists.
        // Silently swallow the error so startup is idempotent whether the
        // database is brand-new (column already in CREATE TABLE) or legacy
        // (column genuinely absent and needs to be added).
        try { db.exec(ddl); } catch (_) { /* column already exists */ }
      } else {
        db.exec(ddl);
      }
    }
  });
  migrate();
}

/**
 * Convenience: close the database handle, flushing the WAL and releasing the
 * file lock.  Idempotent — calling close on an already-closed db is a no-op.
 *
 * @param {import('better-sqlite3').Database} db
 */
function closeDatabase(db) {
  if (db && typeof db.close === 'function' && db.open) {
    db.close();
  }
}

module.exports = {
  SCHEMA_VERSION,
  DRIVER_PACKAGE,
  loadDatabaseDriver,
  openDatabase,
  closeDatabase
};
