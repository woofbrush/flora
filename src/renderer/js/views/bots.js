/**
 * Bots.
 *
 * A master/detail screen: every running bot on the left with a live status, and
 * the console of whichever one is selected on the right. The console is the
 * reason this view exists - a bot that will not connect has a reason, and it is
 * always in the last twenty lines of its own output.
 *
 * `bots.describe` is the only polling call in the app, and it runs only while
 * this view is open and only for the selected bot. Everything else here arrives
 * through the event stream.
 */
import { h, fill, raf } from '../dom.js';
import { icon, hydrate } from '../icons.js';
import * as bridge from '../bridge.js';
import * as store from '../store.js';
import * as format from '../format.js';
import * as toast from '../components/toast.js';
import { headElement } from '../lib/heads.js';
import { emptyState } from '../components/table.js';
import { menu, dropdown } from '../components/overlay.js';
import { openBotCommands } from './helpDialog.js';
import { shell, bag } from './shell.js';
import { go, startAccounts, stopAccounts, stopEverything, restartBot } from '../actions.js';

/** How often the selected bot's position, health and player list are refreshed. */
const DESCRIBE_INTERVAL = 4000;

export default {
  mount(container) {
    const subscriptions = bag();
    const view = shell({ title: 'Bots', subtitle: 'Nothing connected.', flush: true });

    let selection = null;         // account id whose console is open
    let describeTimer = null;
    let describe = null;          // the last `bots.describe` payload
    let follow = true;            // stick the console to the newest line

    // Full-bleed by design: the list and the console each scroll on their own
    // and the divider between them runs the whole height. Only the horizontal
    // gutter belongs to the page, so it goes on the split rather than on either
    // pane - the divider then lands inside the content width instead of out at
    // the window edge. `--page-pad` for the same reason as the other views: it
    // is what the title above is inset by.
    const listHost = h('div', { style: { overflowY: 'auto', minHeight: '0', padding: '0 12px 12px 0' } });
    const panes = h('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'minmax(280px, 360px) 1fr',
        flex: '1 1 auto',
        minHeight: '0',
        padding: '0 var(--page-pad) 12px'
      }
    });

    const detailHost = h('div', {
      style: { display: 'flex', flexDirection: 'column', minWidth: '0', minHeight: '0', borderLeft: '1px solid var(--surface0)' }
    });

    panes.append(listHost, detailHost);

    /**
     * Quick mode: the two facts every start needs, on the page they are needed
     * on.
     *
     * Both fields are the settings the connect path already reads, not a second
     * copy of them - `bots.start` falls back to `bots.defaultServer` and
     * `bots.defaultVersion`, so editing here and editing in Settings are the
     * same edit.
     */
    const quickStrip = h('div', { style: { flex: 'none' } });

    view.body.append(quickStrip, panes);
    view.body.style.display = 'flex';
    view.body.style.flexDirection = 'column';
    view.body.style.minHeight = '0';

    // ------------------------------------------------------------ settings

    let versionOptions = null;

    /**
     * Write one setting and keep the local mirror honest about it.
     *
     * The backend returns everything it holds, so taking that wholesale is what
     * keeps a clamped number or a rejected value from lingering here as if it
     * had been saved.
     */
    async function saveSetting(key, value, { announce = null } = {}) {
      const previous = store.state.settings[key];
      store.state.settings[key] = value;

      try {
        const result = await bridge.invoke('app.settings.update', { [key]: value });
        if (result) store.state.settings = result;
        if (announce) toast.ok('Saved', `${announce}: ${value || '—'}`, { timeout: 1600 });
      } catch (err) {
        store.state.settings[key] = previous;
        toast.fromError(err, 'Could not save that setting');
      }

      paintQuick();
    }

    /** The versions flora can connect as, or just `auto` if that call fails. */
    async function versions() {
      if (versionOptions) return versionOptions;
      try {
        versionOptions = await bridge.invoke('bots.versions');
      } catch {
        // The dropdown still has to render; a version can be typed in Settings.
        versionOptions = [{ value: 'auto', label: 'Automatic (from the server)' }];
      }
      return versionOptions;
    }

    const paintQuick = raf(() => {
      if (!store.state.settings['bots.quickMode']) { fill(quickStrip, null); return; }

      const server = h('input.input', {
        type: 'text',
        value: store.state.settings['bots.defaultServer'] ?? '',
        placeholder: 'play.example.com',
        spellcheck: 'false',
        autocomplete: 'off',
        'aria-label': 'Default server',
        style: { width: '220px', fontFamily: 'var(--mono)', fontSize: 'var(--fs-sm)' }
      });

      // Same 400ms debounce as Settings: a hostname is typed, not chosen, and
      // writing on every keystroke would save six prefixes of the same address.
      debouncedSave(server, () => saveSetting('bots.defaultServer', server.value.trim()));

      const version = dropdown({
        options: versionOptions ?? [{ value: 'auto', label: 'Automatic (from the server)' }],
        value: store.state.settings['bots.defaultVersion'] ?? 'auto',
        label: 'Minecraft version',
        width: 190,
        onChange: (next) => saveSetting('bots.defaultVersion', next, { announce: 'Version' })
      });

      fill(quickStrip, h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          flexWrap: 'wrap',
          margin: '0 var(--page-pad) 10px',
          padding: '9px 12px',
          background: 'var(--mantle)',
          border: '1px solid var(--surface0)',
          borderRadius: 'var(--r-sm)'
        }
      }, [
        h('span', { style: { display: 'inline-flex', color: 'var(--accent)' } }, [icon('zap', { size: 15 })]),
        h('span', { style: { fontWeight: '500', fontSize: 'var(--fs-sm)' } }, 'Quick mode'),
        h('span.muted', { style: { fontSize: 'var(--fs-xs)' } }, 'Every bot starts here.'),
        h('div.grow'),
        h('span.muted', { style: { fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, 'Server'),
        server,
        h('span.muted', { style: { fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, 'Version'),
        version.el
      ]));

      hydrate(quickStrip);

      // The list arrives a moment after the first paint; repaint once it does so
      // the closed dropdown shows the version rather than a dash.
      if (!versionOptions) versions().then(() => paintQuick());
    });

    /** Commit a typed field once the typing stops, or as soon as it is left. */
    function debouncedSave(input, commit) {
      let timer = null;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(commit, 400);
      });
      input.addEventListener('blur', () => {
        clearTimeout(timer);
        commit();
      });
    }

    // ------------------------------------------------------------ actions

    // The switch for quick mode lives next to what it changes, not only in
    // Settings: it is a mode for this page, and a mode you have to leave the
    // page to turn off is a mode you stop using.
    const quickChip = h('button.chip', {
      type: 'button',
      title: 'Show just the server and version here',
      'aria-pressed': 'false',
      onclick: () => saveSetting('bots.quickMode', !store.state.settings['bots.quickMode'])
    }, [icon('zap', { size: 13 }), 'Quick mode']);
    hydrate(quickChip);

    view.add(
      quickChip,
      h('button.btn.btn--ghost', {
        type: 'button',
        onclick: (event) => openStartMenu(event.currentTarget)
      }, [icon('play', { size: 15 }), 'Start a bot']),
      h('button.btn.btn--ghost', {
        type: 'button',
        onclick: () => stopEverything()
      }, [icon('square', { size: 15 }), 'Stop all'])
    );

    function paintQuickChip() {
      quickChip.setAttribute('aria-pressed', store.state.settings['bots.quickMode'] ? 'true' : 'false');
      quickChip.title = store.state.settings['bots.quickMode']
        ? 'Hide the server and version fields'
        : 'Show just the server and version here';
    }


    function selectableAccounts() {
      return store.accounts();
    }

    function openStartMenu(anchor = null) {
      const accounts = selectableAccounts();
      if (!accounts.length) {
        toast.warn('No accounts to start', 'Import some accounts first.');
        go('accounts');
        return null;
      }

      const selected = store.selectedIds();
      const pool = selected.length ? accounts.filter((a) => selected.includes(a.id)) : accounts;
      const candidates = pool.slice(0, 40);
      const target = anchor ?? view.actions.querySelector('button');

      return menu(target, [
        { header: true, label: selected.length ? `${selected.length} selected` : 'Every account' },
        ...candidates.map((account) => ({
          icon: 'play',
          label: account.username || `Account ${account.id}`,
          disabled: store.botFor(account.id).status !== 'offline',
          onClick: () => startAccounts([account.id])
        })),
        ...(pool.length > candidates.length
          ? [{ icon: 'dots-grid', label: `…and ${pool.length - candidates.length} more`, onClick: () => startAccounts(pool.map((a) => a.id)) }]
          : []),
        { separator: true },
        { icon: 'rocket-02', label: `Start all ${format.num(pool.length)}`, onClick: () => startAccounts(pool.map((a) => a.id)) }
      ]);
    }

    // ------------------------------------------------------------ list

    const paintList = raf(() => {
      const live = store.accounts()
        .filter((a) => store.botFor(a.id).status !== 'offline')
        .sort((a, b) => (store.botFor(b.id).startedAt ?? 0) - (store.botFor(a.id).startedAt ?? 0));

      const running = store.state.stats?.runningBots ?? live.length;
      view.setSubtitle(running
        ? `${format.plural(running, 'bot')} connected or connecting.`
        : 'Nothing connected.');

      if (!live.length) {
        fill(listHost, emptyState({
          icon: 'rocket-02',
          title: 'No bots running',
          body: 'Start an account and its console will appear here.'
        }));
        hydrate(listHost);
        if (selection !== null) { selection = null; paintDetail(); }
        return;
      }

      if (selection === null || !live.some((a) => a.id === selection)) selection = live[0].id;

      fill(listHost, h('div', { style: { display: 'grid', gap: '6px' } }, live.map((account) => {
        const bot = store.botFor(account.id);
        const active = account.id === selection;

        return h('button', {
          type: 'button',
          class: 'menu__item',
          style: {
            height: 'auto',
            padding: '9px 10px',
            alignItems: 'center',
            background: active ? 'var(--accent-soft)' : null,
            color: active ? 'var(--text)' : null
          },
          onclick: () => { selection = account.id; paintList(); paintDetail(); }
        }, [
          headElement(account.skinHash, { name: account.username, size: 28 }),
          h('span.grow', { style: { minWidth: '0' } }, [
            h('b', { style: { display: 'block', fontWeight: '500' } }, account.username || `Account ${account.id}`),
            h('span.muted', {
              style: { display: 'block', fontSize: 'var(--fs-xs)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
            }, bot.error || format.server(bot.server) || 'connecting…')
          ]),
          h(`span.badge.badge--${format.statusTone(bot.status)}${bot.status === 'online' ? '.badge--live' : ''}`,
            format.statusLabel(bot.status))
        ]);
      })));
      hydrate(listHost);
    });

    // ------------------------------------------------------------ detail

    const consoleEl = h('div.console');
    const inputEl = h('input.input', {
      type: 'text',
      placeholder: 'Say something, or type a command…',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Send to the bot'
    });

    /**
     * Ask the backend for a bot's existing output.
     *
     * The store only accumulates lines that arrive while the app is running, so
     * a bot that connected before this view was opened would otherwise show an
     * empty console. Fetched once per bot, guarded by the set below.
     */
    const backfilled = new Set();

    function loadBacklog(id) {
      if (backfilled.has(id) || store.consoleFor(id).length) return;
      backfilled.add(id);
      bridge.invoke('bots.console', { id })
        .then((lines) => {
          if (!Array.isArray(lines) || !lines.length) return;
          // Merged rather than assigned: lines that arrived while this call was
          // in flight are already in the store and must not be dropped.
          const existing = store.consoleFor(id);
          if (!existing.length) store.state.consoles.set(Number(id), lines);
          paintConsole();
        })
        .catch(() => {});
    }

    // A console that does not stay pinned to the newest line is a console
    // nobody scrolls back down from.
    consoleEl.addEventListener('scroll', () => {
      const distance = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight;
      follow = distance < 40;
    });

    const infoRow = h('div');
    const playersRow = h('div');

    function selectedAccount() {
      return selection === null ? null : store.accountById(selection);
    }

    const paintConsole = raf(() => {
      const lines = selection === null ? [] : store.consoleFor(selection);

      if (!lines.length) {
        fill(consoleEl, h('div.console-line', [
          h('span.console-line__time', '--:--:--'),
          h('span.console-line__text', { style: { color: 'var(--overlay0)' } },
            selection === null ? 'Nothing selected.' : 'Waiting for the first line…')
        ]));
        return;
      }

      fill(consoleEl, lines.slice(-400).map((line) => h('div.console-line', {
        dataset: { kind: line.kind ?? 'system' }
      }, [
        h('span.console-line__time', format.clock(line.ts ?? Date.now())),
        h('span.console-line__text', line.text ?? '')
      ])));

      if (follow) consoleEl.scrollTop = consoleEl.scrollHeight;
    });

    function paintDetail() {
      const account = selectedAccount();

      if (!account) {
        fill(detailHost, emptyState({
          icon: 'terminal',
          title: 'No console open',
          body: 'Pick a running bot on the left, or start one.',
          action: h('button.btn.btn--primary', { type: 'button', onclick: () => openStartMenu() }, [
            icon('play', { size: 15 }), 'Start a bot'
          ])
        }));
        hydrate(detailHost);
        stopDescribe();
        return;
      }

      const bot = store.botFor(account.id);

      const header = h('header', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '12px 16px',
          borderBottom: '1px solid var(--surface0)',
          flex: 'none'
        }
      }, [
        headElement(account.skinHash, { name: account.username, size: 32 }),
        h('div.grow', { style: { minWidth: '0' } }, [
          h('b', { style: { display: 'block' } }, account.username || `Account ${account.id}`),
          h('span.muted', { style: { fontSize: 'var(--fs-xs)' } },
            [format.server(bot.server), bot.startedAt ? format.since(bot.startedAt) : null].filter(Boolean).join(' · ') || 'connecting…')
        ]),
        h(`span.badge.badge--${format.statusTone(bot.status)}${bot.status === 'online' ? '.badge--live' : ''}`, format.statusLabel(bot.status)),
        h('button.btn.btn--ghost.btn--icon.btn--sm', {
          type: 'button',
          'aria-label': 'Bot actions',
          onclick: (event) => menu(event.currentTarget, [
            { icon: 'refresh-cw-01', label: 'Reconnect', onClick: () => restartBot(account.id) },
            { icon: 'square', label: 'Disconnect', onClick: () => stopAccounts([account.id]) },
            { separator: true },
            { icon: 'copy-01', label: 'Copy the console', onClick: () => copyConsole(account.id) },
            { icon: 'x-close', label: 'Clear the console', onClick: () => clearConsole(account.id) }
          ])
        }, [icon('dots-vertical', { size: 15 })])
      ]);

      fill(detailHost, [
        header,
        infoRow,
        playersRow,
        consoleEl,
        h('div.console-input', [
          h('span.prefix', '›'),
          inputEl,
          h('button.btn.btn--ghost.btn--sm', {
            type: 'button',
            title: 'What can a bot be told to do?',
            onclick: () => openBotCommands()
          }, [icon('zap', { size: 13 }), 'Commands']),
          h('button.btn.btn--ghost.btn--sm', {
            type: 'button',
            onclick: () => send()
          }, ['Send'])
        ])
      ]);
      hydrate(detailHost);
      loadBacklog(account.id);
      paintConsole();
      paintInfo();
    }

    function paintInfo() {
      if (!describe || selection === null) { fill(infoRow, null); fill(playersRow, null); return; }
      const account = selectedAccount();
      if (!account) return;

      const facts = [
        ['Health', describe.health != null ? `${Math.round(describe.health)} ♥` : '—'],
        ['Position', describe.position
          ? `${describe.position.x}, ${describe.position.y}, ${describe.position.z}`
          : '—'],
        ['Players', describe.players ? format.num(describe.players.length) : '—'],
        ['Dimension', describe.game?.dimension ?? '—'],
        ['Proxy', describe.proxy ?? 'direct']
      ];

      fill(infoRow, h('div.row', {
        style: {
          gap: '18px',
          padding: '9px 16px',
          borderBottom: '1px solid var(--surface0)',
          flexWrap: 'wrap',
          flex: 'none'
        }
      }, facts.map(([label, value]) => h('div', { style: { display: 'flex', gap: '6px', alignItems: 'baseline' } }, [
        h('span.muted', { style: { fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '0.04em' } }, label),
        h('span.mono-sm', value)
      ]))));

      const players = describe.players ?? [];
      fill(playersRow, players.length
        ? h('div.row', {
            style: {
              gap: '6px',
              padding: '8px 16px',
              borderBottom: '1px solid var(--surface0)',
              flexWrap: 'wrap',
              maxHeight: '88px',
              overflowY: 'auto',
              flex: 'none'
            }
          }, players.slice(0, 60).map((player) => h('span.chip.chip--static', { title: player.uuid ?? '' }, [
            headElement(null, { size: 14 }),
            player.username
          ])))
        : null);
    }

    async function send() {
      const text = inputEl.value.trim();
      if (!text || selection === null) return;
      inputEl.value = '';

      const command = text.startsWith('/');
      try {
        await bridge.invoke(command ? 'bots.command' : 'bots.chat', {
          id: selection,
          [command ? 'command' : 'message']: command ? text.slice(1) : text
        });
      } catch (err) {
        toast.fromError(err, 'That message did not send');
      }
    }

    inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); send(); }
      // Up recalls nothing yet; the history menu is the deliberate way in.
      if (event.key === 'ArrowUp' && !inputEl.value) {
        event.preventDefault();
        bridge.invoke('history.list', { limit: 40 })
          .then((rows) => {
            if (!rows?.length) return;
            menu(inputEl, rows.map((row) => ({
              icon: row.kind === 'command' ? 'terminal' : 'message-text-square-01',
              label: format.truncateMiddle(row.text, 34, 10),
              onClick: () => { inputEl.value = row.text; inputEl.focus(); }
            })).slice(0, 20));
          })
          .catch(() => {});
      }
    });

    async function copyConsole(id) {
      const lines = store.consoleFor(id);
      if (!lines.length) { toast.warn('The console is empty'); return; }
      const text = lines.map((l) => `[${format.clock(l.ts ?? Date.now())}] ${l.text ?? ''}`).join('\n');
      await bridge.ui.copy(text);
      toast.ok(`Copied ${format.plural(lines.length, 'line')}`);
    }

    async function clearConsole(id) {
      try {
        await bridge.invoke('bots.clearConsole', { id });
        store.state.consoles.set(Number(id), []);
        paintConsole();
      } catch (err) {
        toast.fromError(err, 'Could not clear the console');
      }
    }

    // ------------------------------------------------------------ describe

    function startDescribe() {
      stopDescribe();
      if (selection === null) return;
      describeTimer = setInterval(refreshDescribe, DESCRIBE_INTERVAL);
      refreshDescribe();
    }

    function stopDescribe() {
      clearInterval(describeTimer);
      describeTimer = null;
      describe = null;
    }

    async function refreshDescribe() {
      if (selection === null) return;
      try {
        describe = await bridge.invoke('bots.describe', { id: selection });
        paintInfo();
      } catch {
        // A bot that ended between the interval firing and the call arriving is
        // normal; the event stream will update the list.
      }
    }

    // ------------------------------------------------------------ events

    subscriptions.add(store.subscribe(store.TOPICS.BOTS, (payload) => {
      paintList();
      if (payload?.console && payload.accountId === selection) paintConsole();
      if (payload?.accountId === selection && !payload.console) { paintDetail(); startDescribe(); }
    }));
    subscriptions.add(store.subscribe(store.TOPICS.ACCOUNTS, paintList));
    subscriptions.add(store.subscribe(store.TOPICS.STATS, paintList));
    subscriptions.add(store.subscribe(store.TOPICS.SETTINGS, () => {
      paintQuickChip();
      paintQuick();
    }));

    view.mount(container);
    paintList();
    paintDetail();
    paintQuickChip();
    paintQuick();
    if (selection !== null) startDescribe();

    return {
      refresh() {
        paintList();
        paintDetail();
        paintQuickChip();
        paintQuick();
        startDescribe();
      },
      destroy() {
        stopDescribe();
        subscriptions.dispose();
      }
    };
  }
};
