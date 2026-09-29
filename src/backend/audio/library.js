/**
 * The audio library.
 *
 * Tracks a bot can play through voice chat, kept as ordinary files in the data
 * root. There is no database table behind this and no index file: the folder is
 * the library, and the listing is a directory read. A cache of what is in a
 * folder is a cache that goes wrong the moment someone drags a file in with
 * Explorer, and the folder is small enough that reading it is free.
 *
 * Files arrive as bytes from the renderer rather than being copied by the main
 * process, because the main process owns dialogs and this module owns the data
 * root - keeping the write on this side means one place knows the layout, and
 * one place validates the name. The name is the only user-supplied string that
 * reaches the filesystem here, so it is rebuilt from scratch rather than
 * trusted: nothing that survives sanitising can contain a separator, a drive
 * letter or a `..`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { addonDataDir } from '../paths.js';

/** Extensions the renderer's decoder can be expected to open. */
const ALLOWED = new Set(['ogg', 'oga', 'mp3', 'wav', 'm4a', 'flac']);

/** Per-file cap, matching the picker's. */
const MAX_BYTES = 64 * 1024 * 1024;

const libraryDir = () => path.join(addonDataDir(), 'voice-chat', 'audio');

function ensureDir() {
  const dir = libraryDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Reduce a filename to something safe to join onto a directory.
 *
 * Deliberately lossy: `path.basename` first, so separators are gone, then
 * everything outside a conservative alphabet is replaced. The extension is
 * lowercased and checked against the allowed set, and the stem is capped so a
 * 300-character name cannot push the path past a filesystem limit. Two files
 * whose names differ only in punctuation collapse onto the same name, which is
 * the right way round - the second one replaces the first rather than both
 * being kept under names nobody can tell apart.
 */
function safeName(raw) {
  const base = path.basename(String(raw ?? '')).replace(/\\/g, '/');
  const dot = base.lastIndexOf('.');
  const ext = dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
  const stem = (dot === -1 ? base : base.slice(0, dot))
    .replace(/[^A-Za-z0-9 _().-]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 96);

  if (!stem) throw new Error('That file has no usable name.');
  if (!ALLOWED.has(ext)) {
    throw new Error(`flora cannot play .${ext || 'that'}. Try ogg, mp3, wav, m4a or flac.`);
  }
  return `${stem}.${ext}`;
}

/** Every track in the library, newest last, with its size. */
export function list() {
  const dir = ensureDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  return names
    .filter((name) => ALLOWED.has(name.slice(name.lastIndexOf('.') + 1).toLowerCase()))
    .map((name) => {
      let size = 0;
      let addedAt = null;
      try {
        const stat = fs.statSync(path.join(dir, name));
        size = stat.size;
        addedAt = stat.mtimeMs;
      } catch { /* vanished between the read and the stat */ }
      return { name, size, addedAt };
    })
    .filter((entry) => entry.size > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Add files handed over by the renderer.
 *
 * One bad file does not fail the batch: a person who selected five tracks and
 * had one of them rejected wants the other four, and a sentence saying which
 * one was refused. So the result is a list of what happened per file rather
 * than a single outcome.
 */
export function add(files = []) {
  const dir = ensureDir();
  const results = [];

  for (const file of files) {
    try {
      const name = safeName(file?.name);
      const bytes = Buffer.from(String(file?.bytes ?? ''), 'base64');
      if (!bytes.length) throw new Error('That file is empty.');
      if (bytes.length > MAX_BYTES) {
        throw new Error(`That file is ${(bytes.length / 1048576).toFixed(1)} MB. The limit is 64 MB.`);
      }
      fs.writeFileSync(path.join(dir, name), bytes);
      results.push({ name, added: true });
    } catch (err) {
      results.push({ name: String(file?.name ?? 'that file'), added: false, error: err.message });
    }
  }

  return { results, tracks: list() };
}

export function remove(name) {
  const safe = safeName(name);
  const file = path.join(ensureDir(), safe);
  if (!fs.existsSync(file)) throw new Error(`There is no track called "${safe}".`);
  fs.rmSync(file, { force: true });
  return { removed: safe, tracks: list() };
}

/**
 * Hand one track back to the renderer as bytes.
 *
 * This is the path the audio pipeline starts on: the renderer asks for the
 * file, decodes it with the browser's own decoder, resamples it, and encodes it
 * to Opus. Nothing on this side ever needs to understand the audio itself,
 * which is what keeps ffmpeg out of the installer.
 */
export function read(name) {
  const safe = safeName(name);
  const file = path.join(ensureDir(), safe);
  if (!fs.existsSync(file)) throw new Error(`There is no track called "${safe}".`);
  return { name: safe, bytes: fs.readFileSync(file).toString('base64') };
}

/** Total size on disk, for the Settings pane. */
export function stats() {
  const tracks = list();
  return { count: tracks.length, bytes: tracks.reduce((sum, track) => sum + track.size, 0) };
}
