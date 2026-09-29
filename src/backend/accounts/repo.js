/**
 * Account storage.
 *
 * The database row and the object the rest of the app uses are different
 * shapes. Rows hold `token_sealed` (ciphertext) and integer booleans; the rest
 * of the app deals in `hasToken`, `selected: true` and never sees a token
 * unless it explicitly asks for one.
 *
 * `toPublic` is the boundary. Anything crossing to the renderer goes through
 * it, which is what makes "no token ever reaches the UI" a property of the
 * code rather than a rule people have to remember.
 */
import { all, get, run, count, transaction } from '../db/index.js';
import { seal, open, fingerprint, hint } from '../auth/crypto.js';

const now = () => Date.now();

/** Wrap a tag list as ',a,b,' so LIKE '%a,%' cannot match a substring tag. */
export function packTags(tags) {
  const list = (Array.isArray(tags) ? tags : String(tags ?? '').split(','))
    .map((t) => String(t).trim().toLowerCase())
    .filter(Boolean);
  return list.length ? `,${[...new Set(list)].join(',')},` : '';
}

export function unpackTags(packed) {
  return String(packed ?? '').split(',').filter(Boolean);
}

function toPublic(row, { bot = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    uuid: row.uuid,
    label: row.label,
    notes: row.notes,
    tags: unpackTags(row.tags),
    kind: row.kind,
    hasToken: Boolean(row.token_sealed),
    tokenHint: row.token_hint,
    hasPassword: Boolean(row.password_sealed),
    passwordHint: row.password_hint,
    canRefresh: Boolean(row.cache_id),
    selected: Boolean(row.selected),
    favorite: Boolean(row.favorite),
    proxyId: row.proxy_id,
    skinHash: row.skin_hash,
    skinModel: row.skin_model,
    lastTestedAt: row.last_tested_at,
    lastTestOk: row.last_test_ok == null ? null : Boolean(row.last_test_ok),
    lastTestError: row.last_test_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bot
  };
}

export { toPublic };

/**
 * List accounts with optional filtering, sorting and paging.
 *
 * Sorting is whitelisted rather than interpolated: the column name is chosen
 * from a fixed map, so nothing user-supplied reaches the SQL string.
 */
const SORTS = {
  added: 'a.created_at',
  name: "LOWER(NULLIF(a.username,''))",
  status: 'a.selected',
  tested: 'a.last_tested_at',
  updated: 'a.updated_at'
};

