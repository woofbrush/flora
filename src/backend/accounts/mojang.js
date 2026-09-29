/**
 * Mojang API client.
 *
 * The only outbound HTTP in flora, and every call here is one Microsoft
 * exposes for account holders to manage their own profile:
 *
 *   POST   api.minecraftservices.com/minecraft/profile/skins          - set a skin
 *   DELETE api.minecraftservices.com/minecraft/profile/skins/active   - reset to default
 *   GET    api.minecraftservices.com/minecraft/profile                - verify a token
 *   GET    api.minecraftservices.com/minecraft/profile/name/X/available - is X free
 *   PUT    api.minecraftservices.com/minecraft/profile/name/X         - rename
 *   POST   api.minecraftservices.com/player/certificates              - chat signing keys
 *   GET    sessionserver.mojang.com/session/minecraft/profile         - name + skin URL
 *   GET    textures.minecraft.net/skin/<hash>                         - the skin PNG
 *
 * There is no third-party service anywhere in here: heads are rendered locally
 * from the skin PNG rather than fetched from an avatar CDN, so no host learns
 * which accounts the user holds.
 *
 * Every call takes an optional `proxy`, a row from the proxies table. Bulk work
 * is the reason it exists - forty skins set from one address is the pattern
 * these endpoints rate limit, and forty skins set from forty addresses is not.
 * The transport that honours it is ../net/http.js.
 */
import { createPublicKey, createPrivateKey } from 'node:crypto';
import { send, HttpError } from '../net/http.js';

const SERVICES = 'https://api.minecraftservices.com';
const SESSION = 'https://sessionserver.mojang.com';
const TEXTURES = 'https://textures.minecraft.net';

const DEFAULT_TIMEOUT = 15000;

export class ApiError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    // 401/403 means the credential is dead and the account needs re-adding.
    this.authFailed = status === 401 || status === 403;
    // 429 means slow down; callers back off rather than retrying immediately.
    this.rateLimited = status === 429;
  }
}

/**
 * The shape every caller already expects.
 *
 * ../net/http.js has its own error class, and letting it escape would mean
 * anything checking `err.authFailed` - the bulk account check, the skin runner,
 * the reconnect policy - silently stopped matching. Translating here keeps this
 * module's contract exactly as it was and confines the new transport to one
 * place.
 */
function asApiError(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof HttpError) {
    const wrapped = new ApiError(err.message, { status: err.status, body: err.body });
    if (err.retryAfterMs) wrapped.retryAfterMs = err.retryAfterMs;
    return wrapped;
  }
  return new ApiError(err?.message || 'Network request failed', { status: 0 });
}

async function request(url, { method = 'GET', token, body, headers = {}, timeout = DEFAULT_TIMEOUT, proxy = null } = {}) {
  try {
    return await send(url, { method, token, body, headers, timeout, proxy });
  } catch (err) {
    throw asApiError(err);
  }
}

/** Strip dashes: Mojang's session server wants a bare 32-char hex id. */
export const undash = (uuid) => String(uuid ?? '').replace(/-/g, '').toLowerCase();

const patterns = {
  uuid: /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i,
  name: /^[A-Za-z0-9_]{3,16}$/
};

export function isValidUuid(value) { return patterns.uuid.test(String(value ?? '')); }

export function isValidName(value) { return patterns.name.test(String(value ?? '')); }

/**
 * The account's own profile. Doubles as the token validity check: a 401 here
 * means the access token is expired or revoked.
 */
export async function fetchOwnProfile(token, { timeout, proxy } = {}) {
  const { data } = await request(`${SERVICES}/minecraft/profile`, { token, timeout, proxy });
  if (!data?.id) throw new ApiError('Profile response did not include an id.', { status: 0, body: data });

  return {
    uuid: undash(data.id),
    name: data.name ?? '',
    skins: (data.skins ?? []).map((s) => ({
      id: s.id ?? null,
      state: s.state ?? null,
      url: s.url ?? null,
      variant: s.variant ?? null
    })),
    capes: (data.capes ?? []).map((c) => ({
      id: c.id ?? null,
      state: c.state ?? null,
      url: c.url ?? null,
      alias: c.alias ?? null
    }))
  };
}

