/**
 * Shared actions.
 *
 * The operations that more than one place can trigger - a toolbar button, a row
 * menu, the command palette - live here so they cannot drift apart. Nothing in
 * this module opens a dialog or navigates: those are the caller's business, and
 * keeping them out is what stops the view layer from importing itself in a
 * circle.
 */
import * as bridge from './bridge.js';
import * as store from './store.js';
import * as toast from './components/toast.js';
import * as format from './format.js';

/** Move to another view. Routed through the store so no module needs the shell. */
export const go = (view) => store.emit(store.TOPICS.NAVIGATE, view);

/** Re-read the account list right away, rather than waiting for the debounce. */
export const reload = () => store.refreshAccounts({ immediate: true });

// ---------------------------------------------------------------- selection

export async function selectAll() {
  await bridge.invoke('accounts.selectAll');
  await reload();
}

export async function selectNone() {
  await bridge.invoke('accounts.selectNone');
  await reload();
}

export async function invertSelection() {
  await bridge.invoke('accounts.invert');
  await reload();
}

export async function setSelected(ids, value) {
  await bridge.invoke('accounts.select', { ids, value });
  // Patched locally as well as on the backend, so the checkbox does not lag a
  // round trip behind the click. The refetch reconciles either way.
  for (const id of ids) {
    const account = store.accountById(id);
    if (account) account.selected = value;
  }
  store.emit(store.TOPICS.ACCOUNTS);
  await reload();
}

// ---------------------------------------------------------------- bots

/**
 * Connect accounts.
 *
 * `bots.startMany` runs them one at a time - each connect is a socket, a
 * handshake and a spawn - so the toast reports the tally rather than pretending
 * this was instantaneous.
 */
export async function startAccounts(ids, { server = null, version = null, proxyId = null } = {}) {
  if (!ids.length) return null;

  const toastHandle = toast.info(
    `Connecting ${format.plural(ids.length, 'account')}…`,
    'This can take a moment on a slow connection.',
    { id: 'bots-start', timeout: 0 }
  );

  try {
    const result = await bridge.invoke('bots.startMany', { ids, server, version, proxyId });
    const { started, failed } = result.counts;

    if (!failed) {
      toastHandle.close();
      toast.ok(`Connecting ${format.plural(started, 'bot')}`);
    } else if (started) {
      toastHandle.close();
      const first = result.results.find((r) => !r.ok)?.error;
      toast.warn(`${started} connecting, ${failed} refused`, first ?? null);
    } else {
      toastHandle.close();
      const first = result.results.find((r) => !r.ok)?.error ?? 'The server refused every one of them.';
      toast.error('No bots could start', first);
    }
    return result;
  } catch (err) {
    toastHandle.close();
    toast.fromError(err, 'Could not start those accounts');
    return null;
  }
}

export async function stopAccounts(ids) {
  if (!ids.length) return 0;
  try {
    const results = await Promise.all(ids.map((id) =>
      bridge.invoke('bots.stop', { id }).then(() => true).catch(() => false)));
    const stopped = results.filter(Boolean).length;
    if (stopped) toast.ok(`Stopped ${format.plural(stopped, 'bot')}`);
    return stopped;
  } catch (err) {
    toast.fromError(err, 'Could not stop those bots');
    return 0;
  }
}

export async function stopEverything() {
  try {
    const { stopped } = await bridge.invoke('bots.stopAll');
    if (stopped) toast.ok(`Stopped ${format.plural(stopped, 'bot')}`);
    else toast.info('No bots were running');
    return stopped;
  } catch (err) {
    toast.fromError(err, 'Could not stop the bots');
    return 0;
  }
}

export async function restartBot(id) {
  await stopAccounts([id]);
  return startAccounts([id]);
}

// ---------------------------------------------------------------- checks

export async function testAccounts(ids) {
  if (!ids.length) return null;

  const handle = toast.info(
    `Checking ${format.plural(ids.length, 'account')}…`,
    'Asking Mojang for each profile.',
    { id: 'accounts-test', timeout: 0 }
  );

  try {
    const result = await bridge.invoke('accounts.testMany', { ids });
    const { ok, failed, skipped } = result.counts;
    const parts = [`${ok} working`];
    if (failed) parts.push(`${failed} failed`);
    if (skipped) parts.push(`${skipped} offline-mode`);

    handle.close();
    const tone = failed ? toast.warn : toast.ok;
    tone(`Checked ${format.plural(result.counts.total, 'account')}`, parts.join(' · '));
    return result;
  } catch (err) {
    handle.close();
    toast.fromError(err, 'Could not check those accounts');
    return null;
  }
}

