/**
 * Proxies.
 *
 * A pool of SOCKS/HTTP endpoints that bots can be routed through, plus the
 * assignment rules that decide which account uses which. Off by default: with
 * `proxies.enabled` false, every bot connects directly and nothing here is
 * consulted.
 *
 * Credentials are stored in the clear. That is a deliberate difference from
 * account tokens: a proxy login is not a Microsoft credential, it is usually
 * shared across a whole pool, and encrypting it would mean a user could not
 * read back a list they pasted in themselves. The file is still inside the
 * per-user data directory.
 */
import { SocksClient } from 'socks';
import net from 'node:net';
import { all, get, run, count, transaction } from '../db/index.js';
import { bus, EVENTS } from '../events.js';
import { logger } from '../logging/logger.js';
import { getSetting } from '../settings.js';
import { mapLimit } from '../util/concurrency.js';

export const PROTOCOLS = ['socks5', 'socks4', 'http'];
export const MODES = ['preferred', 'rotate', 'random'];
const now = () => Date.now();

function toPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    host: row.host,
    port: row.port,
    username: row.username,
    // The password is returned only as "is one set" - the UI has no reason to
    // display it, and omitting it means it cannot leak into a screenshot.
    hasPassword: Boolean(row.password),
    protocol: row.protocol,
    label: row.label,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    lastCheckedAt: row.last_checked_at,
    lastOk: row.last_ok == null ? null : Boolean(row.last_ok),
    lastLatencyMs: row.last_latency_ms,
    lastError: row.last_error
  };
}

export function list({ enabledOnly = false } = {}) {
  const rows = enabledOnly
    ? all('SELECT * FROM proxies WHERE enabled = 1 ORDER BY id')
    : all('SELECT * FROM proxies ORDER BY id');
  return rows.map(toPublic);
}

export function getById(id) {
  return toPublic(get('SELECT * FROM proxies WHERE id = ?', Number(id)));
}

/** Full row including the password. Only the connector calls this. */
export function getRaw(id) {
  return get('SELECT * FROM proxies WHERE id = ?', Number(id));
}

