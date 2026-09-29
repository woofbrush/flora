/**
 * Skins.
 *
 * Two directions:
 *
 *   fetch  - resolve an account's current skin, download the PNG once, and
 *            cache it under skins/<hash>.png. The renderer draws heads from
 *            that local file, so scrolling a list of a thousand accounts makes
 *            no network requests and no third-party avatar service ever sees
 *            which accounts the user has.
 *
 *   push   - upload a PNG to one or many accounts at once, in parallel but
 *            rate-limited, with per-account results so a partial failure is
 *            reported honestly instead of being swallowed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { skinCacheDir, headCacheDir } from '../paths.js';
import { bus, EVENTS } from '../events.js';
import { logger } from '../logging/logger.js';
import * as mojang from '../accounts/mojang.js';
import * as repo from '../accounts/repo.js';
import { withCredential, mapLimit } from '../accounts/service.js';
import { apiProxyFor, apiConcurrency } from '../proxies/service.js';

/** Absolute path of a cached skin, or null when the hash is unknown. */
export function skinPath(hash) {
  if (!hash || !/^[a-f0-9]{8,64}$/i.test(hash)) return null;
  const file = path.join(skinCacheDir(), `${hash}.png`);
  return fs.existsSync(file) ? file : null;
}

/** Store a skin buffer in the cache and return its content hash. */
export function cacheSkin(buffer) {
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 32);
  const file = path.join(skinCacheDir(), `${hash}.png`);
  if (!fs.existsSync(file)) {
    // Write to a temporary name first: a half-written PNG that a renderer
    // reads mid-copy is worse than no file at all.
    const tmp = `${file}.${process.pid}.part`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, file);
  }
  return hash;
}

export function readSkin(hash) {
  const file = skinPath(hash);
  return file ? fs.readFileSync(file) : null;
}

/**
 * Resolve and cache an account's current skin.
 *
 * Returns `{ hash, model, url }`, or `{ hash: null, reason }` when the account
 * has no skin to fetch - which is a normal outcome, not an error.
 *
 * The proxy is resolved once here and used for all three requests this can make
 * rather than being looked up per call. In "rotate" mode each lookup picks a
 * different endpoint, so asking twice would send the profile read and the skin
 * download out through two different addresses for no reason.
 */
export async function fetchSkin(accountId, { force = false } = {}) {
  const account = repo.getById(accountId);
  if (!account) throw new Error('Account not found.');

  if (!force && account.skin_hash && skinPath(account.skin_hash)) {
    return { hash: account.skin_hash, model: account.skin_model, url: null, cached: true };
  }

  const proxy = apiProxyFor(Number(accountId));
  let skinUrl = null;
  let model = null;

  if (account.kind === 'offline') {
    // Offline accounts have no Mojang skin, but they can still have a UUID
    // whose textures we can read from the public session server.
    if (!account.uuid) return { hash: null, reason: 'This offline account has no UUID.' };
    const profile = await mojang.lookupProfile(account.uuid, { proxy });
    if (!profile?.skinUrl) {
      repo.update(accountId, { skinHash: null, skinModel: null });
      return { hash: null, reason: 'No skin on record for that UUID.' };
    }
    skinUrl = profile.skinUrl;
    model = profile.model;
  } else {
    const profile = await withCredential(accountId, (token) => mojang.fetchOwnProfile(token, { proxy }));
    const active = profile.skins.find((s) => s.state === 'ACTIVE') ?? profile.skins[0] ?? null;
    if (!active?.url) {
      repo.update(accountId, { skinHash: null, skinModel: null });
      return { hash: null, reason: 'This account is using the default skin.' };
    }
    skinUrl = active.url;
    model = active.variant ?? null;
  }

  const png = await mojang.downloadSkin(skinUrl, { proxy });
  const hash = cacheSkin(png);

  // Mojang's `variant` is authoritative when present; otherwise read the model
  // out of the PNG's own metadata.
  const resolvedModel = model === 'slim' ? 'slim' : (model === 'classic' ? 'classic' : mojang.readSkinModel(png));

  repo.update(accountId, { skinHash: hash, skinModel: resolvedModel });
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'skin', id: accountId });

  return { hash, model: resolvedModel, url: skinUrl, cached: false };
}

