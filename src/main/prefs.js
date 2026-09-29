/**
 * Main-process preferences.
 *
 * A mirror of a handful of settings that the main process needs *synchronously*
 * and *before the backend exists*: whether to restore the window bounds, whether
 * to start minimised, whether closing means quitting.
 *
 * Those decisions happen at moments where an async IPC round-trip is useless -
 * during `whenReady`, and inside a `close` handler that has to call
 * `preventDefault()` on the same tick. So the values are cached in a small JSON
 * file that the backend's settings events keep up to date.
 *
 * This is a cache, never the source of truth. If it is deleted or stale, the
 * defaults below are used and the real values arrive with the first settings
 * event.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  'general.restoreWindow': true,
  'general.startMinimised': false,
  'general.confirmQuit': true,
  'general.tray': false,
  'general.closeToTray': false,
  'general.ownerName': ''
};

/** The keys mirrored out of the settings table. */
const MIRRORED = Object.keys(DEFAULTS);

let file = null;
let values = { ...DEFAULTS };

export function configure({ dataRoot }) {
  file = path.join(dataRoot, 'prefs.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of MIRRORED) {
      if (key in raw) values[key] = raw[key];
    }
  } catch {
    // Missing or unreadable: defaults stand, and the first settings event
    // overwrites the file with the real values.
  }
}

export function get(key, fallback = undefined) {
  if (key in values) return values[key];
  return fallback === undefined ? DEFAULTS[key] : fallback;
}

export function all() {
  return { ...values };
}

/**
 * Update from a settings event.
 *
 * Only mirrored keys are written, so a settings payload can be passed straight
 * through without the file accumulating a copy of everything.
 */
export function apply(settings) {
  let changed = false;
  for (const key of MIRRORED) {
    if (!(key in settings)) continue;
    const next = settings[key];
    if (values[key] === next) continue;
    values[key] = next;
    changed = true;
  }
  if (!changed) return false;

  try {
    fs.writeFileSync(file, JSON.stringify(values, null, 2));
  } catch { /* a preference that cannot be written is not worth failing over */ }
  return true;
}

export { MIRRORED, DEFAULTS };
