/**
 * The addon registry.
 *
 * Owns everything about addons that is not the sandbox itself: where they live,
 * which ones are on, what API each one is handed, and the two ways an addon
 * reaches into a bot - a command it registers, and an event it listens for.
 *
 * Load order is worth stating because it explains most of the shape below.
 * Commands are consulted on every chat line a bot receives, so the command
 * table has to be answerable synchronously and cheaply - `addonCommand()` is a
 * map lookup, not a search. Bot events arrive from the manager, which is the
 * only module that knows a bot exists, so this module never imports the manager;
 * the manager installs a provider here at boot instead. That keeps the
 * dependency one-way and the module testable without a socket.
 *
 * A failing addon is isolated rather than fatal throughout. It is not loaded,
 * or it is unloaded, and the reason is kept beside its name so the Settings
 * pane can show it. Nothing an addon does should be able to stop flora from
 * starting, because the accounts and the bots are the app and the addons are
 * not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bus, EVENTS } from '../events.js';
import { logger } from '../logging/logger.js';
import { getSetting } from '../settings.js';
import { addonsDir, addonDataDir, addonStoreFile } from '../paths.js';
import { readManifest, API_VERSION } from './manifest.js';
import { loadAddon, guard } from './host.js';

const BUILTIN_DIR = fileURLToPath(new URL('./builtin/', import.meta.url));

/** Written into the addon-data folder. An id can never start with "_". */
const STATE_FILE = () => path.join(addonDataDir(), '_state.json');

/** The events an addon may subscribe to. Anything else is refused by name. */
export const BOT_EVENTS = Object.freeze([
  'bot:login',    // authenticated and in the world's player list
  'bot:spawn',    // positioned in a world and able to move
  'bot:chat',     // a player said something: { username, message }
  'bot:message',  // system or action-bar text: { message }
  'bot:kicked',   // { reason }
  'bot:error',    // { error }
  'bot:end'       // the socket closed: { reason }
]);

const COMMAND_NAME = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * Everything the registry knows, keyed by addon id.
 *
 * One entry per discovered addon, loaded or not, because the Settings pane has
 * to list an addon that failed to load alongside the ones that did.
 */
const entries = new Map();

/** name -> { addonId, spec }, the lookup the command dispatcher uses. */
const commands = new Map();

/** The manager installs this at boot. See the note at the top of the file. */
let botProvider = null;

export function setBotProvider(provider) {
  botProvider = provider;
}

const bots = () => botProvider ?? {};

// ---------------------------------------------------------------- state

/**
 * Which addons are switched on.
 *
 * Kept in a file of its own rather than in the settings table because a setting
 * has to be declared in the schema to be read, and the set of addons is not
 * known until the addons folder has been scanned - a chicken and egg that a
 * plain JSON file sidesteps. The file also survives deleting an addon, so
 * reinstalling it comes back with the switch where it was left.
 */
function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.enabled && typeof parsed.enabled === 'object'
      ? parsed.enabled
      : {};
  } catch {
    return {};
  }
}

function writeState(enabled) {
  try {
    fs.writeFileSync(STATE_FILE(), JSON.stringify({ enabled }, null, 2));
  } catch (err) {
    logger.warn('addons', `Could not save which addons are on: ${err.message}`);
  }
}

// ---------------------------------------------------------------- per-addon storage

const storeCache = new Map();

function storeFor(id) {
  if (storeCache.has(id)) return storeCache.get(id);

  let data = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(addonStoreFile(id), 'utf8'));
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch { /* a missing or unreadable file is an addon with no saved state */ }

  const shape = { settings: {}, data: {}, ...data };
  storeCache.set(id, shape);
  return shape;
}

const storeTimers = new Map();

/**
 * Save an addon's storage, a moment after it stops changing.
 *
 * Debounced because the natural thing for an addon to do is write a counter on
 * every event it handles, and one file write per chat message across a dozen
 * bots is a lot of disk traffic for a value nobody reads until the next launch.
 */
