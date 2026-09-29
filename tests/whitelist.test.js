/**
 * The whitelist, and the commands it gates.
 *
 * This is the one part of flora whose failure mode is "a stranger drove your
 * accounts", so it is tested from both ends: the pure rules (`parse`,
 * `isWhitelisted`) and the dispatcher (`handle`) driven against the real
 * settings table rather than a stub. `commands.js` imports `getSetting`
 * directly, so the only honest way to test what a saved list does is to save
 * one.
 *
 * The database is redirected to a throwaway directory before anything imports
 * `paths.js`, which reads FLORA_DATA_DIR once at module load - hence the
 * dynamic imports below rather than static ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flora-whitelist-'));
process.env.FLORA_DATA_DIR = dataDir;

const { isWhitelisted, parse, handle, commandHelp, whisperBudget, COMMAND_NAMES } =
  await import('../src/backend/bots/commands.js');
const { getSetting, updateSettings, invalidate, resetSettings } =
  await import('../src/backend/settings.js');

test.after(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows lock */ }
});

/** A bot that records what it was told, so replies can be asserted on. */
function fakeBot({ withPathfinder = true, failOn = null } = {}) {
  const said = [];
  const whispered = [];
  return {
    username: 'flora_bot',
    health: 20,
    food: 18,
    entity: { position: { x: 4, y: 64, z: -9 } },
    players: { Notch: { entity: { position: { x: 1, y: 64, z: 2 } } } },
    pathfinder: withPathfinder
      ? {
        goal: 'unset',
        setGoal(goal) {
          if (failOn === 'setGoal') throw new Error('path was blocked');
          this.goal = goal;
        }
      }
      : undefined,
    chat(text) { if (failOn === 'chat') throw new Error('chat refused'); said.push(text); },
    whisper(to, text) { whispered.push([to, text]); },
    said,
    whispered
  };
}

const record = { accountId: 1, server: 'example.org:25565' };

/** Put the app into a known state for one test. */
function configure({ enabled, players }) {
  updateSettings({ 'whitelist.enabled': enabled, 'whitelist.players': players });
}

// ------------------------------------------------------------------ matching

test('isWhitelisted matches a name however it was typed', () => {
  const list = ['Notch', 'jeb_'];

  assert.equal(isWhitelisted('Notch', list), true);
  assert.equal(isWhitelisted('notch', list), true);
  assert.equal(isWhitelisted('NOTCH', list), true);
  // Hand-typed lists pick up stray spaces, and a name that differs only in
  // whitespace is the same person.
  assert.equal(isWhitelisted('  jeb_  ', list), true);
  assert.equal(isWhitelisted(' jeb_', ['jeb_ ']), true);
});

test('isWhitelisted refuses everyone the list does not name', () => {
  assert.equal(isWhitelisted('Herobrine', ['Notch']), false);
  assert.equal(isWhitelisted('Notch', []), false);
  assert.equal(isWhitelisted('Notch', null), false);
  assert.equal(isWhitelisted('Notch', undefined), false);
  // An empty or missing username is not a match for anything, including an
  // empty list entry - a chat line with no sender must never be authorised.
  assert.equal(isWhitelisted('', ['']), false);
  assert.equal(isWhitelisted(null, ['Notch']), false);
  assert.equal(isWhitelisted(undefined, ['Notch']), false);
});

test('isWhitelisted does not treat a partial name as a match', () => {
  assert.equal(isWhitelisted('Not', ['Notch']), false);
  assert.equal(isWhitelisted('Notch2', ['Notch']), false);
});

// ------------------------------------------------------------------ parsing

test('parse reads a command, its name and its arguments', () => {
  assert.deepEqual(parse('.come', '.'), { name: 'come', args: [] });
  assert.deepEqual(parse('.say hello there', '.'), { name: 'say', args: ['hello', 'there'] });
  // The name is lower-cased so `.Say` is the same command; the arguments are
  // not, because they are usually something a human wants repeated verbatim.
  assert.deepEqual(parse('.SAY Hello There', '.'), { name: 'say', args: ['Hello', 'There'] });
});

test('parse ignores anything that is not a command', () => {
  assert.equal(parse('hello everyone', '.'), null);
  assert.equal(parse('', '.'), null);
  assert.equal(parse(null, '.'), null);
  // Just the prefix is not a command.
  assert.equal(parse('.', '.'), null);
  assert.equal(parse('   .   ', '.'), null);
  // A dot in the middle of a sentence is punctuation, not a prefix.
  assert.equal(parse('well. come here', '.'), null);
});

