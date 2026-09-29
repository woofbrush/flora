/**
 * Activity.
 *
 * Two logs behind one tab strip. The first is the application log - everything
 * flora did, at every level - and it is the place a "why did that fail?"
 * question gets answered. The second is the command history, which is what the
 * bots actually sent and when.
 *
 * The tail is live. Rows arrive on `app:log` and are appended rather than
 * re-queried, which is the difference between a log that keeps up with a busy
 * pool and one that stalls it. Pausing freezes the list without stopping the
 * backend, so a line can be read while a hundred more go past.
 */
import { h, fill, raf, debounce } from '../dom.js';
import { icon, hydrate } from '../icons.js';
import * as bridge from '../bridge.js';
import * as store from '../store.js';
import * as format from '../format.js';
import * as toast from '../components/toast.js';
import { emptyState, skeletonRows } from '../components/table.js';
import { menu, modal, dropdown, confirm as confirmDialog } from '../components/overlay.js';
import { shell, bag, searchField } from './shell.js';

const LEVELS = ['debug', 'info', 'warn', 'error'];

/** The colour each level is written in, in the log table and in its badge. */
const LEVEL_COLOUR = { debug: 'overlay0', info: 'info', warn: 'warn', error: 'red' };

/** Tail length on open. The live stream appends past this as it runs. */
const TAIL_LIMIT = 600;

