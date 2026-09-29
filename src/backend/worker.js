/**
 * Backend worker.
 *
 * Runs in an Electron `utilityProcess`, not in the main process. That is a
 * deliberate split: mineflayer holds a physics simulation, a chunk cache and a
 * socket per bot, and none of that belongs on the thread that owns the window.
 * A bot that stalls the event loop here makes the UI stutter there.
 *
 * The contract with the rest of the app is small:
 *
 *   in    { id, method, params }   a call, expecting exactly one reply
 *   out   { id, ok, result|error } that reply
 *   out   { event, payload }       an unsolicited push from the event bus
 *
 * Nothing here knows about windows, dialogs or the filesystem layout of the
 * renderer. Anything that needs a native dialog is done in the main process,
 * which then calls a method here with the result.
 */
import { setDataRoot, dataRoot, dbFile } from './paths.js';
import { db, all, count, closeDb, info, snapshot } from './db/index.js';
import { configureLogger, logger, prune as pruneLogs } from './logging/logger.js';
import { bus, EVENTS } from './events.js';
import { all_settings, updateSettings, resetSettings, describe as describeSettings, getSetting } from './settings.js';

import * as accounts from './accounts/service.js';
import * as repo from './accounts/repo.js';
import * as skins from './skins/service.js';
import * as proxies from './proxies/service.js';
import * as bots from './bots/manager.js';
import * as audio from './audio/library.js';
import * as addons from './addons/registry.js';
import * as presence from './discord/presence.js';
import { API_VERSION } from './addons/manifest.js';
import { ADDON_PROMPT } from './addons/prompt.js';

const port = process.parentPort;

/**
 * When this process started, which is what the Discord presence counts from.
 *
 * The worker's lifetime is the app's, so this is the app's uptime as far as
 * anyone reading a Discord profile is concerned.
 */
const startedAt = Date.now();

// ---------------------------------------------------------------- lifecycle

/**
 * Boot order matters: the data root has to be known before the database file is
 * opened, and the database has to exist before settings are read, because the
 * logger's configuration lives in settings.
 */
function boot({ dataRoot: root, logLevel = null } = {}) {
  setDataRoot(root);
  // `db()` creates the file and applies the schema in one step, so there is no
  // separate migration call to forget.
  db();

  const settings = all_settings();
  configureLogger({
    level: logLevel ?? settings['logging.level'],
    toFile: settings['logging.toFile'],
    maxRows: settings['logging.maxRows']
  });

  pruneLogs(settings['logging.retentionDays']);

  // No bot survives a restart, so no row may claim one did.
  bots.resetStaleState();

  // The account service asks the bot manager for live status rather than
  // importing it, which keeps the two modules from depending on each other.
  accounts.setBotStateProvider((id) => bots.stateFor(id));

  // Last, because an addon may register a command and the registry needs the
  // built-in command names to have been claimed before it can refuse a clash -
  // and because an addon that fails to load should do so after the app it is
  // extending is already standing up.
  addons.start();

  syncPresence();

  logger.info('app', `flora backend ready (${dataRoot()}).`);
}

// ---------------------------------------------------------------- presence

/**
 * What the Discord profile should say right now.
 *
 * Deliberately two counts and nothing else. A server address or an account name
 * would be more informative, and would also be the one thing here that leaves
 * this machine for somewhere the user cannot see, so neither is in it.
 *
 * `details` and `state` are Discord's own names for the two lines under the
 * application title. There is no `buttons` entry: a button would fit here, and
 * an activity Discord refuses is refused whole, so the presence is kept to the
 * fields that cannot be wrong for an application nobody has configured.
 */
function presenceActivity() {
  const running = bots.runningCount();
  const accounts = count('SELECT COUNT(*) FROM accounts');

  const details = running === 0
    ? 'No bots running'
    : `Running ${running} ${running === 1 ? 'bot' : 'bots'}`;

  const state = accounts === 0
    ? 'No accounts yet'
    : `${accounts} ${accounts === 1 ? 'account' : 'accounts'} in the panel`;

  return { details, state, timestamps: { start: startedAt } };
}

/** Push the current settings and activity at the presence module. */
function syncPresence() {
  const settings = all_settings();
  presence.sync({
    enabled: settings['discord.richPresence'],
    clientId: settings['discord.clientId'],
    activity: presenceActivity()
  });
}

// ---------------------------------------------------------------- events

/**
 * Push every bus event to the renderer.
 *
 * The payload is structured-cloned by Electron. Anything circular - a
 * mineflayer entity graph, for instance - would throw there, so events carry
 * plain values only; the guard below turns a mistake into a log line rather
 * than a dead worker.
 */