/** Check a token without throwing. Used by the bulk "check accounts" action. */
export async function probeToken(token, { timeout, proxy } = {}) {
  try {
    const profile = await fetchOwnProfile(token, { timeout, proxy });
    return { ok: true, profile };
  } catch (err) {
    return {
      ok: false,
      status: err.status ?? 0,
      authFailed: Boolean(err.authFailed),
      error: err.message
    };
  }
}

/**
 * The account's chat signing key pair.
 *
 * From 1.19 a client signs the chat it sends, and the server checks the
 * signature against a public key the account registered with Mojang. This is
 * where that key pair comes from: an RSA key pair made for the account, with
 * Mojang's signature over the public half, plus the two timestamps that say how
 * long it is good for.
 *
 * Worth being precise about what breaks without it, because none of it is
 * visible from flora: with no key pair, minecraft-protocol cannot create a chat
 * session, so every message the bot sends goes out unsigned. A server running
 * the default `enforce-secure-profile=true` then rejects that chat, and on
 * 1.19-1.19.2 it kicks the bot on join with "Chat disabled due to missing
 * profile public key".
 *
 * The key pair is a credential - the private half signs as the account - so it
 * is never written to disk here. It is held for the life of the process by
 * bots/chatKeys.js and refetched when Mojang says it has gone stale.
 */
export async function fetchChatKeys(token, { timeout, proxy } = {}) {
  const { data } = await request(`${SERVICES}/player/certificates`, { method: 'POST', token, timeout, proxy });

  const publicPEM = data?.keyPair?.publicKey;
  const privatePEM = data?.keyPair?.privateKey;
  if (!publicPEM || !privatePEM) {
    throw new ApiError('The key pair response was missing a key.', { status: 0, body: data });
  }

  // DER as well as PEM: the wire format wants the raw key bytes, and the two
  // KeyObjects are what minecraft-protocol signs and verifies with.
  const publicDER = toDER(publicPEM);
  const privateDER = toDER(privatePEM);

  return {
    publicPEM,
    privatePEM,
    publicDER,
    privateDER,
    public: createPublicKey({ key: publicDER, format: 'der', type: 'spki' }),
    private: createPrivateKey({ key: privateDER, format: 'der', type: 'pkcs8' }),
    // Two signatures over the same public key. A 1.19 server wants the first,
    // 1.19.1 and later want the second; minecraft-protocol picks by version.
    signature: Buffer.from(data.publicKeySignature ?? '', 'base64'),
    signatureV2: Buffer.from(data.publicKeySignatureV2 ?? '', 'base64'),
    // Both timestamps have a fallback, because a Date built from a missing
    // field is Invalid, and every comparison against it is false - which would
    // mean refetching on every single start rather than once an hour.
    expiresOn: timestampOr(data.expiresAt, 24 * 60 * 60 * 1000),
    refreshAfter: timestampOr(data.refreshedAfter, 60 * 60 * 1000)
  };
}

/** A Date from Mojang, or now + `fallbackMs` when the field is unusable. */
function timestampOr(value, fallbackMs) {
  const at = new Date(value ?? NaN);
  return Number.isFinite(at.getTime()) ? at : new Date(Date.now() + fallbackMs);
}

/** PEM to DER, the same way prismarine-auth does it, so the bytes match. */
function toDER(pem) {
  return String(pem)
    .split('\n')
    .slice(1, -1)
    .reduce((acc, line) => Buffer.concat([acc, Buffer.from(line, 'base64')]), Buffer.alloc(0));
}

/**
 * Public profile for any UUID: current name and the signed texture blob.
 * No authentication required, and it is rate limited to roughly one lookup
 * per second per IP, so callers should batch and cache rather than loop.
 */
export async function fetchProfileByUuid(uuid, { timeout, proxy } = {}) {
  const id = undash(uuid);
  if (!isValidUuid(id)) throw new ApiError('Not a valid UUID.', { status: 0 });

  try {
    const { data } = await request(`${SESSION}/session/minecraft/profile/${id}`, { timeout, proxy });
    return data ? { uuid: id, name: data.name ?? '', properties: data.properties ?? [] } : null;
  } catch (err) {
    // 204/404 both mean "no such profile" rather than a transport failure.
    if (err.status === 204 || err.status === 404) return null;
    throw err;
  }
}

