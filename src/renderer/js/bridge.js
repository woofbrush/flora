/**
 * The renderer's only route out of itself.
 *
 * Wraps `window.flora` (injected by the preload) so that every call site gets
 * the same error shape and nothing reaches for `window.flora` directly. It also
 * owns the "the backend is down" case: calls fail with a clear message rather
 * than an unhandled rejection nobody looked at.
 */

const api = window.flora;

if (!api) {
  // The preload failed to load, which means every call below would throw a
  // confusing TypeError instead of saying what is actually wrong.
  throw new Error('flora could not reach its own bridge. The preload script did not load.');
}

/** True once the backend has reported itself ready. */
let backendReady = false;
const readyWaiters = new Set();

export function isReady() {
  return backendReady;
}

export function onReady(callback) {
  if (backendReady) { callback(); return () => {}; }
  readyWaiters.add(callback);
  return () => readyWaiters.delete(callback);
}

function setReady(value) {
  if (backendReady === value) return;
  backendReady = value;
  if (value) {
    for (const waiter of readyWaiters) {
      try { waiter(); } catch { /* a bad listener must not block the rest */ }
    }
    readyWaiters.clear();
  }
}

/**
 * Invoke a backend or main-process method.
 *
 * `signal` is optional; without it the promise settles whenever the backend
 * does, which for a bulk skin upload on a slow connection can be minutes. Views
 * that can be left pass one.
 */
export async function invoke(method, params = {}, { signal = null } = {}) {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  const promise = api.invoke(method, params);

  if (!signal) return promise;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
    })
  ]);
}

/**
 * Subscribe to a push channel. Returns an unsubscribe function.
 *
 * `backend:state` is intercepted so `isReady()` stays accurate without every
 * view having to track it.
 */
const subscriptions = new Set();

export function on(channel, callback) {
  const wrapped = channel === 'backend:state'
    ? (payload) => { setReady(Boolean(payload?.ready)); callback(payload); }
    : callback;

  const off = api.on(channel, wrapped);
  const entry = { channel, callback, off };
  subscriptions.add(entry);

  // A late subscriber to backend:state still learns the current value.
  if (channel === 'backend:state' && backendReady) {
    queueMicrotask(() => callback({ ready: true }));
  }

  return () => {
    subscriptions.delete(entry);
    off();
  };
}

/** Drop every subscription. Used when the shell is torn down. */
export function unsubscribeAll() {
  for (const entry of subscriptions) entry.off();
  subscriptions.clear();
}

/** Tell the main process the first paint has happened. */
export function ready() {
  api.ready();
}

export const channels = api.channels;

/** Convenience wrappers for the handful of calls used from several places. */
export const ui = {
  versions: () => invoke('ui.app.versions'),
  openAccountsFile: () => invoke('ui.openAccountsFile'),
  openSkinFile: () => invoke('ui.openSkinFile'),
  openAddonFolder: () => invoke('ui.openAddonFolder'),
  openAudioFiles: () => invoke('ui.openAudioFiles'),
  saveText: (params) => invoke('ui.saveText', params),
  saveImage: (params) => invoke('ui.saveImage', params),
  confirm: (params) => invoke('ui.confirm', params),
  openExternal: (url) => invoke('ui.openExternal', { url }),
  copy: (text) => invoke('ui.copy', { text }),
  revealPath: (path) => invoke('ui.revealPath', { path }),
  openPath: (path) => invoke('ui.openPath', { path }),
  window: {
    minimise: () => invoke('ui.window.minimise'),
    toggleMaximise: () => invoke('ui.window.toggleMaximise'),
    close: () => invoke('ui.window.close'),
    state: () => invoke('ui.window.state')
  }
};
