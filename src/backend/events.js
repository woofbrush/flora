/**
 * Event bus.
 *
 * Everything that happens asynchronously in the backend - a bot connecting, a
 * token being refreshed, an import finishing - is announced here. The worker
 * subscribes once and forwards each event to the renderer over IPC, so no
 * module needs to know that a UI exists.
 *
 * Handlers are called defensively: a listener that throws must not stop the
 * other listeners, and must not take down whatever emitted the event.
 */
import { EventEmitter } from 'node:events';

class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }

  emit(event, payload) {
    for (const listener of this.listeners(event)) {
      try {
        listener(payload);
      } catch (err) {
        // Deliberately not re-entrant: logging a failed listener through the
        // bus would loop if the logger itself is what failed.
        process.stderr.write(`flora: event listener for "${event}" threw: ${err?.message ?? err}\n`);
      }
    }
    return true;
  }
}

export const bus = new Bus();

/**
 * Event names.
 *
 * Kept as a frozen object rather than raw strings so a typo is a silent no-op
 * at worst and an obvious `undefined` at best, not a mismatched pair of
 * literals in two files.
 */
export const EVENTS = Object.freeze({
  // accounts
  ACCOUNTS_CHANGED: 'accounts:changed',
  ACCOUNT_UPDATED: 'accounts:updated',
  IMPORT_PROGRESS: 'accounts:import-progress',
  TEST_PROGRESS: 'accounts:test-progress',

  // microsoft sign-in
  LOGIN_STARTED: 'auth:login-started',
  LOGIN_CODE: 'auth:login-code',
  LOGIN_DONE: 'auth:login-done',
  LOGIN_FAILED: 'auth:login-failed',
  LOGIN_CANCELLED: 'auth:login-cancelled',

  // bots
  BOT_STATE: 'bots:state',
  BOT_LOG: 'bots:log',
  BOT_CHAT: 'bots:chat',
  BOT_KICKED: 'bots:kicked',
  BOT_ERROR: 'bots:error',

  // proxies
  PROXIES_CHANGED: 'proxies:changed',
  PROXY_CHECKED: 'proxies:checked',
  PROXY_CHECK_PROGRESS: 'proxies:check-progress',

  // skins
  SKIN_PROGRESS: 'skins:progress',
  SKIN_APPLIED: 'skins:applied',

  // addons
  ADDONS_CHANGED: 'addons:changed',
  ADDON_PROGRESS: 'addons:progress',

  // app
  LOG: 'app:log',
  SETTINGS_CHANGED: 'app:settings-changed',
  NOTIFY: 'app:notify',
  BUSY: 'app:busy'
});

/** Convenience for the common "something changed, redraw it" case. */
export const notifyChanged = (what, extra = {}) => bus.emit(EVENTS.ACCOUNTS_CHANGED, { what, ...extra });
