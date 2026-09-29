/**
 * Accounts.
 *
 * The busiest screen in the app: a list that can run to thousands of rows, a
 * selection that drives every bulk action, and a row menu with the per-account
 * operations. Two things keep it honest at that size:
 *
 *   - Filtering and sorting happen in the renderer over the list the store
 *     already holds, so typing in the search box is instant and costs no IPC.
 *   - Only the first `PAGE_SIZE` rows are built. A table of 4000 rows is 4000
 *     checkbox elements, and the browser's layout of that is slower than any
 *     query behind it.
 */
import { h, fill, raf, debounce } from '../dom.js';
import { icon, hydrate } from '../icons.js';
import * as bridge from '../bridge.js';
import * as store from '../store.js';
import * as format from '../format.js';
import * as toast from '../components/toast.js';
import { headElement } from '../lib/heads.js';
import { dataTable, renderRows, emptyState, skeletonRows, sortRows, progress } from '../components/table.js';
import { menu, confirm as confirmDialog } from '../components/overlay.js';
import { shell, bag, searchField } from './shell.js';
import {
  go, reload, selectAll, selectNone, invertSelection, setSelected,
  startAccounts, stopAccounts, testAccounts, refreshProfile, fetchSkins,
  exportAccounts, removeAccounts, copy, reveal
} from '../actions.js';
import { openAddAccountDialog, openAccountDetail } from './accountDialog.js';
import { openImportDialog } from './importDialog.js';
import { openMicrosoftDialog } from './microsoftDialog.js';
import { openSkinPicker } from './skinDialog.js';
import { openNameDialog } from './nameDialog.js';

const PAGE_SIZE = 400;

const FILTERS = [
  { id: 'all', label: 'All', icon: 'users-01' },
  { id: 'selected', label: 'Selected', icon: 'check-circle' },
  { id: 'favorites', label: 'Favourites', icon: 'check' },
  { id: 'ok', label: 'Working', icon: 'check-circle' },
  { id: 'failed', label: 'Failing', icon: 'alert-circle' },
  { id: 'untested', label: 'Never checked', icon: 'help-circle' },
  { id: 'offline', label: 'Offline-mode', icon: 'log-out-01' }
];

