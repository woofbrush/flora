/**
 * The proxy-aware HTTP client.
 *
 * This is the one piece of flora that opens a socket by hand, and the proxied
 * path passes `agent: null` with a `createConnection` override - an arrangement
 * where getting it wrong still compiles, still runs, and quietly stops using
 * the proxy. So the proxy here is real: a CONNECT server on a loopback port
 * that records what it was asked to tunnel, and the assertion is that the
 * request actually went through it rather than merely that it succeeded.
 *
 * Loopback and a listening socket are fine in tests/ - what preflight forbids
 * is the app doing it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { send, HttpError, dialThrough } from '../src/backend/net/http.js';
import { startSocks } from './helpers/socks5.js';

/** A target that answers the handful of shapes the client has to handle. */
function startTarget() {
  const server = http.createServer((req, res) => {
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (req.url === '/json') return json(200, { ok: true, method: req.method, auth: req.headers.authorization ?? null });
    if (req.url === '/empty') { res.writeHead(204); return res.end(); }
    if (req.url === '/forbidden') return json(403, { errorMessage: 'The access token is not valid.' });
    if (req.url === '/throttled') return json(429, { error: 'Too many requests' }, { 'retry-after': '2' });
    if (req.url === '/broken') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('not json at all'); }
    if (req.url === '/bytes') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from([1, 2, 3, 4, 5])); }
    if (req.url === '/hang') return; // never answers
    return json(404, { message: 'no such route' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      url: (route) => `http://127.0.0.1:${server.address().port}${route}`,
      close: () => new Promise((done) => server.close(done))
    }));
  });
}

/** A CONNECT proxy, and the list of destinations it was asked for. */
function startProxy({ credentials = null } = {}) {
  const tunnels = [];
  const server = http.createServer((req, res) => {
    res.writeHead(405).end();
  });

  server.on('connect', (req, clientSocket, head) => {
    if (credentials) {
      const expected = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
      if (req.headers['proxy-authorization'] !== expected) {
        clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
    }

    tunnels.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      tunnels,
      port: server.address().port,
      row: { host: '127.0.0.1', port: server.address().port, protocol: 'http', username: '', password: '' },
      close: () => new Promise((done) => server.close(done))
    }));
  });
}

/**
 * The SOCKS5 server used to live here; it moved to ./helpers/socks5.js when the
 * bot connection tests needed the same one. The assertion worth making is
 * unchanged - that flora's SOCKS path interoperates with a real handshake,
 * including the username/password sub-negotiation.
 */

test('a direct request parses a JSON body', async (t) => {
  const target = await startTarget();
  t.after(() => target.close());

  const response = await send(target.url('/json'));
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { ok: true, method: 'GET', auth: null });
});

test('a token becomes a bearer header', async (t) => {
  const target = await startTarget();
  t.after(() => target.close());

  const { data } = await send(target.url('/json'), { token: 'abc123' });
  assert.equal(data.auth, 'Bearer abc123');
});

test('204 resolves with no body rather than throwing', async (t) => {
  const target = await startTarget();
  t.after(() => target.close());

  const response = await send(target.url('/empty'));
  assert.equal(response.status, 204);
  assert.equal(response.data, null);
});

test('the same request goes through a proxy when one is given', async (t) => {
  const target = await startTarget();
  const proxy = await startProxy();
  t.after(() => Promise.all([target.close(), proxy.close()]));

  const response = await send(target.url('/json'), { proxy: proxy.row });

  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
  // The point of the test: the request arrived through the tunnel, not around it.
  assert.equal(proxy.tunnels.length, 1);
  assert.equal(proxy.tunnels[0], `127.0.0.1:${target.port}`);
});

test('proxy credentials are sent when the proxy has them', async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({ credentials: { username: 'user', password: 'pass' } });
  t.after(() => Promise.all([target.close(), proxy.close()]));

  const response = await send(target.url('/json'), {
    proxy: { ...proxy.row, username: 'user', password: 'pass' }
  });

  assert.equal(response.data.ok, true);
  assert.equal(proxy.tunnels.length, 1);
});

