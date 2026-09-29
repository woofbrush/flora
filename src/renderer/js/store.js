/**
 * Application state.
 *
 * A small observable store rather than a framework. It holds the data every
 * view shares, keeps it current by reacting to the backend's push events, and
 * hands out two things: `subscribe(topic, fn)` for changes to a slice, and
 * `emit(topic, payload)` for the app's own internal signals (navigation, a
 * toast, a modal closing).
 *
 * Refresh policy, which is the only subtle part:
 *
 *   - The account list is refetched on `accounts:changed`, debounced. A bulk
 *     import emits one event per hundred rows, and refetching a thousand
 *     accounts on each of them would make the app unusable for exactly as long
 *     as the import takes.
 *   - Bot status is *not* refetched. It arrives in the event payload, so the
 *     rows are patched in place - a bot that connects should highlight instantly,
 *     not after a round trip.
 */

import * as bridge from './bridge.js';

// ---------------------------------------------------------------- topics

const listeners = new Map();

export function subscribe(topic, fn) {
  if (!listeners.has(topic)) listeners.set(topic, new Set());
  listeners.get(topic).add(fn);
  return () => listeners.get(topic)?.delete(fn);
}

export function emit(topic, payload = null) {
  const set = listeners.get(topic);
  if (!set) return;
  for (const fn of [...set]) {
    try { fn(payload); } catch (err) { console.error(`[flora] listener for "${topic}" threw`, err); }
  }
}

export const TOPICS = Object.freeze({
  READY: 'ready',
  ACCOUNTS: 'accounts',
  PROXIES: 'proxies',
  BOTS: 'bots',
  LOGS: 'logs',
  SETTINGS: 'settings',
  STATS: 'stats',
  ADDONS: 'addons',
  AUDIO: 'audio',
  BUSY: 'busy',
  // internal
  NAVIGATE: 'navigate',
  ACTION: 'action'
});

// ---------------------------------------------------------------- state

export const state = {
  ready: false,
  /** Every setting, keyed as in the backend schema. */
  settings: {},
  /** The schema `describe()` returns: groups and field specs for Settings. */
  settingsSchema: { groups: [], fields: [] },

  accounts: [],
  proxies: [],
  /** Account ids whose row is ticked, mirrored from the database. */
  selection: new Set(),
  /** Live bot status per account id, patched from events. */
  botState: {},

  /** Anything the backend said it is working on, keyed by scope. */
  busy: {},

  stats: null,
  /**
   * Installed addons, as the registry describes them.
   *
   * Held here rather than fetched inside the Settings view because the addon
   * list is also what the shell needs: the count of loaded addons is worth a
   * badge, and an addon that failed to load is worth saying out loud on the
   * screen the user is already looking at.
   */
  addons: [],
  /** The voice chat audio library: the tracks a bot can play. */
  audio: { tracks: [], stats: null },
  /** Recent log rows, newest last. */
  logs: [],
  /** Per-account bot console lines, newest last. Capped at 500 per account. */
  consoles: new Map()
};

const CONSOLE_LIMIT = 500;

export const settings = () => state.settings;
export const setting = (key, fallback = undefined) =>
  (key in state.settings ? state.settings[key] : fallback);

export const accounts = () => state.accounts;
export const proxies = () => state.proxies;

/**
 * The rows the user has ticked.
 *
 * Selection is mirrored from the database rather than kept only in the renderer
 * because bulk actions run against `selected = 1` on the backend, and the two
 * must not be able to disagree.
 */
export function selected() {
  return state.accounts.filter((a) => a.selected);
}

export function selectedIds() {
  return selected().map((a) => a.id);
}

export function accountById(id) {
  return state.accounts.find((a) => a.id === Number(id)) ?? null;
}

export function proxyById(id) {
  return state.proxies.find((p) => p.id === Number(id)) ?? null;
}

export function consoleFor(id) {
  return state.consoles.get(Number(id)) ?? [];
}

/** Live status for an account, preferring the event-fed map. */
export function botFor(id) {
  return state.botState[Number(id)] ?? { status: 'offline', server: null, error: null, count: 0 };
}

export function onlineCount() {
  return Object.values(state.botState).filter((b) => b.status === 'online').length;
}

// ---------------------------------------------------------------- loading

let accountRefresh = null;