function saveStore(id) {
  clearTimeout(storeTimers.get(id));
  storeTimers.set(id, setTimeout(() => {
    storeTimers.delete(id);
    try {
      fs.writeFileSync(addonStoreFile(id), JSON.stringify(storeFor(id), null, 2));
    } catch (err) {
      logger.warn('addons', `Could not save ${id}'s data: ${err.message}`);
    }
  }, 400));
}

// ---------------------------------------------------------------- discovery

/** Every addon folder under `root`, skipping anything that is not a directory. */
function foldersIn(root) {
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(root, entry.name));
}

/**
 * Scan both addon folders and reconcile them with what is already loaded.
 *
 * Called at boot and again whenever the user asks for a reload, which is the
 * answer to "I dropped a folder in and nothing happened" - the app does not
 * watch the filesystem, because a half-copied folder being loaded mid-copy is a
 * worse experience than pressing a button.
 */
export function discover({ load = true } = {}) {
  const enabled = readState();
  const seen = new Set();

  const found = [
    ...foldersIn(BUILTIN_DIR).map((dir) => ({ dir, builtinRoot: true })),
    ...foldersIn(addonsDir()).map((dir) => ({ dir, builtinRoot: false }))
  ];

  for (const { dir } of found) {
    const read = readManifest(dir);

    if (!read.ok) {
      // A folder that is not an addon at all is not worth a row in the UI; a
      // folder that meant to be one and got the manifest wrong is.
      if (fs.existsSync(path.join(dir, 'addon.json'))) {
        const id = path.basename(dir);
        // Added to `seen` as well: a row for a broken addon is worthless if the
        // ghost sweep at the end of this pass deletes it again for not having
        // been read successfully.
        seen.add(id);
        entries.set(id, { id, dir, error: read.error, loaded: false });
      }
      continue;
    }

    const { manifest } = read;
    seen.add(manifest.id);

    const existing = entries.get(manifest.id);
    const wanted = enabled[manifest.id] ?? manifest.defaultEnabled;

    // Already loaded from the same folder: leave it running, but pick up a
    // change to the on/off switch made through a path other than setEnabled.
    if (existing?.loaded && existing.dir === dir && wanted) continue;
    if (existing?.loaded && !wanted) { unload(manifest.id); }

    entries.set(manifest.id, {
      id: manifest.id,
      dir,
      manifest,
      enabled: wanted,
      loaded: false,
      error: null,
      hooks: null,
      registrations: [],
      timers: new Set(),
      listeners: new Map(),
      fieldSpecs: new Map()
    });

    // The master switch is consulted here rather than only by the callers, so
    // that installing or reloading while addons are switched off cannot quietly
    // start one.
    if (load && wanted && masterEnabled()) loadEntry(manifest.id);
  }

  // An addon whose folder has gone is removed rather than left as a ghost row.
  for (const id of [...entries.keys()]) {
    if (!seen.has(id)) { unload(id); entries.delete(id); }
  }

  bus.emit(EVENTS.ADDONS_CHANGED, list());
  return list();
}

// ---------------------------------------------------------------- loading

function loadEntry(id) {
  const entry = entries.get(id);
  if (!entry?.manifest || entry.loaded) return entry;

  let source;
  try {
    source = fs.readFileSync(entry.manifest.entry, 'utf8');
  } catch (err) {
    entry.error = `Could not read ${entry.manifest.main}: ${err.message}`;
    return entry;
  }

  const api = buildApi(entry);
  const result = loadAddon({ manifest: entry.manifest, source, api });

  if (!result.ok) {
    entry.error = result.error;
    entry.loaded = false;
    logger.warn('addons', `${id} did not load: ${result.error}`);
    return entry;
  }

  entry.hooks = result.hooks;
  entry.loaded = true;
  entry.error = null;

  if (typeof entry.hooks.activate === 'function') {
    try {
      entry.hooks.activate();
    } catch (err) {
      entry.error = `activate() failed: ${err?.message ?? err}`;
      logger.warn('addons', `${id}: ${entry.error}`);
    }
  }

  logger.info('addons', `${entry.manifest.name} ${entry.manifest.version} loaded.`);
  return entry;
}

