/**
 * IPC relay.
 *
 * The renderer never talks to the backend directly. It calls `flora.invoke()`,
 * which lands here, gets forwarded to the worker, and comes back as a settled
 * promise. Events travel the other way over a single channel.
 *
 * Two rules make this safe to leave open:
 *
 *   - The channel names the renderer may reach are the method names the backend
 *     publishes. A channel that is not in the table below is refused, so the
 *     renderer cannot reach `dialog:*` through `invoke`.
 *   - Anything that opens a dialog or touches the shell is handled here
 *     explicitly, one named channel at a time, rather than by wildcard.
 */
import { ipcMain, clipboard, app } from 'electron';
import * as dialogs from './dialogs.js';
import { send, window, focus } from './window.js';

/**
 * Channels the renderer may invoke that are answered in the main process rather
 * than forwarded to the worker.
 */
function mainHandlers(context) {
  const { backend, quit, beforeQuit } = context;

  return {
    // ---------------------------------------------------------- dialogs
    'ui.openAccountsFile': () => dialogs.openAccountsFile(),
    'ui.openSkinFile': () => dialogs.openSkinFile(),
    'ui.openAddonFolder': () => dialogs.openAddonFolder(),
    'ui.openAudioFiles': () => dialogs.openAudioFiles(),
    'ui.saveText': (params) => dialogs.saveText(params),
    'ui.saveImage': (params) => dialogs.saveImage(params),
    'ui.confirm': (params) => dialogs.confirm(params),

    // ---------------------------------------------------------- shell
    'ui.openExternal': ({ url }) => dialogs.openExternal(url),
    'ui.revealPath': ({ path }) => dialogs.revealPath(path),
    'ui.openPath': ({ path }) => dialogs.openPath(path),
    'ui.copy': ({ text }) => {
      clipboard.writeText(String(text ?? ''));
      return { copied: true };
    },

    // ---------------------------------------------------------- window
    'ui.window.minimise': () => { window()?.minimize(); return { ok: true }; },
    'ui.window.toggleMaximise': () => {
      const win = window();
      if (!win) return { maximised: false };
      if (win.isMaximized()) win.unmaximize(); else win.maximize();
      return { maximised: win.isMaximized() };
    },
    'ui.window.close': () => { window()?.close(); return { ok: true }; },
    'ui.window.focus': () => { focus(); return { ok: true }; },
    'ui.window.state': () => ({
      maximised: window()?.isMaximized() ?? false,
      fullscreen: window()?.isFullScreen() ?? false
    }),

    // ---------------------------------------------------------- app
    'ui.app.versions': () => ({
      ...dialogs.versions(),
      backend: backend.ready,
      dataRoot: backend.dataRoot
    }),
    'ui.app.relaunch': async () => {
      await beforeQuit({ forRestart: true });
      app.relaunch();
      quit();
      return { ok: true };
    },
    'ui.app.quit': () => { quit(); return { ok: true }; },
    'ui.app.restartBackend': async () => {
      await backend.restart();
      send('backend:state', { ready: true, restarted: true });
      return { ok: true, pid: backend.pid };
    },
    'ui.app.setBadge': ({ count = 0 }) => {
      if (process.platform === 'win32') {
        window()?.setOverlayIcon(null, count ? `${count} running` : '');
      }
      return { ok: true };
    }
  };
}

/**
 * Channels the renderer may invoke. `method` is the backend RPC name; when it
 * is missing, the main-process handler is used instead.
 */
const FORWARDED = [
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
];

export function install(context) {
  const { backend } = context;
  const local = mainHandlers(context);

  // Forwarded calls. The list is closed, so a channel the renderer invents is
  // rejected here rather than reaching the worker as an unknown method.
  for (const method of FORWARDED) {
    ipcMain.handle(`flora:${method}`, async (event, params) => {
      // Only the app's own window may call this.
      if (event.senderFrame?.url && !event.senderFrame.url.startsWith('flora://')) {
        throw new Error('Refused: unrecognised sender.');
      }
      return backend.call(method, params ?? {});
    });
  }

  for (const [channel, handler] of Object.entries(local)) {
    ipcMain.handle(`flora:${channel}`, async (event, params) => {
      if (event.senderFrame?.url && !event.senderFrame.url.startsWith('flora://')) {
        throw new Error('Refused: unrecognised sender.');
      }
      return handler(params ?? {});
    });
  }

  // The renderer announcing that its first paint has happened; the point at
  // which the window can be shown without a flash of unstyled content.
  ipcMain.on('flora:ui.ready', () => {
    const win = window();
    if (win && !win.isVisible() && !context.startMinimised) win.show();
  });
}

/**
 * Push a backend event to the renderer.
 *
 * Events already carry a flat, clonable payload from the worker; they are sent
 * on a single channel so the renderer has one listener rather than twenty.
 */
export function forwardEvent(name, payload) {
  send('backend:event', { event: name, payload });
}

export function forwardBackendState(state) {
  send('backend:state', state);
}