function forwardEvents() {
  for (const name of Object.values(EVENTS)) {
    bus.on(name, (payload) => {
      try {
        port.postMessage({ event: name, payload: payload ?? null });
      } catch (err) {
        logger.warn('app', `Dropped an unclonable "${name}" event: ${err.message}`);
      }
    });
  }

  bus.on(EVENTS.NOTIFY, (payload) => {
    if (!getSetting('notify.sound')) return;
    // Nothing to do here; the renderer decides whether to chime.
    void payload;
  });

  // A bot connecting or dropping changes the count on the Discord profile.
  // This event fires far more often than the count changes - it carries health
  // and position as well - so the presence module is what decides whether there
  // is anything new to say, and stops a no-op from becoming a write per tick.
  bus.on(EVENTS.BOT_STATE, () => syncPresence());
}

// ---------------------------------------------------------------- methods

const asIds = (value) => (Array.isArray(value) ? value : []).map(Number).filter(Number.isFinite);

/**
 * Re-read settings after a write, apply the ones the backend owns, and tell
 * everyone.
 *
 * The logger's level and destination live in settings, so they have to be
 * pushed into the live logger instance rather than only stored. The event is
 * emitted with the *complete* settings object because the main process mirrors
 * a few general keys into a JSON file it can read synchronously.
 */
function applySettingsChange() {
  const settings = all_settings();

  configureLogger({
    level: settings['logging.level'],
    toFile: settings['logging.toFile'],
    maxRows: settings['logging.maxRows']
  });

  // The master switch can have been moved, which means loading or unloading
  // every addon. Doing it here rather than in a listener keeps the reload on
  // the same tick as the write that caused it, so the Settings pane never shows
  // a switch that has moved next to a list that has not.
  addons.syncMasterSwitch();

  // The presence is a live view of the same two counts the panel shows, so a
  // switch that turns it on has to take effect on this tick rather than on the
  // next bot event.
  syncPresence();

  bus.emit(EVENTS.SETTINGS_CHANGED, settings);
  return settings;
}

