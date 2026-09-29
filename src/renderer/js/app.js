/**
 * Application shell.
 *
 * Owns the window chrome, the sidebar, the router and the command palette. A
 * view is a plain object with `mount(container, context)`; it returns an object
 * with `destroy()` and optionally `refresh()`. Nothing else is required of one,
 * which keeps a view from needing to know anything about the shell beyond the
 * node it is handed.
 *
 * Routing is a string, not a URL. There is no address bar to keep in step with
 * and nothing here should be linkable from outside the app.
 */
import { h, fill, $, $$, toggle, raf } from './dom.js';
import { icon, hydrate } from './icons.js';
import { headElement } from './lib/heads.js';
import * as bridge from './bridge.js';
import * as store from './store.js';
import * as toast from './components/toast.js';
import { closeTop } from './components/overlay.js';
import { createStage } from './stage.js';
import * as format from './format.js';
import { LINKS } from './links.js';
import {
  startAccounts, stopEverything, testAccounts, snapshotNow, exportAccounts,
  selectAll, selectNone, invertSelection
} from './actions.js';

import dashboard from './views/dashboard.js';
import accounts from './views/accounts.js';
import bots from './views/bots.js';
import proxies from './views/proxies.js';
import activity from './views/activity.js';
import settings from './views/settings.js';

import { openImportDialog } from './views/importDialog.js';
import { openMicrosoftDialog } from './views/microsoftDialog.js';
import { openAddAccountDialog } from './views/accountDialog.js';
import { openAboutDialog } from './views/aboutDialog.js';
import { openImportHelp, openBotCommands } from './views/helpDialog.js';
import { openSkinPicker } from './views/skinDialog.js';
import { openNamePicker } from './views/nameDialog.js';
import { createOnboarding } from './views/onboarding.js';

const VIEWS = { dashboard, accounts, bots, proxies, activity, settings };

/**
 * The navbar links.
 *
 * A flat list, not the grouped sidebar this started as: the reference puts its
 * primary navigation across the top of the window, where it costs one row
 * instead of a whole column and leaves the full width to the data. `settings`
 * is absent because it has its own icon on the right, which is where the
 * reference keeps it.
 */
const NAV = [
  { id: 'dashboard', label: 'Home' },
  { id: 'accounts', label: 'Accounts', badge: 'accounts' },
  { id: 'bots', label: 'Bots', badge: 'bots' },
  { id: 'proxies', label: 'Proxies', badge: 'proxies' },
  { id: 'activity', label: 'Activity' }
];

/** The one route that shows the backdrop as its own background. */
const ART_FULL = 'dashboard';

const els = {};
let current = null;
let currentId = null;
let stage = null;
/** The first-run flow, while it is on screen. */
let setup = null;

// ---------------------------------------------------------------- routing

export function navigate(id, params = null) {
  if (!VIEWS[id] || id === currentId) {
    // Re-navigating to the current view is a request to refresh it, which is
    // what clicking the active nav link should do.
    if (id === currentId && current?.refresh) current.refresh();
    return;
  }

  current?.destroy?.();
  currentId = id;
  current = VIEWS[id].mount(els.content, { navigate, params });

  // Which view is on screen, as an attribute on the container.
  //
  // The mounted view root carries no identifying class of its own - every view
  // is a `.view` - so without this the only way to reach one page's chrome from
  // CSS is to guess at its markup. Themes and the icon rules use it.
  els.content.dataset.view = id;

  for (const item of $$('.navitem', els.nav)) {
    if (item.dataset.view === id) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }

  // The backdrop comes forward on the dashboard and recedes everywhere else,
  // which is the one place the two page types differ structurally.
  els.app.dataset.art = id === ART_FULL ? 'full' : 'veiled';

  // A fresh view is a fresh scroll container, so the bar must unfrost even
  // though the old one was scrolled.
  els.app.dataset.scrolled = 'false';

  hydrate(els.content);
  const scroller = els.content.querySelector('.view__body');
  if (scroller) scroller.scrollTop = 0;
}