test('a proxy that refuses the credentials fails the request', async (t) => {
  const target = await startTarget();
  const proxy = await startProxy({ credentials: { username: 'user', password: 'pass' } });
  t.after(() => Promise.all([target.close(), proxy.close()]));

  await assert.rejects(
    () => send(target.url('/json'), { proxy: { ...proxy.row, username: 'user', password: 'wrong' } }),
    (err) => err instanceof HttpError && /407/.test(err.message)
  );
  assert.equal(proxy.tunnels.length, 0);
});

test('a JSON error body becomes an HttpError with its status', async (t) => {
  const target = await startTarget();
  t.after(() => target.close());

  await assert.rejects(
    () => send(target.url('/forbidden')),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 403);
      assert.equal(err.authFailed, true);
      assert.equal(err.rateLimited, false);
      // Mojang's own wording reaches the caller rather than a generic string.
      assert.equal(err.message, 'The access token is not valid.');
      return true;
    }
  );
});

test('429 carries the retry-after delay in milliseconds', async (t) => {
  const target = await startTarget();
  t.after(() => target.close());

  await assert.rejects(
    () => send(target.url('/throttled')),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.rateLimited, true);
      assert.equal(err.retryAfterMs, 2000);
      return true;
    }
  );
});

test('a body that is not JSON is still reported', async (t) => {
  const target = await startTarget();
  t.after(() => target.close());

  await assert.rejects(
    () => send(target.url('/broken')),
    (err) => err.status === 500 && /not json at all/.test(JSON.stringify(err.body))
  );
});

test('binary mode hands back the bytes untouched', async (t) => {
  const target = await startTarget();
  t.after(() => target.close());

  const { data } = await send(target.url('/bytes'), { binary: true });
  assert.ok(Buffer.isBuffer(data));
  assert.deepEqual([...data], [1, 2, 3, 4, 5]);
});

test('a request that never answers gives up on its own', async (t) => {
  const target = await startTarget();
  t.after(() => target.close());

  await assert.rejects(
    () => send(target.url('/hang'), { timeout: 200 }),
    (err) => err instanceof HttpError && /timed out/.test(err.message)
  );
});

test('a proxy that is not listening fails rather than hanging', async (t) => {
  const target = await startTarget();
  t.after(() => target.close());

  // Port 1 on loopback: nothing is ever bound there.
  const dead = { host: '127.0.0.1', port: 1, protocol: 'socks5', username: '', password: '' };
  await assert.rejects(() => dialThrough(dead, { host: '127.0.0.1', port: target.port }, 2000));
});

test('a SOCKS5 proxy carries the request', async (t) => {
  const target = await startTarget();
  const proxy = await startSocks();
  t.after(() => Promise.all([target.close(), proxy.close()]));

  const response = await send(target.url('/json'), { proxy: proxy.row });

  assert.equal(response.data.ok, true);
  assert.equal(proxy.tunnels.length, 1);
  assert.equal(proxy.tunnels[0], `127.0.0.1:${target.port}`);
});

test('a SOCKS5 proxy with a username and password authenticates', async (t) => {
  const target = await startTarget();
  const proxy = await startSocks({ credentials: { username: 'user', password: 'pass' } });
  t.after(() => Promise.all([target.close(), proxy.close()]));

  const response = await send(target.url('/json'), { proxy: proxy.row });

  assert.equal(response.data.ok, true);
  assert.equal(proxy.tunnels.length, 1);
});

test('the wrong SOCKS5 password is refused', async (t) => {
  const target = await startTarget();
  const proxy = await startSocks({ credentials: { username: 'user', password: 'pass' } });
  t.after(() => Promise.all([target.close(), proxy.close()]));

  await assert.rejects(
    () => send(target.url('/json'), { proxy: { ...proxy.row, password: 'wrong' } })
  );
  assert.equal(proxy.tunnels.length, 0);
});

test('the proxy is dialled before the request is written', async (t) => {
  const target = await startTarget();
  const proxy = await startProxy();
  t.after(() => Promise.all([target.close(), proxy.close()]));

  // The tunnel is built by dialThrough; this asserts the socket it returns is
  // already connected, which is what lets the client write immediately.
  const socket = await dialThrough(proxy.row, { host: '127.0.0.1', port: target.port }, 3000);
  assert.equal(socket.readyState, 'open');
  socket.destroy();
  assert.equal(proxy.tunnels.length, 1);
});