export const methods = {
  // ------------------------------------------------------------ app
  'app.info': () => ({
    version: process.env.FLORA_VERSION ?? '0.0.0',
    dataRoot: dataRoot(),
    dbFile: dbFile(),
    db: info(),
    pid: process.pid,
    electron: process.versions.electron ?? null,
    node: process.versions.node,
    runningBots: bots.runningCount(),
    botLimit: getSetting('bots.maxConcurrent'),
    // Reported here rather than only in the Settings pane because the answer to
    // "why does my profile not say anything" is nearly always "Discord is not
    // running" or "no application ID was pasted", and this is what the
    // diagnostics block in About copies out.
    discord: presence.status()
  }),

  'app.settings.all': () => all_settings(),
  'app.settings.describe': () => describeSettings(),
  'app.settings.update': (patch) => {
    updateSettings(patch ?? {});
    return applySettingsChange();
  },
  'app.settings.reset': (keys) => {
    resetSettings(keys ?? null);
    return applySettingsChange();
  },

  'app.logs.tail': ({ limit = 500, level = null } = {}) => {
    const rows = level
      ? all('SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?', level, Number(limit))
      : all('SELECT * FROM logs ORDER BY id DESC LIMIT ?', Number(limit));
    return rows.reverse();
  },
  'app.logs.clear': () => {
    const removed = count('SELECT COUNT(*) FROM logs');
    db().exec('DELETE FROM logs');
    return { removed, ok: true };
  },
  'app.logs.prune': ({ days = null } = {}) => ({ removed: pruneLogs(days ?? getSetting('logging.retentionDays')) }),

  'app.snapshot': ({ reason = 'manual' } = {}) => snapshot(reason),

  'app.stats': () => ({
    accounts: repo.counts(),
    proxies: proxies.counts(),
    skins: skins.cacheStats(),
    runningBots: bots.runningCount(),
    logs: count('SELECT COUNT(*) FROM logs'),
    history: count('SELECT COUNT(*) FROM command_history')
  }),

  // ------------------------------------------------------------ accounts
  'accounts.list': (options = {}) => accounts.list(options),
  'accounts.counts': () => accounts.counts(),
  'accounts.tags': () => accounts.tags(),
  'accounts.get': ({ id }) => accounts.get(id),
  'accounts.ids': (options = {}) => accounts.idsFor(options),

  'accounts.addToken': (payload = {}) => accounts.addToken(payload),
  'accounts.addOffline': (payload = {}) => accounts.addOffline(payload),
  'accounts.update': ({ id, patch = {} }) => accounts.updateMeta(id, patch),
  'accounts.remove': ({ ids }) => ({ removed: accounts.remove(ids) }),

  'accounts.test': ({ id }) => accounts.testAccount(id),
  'accounts.testMany': ({ ids, concurrency = 6 }) => accounts.testAccounts(asIds(ids), { concurrency }),
  'accounts.refreshProfile': ({ id }) => accounts.refreshProfile(id),

  'accounts.select': ({ ids, value = true }) => accounts.setSelection(asIds(ids), value),
  'accounts.selectAll': () => accounts.selectAll(),
  'accounts.selectNone': () => accounts.selectNone(),
  'accounts.invert': () => accounts.invertSelection(),

  'accounts.revealToken': ({ id }) => ({ token: repo.revealToken(id) }),
  'accounts.revealPassword': ({ id }) => ({ password: repo.revealPassword(id) }),
  'accounts.export': ({ ids, includeSecrets = false }) =>
    accounts.exportAccounts(asIds(ids), { includeSecrets }),

  // Renaming is one account at a time on purpose. Mojang allows a change once
  // every 30 days per account, so a batch would only produce a longer list of
  // the same refusal.
  'accounts.checkName': ({ id, name }) => accounts.checkUsername(id, name),
  'accounts.changeName': ({ id, name }) => accounts.changeUsername(id, name),

  // ------------------------------------------------------------ microsoft
  'microsoft.begin': ({ label = '' } = {}) => accounts.beginMicrosoftLogin({ label }),
  'microsoft.cancel': ({ id }) => ({ cancelled: accounts.cancelLoginSession(id) }),

  // ------------------------------------------------------------ import
  'import.prepare': ({ text, filename = '' }) => accounts.prepareImport(text, filename),
  'import.confirm': ({ stageId, label = '', verify = false }) =>
    accounts.confirmImport(stageId, { label, verify }),
  'import.discard': ({ stageId }) => ({ discarded: accounts.discardImport(stageId) }),
  'import.help': () => accounts.formatHelp(),

  // ------------------------------------------------------------ skins
  // Concurrency is left undefined wherever a caller has not named one, so the
  // service default applies - and that default is wider when the work is being
  // spread across a proxy pool. A number written here would override it.
  'skins.fetch': ({ id, force = false }) => skins.fetchSkin(id, { force }),
  'skins.fetchMany': ({ ids, concurrency, force = false }) =>
    skins.fetchSkinsFor(asIds(ids), { concurrency, force }),
  'skins.apply': ({ id, pngBase64, model = 'classic' }) =>
    skins.applySkin(id, { png: Buffer.from(pngBase64, 'base64'), model }),
  'skins.applyMany': ({ ids, pngBase64, model = 'classic', concurrency }) =>
    skins.applySkinToMany(asIds(ids), { png: Buffer.from(pngBase64, 'base64'), model, concurrency }),
  'skins.copyFrom': ({ sourceId, ids, model = null, concurrency }) =>
    skins.copySkinFrom(sourceId, asIds(ids), { model, concurrency }),
  'skins.reset': ({ id }) => skins.resetSkin(id),
  'skins.resetMany': async ({ ids }) => {
    const results = await accounts.mapLimit(asIds(ids), proxies.apiConcurrency(3, 8), async (id) => {
      try { await skins.resetSkin(id); return { id, ok: true }; }
      catch (err) { return { id, ok: false, error: err.message }; }
    });
    return {
      results,
      counts: {
        total: results.length,
        reset: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length
      }
    };
  },
  'skins.cache': () => skins.cacheStats(),
  'skins.clearCache': () => ({ removed: skins.clearCache() }),

  // ------------------------------------------------------------ bots
  'bots.list': () => bots.listRunning(),
  'bots.start': ({ id, server = null, version = null, proxyId = null }) =>
    bots.start(id, { server, version, proxyId }),
  'bots.startMany': async ({ ids, server = null, version = null, proxyId = null }) => {
    const list = asIds(ids);
    const results = await accounts.mapLimit(list, 1, async (id) => {
      try { return { id, ok: true, ...(await bots.start(id, { server, version, proxyId })) }; }
      catch (err) { return { id, ok: false, error: err.message }; }
    });
    return {
      results,
      counts: {
        total: list.length,
        started: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length
      }
    };
  },
  'bots.stop': async ({ id, server = null, reason = 'requested' }) =>
    ({ stopped: await bots.stop(id, { server, reason }) }),
  'bots.stopAll': async () => ({ stopped: await bots.stopAll({ reason: 'requested from the app' }) }),
  'bots.chat': ({ id, message, server = null }) => ({ sent: bots.chat(id, message, { server }) }),
  'bots.command': ({ id, command, server = null }) => ({ sent: bots.command(id, command, { server }) }),
  'bots.whisper': ({ id, target, message, server = null }) =>
    ({ sent: bots.whisper(id, target, message, { server }) }),
  'bots.describe': ({ id, server = null }) => bots.describe(id, server),
  'bots.console': ({ id }) => bots.consoleFor(id),
  'bots.clearConsole': ({ id }) => ({ cleared: Boolean(bots.clearConsole(id)) }),
  'bots.states': () => bots.stateMap(),
  'bots.commands': () => bots.commandReference(),
  'bots.versions': () => bots.supportedVersions(),

  // ------------------------------------------------------------ proxies
  'proxies.list': (options = {}) => proxies.list(options),
  'proxies.counts': () => proxies.counts(),
  'proxies.add': (payload = {}) => proxies.add(payload),
  'proxies.update': ({ id, patch = {} }) => proxies.update(id, patch),
  'proxies.remove': ({ ids }) => ({ removed: proxies.removeMany(asIds(ids)) }),
  'proxies.parse': ({ text, protocol = 'socks5' }) => proxies.parseList(text, { protocol }),
  'proxies.addMany': ({ entries, label = '' }) => proxies.addMany(entries ?? [], { label }),
  'proxies.check': ({ id }) => proxies.check(id),
  'proxies.checkMany': ({ ids, concurrency = 8 }) => proxies.checkMany(asIds(ids), { concurrency }),
  'proxies.assign': ({ ids, reassign = false }) => proxies.assignUniqueProxies(asIds(ids), { reassign }),
  'proxies.clearAssignments': ({ ids }) => ({ cleared: proxies.clearAssignments(asIds(ids)) }),
  'proxies.usage': () => Object.fromEntries(proxies.usage()),

  // ------------------------------------------------------------ addons
  'addons.list': () => addons.list(),
  'addons.enable': ({ id, enabled }) => addons.setEnabled(id, enabled),
  'addons.setting': ({ id, key, value }) => ({ value: addons.setSetting(id, key, value) }),
  'addons.install': ({ path }) => addons.install(path),
  'addons.remove': ({ id }) => addons.remove(id),
  'addons.reload': () => addons.reload(),
  'addons.folder': () => ({ path: addons.folder() }),
  // Kept in the backend rather than the renderer so the text sits next to the
  // API it documents, and a change to the API and a change to the instructions
  // for using it are one diff rather than two files that can drift.
  'addons.prompt': () => ({ text: ADDON_PROMPT, api: API_VERSION }),

  // ------------------------------------------------------------ audio
  'audio.list': () => ({ tracks: audio.list(), stats: audio.stats() }),
  'audio.add': ({ files }) => audio.add(files ?? []),
  'audio.remove': ({ name }) => audio.remove(name),
  'audio.read': ({ name }) => audio.read(name),

  // ------------------------------------------------------------ history
  'history.list': ({ limit = 100 } = {}) =>
    all('SELECT * FROM command_history ORDER BY id DESC LIMIT ?', Number(limit)),
  'history.clear': () => {
    db().exec('DELETE FROM command_history');
    return { ok: true };
  }
};