export async function refreshProfile(id) {
  try {
    const result = await bridge.invoke('accounts.refreshProfile', { id });
    const name = result?.account?.username ?? result?.username;
    toast.ok('Profile refreshed', name ? `Now signed in as ${name}.` : null);
    await reload();
    return result;
  } catch (err) {
    toast.fromError(err, 'Could not refresh that profile');
    return null;
  }
}

// ---------------------------------------------------------------- skins

export async function fetchSkins(ids, { force = false } = {}) {
  if (!ids.length) return null;
  const handle = toast.info(
    `Fetching ${format.plural(ids.length, 'skin')}…`,
    null,
    { id: 'skins-fetch', timeout: 0 }
  );
  try {
    const result = await bridge.invoke('skins.fetchMany', { ids, force });
    const { fetched, cached, none, failed } = result.counts;
    handle.close();
    const parts = [];
    if (fetched) parts.push(`${fetched} downloaded`);
    if (cached) parts.push(`${cached} already cached`);
    if (none) parts.push(`${none} with no skin`);
    if (failed) parts.push(`${failed} failed`);
    (failed ? toast.warn : toast.ok)('Skin refresh finished', parts.join(' · '));
    await reload();
    return result;
  } catch (err) {
    handle.close();
    toast.fromError(err, 'Could not fetch those skins');
    return null;
  }
}

// ---------------------------------------------------------------- data

export async function exportAccounts({ ids = [], includeSecrets = false } = {}) {
  try {
    const result = await bridge.invoke('accounts.export', { ids, includeSecrets });
    if (!result?.text?.trim()) {
      toast.warn('Nothing to export', 'There are no accounts matching that.');
      return null;
    }

    const saved = await bridge.ui.saveText({
      title: includeSecrets ? 'Export accounts with tokens' : 'Export accounts',
      defaultName: includeSecrets ? 'flora-accounts-with-tokens.txt' : 'flora-accounts.txt',
      contents: result.text
    });

    if (saved?.cancelled) return null;
    const count = result.text.trim().split('\n').length;
    toast.ok(`Exported ${format.plural(count, 'account')}`,
      saved?.path ? format.truncateMiddle(saved.path, 26, 16) : null);
    return saved;
  } catch (err) {
    toast.fromError(err, 'Could not export those accounts');
    return null;
  }
}

export async function snapshotNow() {
  try {
    // The backend returns the written path, or null when there is no database
    // file yet - which is a real answer, not a failure.
    const path = await bridge.invoke('app.snapshot', { reason: 'manual' });
    if (!path) {
      toast.warn('Nothing to back up yet', 'The database is created on first launch.');
      return null;
    }
    toast.ok('Backup written', format.truncateMiddle(path, 26, 16));
    return path;
  } catch (err) {
    toast.fromError(err, 'Could not back up the database');
    return null;
  }
}

/** Remove accounts, confirming first. Returns the number actually removed. */
export async function removeAccounts(rows, { confirm: ask = null } = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return 0;

  const names = list.slice(0, 3).map((a) => a.username || `#${a.id}`).join(', ');
  const more = list.length > 3 ? ` and ${list.length - 3} more` : '';

  const confirmed = ask
    ? await ask()
    : await bridge.ui.confirm({
        title: list.length === 1 ? 'Remove this account?' : `Remove ${list.length} accounts?`,
        message: `${names}${more} will be removed from flora.`,
        detail: 'The accounts themselves are not affected - only flora\'s copy of them. This cannot be undone.',
        confirmLabel: 'Remove',
        danger: true
      });

  if (!confirmed) return 0;

  try {
    const { removed } = await bridge.invoke('accounts.remove', { ids: list.map((a) => a.id) });
    toast.ok(`Removed ${format.plural(removed, 'account')}`);
    await reload();
    return removed;
  } catch (err) {
    toast.fromError(err, 'Could not remove those accounts');
    return 0;
  }
}

/** Copy a value to the system clipboard, reporting the outcome. */
export async function copy(value, what = 'Value') {
  if (!value) { toast.warn(`Nothing to copy`, `That ${what.toLowerCase()} is empty.`); return; }
  try {
    await bridge.ui.copy(String(value));
    toast.ok(`${what} copied`, null, { timeout: 1800 });
  } catch (err) {
    toast.fromError(err, 'Could not copy that');
  }
}

/** Reveal a secret stored in the database, offering to copy it. */
export async function reveal(id, kind = 'token') {
  try {
    const result = kind === 'token'
      ? await bridge.invoke('accounts.revealToken', { id })
      : await bridge.invoke('accounts.revealPassword', { id });

    const value = kind === 'token' ? result.token : result.password;
    if (!value) {
      toast.warn(`No ${kind} stored`, 'This account does not have one.');
      return null;
    }
    return value;
  } catch (err) {
    toast.fromError(err, `Could not read that ${kind}`);
    return null;
  }
}