export const view = () => currentId;

// ---------------------------------------------------------------- navbar

function buildNav() {
  fill(els.nav, NAV.map((item) => h('button.navitem', {
    type: 'button',
    dataset: { view: item.id, badge: item.badge ?? '' },
    onclick: () => navigate(item.id)
  }, [
    h('span', item.label),
    item.badge ? h('span.navitem__badge', { hidden: true }) : null
  ])));
}

/**
 * Update the counts on the navbar links.
 *
 * Written as a targeted patch rather than a rebuild: re-creating the nav on
 * every account event would take the focus off whatever the user was clicking.
 */
const updateBadges = raf(() => {
  const accounts = store.accounts();
  const online = store.onlineCount();
  const proxies = store.proxies();

  const values = {
    accounts: { text: accounts.length ? format.num(accounts.length) : null, tone: null },
    bots: { text: online ? `${online}` : (store.state.botsRunning ? format.num(store.state.botsRunning) : null), tone: online ? 'ok' : null },
    proxies: {
      text: proxies.length ? format.num(proxies.length) : null,
      tone: proxies.some((p) => p.lastOk === false) ? 'danger' : null
    }
  };

  for (const [name, value] of Object.entries(values)) {
    const badge = els.nav.querySelector(`.navitem[data-badge="${name}"] .navitem__badge`);
    if (!badge) continue;
    badge.textContent = value.text ?? '';
    toggle(badge, Boolean(value.text));
    if (value.tone) badge.dataset.tone = value.tone;
    else delete badge.dataset.tone;
  }
});

// ---------------------------------------------------------------- identity

/**
 * The connection chip.
 *
 * Three states, carried by the dot's colour and by the tooltip. The label is
 * screen-reader-only text rather than a visible caption: the navbar has room
 * for a signal, not a sentence, and a coloured dot with a tooltip says the same
 * thing in a quarter of the width.
 */
const STATE_LABEL = { ok: 'Connected', busy: 'Starting…', bad: 'Disconnected' };

/**
 * Whose face goes in the chip.
 *
 * The first whitelisted player, because the whitelist is the one list in flora
 * that names a person rather than an account: it is who is allowed to command
 * the bots, which makes it the closest thing this app has to an owner. With
 * nobody on the list the chip falls back to flora's own mark, so a fresh
 * install still has a face there rather than an empty square.
 *
 * `resolved` is what the element currently shows. Rebuilding the head on every
 * repaint would restart the image fetch each time the backend reports in, and
 * a head that flickers between updates is worse than no head at all.
 */
// `undefined`, not `null`. No whitelisted player resolves to `null`, so
// starting from `null` would make the very first paint look like a repaint of
// the same thing and the chip would sit empty until a name was ever added.
let resolvedMark;

function paintIdentityMark() {
  const players = store.setting('whitelist.players', []);
  const name = Array.isArray(players) && typeof players[0] === 'string' ? players[0] : null;
  if (name === resolvedMark) return;
  resolvedMark = name;

  // `.illus` is what tells the icon system this is a drawn picture rather than
  // line art, and it has to come off when a head goes in.
  els.identityMark.className = name ? 'statuschip__mark' : 'statuschip__mark illus';
  fill(els.identityMark, name
    ? headElement(null, { name, size: 30 })
    : icon('flora-mark', { size: 30, art: true }));
  // `icon()` returns a detached span and only fills it once something hydrates
  // it, which every view does for its own subtree after rendering. This is not
  // inside a view, so it has to ask. Without this the chip goes blank the first
  // time a whitelisted player is removed, and stays blank until the next route
  // change happens to sweep it up.
  hydrate(els.identityMark);
}