export function add({ host, port, username = '', password = '', protocol = 'socks5', label = '', enabled = true }) {
  const cleanHost = String(host ?? '').trim();
  const cleanPort = Number(port);

  if (!cleanHost) throw new Error('A host is required.');
  if (!Number.isInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535) {
    throw new Error('Port must be between 1 and 65535.');
  }
  if (!PROTOCOLS.includes(protocol)) throw new Error(`Protocol must be one of: ${PROTOCOLS.join(', ')}`);

  const existing = get(
    'SELECT id FROM proxies WHERE host = ? AND port = ? AND username = ? AND protocol = ?',
    cleanHost, cleanPort, username, protocol
  );
  if (existing) {
    update(existing.id, { password, label, enabled });
    return { proxy: getById(existing.id), duplicate: true };
  }

  const res = run(
    `INSERT INTO proxies (host, port, username, password, protocol, label, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    cleanHost, cleanPort, username, password, protocol, label, enabled ? 1 : 0, now()
  );

  bus.emit(EVENTS.PROXIES_CHANGED, { what: 'add', id: res.lastInsertRowid });
  return { proxy: getById(res.lastInsertRowid), duplicate: false };
}

export function update(id, patch = {}) {
  const sets = [];
  const params = [];
  const field = (col, value) => { sets.push(`${col} = ?`); params.push(value); };

  if ('host' in patch) field('host', String(patch.host).trim());
  if ('port' in patch) {
    const p = Number(patch.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Port must be between 1 and 65535.');
    field('port', p);
  }
  if ('username' in patch) field('username', String(patch.username ?? ''));
  if ('password' in patch) field('password', String(patch.password ?? ''));
  if ('protocol' in patch) {
    if (!PROTOCOLS.includes(patch.protocol)) throw new Error(`Protocol must be one of: ${PROTOCOLS.join(', ')}`);
    field('protocol', patch.protocol);
  }
  if ('label' in patch) field('label', String(patch.label ?? ''));
  if ('enabled' in patch) field('enabled', patch.enabled ? 1 : 0);

  if (!sets.length) return getById(id);
  params.push(Number(id));
  run(`UPDATE proxies SET ${sets.join(', ')} WHERE id = ?`, ...params);
  bus.emit(EVENTS.PROXIES_CHANGED, { what: 'update', id: Number(id) });
  return getById(id);
}

export function removeMany(ids) {
  const list = [...new Set(ids.map(Number).filter(Number.isFinite))];
  if (!list.length) return 0;
  const placeholders = list.map(() => '?').join(',');
  const removed = run(`DELETE FROM proxies WHERE id IN (${placeholders})`, ...list).changes;
  bus.emit(EVENTS.PROXIES_CHANGED, { what: 'delete', ids: list });
  return removed;
}

export function counts() {
  return {
    total: count('SELECT COUNT(*) FROM proxies'),
    enabled: count('SELECT COUNT(*) FROM proxies WHERE enabled = 1'),
    ok: count('SELECT COUNT(*) FROM proxies WHERE last_ok = 1'),
    failed: count('SELECT COUNT(*) FROM proxies WHERE last_ok = 0'),
    unchecked: count('SELECT COUNT(*) FROM proxies WHERE last_checked_at IS NULL')
  };
}

// ---------------------------------------------------------------- parsing

/**
 * Parse a pasted proxy list.
 *
 * Accepts, one per line:
 *   host:port
 *   host:port:user:pass
 *   user:pass@host:port
 *   scheme://user:pass@host:port
 *   host port user pass        (whitespace separated)
 *
 * '#', '//' and blank lines are ignored, so a list copied out of a provider's
 * page with headings still works.
 */
export function parseList(text, { protocol = 'socks5' } = {}) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  const lines = String(text ?? '').split(/\r?\n/);

  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('//')) return;

    let scheme = null;
    let body = line;
    const schemeMatch = /^(socks5h?|socks4a?|https?):\/\//i.exec(line);
    if (schemeMatch) {
      const s = schemeMatch[1].toLowerCase();
      scheme = s.startsWith('socks5') ? 'socks5' : s.startsWith('socks4') ? 'socks4' : 'http';
      body = line.slice(schemeMatch[0].length);
    }

    let host;
    let port;
    let username = '';
    let password = '';

    if (body.includes('@')) {
      const at = body.lastIndexOf('@');
      const creds = body.slice(0, at);
      const endpoint = body.slice(at + 1);
      const colon = creds.indexOf(':');
      username = colon === -1 ? creds : creds.slice(0, colon);
      password = colon === -1 ? '' : creds.slice(colon + 1);
      [host, port] = splitEndpoint(endpoint);
    } else if (/\s/.test(body) && !body.includes(':')) {
      const parts = body.split(/\s+/);
      [host, port, username = '', password = ''] = parts;
    } else {
      const parts = body.split(':');
      if (parts.length === 2) [host, port] = parts;
      else if (parts.length === 4) [host, port, username, password] = parts;
      else { host = null; port = null; }
    }

    const cleanPort = Number(port);
    const problem = !host ? 'missing host'
      : !Number.isInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535 ? 'invalid port'
      : null;

    if (problem) {
      invalid.push({ line: index + 1, text: line.slice(0, 60), reason: problem });
      return;
    }

    const key = `${host}:${cleanPort}:${username}:${scheme ?? protocol}`;
    if (seen.has(key)) {
      invalid.push({ line: index + 1, text: line.slice(0, 60), reason: 'duplicate in this list' });
      return;
    }
    seen.add(key);

    valid.push({ host, port: cleanPort, username, password, protocol: scheme ?? protocol, line: index + 1 });
  });

  return {
    valid,
    invalid: invalid.slice(0, 200),
    counts: { total: valid.length + invalid.length, valid: valid.length, invalid: invalid.length }
  };
}

function splitEndpoint(value) {
  const idx = value.lastIndexOf(':');
  if (idx === -1) return [value, null];
  return [value.slice(0, idx), value.slice(idx + 1)];
}

export function addMany(entries, { label = '' } = {}) {
  let added = 0;
  transaction(() => {
    for (const entry of entries) {
      try {
        const result = add({ ...entry, label });
        if (!result.duplicate) added += 1;
      } catch { /* row-level failure should not abort the batch */ }
    }
  });
  logger.info('proxies', `Imported ${added} proxies.`);
  bus.emit(EVENTS.PROXIES_CHANGED, { what: 'import', added });
  return { added, counts: counts() };
}

// ---------------------------------------------------------------- checking

/**
 * Open a TCP connection through a proxy to a neutral destination.
 *
 * The destination is a Minecraft endpoint because that is what actually has to
 * work; checking against an arbitrary host would pass for a proxy that blocks
 * the game's ports.
 */
export async function check(id) {
  const proxy = getRaw(id);
  if (!proxy) throw new Error('Proxy not found.');

  const timeout = getSetting('proxies.testTimeoutMs');
  const destination = { host: 'api.minecraftservices.com', port: 443 };
  const started = Date.now();

  try {
    if (proxy.protocol === 'http') {
      await httpConnect(proxy, destination, timeout);
    } else {
      const client = await SocksClient.createConnection({
        proxy: {
          host: proxy.host,
          port: proxy.port,
          type: proxy.protocol === 'socks4' ? 4 : 5,
          userId: proxy.username || undefined,
          password: proxy.password || undefined
        },
        command: 'connect',
        destination,
        timeout
      });
      client.socket.destroy();
    }

    const latency = Date.now() - started;
    run(
      `UPDATE proxies SET last_checked_at = ?, last_ok = 1, last_latency_ms = ?, last_error = NULL WHERE id = ?`,
      Date.now(), latency, id
    );
    bus.emit(EVENTS.PROXY_CHECKED, { id, ok: true, latency });
    return { id, ok: true, latency };
  } catch (err) {
    const message = err?.message ?? 'Connection failed.';
    run(
      'UPDATE proxies SET last_checked_at = ?, last_ok = 0, last_latency_ms = NULL, last_error = ? WHERE id = ?',
      Date.now(), message, id
    );
    bus.emit(EVENTS.PROXY_CHECKED, { id, ok: false, error: message });
    return { id, ok: false, error: message };
  }
}

/** Minimal HTTP CONNECT tunnel, enough to prove an HTTP proxy works. */
function httpConnect(proxy, destination, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      if (err) { socket.destroy(); reject(err); }
      else { socket.destroy(); resolve(); }
    };

    const timer = setTimeout(() => finish(new Error(`Timed out after ${timeout}ms`)), timeout);

    socket.on('connect', () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT ${destination.host}:${destination.port} HTTP/1.1\r\n` +
        `Host: ${destination.host}:${destination.port}\r\n` +
        auth +
        'Connection: close\r\n\r\n'
      );
    });

    socket.on('data', (chunk) => {
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(chunk.toString('latin1'));
      if (!status) return;                       // wait for the full status line
      if (status[1] === '200') finish(null);
      else finish(new Error(`Proxy refused the tunnel (HTTP ${status[1]})`));
    });

    socket.on('error', (err) => finish(new Error(err.message)));
    socket.on('close', () => finish(new Error('Proxy closed the connection before responding.')));
  });
}

