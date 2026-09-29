/**
 * Backend client (main-process side).
 *
 * Owns the `utilityProcess` running src/backend/worker.js and gives the rest of
 * the main process two things: `call()`, which is a promise for exactly one
 * method invocation, and `on()`, which receives the backend's pushed events.
 *
 * Requests are correlated by an incrementing id. The pending map holds one
 * resolver per in-flight call, and every one of them is rejected if the worker
 * dies - a promise that never settles is how a UI ends up spinning forever.
 */
import { utilityProcess } from 'electron';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = path.join(here, '..', 'backend', 'worker.js');

/** Idle grace period before a restarted worker is announced as recovered. */
const BOOT_TIMEOUT_MS = 30000;

export class Backend extends EventEmitter {
  #child = null;
  #pending = new Map();
  #nextId = 1;
  #ready = false;
  #starting = null;
  #bootResolve = null;

  constructor({ dataRoot, version }) {
    super();
    this.dataRoot = dataRoot;
    this.version = version;
  }

  get ready() {
    return this.#ready;
  }

  get pid() {
    return this.#child?.pid ?? null;
  }

  /**
   * Spawn the worker and wait for it to report a successful boot.
   *
   * Resolves once the backend is serving; rejects with the backend's own stack
   * when boot fails, which is almost always an unwritable data directory.
   */
  start() {
    if (this.#starting) return this.#starting;

    this.#starting = new Promise((resolve, reject) => {
      let child;
      try {
        child = utilityProcess.fork(WORKER_ENTRY, [], {
          serviceName: 'flora backend',
          // A worker that dies silently is the hardest kind of bug to chase, so
          // its own stdout/stderr are piped into the main process log.
          stdio: 'pipe',
          env: {
            ...process.env,
            FLORA_VERSION: this.version,
            FLORA_DATA_DIR: this.dataRoot
          }
        });
      } catch (err) {
        reject(err);
        return;
      }

      this.#child = child;

      child.stdout?.on('data', (chunk) => this.emit('stdout', chunk.toString()));
      child.stderr?.on('data', (chunk) => this.emit('stderr', chunk.toString()));

      child.on('message', (message) => this.#receive(message));

      child.on('exit', (code) => {
        const wasReady = this.#ready;
        this.#ready = false;
        this.#child = null;
        this.#starting = null;

        // Every in-flight call is now unanswerable.
        for (const [, pending] of this.#pending) {
          pending.reject(new Error('The flora backend stopped.'));
        }
        this.#pending.clear();

        this.emit('exit', { code, wasReady });
      });

      const timer = setTimeout(() => {
        reject(new Error('The flora backend did not start within 30 seconds.'));
      }, BOOT_TIMEOUT_MS);

      // The boot reply is handled inline so a failure carries the backend's
      // own message rather than a generic timeout.
      this.#bootResolve = (result) => {
        clearTimeout(timer);
        this.#bootResolve = null;
        if (result.ok) {
          this.#ready = true;
          resolve();
        } else {
          reject(new Error(result.error));
        }
      };

      this.#post({ id: 0, method: '__boot', params: { dataRoot: this.dataRoot } });
    });

    return this.#starting;
  }

  #post(message) {
    if (!this.#child) throw new Error('The flora backend is not running.');
    this.#child.postMessage(message);
  }

  #receive(message) {
    if (!message) return;

    // The boot reply is id 0 and has its own resolver.
    if (message.id === 0 && this.#bootResolve) {
      this.#bootResolve(message);
      return;
    }

    if (message.event) {
      this.emit('event', message.event, message.payload);
      return;
    }

    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error ?? 'The backend reported an unknown failure.'));
  }

  /**
   * Invoke a backend method.
   *
   * Rejects immediately when the backend is down, rather than queueing a call
   * that can never be answered.
   */
  call(method, params = {}, { timeoutMs = 0 } = {}) {
    if (!this.#child || !this.#ready) {
      return Promise.reject(new Error('The flora backend is not running.'));
    }

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, method };
      this.#pending.set(id, entry);

      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`"${method}" did not finish within ${Math.round(timeoutMs / 1000)}s.`));
        }, timeoutMs);
      }

      try {
        this.#post({ id, method, params });
      } catch (err) {
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        reject(err);
      }
    });
  }

  /** Ask the backend to stop its bots and close the database, then exit. */
  async stop({ timeoutMs = 8000 } = {}) {
    const child = this.#child;
    if (!child) return;

    try {
      // A dedicated channel, not a normal call: the reply has to be the last
      // thing the worker does before it exits.
      const done = new Promise((resolve) => {
        const onExit = () => resolve();
        child.once('exit', onExit);
        setTimeout(() => { child.off('exit', onExit); resolve(); }, timeoutMs).unref?.();
      });

      child.postMessage({ id: -1, method: '__shutdown', params: {} });
      await done;
    } catch { /* already gone */ }

    if (this.#child) {
      try { this.#child.kill(); } catch { /* already dead */ }
      this.#child = null;
    }
    this.#ready = false;
    this.#starting = null;
  }

  /** Force a fresh worker, for the Settings > Data "restart backend" action. */
  async restart() {
    await this.stop();
    this.#pending.clear();
    return this.start();
  }
}
