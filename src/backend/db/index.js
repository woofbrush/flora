/**
 * Database handle.
 *
 * Uses `node:sqlite`, built into the Node runtime Electron ships, so there is
 * no native module to compile and nothing to rebuild per Electron version.
 *
 * The API here is deliberately small: `db()` for the handle, plus helpers for
 * the two shapes the rest of the backend actually needs (one row, all rows,
 * run-and-get-id). Repositories build on these rather than touching prepare()
 * directly, which keeps statement caching in one place.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { dbFile, dataRoot, backupsDir } from '../paths.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

let handle = null;
const cache = new Map();

/** Open (or create) the database and apply the schema. Safe to call repeatedly. */
export function db() {
  if (handle) return handle;

  const file = dbFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  handle = new DatabaseSync(file);

  // WAL means a crash mid-write cannot corrupt the file. The busy timeout keeps
  // a background write from failing while a foreground read holds the lock.
  handle.exec('PRAGMA journal_mode = WAL;');
  handle.exec('PRAGMA foreign_keys = ON;');
  handle.exec('PRAGMA busy_timeout = 5000;');
  handle.exec(SCHEMA_SQL);

  const current = handle.prepare('PRAGMA user_version').get().user_version ?? 0;
  if (current < SCHEMA_VERSION) {
    handle.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  return handle;
}

/** Prepare + cache a statement. Statements are reusable across calls. */
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db().prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

/** First matching row, or undefined. */
export const get = (sql, ...params) => stmt(sql).get(...params);

/** Every matching row. */
export const all = (sql, ...params) => stmt(sql).all(...params);

/** Execute a write. Returns { changes, lastInsertRowid }. */
export function run(sql, ...params) {
  const res = stmt(sql).run(...params);
  return {
    changes: Number(res.changes ?? 0),
    lastInsertRowid: Number(res.lastInsertRowid ?? 0)
  };
}

/** Convenience for `SELECT COUNT(*) AS n` style queries. */
export function count(sql, ...params) {
  const row = get(sql, ...params);
  return row ? Number(Object.values(row)[0]) : 0;
}

/**
 * Wrap `fn` in a transaction. Nested calls reuse the outer transaction so a
 * repository method can be composed safely.
 */
let depth = 0;
export function transaction(fn) {
  const h = db();
  if (depth > 0) return fn();

  depth += 1;
  h.exec('BEGIN');
  try {
    const result = fn();
    h.exec('COMMIT');
    return result;
  } catch (err) {
    try { h.exec('ROLLBACK'); } catch { /* already unwound */ }
    throw err;
  } finally {
    depth -= 1;
  }
}

export function closeDb() {
  if (!handle) return;
  try { handle.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* non-fatal */ }
  try { handle.close(); } catch { /* already closed */ }
  handle = null;
  cache.clear();
}

export function info() {
  return { file: dbFile(), root: dataRoot(), version: SCHEMA_VERSION };
}

/**
 * Copy the database (and its WAL) into backups/ before a destructive import or
 * a schema upgrade. Returns the written path, or null when there is nothing yet.
 */
export function snapshot(reason = 'manual') {
  const src = dbFile();
  if (!fs.existsSync(src)) return null;
  try { handle?.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* non-fatal */ }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupsDir(), `${path.basename(src, '.db')}-${reason}-${stamp}.db`);
  fs.copyFileSync(src, dest);
  return dest;
}
