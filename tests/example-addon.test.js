/**
 * The worked example addon.
 *
 * `examples/playtime` is documentation that happens to be executable, and
 * documentation that is never run rots. This copies it into the addons folder
 * the way a user would drop one in, and drives it through the real registry, so
 * an example that has drifted away from the API fails here rather than in
 * somebody's first attempt at writing an addon.
 *
 * The database is redirected to a throwaway directory before anything imports
 * `paths.js`, which reads FLORA_DATA_DIR once at module load, hence the dynamic
 * imports below rather than static ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flora-example-'));
process.env.FLORA_DATA_DIR = dataDir;

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.join(here, '..', 'examples', 'playtime');

const paths = await import('../src/backend/paths.js');
paths.setDataRoot(dataDir);

const { db, closeDb } = await import('../src/backend/db/index.js');
db();

const { addonsDir, addonDataDir } = paths;
const addons = await import('../src/backend/addons/registry.js');
const { updateSettings } = await import('../src/backend/settings.js');
// Imported for its side effect: loading it tells the registry which command
// names the built-ins already own.
await import('../src/backend/bots/commands.js');

test.after(() => {
  try { closeDb(); } catch { /* already closed */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows lock */ }
});

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Empty the addons folder and put the switches back to their defaults. */
function reset() {
  fs.mkdirSync(addonDataDir(), { recursive: true });
  for (const name of fs.readdirSync(addonsDir())) {
    fs.rmSync(path.join(addonsDir(), name), { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(addonDataDir(), '_state.json'), '{}');
  fs.rmSync(path.join(addonDataDir(), 'playtime.json'), { force: true });
  updateSettings({ 'addons.enabled': true, 'addons.allowChatCommands': true });
}

/** Copy the example in and switch it on, which is how a user ends up running it. */
function install() {
  reset();
  fs.cpSync(EXAMPLE, path.join(addonsDir(), 'playtime'), { recursive: true });
  addons.reload();
  addons.setEnabled('playtime', true);
  return addons.list().find((entry) => entry.id === 'playtime');
}

/** The store file, once its debounced write has had time to land. */
async function savedStore() {
  await sleep(500);
  try {
    return JSON.parse(fs.readFileSync(path.join(addonDataDir(), 'playtime.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Stand in for a mineflayer bot, recording what the addon makes it say. */
function fakeBot(username) {
  const said = [];
  return {
    said,
    bot: { username, whisper: (to, text) => said.push([to, text]) }
  };
}

// ------------------------------------------------------------------ loading

test('the example addon loads and registers what its manifest promises', () => {
  const entry = install();

  assert.equal(entry.error, null, `the example failed to load: ${entry.error}`);
  assert.equal(entry.loaded, true);
  assert.deepEqual(entry.commands, ['playtime']);
  assert.deepEqual(entry.fields.map((field) => field.key).sort(), ['announce', 'minimum']);
  assert.deepEqual(entry.values, { announce: false, minimum: 60 });
});

test('the example is in the help list, so it is reachable in chat', () => {
  install();
  assert.ok(addons.addonCommand('playtime'), 'the command should be registered');
  assert.equal(addons.addonFor('playtime').name, 'Playtime');
});

// ------------------------------------------------------------------ command

test('playtime answers with the session and the total', () => {
  install();

  const { bot, said } = fakeBot('flora_bot');
  addons.addonCommand('playtime').run(bot, [], { username: 'Notch', accountId: 1, prefix: '.' });

  assert.deepEqual(said, [['Notch', 'this session 0s, total 0s.']]);
});

test('a session still running is counted, not only banked ones', async () => {
  install();
  addons.setSetting('playtime', 'minimum', 0);

  addons.emit('bot:spawn', { accountId: 3, username: 'Rowan', server: 'example.net', bot: {} });
  await sleep(1100);

  const { bot, said } = fakeBot('Rowan');
  addons.addonCommand('playtime').run(bot, [], { username: 'Notch', accountId: 3, prefix: '.' });

  const match = /^this session (\d+)s, total (\d+)s\.$/.exec(said[0][1]);
  assert.ok(match, `unexpected reply: ${said[0][1]}`);
  // Nothing has been banked yet, so the total is the session and nothing more.
  assert.equal(match[1], match[2]);
  assert.ok(Number(match[1]) >= 1);
});

// ------------------------------------------------------------------ storage

test('switching the addon off banks the session that was still running', async () => {
  install();
  addons.setSetting('playtime', 'minimum', 0);

  addons.emit('bot:spawn', { accountId: 9, username: 'Hazel', server: 'example.net', bot: {} });
  await sleep(1100);

  // Deliberately no bot:end. Switching the addon off is the last chance to save
  // this session, which is the whole reason the example has a deactivate().
  addons.setEnabled('playtime', false);

  const saved = await savedStore();
  assert.ok(saved.data?.['banked:hazel'] >= 1000,
    `expected a banked session, got ${saved.data?.['banked:hazel']}`);
});

test('a banked total is still there after the addon is switched off and on', async () => {
  install();
  addons.setSetting('playtime', 'minimum', 0);

  addons.emit('bot:spawn', { accountId: 4, username: 'Willow', server: 'example.net', bot: {} });
  await sleep(1100);
  addons.emit('bot:end', { accountId: 4, reason: null });
  await savedStore();

  addons.setEnabled('playtime', false);
  addons.setEnabled('playtime', true);

  const { bot, said } = fakeBot('Willow');
  addons.addonCommand('playtime').run(bot, [], { username: 'Notch', accountId: 4, prefix: '.' });

  const match = /^this session (\d+)s, total (\d+)s\.$/.exec(said[0][1]);
  assert.ok(match, `unexpected reply: ${said[0][1]}`);
  // The session is over, so the session reads zero and the total is the bank.
  assert.equal(match[1], '0');
  assert.ok(Number(match[2]) >= 1, `the total should have survived, got ${said[0][1]}`);
});

test('a session shorter than the minimum is not banked at all', async () => {
  install();
  addons.setSetting('playtime', 'minimum', 3600);

  addons.emit('bot:spawn', { accountId: 11, username: 'Alder', server: 'example.net', bot: {} });
  await sleep(150);
  addons.emit('bot:end', { accountId: 11, reason: null });

  const saved = await savedStore();
  assert.equal(saved.data?.['banked:alder'], undefined);
});

test('the total is kept per account, not shared between them', async () => {
  install();
  addons.setSetting('playtime', 'minimum', 0);

  addons.emit('bot:spawn', { accountId: 1, username: 'Fletcher', server: 'example.net', bot: {} });
  await sleep(1100);
  addons.emit('bot:end', { accountId: 1, reason: null });

  const saved = await savedStore();
  assert.ok(saved.data?.['banked:fletcher'] >= 1000);
  assert.equal(saved.data?.['banked:bramble'], undefined);
});

// ------------------------------------------------------------------ failures

test('an addon command that throws does not take the registry with it', () => {
  install();

  // The bot is gone by the time the command runs, which is what a disconnect
  // mid-command looks like in practice.
  const bot = { username: 'flora_bot', whisper() { throw new Error('the bot left'); } };
  assert.equal(
    addons.addonCommand('playtime').run(bot, [], { username: 'Notch', accountId: 1, prefix: '.' }),
    undefined
  );

  assert.equal(addons.list().find((entry) => entry.id === 'playtime').loaded, true);
});
