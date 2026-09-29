/**
 * Tray icon.
 *
 * Optional, and off until the user turns it on. A bot panel that keeps running
 * in the background is exactly the kind of app people want living in the tray,
 * but an icon that appears uninvited is the kind of thing they uninstall over.
 *
 * The tray is also the only way back to a window that was closed to the tray
 * rather than quit, so that behaviour and the tray are decided together in
 * index.js.
 */
import { Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { focus, window } from './window.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ICON = path.join(here, '..', '..', 'build', 'tray.png');

let tray = null;
let statusProvider = () => ({ online: 0, total: 0 });
let quitHandler = () => {};

function navigate(view) {
  focus();
  window()?.webContents.send('app:navigate', view);
}

/**
 * Rebuild the menu.
 *
 * Electron cannot change a menu item's label in place, so the whole template is
 * rebuilt. That is cheap, and it happens on bot start/stop rather than on a
 * timer.
 */
export function refresh() {
  if (!tray) return;

  const { online = 0, total = 0 } = statusProvider() ?? {};
  tray.setToolTip(total ? `flora - ${online} of ${total} bots online` : 'flora');

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: total ? `${online} of ${total} bots online` : 'No bots running', enabled: false },
    { type: 'separator' },
    { label: 'Open flora', click: () => focus() },
    { label: 'Accounts', click: () => navigate('accounts') },
    { label: 'Bots', click: () => navigate('bots') },
    { label: 'Proxies', click: () => navigate('proxies') },
    { type: 'separator' },
    { label: 'Settings', click: () => navigate('settings') },
    { label: 'Quit flora', click: () => quitHandler() }
  ]));
}

export function isActive() {
  return tray !== null;
}

/**
 * Create the tray. Returns false when the icon asset is missing, which is not
 * worth failing over - the app simply runs without one.
 */
export function create({ onQuit, status } = {}) {
  if (tray) return true;
  if (onQuit) quitHandler = onQuit;
  if (status) statusProvider = status;

  const image = nativeImage.createFromPath(ICON);
  if (image.isEmpty()) return false;

  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', () => focus());

  refresh();
  return true;
}

export function setStatusProvider(fn) {
  statusProvider = fn;
  refresh();
}

export function destroy() {
  if (!tray) return;
  tray.destroy();
  tray = null;
}
