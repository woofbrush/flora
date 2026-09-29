/**
 * The addon registry.
 *
 * Addons are the one part of flora that runs code nobody at flora wrote, so the
 * tests here are mostly about the walls rather than the happy path: an addon
 * that cannot be loaded must not take the app with it, an addon that cannot be
 * trusted with a path must not get one, and the switches that turn addons off
 * must actually stop them rather than only relabel them.
 *
 * The database is redirected to a throwaway directory before anything imports
 * `paths.js`, which reads FLORA_DATA_DIR once at module load - hence the dynamic
 * imports below rather than static ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flora-addons-'));
process.env.FLORA_DATA_DIR = dataDir;

const paths = await import('../src/backend/paths.js');
paths.setDataRoot(dataDir);

const { db, closeDb } = await import('../src/backend/db/index.js');
db();

const { addonsDir, addonDataDir } = paths;
const addons = await import('../src/backend/addons/registry.js');
const { updateSettings } = await import('../src/backend/settings.js');
// Imported for its side effect as much as its exports: loading it is what tells
// the registry which command names the built-ins already own.
const { commandHelp } = await import('../src/backend/bots/commands.js');

test.after(() => {
  try { closeDb(); } catch { /* already closed */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows lock */ }
});

// ------------------------------------------------------------------ helpers

/** Write an addon folder, the way a user would drop one in. */
function writeAddon(id, { manifest = {}, source = '' } = {}) {
  const dir = path.join(addonsDir(), id);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'addon.json'), JSON.stringify({
    id,
    name: id,
    version: '1.0.0',
    description: `${id} for the tests`,
    main: 'index.js',
    ...manifest
  }, null, 2));

  fs.writeFileSync(path.join(dir, 'index.js'), source);
  return dir;
}

/**
 * Put the registry back to a known state with only the bundled addon present.
 *
 * The on/off file is emptied too. It is keyed by id, so a stale entry would
 * only ever be read by a test that recreated the same id - which several do.
 */
