/**
 * Account import parsing.
 *
 * The parser decides what kind of account a pasted line describes, and getting
 * it wrong means a real Microsoft token is stored as an offline password (or the
 * reverse), so every documented format has a case here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  parse, plan, serialise, preview, looksLikeToken, parseLine, CONSTANTS
} from '../src/backend/accounts/import.js';

/** A realistic Minecraft access token: a JWT, long enough to be unambiguous. */
const JWT =
  'eyJraWQiOiJhYmMxMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoiLCJhbGciOiJSUzI1NiJ9' +
  '.eyJ4NXUiOiJodHRwczovL2V4YW1wbGUuaW52YWxpZC94NXUiLCJpc3MiOiJodHRwczovL2V4YW1wbGUuaW52' +
  'YWxpZCJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU';

const UUID = '069a79f444e94726a5befca90e38aaf5';
const UUID_DASHED = '069a79f4-44e9-4726-a5be-fca90e38aaf5';

/** A long, high-entropy-looking run with no JWT prefix. */
const OPAQUE_TOKEN = `${'A'.repeat(45)}${'b'.repeat(45)}${'0'.repeat(45)}`;

const fingerprint = (token) => createHash('sha256').update(token).digest('hex');

// ---------------------------------------------------------------- looksLikeToken

test('looksLikeToken accepts a JWT', () => {
  assert.equal(looksLikeToken(JWT), true);
});

test('looksLikeToken accepts a long mixed-case run with no JWT prefix', () => {
  assert.equal(looksLikeToken(OPAQUE_TOKEN), true);
});

test('looksLikeToken rejects anything that is plainly not a token', () => {
  assert.equal(looksLikeToken('hunter2'), false);
  assert.equal(looksLikeToken('Notch'), false);
  assert.equal(looksLikeToken(''), false);
  assert.equal(looksLikeToken(null), false);
  assert.equal(looksLikeToken(42), false);
  // Long, but a single case and no digits: that is a passphrase, not a token.
  assert.equal(looksLikeToken('A'.repeat(130)), false);
  // Longer than any token the API issues.
  assert.equal(looksLikeToken('A'.repeat(CONSTANTS.MAX_TOKEN_LENGTH + 1)), false);
  // Whitespace never appears inside a token.
  assert.equal(looksLikeToken(`${JWT} ${JWT}`), false);
  assert.equal(looksLikeToken(`ey${'J'.repeat(70)}. abcd`), false);
});

test('looksLikeToken requires the minimum length', () => {
  const short = `ey${'J'.repeat(CONSTANTS.MIN_TOKEN_LENGTH - 10)}.x`;
  assert.ok(short.length < CONSTANTS.MIN_TOKEN_LENGTH);
  assert.equal(looksLikeToken(short), false);
});

// ---------------------------------------------------------------- parseLine

test('parseLine ignores a blank line', () => {
  assert.equal(parseLine('', 1), null);
  assert.equal(parseLine('    ', 1), null);
});

test('parseLine reads user:pass as an offline account', () => {
  const { entry } = parseLine('Notch:hunter2', 4);
  assert.equal(entry.kind, 'offline');
  assert.equal(entry.username, 'Notch');
  assert.equal(entry.password, 'hunter2');
  assert.equal(entry.uuid, null);
  assert.equal(entry.line, 4);
});

test('parseLine reads email:token as a token account, not a password', () => {
  const { entry } = parseLine(`alice@example.com:${JWT}`, 1);
  assert.equal(entry.kind, 'token');
  assert.equal(entry.token, JWT);
  assert.equal(entry.username, 'alice@example.com', 'the email is kept as the label for the account');
  assert.equal(entry.password, null);
});

test('parseLine reads user:pass:uuid and normalises the UUID', () => {
  const { entry } = parseLine(`Notch:hunter2:${UUID}`, 1);
  assert.equal(entry.kind, 'offline');
  assert.equal(entry.username, 'Notch');
  assert.equal(entry.password, 'hunter2');
  assert.equal(entry.uuid, UUID);
});

test('parseLine strips the dashes out of a dashed UUID', () => {
  const { entry } = parseLine(`Notch:hunter2:${UUID_DASHED}`, 1);
  assert.equal(entry.uuid, UUID);
});

test('parseLine reads uuid:username as an offline account', () => {
  const { entry } = parseLine(`${UUID}:Notch`, 1);
  assert.equal(entry.kind, 'offline');
  assert.equal(entry.username, 'Notch');
  assert.equal(entry.uuid, UUID);
  assert.equal(entry.password, null);
});

test('parseLine reads a bare username as an offline account', () => {
  const { entry } = parseLine('Notch', 1);
  assert.equal(entry.kind, 'offline');
  assert.equal(entry.username, 'Notch');
  assert.equal(entry.password, null);
});

test('parseLine reads a bare token as a token account', () => {
  const { entry } = parseLine(JWT, 1);
  assert.equal(entry.kind, 'token');
  assert.equal(entry.token, JWT);
  assert.equal(entry.username, '');
});

