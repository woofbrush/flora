/**
 * Account service.
 *
 * The layer between the IPC handlers and storage. Everything that needs both a
 * credential and the network lives here, so the rules about which account kind
 * can do what are in one place:
 *
 *   msa      - signed in with Microsoft. Has a cached refresh token, so its
 *              access token can be renewed silently. Full API access.
 *   token    - an imported access token. Works until it expires; there is no
 *              way to renew it, so it has to be re-imported.
 *   offline  - a username and password for offline-mode servers. Never touches
 *              a Microsoft API; it cannot own a skin, because skins are a
 *              Mojang account feature.
 *
 * `withCredential` is the one entry point for "do a thing that needs a token".
 * It handles decryption, silent refresh for msa accounts, and a single retry
 * when the first call comes back unauthorized.
 */
import * as repo from './repo.js';
import * as mojang from './mojang.js';
import { bus, EVENTS } from '../events.js';
import { logger } from '../logging/logger.js';
import {
  startMicrosoftLogin,
  getLoginSession,
  cancelLoginSession,
  refreshMicrosoftAccount,
  hasCache
} from '../auth/microsoft.js';
import * as importLib from './import.js';
import { fingerprint } from '../auth/crypto.js';
import { apiProxyFor } from '../proxies/service.js';
import { mapLimit } from '../util/concurrency.js';

// Re-exported rather than defined here. The proxies service needs it too, and
// it is imported by this module, so keeping the definition here would have made
// the two import each other. Callers that already do
// `import { mapLimit } from './service.js'` are unaffected.
export { mapLimit };

// ---------------------------------------------------------------- reading

/** Accounts with live bot status merged in. `stateFor` is injected to avoid a
 *  circular import between the account service and the bot manager. */
let botStateProvider = () => null;
export function setBotStateProvider(fn) {
  botStateProvider = fn;
}

export function list(options = {}) {
  const accounts = repo.list(options);
  return accounts.map((a) => ({ ...a, bot: botStateProvider(a.id) }));
}

export const counts = () => repo.counts();
export const tags = () => repo.tags();

export function get(id) {
  const account = repo.getById(id);
  return account ? { ...account, bot: botStateProvider(account.id) } : null;
}

export function idsFor(options = {}) {
  return repo.idsMatching(options);
}

// ---------------------------------------------------------------- writing

/**
 * Add an account from a raw access token.
 *
 * The token is verified before the row is written, so an import full of dead
 * tokens fails loudly at the point of import rather than silently producing a
 * list of accounts that cannot connect.
 */
export async function addToken({ token, label = '', username = '', verify = true, uuid = null }) {
  const clean = String(token ?? '').trim();
  if (!clean) throw new Error('No token provided.');

  const existing = repo.findByFingerprint(fingerprint(clean));

  let resolvedName = username;
  let resolvedUuid = uuid;
  let verified = false;
  let verifyError = null;

  if (verify) {
    const probe = await mojang.probeToken(clean);
    if (probe.ok) {
      verified = true;
      resolvedName = probe.profile.name || resolvedName;
      resolvedUuid = probe.profile.uuid || resolvedUuid;
    } else {
      verifyError = probe.error;
    }
  }

  if (existing) {
    // Re-adding a token we already hold: refresh it in place rather than
    // creating a second row for the same account.
    repo.update(existing.id, {
      token: clean,
      username: resolvedName || existing.username,
      uuid: resolvedUuid || existing.uuid,
      kind: 'token'
    });
    repo.recordTest(existing.id, { ok: verified, error: verifyError, username: resolvedName, uuid: resolvedUuid });
    bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'update', id: existing.id });
    return { account: get(existing.id), duplicate: true, verified, error: verifyError };
  }

  const account = repo.insert({
    username: resolvedName,
    uuid: resolvedUuid,
    token: clean,
    kind: 'token',
    label
  });
  repo.recordTest(account.id, { ok: verified, error: verifyError, username: resolvedName, uuid: resolvedUuid });

  logger.info('accounts', `Added account${resolvedName ? ` ${resolvedName}` : ''} from a token.`, {
    accountId: account.id
  });
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'add', id: account.id });

  return { account: get(account.id), duplicate: false, verified, error: verifyError };
}

