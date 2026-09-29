/**
 * Proxies.
 *
 * A pool table with the operations that only make sense in bulk: paste a list,
 * check them all, and hand one to each account. The "in use" column is the one
 * that matters most - a proxy silently shared by thirty accounts is the reason
 * a farm gets flagged, and it is invisible without this count.
 */
import { h, fill, raf, debounce } from '../dom.js';
import { icon, hydrate } from '../icons.js';
import * as bridge from '../bridge.js';
import * as store from '../store.js';
import * as format from '../format.js';
import * as toast from '../components/toast.js';
import { dataTable, emptyState, skeletonRows, sortRows, progress } from '../components/table.js';
import { menu, modal, dropdown, confirm as confirmDialog } from '../components/overlay.js';
import { shell, bag, field, searchField } from './shell.js';
import { copy, go } from '../actions.js';

const PROTOCOLS = ['socks5', 'socks4', 'http', 'https'];

export default {
  mount(container) {
    const subscriptions = bag();
    const view = shell({ title: 'Proxies', subtitle: 'Loading…', flush: true });

    let query = '';
    let protocol = null;
    let status = 'all';
    let sort = { key: 'host', dir: 'asc' };
    let usage = {};
    let rows = [];

    // See the note in accounts.js: the flush body hands the width to the view,
    // and the gutter it puts back has to be the same `--page-pad` the page title
    // is inset by or the two do not line up.
    const toolbar = h('div.toolbar', { style: { padding: '4px var(--page-pad) 14px', margin: '0' } });
    const busyHost = h('div', { style: { padding: '0 var(--page-pad)' } });
    const tableHost = h('div', { style: { padding: '0 var(--page-pad) 40px' } });

    view.body.append(toolbar, busyHost, tableHost);

    // ------------------------------------------------------------ data

    const searchBox = searchField({
      placeholder: 'Search proxies…',
      label: 'Search proxies by host, port or label',
      width: 260,
      onInput: debounce((value) => {
        query = value.trim();
        paint();
      }, 160)
    });

    const chips = h('div.row', { style: { gap: '6px', flexWrap: 'wrap' } });
    const bulkHost = h('div.row', { style: { marginLeft: 'auto', gap: '8px' } });

    function matches(proxy) {
      if (protocol && proxy.protocol !== protocol) return false;
      if (status === 'ok' && proxy.lastOk !== true) return false;
      if (status === 'failed' && proxy.lastOk !== false) return false;
      if (status === 'unchecked' && proxy.lastCheckedAt != null) return false;
      if (status === 'idle' && (usage[proxy.id] ?? 0) > 0) return false;
      if (query) {
        const needle = query.toLowerCase();
        if (!`${proxy.host}:${proxy.port} ${proxy.label ?? ''}`.toLowerCase().includes(needle)) return false;
      }
      return true;
    }

    function compute() {
      rows = store.proxies().filter(matches);
      rows = sortRows(rows, sort.key, sort.dir, sort.key === 'usage' ? (p) => usage[p.id] ?? 0 : null);
    }

    function paintChips() {
      const all = store.proxies();
      const counts = {
        all: all.length,
        ok: all.filter((p) => p.lastOk === true).length,
        failed: all.filter((p) => p.lastOk === false).length,
        unchecked: all.filter((p) => p.lastCheckedAt == null).length,
        idle: all.filter((p) => !(usage[p.id] > 0)).length
      };

      fill(chips, [
        ...[['all', 'All'], ['ok', 'Working'], ['failed', 'Failing'], ['unchecked', 'Never checked'], ['idle', 'Unused']]
          .map(([id, label]) => h('button.chip', {
            type: 'button',
            'aria-pressed': status === id ? 'true' : 'false',
            onclick: () => { status = id; paintChips(); paint(); }
          }, [label, h('span.chip__count', format.num(counts[id] ?? 0))])),
        h('div', { style: { width: '1px', height: '18px', background: 'var(--surface0)', margin: '0 4px' } }),
        ...PROTOCOLS.map((entry) => h('button.chip', {
          type: 'button',
          'aria-pressed': protocol === entry ? 'true' : 'false',
          onclick: () => { protocol = protocol === entry ? null : entry; paintChips(); paint(); }
        }, entry.toUpperCase()))
      ]);
    }

    function paintBulk() {
      const selected = selectedProxies();
      const count = selected.length;
      const disabled = count === 0;

      fill(bulkHost, [
        h('button.btn.btn--sm', {
          type: 'button',
          disabled,
          onclick: () => checkMany(selected.map((p) => p.id))
        }, [icon('clipboard-check', { size: 14 }), count ? `Check ${format.num(count)}` : 'Check']),
        h('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          disabled: disabled && !store.proxies().length,
          onclick: (event) => menu(event.currentTarget, [
            { header: true, label: count ? `${count} selected` : 'Pool' },
            { icon: 'play', label: 'Enable selected', disabled, onClick: () => setEnabled(selected, true) },
            { icon: 'square', label: 'Disable selected', disabled, onClick: () => setEnabled(selected, false) },
            { separator: true },
            { icon: 'globe-01', label: 'Give one to each selected account', onClick: () => assignToSelection() },
            { icon: 'clipboard-check', label: 'Check the whole pool', onClick: () => checkMany(store.proxies().map((p) => p.id)) },
            { icon: 'copy-01', label: 'Copy the pool as text', onClick: () => copyPool() },
            { separator: true },
            { icon: 'trash-01', label: 'Remove selected', danger: true, disabled, onClick: () => removeSelected(selected) }
          ])
        }, [icon('dots-vertical', { size: 15 })])
      ]);
      hydrate(bulkHost);
    }

    const selectedProxies = () => store.proxies().filter((p) => p.selected);

    // ------------------------------------------------------------ actions

    async function checkMany(ids) {
      if (!ids.length) return;
      const handle = toast.info(`Checking ${format.plural(ids.length, 'proxy', 'proxies')}…`, null, { id: 'proxy-check', timeout: 0 });
      try {
        const result = await bridge.invoke('proxies.checkMany', { ids });
        const working = result.results.filter((r) => r.ok).length;
        handle.close();
        const tone = working === ids.length ? toast.ok : toast.warn;
        tone('Proxy check finished', `${working} of ${ids.length} reachable.`);
        await store.refreshProxies();
        await loadUsage();
        paint();
      } catch (err) {
        handle.close();
        toast.fromError(err, 'Could not check those proxies');
      }
    }

    async function setEnabled(list, enabled) {
      if (!list.length) return;
      try {
        for (const proxy of list) {
          await bridge.invoke('proxies.update', { id: proxy.id, patch: { enabled } });
        }
        toast.ok(`${enabled ? 'Enabled' : 'Disabled'} ${format.plural(list.length, 'proxy', 'proxies')}`);
        await store.refreshProxies();
        paint();
      } catch (err) {
        toast.fromError(err, 'Could not update those proxies');
      }
    }

    async function removeSelected(list) {
      if (!list.length) return;
      const confirmed = await confirmDialog({
        title: `Remove ${format.plural(list.length, 'proxy', 'proxies')}?`,
        message: 'Accounts using them keep their assignment until it is cleared.',
        detail: 'This cannot be undone.',
        confirmLabel: 'Remove',
        danger: true
      });
      if (!confirmed) return;

      try {
        await bridge.invoke('proxies.remove', { ids: list.map((p) => p.id) });
        toast.ok(`Removed ${format.plural(list.length, 'proxy', 'proxies')}`);
        await store.refreshProxies();
        await loadUsage();
        paint();
      } catch (err) {
        toast.fromError(err, 'Could not remove those proxies');
      }
    }

    async function assignToSelection() {
      const ids = store.selectedIds();
      if (!ids.length) {
        toast.warn('No accounts selected', 'Tick the accounts you want to give proxies to, then try again.');
        go('accounts');
        return;
      }
      try {
        const result = await bridge.invoke('proxies.assign', { ids, reassign: true });
        toast.ok('Proxies assigned', `${format.plural(result.changed ?? 0, 'account')} updated.`);
        await loadUsage();
        await store.refreshAccounts({ immediate: true });
        paint();
      } catch (err) {
        toast.fromError(err, 'Could not assign proxies');
      }
    }

    async function copyPool() {
      const all = store.proxies();
      if (!all.length) { toast.warn('The pool is empty'); return; }
      const text = all.map((p) => {
        const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password ?? '')}@` : '';
        return `${p.protocol}://${auth}${p.host}:${p.port}`;
      }).join('\n');
      await bridge.ui.copy(text);
      toast.ok(`Copied ${format.plural(all.length, 'proxy', 'proxies')}`);
    }

    async function loadUsage() {
      try {
        usage = await bridge.invoke('proxies.usage', {}) ?? {};
      } catch { /* the column shows dashes */ }
    }

    // ------------------------------------------------------------ columns

    const columns = [
      {
        key: 'host',
        label: 'Proxy',
        sortable: true,
        width: '34%',
        render: (proxy) => h('div.account-cell__text', [
          h('b', `${proxy.host}:${proxy.port}`),
          h('span', [proxy.username ? `${proxy.username} · ` : null, proxy.label || 'no label'])
        ])
      },
      {
        key: 'protocol',
        label: 'Type',
        width: '84px',
        render: (proxy) => h('span.tag', proxy.protocol.toUpperCase())
      },
      {
        key: 'enabled',
        label: 'State',
        width: '92px',
        render: (proxy) => h(`span.badge.badge--${proxy.enabled ? 'ok' : 'idle'}`, proxy.enabled ? 'Enabled' : 'Disabled')
      },
      {
        key: 'lastOk',
        label: 'Reachability',
        width: '160px',
        render: (proxy) => {
          if (proxy.lastCheckedAt == null) return h('span.muted', 'never checked');
          return h('div', { style: { display: 'grid', gap: '2px' } }, [
            h(`span.badge.badge--${proxy.lastOk ? 'ok' : 'danger'}`, proxy.lastOk ? format.latency(proxy.lastLatencyMs) : 'Unreachable'),
            h('span.muted', {
              style: { fontSize: 'var(--fs-xs)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
            }, proxy.lastError ?? format.ago(proxy.lastCheckedAt))
          ]);
        }
      },
      {
        key: 'usage',
        label: 'In use',
        sortable: true,
        align: 'right',
        width: '90px',
        render: (proxy) => {
          const count = usage[proxy.id] ?? 0;
          if (!count) return h('span.muted', '—');
          // A proxy carrying a lot of accounts is the thing worth noticing.
          const tone = count > 10 ? 'danger' : count > 3 ? 'warn' : 'info';
          return h(`span.badge.badge--${tone}`, format.num(count));
        }
      },
      {
        key: 'actions',
        label: '',
        cellClass: 'col-actions',
        render: (proxy) => h('div.cell-actions', [
          h('button.btn.btn--ghost.btn--icon.btn--sm', {
            type: 'button',
            'aria-label': `Actions for ${proxy.host}`,
            onclick: (event) => {
              event.stopPropagation();
              menu(event.currentTarget, [
                { header: true, label: `${proxy.host}:${proxy.port}` },
                { icon: 'clipboard-check', label: 'Check it now', onClick: () => checkMany([proxy.id]) },
                { icon: proxy.enabled ? 'square' : 'play', label: proxy.enabled ? 'Disable' : 'Enable', onClick: () => setEnabled([proxy], !proxy.enabled) },
                { separator: true },
                { icon: 'copy-01', label: 'Copy address', onClick: () => copy(`${proxy.host}:${proxy.port}`, 'Address') },
                { icon: 'copy-01', label: 'Copy full URL', onClick: () => copyProxyUrl(proxy) },
                { icon: 'pencil-01', label: 'Edit…', onClick: () => openEditDialog(proxy) },
                { separator: true },
                { icon: 'trash-01', label: 'Remove', danger: true, onClick: () => removeSelected([proxy]) }
              ]);
            }
          }, [icon('dots-vertical', { size: 15 })])
        ])
      }
    ];

    async function copyProxyUrl(proxy) {
      const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@` : '';
      await copy(`${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`, 'Proxy URL');
    }

    // ------------------------------------------------------------ painting

    const paintTable = raf(() => {
      const all = store.proxies();

      if (!all.length) {
        fill(tableHost, emptyState({
          icon: 'globe-01',
          title: 'No proxies yet',
          body: 'Paste a list of proxies to spread your accounts across them. Each account can be pinned to one.',
          action: h('button.btn.btn--primary', { type: 'button', onclick: () => openAddDialog() }, [
            icon('plus', { size: 15 }), 'Add proxies'
          ])
        }));
        hydrate(tableHost);
        return;
      }

      if (!rows.length) {
        fill(tableHost, emptyState({
          icon: 'search-md',
          title: 'Nothing matches those filters',
          action: h('button.btn', {
            type: 'button',
            onclick: () => {
              query = ''; protocol = null; status = 'all';
              searchBox.reset();
              paintChips();
              paint();
            }
          }, 'Clear filters')
        }));
        hydrate(tableHost);
        return;
      }

      const selection = new Set(rows.filter((p) => p.selected).map((p) => p.id));

      fill(tableHost, h('div', { style: { marginTop: '12px' } }, dataTable({
        columns,
        rows,
        selectable: true,
        selection,
        sort,
        onSort: (key) => {
          if (!columns.find((c) => c.key === key)?.sortable) return;
          sort = { key, dir: sort.key === key && sort.dir === 'asc' ? 'desc' : 'asc' };
          compute();
          paintTable();
        },
        onSelect: (key, checked) => {
          const proxy = store.proxyById(key);
          if (!proxy) return;
          // Proxies have no selection column in the database; the row flag is
          // what `checkMany` and `remove` are called with, so it lives here and
          // is deliberately not persisted.
          proxy.selected = checked;
          paintTable();
          paintBulk();
        },
        onSelectAll: (checked) => {
          for (const proxy of rows) proxy.selected = checked;
          paintTable();
          paintBulk();
        },
        onRowClick: (proxy) => openEditDialog(proxy),
        rowAttrs: () => ({ clickable: 'true' })
      })));

      hydrate(tableHost);
    });

    const paintBusy = raf(() => {
      const value = store.state.busy.proxies;
      if (!value?.active) { fill(busyHost, null); return; }
      fill(busyHost, h('div', { style: { paddingBottom: '12px' } }, [
        progress({ done: value.done ?? 0, total: value.total ?? 0, label: 'Checking proxies' })
      ]));
    });

    function paint() {
      paintChips();
      paintBulk();
      compute();
      paintTable();
      paintBusy();

      const all = store.proxies();
      if (!all.length) view.setSubtitle('Nothing added yet.');
      else {
        const working = all.filter((p) => p.lastOk === true).length;
        view.setSubtitle(`${format.plural(all.length, 'proxy', 'proxies')} · ${format.num(working)} working.`);
      }
    }

    // ------------------------------------------------------------ dialogs

    function openAddDialog() {
      const textarea = h('textarea', {
        placeholder: 'host:port\nuser:pass@host:port\nsocks5://host:port\nhttp://user:pass@host:port',
        spellcheck: 'false',
        rows: '8'
      });

      const preview = h('div', { style: { marginTop: '12px' } });
      // Named `picker` and not `protocol`: `protocol` is the toolbar's filter,
      // and shadowing it here would silently disconnect that chip row.
      const protocolPicker = dropdown({
        options: PROTOCOLS.map((entry) => ({ value: entry, label: entry.toUpperCase() })),
        value: 'socks5',
        label: 'Default protocol'
      });
      const protocolField = field({
        label: 'Default protocol',
        control: protocolPicker.el,
        hint: 'Used for lines that do not name one themselves.'
      });

      let parsed = null;

      async function doParse() {
        const text = textarea.value.trim();
        if (!text) { fill(preview, null); parsed = null; return; }

        try {
          parsed = await bridge.invoke('proxies.parse', { text, protocol: protocolPicker.value });
          const { counts, invalid } = parsed;
          fill(preview, h('div.callout', { class: counts.valid ? 'callout--ok' : 'callout--warn' }, [
            icon(counts.valid ? 'check-circle' : 'alert-triangle', { size: 15 }),
            h('div', [
              h('b', `${format.num(counts.valid)} usable`),
              counts.invalid ? ` · ${counts.invalid} line${counts.invalid === 1 ? '' : 's'} could not be read` : '',
              invalid?.length
                ? h('div', { style: { marginTop: '6px', fontFamily: 'var(--mono)', fontSize: 'var(--fs-xs)', color: 'var(--overlay1)' } },
                    invalid.slice(0, 6).map((entry) => h('div', `${entry.line ?? '?'}: ${entry.reason ?? 'unreadable'}`)))
                : null
            ])
          ]));
          hydrate(preview);
        } catch (err) {
          fill(preview, h('p.field__error', err.message));
          parsed = null;
        }
      }

      textarea.addEventListener('input', debounce(doParse, 250));

      const dialog = modal({
        title: 'Add proxies',
        subtitle: 'One per line. Duplicates are ignored.',
        size: 'wide',
        body: h('div', [textarea, protocolField.el, preview]),
        actions: [
          { label: 'Cancel' },
          {
            label: 'Add them',
            tone: 'primary',
            busyLabel: 'Adding…',
            close: false,
            onClick: async () => {
              if (!parsed || !parsed.counts.valid) { await doParse(); }
              if (!parsed?.counts.valid) {
                fill(preview, h('p.field__error', 'Nothing usable to add yet.'));
                return false;
              }
              try {
                const result = await bridge.invoke('proxies.addMany', { entries: parsed.valid, label: '' });
                toast.ok(`Added ${format.plural(result.added ?? parsed.counts.valid, 'proxy', 'proxies')}`);
                await store.refreshProxies();
                await loadUsage();
                paint();
                dialog.close();
              } catch (err) {
                toast.fromError(err, 'Could not add those proxies');
                return false;
              }
              return true;
            }
          }
        ]
      });
    }

    function openEditDialog(proxy) {
      const hostField = field({ label: 'Host', control: h('input.input', { type: 'text', value: proxy.host }) });
      const portField = field({ label: 'Port', control: h('input.input', { type: 'number', value: String(proxy.port) }) });
      const protocolPicker = dropdown({
        options: PROTOCOLS.map((entry) => ({ value: entry, label: entry.toUpperCase() })),
        value: proxy.protocol,
        label: 'Protocol'
      });
      const protocolField = field({ label: 'Protocol', control: protocolPicker.el });
      const userField = field({ label: 'Username', control: h('input.input', { type: 'text', value: proxy.username ?? '', placeholder: 'optional' }) });
      const passwordField = field({
        label: 'Password',
        control: h('input.input', { type: 'password', value: '', placeholder: proxy.hasPassword ? 'unchanged' : 'optional' })
      });
      const labelField = field({ label: 'Label', control: h('input.input', { type: 'text', value: proxy.label ?? '', placeholder: 'e.g. residential-eu' }) });

      const enabledBox = h('input', { type: 'checkbox', checked: proxy.enabled });

      const dialog = modal({
        title: proxy.host,
        subtitle: `${proxy.protocol.toUpperCase()} · added ${format.ago(proxy.createdAt)}`,
        body: h('div', [
          h('div.grid.grid--2', [hostField.el, portField.el]),
          h('div.grid.grid--2', [protocolField.el, labelField.el]),
          h('div.grid.grid--2', [userField.el, passwordField.el]),
          h('div.switchfield', [
            h('div.switchfield__text', [h('b', 'Enabled'), h('span', 'Disabled proxies are skipped when handing them out.')]),
            h('label.toggle', [enabledBox, h('span')])
          ]),
          h('hr.divider'),
          h('dl.kv', [
            h('dt', 'In use'), h('dd', format.num(usage[proxy.id] ?? 0)),
            h('dt', 'Last check'), h('dd', proxy.lastCheckedAt ? format.ago(proxy.lastCheckedAt) : 'never'),
            h('dt', 'Result'), h('dd', proxy.lastOk === true ? format.latency(proxy.lastLatencyMs) : proxy.lastOk === false ? (proxy.lastError ?? 'unreachable') : '—')
          ])
        ]),
        actions: [
          {
            label: 'Check',
            onClick: async () => { await checkMany([proxy.id]); dialog.close(); }
          },
          { label: 'Cancel' },
          {
            label: 'Save',
            tone: 'primary',
            close: false,
            onClick: async () => {
              const patch = {
                host: hostField.control.value.trim(),
                port: Number(portField.control.value),
                protocol: protocolPicker.value,
                username: userField.control.value.trim(),
                label: labelField.control.value.trim(),
                enabled: enabledBox.checked
              };

              if (!patch.host) { hostField.setError('A host is required.'); return false; }
              if (!Number.isInteger(patch.port) || patch.port < 1 || patch.port > 65535) {
                portField.setError('A port between 1 and 65535.');
                return false;
              }
              // An untouched password field means "leave it alone", which is why
              // it is only sent when something was typed into it.
              if (passwordField.control.value) patch.password = passwordField.control.value;

              try {
                await bridge.invoke('proxies.update', { id: proxy.id, patch });
                toast.ok('Proxy saved');
                await store.refreshProxies();
                paint();
                dialog.close();
              } catch (err) {
                toast.fromError(err, 'Could not save that proxy');
                return false;
              }
              return true;
            }
          }
        ]
      });
    }

    // ------------------------------------------------------------ toolbar

    view.add(
      h('button.btn.btn--ghost', { type: 'button', onclick: () => copyPool() }, [icon('copy-01', { size: 15 }), 'Copy pool']),
      h('button.btn.btn--primary', { type: 'button', onclick: () => openAddDialog() }, [icon('plus', { size: 15 }), 'Add proxies'])
    );

    fill(toolbar, [
      h('div.row', { style: { gap: '10px', flexWrap: 'wrap' } }, [searchBox.el, bulkHost]),
      h('div', [chips])
    ]);
    hydrate(toolbar);

    view.mount(container);

    if (store.proxies().length) paint();
    else { fill(tableHost, skeletonRows(5)); paintChips(); paintBulk(); }

    // ------------------------------------------------------------ events

    subscriptions.add(store.subscribe(store.TOPICS.PROXIES, () => paint()));
    subscriptions.add(store.subscribe(store.TOPICS.BUSY, paintBusy));
    subscriptions.add(store.subscribe(store.TOPICS.STATS, () => { loadUsage().then(paint); }));

    loadUsage().then(paint);

    return {
      refresh() {
        store.refreshProxies();
        loadUsage().then(paint);
      },
      destroy: () => subscriptions.dispose()
    };
  }
};
