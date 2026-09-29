/**
 * Discord Rich Presence.
 *
 * The Discord desktop client listens on a local socket and exposes a small
 * JSON protocol over it - the same one a game uses to say "playing X". This
 * connects to that socket, says what flora is doing, and keeps saying it as the
 * bot count changes.
 *
 * Four things are worth knowing before reading the code:
 *
 *   - The socket is local. Discord may not be running at all, in which case
 *     every candidate path refuses the connection and the right behaviour is to
 *     wait and try again quietly. Discord being closed is not an error.
 *
 *   - The client ID belongs to a Discord *application*, which is what supplies
 *     the name and the artwork Discord shows above the two lines. flora ships
 *     with its own, and the field in Settings is there for anyone who would
 *     rather point it at an application of theirs. With the field empty nothing
 *     is sent at all.
 *
 *   - Discord sends a ping on op 3 that has to be answered with op 4 carrying
 *     the same payload, or it drops the connection after a minute or so.
 *
 * The frame layout itself lives in framing.js, which is pure and tested.
 *
 * Nothing here is specific to flora's bot layer: the caller hands in a plain
 * activity object and this module's only job is to get it to Discord and keep
 * the connection alive.
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../logging/logger.js';
import { OP, encodeFrame, createParser } from './framing.js';

const RETRY_FLOOR_MS = 5000;
const RETRY_CEILING_MS = 60000;

/** What the caller wants, which is not always what is on the wire. */
let desired = { enabled: false, clientId: '', activity: null };

let socket = null;
/** Past the handshake, so a frame may be sent. */
let ready = false;
let sent = null;            // the activity Discord currently believes
let parse = createParser();
let nonce = 0;
let retryDelay = RETRY_FLOOR_MS;
let retryTimer = null;
/** True while a connection attempt is in flight, so a retry cannot double up. */
let connecting = false;
let candidates = [];
let candidateIndex = 0;

/**
 * Where Discord's socket might be.
 *
 * Windows has one pipe per instance and a stable name. Everywhere else it is a
 * unix socket in a runtime directory, and which directory depends on how
 * Discord was installed: the plain package uses XDG_RUNTIME_DIR, the Flatpak
 * and Snap builds put it in a subdirectory of their own, and a Discord that
 * started before the session directory existed can end up in /tmp. All of them
 * are tried rather than guessing.
 */
function socketPaths() {
  if (process.platform === 'win32') {
    return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  }

  const roots = [
    process.env.XDG_RUNTIME_DIR,
    process.env.TMPDIR,
    process.env.TMP,
    process.env.TEMP,
    '/tmp'
  ].filter(Boolean);

  const dirs = [];
  for (const root of roots) {
    dirs.push(root);
    // Flatpak and Snap each get their own runtime directory.
    dirs.push(path.join(root, 'app', 'com.discordapp.Discord'));
    dirs.push(path.join(root, 'snap.discord'));
  }
  dirs.push(path.join(os.homedir(), '.discord'));

  const seen = new Set();
  const paths = [];
  for (const dir of dirs) {
    for (let i = 0; i < 10; i += 1) {
      const candidate = path.join(dir, `discord-ipc-${i}`);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      paths.push(candidate);
    }
  }
  return paths;
}

function write(op, payload) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(encodeFrame(op, payload));
  } catch (err) {
    logger.debug('app', `Discord presence write failed: ${err.message}`);
  }
}

function sendActivity() {
  if (!ready || !desired.activity) return;
  nonce += 1;
  write(OP.FRAME, {
    cmd: 'SET_ACTIVITY',
    args: { pid: process.pid, activity: desired.activity },
    nonce: String(nonce)
  });
  sent = JSON.stringify(desired.activity);
}

function onData(chunk) {
  for (const frame of parse(chunk)) {
    if (frame.op === OP.PING) {
      write(OP.PONG, frame.payload);
      continue;
    }

    if (frame.op === OP.CLOSE) {
      teardown();
      scheduleRetry();
      return;
    }

    if (frame.op === OP.FRAME && frame.payload?.evt === 'ERROR') {
      // Discord reports a rejected activity here rather than by closing, and
      // the usual cause is an application ID that does not exist or an activity
      // it refused. Worth a line, because the user's next question is why
      // nothing appeared.
      logger.warn('app', `Discord refused the presence: ${frame.payload?.data?.message ?? 'unknown reason'}`);
    }
  }
}