function paintIdentity(payload) {
  const ready = payload?.ready ?? bridge.isReady();
  const online = store.onlineCount();

  const state = ready ? 'ok' : 'busy';
  const detail = !ready
    ? 'Starting the backend…'
    : online
      ? `Ready — ${online} ${online === 1 ? 'bot' : 'bots'} online`
      : 'Ready';

  paintIdentityMark();
  els.identity.dataset.state = state;
  els.identity.title = `flora — ${STATE_LABEL[state]}\n${detail}`;
  els.identitySub.textContent = detail;
  els.app.dataset.busy = ready ? 'false' : 'true';
}

// ---------------------------------------------------------------- stage

/**
 * Frost the navbar once the view underneath it starts to scroll, and clear it
 * again at the top.
 *
 * The scroll listener is on `#content` in the capture phase: a scroll event
 * does not bubble, so a listener on an ancestor only sees a descendant's
 * scroll if it is capturing. That is what lets this survive every view
 * replacing its own scroller without re-binding anything.
 */
function installScrollState() {
  let scrolled = false;
  const onScroll = raf(() => {
    const next = (els.content.querySelector('.view__body')?.scrollTop ?? 0) > 8;
    if (next === scrolled) return;
    scrolled = next;
    els.app.dataset.scrolled = next ? 'true' : 'false';
  });
  els.content.addEventListener('scroll', onScroll, true);
}

/**
 * Keep the canvas in step with the backdrop settings.
 *
 * `setEnabled` is about motion, not visibility: with the backdrop turned off the
 * element is hidden by CSS and this is left off too, so nothing is painted into
 * a canvas nobody can see. Reduced motion settles the art to the centre instead
 * of removing it, which is what someone asking for less movement usually wants.
 */
function syncStage() {
  if (!stage) return;
  stage.setEnabled(
    store.setting('appearance.background', 'aurora') !== 'none' &&
    !store.setting('appearance.reduceMotion', false)
  );
}

// ---------------------------------------------------------------- palette

/**
 * The command palette.
 *
 * A flat, fuzzy-matched list of everything the app can do: the views, the
 * actions that would otherwise be buried in a menu, and the accounts
 * themselves - because with several hundred accounts, "connect that one" is the
 * action people actually want from a search box.
 */