/** Add an offline-mode account. No Microsoft account is involved. */
export function addOffline({ username, password = null, uuid = null, label = '' }) {
  const name = String(username ?? '').trim();
  if (!name) throw new Error('A username is required.');

  const existing = repo.findByUsername(name);
  if (existing) {
    repo.update(existing.id, { password, kind: 'offline', uuid: uuid ?? existing.uuid });
    bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'update', id: existing.id });
    return { account: get(existing.id), duplicate: true };
  }

  const account = repo.insert({ username: name, uuid, password, kind: 'offline', label });
  logger.info('accounts', `Added offline account ${name}.`, { accountId: account.id });
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'add', id: account.id });
  return { account: get(account.id), duplicate: false };
}

/** Persist an account produced by the Microsoft sign-in flow. */
export async function addFromMicrosoft({ token, profile, cacheId, label = '' }) {
  const uuid = profile?.id ? mojang.undash(profile.id) : null;

  // A re-login of an account we already have should update it, not duplicate it.
  const existing = uuid ? repo.findByUuid(uuid) : null;
  if (existing) {
    repo.update(existing.id, {
      token, cacheId, kind: 'msa',
      username: profile?.name ?? existing.username,
      uuid: uuid ?? existing.uuid
    });
    repo.recordTest(existing.id, { ok: true, username: profile?.name, uuid });
    bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'update', id: existing.id });
    return { account: get(existing.id), duplicate: true };
  }

  const account = repo.insert({
    username: profile?.name ?? '',
    uuid,
    token,
    kind: 'msa',
    cacheId,
    label
  });
  repo.recordTest(account.id, { ok: true, username: profile?.name, uuid });

  logger.info('accounts', `Signed in ${profile?.name ?? 'a Microsoft account'}.`, { accountId: account.id });
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'add', id: account.id });
  return { account: get(account.id), duplicate: false };
}

export function updateMeta(id, patch) {
  const account = repo.update(id, patch);
  bus.emit(EVENTS.ACCOUNT_UPDATED, account);
  return account;
}

export async function remove(ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite))];
  if (!list.length) return 0;
  const removed = repo.removeMany(list);
  logger.info('accounts', `Deleted ${removed} account${removed === 1 ? '' : 's'}.`);
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'delete', ids: list });
  return removed;
}

// ---------------------------------------------------------------- selection

const emitCounts = (changed) => {
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'selection', changed, counts: repo.counts() });
  return { changed, counts: repo.counts() };
};

export const setSelection = (ids, value) => emitCounts(repo.setSelection(ids, value));
export const selectAll = () => emitCounts(repo.selectAll());
export const selectNone = () => emitCounts(repo.selectNone());
export const invertSelection = () => emitCounts(repo.selectInvert());

// ---------------------------------------------------------------- credentials

/**
 * Decrypt an access token for an account, refreshing it first when possible.
 *
 * Exported because the skin and bot paths need the same "get me a live token"
 * behaviour, and duplicating the refresh rule is how it drifts.
 *
 * The proxy comes back attached to the credential rather than being looked up
 * by each caller. Every path that gets a token is a path that then makes an
 * API call as that account, so resolving it here means none of them can forget
 * to route it - and a bulk run gets one lookup per account instead of one per
 * request. It is null whenever proxying is off.
 */
export async function credentialFor(id, { forceRefresh = false } = {}) {
  const row = repo.getRaw(id);
  if (!row) throw new Error('Account not found.');

  if (row.kind === 'offline') {
    throw new Error('This is an offline-mode account and has no Microsoft token.');
  }

  const proxy = apiProxyFor(id);

  if (row.kind === 'msa' && row.cache_id && (forceRefresh || !row.token_sealed)) {
    if (hasCache(row.cache_id)) {
      const refreshed = await refreshMicrosoftAccount(row.cache_id);
      repo.update(id, {
        token: refreshed.token,
        username: refreshed.profile?.name ?? row.username,
        uuid: refreshed.profile?.id ? mojang.undash(refreshed.profile.id) : row.uuid
      });
      return { token: refreshed.token, kind: 'msa', profile: refreshed.profile, proxy };
    }
  }

  if (!row.token_sealed) {
    throw new Error(
      row.kind === 'msa'
        ? 'This account needs to be signed in again.'
        : 'This account has no stored token.'
    );
  }

  return { token: repo.revealToken(id), kind: row.kind, profile: null, proxy };
}