export default {
  mount(container) {
    const subscriptions = bag();
    const view = shell({
      title: 'Accounts',
      subtitle: 'Loading…',
      flush: true
    });

    let query = '';
    let filter = 'all';
    let tag = null;
    let sort = { key: 'added', dir: 'desc' };
    let limit = PAGE_SIZE;
    let rows = [];

    // `flush: true` hands this view the full width so the toolbar and table can
    // scroll edge to edge; the page gutter is put back by hand here. It is
    // `--page-pad` and not a number, because the page title above uses the same
    // token - a literal 24 here is exactly how a table ends up indented half as
    // far as its own heading.
    const toolbar = h('div.toolbar', { style: { padding: '4px var(--page-pad) 14px', margin: '0' } });
    const busyHost = h('div', { style: { padding: '0 var(--page-pad)' } });
    const tableHost = h('div', { style: { padding: '0 var(--page-pad) 40px' } });
    const footerHost = h('div', { style: { padding: '0 var(--page-pad) 40px' } });

    view.body.append(toolbar, busyHost, tableHost, footerHost);

    // ------------------------------------------------------------ filtering

    const STATUS_OF = (account) => store.botFor(account.id).status ?? 'offline';

    function matches(account) {
      if (query) {
        const needle = query.toLowerCase();
        const haystack = `${account.username ?? ''} ${account.label ?? ''} ${account.uuid ?? ''} ${(account.tags ?? []).join(' ')}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }

      if (tag && !(account.tags ?? []).includes(tag)) return false;

      switch (filter) {
        case 'selected': return account.selected;
        case 'favorites': return account.favorite;
        case 'ok': return account.lastTestOk === true;
        case 'failed': return account.lastTestOk === false;
        case 'untested': return account.lastTestedAt == null;
        case 'offline': return account.kind === 'offline';
        default: return true;
      }
    }

    const SORT_ACCESSORS = {
      added: (a) => a.createdAt,
      name: (a) => (a.username ?? '').toLowerCase() || null,
      tested: (a) => a.lastTestedAt,
      status: (a) => STATUS_OF(a),
      updated: (a) => a.updatedAt
    };

    function compute() {
      const all = store.accounts();
      rows = all.filter(matches);

      // Live status sorts by a rank rather than alphabetically, so "online"
      // does not end up between "offline" and "starting".
      if (sort.key === 'status') {
        const rank = { online: 0, connecting: 1, starting: 1, stopping: 2, offline: 3, error: 4, kicked: 4 };
        rows.sort((a, b) => {
          const delta = (rank[STATUS_OF(a)] ?? 9) - (rank[STATUS_OF(b)] ?? 9);
          return sort.dir === 'desc' ? -delta : delta;
        });
      } else {
        rows = sortRows(rows, sort.key, sort.dir, SORT_ACCESSORS[sort.key]);
      }
    }

    // ------------------------------------------------------------ selection

    function selectionSet() {
      return new Set(rows.filter((a) => a.selected).map((a) => a.id));
    }

    const selectedRows = () => store.accounts().filter((a) => a.selected);

    // ------------------------------------------------------------ toolbar

    const searchBox = searchField({
      placeholder: 'Search accounts…',
      label: 'Search accounts by username, label, UUID or tag',
      width: 260,
      onInput: debounce((value) => {
        query = value.trim();
        limit = PAGE_SIZE;
        paint();
      }, 160)
    });

    const chips = h('div.row', { style: { gap: '6px', flexWrap: 'wrap' } });
    const tagHost = h('div');
    const bulkHost = h('div.row', { style: { marginLeft: 'auto', gap: '8px' } });

    function paintChips() {
      const counts = {
        all: store.accounts().length,
        selected: selectedRows().length,
        favorites: store.accounts().filter((a) => a.favorite).length,
        ok: store.accounts().filter((a) => a.lastTestOk === true).length,
        failed: store.accounts().filter((a) => a.lastTestOk === false).length,
        untested: store.accounts().filter((a) => a.lastTestedAt == null).length,
        offline: store.accounts().filter((a) => a.kind === 'offline').length
      };

      fill(chips, FILTERS.map((entry) => h('button.chip', {
        type: 'button',
        'aria-pressed': filter === entry.id ? 'true' : 'false',
        onclick: () => {
          filter = entry.id;
          limit = PAGE_SIZE;
          paintChips();
          paint();
        }
      }, [
        icon(entry.icon, { size: 13 }),
        entry.label,
        h('span.chip__count', format.num(counts[entry.id] ?? 0))
      ])));
      hydrate(chips);
    }

    async function paintTags() {
      let tags = [];
      try {
        tags = await bridge.invoke('accounts.tags', {}) ?? [];
      } catch { /* tags are a nicety; the rest of the toolbar still works */ }

      if (!tags.length) { fill(tagHost, null); return; }

      const options = tags.slice(0, 12).map((entry) => ({
        label: `${entry.tag} (${entry.count ?? 0})`,
        checked: tag === entry.tag,
        onClick: () => {
          tag = tag === entry.tag ? null : entry.tag;
          limit = PAGE_SIZE;
          paintTags();
          paint();
        }
      }));

      const button = h('button.btn.btn--ghost', { type: 'button' }, [
        icon('colors', { size: 14 }),
        tag ?? 'Any tag',
        icon('chevron-down', { size: 13 })
      ]);
      button.addEventListener('click', () => menu(button, [
        { label: 'Any tag', checked: tag === null, onClick: () => { tag = null; limit = PAGE_SIZE; paintTags(); paint(); } },
        ...options
      ]));

      fill(tagHost, [button]);
      hydrate(tagHost);
    }

    function paintBulk() {
      const selected = selectedRows();
      const count = selected.length;
      const running = selected.filter((a) => STATUS_OF(a) !== 'offline').length;

      const actions = count
        ? [
            { icon: 'play', label: `Start ${format.num(count)}`, tone: 'primary', run: () => startAccounts(selected.map((a) => a.id)) },
            running ? { icon: 'square', label: `Stop ${format.num(running)}`, run: () => stopAccounts(selected.filter((a) => STATUS_OF(a) !== 'offline').map((a) => a.id)) } : null,
            { icon: 'clipboard-check', label: 'Check', run: () => testAccounts(selected.map((a) => a.id)) },
            { icon: 'paint-pour', label: 'Skins', run: () => openSkinPicker(selected.map((a) => a.id)) },
            { icon: 'download-cloud-02', label: 'Refresh heads', run: () => fetchSkins(selected.map((a) => a.id), { force: false }) }
          ].filter(Boolean)
        : [];

      fill(bulkHost, [
        ...actions.map((action) => h(
          `button.btn.btn--sm${action.tone === 'primary' ? '.btn--primary' : ''}`,
          { type: 'button', onclick: action.run },
          [icon(action.icon, { size: 14 }), action.label]
        )),
        h('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          'aria-label': 'More bulk actions',
          onclick: (event) => menu(event.currentTarget, [
            { header: true, label: count ? `${count} selected` : 'Selection' },
            { icon: 'check-circle', label: 'Select everything', onClick: () => run(selectAll) },
            { icon: 'x-close', label: 'Clear the selection', onClick: () => run(selectNone) },
            { icon: 'refresh-ccw-02', label: 'Invert the selection', onClick: () => run(invertSelection) },
            { separator: true },
            { icon: 'globe-01', label: 'Give each a proxy', disabled: !count, onClick: () => assignProxies(selected, false) },
            { icon: 'refresh-cw-01', label: 'Re-assign proxies', disabled: !count, onClick: () => assignProxies(selected, true) },
            { icon: 'x-close', label: 'Clear proxy assignment', disabled: !count, onClick: () => clearProxies(selected) },
            { separator: true },
            { icon: 'download-01', label: 'Export selected', disabled: !count, onClick: () => exportAccounts({ ids: selected.map((a) => a.id) }) },
            { icon: 'download-01', label: 'Export everything', onClick: () => exportAccounts({ ids: [] }) },
            { icon: 'key-01', label: 'Export with tokens…', danger: true, disabled: !count, onClick: () => exportWithSecrets(selected) },
            { separator: true },
            { icon: 'trash-01', label: 'Remove selected', danger: true, disabled: !count, onClick: () => removeAccounts(selected) }
          ])
        }, [icon('dots-vertical', { size: 15 })])
      ]);
      hydrate(bulkHost);
    }

    async function run(fn) {
      await fn();
      paint();
    }

    async function assignProxies(list, reassign) {
      if (!list.length) return;
      try {
        const result = await bridge.invoke('proxies.assign', { ids: list.map((a) => a.id), reassign });
        toast.ok('Proxies assigned', `${format.plural(result.changed ?? 0, 'account')} updated.`);
        await reload();
        paint();
      } catch (err) {
        toast.fromError(err, 'Could not assign proxies');
      }
    }

    async function clearProxies(list) {
      if (!list.length) return;
      try {
        await bridge.invoke('proxies.clearAssignments', { ids: list.map((a) => a.id) });
        toast.ok('Assignments cleared');
        await reload();
        paint();
      } catch (err) {
        toast.fromError(err, 'Could not clear those assignments');
      }
    }

    async function exportWithSecrets(list) {
      const confirmed = await confirmDialog({
        title: 'Export tokens in plain text?',
        message: `The file will contain working access tokens for ${format.plural(list.length, 'account')}.`,
        detail: 'Anyone who opens that file can sign in as those accounts. Keep it somewhere safe and delete it when you are done.',
        confirmLabel: 'Export anyway',
        danger: true
      });
      if (!confirmed) return;
      await exportAccounts({ ids: list.map((a) => a.id), includeSecrets: true });
    }

    // ------------------------------------------------------------ columns

    const columns = [
      {
        key: 'account',
        label: 'Account',
        sortable: true,
        width: '30%',
        render: (account) => h('div.account-cell', [
          headElement(account.skinHash, { name: account.username, size: 28 }),
          h('div.account-cell__text', [
            h('b', account.username || 'Unnamed'),
            h('span', account.tokenHint || account.uuid || (account.kind === 'offline' ? 'Offline-mode' : '—'))
          ])
        ])
      },
      {
        key: 'kind',
        label: 'Type',
        width: '92px',
        render: (account) => h('span.tag', format.kindLabel(account.kind))
      },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        width: '128px',
        render: (account) => {
          const bot = store.botFor(account.id);
          const tone = format.statusTone(bot.status);
          return h('div', { style: { display: 'grid', gap: '3px' } }, [
            h(`span.badge.badge--${tone}${bot.status === 'online' ? '.badge--live' : ''}`, format.statusLabel(bot.status)),
            bot.server ? h('span.muted', { style: { fontSize: 'var(--fs-xs)' } }, format.server(bot.server)) : null
          ]);
        }
      },
      {
        key: 'proxy',
        label: 'Proxy',
        width: '150px',
        render: (account) => {
          const proxy = account.proxyId ? store.proxyById(account.proxyId) : null;
          if (!proxy) return h('span.muted', '—');
          const tone = proxy.lastOk === false ? 'danger' : proxy.lastOk === true ? 'ok' : 'idle';
          return h('span.mono-sm', { style: { color: `var(--${tone === 'idle' ? 'overlay1' : tone})` } },
            `${proxy.host}:${proxy.port}`);
        }
      },
      {
        key: 'tested',
        label: 'Last check',
        sortable: true,
        width: '150px',
        render: (account) => {
          if (account.lastTestedAt == null) return h('span.muted', 'never');
          const ok = account.lastTestOk === true;
          return h('div', { style: { display: 'grid', gap: '2px' } }, [
            h(`span.badge.badge--${ok ? 'ok' : 'danger'}`, ok ? 'Working' : 'Failed'),
            h('span.muted', { style: { fontSize: 'var(--fs-xs)' } }, format.ago(account.lastTestedAt))
          ]);
        }
      },
      {
        key: 'added',
        label: 'Added',
        sortable: true,
        align: 'right',
        width: '110px',
        render: (account) => h('span.muted', { style: { fontSize: 'var(--fs-sm)' } }, format.ago(account.createdAt))
      },
      {
        key: 'actions',
        label: '',
        cellClass: 'col-actions',
        render: (account) => h('div.cell-actions', [
          rowMenuButton(account)
        ])
      }
    ];

    function rowMenuButton(account) {
      const status = STATUS_OF(account);
      const live = status !== 'offline';

      return h('button.btn.btn--ghost.btn--icon.btn--sm', {
        type: 'button',
        'aria-label': `Actions for ${account.username || 'this account'}`,
        onclick: (event) => {
          event.stopPropagation();
          menu(event.currentTarget, [
            { header: true, label: account.username || `Account ${account.id}` },
            live
              ? { icon: 'square', label: 'Disconnect', onClick: () => stopAccounts([account.id]) }
              : { icon: 'play', label: 'Connect to a server', onClick: () => startAccounts([account.id]) },
            { icon: 'clipboard-check', label: 'Check the token', onClick: () => testAccounts([account.id]) },
            { icon: 'refresh-cw-01', label: 'Refresh name and skin', disabled: account.kind === 'offline', onClick: () => refreshProfile(account.id) },
            { icon: 'paint-pour', label: 'Change skin…', onClick: () => openSkinPicker([account.id]) },
            // One account at a time on purpose: Mojang permits a rename once
            // every 30 days per account, so there is no bulk version of this.
            { icon: 'pencil-01', label: 'Change username…', disabled: account.kind === 'offline', onClick: () => openNameDialog(account.id) },
            { separator: true },
            { icon: 'copy-01', label: 'Copy username', onClick: () => copy(account.username, 'Username') },
            { icon: 'copy-01', label: 'Copy UUID', disabled: !account.uuid, onClick: () => copy(account.uuid, 'UUID') },
            { icon: 'key-01', label: 'Copy access token', disabled: !account.hasToken, onClick: () => revealAndCopy(account, 'token') },
            { icon: 'key-01', label: 'Copy password', disabled: !account.hasPassword, onClick: () => revealAndCopy(account, 'password') },
            { separator: true },
            { icon: 'eye', label: 'Details and notes…', onClick: () => openDetail(account) },
            { icon: 'terminal', label: 'Open the console', onClick: () => { store.emit(store.TOPICS.NAVIGATE, 'bots'); } },
            { separator: true },
            { icon: 'trash-01', label: 'Remove from flora', danger: true, onClick: () => removeAccounts([account]) }
          ]);
        }
      }, [icon('dots-vertical', { size: 15 })]);
    }

    async function revealAndCopy(account, kind) {
      const value = await reveal(account.id, kind);
      if (value) await copy(value, kind === 'token' ? 'Access token' : 'Password');
    }

    function openDetail(account) {
      openAccountDetail(account.id, { onChanged: () => { reload(); paint(); } });
    }

    // ------------------------------------------------------------ painting

    const paintTable = raf(() => {
      const shown = rows.slice(0, limit);

      if (!store.accounts().length) {
        fill(tableHost, emptyState({
          icon: 'users-01',
          title: 'No accounts yet',
          body: 'Import a list from a file, sign in with Microsoft, or paste a token. flora keeps them encrypted at rest.',
          action: h('div.row', { style: { gap: '8px' } }, [
            h('button.btn.btn--primary', { type: 'button', onclick: () => openImportDialog() }, [icon('file-plus-02', { size: 15 }), 'Import a file']),
            h('button.btn', { type: 'button', onclick: () => openMicrosoftDialog() }, [icon('key-01', { size: 15 }), 'Sign in with Microsoft']),
            h('button.btn.btn--ghost', { type: 'button', onclick: () => openAddAccountDialog() }, [icon('plus', { size: 15 }), 'Add by token'])
          ])
        }));
        hydrate(tableHost);
        return;
      }

      if (!rows.length) {
        fill(tableHost, emptyState({
          icon: 'search-md',
          title: 'Nothing matches those filters',
          body: 'Try a different search, or clear the filters to see everything.',
          action: h('button.btn', {
            type: 'button',
            onclick: () => {
              query = '';
              filter = 'all';
              tag = null;
              limit = PAGE_SIZE;
              // Clearing through the box keeps its own clear button in step.
              searchBox.reset();
              paintChips();
              paint();
            }
          }, 'Clear filters')
        }));
        hydrate(tableHost);
        return;
      }

      const selection = selectionSet();

      fill(tableHost, dataTable({
        columns,
        rows: shown,
        selectable: true,
        selection,
        sort,
        onSort: (key) => {
          if (!columns.find((c) => c.key === key)?.sortable) return;
          sort = { key, dir: sort.key === key && sort.dir === 'desc' ? 'asc' : 'desc' };
          compute();
          paintTable();
          paintFooter();
        },
        onSelect: (key, checked) => { setSelected([Number(key)], checked); },
        onSelectAll: (checked) => run(checked ? selectAll : selectNone),
        onRowClick: (account) => openDetail(account),
        rowAttrs: (account) => ({ clickable: 'true' })
      }));

      hydrate(tableHost);
    });

    function paintFooter() {
      const parts = [`Showing ${format.num(Math.min(limit, rows.length))} of ${format.num(rows.length)}`];
      if (rows.length !== store.accounts().length) parts.push(`filtered from ${format.num(store.accounts().length)}`);

      fill(footerHost, h('div.row', { style: { justifyContent: 'space-between', gap: '10px' } }, [
        h('span.muted', { style: { fontSize: 'var(--fs-sm)' } }, parts.join(' · ')),
        rows.length > limit
          ? h('button.btn.btn--outline.btn--sm', {
              type: 'button',
              onclick: () => { limit += PAGE_SIZE; paintTable(); paintFooter(); }
            }, [icon('chevron-down', { size: 14 }), `Show ${format.num(Math.min(PAGE_SIZE, rows.length - limit))} more`])
          : null
      ]));
      hydrate(footerHost);
    }

    /**
     * Live progress for whatever the backend is working through.
     *
     * Two sources feed this: `app:busy` announces a job's start and end, and the
     * per-item `*-progress` events carry the running totals. They are merged
     * into one map so a job reports a percentage when it knows the total and an
     * indeterminate bar when it does not.
     */
    const PROGRESS_SCOPE = {
      'accounts:test-progress': 'test',
      'accounts:import-progress': 'import',
      'skins:progress': 'skins',
      'proxies:check-progress': 'proxies'
    };

    const PROGRESS_LABEL = {
      test: 'Checking accounts',
      import: 'Importing accounts',
      skins: 'Fetching skins',
      proxies: 'Checking proxies'
    };

    const live = new Map();
    let stallTimer = null;

    function noteProgress(payload) {
      if (!payload) return;

      if (payload.scope) {
        if (payload.active) live.set(payload.scope, { done: 0, total: payload.total ?? 0 });
        else live.delete(payload.scope);
      } else if (payload.event) {
        const scope = PROGRESS_SCOPE[payload.event];
        if (!scope) return;
        const done = payload.done ?? 0;
        const total = payload.total ?? 0;
        if (total && done >= total) live.delete(scope);
        else live.set(scope, { done, total });
      } else {
        return;
      }

      // A backend that dies mid-job would otherwise leave a bar on screen
      // forever, claiming work that is no longer happening.
      clearTimeout(stallTimer);
      if (live.size) stallTimer = setTimeout(() => { live.clear(); paintBusy(); }, 20000);

      paintBusy();
    }

    const paintBusy = raf(() => {
      if (!live.size) { fill(busyHost, null); return; }

      fill(busyHost, h('div', { style: { display: 'grid', gap: '10px', paddingBottom: '12px' } },
        [...live.entries()].map(([scope, value]) => progress({
          done: value.done,
          total: value.total,
          label: PROGRESS_LABEL[scope] ?? scope
        }))));
    });

    function paint() {
      paintChips();
      paintBulk();
      compute();
      paintTable();
      paintFooter();
      view.setSubtitle(summary());
    }

    function summary() {
      const all = store.accounts();
      if (!all.length) return 'Nothing imported yet.';
      const online = store.onlineCount();
      const failing = all.filter((a) => a.lastTestOk === false).length;
      const selected = all.filter((a) => a.selected).length;

      const parts = [format.plural(all.length, 'account')];
      if (selected) parts.push(`${format.num(selected)} selected`);
      if (online) parts.push(`${format.num(online)} online`);
      if (failing) parts.push(`${format.num(failing)} failing`);
      return `${parts.join(' · ')}.`;
    }

    // ------------------------------------------------------------ chrome

    view.add(
      h('button.btn.btn--outline', { type: 'button', onclick: () => openAddAccountDialog() }, [icon('plus', { size: 15 }), 'Add']),
      h('button.btn.btn--primary', { type: 'button', onclick: () => openImportDialog() }, [icon('file-plus-02', { size: 15 }), 'Import'])
    );

    fill(toolbar, [
      h('div.row', { style: { gap: '10px', flexWrap: 'wrap' } }, [searchBox.el, tagHost, bulkHost]),
      h('div', [chips])
    ]);
    hydrate(toolbar);

    view.mount(container);

    // First paint from whatever the store already has, so the view is not blank
    // while the initial load is in flight.
    if (store.accounts().length) {
      paint();
    } else {
      fill(tableHost, skeletonRows(8));
      paintChips();
      paintBulk();
      // An empty store means one of two things: the first load is still running,
      // or it finished and there is genuinely nothing. Only the first of those
      // ends in an `accounts` event, so on a fresh install the skeletons used to
      // stay up for good. Asking once settles it either way, and asking is a
      // single query against a local file.
      reload();
    }

    paintTags();

    // ------------------------------------------------------------ events

    subscriptions.add(store.subscribe(store.TOPICS.ACCOUNTS, () => paint()));
    subscriptions.add(store.subscribe(store.TOPICS.BOTS, () => { paintTable(); paintBulk(); }));
    subscriptions.add(store.subscribe(store.TOPICS.PROXIES, () => paintTable()));
    subscriptions.add(store.subscribe(store.TOPICS.BUSY, noteProgress));

    return {
      refresh() {
        reload();
        paintTags();
        paint();
      },
      destroy() {
        clearTimeout(stallTimer);
        subscriptions.dispose();
      }
    };
  }
};
