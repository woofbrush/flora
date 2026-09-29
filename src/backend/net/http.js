/**
 * The HTTP client.
 *
 * One function, two transports. Without a proxy a request goes out over the
 * global agent exactly as `fetch` would have sent it; with one, the socket is
 * opened by hand through the proxy first and the request is written down that
 * tunnel.
 *
 * Why not `fetch` with a dispatcher: the only dispatcher undici ships that
 * knows about proxies speaks HTTP CONNECT, and half the pools people paste into
 * flora are SOCKS5. `socks` is already a dependency for the bot connections, so
 * the tunnel is built from the same code the bots use and behaves the same way
 * in both places.
 *
 * The proxied path passes `agent: null` plus a `createConnection` function.
 * That is the one documented way to hand Node's HTTP client a socket you
 * opened yourself, and it avoids subclassing Agent and having to reproduce its
 * pooling, which is where hand-rolled proxy agents usually go wrong.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { SocksClient } from 'socks';

const DEFAULT_TIMEOUT = 15000;

export class HttpError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    // 401/403 means the credential is dead and the account needs re-adding.
    this.authFailed = status === 401 || status === 403;
    // 429 means slow down; callers back off rather than retrying immediately.
    this.rateLimited = status === 429;
  }
}

// ------------------------------------------------------------------ tunnels

/**
 * Open a raw TCP socket to `destination` through `proxy`.
 *
 * `proxy` is a row from the proxies table: { host, port, username, password,
 * protocol }. Credentials may be blank, which is normal for a residential
 * endpoint that authenticates by IP.
 */
export async function dialThrough(proxy, destination, timeout) {
  if (proxy.protocol === 'http') return dialHttpConnect(proxy, destination, timeout);

  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: proxy.host,
      port: Number(proxy.port),
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
 * HTTP CONNECT tunnel.
 *
 * The proxy answers with a status line and a header block; everything after the
 * blank line is already the tunnelled stream, so any bytes that arrived in the
 * same packet are pushed back onto the socket rather than dropped.
 */
function dialHttpConnect(proxy, destination, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: Number(proxy.port) });
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onFail);
      socket.removeListener('close', onClose);
      if (err) { socket.destroy(); reject(err); }
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error(`Proxy timed out after ${timeout}ms`)), timeout);
    const onFail = (err) => finish(new Error(err.message));
    const onClose = () => finish(new Error('Proxy closed the connection before responding.'));

    socket.on('connect', () => {
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

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');

      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        // A proxy that has not finished its header block after 8KB is not
        // something to keep waiting on.
        if (buffer.length > 8192) finish(new Error('The proxy sent an oversized response.'));
        return;
      }

      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buffer);
      if (!status) return finish(new Error('The proxy did not speak HTTP.'));
      if (status[1] !== '200') return finish(new Error(`The proxy refused the tunnel (HTTP ${status[1]}).`));

      const rest = Buffer.from(buffer.slice(end + 4), 'latin1');

      // Pausing is what keeps bytes that arrive after this handler is removed
      // from being dropped on the floor. The catch is that a paused socket
      // stays paused: attaching a 'data' listener to it does not restart the
      // flow once something has explicitly stopped it. So the resume is
      // scheduled rather than left to the caller - nextTick, because whoever
      // receives this socket attaches its own listeners synchronously.
      socket.pause();
      socket.removeListener('data', onData);
      if (rest.length) socket.unshift(rest);
      process.nextTick(() => {
        if (!socket.destroyed) socket.resume();
      });
      finish(null, socket);
    };

    socket.on('data', onData);
    socket.on('error', onFail);
    socket.on('close', onClose);
  });
}

/**
 * The `createConnection` Node's HTTP client calls when `agent` is null.
 *
 * Returns a socket that is already connected - and, for an https request,
 * already past its TLS handshake - so the first write goes out immediately
 * instead of being queued behind a handshake the client does not know about.
 */
