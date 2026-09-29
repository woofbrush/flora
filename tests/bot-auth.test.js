/**
 * What flora's custom `auth` does for a token account.
 *
 * This is the bug the whole chat-keys change exists to fix, so it is pinned
 * down from the outside: drive the auth function minecraft-protocol calls, with
 * a client and an options object that look enough like the real ones, and check
 * what it did to them.
 *
 * The rule that matters is an ordering one, and it is invisible in the source:
 *
 *   client.profileKeys must be set BEFORE options.connect is called
 *
 * because minecraft-protocol reads profileKeys while it is writing the login
 * packets that `connect` triggers. Setting them afterwards is the same as not
 * setting them at all, and nothing anywhere reports an error.
 *
 * The key resolver is injected, so no Mojang account or network is involved.
 * `manager.js` pulls in mineflayer, which is slow to load but loads the same
 * way the backend worker loads it - which is itself worth checking, since a
 * module that parses can still throw on import.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flora-botauth-'));
process.env.FLORA_DATA_DIR = dataDir;

const { tokenAuthFactory } = await import('../src/backend/bots/manager.js');

test.after(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows lock */ }
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Enough of a minecraft-protocol client to be driven by the auth function. */
function fakeClient() {
  const emitted = [];
  return {
    session: null,
    username: null,
    uuid: null,
    profileKeys: null,
    emit(event, payload) { emitted.push({ event, payload }); },
    emitted
  };
}

function fakeOptions() {
  const connected = [];
  return {
    username: 'flora_bot',
    connect(client) { connected.push(client); },
    connected
  };
}

const credential = (extra = {}) => ({
  accountId: 7,
  token: 'stored-access-token',
  profile: { id: '0123456789abcdef0123456789abcdef', name: 'flora_bot' },
  proxy: null,
  ...extra
});

const keys = (refreshIn = HOUR) => ({
  publicPEM: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----',
  signature: Buffer.from('sig'),
  signatureV2: Buffer.from('sig2'),
  refreshAfter: new Date(Date.now() + refreshIn),
  expiresOn: new Date(Date.now() + 24 * HOUR)
});

/** Let the auth function's continuation run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the session mineflayer needs is set synchronously', () => {
  const client = fakeClient();
  const options = fakeOptions();

  tokenAuthFactory(credential(), async () => ({ keys: keys(), reason: null }))(client, options);

  // Before any await: createClient reads these straight after this returns.
  assert.equal(client.username, 'flora_bot');
  assert.equal(client.uuid, '0123456789abcdef0123456789abcdef');
  assert.equal(client.session.accessToken, 'stored-access-token');
  assert.equal(client.session.selectedProfile.name, 'flora_bot');
  assert.equal(options.haveCredentials, true);
  assert.equal(options.accessToken, 'stored-access-token');
  assert.ok(client.emitted.some((e) => e.event === 'session'));
});

test('keys land on the client before connect is called', async () => {
  const client = fakeClient();
  const options = fakeOptions();
  const pair = keys();

  tokenAuthFactory(credential(), async () => ({ keys: pair, reason: null }))(client, options);

  // Nothing may connect while the keys are still in flight.
  assert.equal(options.connected.length, 0, 'connect ran before the keys were known');

  await settle();

  assert.equal(client.profileKeys, pair);
  assert.equal(options.connected.length, 1);
  assert.equal(options.connected[0], client);
});

test('the account id, token and proxy are what the fetch is given', async () => {
  const client = fakeClient();
  const options = fakeOptions();
  const proxy = { host: '10.0.0.9', port: 1080 };
  const seen = [];

  const auth = tokenAuthFactory(credential({ accountId: 42, proxy }), async (args) => {
    seen.push(args);
    return { keys: keys(), reason: null };
  });
  auth(client, options);
  await settle();

  assert.deepEqual(seen, [{ accountId: 42, token: 'stored-access-token', proxy }]);
});

test('no keys still connects, and says why', async () => {
  const client = fakeClient();
  const options = fakeOptions();
  const told = [];

  tokenAuthFactory(
    credential({ onKeyIssue: (reason) => told.push(reason) }),
    async () => ({ keys: null, reason: 'Mojang refused the request.' })
  )(client, options);
  await settle();

  assert.equal(client.profileKeys, null);
  assert.equal(options.connected.length, 1, 'a bot with unsigned chat is still a usable bot');
  assert.deepEqual(told, ['Mojang refused the request.']);
});

test('a resolver that throws does not stop the connection', async () => {
  const client = fakeClient();
  const options = fakeOptions();
  const told = [];

  tokenAuthFactory(
    credential({ onKeyIssue: (reason) => told.push(reason) }),
    async () => { throw new Error('the network is gone'); }
  )(client, options);
  await settle();

  assert.equal(options.connected.length, 1);
  assert.deepEqual(told, ['the network is gone']);
});

test('a missing onKeyIssue is not itself a failure', async () => {
  const client = fakeClient();
  const options = fakeOptions();

  tokenAuthFactory(credential(), async () => { throw new Error('nope'); })(client, options);
  await settle();

  assert.equal(options.connected.length, 1);
});

test('a connect that throws goes onto the client rather than nowhere', async () => {
  const client = fakeClient();
  const options = {
    username: 'flora_bot',
    connect() { throw new Error('the proxy refused the tunnel'); }
  };

  tokenAuthFactory(credential(), async () => ({ keys: keys(), reason: null }))(client, options);
  await settle();

  // Nothing threw past the auth function, and mineflayer is told, which is how
  // it reaches flora's error handler instead of becoming an unhandled rejection.
  const errors = client.emitted.filter((e) => e.event === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].payload.message, /proxy refused/);
});

test('the auth function itself never throws, even with nothing resolvable', async () => {
  const client = fakeClient();
  const options = fakeOptions();

  // A credential with no token at all: resolveChatKeys reports it rather than
  // fetching, and the bot must still be connected.
  const auth = tokenAuthFactory(
    { accountId: 1, token: '', profile: null, proxy: null },
    async () => ({ keys: null, reason: 'No access token to fetch keys with.' })
  );

  assert.doesNotThrow(() => auth(client, options));
  await settle();

  assert.equal(options.connected.length, 1);
  assert.equal(client.uuid, null, 'no profile id means no uuid to set');
});

test('a profile with no id leaves the uuid alone rather than blanking it', async () => {
  const client = fakeClient();
  const options = fakeOptions();

  tokenAuthFactory(
    { accountId: 2, token: 'tok', profile: { id: null, name: 'named' }, proxy: null },
    async () => ({ keys: keys(), reason: null })
  )(client, options);
  await settle();

  assert.equal(client.uuid, null);
  assert.equal(client.username, 'named');
});

test('the keys are not handed out a second time for the same start', async () => {
  const client = fakeClient();
  const options = fakeOptions();
  let calls = 0;

  tokenAuthFactory(credential(), async () => { calls += 1; return { keys: keys(), reason: null }; })(client, options);
  await settle();

  assert.equal(calls, 1);
});