function openPalette(seed = '') {
  const commands = [
    { id: 'view:dashboard', label: 'Go to Dashboard', icon: 'layout-top', run: () => navigate('dashboard') },
    { id: 'view:accounts', label: 'Go to Accounts', icon: 'users-01', run: () => navigate('accounts') },
    { id: 'view:bots', label: 'Go to Bots', icon: 'rocket-02', run: () => navigate('bots') },
    { id: 'view:proxies', label: 'Go to Proxies', icon: 'globe-01', run: () => navigate('proxies') },
    { id: 'view:activity', label: 'Go to Activity', icon: 'terminal', run: () => navigate('activity') },
    { id: 'view:settings', label: 'Go to Settings', icon: 'settings-01', run: () => navigate('settings') },
    { id: 'act:import', label: 'Import accounts from a file', icon: 'file-plus-02', hint: 'Ctrl I', run: () => openImportDialog() },
    { id: 'act:microsoft', label: 'Sign in with Microsoft', icon: 'key-01', run: () => openMicrosoftDialog() },
    { id: 'act:addToken', label: 'Add an account by token', icon: 'plus', run: () => openAddAccountDialog() },
    { id: 'act:skin', label: 'Change skins…', icon: 'paint-pour', run: () => openSkinPicker() },
    { id: 'act:rename', label: 'Change a username…', icon: 'pencil-01', run: () => openNamePicker() },
    { id: 'act:startAll', label: 'Start every selected account', icon: 'play', run: () => startSelected() },
    { id: 'act:stopAll', label: 'Stop every running bot', icon: 'square', run: () => stopAll() },
    { id: 'act:test', label: 'Check every selected account', icon: 'clipboard-check', run: () => testSelected() },
    { id: 'act:snapshot', label: 'Back up the database now', icon: 'database-01', run: () => snapshot() },
    { id: 'act:botCommands', label: 'What can the bots be told to do?', icon: 'zap', run: () => openBotCommands() },
    { id: 'act:importHelp', label: 'Which account formats are supported?', icon: 'help-circle', run: () => openImportHelp() },
    { id: 'act:about', label: 'About flora', icon: 'info-circle', run: () => openAboutDialog() },
    { id: 'link:site', label: 'Open woofbrush.com', icon: 'link-external-01', run: () => bridge.ui.openExternal(LINKS.website) },
    { id: 'link:discord', label: 'Join the Discord', icon: 'discord', run: () => bridge.ui.openExternal(LINKS.discord) }
  ];

  const panel = h('div.palette');
  const input = h('input.palette__input', {
    type: 'text',
    value: seed,
    placeholder: 'Search views, actions and accounts…',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Command palette'
  });
  const list = h('div.palette__list', { role: 'listbox' });

  const scrim = h('div.scrim.scrim--top', { onmousedown: (e) => { if (e.target === scrim) close(); } }, [
    h('div.palette__panel', [input, list])
  ]);

  let results = [];
  let cursor = 0;

  function score(text, query) {
    // Subsequence match with a bonus for word starts. Enough to make "sta all"
    // find "Start every selected account" without a fuzzy-match dependency.
    const haystack = text.toLowerCase();
    const needle = query.toLowerCase();
    if (!needle) return 1;

    let index = 0;
    let points = 0;
    let streak = 0;

    for (const char of needle) {
      const found = haystack.indexOf(char, index);
      if (found === -1) return 0;
      streak = found === index ? streak + 1 : 0;
      points += 1 + streak * 2 + (found === 0 || haystack[found - 1] === ' ' ? 4 : 0);
      index = found + 1;
    }
    return points / (haystack.length + 8);
  }

  function compute() {
    const query = input.value.trim();
    const base = [...commands];

    for (const account of store.accounts()) {
      base.push({
        id: `acct:${account.id}`,
        label: account.username || `Account ${account.id}`,
        sub: format.kindLabel(account.kind),
        icon: 'users-01',
        account,
        run: () => navigate('accounts')
      });
    }

    for (const proxy of store.proxies()) {
      base.push({
        id: `proxy:${proxy.id}`,
        label: `${proxy.host}:${proxy.port}`,
        sub: proxy.protocol,
        icon: 'globe-01',
        run: () => navigate('proxies')
      });
    }

    if (!query) {
      results = base.slice(0, 9);
    } else {
      results = base
        .map((command) => ({ command, points: score(`${command.label} ${command.sub ?? ''}`, query) }))
        .filter((entry) => entry.points > 0)
        .sort((a, b) => b.points - a.points)
        .slice(0, 12)
        .map((entry) => entry.command);
    }

    cursor = 0;
    paint();
  }

  function paint() {
    fill(list, results.length
      ? results.map((command, index) => h(
          `button.palette__item${index === cursor ? '.is-active' : ''}`,
          {
            type: 'button',
            role: 'option',
            'aria-selected': index === cursor ? 'true' : 'false',
            onclick: () => choose(command)
          },
          [
            icon(command.icon, { size: 15 }),
            h('span.grow', command.label),
            command.sub ? h('span.muted', command.sub) : null,
            command.hint ? h('kbd', command.hint) : null
          ]
        ))
      : [h('div.palette__empty', 'Nothing matches that.')]);
  }

  function move(delta) {
    if (!results.length) return;
    cursor = (cursor + delta + results.length) % results.length;
    paint();
    list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }

  function choose(command) {
    close();
    // After the palette is gone, so a dialog it opens is not fighting it for
    // focus.
    setTimeout(() => command.run?.(), 0);
  }

  input.addEventListener('input', compute);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); if (results[cursor]) choose(results[cursor]); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
  });

  $('#overlays').appendChild(scrim);
  compute();
  input.focus();
  input.select();

  function close() {
    scrim.remove();
    document.removeEventListener('keydown', onKey, true);
  }

  function onKey(event) {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  }
  document.addEventListener('keydown', onKey, true);
}

