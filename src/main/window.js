/**
 * Window management.
 *
 * Frameless, because the design calls for the app's own chrome: an overlay
 * navbar carrying the mark, the navigation and the window controls, drawn in
 * the app's own type and colours. `titleBarStyle: 'hidden'` plus the
 * `-webkit-app-region: drag` rules in layout.css is what makes that possible
 * without losing snap, resize or the system menu.
 *
 * Size and position are remembered in a small JSON file in the data directory.
 * They are deliberately not in the settings table: window geometry changes on
 * every drag, and writing that into the database on each move would fill the
 * WAL with noise.
 */
import { app, BrowserWindow, screen, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENTRY, ORIGIN } from './protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// `.mjs` because Electron only treats a preload as a module when the extension
// says so explicitly.
const PRELOAD = path.join(here, '..', 'preload', 'index.mjs');

const MIN_WIDTH = 940;
const MIN_HEIGHT = 620;
const DEFAULT = { width: 1240, height: 800 };

let stateFile = null;
let win = null;

export function configure({ dataRoot }) {
  stateFile = path.join(dataRoot, 'window.json');
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return {
      width: Number(raw.width) || DEFAULT.width,
      height: Number(raw.height) || DEFAULT.height,
      x: Number.isFinite(raw.x) ? raw.x : undefined,
      y: Number.isFinite(raw.y) ? raw.y : undefined,
      maximised: Boolean(raw.maximised)
    };
  } catch {
    return { ...DEFAULT, maximised: false };
  }
}

function saveState() {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.getNormalBounds();
    fs.writeFileSync(stateFile, JSON.stringify({
      ...bounds,
      maximised: win.isMaximized()
    }, null, 2));
  } catch { /* a window that cannot remember its size is not a failure */ }
}

/**
 * Keep a restored window on a screen that still exists.
 *
 * A laptop undocked from a second monitor would otherwise reopen off-screen,
 * which reads to the user as "the app did not start".
 */
function onScreen(state) {
  if (state.x == null || state.y == null) return true;
  return screen.getAllDisplays().some((display) => {
    const { x, y, width, height } = display.workArea;
    return state.x < x + width && state.x + 120 > x && state.y < y + height && state.y + 60 > y;
  });
}

export function create({ restoreBounds = true, startMinimised = false } = {}) {
  const state = restoreBounds ? loadState() : { ...DEFAULT, maximised: false };
  const usable = onScreen(state);

  win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: usable ? state.x : undefined,
    y: usable ? state.y : undefined,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    // The deepest surface in the palette. Painting the window this colour
    // before the renderer loads is what stops the frame appearing white for a
    // moment on a slow start.
    backgroundColor: '#11131c',
    // Frameless with the system controls hidden; the app draws its own.
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    // A visible flash of white before the stylesheet loads would undo the point
    // of a dark app, so the window is revealed only once the UI says it is
    // painted.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // The UI is entirely local; no remote content is ever loaded.
      webSecurity: true
    }
  });

  if (state.maximised) win.maximize();
  if (!startMinimised) {
    win.once('ready-to-show', () => win.show());
  }

  win.on('resize', saveState);
  win.on('move', saveState);
  win.on('maximize', saveState);
  win.on('unmaximize', saveState);

  win.on('maximize', () => win.webContents.send('window:state', { maximised: true }));
  win.on('unmaximize', () => win.webContents.send('window:state', { maximised: false }));

  win.on('enter-full-screen', () => win.webContents.send('window:state', { fullscreen: true }));
  win.on('leave-full-screen', () => win.webContents.send('window:state', { fullscreen: false }));

  // Nothing in the UI should ever navigate away, and nothing should open a new
  // window. Both would be a route out of the app's own origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN)) event.preventDefault();
  });

  win.webContents.on('did-fail-load', (event, code, description, url) => {
    // A failed load of the app's own entry point is not recoverable from here;
    // surface it rather than showing an empty window.
    if (url?.startsWith(ORIGIN)) {
      console.error(`[flora] renderer failed to load (${code} ${description})`);
    }
  });

  // Outside a packaged build the renderer's console is forwarded to this
  // terminal. Without it a renderer-side error is invisible: the window simply
  // renders less than it should and the terminal stays silent. `npm run dev`
  // additionally opens the inspector.
  if (!app.isPackaged) {
    win.webContents.on('console-message', (event) => {
      // Electron 32 and later report the level as a string, not an index.
      console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });
    win.webContents.on('render-process-gone', (event, details) => {
      console.error(`[flora] the renderer process exited: ${details.reason} (exit ${details.exitCode})`);
    });
    win.webContents.on('preload-error', (event, preloadPath, error) => {
      console.error(`[flora] the preload failed: ${preloadPath}\n${error?.stack ?? error}`);
    });
  }

  if (process.argv.includes('--dev') && !app.isPackaged) {
    // Docked rather than detached: a detached inspector is a second top-level
    // window, which is one more thing to go wrong on a machine whose GPU stack
    // is unhappy, and it covers the app it is meant to be inspecting.
    win.webContents.openDevTools();
  }

  win.on('closed', () => { win = null; });

  win.loadURL(ENTRY);
  return win;
}

export const window = () => win;

/** Send to the renderer if it is still there. */
export function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

export function focus() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function save() {
  saveState();
}