export default {
  mount(container) {
    const subscriptions = bag();
    const view = shell({ title: 'Activity', subtitle: 'Loading…', flush: true });

    let tab = 'log';
    let level = null;              // null = every level
    let scope = null;
    let query = '';
    let paused = false;
    let follow = true;
    /**
     * Rows that arrived while paused.
     *
     * They are held rather than dropped so resuming continues the list where it
     * left off, instead of silently losing everything that happened in between.
     */
    const held = [];

    let history = [];

    // The gutter is `--page-pad` rather than a number so the tab strip, the
    // filter bar and the list all line up with the page title above them; the
    // tab strip has no bottom padding of its own because the tab underline sits
    // on its lower edge.
    const tabsEl = h('div.tabs', { style: { padding: '0 var(--page-pad)' } });
    const filterBar = h('div.toolbar', { style: { padding: '4px var(--page-pad) 14px', margin: '0' } });
    const listHost = h('div', { style: { padding: '0 var(--page-pad) 40px' } });

    view.body.append(tabsEl, filterBar, listHost);

    // ------------------------------------------------------------ normalising

    /**
     * One row shape for both sources.
     *
     * Rows read from the table use snake_case columns and a JSON meta string;
     * rows pushed on the event bus use camelCase and an already-parsed object.
     * Everything downstream sees the same fields either way.
     */
    function normalise(row) {
      let meta = row.meta ?? null;
      if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { /* leave it as the raw string */ }
      }

      return {
        id: row.id ?? null,
        ts: Number(row.ts ?? Date.now()),
        level: String(row.level ?? 'info'),
        scope: String(row.scope ?? 'app'),
        message: String(row.message ?? ''),
        meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null,
        rawMeta: typeof meta === 'string' ? meta : null,
        accountId: row.accountId ?? row.account_id ?? null
      };
    }

    let rows = [];

    const visible = () => rows.filter((row) => {
      if (level && row.level !== level) return false;
      if (scope && row.scope !== scope) return false;
      if (query) {
        const needle = query.toLowerCase();
        if (!`${row.scope} ${row.message}`.toLowerCase().includes(needle)) return false;
      }
      return true;
    });

    const scopes = () => [...new Set(rows.map((row) => row.scope))].sort();

    // ------------------------------------------------------------ log list

    const listEl = h('div.log-list', {
      style: {
        display: 'grid',
        gap: '1px',
        fontFamily: 'var(--mono)',
        fontSize: 'var(--fs-sm)',
        background: 'var(--surface0)',
        border: '1px solid var(--surface0)',
        borderRadius: 'var(--r-md)',
        overflow: 'hidden'
      }
    });

    listEl.addEventListener('scroll', () => {
      follow = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
      paintFollow();
    });

    const followButton = h('button.btn.btn--ghost.btn--sm', { type: 'button', onclick: () => jumpToEnd() });

    function paintFollow() {
      fill(followButton, follow || paused
        ? [icon('arrow-right', { size: 13 }), paused ? 'Paused' : 'Following']
        : [icon('arrow-right', { size: 13 }), 'Jump to newest']);
    }

    function jumpToEnd() {
      follow = true;
      listEl.scrollTop = listEl.scrollHeight;
      paintFollow();
    }

    const paintLog = raf(() => {
      const shown = visible();

      view.setSubtitle(rows.length
        ? `${format.plural(shown.length, 'row')} shown · ${format.plural(rows.length, 'row')} loaded.`
        : 'Nothing logged yet.');

      if (!rows.length) {
        fill(listHost, emptyState({
          icon: 'terminal',
          title: 'Nothing logged yet',
          body: 'Everything flora does lands here: connections, imports, checks and failures.'
        }));
        hydrate(listHost);
        return;
      }

      if (!shown.length) {
        fill(listHost, emptyState({
          icon: 'search-md',
          title: 'No rows match those filters',
          action: h('button.btn', { type: 'button', onclick: clearFilters }, 'Clear filters')
        }));
        hydrate(listHost);
        return;
      }

      fill(listEl, shown.slice(-1500).map((row) => h('div.log-row', {
        style: {
          display: 'grid',
          gridTemplateColumns: '72px 62px minmax(90px, 130px) 1fr',
          gap: '10px',
          padding: '5px 10px',
          background: 'var(--mantle)',
          alignItems: 'baseline'
        },
        title: format.stamp(row.ts)
      }, [
        h('span.muted', format.clock(row.ts)),
        h(`span.log-level.log-level--${row.level}`, {
          style: {
            color: `var(--${LEVEL_COLOUR[row.level] ?? 'overlay1'})`,
            fontSize: 'var(--fs-xs)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em'
          }
        }, row.level),
        h('span', { style: { color: 'var(--overlay1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.scope),
        h('span', { style: { color: row.level === 'error' ? 'var(--red)' : row.level === 'warn' ? 'var(--warn)' : 'var(--subtext1)', wordBreak: 'break-word' } }, [
          row.message,
          row.meta ? h('span.muted', { style: { marginLeft: '8px', color: 'var(--overlay0)' } }, compactMeta(row.meta)) : null
        ])
      ])));

      fill(listHost, h('div', [
        listEl,
        h('div.row', {
          style: { justifyContent: 'space-between', marginTop: '10px', gap: '10px' }
        }, [
          h('span.muted', { style: { fontSize: 'var(--fs-xs)' } },
            paused ? `${format.plural(held.length, 'new row')} held back while paused.` : 'New rows appear as they happen.'),
          followButton
        ])
      ]));

      hydrate(listHost);
      if (follow) listEl.scrollTop = listEl.scrollHeight;
      paintFollow();
    });

    /** "key=value key=value", truncated - the shape a log line wants. */
    function compactMeta(meta) {
      const text = Object.entries(meta)
        .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
        .join(' ');
      return text.length > 120 ? `${text.slice(0, 120)}…` : text;
    }

    // ------------------------------------------------------------ history

    const paintHistory = raf(() => {
      if (!history.length) {
        fill(listHost, emptyState({
          icon: 'clock-rewind',
          title: 'No commands yet',
          body: 'Every message a bot sends or command it runs is recorded here.'
        }));
        hydrate(listHost);
        return;
      }

      fill(listHost, h('table.table', [
        h('thead', [h('tr', [
          h('th', { style: { width: '92px' } }, 'When'),
          h('th', { style: { width: '160px' } }, 'Account'),
          h('th', null, 'Text')
        ])]),
        h('tbody', history.map((row) => {
          const account = store.accountById(row.account_id);
          return h('tr', [
            h('td.mono-sm.muted', { title: format.stamp(row.ts) }, format.clock(row.ts)),
            h('td', account
              ? h('span', account.username || `Account ${account.id}`)
              : h('span.muted', row.account_id ? `Account ${row.account_id}` : 'deleted')),
            h('td', { style: { fontFamily: 'var(--mono)', fontSize: 'var(--fs-sm)', wordBreak: 'break-word' } }, row.text)
          ]);
        }))
      ]));

      hydrate(listHost);
    });

    async function loadHistory() {
      try {
        history = await bridge.invoke('history.list', { limit: 300 });
      } catch (err) {
        history = [];
        toast.fromError(err, 'Could not read the command history');
      }
      // `paint()`, not `paintHistory()`. Both loads start together on mount and
      // both draw into the same host, so painting this one directly means the
      // slower of the two always wins: the command history's empty state used to
      // land on top of a full application log, on the log tab, every time.
      paintTabs();
      paintFilters();
      paint();
    }

    // ------------------------------------------------------------ chrome

    function paintTabs() {
      fill(tabsEl, [
        ['log', 'Application log', rows.length],
        ['history', 'Command history', history.length]
      ].map(([id, text, count]) => h('button.tab', {
        type: 'button',
        role: 'tab',
        'aria-selected': tab === id ? 'true' : 'false',
        onclick: () => { tab = id; paintTabs(); paintFilters(); paint(); }
      }, [text, h('span.tab__count', format.num(count))])));
      hydrate(tabsEl);
    }

    const searchBox = searchField({
      placeholder: 'Search the log…',
      label: 'Search the activity log',
      width: 260,
      onInput: debounce((value) => { query = value.trim(); paint(); }, 160)
    });

    const levelChips = h('div.row', { style: { gap: '6px' } });
    const scopeSelect = dropdown({
      options: [],
      value: '',
      label: 'Filter by scope',
      onChange: (next) => { scope = next || null; paint(); }
    });
    const actions = h('div.row', { style: { marginLeft: 'auto', gap: '8px' } });

    function clearFilters() {
      level = null;
      scope = null;
      query = '';
      searchBox.reset();
      paintFilters();
      paint();
    }

    function paintFilters() {
      if (tab !== 'log') { fill(filterBar, null); return; }

      const counts = {};
      for (const entry of LEVELS) counts[entry] = rows.filter((row) => row.level === entry).length;

      fill(levelChips, [
        h('button.chip', {
          type: 'button',
          'aria-pressed': level === null ? 'true' : 'false',
          onclick: () => { level = null; paintFilters(); paint(); }
        }, ['All levels', h('span.chip__count', format.num(rows.length))]),
        ...LEVELS.map((entry) => h('button.chip', {
          type: 'button',
          'aria-pressed': level === entry ? 'true' : 'false',
          onclick: () => { level = level === entry ? null : entry; paintFilters(); paint(); }
        }, [entry, h('span.chip__count', format.num(counts[entry] ?? 0))]))
      ]);

      scopeSelect.setOptions([
        { value: '', label: 'Every scope' },
        ...scopes().map((entry) => ({ value: entry, label: entry }))
      ], scope ?? '');

      fill(actions, [
        h('button.btn.btn--ghost.btn--sm', {
          type: 'button',
          onclick: () => togglePause()
        }, [icon(paused ? 'play' : 'minus', { size: 13 }), paused ? `Resume${held.length ? ` (${held.length})` : ''}` : 'Pause']),
        h('button.btn.btn--ghost.btn--sm', { type: 'button', onclick: () => openActions() }, [
          icon('dots-vertical', { size: 14 })
        ])
      ]);

      hydrate(filterBar);
    }

    function openActions() {
      const items = tab === 'log' ? [
        { header: true, label: 'Log' },
        { icon: 'download-01', label: 'Export what is shown…', onClick: () => exportLog() },
        { icon: 'copy-01', label: 'Copy what is shown', onClick: () => copyLog() },
        { separator: true },
        { icon: 'refresh-cw-01', label: 'Reload from the database', onClick: () => loadLog() },
        { icon: 'clock-rewind', label: 'Delete rows older than…', onClick: () => pruneDialog() },
        { separator: true },
        { icon: 'trash-01', label: 'Clear the whole log', danger: true, onClick: () => clearLog() }
      ] : [
        { header: true, label: 'History' },
        { icon: 'copy-01', label: 'Copy everything', onClick: () => copyHistory() },
        { icon: 'refresh-cw-01', label: 'Reload', onClick: () => loadHistory() },
        { separator: true },
        { icon: 'trash-01', label: 'Clear the history', danger: true, onClick: () => clearHistory() }
      ];

      // The overflow button is the last thing in the row, and it is the anchor.
      const anchor = actions.lastElementChild;
      if (anchor) menu(anchor, items, { align: 'end' });
    }

    // ------------------------------------------------------------ actions

    /** Freeze the tail, or let it run again and catch up in one go. */
    function togglePause() {
      paused = !paused;

      if (!paused && held.length) {
        rows.push(...held.splice(0, held.length));
        if (rows.length > 2000) rows.splice(0, rows.length - 2000);
      }

      paintFollow();
      paint();
      paintFilters();
    }

    async function exportLog() {
      const shown = visible();
      if (!shown.length) { toast.warn('There is nothing to export'); return; }

      const text = shown.map((row) =>
        `${new Date(row.ts).toISOString()} ${row.level.toUpperCase().padEnd(5)} [${row.scope}] ${row.message}` +
        (row.meta ? ` ${JSON.stringify(row.meta)}` : '')
      ).join('\n');

      try {
        const saved = await bridge.ui.saveText({
          title: 'Export activity',
          defaultName: `flora-activity-${new Date().toISOString().slice(0, 10)}.log`,
          contents: text
        });
        if (saved?.cancelled) return;
        toast.ok('Exported', `${format.plural(shown.length, 'row')} written to ${format.truncateMiddle(saved.path, 22, 14)}`);
      } catch (err) {
        toast.fromError(err, 'Could not export the log');
      }
    }

    async function copyLog() {
      const shown = visible();
      if (!shown.length) { toast.warn('There is nothing to copy'); return; }
      const text = shown.map((row) => `[${format.clock(row.ts)}] ${row.level.toUpperCase()} ${row.scope}: ${row.message}`).join('\n');
      await bridge.ui.copy(text);
      toast.ok(`Copied ${format.plural(shown.length, 'row')}`);
    }

    function pruneDialog() {
      const input = h('input.input', { type: 'number', value: '14', min: '1', max: '365' });

      const dialog = modal({
        title: 'Delete old rows',
        subtitle: 'Only the application log is affected. The files on disk are left alone.',
        size: 'slim',
        body: h('div', [
          h('label.field__label', 'Delete rows older than this many days'),
          input
        ]),
        actions: [
          { label: 'Cancel' },
          {
            label: 'Delete',
            tone: 'danger',
            close: false,
            onClick: async () => {
              const days = Number(input.value);
              if (!Number.isInteger(days) || days < 1) return false;
              try {
                const result = await bridge.invoke('app.logs.prune', { days });
                toast.ok(`Deleted ${format.plural(result.removed ?? 0, 'row')}`);
                dialog.close();
                await loadLog();
              } catch (err) {
                toast.fromError(err, 'Could not prune the log');
                return false;
              }
              return true;
            }
          }
        ]
      });
    }

    async function clearLog() {
      const confirmed = await confirmDialog({
        title: 'Clear the application log?',
        message: 'Every row in the database is deleted. The log files on disk are left alone.',
        detail: 'This cannot be undone.',
        confirmLabel: 'Clear',
        danger: true
      });
      if (!confirmed) return;

      try {
        const result = await bridge.invoke('app.logs.clear');
        rows = [];
        store.state.logs = [];
        toast.ok(`Deleted ${format.plural(result.removed ?? 0, 'row')}`);
        paint();
      } catch (err) {
        toast.fromError(err, 'Could not clear the log');
      }
    }

    async function clearHistory() {
      const confirmed = await confirmDialog({
        title: 'Clear the command history?',
        message: 'The record of what each bot sent is deleted.',
        confirmLabel: 'Clear',
        danger: true
      });
      if (!confirmed) return;

      try {
        await bridge.invoke('history.clear');
        history = [];
        paintTabs();
        paint();
        toast.ok('History cleared');
      } catch (err) {
        toast.fromError(err, 'Could not clear the history');
      }
    }

    // ------------------------------------------------------------ loading

    async function loadLog() {
      try {
        rows = (await bridge.invoke('app.logs.tail', { limit: TAIL_LIMIT })).map(normalise);
        // The store keeps its own copy for anything else that wants it; keeping
        // the two in step here means a filter change never shows stale rows.
        store.state.logs = rows.slice();
      } catch (err) {
        toast.fromError(err, 'Could not read the log');
      }
      paintTabs();
      paintFilters();
      paint();
    }

    function paint() {
      if (tab === 'log') paintLog();
      else paintHistory();
    }

    // ------------------------------------------------------------ toolbar

    view.add(
      h('button.btn.btn--ghost', {
        type: 'button',
        onclick: () => (tab === 'log' ? exportLog() : copyHistory())
      }, [icon('download-01', { size: 15 }), 'Export'])
    );

    async function copyHistory() {
      if (!history.length) { toast.warn('There is nothing to copy'); return; }
      const text = history.map((row) => {
        const account = store.accountById(row.account_id);
        return `[${new Date(row.ts).toISOString()}] ${account?.username ?? row.account_id ?? '-'}: ${row.text}`;
      }).join('\n');
      await bridge.ui.copy(text);
      toast.ok(`Copied ${format.plural(history.length, 'line')}`);
    }

    fill(filterBar, [
      h('div.row', { style: { gap: '10px', flexWrap: 'wrap' } }, [searchBox.el, scopeSelect.el, actions]),
      h('div', [levelChips])
    ]);

    view.mount(container);
    fill(listHost, skeletonRows(8, 26));
    paintFollow();

    // ------------------------------------------------------------ events

    subscriptions.add(store.subscribe(store.TOPICS.LOGS, (payload) => {
      // Only rows that arrived after the initial load are appended; the tail
      // call already returned everything up to this point.
      if (!payload?.ts) return;
      if (paused) {
        held.push(normalise(payload));
        if (held.length > 2000) held.shift();
        paintFilters();
        return;
      }
      if (tab !== 'log') return;

      rows.push(normalise(payload));
      if (rows.length > 2000) rows.splice(0, rows.length - 2000);
      paintLog();
      paintFilters();
    }));

    loadLog();
    loadHistory();

    return {
      refresh() {
        if (tab === 'log') loadLog();
        else loadHistory();
      },
      destroy: () => subscriptions.dispose()
    };
  }
};