function onlyBuiltins() {
  for (const name of fs.readdirSync(addonsDir())) {
    fs.rmSync(path.join(addonsDir(), name), { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(addonDataDir(), '_state.json'), '{}');
  updateSettings({ 'addons.enabled': true, 'addons.allowChatCommands': true });
  return addons.reload();
}

/**
 * A folder that was dropped in by hand arrives switched off - nothing runs
 * until someone says so. `install()` is the path that turns one on, so the
 * tests that are about loading have to do it explicitly.
 */
const turnOn = (id) => addons.setEnabled(id, true);

const find = (id) => addons.list().find((entry) => entry.id === id);
const addonNames = () => commandHelp('.').filter((entry) => entry.addon).map((entry) => entry.name);

// ------------------------------------------------------------------ loading

test('the bundled addon loads and its commands join the help list', () => {
  onlyBuiltins();

  const essentials = find('essentials');
  assert.ok(essentials, 'essentials should be discovered');
  assert.equal(essentials.builtin, true);
  assert.equal(essentials.enabled, true);
  assert.equal(essentials.loaded, true);
  assert.equal(essentials.error, null);

  const names = commandHelp('.').map((entry) => entry.name);
  for (const name of ['where', 'who', 'clock', 'ping']) {
    assert.ok(names.includes(name), `${name} should be in the help list`);
  }
});

test('every bundled addon loads, not just the one with commands', () => {
  onlyBuiltins();

  const bundled = addons.list().filter((entry) => entry.builtin);
  assert.ok(bundled.length >= 3, 'the bundled set should have grown past essentials');

  // A built-in that fails to load is a broken row in the Addons pane on a fresh
  // install, which is the worst place to find one. This catches a missing file,
  // a typo in the manifest's `main`, or a throw at the top of the script.
  for (const entry of bundled) {
    assert.equal(entry.error, null, `${entry.id} failed to load: ${entry.error}`);
    assert.equal(entry.loaded, true, `${entry.id} should be running by default`);
  }
});

test('an addon command is attributed to the addon that registered it', () => {
  const entry = commandHelp('.').find((item) => item.name === 'where');
  // The addon's display name, not its id: this is what the help listing shows.
  assert.equal(entry.addon, 'Essentials');
});

test('a user addon registers a command the same way the bundled one does', () => {
  onlyBuiltins();
  writeAddon('dancer', {
    manifest: { name: 'Dancer' },
    source: `
      flora.commands.register({
        name: 'dance',
        usage: 'dance',
        summary: 'Dance',
        run(bot, args, ctx) { bot.whisper(ctx.username, 'dancing'); }
      });
    `
  });

  addons.reload();
  assert.equal(find('dancer').enabled, false, 'a hand-dropped addon starts switched off');

  turnOn('dancer');

  const dancer = find('dancer');
  assert.equal(dancer.loaded, true);
  assert.deepEqual(dancer.commands, ['dance']);
  assert.ok(addonNames().includes('dance'));
});

test('an addon that declares its own settings gets them coerced and clamped', () => {
  onlyBuiltins();
  writeAddon('tuner', {
    source: `
      flora.settings.define({
        loudness: { type: 'number', label: 'Loudness', default: 5, min: 1, max: 10 },
        mode: { type: 'enum', label: 'Mode', default: 'calm', options: ['calm', 'wild'] },
        quiet: { type: 'bool', label: 'Quiet', default: false }
      });
    `
  });

  addons.reload();
  turnOn('tuner');

  const tuner = find('tuner');
  assert.equal(tuner.fields.length, 3);
  assert.deepEqual(tuner.values, { loudness: 5, mode: 'calm', quiet: false });

  // `setSetting` returns what was actually stored, which is what the renderer
  // puts back in the box - so a clamped value is visible rather than silent.
  assert.equal(addons.setSetting('tuner', 'loudness', 999), 10);
  assert.equal(addons.setSetting('tuner', 'loudness', -4), 1);
  assert.equal(find('tuner').values.loudness, 1);

  // An enum only ever holds one of the options it declared.
  assert.equal(addons.setSetting('tuner', 'mode', 'sideways'), 'calm');
  assert.equal(addons.setSetting('tuner', 'mode', 'wild'), 'wild');
});

// ------------------------------------------------------------------ failures

test('an addon with a syntax error is listed with the error rather than dropped', () => {
  onlyBuiltins();
  writeAddon('broken', { source: 'this is not javascript(' });
  addons.reload();
  turnOn('broken');

  const broken = find('broken');
  assert.ok(broken, 'a broken addon is still listed, so the user can see it and remove it');
  assert.equal(broken.loaded, false);
  assert.ok(broken.error, 'the reason should be reported');
  assert.deepEqual(broken.commands, []);
});

test('an addon that throws on activate does not take the registry down', () => {
  onlyBuiltins();
  writeAddon('angry', { source: 'throw new Error("not today");' });
  addons.reload();
  turnOn('angry');

  assert.match(find('angry').error, /not today/);
  // One bad addon is one bad addon: the bundled one is untouched.
  assert.equal(find('essentials').loaded, true);
  assert.ok(addonNames().includes('where'));
});

test('an addon cannot reach outside its own folder', () => {
  onlyBuiltins();
  // The manifest names a file above the addon directory. That path must not be
  // read, whichever way it is spelled.
  writeAddon('escapee', { manifest: { main: '../../secret.key' }, source: '' });
  addons.reload();

  const escapee = find('escapee');
  assert.ok(escapee, 'the folder meant to be an addon, so it gets a row');
  assert.equal(escapee.loaded, false);
  assert.match(escapee.error, /inside the addon folder/i);
});

test('an addon cannot claim a command the built-ins already own', () => {
  onlyBuiltins();
  writeAddon('thief', {
    source: `
      flora.commands.register({
        name: 'help',
        usage: 'help',
        summary: 'Not the real help',
        run() {}
      });
    `
  });

  addons.reload();
  turnOn('thief');

  // The addon loads; it is the registration that is refused, because refusing
  // the whole addon would punish it for one bad line.
  assert.deepEqual(find('thief').commands, []);
  assert.ok(!addonNames().includes('help'), 'the built-in help keeps its name');
});

test('a command without a run function is refused rather than registered', () => {
  onlyBuiltins();
  writeAddon('hollow', {
    source: `flora.commands.register({ name: 'hollow', usage: 'hollow', summary: 'nothing' });`
  });

  addons.reload();
  turnOn('hollow');

  assert.deepEqual(find('hollow').commands, []);
  assert.match(find('hollow').error, /run\(\)/);
});

// ------------------------------------------------------------------ switches

test('switching an addon off takes its commands away and back on restores them', () => {
  onlyBuiltins();
  assert.ok(addonNames().includes('where'));

  assert.equal(addons.setEnabled('essentials', false).loaded, false);
  assert.ok(!addonNames().includes('where'));

  assert.equal(addons.setEnabled('essentials', true).loaded, true);
  assert.ok(addonNames().includes('where'));
});

test('the master switch stops everything, and beats the per-addon switch', () => {
  onlyBuiltins();
  updateSettings({ 'addons.enabled': false });
  addons.syncMasterSwitch();

  assert.equal(find('essentials').loaded, false);
  // The built-in commands are still there; it is the addon ones that are gone.
  assert.deepEqual(addonNames(), []);

  // Switching one addon on while the master is off must not start it, or the
  // list would show a running addon under a notice saying nothing is running.
  assert.equal(addons.setEnabled('essentials', true).loaded, false);

  updateSettings({ 'addons.enabled': true });
  addons.syncMasterSwitch();
  assert.equal(find('essentials').loaded, true);
});

test('the chat-command switch hides addon commands without unloading them', () => {
  onlyBuiltins();
  updateSettings({ 'addons.allowChatCommands': false });

  assert.deepEqual(addonNames(), []);
  assert.equal(addons.addonCommand('where'), undefined);
  // The addon is still loaded: the switch is about who may type at it, not
  // about whether it runs.
  assert.equal(find('essentials').loaded, true);

  updateSettings({ 'addons.allowChatCommands': true });
  assert.ok(addonNames().includes('where'));
});

test('a switched-off addon stays off across a reload', () => {
  onlyBuiltins();
  addons.setEnabled('essentials', false);
  addons.reload();

  assert.equal(find('essentials').enabled, false);
  assert.equal(find('essentials').loaded, false);
});

// ------------------------------------------------------------------ install

test('installing copies the folder in, leaving the original where it was', () => {
  onlyBuiltins();

  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'flora-addon-src-'));
  fs.writeFileSync(path.join(source, 'addon.json'), JSON.stringify({
    id: 'imported',
    name: 'Imported',
    version: '1.0.0',
    description: 'copied in by the test',
    main: 'index.js'
  }));
  fs.writeFileSync(path.join(source, 'index.js'), 'flora.log("imported");');

  const installed = addons.install(source);

  assert.equal(installed.id, 'imported');
  // Installing is the action that means "run this", so it arrives switched on
  // even though dropping the same folder in by hand would not.
  assert.equal(installed.enabled, true);
  assert.equal(installed.loaded, true);
  assert.ok(fs.existsSync(path.join(source, 'index.js')), 'the source folder is not moved');
  assert.ok(fs.existsSync(path.join(addonsDir(), 'imported', 'index.js')));

  // Installing the same one twice is refused rather than silently overwriting
  // whatever the user has since changed in flora's copy.
  assert.throws(() => addons.install(source), /already installed/i);

  fs.rmSync(source, { recursive: true, force: true });
});