test('parse collapses runs of whitespace and tolerates a padded line', () => {
  assert.deepEqual(parse('   .say   spaced    out  ', '.'), { name: 'say', args: ['spaced', 'out'] });
});

test('parse follows the configured prefix', () => {
  assert.deepEqual(parse('!come', '!'), { name: 'come', args: [] });
  assert.equal(parse('.come', '!'), null);
  // An empty prefix would make every chat line a command, so it is refused
  // rather than treated as "match everything".
  assert.equal(parse('.come', ''), null);
  assert.equal(parse('.come', null), null);
});

// ------------------------------------------------------------------ dispatch

test('ordinary chat is ignored, and nothing is said back', () => {
  configure({ enabled: true, players: ['Notch'] });
  const bot = fakeBot();

  assert.deepEqual(handle(bot, record, { username: 'Notch', message: 'nice base' }), { outcome: 'ignored' });
  assert.equal(bot.whispered.length, 0);
  assert.equal(bot.said.length, 0);
});

test('a command is ignored while the feature is switched off', () => {
  configure({ enabled: false, players: ['Notch'] });
  const bot = fakeBot();

  // Silently: a server where nobody switched this on should not have its chat
  // answered by a bot announcing that it takes orders.
  assert.deepEqual(handle(bot, record, { username: 'Notch', message: '.come' }), { outcome: 'disabled' });
  assert.equal(bot.whispered.length, 0);
  assert.equal(bot.pathfinder.goal, 'unset');
});

test('a command from someone off the list is refused, privately', () => {
  configure({ enabled: true, players: ['Notch'] });
  const bot = fakeBot();
  const logged = [];

  const result = handle(bot, record, {
    username: 'Herobrine',
    message: '.come',
    log: (level, text) => logged.push([level, text])
  });

  assert.equal(result.outcome, 'denied');
  assert.equal(result.username, 'Herobrine');
  // Whispered rather than said: the refusal is for the person who tried, not
  // for the server to read.
  assert.equal(bot.said.length, 0);
  assert.equal(bot.whispered.length, 1);
  assert.match(bot.whispered[0][1], /whitelist/i);
  assert.equal(bot.pathfinder.goal, 'unset');
  assert.equal(logged[0][0], 'warn');
});

test('an empty list refuses everyone, which is how flora starts', () => {
  configure({ enabled: true, players: [] });
  const bot = fakeBot();

  assert.equal(handle(bot, record, { username: 'Notch', message: '.come' }).outcome, 'denied');
  assert.equal(bot.pathfinder.goal, 'unset');
});

test('a whitelisted player gets the command run', () => {
  configure({ enabled: true, players: ['Notch'] });
  const bot = fakeBot();
  const logged = [];

  const result = handle(bot, record, {
    username: 'Notch',
    message: '.come',
    log: (level, text) => logged.push([level, text])
  });

  assert.equal(result.outcome, 'ran');
  assert.equal(result.name, 'come');
  assert.notEqual(bot.pathfinder.goal, 'unset');
  assert.deepEqual(logged[0], ['command', 'Notch ran .come']);
});

test('the list is matched case-insensitively end to end', () => {
  configure({ enabled: true, players: ['Notch'] });
  const bot = fakeBot();

  assert.equal(handle(bot, record, { username: 'nOtCh', message: '.status' }).outcome, 'ran');
});

test('an unknown command is reported rather than run', () => {
  configure({ enabled: true, players: ['Notch'] });
  const bot = fakeBot();

  const result = handle(bot, record, { username: 'Notch', message: '.fly' });

  assert.equal(result.outcome, 'unknown');
  assert.equal(result.name, 'fly');
  assert.match(bot.whispered.at(-1)[1], /no such command/i);
});

test('a command that throws is reported, not propagated', () => {
  configure({ enabled: true, players: ['Notch'] });
  const bot = fakeBot({ failOn: 'setGoal' });
  const logged = [];

  // A pathfinder failure must not take the bot's chat listener down with it.
  const result = handle(bot, record, {
    username: 'Notch',
    message: '.come',
    log: (level, text) => logged.push([level, text])
  });

  assert.equal(result.outcome, 'failed');
  assert.match(result.error, /path was blocked/);
  // The request is logged before it runs, so the failure is the line after it.
  assert.deepEqual(logged[0], ['command', 'Notch ran .come']);
  assert.equal(logged.at(-1)[0], 'error');
  assert.match(logged.at(-1)[1], /path was blocked/);
});