export function list({ search = '', selectedOnly = false, favoritesOnly = false,
                       tag = null, sortBy = 'added', sortDir = 'desc',
                       limit = null, offset = 0 } = {}) {
  const where = [];
  const params = [];

  if (search) {
    where.push('(a.username LIKE ? OR a.label LIKE ? OR a.notes LIKE ? OR a.tags LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (selectedOnly) where.push('a.selected = 1');
  if (favoritesOnly) where.push('a.favorite = 1');
  if (tag) {
    where.push('a.tags LIKE ?');
    params.push(`%,${String(tag).toLowerCase()},%`);
  }

  const column = SORTS[sortBy] ?? SORTS.added;
  const direction = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // Username can be empty for a token imported before its profile resolved;
  // those sort last rather than first.
  const nullsLast = column.includes('NULLIF') ? ' , a.created_at DESC' : '';

  const sql = `
    SELECT a.* FROM accounts a
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${column} ${direction}${nullsLast}
    ${limit ? 'LIMIT ? OFFSET ?' : ''}
  `;
  const rows = limit ? all(sql, ...params, limit, offset) : all(sql, ...params);
  return rows.map((r) => toPublic(r));
}

export function getById(id) {
  return toPublic(get('SELECT * FROM accounts WHERE id = ?', Number(id)));
}

/** Raw row including the sealed token. Only the auth paths call this. */
export function getRaw(id) {
  return get('SELECT * FROM accounts WHERE id = ?', Number(id));
}

export function findByFingerprint(fp) {
  return get('SELECT * FROM accounts WHERE token_fp = ?', fp);
}

export function findByUuid(uuid) {
  if (!uuid) return undefined;
  return get('SELECT * FROM accounts WHERE uuid = ?', String(uuid).replace(/-/g, ''));
}

export function findByUsername(username) {
  if (!username) return undefined;
  return get('SELECT * FROM accounts WHERE LOWER(username) = LOWER(?)', String(username));
}

/**
 * Insert an account.
 *
 * Both credentials are optional: a row can be created for a username whose
 * profile has not resolved yet. Whatever is supplied is sealed immediately and
 * only the hint is stored alongside.
 */
export function insert({ username = '', uuid = null, token = null, password = null,
                         kind = 'token', cacheId = null, label = '', notes = '',
                         tags = [], selected = false, proxyId = null }) {
  const ts = now();
  const sealed = token ? seal(token) : null;
  const fp = token ? fingerprint(token) : null;

  const res = run(
    `INSERT INTO accounts
       (username, uuid, token_sealed, token_hint, token_fp, password_sealed,
        password_hint, kind, cache_id, label, notes, tags, selected, proxy_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    username,
    uuid ? String(uuid).replace(/-/g, '') : null,
    sealed,
    token ? hint(token) : null,
    fp,
    password ? seal(password) : null,
    password ? hint(password) : null,
    kind, cacheId, label, notes,
    packTags(tags), selected ? 1 : 0, proxyId, ts, ts
  );

  return getById(res.lastInsertRowid);
}

/** Patch the mutable fields of an account. Returns the updated row. */
export function update(id, patch = {}) {
  const sets = [];
  const params = [];
  const field = (col, value) => { sets.push(`${col} = ?`); params.push(value); };

  if ('username' in patch) field('username', String(patch.username ?? ''));
  if ('uuid' in patch) field('uuid', patch.uuid ? String(patch.uuid).replace(/-/g, '') : null);
  if ('label' in patch) field('label', String(patch.label ?? ''));
  if ('notes' in patch) field('notes', String(patch.notes ?? ''));
  if ('tags' in patch) field('tags', packTags(patch.tags));
  if ('selected' in patch) field('selected', patch.selected ? 1 : 0);
  if ('favorite' in patch) field('favorite', patch.favorite ? 1 : 0);
  if ('proxyId' in patch) field('proxy_id', patch.proxyId == null ? null : Number(patch.proxyId));
  if ('skinHash' in patch) field('skin_hash', patch.skinHash ?? null);
  if ('skinModel' in patch) field('skin_model', patch.skinModel ?? null);
  if ('cacheId' in patch) field('cache_id', patch.cacheId ?? null);
  if ('kind' in patch) field('kind', String(patch.kind));

  if ('token' in patch) {
    const token = patch.token;
    field('token_sealed', token ? seal(token) : null);
    field('token_hint', token ? hint(token) : null);
    field('token_fp', token ? fingerprint(token) : null);
  }

  if ('password' in patch) {
    const password = patch.password;
    field('password_sealed', password ? seal(password) : null);
    field('password_hint', password ? hint(password) : null);
  }

  if (!sets.length) return getById(id);

  field('updated_at', now());
  params.push(Number(id));
  run(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getById(id);
}

/** Record the outcome of an authentication check. */
export function recordTest(id, { ok, error = null, username = null, uuid = null } = {}) {
  const sets = ['last_tested_at = ?', 'last_test_ok = ?', 'last_test_error = ?', 'updated_at = ?'];
  const params = [now(), ok ? 1 : 0, error, now()];

  if (username) { sets.push('username = ?'); params.push(username); }
  if (uuid) { sets.push('uuid = ?'); params.push(String(uuid).replace(/-/g, '')); }

  params.push(Number(id));
  run(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getById(id);
}

export function removeMany(ids) {
  const list = [...new Set(ids.map(Number).filter(Number.isFinite))];
  if (!list.length) return 0;
  const placeholders = list.map(() => '?').join(',');
  return run(`DELETE FROM accounts WHERE id IN (${placeholders})`, ...list).changes;
}

export function setSelection(ids, value) {
  const list = [...new Set(ids.map(Number).filter(Number.isFinite))];
  if (!list.length) return 0;
  const placeholders = list.map(() => '?').join(',');
  return run(
    `UPDATE accounts SET selected = ?, updated_at = ? WHERE id IN (${placeholders})`,
    value ? 1 : 0, now(), ...list
  ).changes;
}

export function selectAll() {
  return run('UPDATE accounts SET selected = 1, updated_at = ? WHERE selected = 0', now()).changes;
}

export function selectNone() {
  return run('UPDATE accounts SET selected = 0, updated_at = ? WHERE selected = 1', now()).changes;
}

export function selectInvert() {
  return run('UPDATE accounts SET selected = 1 - selected, updated_at = ?', now()).changes;
}

export function selectedIds() {
  return all('SELECT id FROM accounts WHERE selected = 1 ORDER BY id').map((r) => r.id);
}

export function allIds() {
  return all('SELECT id FROM accounts ORDER BY id').map((r) => r.id);
}

export function idsMatching({ search = '', selectedOnly = false, favoritesOnly = false, tag = null } = {}) {
  return list({ search, selectedOnly, favoritesOnly, tag }).map((a) => a.id);
}

export function counts() {
  return {
    total: count('SELECT COUNT(*) FROM accounts'),
    selected: count('SELECT COUNT(*) FROM accounts WHERE selected = 1'),
    favorites: count('SELECT COUNT(*) FROM accounts WHERE favorite = 1'),
    withToken: count('SELECT COUNT(*) FROM accounts WHERE token_sealed IS NOT NULL'),
    refreshable: count('SELECT COUNT(*) FROM accounts WHERE cache_id IS NOT NULL'),
    ok: count('SELECT COUNT(*) FROM accounts WHERE last_test_ok = 1'),
    failed: count('SELECT COUNT(*) FROM accounts WHERE last_test_ok = 0'),
    untested: count('SELECT COUNT(*) FROM accounts WHERE last_tested_at IS NULL')
  };
}

/** Every distinct tag in use, with a count, for the filter bar. */
export function tags() {
  const rows = all("SELECT tags FROM accounts WHERE tags <> ''");
  const tally = new Map();
  for (const row of rows) {
    for (const tag of unpackTags(row.tags)) tally.set(tag, (tally.get(tag) ?? 0) + 1);
  }
  return [...tally.entries()]
    .map(([name, n]) => ({ name, count: n }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Distinct token fingerprints currently stored, for duplicate detection. */
export function fingerprints() {
  return new Set(all('SELECT token_fp FROM accounts WHERE token_fp IS NOT NULL').map((r) => r.token_fp));
}

/**
 * Decrypt an account's token.
 *
 * The only place in the app that returns a usable credential, and it is
 * synchronous and explicit so every call site is visible in review.
 */
export function revealToken(id) {
  const row = getRaw(id);
  if (!row) throw new Error('Account not found.');
  if (!row.token_sealed) throw new Error('This account has no stored token.');
  return open(row.token_sealed);
}

/** Decrypt many tokens at once, keeping the account id attached. */
export function revealMany(ids) {
  return ids.map((id) => {
    try {
      return { id: Number(id), token: revealToken(id), error: null };
    } catch (err) {
      return { id: Number(id), token: null, error: err.message };
    }
  });
}

/** Decrypt the offline-mode password. Same contract as revealToken. */
export function revealPassword(id) {
  const row = getRaw(id);
  if (!row) throw new Error('Account not found.');
  if (!row.password_sealed) return null;
  return open(row.password_sealed);
}

/** True when this account signs in with a password rather than a token. */
export function isOffline(id) {
  const row = getRaw(id);
  return row?.kind === 'offline';
}

export { transaction };