function connectThrough(proxy, timeout) {
  return function createConnection(options, callback) {
    const secure = options.protocol === 'https:';
    const destination = {
      host: options.hostname || options.host,
      port: Number(options.port) || (secure ? 443 : 80)
    };

    let settled = false;
    const finish = (err, socket) => {
      if (settled) return;
      settled = true;
      callback(err, socket);
    };

    dialThrough(proxy, destination, timeout).then((socket) => {
      if (!secure) { finish(null, socket); return; }

      // The tunnel carries plain TCP, so TLS is negotiated on top of it here.
      // `servername` is what makes SNI and the certificate check use the real
      // host rather than the proxy's address.
      const secured = tls.connect({
        socket,
        servername: destination.host,
        rejectUnauthorized: true
      }, () => finish(null, secured));
      secured.once('error', (err) => finish(new Error(`TLS handshake failed: ${err.message}`)));
    }, (err) => finish(err));
  };
}

// ----------------------------------------------------------------- requests

/**
 * Read one response to completion.
 *
 * `binary` decides whether the body is parsed as JSON or handed back as a
 * Buffer; the skin download wants the bytes and everything else wants the
 * object, and they share every other line of this.
 */
export function send(url, {
  method = 'GET',
  token = null,
  body = null,
  headers = {},
  timeout = DEFAULT_TIMEOUT,
  proxy = null,
  binary = false
} = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new HttpError('That is not a valid URL.', { status: 0 }));
      return;
    }

    const secure = target.protocol === 'https:';
    const transport = secure ? https : http;

    const options = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (secure ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        Accept: binary ? '*/*' : 'application/json',
        // Asked for explicitly: a transparently gzipped body would otherwise
        // arrive as bytes this client has no decoder for.
        'Accept-Encoding': 'identity',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers
      },
      // Only the proxied path supplies a connector. Leaving the option off
      // entirely keeps the direct path on the global agent and its keep-alive
      // pool, which is what it was doing before any of this existed.
      ...(proxy ? { agent: null, createConnection: connectThrough(proxy, timeout) } : {})
    };

    // Declared before the timer so the timeout callback has something to
    // destroy, and so a synchronous throw from `transport.request` below still
    // clears the timer on the way out.
    let request;
    const timer = setTimeout(
      () => request?.destroy(new HttpError(`Request timed out after ${timeout}ms`, { status: 0 })),
      timeout
    );

    try {
      request = transport.request(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', (err) => {
        clearTimeout(timer);
        reject(new HttpError(err.message, { status: 0 }));
      });
      response.on('end', () => {
        clearTimeout(timer);
        const payload = Buffer.concat(chunks);
        const status = response.statusCode ?? 0;

        if (status >= 200 && status < 300) {
          if (binary) { resolve({ status, data: payload, headers: response.headers }); return; }
          resolve({ status, data: parseJson(payload), headers: response.headers });
          return;
        }

        const data = parseJson(payload);
        // Mojang reports failures as { error, errorMessage, path }; other
        // endpoints just use { message }.
        const detail = data?.errorMessage || data?.message || data?.error || response.statusMessage;
        const err = new HttpError(detail || `Request failed (${status})`, { status, body: data });

        if (status === 429) {
          const retryAfter = Number(response.headers['retry-after']);
          if (Number.isFinite(retryAfter)) err.retryAfterMs = retryAfter * 1000;
        }
        reject(err);
      });
    });

    } catch (err) {
      clearTimeout(timer);
      reject(err instanceof HttpError ? err : new HttpError(err.message || 'Could not start the request.', { status: 0 }));
      return;
    }

    request.on('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof HttpError ? err : new HttpError(err.message || 'Network request failed', { status: 0 }));
    });

    if (body) request.write(body);
    request.end();
  });
}

/** Parse a body that may be empty or may not be JSON at all. */
function parseJson(buffer) {
  const text = buffer.toString('utf8');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export { DEFAULT_TIMEOUT };
