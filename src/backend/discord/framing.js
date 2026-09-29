/**
 * The Discord IPC wire format.
 *
 * Kept apart from the connection so it can be tested without a socket, because
 * it is the part that cannot be checked by eye: a frame is a fixed 8-byte
 * header and a JSON body, and getting either endianness wrong produces a
 * connection that opens, accepts everything and shows nothing, which is
 * indistinguishable from Discord simply not being there.
 *
 * The layout, in full:
 *
 *   bytes 0..3   op, little-endian uint32
 *   bytes 4..7   length of the body, little-endian uint32
 *   bytes 8..    that many bytes of UTF-8 JSON
 *
 * There is no terminator and no padding, so a reader cannot find frame
 * boundaries without the length, and a frame can arrive in pieces.
 */

/** Frame kinds. The numbers are Discord's, not flora's. */
export const OP = Object.freeze({
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4
});

/** One frame, ready to write. */
export function encodeFrame(op, payload) {
  const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op >>> 0, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

/**
 * A stateful reader.
 *
 * Returns a function to feed chunks to, which yields every whole frame that
 * became available and holds the remainder for the next one. A frame whose body
 * does not parse is yielded with `payload: null` rather than dropped, because
 * the op still has to be acted on - a PING that cannot be read is still a PING.
 */
export function createParser() {
  let buffer = Buffer.alloc(0);

  return function feed(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    const frames = [];

    while (buffer.length >= 8) {
      const op = buffer.readUInt32LE(0);
      const length = buffer.readUInt32LE(4);
      if (buffer.length < 8 + length) break;

      const body = buffer.subarray(8, 8 + length).toString('utf8');
      buffer = buffer.subarray(8 + length);

      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        // Left null deliberately; see the note above.
      }
      frames.push({ op, payload });
    }

    return frames;
  };
}
