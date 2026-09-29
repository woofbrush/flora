/**
 * Minecraft heads, fetched once and kept.
 *
 * A head is drawn from the cached skin whenever the backend has one. The gap is
 * every account it does not: a row that was just imported, an offline-mode
 * name, an account whose skin was never downloaded. Those used to fall back to
 * a coloured initial, which is legible but tells you nothing about the account.
 *
 * api.mcheads.org renders a head from a username alone, which fills exactly
 * that gap. It is reached from here rather than from the renderer for three
 * reasons:
 *
 *   - the PNG is written to <root>/heads/<name>.png, so it is fetched once per
 *     username and is local - and therefore instant, and available offline -
 *     from then on;
 *   - the renderer keeps `img-src 'self'` in its CSP, because what it loads is
 *     a flora:// URL like every other image in the app;
 *   - there is exactly one place in flora that talks to a third party, which is
 *     the place to look when asking what flora sends anywhere.
 *
 * What it sends is a username and nothing else: no account id, no token, no
 * batch, and no way to tell which names belong to the same person. The lookup
 * is also switchable off entirely - Settings > Appearance > Head rendering -
 * and the renderer will not ask for a name when it is off.
 */
import { net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** `/head/<name>/<size>` is a PNG. There is no `/body` endpoint. */
const ENDPOINT = 'https://api.mcheads.org/head';
/** One source size for every size the UI draws, at 2x, with room to spare. */
const SIZE = 128;
const TIMEOUT_MS = 8000;

/** Minecraft usernames, which is also the shape of an offline-mode name. */
const NAME = /^[A-Za-z0-9_]{3,16}$/;

/**
 * How long a head is trusted before it is refetched.
 *
 * Players change their skins, and a head that never updates is worse than one
 * extra request a day. Within the window the file is served straight from disk
 * with no network access at all.
 */
const FRESH_MS = 24 * 60 * 60 * 1000;
/**
 * How long to leave a name alone after a failed lookup.
 *
 * The service answers 500 both for a name that does not exist and for a fault
 * of its own, so a failure cannot be cached as permanent - the name may simply
 * not be registered yet.
 */
const RETRY_MS = 15 * 60 * 1000;

let root = null;
/** Lookups running right now, so a list of identical rows makes one call. */
const inFlight = new Map();
/** Names that recently failed, with when. Kept in memory only. */
const failedAt = new Map();

export function configure(dir) {
  root = dir;
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch { /* a read-only data root is survivable: heads just re-download */ }
}

/** Whether a string could be a Minecraft username at all. */
export const isName = (name) => typeof name === 'string' && NAME.test(name);

const keyFor = (name) => name.toLowerCase();
const fileFor = (name) => path.join(root, `${keyFor(name)}.png`);

function statOf(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0 ? stat : null;
  } catch {
    return null;
  }
}

/** The cached head for a name, if it is still fresh. */
export function freshPath(name) {
  if (!root || !isName(name)) return null;
  const file = fileFor(name);
  const stat = statOf(file);
  if (!stat) return null;
  return Date.now() - stat.mtimeMs < FRESH_MS ? file : null;
}

/** The cached head for a name, however old. Used when a refresh fails. */
export function anyPath(name) {
  if (!root || !isName(name)) return null;
  const file = fileFor(name);
  return statOf(file) ? file : null;
}

async function download(name) {
  let response;
  try {
    response = await net.fetch(`${ENDPOINT}/${encodeURIComponent(name)}/${SIZE}`, {
      // Never let this be resolved by our own protocol handler.
      bypassCustomProtocolHandlers: true,
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch {
    return false;
  }

  if (!response.ok) return false;
  if (!(response.headers.get('content-type') ?? '').startsWith('image/')) return false;

  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    return false;
  }
  // Shorter than a PNG's own signature and first chunk: an error page wearing
  // an image content-type, not a head.
  if (buffer.length < 128) return false;

  const file = fileFor(name);
  const tmp = `${file}.${process.pid}.part`;
  try {
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    return false;
  }
}

/**
 * Make sure a head for `name` is on disk.
 *
 * Concurrent asks for the same name share one request, and a name that failed
 * recently is not asked for again until the cooldown expires. Resolves to
 * whether a usable file exists afterwards.
 */
export function ensure(name) {
  if (!root || !isName(name)) return Promise.resolve(false);

  const key = keyFor(name);
  const running = inFlight.get(key);
  if (running) return running;

  const failed = failedAt.get(key);
  if (failed && Date.now() - failed < RETRY_MS) {
    // Still worth serving a stale copy if there is one.
    return Promise.resolve(Boolean(anyPath(name)));
  }

  const request = download(name)
    .then((ok) => {
      if (ok) failedAt.delete(key);
      else failedAt.set(key, Date.now());
      return ok || Boolean(anyPath(name));
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, request);
  return request;
}

/**
 * The response for `flora://app/head/<name>.png`.
 *
 * Built here rather than in the router so that every path out of this module -
 * a fresh file, a refreshed one, a stale one kept after a failed refresh, and
 * no file at all - carries the caching header that matches what it is.
 */
export async function headResponse(name) {
  const notFound = () => new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=900' }
  });

  if (!isName(name)) return notFound();

  const fresh = freshPath(name);
  if (fresh) return send(fresh, 86400);

  const ok = await ensure(name);
  if (ok) return send(fileFor(name), 86400);

  // A refresh that failed is not a reason to stop drawing a head.
  const stale = anyPath(name);
  if (stale) return send(stale, 300);

  return notFound();
}

/** Serve a file through Electron's own file handling. */
function send(file, maxAge) {
  const response = net.fetch(pathToFileURL(file).toString());
  // `net.fetch` hands back a promise; the header has to be set on the
  // response, so this is returned as a promise the router awaits.
  return response.then((res) => {
    res.headers.set('content-type', 'image/png');
    res.headers.set('cache-control', `public, max-age=${maxAge}`);
    return res;
  });
}

/** How many heads are on disk and how much room they take. */
export function cacheStats() {
  if (!root) return { files: 0, bytes: 0 };
  try {
    let files = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(root)) {
      if (!entry.endsWith('.png')) continue;
      const stat = statOf(path.join(root, entry));
      if (!stat) continue;
      files += 1;
      bytes += stat.size;
    }
    return { files, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

/** Drop every cached head. The next look at the page refetches what it needs. */
export function clearCache() {
  if (!root) return 0;
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(root)) {
      try { fs.unlinkSync(path.join(root, entry)); removed += 1; } catch { /* locked */ }
    }
  } catch { /* missing */ }
  failedAt.clear();
  return removed;
}
