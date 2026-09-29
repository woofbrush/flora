/**
 * Schema.
 *
 * Applied on every boot inside a transaction. Each statement is idempotent
 * (IF NOT EXISTS) so an existing database is upgraded in place rather than
 * needing a migration framework for what is still a small schema.
 *
 * `user_version` tracks the revision: bump SCHEMA_VERSION and add the matching
 * ALTER statements below when a column changes.
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT    NOT NULL DEFAULT '',
  uuid            TEXT,
  -- Sealed with AES-256-GCM; the key lives in secret.key, not in this file.
  token_sealed    TEXT,
  -- Human-readable tail of the token, for telling rows apart in the UI.
  token_hint      TEXT,
  -- sha256 of the token: duplicate detection without a second plaintext copy.
  token_fp        TEXT,
  -- Password for kind='offline' accounts, sealed with the same key.
  -- Kept separate from token_sealed so a token can never be mistaken for a
  -- password by a caller that only knows the account id.
  password_sealed TEXT,
  password_hint   TEXT,
  -- 'msa'     - added by Microsoft sign-in, refreshable from cache_id
  -- 'token'   - imported access token
  -- 'offline' - username + password for offline-mode servers
  kind            TEXT    NOT NULL DEFAULT 'token',
  -- prismarine-auth cache folder name; required to refresh an 'msa' account.
  cache_id        TEXT,
  label           TEXT    NOT NULL DEFAULT '',
  notes           TEXT    NOT NULL DEFAULT '',
  -- Comma-wrapped tag list, e.g. ',main,alt,' - matched with LIKE.
  tags            TEXT    NOT NULL DEFAULT '',
  selected        INTEGER NOT NULL DEFAULT 0,
  favorite        INTEGER NOT NULL DEFAULT 0,
  proxy_id        INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  -- Cached skin facts so lists render without hitting the network.
  skin_hash       TEXT,
  skin_model      TEXT,
  last_tested_at  INTEGER,
  last_test_ok    INTEGER,
  last_test_error TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_selected ON accounts(selected);
CREATE INDEX IF NOT EXISTS idx_accounts_fp       ON accounts(token_fp);
CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);

CREATE TABLE IF NOT EXISTS proxies (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  host            TEXT    NOT NULL,
  port            INTEGER NOT NULL,
  username        TEXT    NOT NULL DEFAULT '',
  password        TEXT    NOT NULL DEFAULT '',
  -- 'socks5' | 'socks4' | 'http'
  protocol        TEXT    NOT NULL DEFAULT 'socks5',
  label           TEXT    NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  last_checked_at INTEGER,
  last_ok         INTEGER,
  last_latency_ms INTEGER,
  last_error      TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_proxies_endpoint
  ON proxies(host, port, username, protocol);

CREATE TABLE IF NOT EXISTS bot_state (
  account_id  INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- 'offline' | 'connecting' | 'online' | 'error' | 'stopping'
  status      TEXT    NOT NULL DEFAULT 'offline',
  server      TEXT,
  started_at  INTEGER,
  last_error  TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  level   TEXT    NOT NULL,
  scope   TEXT    NOT NULL DEFAULT 'app',
  message TEXT    NOT NULL,
  meta    TEXT,
  account_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_logs_ts    ON logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

CREATE TABLE IF NOT EXISTS command_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  text       TEXT    NOT NULL,
  ts         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_account ON command_history(account_id, ts DESC);
`;