/**
 * Run `fn(token, account)` with a valid credential, retrying once via a silent
 * refresh if the API rejects the token.
 *
 * `retryAuth` is off for calls where a 403 does not mean the token is bad. A
 * refused rename is the 30-day cooldown, and refreshing a perfectly good token
 * to then fail identically wastes an OAuth round trip and buries the real error
 * under a retry. Those callers handle their own 401.
 */
export async function withCredential(id, fn, { forceRefresh = false, retryAuth = true } = {}) {
  let credential = await credentialFor(id, { forceRefresh });

  try {
    return await fn(credential.token, credential);
  } catch (err) {
    const canRetry = retryAuth && err?.authFailed && credential.kind === 'msa' && !forceRefresh;
    if (!canRetry) throw err;

    credential = await credentialFor(id, { forceRefresh: true });
    return fn(credential.token, credential);
  }
}

// ---------------------------------------------------------------- checking

/**
 * Verify one account.
 *
 * offline accounts have nothing to verify against, so they are reported as
 * "skipped" rather than being marked failed - a green tick would be a lie and
 * a red cross would be noise.
 */
export async function testAccount(id) {
  const account = get(id);
  if (!account) return { id, ok: false, error: 'Account not found.' };

  if (account.kind === 'offline') {
    return { id, ok: true, skipped: true, username: account.username, message: 'Offline-mode account; nothing to verify.' };
  }

  try {
    const profile = await withCredential(id, (token, cred) => mojang.fetchOwnProfile(token, { proxy: cred.proxy }));
    repo.recordTest(id, { ok: true, username: profile.name, uuid: profile.uuid });
    return { id, ok: true, username: profile.name, uuid: profile.uuid };
  } catch (err) {
    const message = err?.message ?? 'Check failed.';
    repo.recordTest(id, { ok: false, error: message });
    return { id, ok: false, error: message, authFailed: Boolean(err?.authFailed) };
  }
}

/**
 * Check many accounts, capped so a list of 5000 does not open 5000 sockets.
 * Progress is emitted per completion so the UI can show a live counter.
 */
export async function testAccounts(ids, { concurrency = 6 } = {}) {
  const list = [...new Set(ids.map(Number).filter(Number.isFinite))];
  if (!list.length) return { results: [], counts: { total: 0, ok: 0, failed: 0, skipped: 0 } };

  bus.emit(EVENTS.BUSY, { scope: 'test', active: true, total: list.length });

  const results = await mapLimit(list, concurrency, (id) => testAccount(id), {
    onProgress: (done, total) => bus.emit(EVENTS.TEST_PROGRESS, { done, total })
  });

  const tally = results.reduce(
    (acc, r) => {
      if (r?.skipped) acc.skipped += 1;
      else if (r?.ok) acc.ok += 1;
      else acc.failed += 1;
      return acc;
    },
    { total: list.length, ok: 0, failed: 0, skipped: 0 }
  );

  bus.emit(EVENTS.BUSY, { scope: 'test', active: false });
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'tested', ids: list, counts: repo.counts() });

  if (tally.failed) {
    logger.warn('accounts', `Checked ${tally.total} accounts: ${tally.failed} failed.`);
  } else {
    logger.info('accounts', `Checked ${tally.total} accounts: all reachable.`);
  }

  return { results, counts: tally };
}

// ---------------------------------------------------------------- usernames

/** One sentence per answer the availability endpoint can give. */
const NAME_RESULTS = {
  AVAILABLE: 'That username is free.',
  DUPLICATE: 'That username is already taken.',
  NOT_ALLOWED: 'Mojang does not allow that username.',
  INVALID: '3 to 16 characters, letters, numbers and underscores only.',
  CURRENT: "That is already this account's username.",
  UNKNOWN: 'Mojang did not give a clear answer for that name.'
};