export async function checkMany(ids, { concurrency = 8 } = {}) {
  const list = [...new Set(ids.map(Number).filter(Number.isFinite))];
  if (!list.length) return { results: [], counts: counts() };

  bus.emit(EVENTS.BUSY, { scope: 'proxies', active: true, total: list.length });

  const results = await mapLimit(list, concurrency, (id) => check(id), {
    onProgress: (done, total) => bus.emit(EVENTS.PROXY_CHECK_PROGRESS, { done, total })
  });

  bus.emit(EVENTS.BUSY, { scope: 'proxies', active: false });
  return { results, counts: counts() };
}

// ---------------------------------------------------------------- assignment

/**
 * Pick a proxy for an account according to the configured mode.
 *
 * Returns null when proxying is off or no proxy is usable, which callers treat
 * as "connect directly".
 */
export function assignFor(accountId, { exclude = [] } = {}) {
  if (!getSetting('proxies.enabled')) return null;

  const pool = list({ enabledOnly: true }).filter((p) => !exclude.includes(p.id));
  if (!pool.length) return null;

  const mode = getSetting('proxies.mode');

  if (mode === 'random') {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  if (mode === 'rotate') {
    // Least-recently-used: spreads load evenly without needing a counter.
    const usage = all(
      'SELECT proxy_id, COUNT(*) AS n FROM accounts WHERE proxy_id IS NOT NULL GROUP BY proxy_id'
    );
    const byId = new Map(usage.map((r) => [r.proxy_id, Number(r.n)]));
    return [...pool].sort((a, b) => (byId.get(a.id) ?? 0) - (byId.get(b.id) ?? 0))[0];
  }

  // preferred: honour an existing assignment when it is still in the pool.
  const current = get('SELECT proxy_id FROM accounts WHERE id = ?', Number(accountId))?.proxy_id;
  const preferred = pool.find((p) => p.id === current);
  if (preferred) return preferred;

  const usage = all(
    'SELECT proxy_id, COUNT(*) AS n FROM accounts WHERE proxy_id IS NOT NULL GROUP BY proxy_id'
  );
  const byId = new Map(usage.map((r) => [r.proxy_id, Number(r.n)]));
  return [...pool].sort((a, b) => (byId.get(a.id) ?? 0) - (byId.get(b.id) ?? 0))[0];
}

/**
 * The proxy an account's API traffic should leave through, or null for direct.
 *
 * Separate from `assignFor` because the two are asked different questions. A
 * bot connection is long-lived and wants a stable endpoint, so it takes
 * whatever the account is already assigned. An API call is one-shot, and bulk
 * work - forty skins in a row - is exactly the shape these endpoints rate
 * limit, so the useful property there is that consecutive accounts leave from
 * different addresses. Both prefer the account's own assignment; the API path
 * just falls back to the pool when there is none.
 *
 * Gated by its own setting as well as the master switch. Proxying bots and
 * proxying account management are separately reasonable, and someone
 * debugging a bot that will not connect should not have to unproxy the whole
 * account list to do it.
 *
 * The row returned includes the password, because it is going to a socket
 * rather than to a screen. Everything that reaches the UI goes through
 * `toPublic` instead.
 */
export function apiProxyFor(accountId) {
  if (!getSetting('proxies.enabled')) return null;
  if (!getSetting('proxies.routeApi')) return null;

  const pool = list({ enabledOnly: true });
  if (!pool.length) return null;

  const assigned = get('SELECT proxy_id FROM accounts WHERE id = ?', Number(accountId))?.proxy_id;
  if (assigned) {
    const match = pool.find((p) => p.id === assigned);
    if (match) return getRaw(match.id);
  }

  const chosen = assignFor(accountId);
  return chosen ? getRaw(chosen.id) : null;
}

/**
 * How wide a bulk API run can safely go, given how it is being routed.
 *
 * The direct limits exist because everything arrives at Mojang from one
 * address: three uploads at a time is already pushing it, and more only reaches
 * the rate limiter sooner. Behind a pool that reasoning stops applying - the
 * whole point of forty proxies is that forty requests are forty addresses.
 *
 * Capped at the size of the pool, because past that two accounts share an
 * address and the extra width buys nothing but a faster refusal. Never below
 * the direct width, so turning proxies on can never make a run slower.
 */
export function apiConcurrency(direct = 3, proxied = 8) {
  if (!getSetting('proxies.enabled') || !getSetting('proxies.routeApi')) return direct;

  const pool = list({ enabledOnly: true }).length;
  if (!pool) return direct;

  return Math.max(direct, Math.min(proxied, pool));
}

/** Build the mineflayer `agent`/`socks` option for a proxy row. */
export function connectionOptions(proxy) {
  if (!proxy) return {};
  return {
    host: proxy.host,
    port: proxy.port,
    type: proxy.protocol === 'socks4' ? 4 : 5,
    userId: proxy.username || undefined,
    password: proxy.password || undefined,
    protocol: proxy.protocol
  };
}

/**
 * Give each selected account its own enabled proxy.
 *
 * Accounts outnumbering proxies wrap around, so a pool of ten covers a hundred
 * accounts rather than leaving ninety unassigned.
 */
export function assignUniqueProxies(ids, { reassign = false } = {}) {
  const pool = list({ enabledOnly: true });
  if (!pool.length) throw new Error('There are no enabled proxies to assign.');

  const targets = ids.map(Number).filter(Number.isFinite);
  if (!targets.length) throw new Error('No accounts selected.');

  let index = 0;
  let changed = 0;

  transaction(() => {
    for (const id of targets) {
      const account = get('SELECT proxy_id FROM accounts WHERE id = ?', id);
      if (!account) continue;
      if (account.proxy_id && !reassign) continue;

      const proxy = pool[index % pool.length];
      index += 1;
      run('UPDATE accounts SET proxy_id = ?, updated_at = ? WHERE id = ?', proxy.id, Date.now(), id);
      changed += 1;
    }
  });

  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'proxies-assigned', changed });
  return { changed, pool: pool.length };
}

export function clearAssignments(ids) {
  const targets = ids.map(Number).filter(Number.isFinite);
  if (!targets.length) return 0;
  const placeholders = targets.map(() => '?').join(',');
  const changed = run(
    `UPDATE accounts SET proxy_id = NULL, updated_at = ? WHERE id IN (${placeholders})`,
    Date.now(), ...targets
  ).changes;
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'proxies-cleared', changed });
  return changed;
}

/** How many accounts sit on each proxy, for the proxy list. */
export function usage() {
  const rows = all(
    'SELECT proxy_id, COUNT(*) AS n FROM accounts WHERE proxy_id IS NOT NULL GROUP BY proxy_id'
  );
  return new Map(rows.map((r) => [r.proxy_id, Number(r.n)]));
}

export { mapLimit };