/** Refetch the account list. Debounced, because bulk actions emit in bursts. */
export function refreshAccounts({ immediate = false } = {}) {
  if (immediate) {
    clearTimeout(accountRefresh);
    accountRefresh = null;
    return loadAccounts();
  }

  clearTimeout(accountRefresh);
  // Long enough to absorb an import's progress events, short enough that a
  // single edit feels instant.
  accountRefresh = setTimeout(loadAccounts, 120);
}

async function loadAccounts() {
  try {
    const rows = await bridge.invoke('accounts.list', {});
    state.accounts = rows;
    // Bot status comes back merged for anything currently connected, so the
    // event-fed map is seeded rather than replaced.
    for (const row of rows) {
      if (row.bot) state.botState[row.id] = row.bot;
    }
    emit(TOPICS.ACCOUNTS);
  } catch (err) {
    emit(TOPICS.ACCOUNTS, { error: err.message });
  }
}

export async function refreshProxies() {
  try {
    state.proxies = await bridge.invoke('proxies.list', {});
    emit(TOPICS.PROXIES);
  } catch (err) {
    emit(TOPICS.PROXIES, { error: err.message });
  }
}

export async function refreshStats() {
  try {
    state.stats = await bridge.invoke('app.stats');
    emit(TOPICS.STATS);
  } catch { /* the dashboard shows what it has */ }
}

export async function refreshLogs({ limit = 400 } = {}) {
  try {
    state.logs = await bridge.invoke('app.logs.tail', { limit });
    emit(TOPICS.LOGS);
  } catch { /* the activity view keeps its last list */ }
}

/**
 * Read the installed addons.
 *
 * Failure is swallowed rather than surfaced: the addon list is a convenience
 * for a screen most sessions never open, and an app that shows an error about
 * it on launch would be reporting a problem with its least important part.
 */
export async function refreshAddons() {
  try {
    state.addons = await bridge.invoke('addons.list');
    emit(TOPICS.ADDONS);
  } catch { /* the Settings pane will show the list as empty */ }
}

export async function refreshAudio() {
  try {
    const result = await bridge.invoke('audio.list');
    state.audio = { tracks: result?.tracks ?? [], stats: result?.stats ?? null };
    emit(TOPICS.AUDIO);
  } catch { /* same reasoning as the addon list */ }
}

export async function refreshSettings() {
  try {
    state.settings = await bridge.invoke('app.settings.all');
    applyAppearance();
    emit(TOPICS.SETTINGS);
  } catch { /* keep the mirror, which is at worst one launch out of date */ }
}

/**
 * Push the appearance settings onto <html> and into the pre-paint mirror.
 *
 * Everything the Appearance panel controls resolves through these attributes,
 * which is why the theme can change without re-rendering a single view.
 */
export function applyAppearance() {
  const root = document.documentElement;
  const map = {
    'appearance.theme': 'theme',
    'appearance.accent': 'accent',
    'appearance.radius': 'radius',
    'appearance.density': 'density',
    'appearance.headStyle': 'headStyle'
  };

  const mirror = {};

  for (const [key, attribute] of Object.entries(map)) {
    const value = state.settings[key];
    if (value == null) continue;
    root.dataset[attribute] = value;
    mirror[attribute] = value;
  }

  const custom = state.settings['appearance.accentCustom'];
  if (custom && state.settings['appearance.accent'] === 'custom') {
    root.style.setProperty('--accent', custom);
    mirror.accentCustom = custom;
  } else {
    root.style.removeProperty('--accent');
  }

  if (state.settings['appearance.fontScale']) {
    root.style.setProperty('--font-scale', String(state.settings['appearance.fontScale']));
  }

  root.dataset.reduceMotion = state.settings['appearance.reduceMotion'] ? 'true' : 'false';

  // The backdrop is a separate switch from reduced motion: one is about comfort,
  // the other about taste, and someone may well want the art held still rather
  // than gone. `none` removes the canvas from the layout entirely.
  root.dataset.backdrop = state.settings['appearance.background'] === 'none' ? 'none' : 'aurora';

  try {
    localStorage.setItem('flora.appearance', JSON.stringify(mirror));
  } catch { /* private mode, or the quota; the mirror is a nicety */ }
}

/** Initial load. Resolves once every collection has been fetched at least once. */
export async function loadAll() {
  await Promise.all([
    refreshSettings(),
    refreshAccounts({ immediate: true }),
    refreshProxies(),
    refreshStats(),
    refreshLogs(),
    refreshAddons(),
    refreshAudio(),
    bridge.invoke('app.settings.describe')
      .then((schema) => { state.settingsSchema = schema; emit(TOPICS.SETTINGS); })
      .catch(() => {})
  ]);
}

