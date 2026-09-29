/**
 * Dashboard.
 *
 * The screen that answers "what is going on?" in one look: how many accounts
 * there are, how many are connected, and what is broken. Everything on it is
 * derived from state the store already holds, plus one `app.info` call for the
 * paths and versions - which are the only things no view can infer.
 */
import { h, fill, raf } from '../dom.js';
import { icon, hydrate } from '../icons.js';
import * as bridge from '../bridge.js';
import * as store from '../store.js';
import * as format from '../format.js';
import * as toast from '../components/toast.js';
import { headElement } from '../lib/heads.js';
import { emptyState } from '../components/table.js';
import { shell, statCard, bag } from './shell.js';
import {
  go, startAccounts, stopEverything, testAccounts, snapshotNow, fetchSkins
} from '../actions.js';
import { openImportDialog } from './importDialog.js';
import { openMicrosoftDialog } from './microsoftDialog.js';
import { openAddAccountDialog } from './accountDialog.js';

export default {
  mount(container) {
    const subscriptions = bag();
    const view = shell({ title: 'Dashboard', subtitle: 'Everything at a glance.' });

    const stats = h('div.grid.grid--4');
    const quick = h('div.card');
    const attention = h('div.card');
    const running = h('div.card');
    const system = h('div.card');

    view.body.append(
      stats,
      h('div.grid.grid--2', { style: { marginTop: '14px' } }, [running, attention]),
      h('div.grid.grid--2', { style: { marginTop: '14px' } }, [quick, system])
    );

    // ------------------------------------------------------------ stats

    const paintStats = raf(() => {
      const accounts = store.accounts();
      const s = store.state.stats;
      const online = store.onlineCount();
      const counts = s?.accounts ?? {};

      const total = counts.total ?? accounts.length;
      const selected = counts.selected ?? accounts.filter((a) => a.selected).length;
      const failing = counts.failed ?? accounts.filter((a) => a.lastTestOk === false).length;

      const proxies = s?.proxies ?? {};
      const skins = s?.skins ?? { files: 0, bytes: 0 };

      fill(stats, [
        statCard({
          icon: 'users-01',
          label: 'Accounts',
          value: format.num(total),
          meta: total
            ? `${format.num(selected)} selected · ${format.num(failing)} failing`
            : 'Nothing imported yet',
          tone: 'accent'
        }),
        statCard({
          icon: 'rocket-02',
          label: 'Bots online',
          value: format.num(online),
          meta: s?.runningBots != null && s.runningBots > online
            ? `${format.num(s.runningBots)} running in total`
            : online ? 'Connected right now' : 'All idle',
          tone: online ? 'ok' : null
        }),
        statCard({
          icon: 'globe-01',
          label: 'Proxies',
          value: format.num(proxies.total ?? 0),
          meta: proxies.total
            ? `${format.num(proxies.ok ?? 0)} working · ${format.num(proxies.failed ?? 0)} failing`
            : 'Direct connections only'
        }),
        statCard({
          icon: 'folder-download',
          label: 'Skins cached',
          value: format.num(skins.files ?? 0),
          meta: skins.files ? format.bytes(skins.bytes) : 'Nothing cached yet'
        })
      ]);
    });

    // ------------------------------------------------------------ running

    const paintRunning = raf(() => {
      const online = store.accounts().filter((a) => (store.botFor(a.id).status ?? 'offline') !== 'offline');
      online.sort((a, b) => (store.botFor(a.id).startedAt ?? 0) - (store.botFor(b.id).startedAt ?? 0));

      const header = h('header.card__header', [
        h('div.grow', [h('h3', 'Connected now'), h('p', `${format.plural(online.length, 'bot')} in game`)]),
        online.length
          ? h('button.btn.btn--ghost.btn--sm', { type: 'button', onclick: () => go('bots') }, [
              icon('chevron-right', { size: 13 }), 'Console'
            ])
          : null
      ]);

      if (!online.length) {
        fill(running, [
          header,
          emptyState({
            icon: 'rocket-02',
            title: 'No bots are connected',
            body: accounts_selected() ? 'Start the selected accounts to see them here.' : 'Import some accounts, then start them.',
            action: startButton()
          })
        ]);
        hydrate(running);
        return;
      }

      fill(running, [
        header,
        h('table.table', [
          h('tbody', online.slice(0, 8).map((account) => {
            const bot = store.botFor(account.id);
            return h('tr', [
              h('td', { style: { width: '44px' } }, [headElement(account.skinHash, { name: account.username, size: 26 })]),
              h('td', [
                h('div.account-cell__text', [
                  h('b', account.username || `Account ${account.id}`),
                  h('span', format.server(bot.server) || account.uuid || '—')
                ])
              ]),
              h('td.right', [
                h(`span.badge.badge--${format.statusTone(bot.status)}${bot.status === 'online' ? '.badge--live' : ''}`,
                  format.statusLabel(bot.status))
              ]),
              h('td.right.mono-sm.muted', bot.startedAt ? format.since(bot.startedAt) : '')
            ]);
          }))
        ])
      ]);
      hydrate(running);
    });

    // ------------------------------------------------------------ attention

    const paintAttention = raf(() => {
      const broken = store.accounts()
        .filter((a) => a.lastTestOk === false)
        .sort((a, b) => (b.lastTestedAt ?? 0) - (a.lastTestedAt ?? 0));

      fill(attention, [
        h('header.card__header', [
          h('div.grow', [
            h('h3', 'Needs attention'),
            h('p', broken.length ? 'Accounts that last failed a check.' : 'Nothing is failing.')
          ]),
          broken.length > 3
            ? h('button.btn.btn--ghost.btn--sm', { type: 'button', onclick: () => go('accounts') }, ['See all'])
            : null
        ]),
        broken.length
          ? h('table.table', [
              h('tbody', broken.slice(0, 4).map((account) => h('tr', [
                h('td', { style: { width: '44px' } }, [headElement(account.skinHash, { name: account.username, size: 26 })]),
                h('td', [
                  h('div.account-cell__text', [
                    h('b', account.username || `Account ${account.id}`),
                    h('span', format.truncateMiddle(account.lastTestError ?? 'Unknown reason', 30, 10))
                  ])
                ]),
                h('td.right', [
                  h('button.btn.btn--ghost.btn--sm', {
                    type: 'button',
                    onclick: (event) => {
                      event.stopPropagation();
                      testAccounts([account.id]);
                    }
                  }, ['Recheck'])
                ])
              ])))
            ])
          : emptyState({
              icon: 'folder-check',
              title: 'All clear',
              body: 'Every account that has been checked is still working.'
            })
      ]);
      hydrate(attention);
    });

    // ------------------------------------------------------------ quick actions

    function startButton() {
      const selected = store.selectedIds();
      if (!selected.length) {
        return h('button.btn.btn--primary', { type: 'button', onclick: () => go('accounts') }, [
          icon('users-01', { size: 15 }), 'Choose accounts'
        ]);
      }
      return h('button.btn.btn--primary', {
        type: 'button',
        onclick: () => startAccounts(selected)
      }, [icon('play', { size: 15 }), `Start ${format.plural(selected.length, 'account')}`]);
    }

    const quickActions = [
      { icon: 'file-plus-02', label: 'Import accounts', hint: 'From a .txt, .csv or JSON file', run: () => openImportDialog() },
      { icon: 'key-01', label: 'Sign in with Microsoft', hint: 'Device code - no password typed here', run: () => openMicrosoftDialog() },
      { icon: 'plus', label: 'Add by token', hint: 'Paste an access token', run: () => openAddAccountDialog() },
      { icon: 'rocket-02', label: 'Start the selection', hint: 'Connect every ticked account', run: () => startAccounts(store.selectedIds()) },
      { icon: 'square', label: 'Stop everything', hint: 'Disconnect every running bot', run: () => stopEverything() },
      { icon: 'clipboard-check', label: 'Check the selection', hint: 'Ask Mojang whether each token still works', run: () => testAccounts(store.selectedIds()) },
      { icon: 'download-cloud-02', label: 'Refresh skins', hint: 'Re-download heads for the selection', run: () => fetchSkins(store.selectedIds(), { force: true }) },
      { icon: 'database-01', label: 'Back up now', hint: 'Write a copy of the database', run: () => snapshotNow() }
    ];

    function paintQuick() {
      fill(quick, [
        h('header.card__header', [h('div.grow', [h('h3', 'Quick actions'), h('p', 'The things you do most often.')])]),
        h('div', { style: { padding: '6px' } }, quickActions.map((action) => h(
          'button.menu__item',
          { type: 'button', style: { height: 'auto', padding: '9px 10px' }, onclick: action.run },
          [
            icon(action.icon, { size: 18 }),
            h('span.grow', [
              h('b', { style: { display: 'block', fontWeight: '500' } }, action.label),
              h('span.muted', { style: { display: 'block', fontSize: 'var(--fs-xs)' } }, action.hint)
            ])
          ]
        )))
      ]);
      hydrate(quick);
    }

    // ------------------------------------------------------------ system

    function paintSystem(info) {
      if (!info) {
        fill(system, [
          h('header.card__header', [h('div.grow', [h('h3', 'This installation')])]),
          h('div.loading-block', [h('span.spinner'), 'Reading the backend…'])
        ]);
        return;
      }

      const db = info.db ?? {};
      const s = store.state.stats ?? {};

      fill(system, [
        h('header.card__header', [
          h('div.grow', [h('h3', 'This installation'), h('p', 'Where flora keeps everything.')])
        ]),
        h('div.card__body', [
          h('dl.kv', [
            h('dt', 'Version'), h('dd', info.version),
            h('dt', 'Data folder'), h('dd', info.dataRoot),
            h('dt', 'Database'), h('dd', db.file ?? info.dbFile ?? '—'),
            h('dt', 'Accounts'), h('dd', format.num(s.accounts?.total ?? 0)),
            h('dt', 'Log rows'), h('dd', format.num(s.logs ?? 0)),
            h('dt', 'Runtime'), h('dd', `Electron ${info.electron ?? '—'} · Node ${info.node}`)
          ]),
          h('div.row', { style: { marginTop: '16px', gap: '8px' } }, [
            h('button.btn.btn--outline.btn--sm', {
              type: 'button',
              onclick: () => bridge.ui.revealPath(info.dataRoot).catch((err) => toast.fromError(err, 'Could not open that folder'))
            }, [icon('folder', { size: 14 }), 'Show data folder']),
            h('button.btn.btn--ghost.btn--sm', {
              type: 'button',
              onclick: async () => {
                await bridge.ui.copy(info.dataRoot);
                toast.ok('Path copied', null, { timeout: 1600 });
              }
            }, [icon('copy-01', { size: 14 }), 'Copy path'])
          ])
        ])
      ]);
    }

    // ------------------------------------------------------------ events

    const repaint = () => { paintStats(); paintRunning(); paintAttention(); };

    subscriptions.add(store.subscribe(store.TOPICS.ACCOUNTS, repaint));
    subscriptions.add(store.subscribe(store.TOPICS.BOTS, repaint));
    subscriptions.add(store.subscribe(store.TOPICS.PROXIES, paintStats));
    subscriptions.add(store.subscribe(store.TOPICS.STATS, () => { paintStats(); paintRunning(); }));

    function accounts_selected() {
      return store.selectedIds().length > 0;
    }

    view.mount(container);

    paintStats();
    paintRunning();
    paintAttention();
    paintQuick();
    paintSystem(null);
    hydrate(view.el);

    bridge.invoke('app.info')
      .then(paintSystem)
      .catch(() => paintSystem(null));
    store.refreshStats();

    return {
      refresh() {
        paintStats();
        paintRunning();
        paintAttention();
        store.refreshStats();
      },
      destroy: () => subscriptions.dispose()
    };
  }
};
