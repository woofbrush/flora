/**
 * Custom protocol.
 *
 * The renderer is served over `flora://app/` rather than `file://` for one
 * concrete reason: ES modules are blocked on file URLs by Chromium's origin
 * rules, and the alternative - bundling the UI into a single script - would
 * trade a real constraint for a build step this app does not otherwise need.
 *
 * It also gives cached skins a same-origin URL. `flora://app/skin/<hash>` reads
 * from the skin cache directory, so a list of a thousand accounts loads heads
 * with no third-party request and no base64 blobs in the DOM.
 *
 * `flora://app/head/<name>` is the counterpart for accounts with no cached
 * skin. It goes through avatars.js, which fetches once from a public head
 * service and then serves the result from disk - so the renderer's CSP stays at
 * `img-src 'self'` and a head is a local file after its first view.
 *
 * There is no listener on any port, so nothing about the app is reachable from
 * outside it.
 */
import { protocol, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import * as avatars from './avatars.js';

export const SCHEME = 'flora';
export const ORIGIN = `${SCHEME}://app`;
export const ENTRY = `${ORIGIN}/index.html`;

/** Must run before `app.whenReady()`. */
export function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }]);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.map': 'application/json'
};

/**
 * Resolve a request path to a file, refusing anything that escapes its root.
 *
 * `normalise` collapses `..` before the prefix check, so a path like
 * `/../../secret.key` resolves to something outside the root and is rejected
 * rather than read.
 */
function resolveWithin(root, requestPath) {
  const clean = decodeURIComponent(requestPath).replace(/^\/+/, '');
  const target = path.normalize(path.join(root, clean));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) return null;
  return target;
}

/**
 * Build the response for a resolved path.
 *
 * Async, and awaited by both callers: `net.fetch` returns a promise, so a
 * synchronous version would hand back a promise whose `.headers` is undefined
 * and every header set on it would throw.
 */
async function serve(resolved) {
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
  } catch {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  // `net.fetch` on a file URL gives Electron's own streaming file handling,
  // which keeps large fonts and images off the main thread.
  return net.fetch(pathToFileURL(resolved).toString());
}

/**
 * Install the handler.
 *
 * `rendererRoot` is the UI directory; `skinRoot` is the cache populated by the
 * backend. Both are absolute.
 */
export function install({ rendererRoot, skinRoot }) {
  protocol.handle(SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    // Only ever serve to our own origin.
    if (url.hostname !== 'app') {
      return new Response('Not found', { status: 404 });
    }

    const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;

    if (requestPath.startsWith('/skin/')) {
      const name = requestPath.slice('/skin/'.length);
      // Skin files are content-addressed hex; anything else is a probe.
      if (!/^[a-f0-9]{8,64}\.png$/i.test(name)) {
        return new Response('Not found', { status: 404 });
      }
      const resolved = resolveWithin(skinRoot, name);
      if (!resolved) return new Response('Not found', { status: 404 });
      const response = await serve(resolved);
      // Immutable: the filename is the content hash, so a hash's bytes never
      // change and the renderer can cache aggressively.
      response.headers.set('cache-control', 'public, max-age=31536000, immutable');
      return response;
    }

    if (requestPath.startsWith('/head/')) {
      // Usernames are case-insensitive and are folded to lower case for the
      // cache filename, so `Notch` and `notch` share one download.
      const name = requestPath.slice('/head/'.length).replace(/\.png$/i, '');
      return avatars.headResponse(name);
    }

    const resolved = resolveWithin(rendererRoot, requestPath);
    if (!resolved) return new Response('Forbidden', { status: 403 });

    const ext = path.extname(resolved).toLowerCase();
    const response = await serve(resolved);
    if (response.ok && MIME[ext]) {
      response.headers.set('content-type', MIME[ext]);
    }
    // The one directive a meta element cannot carry: a browser ignores
    // `frame-ancestors` when it arrives in the markup, so it is sent here. The
    // rest of the policy lives in index.html, next to the markup it governs.
    if (ext === '.html') {
      response.headers.set('content-security-policy', "frame-ancestors 'none'");
    }
    // The UI is versioned with the app, not the network; no caching means an
    // update is visible on the next launch rather than after a cache expiry.
    response.headers.set('cache-control', 'no-cache');
    return response;
  });
}