// ---------------------------------------------------------------- actions

/**
 * Run a bulk action against the current selection.
 *
 * Every bulk control in the app goes through here, so "nothing is selected" is
 * explained once rather than by five slightly different warnings.
 */
async function withSelection(title, fn) {
  const ids = store.selectedIds();
  if (!ids.length) {
    toast.warn('Nothing selected', 'Tick the accounts you want to act on first.');
    return null;
  }
  try {
    return await fn(ids);
  } catch (err) {
    if (err?.name !== 'AbortError') toast.fromError(err, title);
    return null;
  }
}

const startSelected = () => withSelection('Could not start those accounts', (ids) => startAccounts(ids));
const testSelected = () => withSelection('Could not check those accounts', (ids) => testAccounts(ids));

export { startSelected, testSelected, stopEverything as stopAll, snapshotNow as snapshot };

// ---------------------------------------------------------------- actions

/**
 * The actions the native menu asks for.
 *
 * Kept here rather than in each view so the accelerator, the palette entry and
 * the menu item all reach the same code.
 */
const MENU_ACTIONS = {
  import: () => openImportDialog(),
  export: async () => {
    // Exporting what is selected is the common case; with nothing selected the
    // backend exports everything, which is what the label promises.
    await exportAccounts({ ids: store.selectedIds() });
  },
  palette: () => openPalette(),
  search: () => navigate('accounts'),
  snapshot: () => snapshotNow(),
  about: () => openAboutDialog(),
  'import-help': () => openImportHelp(),
  'bot-commands': () => openBotCommands(),
  skins: () => openSkinPicker(),
  'select-all': selectAll,
  'select-none': selectNone,
  'select-invert': invertSelection
};

// ---------------------------------------------------------------- shortcuts

function installShortcuts() {
  document.addEventListener('keydown', (event) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;

    // Ctrl+K is the palette, always - including from inside a field, because
    // that is exactly where someone is likely to want it.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openPalette();
      return;
    }

    if (event.key === 'Escape' && !inField) {
      if (closeTop()) event.preventDefault();
      return;
    }

    if (inField) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      openAddAccountDialog();
    }
  });
}

// ---------------------------------------------------------------- chrome

function installChrome() {
  $('#win-min').addEventListener('click', () => bridge.ui.window.minimise());
  $('#win-max').addEventListener('click', async () => {
    const { maximised } = await bridge.ui.window.toggleMaximise();
    // The restore glyph is a design choice the main process cannot make for us.
    setMaxGlyph(maximised);
  });
  $('#win-close').addEventListener('click', () => bridge.ui.window.close());
  $('#omni').addEventListener('click', () => openPalette());
  $('#nav-discord').addEventListener('click', () => bridge.ui.openExternal(LINKS.discord));
  $('#nav-settings').addEventListener('click', () => navigate('settings'));
  $('#brand').addEventListener('click', (event) => {
    event.preventDefault();
    navigate('dashboard');
  });

  // Double-clicking the bar maximises, which is what every Windows app does
  // and is missed immediately when it is absent. Anything in the bar that is
  // its own control is left alone.
  els.navbar.addEventListener('dblclick', (event) => {
    if (event.target.closest('button, a, input, kbd')) return;
    bridge.ui.window.toggleMaximise();
  });

  els.identity.addEventListener('click', () => navigate('settings'));
}

/** Swap the maximise/restore glyph, in place. */
function setMaxGlyph(maximised) {
  const button = $('#win-max');
  if (!button) return;
  button.replaceChildren(icon(maximised ? 'copy-01' : 'square', { size: 13 }));
  hydrate(button);
}

