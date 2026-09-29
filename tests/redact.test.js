/**
 * Secret redaction.
 *
 * Every log line, error message and UI string passes through `scrub`, and the
 * point of the module is that a secret never survives the trip. These tests
 * therefore assert on what is *gone* at least as much as on what is left: a
 * pattern that silently stopped matching would still produce tidy output.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { scrub, scrubDeep, maskToken } from '../src/backend/logging/redact.js';

const MASK = '«redacted»';

/** A real-shaped Minecraft access token: three base64url segments. */
const JWT =
  'eyJraWQiOiJhYmMxMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoiLCJhbGciOiJSUzI1NiJ9' +
  '.eyJ4NXUiOiJodHRwczovL2V4YW1wbGUuaW52YWxpZC94NXUiLCJpc3MiOiJodHRwczovL2V4YW1wbGUuaW52' +
  'YWxpZCJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU';

/** A long opaque run with no JWT shape, as a session token would be. */
const OPAQUE = `${'A'.repeat(45)}${'b'.repeat(45)}${'0'.repeat(45)}`;

// ---------------------------------------------------------------- scrub: tokens

test('scrub removes a JWT entirely', () => {
  const out = scrub(`Authenticated with ${JWT}`);
  assert.equal(out.includes(JWT), false);
  assert.ok(out.includes(MASK));
});

test('scrub removes a long opaque token', () => {
  const out = scrub(`session ${OPAQUE} established`);
  assert.equal(out.includes(OPAQUE), false);
  assert.ok(out.includes(MASK));
});

test('scrub removes a JWT embedded in an error message', () => {
  // The usual way a token leaks: a library putting it in its own error text.
  const out = scrub(`Error: request failed for token=${JWT} (401)`);
  assert.equal(out.includes(JWT), false);
  assert.ok(out.includes('401'), 'the rest of the message survives');
});

// ---------------------------------------------------------------- scrub: headers

test('scrub removes a bearer header', () => {
  const out = scrub(`Authorization: Bearer ${JWT}`);
  assert.equal(out.includes(JWT), false);
});

test('scrub removes a bare bearer token', () => {
  const out = scrub(`Bearer ${OPAQUE}`);
  assert.equal(out.includes(OPAQUE), false);
});

// ---------------------------------------------------------------- scrub: keyed

test('scrub removes a value named by its key', () => {
  for (const line of [
    'password: hunter2',
    'password=hunter2',
    'api_key: abc123',
    'access_token: abc123',
    'refresh_token=abc123',
    'client_secret: abc123',
    'session: abc123'
  ]) {
    const out = scrub(line);
    assert.equal(out.includes('abc123') || out.includes('hunter2'), false, line);
    assert.ok(out.includes(MASK), line);
  }
});

test('scrub leaves a key with no value attached alone', () => {
  // Nothing follows the separator, so there is nothing to redact and the
  // pattern deliberately does not match.
  assert.equal(scrub('the password is not set'), 'the password is not set');
});

// ---------------------------------------------------------------- scrub: URLs

test('scrub removes proxy credentials from a URL', () => {
  const out = scrub('socks5://alice:hunter2@1.2.3.4:1080');
  assert.equal(out.includes('hunter2'), false);
  assert.equal(out, `socks5://alice:${MASK}@1.2.3.4:1080`);
});

test('scrub keeps the host of a URL whose credentials it removed', () => {
  const out = scrub('https://user:s3cret@api.example.com/path');
  assert.equal(out.includes('s3cret'), false);
  assert.ok(out.includes('api.example.com'));
});

// ---------------------------------------------------------------- scrub: email

test('scrub masks the local part of an email address and keeps the domain', () => {
  assert.equal(scrub('alice@example.com'), 'a•••@example.com');
});

test('scrub masks an email address inside a sentence', () => {
  const out = scrub('signing in as alice@example.com now');
  assert.equal(out.includes('alice@example.com'), false);
  assert.ok(out.includes('@example.com'));
});

// ---------------------------------------------------------------- scrub: edges

test('scrub passes a non-string through untouched', () => {
  assert.equal(scrub(42), 42);
  assert.equal(scrub(null), null);
  assert.equal(scrub(undefined), undefined);
});

test('scrub handles an empty string', () => {
  assert.equal(scrub(''), '');
});

test('scrub leaves ordinary text alone', () => {
  const line = 'Connected to play.example.com as Notch after 3 attempts.';
  assert.equal(scrub(line), line);
});

test('scrubDeep walks an object and redacts what it finds', () => {
  const out = scrubDeep({ token: JWT, nested: { authorization: `Bearer ${OPAQUE}` } });
  assert.equal(JSON.stringify(out).includes(JWT), false);
  assert.equal(JSON.stringify(out).includes(OPAQUE), false);
});

test('scrubDeep redacts an Error message and keeps its name', () => {
  const out = scrubDeep(new Error(`failed with ${JWT}`));
  assert.equal(out.name, 'Error');
  assert.equal(String(out.message).includes(JWT), false);
});

test('scrubDeep survives a circular object', () => {
  const node = { label: 'root' };
  node.self = node;
  const out = scrubDeep(node);
  assert.equal(out.self, '[circular]');
});

test('scrubDeep truncates rather than walking a very deep object', () => {
  let deep = { value: 'leaf' };
  for (let i = 0; i < 12; i += 1) deep = { next: deep };
  assert.equal(JSON.stringify(scrubDeep(deep)).includes('[deep]'), true);
});

test('scrubDeep passes numbers and booleans through', () => {
  assert.deepEqual(scrubDeep({ n: 3, ok: true }), { n: 3, ok: true });
});

// ---------------------------------------------------------------- maskToken

test('maskToken keeps only the last four characters', () => {
  assert.equal(maskToken('123456789'), '••••••••6789');
});

test('maskToken hides a short value completely', () => {
  assert.equal(maskToken('abc'), '•••');
  assert.equal(maskToken('12345678'), '••••••••');
});

test('maskToken never returns the whole secret', () => {
  const out = maskToken(JWT);
  assert.equal(out.includes(JWT), false);
  assert.equal(out.endsWith(JWT.slice(-4)), true);
});

test('maskToken handles a missing value', () => {
  assert.equal(maskToken(''), '');
  assert.equal(maskToken(null), '');
  assert.equal(maskToken(undefined), '');
  assert.equal(maskToken(42), '');
});
