/**
 * Native dialogs and shell integration.
 *
 * Everything here needs a real user gesture on a real window, so it lives in
 * the main process. The backend never opens a dialog: it asks the renderer,
 * which asks here, and the result is handed back as plain bytes or text.
 *
 * File reads are size-capped. A user pointing the importer at a 4 GB log by
 * mistake should get an error, not a frozen app.
 */
import { dialog, shell, app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { window } from './window.js';

const MAX_TEXT_BYTES = 32 * 1024 * 1024;   // account lists are text; 32 MB is generous
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;   // a skin is under 20 KB
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;  // a track someone wants a bot to play

function parent() {
  const win = window();
  return win && !win.isDestroyed() ? win : null;
}

export async function openAccountsFile() {
  const result = await dialog.showOpenDialog(parent(), {
    title: 'Import accounts',
    buttonLabel: 'Import',
    properties: ['openFile'],
    filters: [
      { name: 'Account lists', extensions: ['txt', 'csv', 'list', 'log'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths.length) return { cancelled: true };

  const file = result.filePaths[0];
  const stat = await fs.stat(file);
  if (stat.size > MAX_TEXT_BYTES) {
    throw new Error(`That file is ${(stat.size / 1048576).toFixed(1)} MB. The limit is 32 MB.`);
  }

  // Read as UTF-8, but strip a BOM: a list exported from Notepad or Excel would
  // otherwise have its first token silently corrupted.
  const text = (await fs.readFile(file, 'utf8')).replace(/^﻿/, '');

  return { cancelled: false, name: path.basename(file), path: file, text };
}

/**
 * Pick an addon folder to install.
 *
 * A folder rather than a file, because an addon is two files and the manifest
 * is the one that names the other. Asking for the directory means the dialog
 * matches what the user made, instead of making them know which of their two
 * files flora wants pointed at.
 */
export async function openAddonFolder() {
  const result = await dialog.showOpenDialog(parent(), {
    title: 'Choose an addon folder',
    buttonLabel: 'Install',
    properties: ['openDirectory'],
    message: 'Pick the folder that has an addon.json in it.'
  });

  if (result.canceled || !result.filePaths.length) return { cancelled: true };
  const dir = result.filePaths[0];
  return { cancelled: false, path: dir, name: path.basename(dir) };
}

/**
 * Pick one or more audio files for the voice chat library.
 *
 * Read here and handed back as base64 rather than copied, because the backend
 * owns where the library lives and doing the copy in one place keeps the main
 * process out of the data root. The size cap is per file: a track is a few
 * megabytes, and something far larger is a mistake worth naming before the app
 * tries to hold it in memory.
 */
export async function openAudioFiles() {
  const result = await dialog.showOpenDialog(parent(), {
    title: 'Add audio',
    buttonLabel: 'Add',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: ['ogg', 'mp3', 'wav', 'oga', 'm4a', 'flac'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths.length) return { cancelled: true, files: [] };

  const files = [];
  for (const file of result.filePaths) {
    const stat = await fs.stat(file);
    if (stat.size > MAX_AUDIO_BYTES) {
      files.push({
        name: path.basename(file),
        error: `That file is ${(stat.size / 1048576).toFixed(1)} MB. The limit is 64 MB.`
      });
      continue;
    }
    files.push({
      name: path.basename(file),
      bytes: (await fs.readFile(file)).toString('base64')
    });
  }

  return { cancelled: false, files };
}

export async function openSkinFile() {
  const result = await dialog.showOpenDialog(parent(), {
    title: 'Choose a skin',
    buttonLabel: 'Use this skin',
    properties: ['openFile'],
    filters: [{ name: 'Minecraft skin', extensions: ['png'] }]
  });

  if (result.canceled || !result.filePaths.length) return { cancelled: true };

  const file = result.filePaths[0];
  const stat = await fs.stat(file);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error('That file is too large to be a Minecraft skin.');
  }

  const buffer = await fs.readFile(file);
  return {
    cancelled: false,
    name: path.basename(file),
    pngBase64: buffer.toString('base64')
  };
}

/**
 * Save text to a file the user picks.
 *
 * `defaultName` is sanitised of path separators so a username can be used in it
 * without escaping the chosen directory.
 */
export async function saveText({ contents, defaultName = 'flora.txt', title = 'Save' }) {
  const safeName = String(defaultName).replace(/[\\/:*?"<>|]/g, '_');

  const result = await dialog.showSaveDialog(parent(), {
    title,
    defaultPath: safeName,
    filters: [
      { name: 'Text', extensions: ['txt'] },
      { name: 'CSV', extensions: ['csv'] }
    ]
  });

  if (result.canceled || !result.filePath) return { cancelled: true };

  await fs.writeFile(result.filePath, contents, 'utf8');
  return { cancelled: false, path: result.filePath, name: path.basename(result.filePath) };
}

export async function saveImage({ base64, defaultName = 'skin.png' }) {
  const safeName = String(defaultName).replace(/[\\/:*?"<>|]/g, '_');

  const result = await dialog.showSaveDialog(parent(), {
    title: 'Save skin',
    defaultPath: safeName,
    filters: [{ name: 'PNG image', extensions: ['png'] }]
  });

  if (result.canceled || !result.filePath) return { cancelled: true };

  await fs.writeFile(result.filePath, Buffer.from(base64, 'base64'));
  return { cancelled: false, path: result.filePath };
}

/** Confirmation used for destructive actions the settings say to confirm. */
export async function confirm({ title, message, detail = '', confirmLabel = 'Confirm', danger = false }) {
  const result = await dialog.showMessageBox(parent(), {
    type: danger ? 'warning' : 'question',
    title,
    message,
    detail,
    buttons: [confirmLabel, 'Cancel'],
    defaultId: danger ? 1 : 0,
    cancelId: 1,
    noLink: true
  });
  return result.response === 0;
}

/**
 * Open an external link.
 *
 * Restricted to https. A link is the one place the app hands control to
 * something outside itself, so it must not be able to launch a local handler
 * or a custom scheme.
 */
export async function openExternal(url) {
  const value = String(url ?? '');
  if (!/^https:\/\//i.test(value)) {
    throw new Error('flora only opens https links.');
  }
  await shell.openExternal(value);
  return { opened: value };
}

export async function revealPath(target) {
  const value = String(target ?? '');
  if (!value) throw new Error('No path given.');
  shell.showItemInFolder(value);
  return { ok: true };
}

export async function openPath(target) {
  const value = String(target ?? '');
  if (!value) throw new Error('No path given.');
  const error = await shell.openPath(value);
  if (error) throw new Error(error);
  return { ok: true };
}

export function versions() {
  return {
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch
  };
}
