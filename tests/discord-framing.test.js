/**
 * The Discord IPC frame format.
 *
 * This is the one part of Rich Presence that cannot be checked by looking at
 * the app: a wrong endianness or a length that counts characters instead of
 * bytes produces a connection that opens cleanly, accepts every write, and
 * shows nothing at all - which is exactly what a user sees when Discord simply
 * is not running. So the layout is asserted byte for byte here, and the reader
 * is driven the way a socket delivers: in pieces, and with more than one frame
 * in a read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { OP, encodeFrame, createParser } from '../src/backend/discord/framing.js';

/** The header of a frame, as the four numbers it is made of. */
function header(frame) {
  return {
    op: frame.readUInt32LE(0),
    length: frame.readUInt32LE(4)
  };
}

test('a handshake frame is an 8-byte header and a JSON body', () => {
  const body = { v: 1, client_id: '1234567890' };
  const frame = encodeFrame(OP.HANDSHAKE, body);

  const { op, length } = header(frame);
  assert.equal(op, 0);
  assert.equal(length, Buffer.byteLength(JSON.stringify(body)));
  assert.equal(frame.length, 8 + length);
  assert.deepEqual(JSON.parse(frame.subarray(8).toString('utf8')), body);
});

test('the length counts bytes, not characters', () => {
  // A body with a multi-byte character is where a character count would drift
  // and take every later frame on the connection with it.
  const frame = encodeFrame(OP.FRAME, { details: 'café — bots' });
  const { length } = header(frame);
  const body = frame.subarray(8);

  assert.equal(length, body.length);
  assert.notEqual(length, body.toString('utf8').length);
});

test('the op is written little-endian', () => {
  // 0x01000000 read the wrong way round would be op 1, so this is checked with
  // an op whose two halves differ rather than with the small ones in use.
  const frame = encodeFrame(OP.PONG, {});
  assert.equal(frame[0], 4);
  assert.equal(frame[1], 0);
  assert.equal(frame[2], 0);
  assert.equal(frame[3], 0);
});

test('a frame split across reads is yielded once, whole', () => {
  const parser = createParser();
  const frame = encodeFrame(OP.FRAME, { cmd: 'SET_ACTIVITY', nonce: '1' });

  // Header only, then the first half of the body, then the rest.
  assert.deepEqual(parser(frame.subarray(0, 8)), []);
  const half = 8 + Math.floor((frame.length - 8) / 2);
  assert.deepEqual(parser(frame.subarray(8, half)), []);

  const frames = parser(frame.subarray(half));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].op, OP.FRAME);
  assert.deepEqual(frames[0].payload, { cmd: 'SET_ACTIVITY', nonce: '1' });
});

test('two frames arriving in one read are both yielded, in order', () => {
  const parser = createParser();
  const both = Buffer.concat([
    encodeFrame(OP.PING, { first: true }),
    encodeFrame(OP.FRAME, { second: true })
  ]);

  const frames = parser(both);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].op, OP.PING);
  assert.deepEqual(frames[0].payload, { first: true });
  assert.equal(frames[1].op, OP.FRAME);
  assert.deepEqual(frames[1].payload, { second: true });
});

test('the remainder of a partial frame is kept for the next read', () => {
  const parser = createParser();
  const first = encodeFrame(OP.FRAME, { a: 1 });
  const second = encodeFrame(OP.FRAME, { b: 2 });

  // A read that ends in the middle of the second frame.
  const cut = first.length + 10;
  const frames = parser(Buffer.concat([first, second]).subarray(0, cut));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].payload, { a: 1 });

  const rest = parser(Buffer.concat([first, second]).subarray(cut));
  assert.equal(rest.length, 1);
  assert.deepEqual(rest[0].payload, { b: 2 });
});

test('a body that is not JSON still yields its op', () => {
  // Discord's half of the protocol is not flora's to guarantee. A frame that
  // cannot be read must not become a frame that cannot be answered.
  const header = Buffer.alloc(8);
  header.writeUInt32LE(OP.PING, 0);
  header.writeUInt32LE(5, 4);
  const frame = Buffer.concat([header, Buffer.from('notjs', 'utf8')]);

  const frames = createParser()(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].op, OP.PING);
  assert.equal(frames[0].payload, null);
});

test('a zero-length body is a frame, not a stall', () => {
  // JSON.stringify(undefined) is not a string, so this cannot be produced by
  // encodeFrame; a hand-built frame is the only way to see one. The point is
  // that a length of zero advances the reader instead of looping on it.
  const header = Buffer.alloc(8);
  header.writeUInt32LE(OP.PONG, 0);
  header.writeUInt32LE(0, 4);

  const frames = createParser()(header);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].op, OP.PONG);
  assert.equal(frames[0].payload, null);
});

test('a read shorter than a header is not lost', () => {
  const parser = createParser();
  const frame = encodeFrame(OP.FRAME, { ok: true });

  assert.deepEqual(parser(frame.subarray(0, 3)), []);
  // The three bytes are held and complete the frame with the rest of it.
  const frames = parser(frame.subarray(3));
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].payload, { ok: true });
});
