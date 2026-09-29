/**
 * Chat signing keys, held in memory for the life of the process.
 *
 * From 1.19 a client signs the chat it sends and the server checks the
 * signature against a public key the account registered with Mojang. flora
 * reaches that key pair two different ways, and only one of them works by
 * itself:
 *
 *   msa      prismarine-auth fetches the certificates during sign-in and
 *            minecraft-protocol copies them onto the client. Nothing to do.
 *   token    an access token on its own carries no keys, so the bot connects
 *            with chat signing off. That is the bug this file exists to fix.
 *
 * The key pair is a credential: the private half signs as the account for as
 * long as it lives. So it is never written to disk, never put in the database,
 * and never logged. It is asked for once per process per account and held here.
 *
 * The two timestamps Mojang returns are both honoured, and they mean different
 * things:
 *
 *   refreshedAfter  when to fetch a new pair. Mojang wants the client to roll
 *                   keys periodically, so this is a *refresh* deadline.
 *   expiresOn       when the current pair stops being accepted. This is a
 *                   *hard* deadline.
 *
 * Between the two there is a window where the pair still works but is due to be
 * replaced - and if the fetch fails in that window, a pair that still works is
 * much better than nothing, so the stale one is kept and a warning is logged.
 */
import { fetchChatKeys } from '../accounts/mojang.js';
import { logger } from '../logging/logger.js';
import { bus, EVENTS } from '../events.js';

/** accountId -> { keys, refreshAfter, expiresOn } */
const cache = new Map();
/** accountId -> in-flight promise, so parallel starts share one fetch. */
const pending = new Map();

/**
 * The chat signing keys for an account, or a reason there are none.
 *
 * Never throws: a bot that cannot sign chat should still connect, because on a
 * server with `enforce-secure-profile=false` - which is a great many of them -
 * unsigned chat works perfectly well. The caller gets `{ keys: null, reason }`
 * and decides what to say about it.
 *
 * `proxy` should be the account's own proxy, the same one its token came from,
 * so that forty accounts fetching keys do not all leave from one address.
 *
 * `fetcher` exists so the timing rules below - refresh window, expiry, the
 * in-flight share - can be tested without a Mojang account. Nothing in flora
 * passes it.
 */
export async function resolveChatKeys({ accountId, token, proxy = null, fetcher = fetchChatKeys } = {}) {
  const id = Number(accountId);
  if (!id) return { keys: null, reason: 'No account to fetch keys for.' };
  if (!token) return { keys: null, reason: 'No access token to fetch keys with.' };

  const now = Date.now();
  const held = cache.get(id);

  // Still inside the refresh window: the pair is current, nothing to do.
  if (held && now < held.refreshAfter) return { keys: held.keys, reason: null };

  // Someone else is already fetching for this account; wait for their answer
  // rather than asking Mojang twice for the same thing.
  if (pending.has(id)) {
    const shared = await pending.get(id);
    return { keys: shared.keys, reason: shared.reason };
  }

  const attempt = fetcher(token, { proxy })
    .then((keys) => {
      cache.set(id, {
        keys,
        refreshAfter: keys.refreshAfter?.getTime() ?? now + 60 * 60 * 1000,
        expiresOn: keys.expiresOn?.getTime() ?? now + 24 * 60 * 60 * 1000
      });
      return { keys, reason: null };
    })
    .catch((err) => {
      // A pair that has not expired yet is still accepted, so a failed refresh
      // is not a reason to stop signing. Say so once and carry on.
      if (held && now < held.expiresOn) {
        logger.warn('bots', `Could not refresh chat keys for account ${id}; using the keys already held: ${err.message}`);
        return { keys: held.keys, reason: null };
      }
      return { keys: null, reason: describe(err) };
    })
    .finally(() => { pending.delete(id); });

  pending.set(id, attempt);
  return attempt;
}

/** A sentence for the bot console, not a stack trace. */
function describe(err) {
  if (err?.authFailed) return 'Mojang refused the request - this account may need signing in again.';
  if (err?.rateLimited) return 'Mojang is rate limiting this account. Signing chat will be off until it clears.';
  if (err?.status) return `Mojang returned ${err.status} when asked for signing keys.`;
  return err?.message ? `Could not reach Mojang for signing keys: ${err.message}` : 'Could not fetch signing keys.';
}

/**
 * Drop what is held for an account.
 *
 * Called when an account is signed in again or removed: both mean the token
 * behind those keys is gone, and keys fetched with a dead token are worse than
 * no keys, because they look like they work right up until the server checks.
 */
export function forget(accountId) {
  const id = Number(accountId);
  cache.delete(id);
  pending.delete(id);
}

export function forgetAll() {
  cache.clear();
  pending.clear();
}

/** For tests and diagnostics: what is held, without exposing any key material. */
export function describeCache() {
  return [...cache.entries()].map(([accountId, entry]) => ({
    accountId,
    refreshAfter: new Date(entry.refreshAfter).toISOString(),
    expiresOn: new Date(entry.expiresOn).toISOString()
  }));
}

// A deleted account's keys have nobody left to sign for, and holding key
// material past the point where it can be used is the one thing this file
// exists to avoid. Listening here rather than being called from the account
// service keeps accounts/ from having to know that bots/ exists.
bus.on(EVENTS.ACCOUNTS_CHANGED, (event) => {
  if (event?.what === 'delete') for (const id of event.ids ?? []) forget(id);
});
