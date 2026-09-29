/**
 * Bot connections.
 *
 * This is the path that `connectThrough` replaces, and it is invoked by
 * minecraft-protocol as `connect(client)` - one argument - from four separate
 * places. flora's hook used to ask for a second parameter, which meant
 * `options.stream` was read off undefined and threw before a socket was ever
 * opened. Every bot start failed with "Cannot read properties of undefined
 * (reading 'stream')", on every account, direct or proxied.
 *
 * So the tests here are not unit tests of a helper: they stand up a real
 * Minecraft server, hand a real mineflayer bot the options flora builds, and
 * assert the server saw a login. A stub would have passed while the real thing
 * threw.
 *
 * Loopback and a listening socket are fine in tests/ - what preflight forbids
 * is the app doing it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import mc from 'minecraft-protocol';
import mineflayer from 'mineflayer';

import { connectThrough, resolveTarget } from '../src/backend/bots/connect.js';
import { startSocks } from './helpers/socks5.js';

/** A server that accepts logins, on an ephemeral port. */
async function startServer() {
  const server = mc.createServer({ 'online-mode': false, port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));

  const logins = [];
  server.on('login', (client) => logins.push(client.username ?? ''));

  // A bot that is still connected holds the listener open, and a test runner
  // that never sees the event loop drain hangs rather than failing. Tracking
  // the sockets lets close() actually be a close.
  const sockets = new Set();
  server.socketServer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    server,
    logins,
    // createServer hands back minecraft-protocol's own wrapper, not a net.Server.
    port: server.socketServer.address().port,
    close: () => new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      try { server.close(); } catch { /* never listened */ }
      done();
    })
  };
}

/** The options flora attaches its hook to, with the same arity. */
function optionsFor({ port, proxy = null, version = false, username = 'flora_test' }) {
  const options = {
    host: '127.0.0.1',
    port,
    username,
    auth: 'offline',
    version,
    hideErrors: true,
    checkTimeoutInterval: 30000
  };
  options.connect = connectThrough(proxy, options);
  return options;
}

/** Wait for the server to record a login, or fail loudly. */
function waitForLogin(logins, ms = 20000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = setInterval(() => {
      if (logins.length) { clearInterval(tick); resolve(logins[0]); return; }
      if (Date.now() - started > ms) { clearInterval(tick); reject(new Error('no login within ' + ms + 'ms')); }
    }, 100);
  });
}

test('the connect hook takes one argument, which is all minecraft-protocol passes', () => {
  const options = optionsFor({ port: 25565 });
  // The regression, stated directly: a hook of arity 2 reads `stream` off
  // undefined. minecraft-protocol never passes a second argument, so anything
  // expecting one is broken by construction.
  assert.equal(options.connect.length, 1);
});

test('a bot reaches login against a real server', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const bot = mineflayer.createBot(optionsFor({ port: server.port }));
  t.after(() => { try { bot.end(); } catch { /* already gone */ } });
  bot.on('error', () => { /* asserted through the server's login, not here */ });

  assert.equal(await waitForLogin(server.logins), 'flora_test');
});

test('auto-version still works, which means the ping went through the hook too', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  // flora connects with version: false, so minecraft-protocol pings the server
  // first - and that ping calls the same hook with the same single argument.
  // A fix that only covered the game socket would fail here.
  const bot = mineflayer.createBot(optionsFor({ port: server.port, version: false, username: 'auto_probe' }));
  t.after(() => { try { bot.end(); } catch { /* already gone */ } });
  bot.on('error', () => { /* asserted through the server's login */ });

  assert.equal(await waitForLogin(server.logins, 30000), 'auto_probe');
});

test('a proxied bot reaches login through the tunnel', async (t) => {
  const server = await startServer();
  const proxy = await startSocks();
  // The bot is registered for teardown first so it is detached before the
  // listeners are asked to close.
  t.after(() => { try { bot.end(); } catch { /* already gone */ } });
  t.after(() => Promise.all([server.close(), proxy.close()]));

  const bot = mineflayer.createBot(optionsFor({ port: server.port, proxy: proxy.row, username: 'proxied_bot' }));
  bot.on('error', () => { /* asserted through the server's login */ });

  assert.equal(await waitForLogin(server.logins), 'proxied_bot');

  // The point of the test: the connection arrived through the tunnel rather
  // than around it. version: false also pings, so there may be two.
  assert.ok(proxy.tunnels.length >= 1, 'the proxy was never used');
  for (const tunnel of proxy.tunnels) {
    assert.equal(tunnel, `127.0.0.1:${server.port}`);
  }
});

test('a proxy that is not listening fails the bot rather than hanging', async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  // Port 1 on loopback: nothing is ever bound there.
  const dead = { host: '127.0.0.1', port: 1, protocol: 'socks5', username: '', password: '' };
  const bot = mineflayer.createBot(optionsFor({ port: server.port, proxy: dead }));
  t.after(() => { try { bot.end(); } catch { /* already gone */ } });

  const failure = await new Promise((resolve) => {
    bot.once('error', resolve);
    setTimeout(() => resolve(new Error('the bot neither connected nor errored')), 25000);
  });

  assert.match(String(failure.message), /ECONNREFUSED|connect|refused/i);
  assert.equal(server.logins.length, 0);
});

test('a port that is not 25565 is dialled directly, with no SRV lookup', async () => {
  // resolveTarget is what replaced the SRV handling the default hook does; a
  // wrong answer here would send every bot to the wrong host.
  const chosen = await resolveTarget('example.com', 25566);
  assert.deepEqual(chosen, { host: 'example.com', port: 25566 });

  const literal = await resolveTarget('127.0.0.1', 25565);
  assert.deepEqual(literal, { host: '127.0.0.1', port: 25565 });
});