/**
 * Stop an addon: run its teardown, drop its commands, clear its timers.
 *
 * Every one of those four is a way an unloaded addon could otherwise keep
 * acting - a listener still firing, a command still answering, a timer still
 * ticking - so all four happen here rather than at the call sites, and the
 * entry is only marked unloaded once they have.
 */
function unload(id) {
  const entry = entries.get(id);
  if (!entry) return;

  for (const timer of entry.timers ?? []) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  entry.timers?.clear();

  for (const name of entry.registrations ?? []) commands.delete(name);
  entry.registrations = [];

  for (const [event, handlers] of entry.listeners ?? []) {
    for (const handler of handlers) bus.off(event, handler);
  }
  entry.listeners = new Map();

  if (entry.loaded && typeof entry.hooks?.deactivate === 'function') {
    try {
      entry.hooks.deactivate();
    } catch (err) {
      logger.warn('addons', `${id}: deactivate() threw: ${err?.message ?? err}`);
    }
  }

  entry.loaded = false;
  entry.hooks = null;
}

// ---------------------------------------------------------------- the api

/**
 * The `flora` object one addon is handed.
 *
 * Everything an addon can do is a method here, and everything it cannot do is
 * simply absent - there is no `fs` to reach for and no `fetch` to call. The
 * object and each of its namespaces are frozen, so an addon cannot add a method
 * to `flora.commands` and have the next addon find it there.
 */
function buildApi(entry) {
  const { id, manifest } = entry;

  const log = (message, level = 'info') => {
    const text = String(message ?? '');
    const write = logger[level] ?? logger.info;
    write('addons', `[${manifest.name}] ${text}`);
  };

  const fail = (err) => {
    logger.warn('addons', `[${manifest.name}] ${err}`);
  };

  // ------------------------------------------------------------ commands

  const register = (spec) => {
    const name = String(spec?.name ?? '').toLowerCase();
    if (!COMMAND_NAME.test(name)) {
      throw new Error(`"${spec?.name}" is not a usable command name. Use lowercase letters, digits and dashes.`);
    }
    if (typeof spec?.run !== 'function') {
      throw new Error(`The command "${name}" has no run() function.`);
    }
    if (reserved.has(name)) {
      throw new Error(`"${name}" is already a flora command. Pick another name.`);
    }
    if (commands.has(name)) {
      throw new Error(`"${name}" is already registered by another addon.`);
    }

    commands.set(name, {
      addonId: id,
      addonName: manifest.name,
      spec: {
        name,
        usage: String(spec.usage ?? name),
        summary: String(spec.summary ?? ''),
        local: Boolean(spec.local),
        run: guard(spec.run, fail)
      }
    });
    entry.registrations.push(name);
    return name;
  };

  const unregister = (name) => {
    const key = String(name ?? '').toLowerCase();
    const found = commands.get(key);
    if (!found || found.addonId !== id) return false;
    commands.delete(key);
    entry.registrations = entry.registrations.filter((n) => n !== key);
    return true;
  };

  // ------------------------------------------------------------ settings

  const define = (fields) => {
    for (const [key, spec] of Object.entries(fields ?? {})) {
      entry.fieldSpecs.set(key, {
        key,
        type: spec.type ?? 'bool',
        label: spec.label ?? key,
        help: spec.help ?? null,
        options: spec.options ?? null,
        min: spec.min ?? null,
        max: spec.max ?? null,
        default: spec.default ?? (spec.type === 'number' ? 0 : spec.type === 'string' ? '' : false)
      });
    }
    entry.fieldSpecs = new Map([...entry.fieldSpecs].sort(([a], [b]) => a.localeCompare(b)));
  };

  const settingGet = (key) => {
    const spec = entry.fieldSpecs.get(key);
    const saved = storeFor(id).settings[key];
    return saved === undefined ? spec?.default : saved;
  };

  const settingSet = (key, value) => {
    storeFor(id).settings[key] = value;
    saveStore(id);
    return value;
  };

  // ------------------------------------------------------------ storage

  const store = Object.freeze({
    get: (key, fallback = null) => {
      const value = storeFor(id).data[key];
      return value === undefined ? fallback : value;
    },
    set: (key, value) => { storeFor(id).data[key] = value; saveStore(id); return value; },
    delete: (key) => { delete storeFor(id).data[key]; saveStore(id); },
    all: () => ({ ...storeFor(id).data })
  });

  // ------------------------------------------------------------ bots

  const botApi = Object.freeze({
    list: () => bots().list?.() ?? [],
    get: (accountId) => bots().get?.(Number(accountId)) ?? null,
    chat: (accountId, text) => bots().chat?.(Number(accountId), String(text)),
    whisper: (accountId, target, text) => bots().whisper?.(Number(accountId), String(target), String(text)),
    command: (accountId, text) => bots().command?.(Number(accountId), String(text)),
    log: (accountId, text, level = 'system') => bots().log?.(Number(accountId), level, String(text)),
    /** Every bot connected right now, as `{ accountId, username, server, status }`. */
    online: () => (bots().list?.() ?? []).filter((bot) => bot.status === 'online')
  });

  // ------------------------------------------------------------ timers

  const every = (ms, fn) => {
    const timer = setInterval(guard(fn, fail), clampDelay(ms));
    entry.timers.add(timer);
    return () => { clearInterval(timer); entry.timers.delete(timer); };
  };

  const after = (ms, fn) => {
    const timer = setTimeout(() => {
      entry.timers.delete(timer);
      guard(fn, fail)();
    }, clampDelay(ms));
    entry.timers.add(timer);
    return () => { clearTimeout(timer); entry.timers.delete(timer); };
  };

  return Object.freeze({
    id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    api: API_VERSION,

    log,
    /** Deliberately the only diagnostic channel: addon output goes to flora's log. */
    warn: (message) => log(message, 'warn'),
    error: (message) => log(message, 'error'),

    on: (event, handler) => subscribe(entry, event, handler),

    commands: Object.freeze({ register, unregister, list: () => listCommands(id) }),
    settings: Object.freeze({ define, get: settingGet, set: settingSet }),
    store,
    bots: botApi,
    every,
    after
  });
}

