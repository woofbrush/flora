/**
 * Bot manager.
 *
 * Owns every mineflayer connection: creating it, keeping it alive, reporting
 * its state, and tearing it down cleanly. One place, because the failure modes
 * here are all cross-cutting - a bot that reconnects forever, a bot that is
 * stopped while still connecting, a shutdown that leaves forty sockets open.
 *
 * Broadcasting a single account across several servers is supported: a bot is
 * keyed by `${accountId}:${server}`, and `stateFor(accountId)` reports the
 * first live one so account rows can show a status without knowing about the
 * fan-out.
 *
 * Auth, per account kind:
 *   msa      auth:'microsoft' with the prismarine-auth cache id as the
 *            username, which is what gets chat-signing certificates too.
 *   token    a custom auth function that hands mineflayer the stored access
 *            token directly, and fetches the account's chat signing keys on the
 *            way past - see bots/chatKeys.js.
 *   offline  auth:'offline'. Offline accounts have no Mojang key pair, so their
 *            chat is never signed. Nothing to fix; that is what offline means.
 */
import mineflayer from 'mineflayer';
import { pathfinder, Movements } from 'mineflayer-pathfinder';
import { plugin as pvpPlugin } from 'mineflayer-pvp';

import { connectThrough } from './connect.js';
import * as chatKeys from './chatKeys.js';
import * as commands from './commands.js';
import * as addons from '../addons/registry.js';
import { run, get } from '../db/index.js';
import { bus, EVENTS } from '../events.js';
import { logger } from '../logging/logger.js';
import { getSetting } from '../settings.js';
import { authCacheDir, authCacheFor } from '../paths.js';
import * as repo from '../accounts/repo.js';
import { credentialFor } from '../accounts/service.js';
import * as proxies from '../proxies/service.js';

/** Live bots, keyed by `${accountId}:${server}`. */
const bots = new Map();
/** Per-account console history, capped. Keyed by account id. */
const logs = new Map();
/** Pending reconnect timers, so shutdown can cancel them. */
const reconnectTimers = new Map();

const LOG_LIMIT = 500;

/** Servers currently in use, so a stop-all can be exhaustive. */
const runtime = new Map();

// ---------------------------------------------------------------- helpers

export const key = (accountId, server) => `${Number(accountId)}:${normaliseServer(server)}`;

/** Accept "host", "host:port" and "scheme://host:port". */
export function normaliseServer(server) {
  const raw = String(server ?? '').trim();
  if (!raw) return '';
  const withoutScheme = raw.replace(/^[a-z]+:\/\//i, '');
  return withoutScheme.replace(/\/.*$/, '').toLowerCase();
}

export function splitServer(server) {
  const clean = normaliseServer(server);
  const idx = clean.lastIndexOf(':');
  if (idx === -1) return { host: clean, port: 25565 };
  const port = Number(clean.slice(idx + 1));
  return {
    host: clean.slice(0, idx),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 25565
  };
}

function pushLog(accountId, line) {
  const id = Number(accountId);
  let list = logs.get(id);
  if (!list) { list = []; logs.set(id, list); }

  list.push(line);
  if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);

  bus.emit(EVENTS.BOT_LOG, { accountId: id, ...line });
}

function log(accountId, kind, text, meta = null) {
  pushLog(accountId, { ts: Date.now(), kind, text, meta });
}

/** Persisted status, so a crash does not leave rows claiming "online". */
function persistState(accountId, status, server, lastError = null) {
  try {
    run(
      `INSERT INTO bot_state (account_id, status, server, started_at, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         status = excluded.status,
         server = excluded.server,
         started_at = COALESCE(excluded.started_at, bot_state.started_at),
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`,
      Number(accountId), status, server,
      status === 'connecting' ? Date.now() : null,
      lastError, Date.now()
    );
  } catch { /* non-fatal */ }
}

function emitState(accountId, status, extra = {}) {
  const payload = { accountId: Number(accountId), status, ...extra };
  bus.emit(EVENTS.BOT_STATE, payload);
  return payload;
}

// ---------------------------------------------------------------- auth