test('installing something that is not an addon says so', () => {
  onlyBuiltins();

  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'flora-addon-src-'));
  fs.writeFileSync(path.join(source, 'readme.txt'), 'not an addon');

  assert.throws(() => addons.install(source), /addon\.json/i);
  assert.throws(() => addons.install(path.join(source, 'nowhere')), /folder/i);

  fs.rmSync(source, { recursive: true, force: true });
});

test('a bundled addon can be switched off but not removed', () => {
  onlyBuiltins();
  assert.throws(() => addons.remove('essentials'), /ship with flora/i);
  assert.ok(find('essentials'));
});

test('removing an addon takes its folder, its commands and its stored state', () => {
  onlyBuiltins();
  writeAddon('throwaway', {
    source: `flora.commands.register({ name: 'temp', usage: 'temp', summary: 't', run() {} });`
  });
  addons.reload();
  turnOn('throwaway');
  assert.ok(addonNames().includes('temp'));

  addons.remove('throwaway');

  assert.equal(find('throwaway'), undefined);
  assert.ok(!addonNames().includes('temp'));
  assert.ok(!fs.existsSync(path.join(addonsDir(), 'throwaway')));
});

// ------------------------------------------------------------------ isolation

test('an addon gets no require, no process, no fetch and no eval', () => {
  onlyBuiltins();
  writeAddon('nosy', {
    source: `
      function probe(expression, run) {
        try { return run(); } catch (err) { return 'refused'; }
      }
      flora.commands.register({
        name: 'probe',
        usage: 'probe',
        summary: 'What can this addon see?',
        run(bot, args, ctx) {
          bot.whisper(ctx.username, JSON.stringify({
            require: typeof require,
            process: typeof process,
            fetch: typeof fetch,
            module: typeof module,
            eval: probe('1 + 1', function () { return typeof eval('1 + 1'); }),
            newFunction: probe('', function () { return typeof new Function('return 1'); })
          }));
        }
      });
    `
  });

  addons.reload();
  turnOn('nosy');

  const spec = addons.addonCommand('probe');
  assert.ok(spec, 'the probe command should be registered');

  const said = [];
  spec.run({ username: 'flora_bot', whisper: (to, text) => said.push([to, text]) }, [], { username: 'Notch' });

  assert.equal(said.length, 1);
  assert.deepEqual(JSON.parse(said[0][1]), {
    require: 'undefined',
    process: 'undefined',
    fetch: 'undefined',
    module: 'undefined',
    eval: 'refused',
    newFunction: 'refused'
  });
});

test('an addon that throws inside a command does not break the caller', () => {
  onlyBuiltins();
  writeAddon('clumsy', {
    source: `
      flora.commands.register({
        name: 'clumsy',
        usage: 'clumsy',
        summary: 'Throws',
        run() { throw new Error('dropped it'); }
      });
    `
  });

  addons.reload();
  turnOn('clumsy');

  const spec = addons.addonCommand('clumsy');
  // The guarded wrapper swallows the throw and returns undefined, so the chat
  // dispatcher carries on rather than dying with the addon.
  assert.equal(spec.run({}, [], { username: 'Notch' }), undefined);
  assert.equal(find('essentials').loaded, true);
});
