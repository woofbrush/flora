/**
 * The icon set.
 *
 * Two lists have to agree and nothing at runtime says so when they do not.
 * `hydrate()` fetches `assets/icons/<name>.svg` and, when that fails, leaves the
 * element empty and moves on - the right call for a missing decoration, and a
 * silent failure everywhere else. A name that is not in `NAMES` is the same
 * shape of bug from the other end: it works, but the picker in Settings cannot
 * offer it and nothing notices.
 *
 * So this reads `NAMES` from the module itself rather than scraping the source
 * (an icon added to the array is the thing being tested, so the array is what to
 * read) and then walks the renderer for every icon named in a literal, which is
 * where a typo actually lands.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const ICONS = path.join(RENDERER, 'assets', 'icons');

const { NAMES } = await import('../src/renderer/js/icons.js');

const files = fs.readdirSync(ICONS).filter((name) => name.endsWith('.svg'));
const onDisk = new Set(files.map((name) => name.slice(0, -4)));

/** Every `.js`, `.mjs` and `.html` under the renderer, as source text. */
function sources(dir = RENDERER) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(js|mjs|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('every listed icon has a file behind it', () => {
  const missing = NAMES.filter((name) => !onDisk.has(name));
  assert.deepEqual(missing, [], `listed in NAMES with no assets/icons/<name>.svg: ${missing.join(', ')}`);
});

test('NAMES holds no duplicates', () => {
  const seen = new Set();
  const repeated = NAMES.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
  assert.deepEqual(repeated, [], `listed twice: ${repeated.join(', ')}`);
});

test('every icon named in the renderer is one the set knows about', () => {
  const unknown = new Map();

  for (const file of sources()) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    const isMarkup = file.endsWith('.html');

    // `icon('name'`, `mark('name'` - the string-literal form. A call passing a
    // variable is not checked here, because what it holds is not in this file.
    for (const match of isMarkup ? [] : text.matchAll(/\b(?:icon|mark)\(\s*'([^']+)'/g)) {
      if (!NAMES.includes(match[1])) unknown.set(match[1], rel);
    }
    // The attribute form, which is how the shell writes the icons that have to
    // be in the document before any script runs. Only in markup: the same text
    // appears in a comment in icons.js, where it is prose rather than a name.
    for (const match of isMarkup ? text.matchAll(/data-icon="([^"]+)"/g) : []) {
      if (!NAMES.includes(match[1])) unknown.set(match[1], rel);
    }
  }

  const report = [...unknown].map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(report, [], `named but not in NAMES: ${report.join(', ')}`);
});

test('the illustrations the setup flow asks for are in the set', async () => {
  // The step list is a plain array of `art: '<name>'` entries, and it is the one
  // place a whole screen is named by a string that nothing else validates: a
  // setup step with a missing illustration renders a blank half of the window.
  const source = fs.readFileSync(path.join(RENDERER, 'js', 'views', 'onboarding.js'), 'utf8');
  const art = [...source.matchAll(/art:\s*'([^']+)'/g)].map((match) => match[1]);

  assert.ok(art.length >= 5, 'the setup flow should still declare an illustration per step');
  for (const name of art) {
    assert.ok(NAMES.includes(name), `${name} is used by a setup step but is not in NAMES`);
    assert.ok(onDisk.has(name), `${name} is used by a setup step but has no file`);
  }
});

test('every icon file on disk is either listed or a known extra', () => {
  // `icon-logo.svg` is the artwork `scripts/make-icons.js` rasterises for the
  // installer, not a UI icon, so it is deliberately absent from NAMES.
  const extra = [...onDisk].filter((name) => !NAMES.includes(name) && name !== 'icon-logo');
  assert.deepEqual(extra, [], `no entry in NAMES for: ${extra.join(', ')}`);
});