/**
 * Custom `auth` for token accounts.
 *
 * minecraft-protocol calls this instead of doing its own sign-in; it must set
 * the session fields and then trigger the connection itself. Mirrors what
 * microsoftAuth.authenticate does, minus the refresh flow that a bare access
 * token cannot perform.
 *
 * `options.connect` is not called here directly. It is called once the account's
 * chat signing keys have been resolved, because a session's keys have to be on
 * the client *before* the socket opens: minecraft-protocol writes the profile
 * public key into the login-start packet (1.19-1.19.2) and into
 * chat_session_update (1.19.3+) on the way in, and reads client.profileKeys at
 * both points.
 *
 * Exported, and with `resolveKeys` as a parameter, so the ordering above can be
 * tested without a Mojang account - the rule that matters is "keys first, then
 * connect", and that is exactly what is hard to see by reading. `buildOptions`
 * never passes it.
 */
export function tokenAuthFactory(credential, resolveKeys = chatKeys.resolveChatKeys) {
  return (client, options) => {
    const profile = credential.profile ?? { id: null, name: options.username };

    options.haveCredentials = true;
    options.accessToken = credential.token;

    const session = {
      accessToken: credential.token,
      selectedProfile: profile,
      availableProfile: [profile]
    };

    client.session = session;
    client.username = profile.name ?? options.username;
    if (profile.id) client.uuid = profile.id;

    client.emit('session', session);

    // Deliberately not awaited. createClient calls this function synchronously
    // and registers its own handlers straight afterwards; blocking here would
    // hold that up, and the fetch is a network round trip anyway.
    //
    // The order this relies on is real but quiet: createBot runs this, returns,
    // and flora's own `wire` attaches its handlers - all without an await in
    // between - so the continuation below cannot run before the bot is wired up
    // and listening.
    applyChatKeys(client, options, credential, resolveKeys);
  };
}

/**
 * Resolve the account's signing keys, put them on the client, then connect.
 *
 * Two guarantees this has to keep, both of them about what happens when things
 * go wrong rather than when they go right:
 *
 *   it never rejects   An ignored promise that rejects does not fail quietly,
 *                      it takes the backend worker down with it.
 *   it always connects A missing key pair is not a reason to refuse to connect:
 *                      plenty of servers run with
 *                      `enforce-secure-profile=false`, where unsigned chat is
 *                      perfectly fine, so refusing would break a working setup
 *                      to avoid a broken one.
 *
 * What is worth avoiding is the *silent* version of a missing key pair - the bot
 * joins, chat appears to send, and the server drops every message - so whatever
 * happened is said out loud in the bot's console, and again at login.
 */
async function applyChatKeys(client, options, credential, resolveKeys) {
  try {
    const { keys, reason } = await resolveKeys({
      accountId: credential.accountId,
      token: credential.token,
      proxy: credential.proxy
    });

    if (keys) client.profileKeys = keys;
    else if (reason) credential.onKeyIssue?.(reason);
  } catch (err) {
    // resolveChatKeys is written not to throw; this is what keeps that true if
    // it is ever edited into throwing.
    credential.onKeyIssue?.(err?.message ?? 'Could not fetch signing keys.');
  }

  try {
    options.connect(client);
  } catch (err) {
    // Connecting used to happen synchronously inside createBot, so a failure
    // here was thrown out of it and caught by the caller, which reported
    // "Could not start". It happens a tick later now and nobody is waiting for
    // it, so the error goes onto the client instead - which is what
    // microsoftAuth does with its own failures, and what mineflayer listens to.
    client.emit('error', err);
  }
}

/**
 * Build the mineflayer options for one account.
 *
 * Kept separate from `start` so the shape can be unit tested without opening a
 * socket.
 */
