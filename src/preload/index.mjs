/**
 * Preload bridge.
 *
 * The only thing the renderer can see of Node. It exposes exactly three verbs -
 * `invoke`, `on`, `ready` - over a fixed set of channels, so the UI has no path
 * to `require`, to the filesystem, or to any channel the main process did not
 * deliberately publish.
 *
 * A `.mjs` extension is required: Electron only loads an ESM preload when the
 * file is explicitly a module, and this package's `type` field applies to the
 * main process, not to this file.
 */
import { contextBridge, ipcRenderer } from 'electron';

/** Push channels the renderer may subscribe to. */
const EVENTS = [
  'backend:event',    // everything from the backend's event bus
  'backend:state',    // backend up/down, bot counts
  'app:navigate',     // menu and tray asked for a view
  'app:action',       // menu asked for an action the UI owns
  'window:state'      // maximise / fullscreen changes
];

/** Invoke channels, kept in step with src/main/ipc.js. */
const METHODS = new Set([
  'ui.openAccountsFile', 'ui.openSkinFile', 'ui.saveText', 'ui.saveImage', 'ui.confirm',
  'ui.openAddonFolder', 'ui.openAudioFiles',
  'ui.openExternal', 'ui.revealPath', 'ui.openPath', 'ui.copy',
  'ui.window.minimise', 'ui.window.toggleMaximise', 'ui.window.close', 'ui.window.focus',
  'ui.window.state',
  'ui.app.versions', 'ui.app.relaunch', 'ui.app.quit', 'ui.app.restartBackend', 'ui.app.setBadge',

  'app.info', 'app.settings.all', 'app.settings.describe', 'app.settings.update', 'app.settings.reset',
  'app.logs.tail', 'app.logs.clear', 'app.logs.prune', 'app.snapshot', 'app.stats',

  'accounts.list', 'accounts.counts', 'accounts.tags', 'accounts.get', 'accounts.ids',
  'accounts.addToken', 'accounts.addOffline', 'accounts.update', 'accounts.remove',
  'accounts.test', 'accounts.testMany', 'accounts.refreshProfile',
  'accounts.select', 'accounts.selectAll', 'accounts.selectNone', 'accounts.invert',
  'accounts.revealToken', 'accounts.revealPassword', 'accounts.export',
  'accounts.checkName', 'accounts.changeName',

  'microsoft.begin', 'microsoft.cancel',

  'import.prepare', 'import.confirm', 'import.discard', 'import.help',

  'skins.fetch', 'skins.fetchMany', 'skins.apply', 'skins.applyMany', 'skins.copyFrom',
  'skins.reset', 'skins.resetMany', 'skins.cache', 'skins.clearCache',

  'bots.list', 'bots.start', 'bots.startMany', 'bots.stop', 'bots.stopAll',
  'bots.chat', 'bots.command', 'bots.whisper', 'bots.describe', 'bots.console',
  'bots.clearConsole', 'bots.states', 'bots.commands', 'bots.versions',

  'proxies.list', 'proxies.counts', 'proxies.add', 'proxies.update', 'proxies.remove',
  'proxies.parse', 'proxies.addMany', 'proxies.check', 'proxies.checkMany',
  'proxies.assign', 'proxies.clearAssignments', 'proxies.usage',

  'addons.list', 'addons.enable', 'addons.setting', 'addons.install', 'addons.remove',
  'addons.reload', 'addons.folder', 'addons.prompt',

  'audio.list', 'audio.add', 'audio.remove', 'audio.read',

  'history.list', 'history.clear'
]);

/**
 * Turn a main-process rejection into something the UI can show.
 *
 * Electron wraps a thrown error in a string like
 * `Error invoking remote method 'flora:x': Error: real message`. That prefix is
 * noise in a toast, so it is stripped here where the wrapping is still legible.
 */
function cleanError(err) {
  const raw = err?.message ?? String(err);
  const match = /Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?([\s\S]*)$/.exec(raw);
  return new Error(match ? match[1].trim() : raw);
}

const listeners = new Map();

const api = {
  /**
   * Call a backend or main-process method.
   *
   * Returns a promise that rejects with the real message, never with Electron's
   * IPC wrapper.
   */
  async invoke(method, params = {}) {
    if (!METHODS.has(method)) {
      throw new Error(`flora has no method called "${method}".`);
    }
    try {
      return await ipcRenderer.invoke(`flora:${method}`, params);
    } catch (err) {
      throw cleanError(err);
    }
  },

  /**
   * Subscribe to a push channel. Returns an unsubscribe function.
   *
   * The raw IpcRendererEvent is never handed to the callback - it carries a
   * `sender` reference the UI has no business holding.
   */
  on(channel, callback) {
    if (!EVENTS.includes(channel)) {
      throw new Error(`flora does not publish "${channel}".`);
    }
    if (typeof callback !== 'function') {
      throw new Error('A listener must be a function.');
    }

    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, wrapped);

    // Tracked so `off` can be called without the caller keeping the wrapper.
    const key = `${channel}:${callback.name || 'anonymous'}`;
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add({ wrapped, callback });

    return () => {
      ipcRenderer.off(channel, wrapped);
      listeners.get(key)?.delete({ wrapped, callback });
    };
  },

  /** Called once the first screen has painted; the window is shown after this. */
  ready() {
    ipcRenderer.send('flora:ui.ready');
  },

  /** Channel list, so the UI can assert its own subscriptions in development. */
  channels: Object.freeze([...EVENTS])
};

contextBridge.exposeInMainWorld('flora', Object.freeze(api));