/**
 * Decode the base64 `textures` property into URLs.
 * The property value is base64 JSON: { textures: { SKIN: { url }, CAPE: {...} } }.
 */
export function decodeTextures(properties = []) {
  const prop = properties.find((p) => p.name === 'textures');
  if (!prop?.value) return { skinUrl: null, capeUrl: null, model: null };

  try {
    const decoded = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
    const skin = decoded?.textures?.SKIN;
    const cape = decoded?.textures?.CAPE;
    return {
      skinUrl: skin?.url ?? null,
      capeUrl: cape?.url ?? null,
      // "slim" means Alex-style 3px arms; anything else is classic.
      model: skin?.metadata?.model === 'slim' ? 'slim' : skin ? 'classic' : null
    };
  } catch {
    return { skinUrl: null, capeUrl: null, model: null };
  }
}

/** Name + skin URL for a UUID, in one call. Returns null for an unknown UUID. */
export async function lookupProfile(uuid, { timeout, proxy } = {}) {
  const raw = await fetchProfileByUuid(uuid, { timeout, proxy });
  if (!raw) return null;
  const textures = decodeTextures(raw.properties);
  return { uuid: raw.uuid, name: raw.name, ...textures };
}

/**
 * Download a skin PNG.
 *
 * The URL is checked against the textures host first: it arrives inside a
 * signed property, but treating it as trusted input would make this an open
 * fetch primitive the moment that assumption changes.
 */
export async function downloadSkin(url, { timeout = DEFAULT_TIMEOUT, proxy = null } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ApiError('Skin URL is not a valid URL.', { status: 0 });
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'textures.minecraft.net') {
    throw new ApiError('Refusing to download a skin from an unexpected host.', { status: 0 });
  }

  let payload;
  try {
    ({ data: payload } = await send(parsed.toString(), { timeout, proxy, binary: true }));
  } catch (err) {
    const wrapped = asApiError(err);
    // The transport reports the status; a skin fetch that failed for transport
    // reasons reads better as a skin fetch that failed.
    if (wrapped.status) throw new ApiError(`Skin download failed (${wrapped.status})`, { status: wrapped.status });
    throw wrapped;
  }

  if (!Buffer.isBuffer(payload) || payload.length < 64) {
    throw new ApiError('Skin file is implausibly small.', { status: 0 });
  }
  if (payload.length > 2 * 1024 * 1024) throw new ApiError('Skin file is larger than 2MB.', { status: 0 });
  return payload;
}

/**
 * Read a PNG's dimensions straight from the IHDR chunk.
 *
 * Avoids pulling in an image library just to learn whether a file is 64x64 or
 * 64x32 - both are valid skins and the difference decides how the head is
 * sampled.
 */