const clampDelay = (ms) => Math.min(3_600_000, Math.max(50, Number(ms) || 1000));

// ---------------------------------------------------------------- events

/**
 * Subscribe an addon to a bot event.
 *
 * These ride the main event bus rather than a private one, so an addon hears
 * exactly what the UI hears and there is one definition of what each event
 * means. The listeners are wrapped rather than tracked by identity, which is
 * what lets `unload` find and remove them again.
 */
function subscribe(entry, event, handler) {
  const name = String(event ?? '');
  if (!BOT_EVENTS.includes(name)) {
    throw new Error(`Unknown event "${name}". Try one of: ${BOT_EVENTS.join(', ')}.`);
  }
  if (typeof handler !== 'function') throw new Error('An event listener must be a function.');

  const wrapped = guard(handler, (err) =>
    logger.warn('addons', `[${entry.manifest.name}] ${name}: ${err}`));

  bus.on(name, wrapped);

  if (!entry.listeners.has(name)) entry.listeners.set(name, new Set());
  entry.listeners.get(name).add(wrapped);

  return () => {
    bus.off(name, wrapped);
    entry.listeners.get(name)?.delete(wrapped);
  };
}

/**
 * Announce a bot event to the addons.
 *
 * Called by the manager at each point in a bot's life that an addon might care
 * about. The bot itself is included, because the useful addon is the one that
 * does something to it - walking, looking, swinging, opening a window - and
 * hiding the bot behind a wrapper would mean re-exposing mineflayer one method
 * at a time.
 */
export function emit(event, payload = {}) {
  if (!entries.size) return;
  bus.emit(event, payload);
}

// ---------------------------------------------------------------- lookups

/**
 * Commands the built-ins own. An addon may not shadow one of these.
 *
 * Filled in by `commands.js` rather than written out here, because a second
 * hand-kept copy of the built-in names is a list that goes stale the first time
 * a command is added and then silently lets an addon shadow it.
 */
const reserved = new Set();

export function setReservedCommands(names) {
  for (const name of names ?? []) reserved.add(String(name).toLowerCase());
}