/**
 * Fetch skins for many accounts.
 *
 * Narrow by default: the session server rate limits per IP, and a burst of
 * parallel lookups is the fastest way to get temporarily blocked. Behind a
 * proxy pool that ceiling is the pool's, not one address's, so the width is
 * asked for rather than assumed.
 */
export async function fetchSkinsFor(ids, { concurrency = apiConcurrency(2, 6), force = false } = {}) {
  const list = [...new Set(ids.map(Number).filter(Number.isFinite))];
  if (!list.length) return { results: [], counts: { total: 0, cached: 0, fetched: 0, none: 0, failed: 0 } };

  bus.emit(EVENTS.BUSY, { scope: 'skins', active: true, total: list.length });

  const results = await mapLimit(list, concurrency, async (id) => {
    try {
      const result = await fetchSkin(id, { force });
      return { id, ...result, ok: Boolean(result.hash) };
    } catch (err) {
      return { id, ok: false, hash: null, error: err.message };
    }
  }, {
    onProgress: (done, total) => bus.emit(EVENTS.SKIN_PROGRESS, { done, total })
  });

  const tally = results.reduce((acc, r) => {
    acc.total += 1;
    if (!r.ok) acc.failed += 1;
    else if (r.cached) acc.cached += 1;
    else if (r.hash) acc.fetched += 1;
    else acc.none += 1;
    return acc;
  }, { total: 0, cached: 0, fetched: 0, none: 0, failed: 0 });

  bus.emit(EVENTS.BUSY, { scope: 'skins', active: false });
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'skins-refreshed' });
  return { results, counts: tally };
}

/**
 * Apply a skin PNG to one account.
 *
 * Rejects offline accounts up front with an explanation rather than letting
 * the API call fail: a skin is a Mojang account feature, and an offline-mode
 * username has no account to attach it to.
 */
export async function applySkin(accountId, { png, model }) {
  const account = repo.getById(accountId);
  if (!account) throw new Error('Account not found.');

  if (account.kind === 'offline') {
    throw new Error('Offline-mode accounts cannot have a skin. It needs a real Microsoft account.');
  }

  const size = mojang.readPngSize(png);
  if (!size) throw new Error('That file is not a PNG.');
  if (size.width !== 64 || (size.height !== 64 && size.height !== 32)) {
    throw new Error(`Skin must be 64x64 or 64x32 pixels (got ${size.width}x${size.height}).`);
  }

  await withCredential(accountId, (token, cred) => mojang.uploadSkin({ token, png, model, proxy: cred.proxy }));

  // The account's skin is now whatever we just uploaded, so update the cache
  // immediately instead of re-downloading it from Mojang.
  const hash = cacheSkin(png);
  repo.update(accountId, { skinHash: hash, skinModel: model === 'slim' ? 'slim' : 'classic' });

  return { id: accountId, ok: true, hash };
}

export async function resetSkin(accountId) {
  const account = repo.getById(accountId);
  if (!account) throw new Error('Account not found.');
  if (account.kind === 'offline') throw new Error('Offline-mode accounts have no skin to reset.');

  await withCredential(accountId, (token, cred) => mojang.resetSkin({ token, proxy: cred.proxy }));
  repo.update(accountId, { skinHash: null, skinModel: null });
  return { id: accountId, ok: true };
}

/**
 * Apply one skin to many accounts.
 *
 * Deliberately modest concurrency: Microsoft's profile endpoints are stricter
 * than the read-only ones, and applying a skin to a hundred accounts at once
 * from one address is exactly the pattern that gets a client throttled. With
 * proxies on, that is the constraint that has been lifted, so the width widens
 * with the pool.
 */