export async function buildOptions(account, { server, version, proxyId = null, viewDistance = null } = {}) {
  const { host, port } = splitServer(server);
  if (!host) throw new Error('A server address is required.');

  const base = {
    host,
    port,
    // 'auto' means "let the server ping decide", which is what false does.
    version: !version || version === 'auto' ? false : version,
    // The full vanilla movement simulation, on by default and off only if the
    // user has asked for that. Nothing in flora cancels a packet or rewrites a
    // position: a bot here falls, takes knockback, is pushed by water and
    // pistons, and moves when the server moves it, exactly as a vanilla client
    // would. The setting exists so that is a stated property of the app rather
    // than something a reader has to take on trust.
    physicsEnabled: getSetting('bots.vanillaPhysics') !== false,
    checkTimeoutInterval: 30000,
    // Keep a broken bot from spamming the console with identical stack traces.
    hideErrors: true
  };

  if (account.kind === 'offline') {
    return { ...base, username: account.username, auth: 'offline' };
  }

  if (account.kind === 'msa' && account.cacheId) {
    authCacheFor(account.cacheId);
    return {
      ...base,
      username: account.cacheId,
      auth: 'microsoft',
      profilesFolder: authCacheDir(),
      // The cache already exists; if it cannot authenticate, fall over to a
      // custom function rather than printing a device code to a headless log.
      onMsaCode: () => { throw new Error('Microsoft needs this account to be signed in again.'); }
    };
  }

  const credential = await credentialFor(account.id);
  const profile = credential.profile ?? { id: account.uuid, name: account.username };

  // A token whose profile was never resolved still needs a name for the
  // handshake; fetch it now rather than connecting as an empty string.
  if (!profile.name) {
    const refreshed = await repo.getById(account.id);
    profile.name = refreshed?.username || '';
  }
  if (!profile.name) throw new Error('This account has no username yet. Check it once before starting a bot.');

  return {
    ...base,
    username: profile.name,
    auth: tokenAuthFactory({
      accountId: account.id,
      token: credential.token,
      profile,
      // The same proxy the token came from, so a hundred accounts collecting
      // keys do not all ask Mojang from one address.
      proxy: credential.proxy ?? null,
      onKeyIssue: (reason) => log(account.id, 'warn', `Chat signing will be off: ${reason}`)
    })
  };
}

/**
 * Attach the transport, proxied or not.
 *
 * minecraft-protocol has no proxy option, so the whole `connect` step is
 * replaced - see bots/connect.js. Doing it unconditionally keeps the direct and
 * proxied paths from drifting apart.
 */
function withProxy(options, proxy) {
  return { ...options, connect: connectThrough(proxy, options) };
}

// ---------------------------------------------------------------- lifecycle

export function stateFor(accountId) {
  const id = Number(accountId);
  let best = null;
  for (const bot of bots.values()) {
    if (bot.accountId !== id) continue;
    if (!best || rank(bot.status) > rank(best.status)) best = bot;
  }
  if (best) {
    return {
      status: best.status,
      server: best.server,
      startedAt: best.startedAt,
      error: best.error,
      count: [...bots.values()].filter((b) => b.accountId === id).length
    };
  }

  const row = get('SELECT * FROM bot_state WHERE account_id = ?', id);
  if (row && row.status !== 'offline') {
    return { status: 'offline', server: row.server, startedAt: null, error: row.last_error, count: 0 };
  }
  return { status: 'offline', server: null, startedAt: null, error: null, count: 0 };
}

const RANK = { offline: 0, error: 1, stopping: 2, connecting: 3, online: 4 };
const rank = (status) => RANK[status] ?? 0;

export function listRunning() {
  return [...bots.values()].map((bot) => ({
    accountId: bot.accountId,
    username: bot.username,
    server: bot.server,
    status: bot.status,
    startedAt: bot.startedAt,
    error: bot.error
  }));
}

export function runningCount() {
  return bots.size;
}

/**
 * The commands a bot answers to, for the reference in flora's UI.
 *
 * Read from the dispatcher rather than written out again, so the reference
 * cannot list a command that no longer exists or miss one that was added.
 */
export function commandReference() {
  const prefix = getSetting('bots.chatPrefix') || '.';
  return { prefix, commands: commands.commandHelp(prefix) };
}

/**
 * The Minecraft versions flora can connect as.
 *
 * mineflayer's own tested list, not a hand-written one: it is what the bundled
 * client actually speaks, and it moves when the dependency does. `auto` is
 * prepended because it is the sensible default - mineflayer reads the version
 * off the server's ping, and guessing wrong is the usual reason a bot will not
 * get in.
 */
export function supportedVersions() {
  return [
    { value: 'auto', label: 'Automatic (from the server)' },
    ...mineflayer.testedVersions.map((version) => ({ value: version, label: version }))
  ];
}

export function consoleFor(accountId) {
  return logs.get(Number(accountId)) ?? [];
}

export function clearConsole(accountId) {
  logs.delete(Number(accountId));
}