/**
 * Is a username free?
 *
 * Per account, because that is the only way it can be: the endpoint needs the
 * account's own token, and the answer depends on which proxy the request leaves
 * through. Using the account's own proxy is what keeps a hundred checks from
 * arriving at Mojang as one address.
 *
 * Never throws. The dialog calls it on every keystroke and an exception there
 * would be a validation error rendered as a crash. A failure to check is
 * reported as such rather than as a verdict on the name, because it is not one.
 */
export async function checkUsername(id, name) {
  const wanted = String(name ?? '').trim();
  const account = get(id);
  if (!account) return { ok: false, name: wanted, status: 'UNKNOWN', error: 'Account not found.' };

  if (!mojang.isValidName(wanted)) {
    return { ok: true, name: wanted, status: 'INVALID', message: NAME_RESULTS.INVALID };
  }
  if (account.username === wanted) {
    return { ok: true, name: wanted, status: 'CURRENT', message: NAME_RESULTS.CURRENT };
  }
  if (account.kind === 'offline') {
    return { ok: false, name: wanted, status: 'UNKNOWN', error: 'Offline-mode accounts have no Mojang profile.' };
  }

  try {
    const result = await withCredential(id, (token, cred) =>
      mojang.nameAvailable(wanted, { token, proxy: cred.proxy }));

    return {
      ok: true,
      name: result.name,
      status: result.status,
      message: NAME_RESULTS[result.status] ?? NAME_RESULTS.UNKNOWN
    };
  } catch (err) {
    return { ok: false, name: wanted, status: 'UNKNOWN', error: err?.message ?? 'Could not check that name.' };
  }
}

/**
 * Rename one account.
 *
 * Single, never bulk: Mojang allows one change per account every 30 days, so
 * there is nothing a batch would buy except a longer list of the same refusal.
 * Throws with the reason, which for the common cases is a sentence rather than
 * a status code - see `changeName` in mojang.js.
 */
export async function changeUsername(id, name) {
  const wanted = String(name ?? '').trim();
  const account = get(id);
  if (!account) throw new Error('Account not found.');

  if (account.kind === 'offline') {
    throw new Error('Offline-mode accounts have no Mojang profile, so there is no name to change.');
  }
  if (!mojang.isValidName(wanted)) {
    throw new Error('A username is 3 to 16 characters, letters, numbers and underscores only.');
  }
  if (account.username === wanted) {
    throw new Error('That account is already using that username.');
  }

  const rename = (token, cred) => mojang.changeName({ token, name: wanted, proxy: cred.proxy });

  let result;
  try {
    // The retry is off here so a cooldown is not mistaken for a dead token.
    result = await withCredential(id, rename, { retryAuth: false });
  } catch (err) {
    // An expired token is still worth one silent refresh, which is the retry
    // that was just disabled.
    if (err?.status !== 401 || account.kind !== 'msa') throw err;
    result = await withCredential(id, rename, { forceRefresh: true, retryAuth: false });
  }

  repo.update(id, { username: result.name });
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'renamed', ids: [Number(id)] });
  logger.info('accounts', `Renamed account #${id} from ${account.username} to ${result.name}.`);

  return { ok: true, id: Number(id), username: result.name, previous: account.username };
}

/** Re-resolve username, UUID and skin for an account from Mojang. */
export async function refreshProfile(id) {
  const account = get(id);
  if (!account) throw new Error('Account not found.');

  if (account.kind === 'offline') {
    if (!account.uuid) throw new Error('An offline account needs a UUID before its profile can be looked up.');
    const profile = await mojang.lookupProfile(account.uuid);
    if (!profile) throw new Error('Mojang does not know that UUID.');
    repo.update(id, { username: profile.name || account.username });
    bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'update', id });
    return { ...get(id), skinUrl: profile.skinUrl, model: profile.model };
  }

  const profile = await withCredential(id, (token) => mojang.fetchOwnProfile(token));
  const active = profile.skins.find((s) => s.state === 'ACTIVE') ?? profile.skins[0] ?? null;

  repo.update(id, {
    username: profile.name,
    uuid: profile.uuid,
    skinModel: active?.variant === 'slim' ? 'slim' : (active ? 'classic' : null)
  });
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'update', id });

  return {
    ...get(id),
    skinUrl: active?.url ?? null,
    model: active?.variant ?? null,
    capeUrl: profile.capes.find((c) => c.state === 'ACTIVE')?.url ?? null
  };
}