export async function applySkinToMany(ids, { png, model, concurrency = apiConcurrency(3, 8), onEach = null }) {
  const list = [...new Set(ids.map(Number).filter(Number.isFinite))];
  if (!list.length) throw new Error('No accounts selected.');
  if (!Buffer.isBuffer(png) || png.length === 0) throw new Error('No skin image provided.');

  bus.emit(EVENTS.BUSY, { scope: 'apply-skin', active: true, total: list.length });

  const results = await mapLimit(list, concurrency, async (id) => {
    const account = repo.getById(id);
    try {
      await applySkin(id, { png, model });
      const result = { id, ok: true, username: account?.username ?? '' };
      onEach?.(result);
      bus.emit(EVENTS.SKIN_APPLIED, result);
      return result;
    } catch (err) {
      const result = { id, ok: false, username: account?.username ?? '', error: err.message };
      onEach?.(result);
      bus.emit(EVENTS.SKIN_APPLIED, result);
      return result;
    }
  }, {
    onProgress: (done, total) => bus.emit(EVENTS.SKIN_PROGRESS, { done, total })
  });

  const tally = results.reduce((acc, r) => {
    acc.total += 1;
    if (r.ok) acc.applied += 1; else acc.failed += 1;
    return acc;
  }, { total: list.length, applied: 0, failed: 0 });

  bus.emit(EVENTS.BUSY, { scope: 'apply-skin', active: false });
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'skins-applied', ids: list });
  logger.info('skins', `Applied a skin to ${tally.applied}/${tally.total} accounts.`);

  return { results, counts: tally };
}

/**
 * Copy the skin already on one account onto a set of others.
 *
 * The source account's cached PNG is reused when present, so copying a skin
 * across a hundred alts costs one download rather than a hundred.
 */
export async function copySkinFrom(sourceId, targetIds, { model = null, concurrency = apiConcurrency(3, 8) } = {}) {
  const source = repo.getById(sourceId);
  if (!source) throw new Error('Source account not found.');

  let png = source.skinHash ? readSkin(source.skinHash) : null;
  if (!png) {
    const fetched = await fetchSkin(sourceId, { force: true });
    if (!fetched.hash) throw new Error(fetched.reason || 'That account has no skin to copy.');
    png = readSkin(fetched.hash);
  }
  if (!png) throw new Error('Could not read the source account skin.');

  const resolvedModel = model ?? source.skinModel ?? mojang.readSkinModel(png) ?? 'classic';

  // Never re-upload to the source itself: it already has this skin.
  const targets = targetIds.map(Number).filter((id) => Number.isFinite(id) && id !== Number(sourceId));

  const result = await applySkinToMany(targets, { png, model: resolvedModel, concurrency });
  return { ...result, source: { id: source.id, username: source.username }, model: resolvedModel };
}

/**
 * Cache statistics for the Settings > Data panel.
 *
 * Skins and heads are counted together: they are one cache to the person
 * clearing it, and the panel offers one button.
 */
export function cacheStats() {
  const skins = dirStats(skinCacheDir());
  const heads = dirStats(headCacheDir());
  return {
    files: skins.files + heads.files,
    bytes: skins.bytes + heads.bytes,
    skinFiles: skins.files,
    headFiles: heads.files
  };
}

/** Count the files in a cache directory and total their size. */
function dirStats(dir) {
  try {
    let files = 0;
    let bytes = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.png')) continue;
      try {
        bytes += fs.statSync(path.join(dir, f)).size;
        files += 1;
      } catch { /* raced with a delete */ }
    }
    return { files, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

export function clearCache() {
  // Skins first. The rows still point at hashes that no longer exist, so they
  // are cleared too: otherwise the next fetch sees a hash, finds no file, and
  // shows a blank head forever instead of downloading a new one.
  const removed = emptyDir(skinCacheDir());
  emptyDir(headCacheDir());
  return removed;
}

function emptyDir(dir) {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.png')) continue;
      try { fs.unlinkSync(path.join(dir, f)); removed += 1; } catch { /* locked */ }
    }
  } catch { /* missing */ }
  return removed;
}