/**
 * Start a bot.
 *
 * `server` defaults to the configured default. The account must be usable:
 * an offline account needs a username, and any other kind needs a credential,
 * both checked before a socket is opened.
 */
export async function start(accountId, { server = null, version = null, proxyId = null } = {}) {
  const id = Number(accountId);
  const account = repo.getById(id);
  if (!account) throw new Error('Account not found.');

  const target = normaliseServer(server || getSetting('bots.defaultServer'));
  if (!target) throw new Error('No server given, and no default server is set.');

  const botKey = key(id, target);
  const existing = bots.get(botKey);
  if (existing && existing.status !== 'offline' && existing.status !== 'error') {
    throw new Error(`That account is already connected to ${target}.`);
  }

  const max = getSetting('bots.maxConcurrent');
  const live = [...bots.values()].filter((b) => b.status === 'online' || b.status === 'connecting').length;
  if (live >= max) {
    throw new Error(`The limit of ${max} online bots has been reached. Raise it in Settings > Bots.`);
  }

  if (account.kind === 'offline' && !account.username) {
    throw new Error('This offline account has no username.');
  }
  if (account.kind !== 'offline' && !account.hasToken && !account.canRefresh) {
    throw new Error('This account has no usable credential. Add it again.');
  }

  const version_ = version ?? getSetting('bots.defaultVersion');
  const proxy = proxyId != null
    ? proxies.getById(proxyId)
    : proxies.assignFor(id);

  const options = await buildOptions(account, { server: target, version: version_, proxyId });
  const record = {
    accountId: id,
    // Kept so the login handler can tell "this bot has no signing keys and that
    // is a problem" from "this bot is offline, so of course it has none".
    authKind: account.kind,
    username: account.username || '(unknown)',
    server: target,
    status: 'connecting',
    startedAt: Date.now(),
    error: null,
    attempts: 0,
    bot: null,
    proxy: proxy ?? null,
    stopped: false
  };

  bots.set(botKey, record);
  persistState(id, 'connecting', target);
  emitState(id, 'connecting', { server: target });
  log(id, 'system', `Connecting to ${target}${proxy ? ` via ${proxy.host}:${proxy.port}` : ''}…`);

  connect(record, options, { version: version_, proxy });
  return { key: botKey, accountId: id, server: target };
}

function connect(record, options, { version, proxy }) {
  let bot;
  try {
    bot = mineflayer.createBot(withProxy(options, proxy));
  } catch (err) {
    record.status = 'error';
    record.error = err.message;
    persistState(record.accountId, 'error', record.server, err.message);
    emitState(record.accountId, 'error', { server: record.server, error: err.message });
    log(record.accountId, 'error', `Could not start: ${err.message}`);
    return;
  }

  record.bot = bot;
  loadPlugins(bot);
  wire(bot, record, options, { version, proxy });
}

/** Plugins are loaded explicitly so the set is visible rather than magic. */
function loadPlugins(bot) {
  try { bot.loadPlugin(pathfinder); } catch { /* already loaded */ }
  try { bot.loadPlugin(pvpPlugin); } catch { /* already loaded */ }
}

