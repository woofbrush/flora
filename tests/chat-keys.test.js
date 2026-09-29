/**
 * Chat signing keys.
 *
 * The risky part of this feature is not the fetch, it is the bookkeeping around
 * it: which pair is still current, when to go and get another, and what to do
 * when the answer is a failure while the pair in hand is still valid. Getting
 * that wrong is invisible - a bot connects either way and the server decides
 * whether to listen to it - so it is pinned down here.
 *
 * The fetch itself is a network call to Mojang and is not tested. It is
 * injected instead, which is also the only way to reach the timing rules with a
 * clock that does not have to be waited on.
 *
 * The database is redirected before anything imports paths.js, because
 * settings.js loads it at module scope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flora-chatkeys-'));
process.env.FLORA_DATA_DIR = dataDir;

const { resolveChatKeys, forget, forgetAll, describeCache } =
  await import('../src/backend/bots/chatKeys.js');

test.after(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows lock */ }
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** A key pair shaped like the one Mojang hands back. */
function keys({ refreshIn = HOUR, expiresIn = 24 * HOUR } = {}) {
  return {
    publicPEM: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----',
    privatePEM: '-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----',
    signature: Buffer.from('signature'),
    signatureV2: Buffer.from('signatureV2'),
    refreshAfter: new Date(Date.now() + refreshIn),
    expiresOn: new Date(Date.now() + expiresIn)
  };
}

/** A fetcher that counts calls and can be told what to answer. */
function stub({ result = null, error = null, delay = 0 } = {}) {
  const calls = [];
  const fetcher = (token, options) => {
    calls.push({ token, options });
    const respond = () => {
      if (error) throw error;
      return result;
    };
    return delay ? new Promise((resolve, reject) => setTimeout(() => {
      try { resolve(respond()); } catch (err) { reject(err); }
    }, delay)) : Promise.resolve().then(respond);
  };
  fetcher.calls = calls;
  return fetcher;
}

/** Each test gets its own account id, so one test's cache cannot reach another. */
let nextId = 1000;
const freshAccount = () => (nextId += 1);

test('a token account gets the keys Mojang returned', async () => {
  const accountId = freshAccount();
  const pair = keys();
  const fetcher = stub({ result: pair });

  const { keys: got, reason } = await resolveChatKeys({ accountId, token: 'tok', fetcher });

  assert.equal(got, pair);
  assert.equal(reason, null);
  assert.equal(fetcher.calls.length, 1);
  assert.equal(fetcher.calls[0].token, 'tok');
});

test('the proxy the account uses is the proxy the fetch uses', async () => {
  const accountId = freshAccount();
  const proxy = { host: '127.0.0.2', port: 1080 };
  const fetcher = stub({ result: keys() });

  await resolveChatKeys({ accountId, token: 'tok', proxy, fetcher });

  assert.deepEqual(fetcher.calls[0].options, { proxy });
});

test('a second start inside the refresh window reuses the pair', async () => {
  const accountId = freshAccount();
  const fetcher = stub({ result: keys({ refreshIn: HOUR }) });

  const first = await resolveChatKeys({ accountId, token: 'tok', fetcher });
  const second = await resolveChatKeys({ accountId, token: 'tok', fetcher });

  assert.equal(second.keys, first.keys);
  assert.equal(fetcher.calls.length, 1, 'Mojang should have been asked once');
});

test('a start past the refresh window goes back to Mojang', async () => {
  const accountId = freshAccount();
  // Already due for replacement, so the very next call has to refetch.
  const fetcher = stub({ result: keys({ refreshIn: -MINUTE }) });

  await resolveChatKeys({ accountId, token: 'tok', fetcher });
  await resolveChatKeys({ accountId, token: 'tok', fetcher });

  assert.equal(fetcher.calls.length, 2);
});

test('a new token does not throw away a pair that is still current', async () => {
  const accountId = freshAccount();
  const fetcher = stub({ result: keys({ refreshIn: HOUR }) });

  const first = await resolveChatKeys({ accountId, token: 'old', fetcher });
  // Mojang's certificates belong to the account, not to the access token, so a
  // token rotation is not a reason to ask for a new pair.
  const second = await resolveChatKeys({ accountId, token: 'new', fetcher });

  assert.equal(second.keys, first.keys);
  assert.equal(fetcher.calls.length, 1);
});

test('parallel starts share one fetch rather than racing', async () => {
  const accountId = freshAccount();
  const fetcher = stub({ result: keys(), delay: 20 });

  const [a, b, c] = await Promise.all([
    resolveChatKeys({ accountId, token: 'tok', fetcher }),
    resolveChatKeys({ accountId, token: 'tok', fetcher }),
    resolveChatKeys({ accountId, token: 'tok', fetcher })
  ]);

  assert.equal(fetcher.calls.length, 1);
  assert.equal(a.keys, b.keys);
  assert.equal(b.keys, c.keys);
});

test('a failed refresh falls back to a pair that has not expired', async () => {
  const accountId = freshAccount();
  const good = stub({ result: keys({ refreshIn: -MINUTE, expiresIn: 12 * HOUR }) });
  const failed = stub({ error: Object.assign(new Error('offline'), { status: 500 }) });

  const first = await resolveChatKeys({ accountId, token: 'tok', fetcher: good });
  const second = await resolveChatKeys({ accountId, token: 'tok', fetcher: failed });

  assert.equal(second.keys, first.keys, 'the still-valid pair should be kept');
  assert.equal(second.reason, null, 'keeping a working pair is not a problem to report');
});