test('a bot without a pathfinder says so instead of throwing', () => {
  configure({ enabled: true, players: ['Notch'] });
  const bot = fakeBot({ withPathfinder: false });

  const result = handle(bot, record, { username: 'Notch', message: '.follow' });

  assert.equal(result.outcome, 'ran');
  assert.match(bot.whispered.at(-1)[1], /no pathfinder/i);
});

test('say repeats the text, and only the text', () => {
  configure({ enabled: true, players: ['Notch'] });
  const bot = fakeBot();

  handle(bot, record, { username: 'Notch', message: '.say hello world' });

  assert.deepEqual(bot.said, ['hello world']);
  // The prefix and the command name are not echoed back as part of the message.
  assert.doesNotMatch(bot.said[0], /\.say/);
});

test('say cannot be used to inject a second chat line', () => {
  configure({ enabled: true, players: ['Notch'] });
  const bot = fakeBot();

  handle(bot, record, { username: 'Notch', message: '.say one\ntwo' });

  assert.equal(bot.said.length, 1);
  assert.doesNotMatch(bot.said[0], /\n/);
});

test('every command in the set is reachable and documented', () => {
  configure({ enabled: true, players: ['Notch'] });

  assert.deepEqual(COMMAND_NAMES.sort(), ['come', 'follow', 'help', 'say', 'status', 'stop']);

  for (const name of COMMAND_NAMES) {
    const bot = fakeBot();
    const result = handle(bot, record, { username: 'Notch', message: `.${name}` });
    // `.say` with no argument only reports its usage, but it is still a
    // command that was found and run rather than an unknown one.
    assert.ok(['ran', 'failed'].includes(result.outcome), `${name} did not run: ${result.outcome}`);
  }
});

test('help is answered in flora, and says nothing to the server', () => {
  configure({ enabled: true, players: ['Notch'] });
  const bot = fakeBot();
  const logged = [];

  const result = handle(bot, record, {
    username: 'Notch',
    message: '.help',
    log: (level, text) => logged.push([level, text])
  });

  assert.equal(result.outcome, 'ran');
  assert.equal(result.local, true);

  // The whole point: a bot that recites its command list into server chat is a
  // bot that gets kicked for it. Nothing may go out over the socket.
  assert.equal(bot.said.length, 0);
  assert.equal(bot.whispered.length, 0);

  // The list still has to reach the person who asked, so it goes to the console.
  const printed = logged.filter(([level]) => level === 'command').map(([, text]) => text).join('\n');
  for (const name of COMMAND_NAMES) assert.match(printed, new RegExp(`\\.${name}\\b`));
});

test('only help is answered locally', () => {
  configure({ enabled: true, players: ['Notch'] });

  for (const name of COMMAND_NAMES) {
    if (name === 'help') continue;
    const bot = fakeBot();
    const result = handle(bot, record, { username: 'Notch', message: `.${name}` });
    assert.notEqual(result.local, true, `${name} should still answer in chat`);
  }
});

test('a whisper is budgeted against the wire string, not a flat number', () => {
  // `/tell <name> ` is part of the 256 the server counts, so the longer the
  // name the less room the message has. A flat cap ignores that.
  assert.equal(whisperBudget('Notch'), 256 - '/tell Notch '.length);
  assert.equal(whisperBudget('a'.repeat(16)), 256 - 23);

  // What is sent is the whole line, and it fits.
  const bot = fakeBot();
  const name = 'a'.repeat(16);
  const long = 'x'.repeat(400);
  configure({ enabled: true, players: [name] });

  handle(bot, record, { username: name, message: `.say ${long}` });

  assert.ok(bot.said[0].length <= 256, `chat was ${bot.said[0].length} characters`);
  assert.ok(bot.whispered.every(([, text]) => `/tell ${name} ${text}`.length <= 256));
});


test('a caller with no logger still gets a working command', () => {
  configure({ enabled: true, players: ['Notch'] });
  const bot = fakeBot();

  // `log` defaults to a no-op, so the dispatcher is usable from anywhere.
  assert.equal(handle(bot, record, { username: 'Notch', message: '.stop' }).outcome, 'ran');
});