function wire(bot, record, options, context) {
  const id = record.accountId;

  /**
   * The shape every addon-facing bot event carries.
   *
   * `bot` is the live mineflayer instance, handed over whole. The useful addon
   * is the one that does something to the bot - walks it, looks it at
   * something, swings its arm - and wrapping mineflayer behind a facade would
   * mean re-exposing it one method at a time forever.
   */
  const forAddons = (extra = {}) => ({
    accountId: id,
    username: record.username,
    server: record.server,
    bot: record.bot,
    ...extra
  });

  bot.once('login', () => {
    record.status = 'online';
    record.error = null;
    record.username = bot.username;
    record.attempts = 0;

    persistState(id, 'online', record.server);
    emitState(id, 'online', { server: record.server, username: bot.username });
    log(id, 'success', `Connected as ${bot.username} to ${record.server}.`);

    reportSigning(bot, record);

    if (getSetting('bots.antiAfk')) startAntiAfk(record);

    addons.emit('bot:login', forAddons({ username: bot.username }));
  });

  bot.on('spawn', () => {
    log(id, 'system', 'Spawned.');
    // Movements are per-bot and depend on the version's physics, so they cannot
    // be shared between instances.
    try { bot.pathfinder.setMovements(new Movements(bot)); } catch { /* plugin absent */ }

    addons.emit('bot:spawn', forAddons());
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;

    if (getSetting('bots.logChat')) {
      log(id, 'chat', `<${username}> ${message}`, { username });
      bus.emit(EVENTS.BOT_CHAT, { accountId: id, username, message });
    }

    // Commands are handled whatever `bots.logChat` says, and their outcome is
    // logged by the dispatcher itself. Someone who has turned chat logging off
    // has asked not to see the server's conversation, not to stop being able to
    // drive their own bots - and a refused command is exactly the line they
    // would want to see.
    commands.handle(bot, record, {
      username,
      message,
      log: (level, text) => log(id, level, text, { username })
    });

    addons.emit('bot:chat', forAddons({ username, message }));
  });

  bot.on('messagestr', (message) => {
    if (message && message.trim()) addons.emit('bot:message', forAddons({ message: message.trim() }));
    if (!getSetting('bots.logChat')) return;
    // System/action-bar text, distinct from player chat.
    if (message && message.trim()) log(id, 'system', message.trim());
  });

  bot.on('kicked', (reason) => {
    const text = formatKick(reason);
    record.error = text;
    log(id, 'warn', `Kicked: ${text}`);
    bus.emit(EVENTS.BOT_KICKED, { accountId: id, reason: text });
    bus.emit(EVENTS.NOTIFY, {
      level: 'warn',
      title: `${record.username} was kicked`,
      body: text
    });
    addons.emit('bot:kicked', forAddons({ reason: text }));
  });

  bot.on('error', (err) => {
    const message = err?.message ?? String(err);
    record.error = message;
    log(id, 'error', message);
    bus.emit(EVENTS.BOT_ERROR, { accountId: id, error: message });
    if (getSetting('notify.botError')) {
      bus.emit(EVENTS.NOTIFY, { level: 'error', title: `${record.username} errored`, body: message });
    }
    addons.emit('bot:error', forAddons({ error: message }));
  });

  bot.on('end', (reason) => {
    stopAntiAfk(record);

    // Emitted before the reconnect logic below decides what happens next, and
    // before `record.bot` is cleared, so an addon tearing down per-bot state
    // still has the bot it was tracking.
    addons.emit('bot:end', forAddons({ reason: reason ?? null }));

    record.bot = null;

    if (record.stopped) {
      log(id, 'system', 'Disconnected.');
      finalise(record);
      return;
    }

    const canRetry = getSetting('bots.autoReconnect') &&
      (getSetting('bots.maxReconnectAttempts') === 0 || record.attempts < getSetting('bots.maxReconnectAttempts'));

    if (!canRetry) {
      record.status = 'error';
      persistState(id, 'error', record.server, record.error ?? `Disconnected (${reason ?? 'unknown'})`);
      emitState(id, 'error', { server: record.server, error: record.error });
      log(id, 'error', `Disconnected (${reason ?? 'unknown'}) and not retrying.`);
      if (getSetting('notify.botDisconnect')) {
        bus.emit(EVENTS.NOTIFY, { level: 'warn', title: `${record.username} disconnected`, body: String(reason ?? '') });
      }
      return;
    }

    record.attempts += 1;
    record.status = 'connecting';

    // Back off as attempts pile up, capped so a long outage does not turn into
    // a multi-minute wait once the server comes back.
    const base = getSetting('bots.reconnectDelayMs');
    const delay = Math.min(base * Math.min(record.attempts, 6), 120000);

    emitState(id, 'connecting', { server: record.server, attempt: record.attempts });
    log(id, 'system', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${record.attempts})…`);

    const timer = setTimeout(async () => {
      reconnectTimers.delete(key(id, record.server));
      if (record.stopped) return;
      try {
        const account = repo.getById(id);
        const fresh = await buildOptions(account, {
          server: record.server,
          version: context.version,
          proxyId: record.proxy?.id ?? null
        });
        connect(record, fresh, context);
      } catch (err) {
        record.status = 'error';
        record.error = err.message;
        persistState(id, 'error', record.server, err.message);
        emitState(id, 'error', { server: record.server, error: err.message });
        log(id, 'error', `Could not reconnect: ${err.message}`);
      }
    }, delay);

    reconnectTimers.set(key(id, record.server), timer);
  });
}

/**
 * Say something when a connected bot cannot sign chat.
 *
 * This is the backstop for the one failure that has no error attached to it
 * anywhere: prismarine-auth fetches an msa account's certificates with
 * `.catch(e => debug(...))`, so a failed fetch leaves the sign-in looking
 * perfectly successful and the client with no key pair. From then on the bot
 * joins, sends chat, and the server quietly drops it.
 *
 * Offline accounts are exempt - there is no Mojang key pair for a name nobody
 * owns, so having none is correct rather than a problem.
 */
function reportSigning(bot, record) {
  if (record.authKind === 'offline') return;

  const client = bot._client;
  if (client?.profileKeys) return;

  const enforced = client?.serverFeatures?.enforcesSecureChat === true;
  log(record.accountId, 'warn', enforced
    ? 'No chat signing keys, and this server enforces secure chat - anything this bot says will be refused.'
    : 'No chat signing keys, so this bot\'s chat is unsigned. Servers that enforce secure chat will ignore it.'
  );
}

function formatKick(reason) {
  if (reason == null) return 'no reason given';
  if (typeof reason === 'string') return reason;
  if (typeof reason === 'object') {
    if (typeof reason.text === 'string') return reason.text;
    try { return JSON.stringify(reason); } catch { return 'unreadable reason'; }
  }
  return String(reason);
}

// ---------------------------------------------------------------- anti-afk

function startAntiAfk(record) {
  stopAntiAfk(record);
  const interval = getSetting('bots.antiAfkIntervalMs');

  record.afkTimer = setInterval(() => {
    const bot = record.bot;
    if (!bot || record.status !== 'online') return;
    try {
      // Rotate the view and hop. Enough to defeat an idle timer, small enough
      // not to look like movement to anything watching for it.
      bot.look(bot.entity.yaw + (Math.random() - 0.5), bot.entity.pitch, true);
      if (bot.entity.onGround) bot.setControlState('jump', true);
      setTimeout(() => { try { bot.setControlState('jump', false); } catch { /* gone */ } }, 120);
    } catch { /* bot vanished mid-tick */ }
  }, interval);

  record.afkTimer.unref?.();
}

function stopAntiAfk(record) {
  if (record.afkTimer) {
    clearInterval(record.afkTimer);
    record.afkTimer = null;
  }
}

// ---------------------------------------------------------------- control

/**
 * Single exit point for a bot that has finished disconnecting.
 *
 * Everything that removes a bot from the live map goes through here, so the
 * "stopping" state cannot be left behind by a socket that reports closing in an
 * order nobody expected.
 */
function finalise(record) {
  if (record.finalised) return;
  record.finalised = true;

  const botKey = key(record.accountId, record.server);
  if (bots.get(botKey) === record) bots.delete(botKey);

  clearTimeout(record.bail);
  record.bail = null;

  record.status = 'offline';
  persistState(record.accountId, 'offline', record.server);
  emitState(record.accountId, 'offline', { server: record.server });

  const settle = record.settle;
  record.settle = null;
  settle?.();
}

/** Stop one bot (all servers for that account when `server` is omitted). */
export async function stop(accountId, { reason = 'requested', server = null } = {}) {
  const id = Number(accountId);
  const targets = [...bots.entries()].filter(([k, b]) =>
    b.accountId === id && (server == null || k === key(id, server))
  );

  if (!targets.length) return 0;

  await Promise.all(targets.map(([botKey, record]) => new Promise((resolve) => {
    record.stopped = true;
    record.status = 'stopping';
    record.settle = resolve;
    stopAntiAfk(record);

    const timer = reconnectTimers.get(botKey);
    if (timer) { clearTimeout(timer); reconnectTimers.delete(botKey); }

    // Safety net. A half-open socket that never emits 'end' would otherwise
    // strand the account in "stopping" with no way back.
    record.bail = setTimeout(() => {
      try { record.bot?.end?.(); } catch { /* already gone */ }
      finalise(record);
    }, 5000);
    record.bail.unref?.();

    if (!record.bot) return finalise(record);      // never finished connecting
    try { record.bot.quit(reason); } catch { finalise(record); }
  })));

  return targets.length;
}

export async function stopAll({ reason = 'shutdown' } = {}) {
  const ids = [...new Set([...bots.values()].map((b) => b.accountId))];
  for (const timer of reconnectTimers.values()) clearTimeout(timer);
  reconnectTimers.clear();

  await Promise.all(ids.map((id) => stop(id, { reason }).catch(() => {})));
  return ids.length;
}

/** Send chat as a bot. */
export function chat(accountId, message, { server = null } = {}) {
  const record = pick(accountId, server);
  if (!record?.bot) throw new Error('That bot is not connected.');
  record.bot.chat(String(message));
  log(accountId, 'input', String(message));
  return true;
}

/** Send a raw command (without the leading slash). */
export function command(accountId, commandText, { server = null } = {}) {
  const record = pick(accountId, server);
  if (!record?.bot) throw new Error('That bot is not connected.');
  const text = String(commandText).replace(/^\//, '');
  record.bot.chat(`/${text}`);
  log(accountId, 'input', `/${text}`);
  return true;
}

/** Send a tab-completed whisper. */
export function whisper(accountId, target, message, { server = null } = {}) {
  const record = pick(accountId, server);
  if (!record?.bot) throw new Error('That bot is not connected.');
  record.bot.whisper(String(target), String(message));
  log(accountId, 'input', `/msg ${target} ${message}`);
  return true;
}

function pick(accountId, server) {
  const id = Number(accountId);
  if (server) return bots.get(key(id, server));
  return [...bots.values()].find((b) => b.accountId === id && b.status === 'online') ??
    [...bots.values()].find((b) => b.accountId === id);
}

/** Snapshot used by the bot detail view. */
export function describe(accountId, server = null) {
  const record = pick(accountId, server);
  if (!record) {
    return { status: 'offline', server: null, players: [], health: null, position: null };
  }

  const bot = record.bot;
  let players = [];
  let health = null;
  let position = null;
  let game = null;

  try {
    players = Object.values(bot?.players ?? {})
      .filter((p) => p.username !== bot.username)
      .map((p) => ({ username: p.username, uuid: p.uuid, ping: p.ping }));
  } catch { /* not spawned yet */ }

  try {
    health = bot?.health ?? null;
    position = bot?.entity?.position
      ? { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) }
      : null;
    game = bot?.game ? { dimension: bot.game.dimension, difficulty: bot.game.difficulty } : null;
  } catch { /* not spawned yet */ }

  return {
    status: record.status,
    server: record.server,
    username: record.username,
    startedAt: record.startedAt,
    error: record.error,
    players,
    health,
    position,
    game,
    proxy: record.proxy ? `${record.proxy.host}:${record.proxy.port}` : null
  };
}

/** Which accounts are running, for the accounts list. */
export function stateMap() {
  const map = {};
  for (const id of new Set([...bots.values()].map((b) => b.accountId))) {
    map[id] = stateFor(id);
  }
  return map;
}

/** Called once at boot: no bot survives a restart, so no row may claim one did. */
export function resetStaleState() {
  const reset = run(
    "UPDATE bot_state SET status = 'offline', updated_at = ? WHERE status <> 'offline'",
    Date.now()
  ).changes;
  if (reset) logger.info('bots', `Reset ${reset} stale bot state row(s).`);
  return reset;
}

export async function shutdown() {
  const count = bots.size;
  await stopAll({ reason: 'flora is closing' });
  logger.info('bots', `Stopped ${count} bot${count === 1 ? '' : 's'} on shutdown.`);
}

/**
 * Hand the addon registry a way back into the bots.
 *
 * The registry is what addons see, and it must not import this module - that
 * would be a cycle, since this module reaches the registry through
 * `commands.js`. So the dependency is inverted here, once, at load: the
 * registry holds a provider and calls through it.
 *
 * Every method is defensive. An addon holding an account id for a bot that has
 * since disconnected is the normal case rather than an error, so `get` returns
 * null and the send helpers throw the same sentence the UI would show, which
 * the registry's own guard turns into a log line against the addon's name.
 */
addons.setBotProvider({
  list: () => listRunning(),
  get: (accountId) => pick(accountId, null) ?? null,
  chat,
  whisper: (accountId, target, text) => whisper(accountId, target, text),
  command: (accountId, text) => command(accountId, text),
  log: (accountId, level, text) => { log(accountId, level, text); return true; }
});

export { bots, logs };