test('a failed fetch with nothing held reports a reason and no keys', async () => {
  const accountId = freshAccount();
  const fetcher = stub({ error: Object.assign(new Error('nope'), { status: 500 }) });

  const { keys: got, reason } = await resolveChatKeys({ accountId, token: 'tok', fetcher });

  assert.equal(got, null);
  assert.match(reason, /500/);
});

test('a failed fetch never throws, whatever the error looks like', async () => {
  const accountId = freshAccount();
  const fetcher = stub({ error: 'not even an Error' });

  const { keys: got, reason } = await resolveChatKeys({ accountId, token: 'tok', fetcher });

  assert.equal(got, null);
  assert.equal(typeof reason, 'string');
  assert.ok(reason.length > 0);
});

test('a dead credential is described as one, not as a status code', async () => {
  const accountId = freshAccount();
  const fetcher = stub({ error: Object.assign(new Error('unauthorized'), { status: 401, authFailed: true }) });

  const { reason } = await resolveChatKeys({ accountId, token: 'tok', fetcher });

  assert.match(reason, /signing in again/);
});

test('rate limiting is described as rate limiting', async () => {
  const accountId = freshAccount();
  const fetcher = stub({ error: Object.assign(new Error('slow down'), { status: 429, rateLimited: true }) });

  const { reason } = await resolveChatKeys({ accountId, token: 'tok', fetcher });

  assert.match(reason, /rate limiting/);
});

test('a failed fetch does not poison the next attempt', async () => {
  const accountId = freshAccount();
  const failed = stub({ error: new Error('offline') });
  const good = stub({ result: keys() });

  await resolveChatKeys({ accountId, token: 'tok', fetcher: failed });
  const second = await resolveChatKeys({ accountId, token: 'tok', fetcher: good });

  assert.ok(second.keys, 'the retry should have been allowed to succeed');
  assert.equal(second.reason, null);
});

test('no token, no account and no credential all fail closed without fetching', async () => {
  const fetcher = stub({ result: keys() });

  const noToken = await resolveChatKeys({ accountId: freshAccount(), token: '', fetcher });
  const noAccount = await resolveChatKeys({ accountId: 0, token: 'tok', fetcher });
  const nothing = await resolveChatKeys({ fetcher });

  assert.equal(noToken.keys, null);
  assert.equal(noAccount.keys, null);
  assert.equal(nothing.keys, null);
  assert.match(noToken.reason, /access token/);
  assert.equal(fetcher.calls.length, 0, 'nothing should have been asked of Mojang');
});

test('forget drops what is held, so the next start fetches again', async () => {
  const accountId = freshAccount();
  const fetcher = stub({ result: keys({ refreshIn: HOUR }) });

  await resolveChatKeys({ accountId, token: 'tok', fetcher });
  forget(accountId);
  await resolveChatKeys({ accountId, token: 'tok', fetcher });

  assert.equal(fetcher.calls.length, 2);
});

test('deleting an account takes its keys with it', async () => {
  const accountId = freshAccount();
  const fetcher = stub({ result: keys({ refreshIn: HOUR }) });

  await resolveChatKeys({ accountId, token: 'tok', fetcher });
  assert.ok(describeCache().some((row) => row.accountId === accountId));

  const { bus, EVENTS } = await import('../src/backend/events.js');
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'delete', ids: [accountId] });

  assert.ok(
    !describeCache().some((row) => row.accountId === accountId),
    'a deleted account should not still have key material held for it'
  );
});

test('a deleted account is not the same as a changed one', async () => {
  const accountId = freshAccount();
  const fetcher = stub({ result: keys({ refreshIn: HOUR }) });

  await resolveChatKeys({ accountId, token: 'tok', fetcher });

  const { bus, EVENTS } = await import('../src/backend/events.js');
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'selection', changed: [accountId] });
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'update', id: accountId });
  bus.emit(EVENTS.ACCOUNTS_CHANGED, null);

  assert.ok(describeCache().some((row) => row.accountId === accountId));
});

test('what is held is described without any key material in it', async () => {
  const accountId = freshAccount();
  const fetcher = stub({ result: keys() });

  await resolveChatKeys({ accountId, token: 'tok', fetcher });

  const row = describeCache().find((entry) => entry.accountId === accountId);
  assert.ok(row);
  assert.deepEqual(Object.keys(row).sort(), ['accountId', 'expiresOn', 'refreshAfter']);
  // A private key that leaks into a description is a private key that leaks.
  assert.ok(!JSON.stringify(row).includes('PRIVATE'));
  assert.ok(!JSON.stringify(describeCache()).includes('BEGIN'));
});

test('forgetAll empties the cache', async () => {
  const a = freshAccount();
  const b = freshAccount();
  await resolveChatKeys({ accountId: a, token: 'tok', fetcher: stub({ result: keys() }) });
  await resolveChatKeys({ accountId: b, token: 'tok', fetcher: stub({ result: keys() }) });

  forgetAll();

  assert.deepEqual(describeCache(), []);
});
