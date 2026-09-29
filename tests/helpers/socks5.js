/**
 * A minimal SOCKS5 server, for tests that need a proxy which really proxies.
 *
 * Shared by the HTTP client tests and the bot connection tests. Both need the
 * same thing - a tunnel that records where it was asked to go - and asserting
 * against a real handshake is the only way to catch a proxy path that silently
 * stopped being used.
 *
 * Only what a CONNECT needs: the greeting, the optional username/password
 * sub-negotiation (how most residential endpoints are sold), and the request.
 * ATYP 0x01 and 0x03 are understood, which covers every address a test dials.
 */
import net from 'node:net';

export function startSocks({ credentials = null } = {}) {
  const tunnels = [];
  // net.Server.close() waits for every open connection to end, so a test whose
  // client is still attached never sees its after-hook resolve. Tracking the
  // sockets makes close() mean close.
  const sockets = new Set();

  const server = net.createServer((socket) => {
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);
    const send = (bytes) => socket.write(Buffer.from(bytes));

    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === 'greeting') {
        if (buffer.length < 2) return;
        const count = buffer[1];
        if (buffer.length < 2 + count) return;
        const methods = [...buffer.subarray(2, 2 + count)];
        buffer = buffer.subarray(2 + count);

        const wanted = credentials ? 0x02 : 0x00;
        if (!methods.includes(wanted)) { send([0x05, 0xff]); socket.destroy(); return; }
        send([0x05, wanted]);
        stage = credentials ? 'auth' : 'request';
      }

      if (stage === 'auth') {
        if (buffer.length < 2) return;
        const userLength = buffer[1];
        if (buffer.length < 3 + userLength) return;
        const passLength = buffer[2 + userLength];
        if (buffer.length < 3 + userLength + passLength) return;

        const user = buffer.subarray(2, 2 + userLength).toString();
        const pass = buffer.subarray(3 + userLength, 3 + userLength + passLength).toString();
        buffer = buffer.subarray(3 + userLength + passLength);

        if (user !== credentials.username || pass !== credentials.password) {
          send([0x01, 0x01]);
          socket.destroy();
          return;
        }
        send([0x01, 0x00]);
        stage = 'request';
      }

      if (stage === 'request') {
        if (buffer.length < 5) return;
        const atyp = buffer[3];
        let host;
        let port;
        let consumed;

        if (atyp === 0x01) {
          if (buffer.length < 10) return;
          host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
          port = buffer.readUInt16BE(8);
          consumed = 10;
        } else if (atyp === 0x03) {
          const length = buffer[4];
          if (buffer.length < 7 + length) return;
          host = buffer.subarray(5, 5 + length).toString();
          port = buffer.readUInt16BE(5 + length);
          consumed = 7 + length;
        } else {
          // Address type not supported.
          send([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
          socket.destroy();
          return;
        }

        const rest = buffer.subarray(consumed);
        buffer = Buffer.alloc(0);
        stage = 'open';
        tunnels.push(`${host}:${port}`);

        const upstream = net.connect(port, host, () => {
          // Success, with a zeroed bound address - which is what a server that
          // does not care about its own bind address sends.
          send([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
          if (rest.length) upstream.write(rest);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      tunnels,
      port: server.address().port,
      row: {
        host: '127.0.0.1',
        port: server.address().port,
        protocol: 'socks5',
        username: credentials?.username ?? '',
        password: credentials?.password ?? ''
      },
      close: () => new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(done);
      })
    }));
  });
}