function teardown() {
  ready = false;
  sent = null;
  parse = createParser();
  if (!socket) return;
  socket.removeAllListeners();
  socket.destroy();
  socket = null;
}

function scheduleRetry() {
  if (retryTimer || !desired.enabled || !desired.clientId) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryDelay);
  // The retry is not a reason to hold the process open; flora is a windowed app
  // and the worker's lifetime is the app's.
  retryTimer.unref?.();
  retryDelay = Math.min(RETRY_CEILING_MS, retryDelay * 2);
}

function tryNext() {
  if (connecting || socket || !desired.enabled || !desired.clientId) return;

  if (candidateIndex >= candidates.length) {
    // Every path refused: Discord is almost certainly not running.
    logger.debug('app', 'Discord is not listening; will try again shortly.');
    scheduleRetry();
    return;
  }

  const target = candidates[candidateIndex];
  candidateIndex += 1;
  connecting = true;

  const attempt = net.createConnection({ path: target });
  let settled = false;

  const giveUp = () => {
    if (settled) return;
    settled = true;
    connecting = false;
    attempt.removeAllListeners();
    attempt.destroy();
    tryNext();
  };

  attempt.once('error', giveUp);
  attempt.once('connect', () => {
    if (settled) return;
    settled = true;
    connecting = false;
    attempt.removeAllListeners();

    socket = attempt;
    socket.on('data', onData);
    socket.on('error', () => { teardown(); scheduleRetry(); });
    socket.on('close', () => { teardown(); scheduleRetry(); });

    // The handshake is op 0 and is the only frame Discord accepts first.
    write(OP.HANDSHAKE, { v: 1, client_id: String(desired.clientId) });
    ready = true;
    retryDelay = RETRY_FLOOR_MS;
    // Whatever the caller last asked for, now that there is somewhere to send
    // it. `sent` is cleared so the comparison in `update` cannot consider an
    // activity already delivered on a connection that has since gone away.
    sent = null;
    sendActivity();
  });
}

function connect() {
  candidates = socketPaths();
  candidateIndex = 0;
  tryNext();
}

/**
 * Tell the presence what it should be doing.
 *
 * Safe to call as often as the caller likes: a call that changes nothing on the
 * wire does nothing on the wire. `activity` may be null, which means "connected
 * but showing nothing".
 */
export function sync({ enabled = false, clientId = '', activity = null } = {}) {
  const wanted = {
    enabled: Boolean(enabled),
    clientId: String(clientId ?? '').trim(),
    activity: activity ?? null
  };

  const wasOn = desired.enabled && desired.clientId;
  const nowOn = wanted.enabled && wanted.clientId;
  desired = wanted;

  if (!nowOn) {
    // Switched off, or switched on with no application ID yet. Either way there
    // is nothing to say and no reason to be connected.
    clearTimeout(retryTimer);
    retryTimer = null;
    retryDelay = RETRY_FLOOR_MS;
    teardown();
    return;
  }

  if (!wasOn || !socket) {
    if (!socket && !connecting) connect();
    return;
  }

  const next = wanted.activity ? JSON.stringify(wanted.activity) : null;
  if (next === sent) return;

  if (!next) {
    // Clearing the activity keeps the connection alive; closing it would make
    // the next change cost a reconnect.
    nonce += 1;
    write(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid }, nonce: String(nonce) });
    sent = null;
    return;
  }

  sendActivity();
}

/** Drop the connection and stop retrying. Called on shutdown. */
export function stop() {
  desired = { enabled: false, clientId: '', activity: null };
  clearTimeout(retryTimer);
  retryTimer = null;
  connecting = false;
  socket?.removeAllListeners();
  socket?.destroy();
  socket = null;
  ready = false;
  sent = null;
  parse = createParser();
}

/** For the diagnostics panel. */
export const status = () => ({
  enabled: desired.enabled,
  configured: Boolean(desired.clientId),
  connected: ready && Boolean(socket)
});