export function readPngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const signature = buffer.subarray(0, 8);
  const isPng = signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isPng) return null;
  if (buffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** True when the PNG declares the slim arm width in its metadata chunk. */
export function readSkinModel(buffer) {
  const size = readPngSize(buffer);
  if (!size) return null;
  // Only 64x64 skins can carry a model marker; 64x32 is always classic.
  if (size.width !== 64 || size.height !== 64) return 'classic';

  const text = buffer.toString('latin1');
  if (text.includes('"model":"slim"') || text.includes('"model": "slim"')) return 'slim';
  return 'classic';
}

/**
 * Upload a skin to an account.
 *
 * `png` must be a 64x64 or 64x32 PNG. Mojang rejects anything else, and
 * rejecting locally first gives a much better error message than a 400.
 */
export async function uploadSkin({ token, png, model = 'classic', timeout = 30000, proxy = null }) {
  const size = readPngSize(png);
  if (!size) throw new ApiError('That file is not a PNG.', { status: 0 });
  if (size.width !== 64 || (size.height !== 64 && size.height !== 32)) {
    throw new ApiError(
      `Skin must be 64x64 or 64x32 pixels (this one is ${size.width}x${size.height}).`,
      { status: 0 }
    );
  }

  const variant = model === 'slim' ? 'slim' : 'classic';

  // Multipart is required, but hand-rolling it avoids a dependency: the body
  // is one file part and one text part.
  const boundary = `----flora${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const parts = [];

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="variant"\r\n\r\n` +
    `${variant}\r\n`
  ));
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="skin.png"\r\n` +
    `Content-Type: image/png\r\n\r\n`
  ));
  parts.push(png);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const { data } = await request(`${SERVICES}/minecraft/profile/skins`, {
    method: 'POST',
    token,
    body,
    timeout,
    proxy,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
  });

  return { ok: true, variant, profile: data ?? null };
}

/** Remove the active skin, returning the account to the default Steve/Alex. */
export async function resetSkin({ token, timeout = DEFAULT_TIMEOUT, proxy = null }) {
  await request(`${SERVICES}/minecraft/profile/skins/active`, { method: 'DELETE', token, timeout, proxy });
  return { ok: true };
}

/**
 * Look up a UUID by username. Used to fill in the UUID for a name-only import.
 * Mojang retired the old bulk endpoint; this uses the current one.
 */
export async function uuidForName(name, { timeout = DEFAULT_TIMEOUT, proxy = null } = {}) {
  if (!isValidName(name)) throw new ApiError('Not a valid Minecraft username.', { status: 0 });
  const { data } = await request(
    `${SERVICES}/minecraft/profile/${encodeURIComponent(name)}`,
    { timeout, proxy }
  );
  if (!data?.id) return null;
  return { uuid: undash(data.id), name: data.name ?? name };
}

// ------------------------------------------------------------------ rename

/**
 * Whether a name can be taken.
 *
 * Needs the account's own token. The older api.mojang.com endpoint answered
 * anonymously; this one does not, and a request without a bearer token comes
 * back as a bare 401. So the check is per-account for two reasons: it needs a
 * credential, and it leaves through that account's proxy.
 *
 * The three answers are the whole vocabulary of the endpoint:
 *
 *   AVAILABLE   - free, and allowed
 *   DUPLICATE   - an account already holds it
 *   NOT_ALLOWED - free, but filtered (profanity, or reserved)
 *
 * A name that does not exist reads as NOT_ALLOWED rather than an error, which
 * is why the caller should treat anything unexpected as "cannot check".
 */
export async function nameAvailable(name, { token = null, timeout = DEFAULT_TIMEOUT, proxy = null } = {}) {
  const wanted = String(name ?? '').trim();
  if (!isValidName(wanted)) return { name: wanted, status: 'INVALID' };

  const { data } = await request(
    `${SERVICES}/minecraft/profile/name/${encodeURIComponent(wanted)}/available`,
    { token, timeout, proxy }
  );

  const status = String(data?.status ?? '').toUpperCase();
  return {
    name: wanted,
    status: status === 'AVAILABLE' || status === 'DUPLICATE' || status === 'NOT_ALLOWED' ? status : 'UNKNOWN'
  };
}

/**
 * Rename an account.
 *
 * Mojang allows one change every 30 days and answers 403 when the account is
 * still inside that window. That is a normal outcome here, not a failure, so it
 * is turned into a sentence the user can act on rather than a status code.
 */
export async function changeName({ token, name, timeout = 30000, proxy = null }) {
  const wanted = String(name ?? '').trim();
  if (!isValidName(wanted)) {
    throw new ApiError('A username is 3 to 16 characters, letters, numbers and underscores only.', { status: 0 });
  }

  try {
    const { data } = await request(
      `${SERVICES}/minecraft/profile/name/${encodeURIComponent(wanted)}`,
      { method: 'PUT', token, timeout, proxy }
    );
    return { ok: true, name: data?.name ?? wanted, profile: data ?? null };
  } catch (err) {
    const code = String(err.body?.error ?? '').toUpperCase();

    if (code === 'ALREADY_SET') {
      throw new ApiError('That account is already using that username.', { status: err.status });
    }
    if (err.status === 403) {
      throw new ApiError(
        'Mojang refused the change. An account can only be renamed once every 30 days, ' +
        'and this name may also be blocked.',
        { status: 403, body: err.body }
      );
    }
    if (err.status === 400) {
      throw new ApiError('Mojang rejected that username as not allowed.', { status: 400, body: err.body });
    }
    throw err;
  }
}

export { SERVICES, SESSION, TEXTURES };
