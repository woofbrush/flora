/**
 * Proxied connections.
 *
 * minecraft-protocol has no notion of a proxy: its transport opens a bare
 * `net.connect` to the server. It does, however, let a caller replace
 * `options.connect`, which is the hook used here - the proxy tunnel is opened
 * first and the resulting stream is handed to the client.
 *
 * Two consequences worth knowing about:
 *
 *   - SRV resolution is ours to do. The default transport looks up
 *     `_minecraft._tcp.<host>` when the port is 25565 and the host is not an
 *     IP; replacing `connect` means replacing that too, otherwise every proxied
 *     bot would fail on servers that rely on SRV records.
 *
 *   - `setSocket` re-emits the socket's own `'connect'` event. By the time a
 *     tunnel is established that event has already fired, so the client is
 *     nudged with a manual emit - the same thing minecraft-protocol does for a
 *     pre-existing stream.
 *
 * The hook is called as `connect(client)` and nothing else. minecraft-protocol
 * reaches it from four places - createClient's offline branch, the server-list
 * ping that `version: false` triggers, and the tail of both its own
 * microsoftAuth and flora's token auth - and every one of them passes the client
 * alone. The host and port are therefore closed over here rather than read from
 * a second parameter, which is the shape that made every bot fail to start with
 * "Cannot read properties of undefined (reading 'stream')".
 */
import net from 'node:net';
import dns from 'node:dns';
import { SocksClient } from 'socks';
import { logger } from '../logging/logger.js';

/**
 * Resolve a server address, honouring SRV records.
 *
 * A failure to resolve SRV is not fatal - it means the host is connected to
 * directly, which is the common case.
 */
export async function resolveTarget(host, port) {
  const isIp = net.isIP(host) !== 0;
  const isLocal = host === 'localhost' || host.endsWith('.localhost');

  if (port !== 25565 || isIp || isLocal) return { host, port };

  try {
    const records = await dns.promises.resolveSrv(`_minecraft._tcp.${host}`);
    if (records?.length) {
      // Lowest priority first, then heaviest weight - the same ordering a
      // client is expected to apply.
      const best = [...records].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
      return { host: best.name, port: best.port, srv: true };
    }
  } catch { /* no SRV record; connect directly */ }

  return { host, port };
}

/** Tunnel through a SOCKS proxy and return a connected socket. */
async function openSocks(proxy, destination, timeout) {
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type: proxy.protocol === 'socks4' ? 4 : 5,
      userId: proxy.username || undefined,
      password: proxy.password || undefined
    },
    command: 'connect',
    destination,
    timeout
  });
  return socket;
}

/**
 * Tunnel through an HTTP proxy with CONNECT.
 *
 * Node has no built-in CONNECT helper and the popular agent packages bring a
 * dependency tree this app does not otherwise need, so the request is written
 * by hand. The socket becomes the tunnel once the proxy answers 200.
 */
function openHttp(proxy, destination, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    let buffer = Buffer.alloc(0);

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);

      if (err) {
        socket.destroy();
        reject(err);
        return;
      }

      // Anything past the response headers is already server data; put it back
      // so the handshake reader sees it.
      const separator = buffer.indexOf('\r\n\r\n');
      const remainder = buffer.subarray(separator + 4);
      if (remainder.length) socket.unshift(remainder);

      resolve(socket);
    };

    const timer = setTimeout(() => finish(new Error(`The proxy did not respond within ${timeout}ms.`)), timeout);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        // A proxy that never terminates its headers is not one we can use.
        if (buffer.length > 16384) finish(new Error('The proxy sent an oversized response.'));
        return;
      }

      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buffer.toString('latin1', 0, 64));
      if (!status) return finish(new Error('The proxy sent a malformed response.'));
      if (status[1] === '200') return finish(null);
      return finish(new Error(`The proxy refused the tunnel (HTTP ${status[1]}).`));
    };

    socket.on('data', onData);
    socket.once('error', (err) => finish(new Error(err.message)));
    socket.once('close', () => finish(new Error('The proxy closed the connection before responding.')));

    socket.once('connect', () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT ${destination.host}:${destination.port} HTTP/1.1\r\n` +
        `Host: ${destination.host}:${destination.port}\r\n` +
        auth +
        'Proxy-Connection: keep-alive\r\n\r\n'
      );
    });
  });
}

/**
 * Build a minecraft-protocol `connect` function that routes through `proxy`.
 *
 * `options` is the mineflayer options object the hook will be attached to; its
 * host and port are what gets dialled. When `proxy` is null the default
 * behaviour is reproduced faithfully, so the direct and proxied paths differ
 * only by the tunnel.
 */
export function connectThrough(proxy, options = {}) {
  const timeout = 20000;

  // Captured, not received. See the note at the top of this file: the hook is
  // invoked as `connect(client)` by every call site in minecraft-protocol, so a
  // second parameter would always arrive undefined.
  const { host, port, stream } = options;

  return function floraConnect(client) {
    // A caller-supplied stream always wins; it is a deliberate override.
    if (stream) {
      client.setSocket(stream);
      client.emit('connect');
      return;
    }

    let cancelled = false;
    client.once('end', () => { cancelled = true; });

    (async () => {
      const destination = await resolveTarget(host, port);
      if (cancelled) return;

      if (!proxy) {
        const socket = net.connect({ host: destination.host, port: destination.port });
        client.setSocket(socket);
        return;
      }

      const socket = proxy.protocol === 'http'
        ? await openHttp(proxy, destination, timeout)
        : await openSocks(proxy, destination, timeout);

      if (cancelled) { socket.destroy(); return; }

      // Order matters: the socket is already connected, so attach it first and
      // then signal readiness - the listener setSocket adds can no longer fire.
      client.setSocket(socket);
      client.emit('connect');

      logger.debug('bots', `Tunnelled to ${destination.host}:${destination.port} via ${proxy.protocol} ${proxy.host}:${proxy.port}.`);
    })().catch((err) => {
      if (cancelled) return;
      client.emit('error', new Error(`Proxy connection failed: ${err.message}`));
      client.end('proxyFailed');
    });
  };
}