// ---------------------------------------------------------------- events

/**
 * Wire the backend's event stream into the store.
 *
 * Every branch here exists because a view would otherwise have to poll. If a
 * change is not reflected in the UI, the missing branch is in this function.
 */
export function connect() {
  bridge.on('backend:event', ({ event, payload }) => {
    switch (event) {
      case 'accounts:changed':
        refreshAccounts();
        refreshStats();
        break;

      case 'accounts:updated':
        // A single row changed; patching it beats refetching the list.
        if (payload?.id) {
          const index = state.accounts.findIndex((a) => a.id === Number(payload.id));
          if (index !== -1) {
            state.accounts[index] = { ...state.accounts[index], ...payload };
            emit(TOPICS.ACCOUNTS);
          } else {
            refreshAccounts();
          }
        } else {
          refreshAccounts();
        }
        break;

      case 'accounts:test-progress':
      case 'accounts:import-progress':
      case 'skins:progress':
      case 'proxies:check-progress':
        emit(TOPICS.BUSY, { event, ...payload });
        break;

      case 'bots:state': {
        const id = Number(payload?.accountId);
        if (!id) break;
        state.botState[id] = {
          ...(state.botState[id] ?? {}),
          ...payload,
          // A terminal transition clears the transient attempt counter.
          attempt: payload.status === 'online' ? 0 : payload.attempt
        };
        emit(TOPICS.BOTS, state.botState[id]);
        break;
      }

      case 'bots:log': {
        const id = Number(payload?.accountId);
        if (!id) break;
        let list = state.consoles.get(id);
        if (!list) { list = []; state.consoles.set(id, list); }
        list.push(payload);
        if (list.length > CONSOLE_LIMIT) list.splice(0, list.length - CONSOLE_LIMIT);
        emit(TOPICS.BOTS, { accountId: id, console: true });
        break;
      }

      case 'bots:chat':
        emit(TOPICS.BOTS, { ...payload, chat: true });
        break;

      case 'bots:kicked':
      case 'bots:error':
        emit(TOPICS.BOTS, payload);
        break;

      case 'proxies:changed':
        refreshProxies();
        refreshStats();
        break;

      case 'proxies:checked':
        // Patch the one row instead of refetching the pool.
        {
          const index = state.proxies.findIndex((p) => p.id === Number(payload?.id));
          if (index !== -1) {
            state.proxies[index] = {
              ...state.proxies[index],
              lastCheckedAt: Date.now(),
              lastOk: Boolean(payload.ok),
              lastLatencyMs: payload.latency ?? null,
              lastError: payload.error ?? null
            };
            emit(TOPICS.PROXIES);
          }
        }
        break;

      case 'skins:applied':
        // The row's head changes, so the list has to be re-read.
        refreshAccounts();
        break;

      case 'app:settings-changed':
        state.settings = payload ?? state.settings;
        applyAppearance();
        emit(TOPICS.SETTINGS);
        break;

      case 'addons:changed':
        // The backend is the authority on this list, so the payload is taken
        // wholesale rather than merged - an addon that failed to load has to be
        // able to disappear from the list, and a merge would keep it.
        state.addons = Array.isArray(payload) ? payload : state.addons;
        emit(TOPICS.ADDONS);
        break;

      case 'app:log':
        // The activity view tails the table; appending keeps it live without a
        // query per line.
        state.logs.push(payload);
        if (state.logs.length > 2000) state.logs.splice(0, state.logs.length - 2000);
        emit(TOPICS.LOGS, payload);
        break;

      case 'app:busy':
        if (payload?.scope) {
          state.busy[payload.scope] = payload.active
            ? { active: true, done: 0, total: payload.total ?? 0 }
            : { active: false };
          emit(TOPICS.BUSY, state.busy[payload.scope]);
        }
        break;

      default:
        break;
    }
  });

  bridge.on('backend:state', (payload) => {
    const wasReady = state.ready;
    state.ready = Boolean(payload?.ready);
    if (state.ready && !wasReady) {
      emit(TOPICS.READY);
      loadAll();
    }
  });

  // Menu and tray ask the shell to move; the shell listens, not the store.
  bridge.on('app:navigate', (view) => emit(TOPICS.NAVIGATE, view));
  bridge.on('app:action', (action) => emit(TOPICS.ACTION, action));
}