/**
 * The addon command registered under `name`, or undefined.
 *
 * Returns nothing while the master switch or the chat-command switch is off, so
 * the dispatcher does not have to know those settings exist - from its side, a
 * switched-off addon simply has no commands.
 */
export function addonCommand(name) {
  if (!chatCommandsEnabled()) return undefined;
  return commands.get(String(name ?? '').toLowerCase())?.spec;
}

/** Where a command came from, for the help listing and the Activity view. */
export function addonFor(name) {
  const found = commands.get(String(name ?? '').toLowerCase());
  if (!found) return null;
  return { id: found.addonId, name: found.addonName };
}

/** Every addon command, in the shape `commandHelp` returns. */
export function commandHelp(prefix = '.') {
  if (!chatCommandsEnabled()) return [];
  return [...commands.entries()]
    .map(([name, found]) => ({
      name,
      usage: `${prefix}${found.spec.usage}`,
      summary: found.spec.summary,
      local: found.spec.local,
      addon: found.addonName
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listCommands(id) {
  return [...commands.entries()]
    .filter(([, found]) => found.addonId === id)
    .map(([name, found]) => ({ name, ...found.spec, run: undefined }));
}

// ---------------------------------------------------------------- public shape

export function list() {
  return [...entries.values()]
    .map((entry) => ({
      id: entry.id,
      name: entry.manifest?.name ?? entry.id,
      version: entry.manifest?.version ?? null,
      description: entry.manifest?.description ?? null,
      author: entry.manifest?.author ?? '',
      homepage: entry.manifest?.homepage ?? '',
      builtin: Boolean(entry.manifest?.builtin),
      enabled: Boolean(entry.enabled),
      loaded: Boolean(entry.loaded),
      error: entry.error ?? null,
      commands: entry.loaded ? listCommands(entry.id).map((c) => c.name) : [],
      fields: [...(entry.fieldSpecs ?? new Map()).values()],
      values: valuesOf(entry)
    }))
    .sort((a, b) => {
      // Built-ins first, then alphabetically. The bundled ones are the ones a
      // user is most likely to be looking for, and they are a stable set.
      if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export function get(id) {
  return list().find((entry) => entry.id === id) ?? null;
}

/** Addon setting values, flattened for the renderer. */
export function settingsOf(id) {
  const entry = entries.get(id);
  return entry ? valuesOf(entry) : {};
}

function valuesOf(entry) {
  const out = {};
  for (const [key, spec] of entry.fieldSpecs ?? new Map()) {
    const saved = storeFor(entry.id).settings[key];
    out[key] = saved === undefined ? spec.default : saved;
  }
  return out;
}

export function setSetting(id, key, value) {
  const entry = entries.get(id);
  if (!entry) throw new Error(`No addon called "${id}".`);
  const spec = entry.fieldSpecs.get(key);
  if (!spec) throw new Error(`"${id}" has no setting called "${key}".`);
  storeFor(id).settings[key] = coerceField(spec, value);
  saveStore(id);
  bus.emit(EVENTS.ADDONS_CHANGED, list());
  return storeFor(id).settings[key];
}

/** The same coercion the main settings table does, for addon-declared fields. */
function coerceField(spec, raw) {
  switch (spec.type) {
    case 'bool': return typeof raw === 'boolean' ? raw : Boolean(raw);
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return spec.default;
      return Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, n));
    }
    case 'enum': return (spec.options ?? []).includes(raw) ? raw : spec.default;
    default: return typeof raw === 'string' ? raw : String(raw ?? '');
  }
}

// ---------------------------------------------------------------- commands from the ui

export function setEnabled(id, enabled) {
  const entry = entries.get(id);
  if (!entry) throw new Error(`No addon called "${id}".`);

  const state = readState();
  state[id] = Boolean(enabled);
  writeState(state);

  entry.enabled = Boolean(enabled);
  // The master switch wins over the per-addon one. Without this, switching an
  // addon on while addons are off globally would load it, and the list would
  // show a running addon under a notice saying nothing is running.
  if (entry.enabled && masterEnabled()) loadEntry(id);
  else unload(id);
  entry.enabled = Boolean(enabled);

  bus.emit(EVENTS.ADDONS_CHANGED, list());
  return get(id);
}

export function reload() {
  for (const id of [...entries.keys()]) unload(id);
  entries.clear();
  commands.clear();
  storeCache.clear();
  return discover();
}

/**
 * Copy an addon folder in from somewhere else on disk.
 *
 * A copy rather than a reference: an addon that ran from wherever it was
 * downloaded would break the moment that folder moved, and "install" meaning
 * "this is now flora's copy to keep" is the behaviour that matches the button.
 */
export function install(sourceDir) {
  const from = path.resolve(String(sourceDir ?? ''));
  if (!fs.existsSync(from) || !fs.statSync(from).isDirectory()) {
    throw new Error('Pick an addon folder - one with an addon.json inside it.');
  }

  const read = readManifest(from);
  if (!read.ok) throw new Error(read.error);

  const { manifest } = read;
  if (manifest.builtin) throw new Error('That addon ships with flora. It is already here.');

  const target = path.join(addonsDir(), manifest.id);
  if (fs.existsSync(target)) {
    throw new Error(`"${manifest.name}" is already installed. Remove it first, or reload it to pick up changes.`);
  }

  fs.cpSync(from, target, { recursive: true });

  const state = readState();
  state[manifest.id] = true;
  writeState(state);

  discover();
  return get(manifest.id);
}

export function remove(id) {
  const entry = entries.get(id);
  if (!entry) throw new Error(`No addon called "${id}".`);
  if (entry.manifest?.builtin) throw new Error('Addons that ship with flora cannot be removed, only switched off.');

  unload(id);
  entries.delete(id);
  for (const name of [...commands.keys()]) {
    if (commands.get(name)?.addonId === id) commands.delete(name);
  }

  try {
    fs.rmSync(entry.dir, { recursive: true, force: true });
  } catch (err) {
    throw new Error(`Could not delete the folder: ${err.message}`);
  }

  try { fs.rmSync(addonStoreFile(id), { force: true }); } catch { /* nothing to remove */ }
  storeCache.delete(id);

  const state = readState();
  delete state[id];
  writeState(state);

  bus.emit(EVENTS.ADDONS_CHANGED, list());
  return { removed: true };
}

/** Where addons are installed, for the "show me the folder" action. */
export const folder = () => addonsDir();

/**
 * Load everything that should be loaded. Called once, at boot, after the data
 * root exists - the addons folder is under it and cannot be scanned before.
 */
export function start() {
  // The master switch is checked here rather than in `discover`, so the
  // Settings pane still lists every installed addon and says why none of them
  // are running, instead of showing an empty page that looks like a bug.
  if (!masterEnabled()) {
    logger.info('addons', 'Addons are switched off in Settings.');
    return discover({ load: false });
  }

  const list_ = discover();
  const loaded = list_.filter((entry) => entry.loaded).length;
  logger.info('addons', `${loaded} of ${list_.length} addons loaded.`);
  return list_;
}

/**
 * Whether the master switch is on.
 *
 * Read defensively because this is consulted from a command path that a test
 * can reach without a database behind it, where an unreadable setting should
 * mean "off" rather than an exception thrown at whoever typed a command.
 */
function masterEnabled() {
  try {
    return getSetting('addons.enabled') !== false;
  } catch {
    return false;
  }
}

/**
 * React to the master switch being changed while the app is running.
 *
 * Called after every settings write rather than only when the addon keys
 * changed, because working out whether they changed would mean keeping a copy
 * of the previous settings here for no gain - this is a handful of map lookups
 * either way.
 */
export function syncMasterSwitch() {
  if (!masterEnabled()) {
    for (const id of [...entries.keys()]) unload(id);
    bus.emit(EVENTS.ADDONS_CHANGED, list());
    return list();
  }
  return discover();
}

/** Whether addon commands are allowed to answer in chat. */
export function chatCommandsEnabled() {
  try {
    return masterEnabled() && getSetting('addons.allowChatCommands') !== false;
  } catch {
    return false;
  }
}
