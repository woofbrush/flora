/**
 * UI formatting.
 *
 * Every string in the app that is derived from a value goes through here, so a
 * change to one of these functions changes dozens of screens. The non-breaking
 * space is deliberate - it keeps "3" and "accounts" on the same line - and is
 * asserted rather than normalised away, because losing it is a silent
 * regression.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  plural, bytes, duration, latency, truncateMiddle, server, initials,
  statusTone, kindLabel
} from '../src/renderer/js/format.js';

const NBSP = ' ';

test('plural agrees with its count', () => {
  assert.equal(plural(1, 'account'), `1${NBSP}account`);
  assert.equal(plural(0, 'account'), `0${NBSP}accounts`);
  assert.equal(plural(3, 'account'), `3${NBSP}accounts`);
});

test('plural groups thousands', () => {
  assert.equal(plural(1234, 'account'), `1,234${NBSP}accounts`);
});

test('plural accepts an irregular plural', () => {
  assert.equal(plural(2, 'proxy', 'proxies'), `2${NBSP}proxies`);
  assert.equal(plural(1, 'proxy', 'proxies'), `1${NBSP}proxy`);
});

test('bytes scales through the units', () => {
  assert.equal(bytes(0), `0${NBSP}B`);
  assert.equal(bytes(512), `512${NBSP}B`);
  assert.equal(bytes(1023), `1023${NBSP}B`);
  assert.equal(bytes(1024), `1.0${NBSP}KB`);
  assert.equal(bytes(1536), `1.5${NBSP}KB`);
  assert.equal(bytes(412 * 1024), `412${NBSP}KB`);
  assert.equal(bytes(18.4 * 1024 * 1024), `18${NBSP}MB`);
});

test('bytes rounds once the number is wide enough not to need a decimal', () => {
  assert.equal(bytes(9 * 1024), `9.0${NBSP}KB`);
  assert.equal(bytes(10 * 1024), `10${NBSP}KB`);
});

test('bytes treats a missing value as zero', () => {
  assert.equal(bytes(null), `0${NBSP}B`);
  assert.equal(bytes(undefined), `0${NBSP}B`);
});

test('duration drops units that would read as zero', () => {
  assert.equal(duration(0), '0s');
  assert.equal(duration(5000), '5s');
  assert.equal(duration(59999), '59s');
  assert.equal(duration(60000), '1m');
  assert.equal(duration(72000), '1m 12s');
  assert.equal(duration(252000), '4m 12s');
  assert.equal(duration(3600000), '1h');
  assert.equal(duration(3900000), '1h 5m');
  assert.equal(duration(86400000), '1d');
  assert.equal(duration(187200000), '2d 4h');
});

test('duration never goes negative', () => {
  assert.equal(duration(-5000), '0s');
});

test('duration treats a missing value as zero', () => {
  assert.equal(duration(null), '0s');
});

test('latency switches to seconds at a thousand milliseconds', () => {
  assert.equal(latency(0), '0ms');
  assert.equal(latency(840), '840ms');
  assert.equal(latency(999), '999ms');
  assert.equal(latency(1000), '1.0s');
  assert.equal(latency(1200), '1.2s');
});

test('latency shows a dash rather than NaN for an unknown value', () => {
  assert.equal(latency(undefined), '-');
  assert.equal(latency(NaN), '-');
  assert.equal(latency('not a number'), '-');
  // null coerces to 0 and reads as a measurement of zero. Both call sites only
  // format a latency for a proxy whose last check succeeded, so a null never
  // reaches here meaning "unknown".
  assert.equal(latency(null), '0ms');
});

test('truncateMiddle shortens a long value in the middle', () => {
  assert.equal(truncateMiddle('abcdefghijklmnop', 6, 4), 'abcdef…mnop');
});

test('truncateMiddle leaves anything short enough alone', () => {
  // head + tail + 1 is the boundary: below it there is nothing to save.
  assert.equal(truncateMiddle('abc'), 'abc');
  assert.equal(truncateMiddle('abcdefghijk'), 'abcdefghijk');
  assert.equal(truncateMiddle('abcdefghijkl'), 'abcdef…ijkl');
});

test('truncateMiddle handles a missing value', () => {
  assert.equal(truncateMiddle(null), '');
  assert.equal(truncateMiddle(undefined), '');
});

test('server drops a redundant default port', () => {
  assert.equal(server('play.example.com:25565'), 'play.example.com');
  assert.equal(server('play.example.com'), 'play.example.com');
});

test('server keeps a port that is not the default', () => {
  assert.equal(server('play.example.com:25566'), 'play.example.com:25566');
});

test('server handles a missing value', () => {
  assert.equal(server(null), '');
  assert.equal(server(undefined), '');
});

test('initials takes two letters from one word', () => {
  assert.equal(initials('Notch'), 'NO');
  assert.equal(initials('al'), 'AL');
});

test('initials takes one letter from each of two words', () => {
  assert.equal(initials('alice smith'), 'AS');
  assert.equal(initials('alice_smith'), 'AS');
  assert.equal(initials('alice.smith'), 'AS');
});

test('initials falls back to a question mark', () => {
  assert.equal(initials(''), '?');
  assert.equal(initials('   '), '?');
  assert.equal(initials(null), '?');
});

test('statusTone maps every bot status onto a badge tone', () => {
  assert.equal(statusTone('online'), 'ok');
  assert.equal(statusTone('connecting'), 'info');
  assert.equal(statusTone('stopping'), 'warn');
  assert.equal(statusTone('error'), 'danger');
  assert.equal(statusTone('offline'), 'muted');
});

test('statusTone is muted for anything it does not recognise', () => {
  assert.equal(statusTone('nonsense'), 'muted');
  assert.equal(statusTone(undefined), 'muted');
});

test('kindLabel names the three account kinds', () => {
  assert.equal(kindLabel('msa'), 'Microsoft');
  assert.equal(kindLabel('token'), 'Token');
  assert.equal(kindLabel('offline'), 'Offline');
});

test('kindLabel is explicit about an unknown kind', () => {
  assert.equal(kindLabel('nonsense'), 'Unknown');
  assert.equal(kindLabel(undefined), 'Unknown');
});
