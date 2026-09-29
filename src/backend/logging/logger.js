/**
 * Logger.
 *
 * Three sinks, all fed from one call:
 *   1. the `logs` table, which the Activity view reads,
 *   2. a daily file under logs/,
 *   3. the event bus, which forwards to the renderer's toasts.
 *
 * Every message and every meta value is scrubbed by redact.js before it reaches
 * any of them, so a token cannot end up in the database or on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { logsDir } from '../paths.js';
import { run } from '../db/index.js';
import { bus, EVENTS } from '../events.js';
import { scrub, scrubDeep } from './redact.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let config = { level: 'info', toFile: true, maxRows: 50000 };
let stream = null;
let streamDay = null;
let pendingTrim = 0;

export function configureLogger({ level, toFile, maxRows } = {}) {
  if (level && LEVELS[level]) config.level = level;
  if (typeof toFile === 'boolean') config.toFile = toFile;
  if (Number.isFinite(maxRows)) config.maxRows = maxRows;
  if (!config.toFile) closeStream();
}

function closeStream() {
  if (stream) { try { stream.end(); } catch { /* already gone */ } }
  stream = null;
  streamDay = null;
}

function fileStream() {
  if (!config.toFile) return null;
  const day = new Date().toISOString().slice(0, 10);
  if (stream && streamDay === day) return stream;
  closeStream();
  try {
    stream = fs.createWriteStream(path.join(logsDir(), `flora-${day}.log`), { flags: 'a' });
    stream.on('error', () => { stream = null; });   // disk full / permissions
    streamDay = day;
  } catch {
    stream = null;
  }
  return stream;
}

function shouldLog(level) {
  return LEVELS[level] >= LEVELS[config.level];
}

/**
 * Write one entry.
 *
 * Never throws: a logging failure in a bot's error path would otherwise turn a
 * recoverable disconnect into a crash.
 */
function write(level, scope, message, meta = null, accountId = null) {
  if (!shouldLog(level)) return;

  let safeMessage;
  let safeMeta;
  try {
    safeMessage = scrub(String(message ?? ''));
    safeMeta = meta == null ? null : scrubDeep(meta);
  } catch {
    safeMessage = '[unloggable message]';
    safeMeta = null;
  }

  const ts = Date.now();
  const metaJson = safeMeta ? JSON.stringify(safeMeta) : null;

  try {
    run(
      'INSERT INTO logs (ts, level, scope, message, meta, account_id) VALUES (?, ?, ?, ?, ?, ?)',
      ts, level, scope, safeMessage, metaJson, accountId
    );
    // Trimming on every write is wasteful; batch it.
    if (++pendingTrim >= 250) { pendingTrim = 0; trim(); }
  } catch { /* database unavailable during shutdown */ }

  try {
    const s = fileStream();
    if (s) {
      const line = `${new Date(ts).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${safeMessage}` +
        (metaJson ? ` ${metaJson}` : '') + '\n';
      s.write(line);
    }
  } catch { /* non-fatal */ }

  try {
    bus.emit(EVENTS.LOG, { ts, level, scope, message: safeMessage, meta: safeMeta, accountId });
  } catch { /* non-fatal */ }
}

/** Drop the oldest rows once the table passes its cap. */
export function trim() {
  try {
    run(
      `DELETE FROM logs WHERE id NOT IN (
         SELECT id FROM logs ORDER BY id DESC LIMIT ?
       )`,
      config.maxRows
    );
  } catch { /* non-fatal */ }
}

function make(level) {
  return (scope, message, opts = {}) =>
    write(level, scope, message, opts.meta ?? null, opts.accountId ?? null);
}

export const logger = {
  debug: make('debug'),
  info: make('info'),
  warn: make('warn'),
  error: make('error')
};

/** Delete log rows and files older than the retention window. */
export function prune(retentionDays = 14) {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  try { run('DELETE FROM logs WHERE ts < ?', cutoff); } catch { /* non-fatal */ }

  try {
    for (const name of fs.readdirSync(logsDir())) {
      const m = /^flora-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (!m) continue;
      if (Date.parse(`${m[1]}T00:00:00Z`) < cutoff) {
        try { fs.unlinkSync(path.join(logsDir(), name)); } catch { /* locked */ }
      }
    }
  } catch { /* directory missing */ }
}

export function closeLogger() {
  closeStream();
}

export { LEVELS };
