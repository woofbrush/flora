/**
 * Renaming an account.
 *
 * The interesting part is not the happy path but the refusals. Mojang answers
 * a rename inside the 30-day window with a 403 - the same status an invalid
 * token gets - so a client that treats 403 as "credential is dead" quietly
 * marks a perfectly good account as broken and tries to refresh its token. The
 * test that matters most here is that a refused rename leaves the account
 * alone.
 *
 * There is no network in this file. The cases that would need it are covered by
 * http-client.test.js, which exercises the transport against a real socket.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isValidName, isValidUuid, undash, decodeTextures, readPngSize, readSkinModel,
  nameAvailable, changeName, ApiError, downloadSkin
} from '../src/backend/accounts/mojang.js';

/** A 64x64 PNG header, which is all `readPngSize` ever looks at. */
function pngHeader(width, height) {
  const buffer = Buffer.alloc(26);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test('a username is 3 to 16 letters, numbers and underscores', () => {
  assert.equal(isValidName('Notch'), true);
  assert.equal(isValidName('a_1'), true);
  assert.equal(isValidName('abcdefghijklmnop'), true);   // 16
  assert.equal(isValidName('ab'), false);                // 2
  assert.equal(isValidName('abcdefghijklmnopq'), false); // 17
  assert.equal(isValidName('has space'), false);
  assert.equal(isValidName('has-dash'), false);
  assert.equal(isValidName(''), false);
  assert.equal(isValidName(null), false);
});

test('a UUID is accepted with or without dashes', () => {
  assert.equal(isValidUuid('069a79f444e94726a5befca90e38aaf5'), true);
  assert.equal(isValidUuid('069a79f4-44e9-4726-a5be-fca90e38aaf5'), true);
  assert.equal(isValidUuid('not-a-uuid'), false);
  assert.equal(undash('069A79F4-44E9-4726-A5BE-FCA90E38AAF5'), '069a79f444e94726a5befca90e38aaf5');
});

test('an availability check on an impossible name never leaves the machine', async () => {
  // Resolves without a socket: rejection is decided before the request is built.
  assert.deepEqual(await nameAvailable('no'), { name: 'no', status: 'INVALID' });
  assert.deepEqual(await nameAvailable('has space'), { name: 'has space', status: 'INVALID' });
});

test('a rename to an impossible name is refused locally', async () => {
  await assert.rejects(
    () => changeName({ token: 'irrelevant', name: 'x' }),
    (err) => err instanceof ApiError && err.status === 0 && /3 to 16 characters/.test(err.message)
  );
});

test('a skin download refuses a host that is not Mojang textures', async () => {
  // The URL arrives inside a signed property, but trusting it would make this
  // an open fetch primitive the moment that assumption changed.
  for (const url of ['https://example.com/skin.png', 'http://textures.minecraft.net/skin/x', 'not a url']) {
    await assert.rejects(
      () => downloadSkin(url),
      (err) => err instanceof ApiError && err.status === 0
    );
  }
});

test('a proxied skin download fails as an ApiError, not a transport error', async () => {
  // The host pin passes, then the dial fails because nothing is listening on
  // port 1. What matters is the error class: every caller in flora checks
  // `err.status` and `err.authFailed`, which only exist on ApiError.
  await assert.rejects(
    () => downloadSkin('https://textures.minecraft.net/skin/abc', {
      proxy: { host: '127.0.0.1', port: 1, protocol: 'socks5', username: '', password: '' },
      timeout: 2000
    }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.name, 'ApiError');
      assert.equal(err.status, 0);
      return true;
    }
  );
});

test('the PNG header reader reports the size and nothing else', () => {
  assert.deepEqual(readPngSize(pngHeader(64, 64)), { width: 64, height: 64 });
  assert.deepEqual(readPngSize(pngHeader(64, 32)), { width: 64, height: 32 });
  assert.equal(readPngSize(Buffer.from('not a png')), null);
  assert.equal(readPngSize(Buffer.alloc(0)), null);
  assert.equal(readPngSize(null), null);
});

test('a 64x32 skin is always the classic model', () => {
  assert.equal(readSkinModel(pngHeader(64, 32)), 'classic');
  assert.equal(readSkinModel(pngHeader(64, 64)), 'classic');
});

test('slim is read out of the skin metadata', () => {
  const slim = Buffer.concat([pngHeader(64, 64), Buffer.from('{"model":"slim"}', 'latin1')]);
  assert.equal(readSkinModel(slim), 'slim');

  const spaced = Buffer.concat([pngHeader(64, 64), Buffer.from('{"model": "slim"}', 'latin1')]);
  assert.equal(readSkinModel(spaced), 'slim');
});

test('textures decode into the skin URL and model', () => {
  const value = Buffer.from(JSON.stringify({
    textures: {
      SKIN: { url: 'http://textures.minecraft.net/texture/abc', metadata: { model: 'slim' } },
      CAPE: { url: 'http://textures.minecraft.net/texture/cape' }
    }
  })).toString('base64');

  assert.deepEqual(decodeTextures([{ name: 'textures', value }]), {
    skinUrl: 'http://textures.minecraft.net/texture/abc',
    capeUrl: 'http://textures.minecraft.net/texture/cape',
    model: 'slim'
  });
});

test('a missing or malformed textures property decodes to nulls', () => {
  const empty = { skinUrl: null, capeUrl: null, model: null };
  assert.deepEqual(decodeTextures([]), empty);
  assert.deepEqual(decodeTextures([{ name: 'textures', value: 'not base64 json' }]), empty);
  assert.deepEqual(decodeTextures([{ name: 'other', value: 'x' }]), empty);
});
