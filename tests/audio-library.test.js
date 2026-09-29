/**
 * The voice chat audio library.
 *
 * The only user-supplied string that reaches the filesystem in flora is the name
 * of a track, and the only thing standing between that string and `path.join` is
 * `safeName`. So most of this file is about the names rather than the audio: a
 * library that can be walked out of is worse than one that refuses a file.
 *
 * The directory is redirected before `paths.js` is imported, because that module
 * reads FLORA_DATA_DIR once at load.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flora-audio-'));
process.env.FLORA_DATA_DIR = dataDir;

const paths = await import('../src/backend/paths.js');
paths.setDataRoot(dataDir);

const audio = await import('../src/backend/audio/library.js');

const libraryDir = () => path.join(paths.addonDataDir(), 'voice-chat', 'audio');
const file = (name) => path.join(libraryDir(), name);

test.after(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows lock */ }
});

/** A track as the renderer sends it: a name and base64 bytes. */
const track = (name, bytes = 'AAAA') => ({ name, bytes: Buffer.from(bytes).toString('base64') });

function clear() {
  fs.rmSync(libraryDir(), { recursive: true, force: true });
}

// ------------------------------------------------------------------ round trip

test('a track goes in, comes back in the listing, and can be removed', () => {
  clear();

  const added = audio.add([track('intro.ogg')]);
  assert.deepEqual(added.results, [{ name: 'intro.ogg', added: true }]);
  assert.deepEqual(added.tracks.map((entry) => entry.name), ['intro.ogg']);
  assert.ok(added.tracks[0].size > 0);

  assert.ok(fs.existsSync(file('intro.ogg')));

  const read = audio.read('intro.ogg');
  assert.equal(read.name, 'intro.ogg');
  assert.deepEqual(Buffer.from(read.bytes, 'base64').toString(), 'AAAA');

  assert.equal(audio.remove('intro.ogg').removed, 'intro.ogg');
  assert.deepEqual(audio.list(), []);
});

test('the library is the folder, so a file deleted by hand stops being listed', () => {
  clear();
  audio.add([track('one.ogg'), track('two.mp3')]);
  assert.equal(audio.list().length, 2);

  // This is the whole reason there is no index file: what is on disk is what
  // the bots can play, and nothing has to be kept in step with it.
  fs.rmSync(file('two.mp3'));
  assert.deepEqual(audio.list().map((entry) => entry.name), ['one.ogg']);
});

test('one bad file does not cost the caller the good ones beside it', () => {
  clear();

  const result = audio.add([track('good.ogg'), track('notes.txt'), track('empty.wav', '')]);

  assert.deepEqual(result.results, [
    { name: 'good.ogg', added: true },
    { name: 'notes.txt', added: false, error: 'flora cannot play .txt. Try ogg, mp3, wav, m4a or flac.' },
    { name: 'empty.wav', added: false, error: 'That file is empty.' }
  ]);
  assert.deepEqual(result.tracks.map((entry) => entry.name), ['good.ogg']);
});

test('stats count what is there', () => {
  clear();
  assert.deepEqual(audio.stats(), { count: 0, bytes: 0 });

  audio.add([track('a.ogg', 'x'.repeat(10)), track('b.ogg', 'x'.repeat(20))]);
  assert.deepEqual(audio.stats(), { count: 2, bytes: 30 });
});

// ------------------------------------------------------------------ names

test('a name that tries to climb out of the folder is flattened, not followed', () => {
  clear();

  const { results, tracks } = audio.add([
    track('../../../secret.key.ogg'),
    track('..\\..\\evil.ogg'),
    track('/etc/passwd.ogg'),
    track('C:drive.ogg')
  ]);

  assert.ok(results.every((entry) => entry.added), 'each one is stored, under a name of flora choosing');
  // Nothing landed outside the library, and nothing above it was touched.
  assert.ok(!fs.existsSync(path.join(dataDir, 'secret.key.ogg')));
  assert.ok(!fs.existsSync(path.join(paths.addonDataDir(), 'evil.ogg')));
  for (const entry of tracks) {
    assert.equal(path.dirname(file(entry.name)), libraryDir());
    assert.ok(!entry.name.includes('/') && !entry.name.includes('\\'), entry.name);
    assert.ok(!entry.name.startsWith('.'), entry.name);
  }
});

test('a name is reduced to something a filesystem will take', () => {
  clear();

  const { tracks } = audio.add([
    track('my song (live).mp3'),
    track('émoji \u{1F3B5}.ogg'),
    track(`${'long'.repeat(60)}.wav`)
  ]);

  const names = tracks.map((entry) => entry.name);
  // Spaces and parentheses survive: they are what people actually name their
  // files, and they mean nothing to a path.
  assert.ok(names.includes('my song (live).mp3'), names.join(', '));
  // Everything else is replaced rather than dropped - a bracket becomes an
  // underscore - so two different files do not silently become one.
  assert.ok(names.every((name) => /^[A-Za-z0-9 _().-]+\.(ogg|mp3|wav|m4a|flac)$/.test(name)), names.join(', '));
  // The stem is capped, so a pathologically long name cannot blow a path limit.
  assert.ok(names.every((name) => name.length <= 101), names.join(', '));
});

test('an extension flora cannot play is refused with the reason', () => {
  clear();

  const result = audio.add([track('track.aiff')]);
  assert.equal(result.results[0].added, false);
  assert.match(result.results[0].error, /cannot play/);
  assert.deepEqual(audio.list(), []);
});

test('a name with nothing usable left in it is refused', () => {
  clear();
  assert.equal(audio.add([track('...ogg')]).results[0].added, false);
  assert.equal(audio.add([track('.ogg')]).results[0].added, false);
  assert.equal(audio.add([track('')]).results[0].added, false);
});

test('reading or removing a track that is not there says so', () => {
  clear();
  assert.throws(() => audio.read('ghost.ogg'), /no track called/i);
  assert.throws(() => audio.remove('ghost.ogg'), /no track called/i);
});

test('reading a track cannot be pointed at a file outside the library', () => {
  clear();

  // A file one level up from the library is the thing worth protecting. It has
  // a playable extension on purpose, so nothing but the name handling is being
  // tested here.
  fs.mkdirSync(paths.addonDataDir(), { recursive: true });
  fs.writeFileSync(path.join(paths.addonDataDir(), 'secret.ogg'), 'do not read me');

  // The climb is flattened into an ordinary name, which then simply misses -
  // so the miss is the proof that it did not escape.
  assert.throws(() => audio.read('../secret.ogg'), /no track called/i);
  assert.throws(() => audio.read(path.join(paths.addonDataDir(), 'secret.ogg')), /no track called/i);
  // An extension flora cannot play is refused before anything is opened.
  assert.throws(() => audio.read('../secret.key'), /cannot play/i);
});