// ---------------------------------------------------------------- microsoft

export function beginMicrosoftLogin({ label = '' } = {}) {
  return startMicrosoftLogin({
    label,
    onToken: (payload) => addFromMicrosoft(payload).then((r) => r.account.id)
  });
}

export { getLoginSession, cancelLoginSession };

// ---------------------------------------------------------------- import

const staged = new Map();
const STAGE_TTL = 30 * 60 * 1000;

function pruneStages() {
  const cutoff = Date.now() - STAGE_TTL;
  for (const [id, stage] of staged) if (stage.createdAt < cutoff) staged.delete(id);
}

/**
 * Parse an imported file and stage the result.
 *
 * Staging means the (potentially large) parsed plan is held once, in the
 * backend, and the renderer only ever receives a redacted preview. Confirming
 * the import refers back to the stage id instead of re-uploading the file.
 */
export function prepareImport(text, filename = '') {
  pruneStages();

  const parsed = importLib.parse(text, filename);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const planned = importLib.plan(parsed, {
    existing: repo.fingerprints(),
    existingNames: new Set(repo.list({}).map((a) => a.username.toLowerCase()).filter(Boolean))
  });

  const stageId = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  staged.set(stageId, { entries: planned.fresh, createdAt: Date.now() });

  return {
    ok: true,
    stageId,
    format: parsed.format,
    ...importLib.preview(planned)
  };
}

/** Apply a staged import. */
export async function confirmImport(stageId, { label = '', verify = false } = {}) {
  const stage = staged.get(stageId);
  if (!stage) return { ok: false, error: 'That import has expired. Choose the file again.' };

  const entries = stage.entries;
  let added = 0;
  const failures = [];

  // Insert first, then verify in a second pass. Writing the rows up front means
  // a network failure part-way through still leaves the user with the accounts
  // they imported rather than a half-empty result.
  for (const entry of entries) {
    try {
      if (entry.kind === 'token') {
        repo.insert({
          username: entry.username,
          uuid: entry.uuid,
          token: entry.token,
          kind: 'token',
          label
        });
      } else {
        repo.insert({
          username: entry.username,
          uuid: entry.uuid,
          password: entry.password,
          kind: 'offline',
          label
        });
      }
      added += 1;
    } catch (err) {
      failures.push({ line: entry.line, reason: err.message });
    }
    if (added % 100 === 0) {
      bus.emit(EVENTS.IMPORT_PROGRESS, { done: added, total: entries.length });
    }
  }

  staged.delete(stageId);
  bus.emit(EVENTS.ACCOUNTS_CHANGED, { what: 'import', added });
  logger.info('accounts', `Imported ${added} account${added === 1 ? '' : 's'}.`);

  let verified = null;
  if (verify) {
    const ids = repo.list({ limit: added, sortBy: 'added', sortDir: 'desc' }).map((a) => a.id);
    verified = await testAccounts(ids);
  }

  return { ok: true, added, failures, counts: repo.counts(), verified };
}

export function discardImport(stageId) {
  return staged.delete(stageId);
}

/** Text export. Secrets are opt-in and never included by default. */
export function exportAccounts(ids, { includeSecrets = false } = {}) {
  const list = ids?.length ? ids.map((id) => repo.getById(id)).filter(Boolean) : repo.list({});
  return importLib.serialise(list, {
    includeSecrets,
    revealToken: includeSecrets ? (id) => repo.revealToken(id) : null
  });
}

export function formatHelp() {
  return importLib.FORMAT_HELP;
}

export { repo };