test('parseLine honours the explicit prefixes', () => {
  const token = parseLine(`token:${JWT}`, 1).entry;
  assert.equal(token.kind, 'token');
  assert.equal(token.token, JWT);

  const offline = parseLine('offline:Notch:hunter2', 2).entry;
  assert.equal(offline.kind, 'offline');
  assert.equal(offline.username, 'Notch');
  assert.equal(offline.password, 'hunter2');

  const named = parseLine('username:Notch', 3).entry;
  assert.equal(named.kind, 'offline');
  assert.equal(named.username, 'Notch');
  assert.equal(named.password, null);
});

test('an explicit prefix beats the heuristic that would otherwise apply', () => {
  // Without the prefix this line is a password pair; the prefix is what makes
  // it authoritative.
  const prefixed = parseLine(`token:${OPAQUE_TOKEN}`, 1).entry;
  assert.equal(prefixed.kind, 'token');
});

test('the prefix separator may be = as well as :', () => {
  const { entry } = parseLine('username=Notch', 1);
  assert.equal(entry.username, 'Notch');
});

test('a token: prefix with an implausible payload is rejected', () => {
  const { error } = parseLine('token:not-a-token', 1);
  assert.match(error.reason, /not a valid access token/);
});

test('parseLine rejects a line with no username', () => {
  const { error } = parseLine(':hunter2', 1);
  assert.match(error.reason, /no username/);
});

test('parseLine rejects a username that cannot exist', () => {
  const { error } = parseLine('!!!:hunter2', 1);
  assert.match(error.reason, /username must be/);
});

test('parseLine leaves a non-UUID third field out of the entry', () => {
  const { entry } = parseLine('Notch:hunter2:notauuid', 1);
  assert.equal(entry.username, 'Notch');
  assert.equal(entry.password, 'hunter2');
  assert.equal(entry.uuid, null);
});

test('parseLine accepts the alternate separators', () => {
  for (const line of ['Notch|hunter2', 'Notch\thunter2']) {
    const { entry } = parseLine(line, 1);
    assert.equal(entry.username, 'Notch', line);
    assert.equal(entry.password, 'hunter2', line);
  }
});

// ---------------------------------------------------------------- parse: text

test('parse reads a whole file, counting comments', () => {
  const text = [
    '# my accounts',
    '// a second comment style',
    'Notch',
    '',
    'alice@example.com:hunter2',
    `bob:${UUID}`
  ].join('\n');

  const result = parse(text, 'accounts.txt');
  assert.equal(result.ok, true);
  assert.equal(result.format, 'text');
  assert.equal(result.comments, 2);
  assert.equal(result.entries.length, 3);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.entries.map((e) => e.username), ['Notch', 'alice@example.com', 'bob']);
});

test('parse survives CRLF line endings', () => {
  const result = parse('Notch\r\nalex:hunter2\r\n');
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].username, 'Notch');
  assert.equal(result.entries[1].password, 'hunter2');
});

test('parse strips a byte order mark without corrupting the first line', () => {
  const result = parse(`﻿Notch\nalex:hunter2`);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].username, 'Notch');
});

test('parse rejects an empty file', () => {
  assert.deepEqual(parse(''), { ok: false, error: 'That file is empty.' });
  assert.equal(parse('   \n\n  ').ok, false);
});

test('parse rejects a file that is only comments', () => {
  const result = parse('# nothing here\n\n// nor here\n');
  assert.equal(result.ok, false);
  assert.match(result.error, /No accounts found/);
});

test('parse reports the lines it could not read without losing the good ones', () => {
  const result = parse('Notch\n!!!:hunter2\n:hunter2\nalex\n');
  assert.equal(result.entries.length, 2);
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.errors.map((e) => e.line), [2, 3]);
  assert.equal(result.errorCount, 2);
  // The good entries keep their original line numbers, so the UI can point at
  // the right row in the preview.
  assert.deepEqual(result.entries.map((e) => e.line), [1, 4]);
});

test('a file with a .json name is parsed as JSON even when it does not look like it', () => {
  const result = parse(`{"accesstoken":"${JWT}"}`, 'dump.json');
  assert.equal(result.format, 'json');
  assert.equal(result.entries.length, 1);
});

// ---------------------------------------------------------------- parse: JSON

test('parse reads a bare array of account objects', () => {
  const result = parse(`[{"accesstoken":"${JWT}"}]`);
  assert.equal(result.format, 'json');
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].kind, 'token');
  assert.equal(result.entries[0].token, JWT);
});

test('parse reads a single object', () => {
  const result = parse(`{"token":"${JWT}","username":"Notch"}`);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].username, 'Notch');
});

test('parse reads an { accounts: [...] } wrapper', () => {
  const result = parse(`{"accounts":[{"accesstoken":"${JWT}"},{"username":"Notch"}]}`);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[1].kind, 'offline');
  assert.equal(result.entries[1].username, 'Notch');
});

test('parse reads a { tokens: [...] } wrapper', () => {
  const result = parse(`{"tokens":["${JWT}"]}`);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].kind, 'token');
});

test('parse reads a bare array of strings', () => {
  const result = parse(`["Notch","${JWT}"]`);
  assert.deepEqual(result.entries.map((e) => e.kind), ['offline', 'token']);
});

