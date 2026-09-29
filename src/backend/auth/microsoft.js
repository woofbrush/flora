/**
 * Microsoft sign-in.
 *
 * Uses the OAuth 2.0 device-code flow, which is the only flow Microsoft offers
 * to a desktop application that does not want to embed a browser and scrape a
 * login form. The user is shown a short code, opens Microsoft's own page in
 * their real browser, and types it there. flora never sees the password.
 *
 * That has a useful side effect: there is no redirect URI, so there is nothing
 * that can be "forbidden" the way a localhost callback page can be. The flow
 * completes inside the app by polling Microsoft, not by catching a redirect.
 *
 * prismarine-auth keeps a refresh token per `cacheId` under auth-cache/, which
 * is what lets an account be silently re-authenticated later without the user
 * touching a browser again.
 */
import crypto from 'node:crypto';
import prismarineAuth from 'prismarine-auth';
import fs from 'node:fs';
import { authCacheFor, authCacheDir } from '../paths.js';
import { logger } from '../logging/logger.js';
import { bus, EVENTS } from '../events.js';
import path from 'node:path';

const { Authflow, Titles } = prismarineAuth;

/** Live sign-in sessions, newest last. Pruned on every access. */
const sessions = new Map();
const SESSION_TTL = 25 * 60 * 1000;

function newSession(label) {
  return {
    id: crypto.randomUUID(),
    label,
    // starting -> awaiting_code -> pending -> done | error | cancelled
    state: 'starting',
    createdAt: Date.now(),
    userCode: null,
    verificationUri: null,
    expiresAt: null,
    message: null,
    error: null,
    profile: null,
    accountId: null
  };
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    label: session.label,
    state: session.state,
    userCode: session.userCode,
    // Always Microsoft's own page; never a local address.
    verificationUri: session.verificationUri,
    expiresAt: session.expiresAt,
    message: session.message,
    error: session.error,
    profile: session.profile,
    accountId: session.accountId
  };
}

function prune() {
  const cutoff = Date.now() - SESSION_TTL;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff && s.state !== 'pending' && s.state !== 'awaiting_code') sessions.delete(id);
  }
}

function emit(session, event) {
  bus.emit(event, publicSession(session));
}

function update(session, patch, event = EVENTS.LOGIN_STARTED) {
  Object.assign(session, patch);
  emit(session, event);
}

/** Filesystem-backed check: can this account be refreshed without a browser? */
export function hasCache(cacheId) {
  if (!cacheId) return false;
  try {
    const dir = path.join(authCacheDir(), cacheId);
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Begin a device-code sign-in.
 *
 * `onToken` receives the finished credential and is expected to persist it;
 * it runs inside this module so the access token never travels further than it
 * has to.
 */
export function startMicrosoftLogin({ onToken, label = '' } = {}) {
  prune();
  const session = newSession(label);
  sessions.set(session.id, session);

  // A stable, opaque cache identity. The account's email is deliberately not
  // used: the folder name would leak it to anyone listing the data directory.
  const cacheId = `msa-${crypto.randomBytes(8).toString('hex')}`;
  const cacheDir = authCacheFor(cacheId);

  (async () => {
    try {
      const flow = new Authflow(cacheId, cacheDir, {
        flow: 'live',
        authTitle: Titles.MinecraftJava,
        deviceType: 'Win32'
      }, (code) => {
        update(session, {
          state: 'pending',
          userCode: code.user_code,
          verificationUri: code.verification_uri || 'https://microsoft.com/link',
          expiresAt: Date.now() + (Number(code.expires_in) || 900) * 1000,
          message: `Enter the code at ${code.verification_uri || 'microsoft.com/link'}`
        }, EVENTS.LOGIN_CODE);
        logger.info('auth', 'Microsoft sign-in started; waiting for the code to be entered.');
      });

      update(session, { state: 'awaiting_code', message: 'Contacting Microsoft…' }, EVENTS.LOGIN_STARTED);

      const result = await flow.getMinecraftJavaToken({ fetchProfile: true });
      if (session.state === 'cancelled') return;

      if (!result?.token) throw new Error('Microsoft did not return a Minecraft token for this account.');

      const profile = result.profile
        ? { name: result.profile.name, id: result.profile.id }
        : null;

      const accountId = await onToken({ token: result.token, profile, cacheId, label });

      update(session, {
        state: 'done',
        profile,
        accountId,
        message: 'Signed in.'
      }, EVENTS.LOGIN_DONE);

      logger.info('auth', `Signed in ${profile?.name ?? 'a Microsoft account'}.`, { accountId });
    } catch (err) {
      if (session.state === 'cancelled') return;
      const message = err?.message ? String(err.message) : 'Microsoft sign-in failed.';
      update(session, { state: 'error', error: message }, EVENTS.LOGIN_FAILED);
      logger.error('auth', `Microsoft sign-in failed: ${message}`);
    }
  })();

  return publicSession(session);
}

export function getLoginSession(id) {
  prune();
  return publicSession(sessions.get(String(id)));
}

export function listLoginSessions() {
  prune();
  return [...sessions.values()].map(publicSession).filter((s) => s.state !== 'done');
}

export function cancelLoginSession(id) {
  const session = sessions.get(String(id));
  if (!session) return false;
  if (session.state === 'done') return false;
  update(session, { state: 'cancelled', message: 'Cancelled.' }, EVENTS.LOGIN_CANCELLED);
  return true;
}

/** Drop finished sessions once the renderer has read them. */
export function dismissLoginSession(id) {
  return sessions.delete(String(id));
}

/**
 * Renew an account's access token from its cached refresh token.
 * Throws a message the UI can act on when the cache is gone or expired.
 */
export async function refreshMicrosoftAccount(cacheId) {
  if (!cacheId) {
    throw new Error('This account was added from a token and cannot be renewed. Add it again with Microsoft sign-in.');
  }

  const cacheDir = authCacheFor(cacheId);
  const flow = new Authflow(cacheId, cacheDir, {
    flow: 'live',
    authTitle: Titles.MinecraftJava,
    deviceType: 'Win32'
  }, () => {
    // Reached only when the cache cannot satisfy the request, which means the
    // refresh token is gone and interactive sign-in is required.
    throw new Error('Microsoft needs you to sign in again for this account.');
  });

  const result = await flow.getMinecraftJavaToken({ fetchProfile: true });
  if (!result?.token) throw new Error('Microsoft did not return a token when renewing.');

  return {
    token: result.token,
    profile: result.profile ? { name: result.profile.name, id: result.profile.id } : null
  };
}

/** Remove an account's cached credentials. Called when the account is deleted. */
export function forgetCache(cacheId) {
  if (!cacheId) return false;
  try {
    fs.rmSync(path.join(authCacheDir(), cacheId), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