test('the reference the UI renders comes from the dispatcher', () => {
  const reference = commandHelp('@');

  assert.deepEqual(reference.map((entry) => entry.name).sort(), [...COMMAND_NAMES].sort());

  for (const entry of reference) {
    assert.ok(entry.usage.startsWith('@'), `${entry.name} ignored the prefix`);
    assert.ok(entry.summary && entry.summary.length > 8, `${entry.name} has no summary`);
  }

  // The prefix is a setting, so the reference has to follow it.
  updateSettings({ 'bots.chatPrefix': '!' });
  try {
    assert.ok(commandHelp().every((entry) => entry.usage.startsWith('!')));
  } finally {
    updateSettings({ 'bots.chatPrefix': '.' });
  }
});

// ------------------------------------------------------------------ storage

test('the whitelist is off and empty on a fresh install', () => {
  // The keys are deleted rather than the cache dropped: this file shares one
  // database with every test above it, and "fresh install" is a statement
  // about what is stored, not about what happens to be cached.
  resetSettings(['whitelist.enabled', 'whitelist.players']);

  assert.equal(getSetting('whitelist.enabled'), false);
  assert.deepEqual(getSetting('whitelist.players'), []);
});

test('the list keeps usernames and drops everything else', () => {
  updateSettings({
    'whitelist.players': [
      'Notch', 'jeb_', 'a_very_long_username_x', // 21 characters - too long
      'ab', // too short
      'has space', 'bad-dash', '', '   ', 42, null, { name: 'Notch' }
    ]
  });

  assert.deepEqual(getSetting('whitelist.players'), ['Notch', 'jeb_']);
});

test('the list collapses duplicates that differ only in case', () => {
  updateSettings({ 'whitelist.players': ['Notch', 'notch', 'NOTCH', 'jeb_'] });
  assert.deepEqual(getSetting('whitelist.players'), ['Notch', 'jeb_']);
});

test('the list trims what it is given rather than storing the padding', () => {
  updateSettings({ 'whitelist.players': ['  Notch  '] });
  assert.deepEqual(getSetting('whitelist.players'), ['Notch']);
});

test('saving the same list twice reports no change', () => {
  updateSettings({ 'whitelist.players': ['Notch', 'jeb_'] });

  // Arrays compare by identity, so a naive `===` would report every save as a
  // change and write to the database on every keystroke that never happened.
  assert.deepEqual(updateSettings({ 'whitelist.players': ['Notch', 'jeb_'] }), {});
  assert.deepEqual(updateSettings({ 'whitelist.players': ['jeb_', 'Notch'] }), {
    'whitelist.players': ['jeb_', 'Notch']
  });
});

test('a list setting survives the round trip through storage', () => {
  updateSettings({ 'whitelist.players': ['Notch', 'jeb_'] });
  // The cache is the thing that would hide a broken write, so it is dropped:
  // what comes back has to have been read out of the database.
  invalidate();
  assert.deepEqual(getSetting('whitelist.players'), ['Notch', 'jeb_']);
});

test('something that is not a list empties the list rather than being stored', () => {
  updateSettings({ 'whitelist.players': ['Notch'] });
  updateSettings({ 'whitelist.players': 'Notch' });

  // No control in the app sends a string here, so this is the hand-edited
  // database file being defended against. Failing to the empty list is the safe
  // direction: the worst case is that commands stop being obeyed, not that a
  // string becomes a list with one accidental entry in it.
  assert.deepEqual(getSetting('whitelist.players'), []);
});

// ------------------------------------------------------------------ wiring

test('the whitelist is declared in the schema the settings screen builds from', async () => {
  const { describe } = await import('../src/backend/settings.js');
  const schema = describe();

  const group = schema.groups.find((entry) => entry.id === 'whitelist');
  assert.ok(group, 'the whitelist group is missing');
  assert.equal(group.label, 'Whitelist');

  const players = schema.fields.find((entry) => entry.key === 'whitelist.players');
  assert.equal(players.type, 'list');
  assert.equal(players.group, 'whitelist');
  assert.deepEqual(players.default, []);

  const enabled = schema.fields.find((entry) => entry.key === 'whitelist.enabled');
  assert.equal(enabled.type, 'bool');
  assert.equal(enabled.default, false);
});