const table = methods;

// ---------------------------------------------------------------- dispatch

function reply(id, ok, payload) {
  port.postMessage(ok ? { id, ok: true, result: payload } : { id, ok: false, error: payload });
}

async function dispatch(message) {
  const { id, method, params } = message ?? {};

  const handler = Object.hasOwn(table, method) ? table[method] : undefined;
  if (typeof handler !== 'function') {
    reply(id, false, `Unknown method "${method}".`);
    return;
  }

  try {
    const result = await handler(params ?? {});
    reply(id, true, result);
  } catch (err) {
    const message_ = err?.message ?? String(err);
    // Method failures are expected traffic - a dead token, a taken username -
    // so they are logged at debug and reported to the caller, not thrown.
    logger.debug('app', `${method} failed: ${message_}`);
    reply(id, false, message_);
  }
}

// ---------------------------------------------------------------- wiring

port.on('message', (event) => {
  const message = event?.data;

  if (message?.method === '__boot') {
    try {
      boot(message.params ?? {});
      forwardEvents();
      reply(message.id, true, { ok: true });
    } catch (err) {
      // A boot failure is fatal: without a database there is nothing to serve.
      reply(message.id, false, err?.stack ?? String(err));
      logger.error('app', `Backend failed to start: ${err?.message ?? err}`);
    }
    return;
  }

  if (message?.method === '__shutdown') {
    (async () => {
      try {
        // Dropping the socket is what clears the profile: Discord forgets an
        // activity when the client that set it goes away, so the presence is
        // not left claiming bots are running after flora has quit.
        presence.stop();
        await bots.shutdown();
        closeDb();
      } catch { /* shutting down anyway */ }
      reply(message.id, true, { ok: true });
      process.exit(0);
    })();
    return;
  }

  dispatch(message);
});

// An unhandled rejection in a bot task must not take the whole worker down and
// strand every other account with it.
process.on('unhandledRejection', (reason) => {
  logger.error('app', `Unhandled rejection in the backend: ${reason?.message ?? reason}`);
});