test('parse reports the keys it did not understand', () => {
  const result = parse(`[{"accesstoken":"${JWT}","nickname":"x","note":"y"}]`);
  assert.deepEqual(result.unknownKeys.sort(), ['nickname', 'note']);
});

test('parse rejects JSON that is not JSON', () => {
  const result = parse('[{"accesstoken": }]');
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
});

test('parse rejects a JSON token that is too short to be one', () => {
  const result = parse('{"accesstoken":"abc"}');
  assert.equal(result.entries.length, 0);
  assert.match(result.errors[0].reason, /too short/);
});

test('parse rejects JSON with nothing in it', () => {
  assert.match(parse('[]').error, /no accounts/i);
  assert.match(parse('[]').error, /contained no accounts/);
});

// ---------------------------------------------------------------- plan

test('plan separates fresh entries from duplicates inside the same file', () => {
  const planned = plan(parse(`token:${JWT}\ntoken:${JWT}\n`));

  assert.equal(planned.fresh.length, 1);
  assert.equal(planned.duplicates.length, 1);
  assert.match(planned.duplicates[0].reason, /repeated inside this file/);
  assert.equal(planned.counts.tokens, 1);
  assert.equal(planned.counts.duplicates, 1);
  assert.equal(planned.counts.importable, 1);
});

test('plan treats a token already in the database as a duplicate', () => {
  const planned = plan(parse(`token:${JWT}`), { existing: new Set([fingerprint(JWT)]) });
  assert.equal(planned.fresh.length, 0);
  assert.match(planned.duplicates[0].reason, /already in flora/);
});

test('plan matches usernames case-insensitively', () => {
  const planned = plan(parse('Notch\nnotch\nNOTCH'));
  assert.equal(planned.fresh.length, 1);
  assert.equal(planned.duplicates.length, 2);
});

test('plan treats a name already in the database as a duplicate', () => {
  const planned = plan(parse('Notch'), { existingNames: new Set(['notch']) });
  assert.equal(planned.fresh.length, 0);
  assert.match(planned.duplicates[0].reason, /already in flora/);
});

test('plan carries the unreadable lines through as invalid', () => {
  const planned = plan(parse('Notch\n!!!:x\n'));
  assert.equal(planned.invalid.length, 1);
  assert.equal(planned.fresh.length, 1);
  assert.equal(planned.counts.invalid, 1);
  assert.equal(planned.counts.total, 2);
});

test('preview never exposes a token or a password', () => {
  const planned = plan(parse(`token:${JWT}\nalice@example.com:hunter2`));
  const shown = JSON.stringify(preview(planned));

  assert.ok(!shown.includes(JWT), 'the token must not reach the UI preview');
  assert.ok(!shown.includes('hunter2'), 'the password must not reach the UI preview');
  assert.equal(preview(planned).sample.length, 2);
  assert.equal(preview(planned).sample[0].masked.endsWith(JWT.slice(-4)), true);
});

// ---------------------------------------------------------------- serialise

test('serialise writes one line per account', () => {
  const text = serialise([
    { kind: 'offline', username: 'Notch', uuid: null },
    { kind: 'offline', username: 'alex', uuid: null }
  ]);
  assert.equal(text, 'Notch\nalex\n');
});

test('serialise round-trips an offline account through parse', () => {
  const accounts = [
    { kind: 'offline', username: 'Notch', uuid: null },
    { kind: 'offline', username: 'alex', uuid: null }
  ];
  const back = parse(serialise(accounts));
  assert.equal(back.ok, true);
  assert.deepEqual(back.entries.map((e) => e.username), ['Notch', 'alex']);
  assert.deepEqual(back.entries.map((e) => e.kind), ['offline', 'offline']);
});

test('serialise includes a token only when the caller asks for it', () => {
  const accounts = [{ id: 7, kind: 'token', username: 'alice@example.com', uuid: null }];

  const without = parse(serialise(accounts));
  assert.equal(without.entries[0].kind, 'offline');
  assert.equal(without.entries[0].username, 'alice@example.com');

  const withSecrets = parse(serialise(accounts, { includeSecrets: true, revealToken: () => JWT }));
  assert.equal(withSecrets.entries[0].kind, 'token');
  assert.equal(withSecrets.entries[0].token, JWT);
});

test('serialise drops a token account that has no username when secrets are withheld', () => {
  const text = serialise([{ id: 7, kind: 'token', username: '', uuid: null }]);
  assert.equal(text, '\n');
});

test('serialise still writes the account when the key cannot produce a token', () => {
  const accounts = [{ id: 7, kind: 'token', username: 'alice@example.com', uuid: null }];
  const text = serialise(accounts, { includeSecrets: true, revealToken: () => null });
  assert.equal(text, 'alice@example.com\n');
});

test('serialise round-trips the UUID of an offline account', () => {
  const back = parse(serialise([{ kind: 'offline', username: 'alex', uuid: UUID }]));
  assert.equal(back.entries[0].uuid, UUID);
  assert.equal(back.entries[0].password, null);
});