// ---------------------------------------------------------------- boot

export async function start() {
  els.app = $('#app');
  els.nav = $('#nav');
  els.navbar = $('#navbar');
  els.content = $('#content');
  els.identity = $('#identity');
  els.identityMark = $('#identity-mark');
  els.identitySub = $('#identity-sub');

  // The icons written into index.html itself, which no view owns.
  hydrate(document);

  buildNav();
  installChrome();
  installShortcuts();
  installScrollState();

  stage = createStage($('#stage'));
  stage.mount();

  store.connect();

  store.subscribe(store.TOPICS.ACCOUNTS, () => { updateBadges(); paintIdentity(); });
  store.subscribe(store.TOPICS.BOTS, () => { updateBadges(); paintIdentity(); });
  store.subscribe(store.TOPICS.PROXIES, updateBadges);
  store.subscribe(store.TOPICS.READY, () => { paintIdentity({ ready: true }); });
  store.subscribe(store.TOPICS.NAVIGATE, (id) => id && navigate(id));
  store.subscribe(store.TOPICS.ACTION, (action) => MENU_ACTIONS[action]?.());
  // The chip's face is the first whitelisted player, so a change to the
  // whitelist is a change to the navbar.
  store.subscribe(store.TOPICS.SETTINGS, () => { syncStage(); paintIdentityMark(); });

  bridge.on('backend:state', (payload) => paintIdentity(payload));

  // The renderer's exceptions should be visible in the Activity view rather
  // than only in a devtools console nobody has open.
  window.addEventListener('error', (event) => {
    console.error('[flora] renderer error', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[flora] unhandled rejection', event.reason);
  });

  // The backdrop starts hidden and is revealed once the first frame is
  // painted, so the app never opens on a flash of empty canvas.
  requestAnimationFrame(() => { els.app.dataset.ready = 'true'; });

  navigate('dashboard');
  syncStage();

  // Everything after the first screen has painted.
  await store.loadAll();
  paintIdentity({ ready: bridge.isReady() });
  syncStage();

  // The window is revealed only now, so the user never sees the unstyled shell.
  bridge.ready();

  // Setup runs over the top of a fully working app rather than instead of one,
  // so finishing it is a reveal, not a reload.
  if (!store.setting('general.seenOnboarding', false)) openSetup();

  bridge.on('window:state', ({ maximised }) => {
    if (typeof maximised === 'boolean') setMaxGlyph(maximised);
  });
}

/**
 * Show the first-run flow, or replay it from Settings.
 *
 * It is inserted after `#app` rather than into `#content`, because it owns the
 * whole window - navbar, title bar and all - and the shell underneath it must
 * stay intact for the moment it is dismissed.
 */
export function openSetup() {
  if (setup) return;

  setup = createOnboarding({
    onDone: () => {
      // `destroy` before the node goes: the flow owns a canvas with a running
      // animation loop and three window listeners, none of which stop just
      // because the element is detached.
      setup?.destroy();
      setup?.el.remove();
      setup = null;
      // The steps write settings as they go; this is what makes the rest of the
      // app agree with them.
      store.applyAppearance();
      syncStage();
      store.refreshSettings().catch(() => {});
      paintIdentity({ ready: bridge.isReady() });
      toast.ok('You are all set', 'flora is ready. Press Ctrl+K for the command palette.');
    }
  });

  document.body.appendChild(setup.el);
  setup.start();
}

export { openPalette, openImportDialog, openMicrosoftDialog, openAddAccountDialog, openAboutDialog, openImportHelp, openBotCommands, openSkinPicker, openNamePicker };

start().catch((err) => {
  console.error('[flora] failed to start the UI', err);
  document.body.appendChild(h('div.empty', { style: { padding: '40px' } }, [
    h('h3', 'flora could not start its interface'),
    h('p.muted', err?.message ?? String(err))
  ]));
});
