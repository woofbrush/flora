/**
 * Application menu.
 *
 * The window is frameless and the menu bar is hidden, but the menu still has to
 * exist: on Windows it is what supplies the accelerators, and Electron will not
 * register a shortcut without one. So this is a menu for its keyboard bindings
 * rather than for its items.
 *
 * Two entries are honest exceptions - About and the Discord link - and both are
 * reachable from the UI as well.
 */
import { Menu, app, shell } from 'electron';
import { window, focus } from './window.js';
// The renderer's own address book, not a second copy of it. The main process
// may import from the renderer tree; the renderer may not import from here,
// which is why the file is over there. See its header.
import { LINKS } from '../renderer/js/links.js';

export { LINKS };

const isDev = () => process.argv.includes('--dev') || !app.isPackaged;

/** Tell the renderer to do something only it can do. */
function toRenderer(channel, payload) {
  focus();
  window()?.webContents.send(channel, payload);
}

export function build({ onQuit, onCheckUpdates = null }) {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Import accounts…', accelerator: 'CmdOrCtrl+I', click: () => toRenderer('app:action', 'import') },
        { label: 'Export accounts…', accelerator: 'CmdOrCtrl+E', click: () => toRenderer('app:action', 'export') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => toRenderer('app:navigate', 'settings') },
        { type: 'separator' },
        {
          label: 'Back up data now',
          click: () => toRenderer('app:action', 'snapshot')
        },
        { type: 'separator' },
        { label: 'Quit flora', accelerator: 'CmdOrCtrl+Q', click: () => onQuit() }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command palette', accelerator: 'CmdOrCtrl+K', click: () => toRenderer('app:action', 'palette') },
        { label: 'Search accounts', accelerator: 'CmdOrCtrl+F', click: () => toRenderer('app:action', 'search') },
        { type: 'separator' },
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => toRenderer('app:navigate', 'dashboard') },
        { label: 'Accounts', accelerator: 'CmdOrCtrl+2', click: () => toRenderer('app:navigate', 'accounts') },
        { label: 'Bots', accelerator: 'CmdOrCtrl+3', click: () => toRenderer('app:navigate', 'bots') },
        { label: 'Proxies', accelerator: 'CmdOrCtrl+4', click: () => toRenderer('app:navigate', 'proxies') },
        { label: 'Activity', accelerator: 'CmdOrCtrl+5', click: () => toRenderer('app:navigate', 'activity') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev()
          ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }]
          : [])
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Import formats', click: () => toRenderer('app:action', 'import-help') },
        { type: 'separator' },
        { label: 'Woofbrush Design', click: () => shell.openExternal(LINKS.website) },
        { label: 'Discord community', click: () => shell.openExternal(LINKS.discord) },
        ...(onCheckUpdates ? [{ label: 'Check for updates', click: onCheckUpdates }] : []),
        { type: 'separator' },
        { label: `About flora ${app.getVersion()}`, click: () => toRenderer('app:action', 'about') }
      ]
    }
  ];

  return Menu.buildFromTemplate(template);
}

export function install(options) {
  Menu.setApplicationMenu(build(options));
}
