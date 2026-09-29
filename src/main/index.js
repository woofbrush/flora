/**
 * flora - application entry point.
 *
 * Order of operations, and why:
 *
 *   1. The single-instance lock, before anything else. A second copy opening the
 *      same SQLite file is the one startup mistake that can actually corrupt
 *      something.
 *   2. The custom scheme, which must be registered before `whenReady`.
 *   3. The backend worker, so the first screen has data by the time it asks.
 *   4. The window.
 *
 * Closing the window quits the app by default. Bots are a background job, so
 * `general.closeToTray` exists for people who want the opposite, but the default
 * has to be the one that cannot surprise someone by leaving twenty Minecraft
 * connections open behind a closed window.
 */
import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { registerScheme, install as installProtocol } from './protocol.js';
import * as avatars from './avatars.js';
import { Backend } from './backend.js';
import * as win from './window.js';
import * as ipc from './ipc.js';
import * as tray from './tray.js';
import * as menu from './menu.js';
import * as prefs from './prefs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', '..');

app.setName('flora');

// Taken before anything touches the data directory.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

registerScheme();

/** Where everything the user owns lives. */
function resolveDataRoot() {
  if (process.env.FLORA_DATA_DIR) return process.env.FLORA_DATA_DIR;

  // A `flora-data` folder beside the executable turns the portable build into a
  // genuinely portable one: accounts travel with the .exe.
  if (app.isPackaged) {
    const beside = path.join(path.dirname(app.getPath('exe')), 'flora-data');
    if (fs.existsSync(beside)) return beside;
  }

  return path.join(app.getPath('userData'), 'data');
}

const DATA_ROOT = resolveDataRoot();

prefs.configure({ dataRoot: DATA_ROOT });

const backend = new Backend({ dataRoot: DATA_ROOT, version: app.getVersion() });

/** Set once a quit is under way, so nothing asks twice. */
let quitting = false;

async function beforeQuit() {
  quitting = true;
  win.save();
  await backend.stop();
}

function quit() {
  quitting = true;
  app.quit();
}

// ---------------------------------------------------------------- lifecycle

app.on('second-instance', () => {
  // A second launch is a request to see the window, not to start a second app.
  win.focus();
});

app.on('window-all-closed', () => {
  if (!tray.isActive() || !prefs.get('general.closeToTray')) quit();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  // preventDefault has to land on this tick, so the async teardown happens
  // after it rather than before.
  event.preventDefault();
  beforeQuit().finally(() => app.quit());
});

app.on('activate', () => {
  if (!win.window()) createWindow();
  else win.focus();
});

// ---------------------------------------------------------------- window

/**
 * Closing is the one place with real consequences: bots die with the process,
 * so a user who closes the window out of habit should be told what that costs
 * when there is something to lose.
 */
function onWindowClose(event, window) {
  if (quitting) return;

  // Synchronous, on this tick - the whole reason prefs is a file and not IPC.
  event.preventDefault();

  if (prefs.get('general.closeToTray') && tray.isActive()) {
    window.hide();
    return;
  }

  (async () => {
    const bots = await runningBots();

    if (bots > 0 && prefs.get('general.confirmQuit')) {
      const buttons = ['Quit and disconnect', 'Keep running'];
      if (tray.isActive()) buttons.push('Minimise to tray');

      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Quit flora?',
        message: `${bots} bot${bots === 1 ? '' : 's'} still running.`,
        detail: 'Closing flora disconnects every bot.',
        buttons,
        defaultId: 1,
        cancelId: 1,
        noLink: true
      });

      if (tray.isActive() && response === 2) { window.hide(); return; }
      if (response !== 0) return;
    }

    quitting = true;
    await beforeQuit();
    window.destroy();
    app.quit();
  })().catch(() => {
    // A failure while quitting must not leave the window unclosable.
    quitting = true;
    window.destroy();
    app.quit();
  });
}

async function runningBots() {
  try {
    const list = await backend.call('bots.list');
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
}

function createWindow() {
  const created = win.create({
    restoreBounds: prefs.get('general.restoreWindow'),
    startMinimised: prefs.get('general.startMinimised')
  });

  created.on('close', (event) => onWindowClose(event, created));
  return created;
}

// ---------------------------------------------------------------- tray

let lastBotStatus = { online: 0, total: 0 };

/**
 * The tray label is the only main-process view of bot state, and it is only
 * needed when a tray exists. Recomputing it from the backend costs one cheap
 * call per state change, which is a far better trade than mirroring the whole
 * bot map here.
 */
async function refreshTray() {
  if (!tray.isActive()) return;
  try {
    const list = await backend.call('bots.list');
    lastBotStatus = {
      online: list.filter((b) => b.status === 'online').length,
      total: list.length
    };
  } catch {
    lastBotStatus = { online: 0, total: 0 };
  }
  tray.refresh();
}

function ensureTray() {
  if (prefs.get('general.tray')) {
    if (tray.create({ onQuit: quit })) {
      tray.setStatusProvider(() => lastBotStatus);
      refreshTray();
    }
  } else {
    tray.destroy();
  }
}

// ---------------------------------------------------------------- startup

async function start() {
  installProtocol({
    rendererRoot: path.join(ROOT, 'src', 'renderer'),
    skinRoot: path.join(DATA_ROOT, 'skins')
  });

  // Sits beside the skin cache and is read by the protocol handler above, so it
  // is the main process that owns it rather than the backend.
  avatars.configure(path.join(DATA_ROOT, 'heads'));

  win.configure({ dataRoot: DATA_ROOT });

  ipc.install({
    backend,
    quit,
    beforeQuit,
    startMinimised: prefs.get('general.startMinimised')
  });

  backend.on('event', (name, payload) => {
    ipc.forwardEvent(name, payload);

    if (name === 'app:settings-changed') {
      // Keep the synchronous mirror current, and react to the two settings that
      // change the main process's own behaviour.
      if (prefs.apply(payload ?? {})) ensureTray();
    }

    if (name === 'bots:state') {
      refreshTray();
      ipc.forwardBackendState({ ready: true, bots: lastBotStatus });
    }
  });

  backend.on('exit', ({ code, wasReady }) => {
    ipc.forwardBackendState({ ready: false, code });
    if (wasReady && !quitting) {
      // A worker that dies mid-session leaves the UI showing stale data and
      // failing every action, so it is worth interrupting for.
      dialog.showMessageBox({
        type: 'error',
        title: 'flora background service stopped',
        message: 'The background service stopped unexpectedly.',
        detail: `Exit code ${code}. Reopen flora to start it again. Your accounts and settings are safe.`,
        buttons: ['Close']
      }).catch(() => {});
    }
  });

  menu.install({ onQuit: quit });

  // The backend starts before the window, so the first render has real data.
  try {
    await backend.start();
    // Seed the mirror from the real settings before anything reads it.
    prefs.apply(await backend.call('app.settings.all'));
  } catch (err) {
    dialog.showErrorBox(
      'flora could not start',
      `${err.message}\n\nData folder:\n${DATA_ROOT}`
    );
    app.exit(1);
    return;
  }

  ensureTray();
  createWindow();

  ipc.forwardBackendState({ ready: true, pid: backend.pid, dataRoot: DATA_ROOT });
}

app.whenReady().then(start);

// A crash in the main process should not leave twenty sockets open.
process.on('uncaughtException', async (err) => {
  console.error('[flora] uncaught exception:', err);
  try { await backend.stop({ timeoutMs: 2000 }); } catch { /* going down anyway */ }
  dialog.showErrorBox('flora hit an unexpected error', String(err?.stack ?? err));
  app.exit(1);
});
