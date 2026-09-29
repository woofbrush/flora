/**
 * First-run setup.
 *
 * A full-window flow that stands in front of the app shell the first time flora
 * is opened, and can be replayed from Settings. Seven short steps, none of them
 * mandatory, arranged so that the user leaves with a working app and knows how
 * to drive it rather than with a checklist.
 *
 * The layout is the reference client's onboarding, which is worth copying
 * closely because it solves the hard part well: a hairline progress bar across
 * the top, an 80px header carrying the mark and the window controls, a body
 * split into an illustration half and a content half, and a footer with the
 * buttons pinned right. Steps slide in from the direction of travel over 320ms,
 * which is what makes going forward feel different from going back.
 *
 * The order is deliberate. Appearance first, because it changes what everything
 * after it looks like; accounts second, because they are the reason the app
 * exists; who may command the bots third, because that is the one decision here
 * with a security consequence and it reads best while the accounts are still on
 * screen. Then the two guide steps, which are the only part of this flow that
 * does not write anything: having just made an account and decided who may use
 * it, the next question is what to actually do, and it is asked here for the
 * last time while the answer is still two clicks away. The summary is last, so
 * the flow ends on a sentence rather than a form.
 */
import { h, fill, nextFrame } from '../dom.js';
import { icon, hydrate, mark } from '../icons.js';
import * as bridge from '../bridge.js';
import * as store from '../store.js';
import * as format from '../format.js';
import * as toast from '../components/toast.js';
import { createStage } from '../stage.js';
import { LINKS } from '../links.js';

/** Accent swatches offered in the appearance step, in the order shown. */
const ACCENTS = [
  { id: 'mauve', label: 'Violet', color: '#ba60ff' },
  { id: 'pink', label: 'Pink', color: '#f472b6' },
  { id: 'blue', label: 'Blue', color: '#61afef' },
  { id: 'teal', label: 'Teal', color: '#56b6c2' },
  { id: 'green', label: 'Green', color: '#3ecf8e' },
  { id: 'yellow', label: 'Amber', color: '#e5c07b' },
  { id: 'peach', label: 'Peach', color: '#d19a66' },
  { id: 'red', label: 'Red', color: '#ff6b6b' }
];

const accentLabel = (id) => ACCENTS.find((a) => a.id === id)?.label ?? 'Custom';

/** How far a step slides while it fades in. Matches the reference. */
const SLIDE = 44;

/** Beyond this a file is refused rather than read into memory. Mirrors the
 *  limit in the import dialog, so both routes behave the same way. */
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * Build the flow.
 *
 * `onDone` is called once, when the user finishes or skips. The flow edits the
 * live document as it goes - the appearance step is meant to be judged by eye,
 * not from a description - and writes the settings on the way out of each step,
 * so the database never holds a value the user was only trying.
 */
export function createOnboarding({ onDone = null } = {}) {
  const draft = {
    theme: store.setting('appearance.theme', 'dark'),
    accent: store.setting('appearance.accent', 'mauve'),
    motion: !store.setting('appearance.reduceMotion', false),
    backdrop: store.setting('appearance.background', 'aurora') !== 'none',
    ownerName: store.setting('general.ownerName', ''),
    // Whichever names are on the list when the step is left are the ones saved;
    // it starts as whatever is already there, so replaying setup edits the list
    // rather than clearing it.
    allowed: [...(store.setting('whitelist.players', []) ?? [])],
    allow: store.setting('whitelist.enabled', false)
  };

  let step = 0;
  let direction = 1;
  let added = 0;

  const STEPS = [
    { id: 'welcome', art: 'onboarding-welcome', build: welcomeStep },
    { id: 'look', art: 'onboarding-preferences', build: lookStep },
    { id: 'accounts', art: 'onboarding-account', build: accountsStep },
    { id: 'control', art: 'onboarding-control', build: controlStep },
    { id: 'run', art: 'onboarding-run', build: runStep },
    { id: 'talk', art: 'onboarding-talk', build: talkStep },
    { id: 'done', art: 'onboarding-complete', build: doneStep }
  ];

  const bar = h('div.ob__bar-fill');
  const slot = h('div.ob__slot');
  const footer = h('div.ob__footer');
  const stage = h('div.ob__stage');

  // Setup gets its own copy of the animated backdrop rather than showing a flat
  // page over the app's. The canvas in `#app` is hidden underneath this overlay
  // and its veil covers everything below the navbar, so without a second one the
  // first thing a new user ever sees is the only screen in flora that is
  // completely still.
  const canvas = h('canvas.ob__canvas');
  const backdrop = createStage(canvas);

  // The header is its own drag region, and its controls are wired here rather
  // than through the app shell's `#win-min` lookups: the shell is still mounted
  // underneath this, and reusing those ids would put two of each in the
  // document.
  const head = h('header.ob__head.drag', [
    h('div.ob__brand', [
      mark(30, 'ob__mark'),
      h('b', 'flora')
    ]),
    h('div.spacer'),
    h('div.wincontrols.no-drag', [
      winButton('minus', 'Minimise', () => bridge.ui.window.minimise()),
      winButton('maximize-01', 'Maximise', () => bridge.ui.window.toggleMaximise()),
      winButton('x-close', 'Close', () => bridge.ui.window.close())
    ])
  ]);

  head.addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    bridge.ui.window.toggleMaximise();
  });

  const el = h('div.ob', [
    h('div.ob__bg', { 'aria-hidden': 'true' }, [
      canvas,
      h('div.ob__veil')
    ]),
    h('div.ob__fore', [
      h('div.ob__bar', { role: 'progressbar', 'aria-label': 'Setup progress' }, [bar]),
      head,
      stage,
      footer,
      h('div.ob__copyright', [
        'Design © 2026 ',
        h('a', {
          href: '#',
          onclick: (event) => {
            event.preventDefault();
            bridge.ui.openExternal(LINKS.website);
          }
        }, 'Woofbrush Design LLC'),
        '. All rights reserved.'
      ])
    ])
  ]);

  // ------------------------------------------------------------ frames

  /**
   * Render the current step.
   *
   * The whole page frame is rebuilt and animated, not just the text column: in
   * the reference both halves slide together, and animating only the content
   * leaves the illustration sitting still while everything around it moves,
   * which reads as a glitch. `slot` is a long-lived node that gets moved into
   * the new frame, so a step's own controls are always built fresh.
   *
   * The animation is a class rather than an inline style, and it is added on the
   * next frame rather than at build time. Both matter: a CSS animation only
   * starts on a style change against a rendered element, so applying it to a
   * detached node and then inserting it is a coin flip. The class is what makes
   * the browser see a change; the frame is what makes the element already be
   * on screen when it does.
   *
   * `nextFrame` and not `raf`: `raf` in dom.js coalesces a burst of calls into
   * one and hands back the wrapper to call later. Passing it a callback and
   * discarding the result does nothing at all, which is what kept every step of
   * this flow from ever animating in.
   */
  function render() {
    const spec = STEPS[step];

    bar.style.width = `${((step + 1) / STEPS.length) * 100}%`;

    slot.replaceChildren(spec.build());

    const page = h('div.ob__page', [
      h('div.ob__art', { 'aria-hidden': 'true' }, [icon(spec.art, { art: true })]),
      slot
    ]);

    page.style.setProperty('--ob-from', `${direction * SLIDE}px`);
    if (!draft.motion) page.classList.add('is-still');

    stage.replaceChildren(page);
    renderFooter();
    hydrate(el);

    if (draft.motion) nextFrame().then(() => page.classList.add('ob__page--in'));
  }

  /** Keep both backdrops in step with the appearance settings. */
  function syncBackdrop() {
    backdrop.setEnabled(draft.backdrop && draft.motion);
    el.classList.toggle('is-still', !draft.motion);
  }

  function renderFooter() {
    const last = step === STEPS.length - 1;

    fill(footer, [
      step > 0
        ? h('button.btn', { type: 'button', onclick: () => go(-1) }, 'Back')
        : null,
      h('div.spacer'),
      last
        ? null
        : h('button.ob__skip', { type: 'button', onclick: () => finish() }, 'Skip setup'),
      last
        ? h('button.btn.btn--primary.ob__next', { type: 'button', onclick: () => finish() },
            ['Finish', icon('arrow-right', { size: 16 })])
        : h('button.btn.btn--primary.ob__next', { type: 'button', onclick: () => go(1) },
            ['Next', icon('arrow-right', { size: 16 })])
    ]);
    hydrate(footer);
  }

  function go(delta) {
    const next = step + delta;
    if (next < 0 || next >= STEPS.length) return;
    commit(STEPS[step].id);
    direction = delta;
    step = next;
    render();
  }

  function finish() {
    commit(STEPS[step].id);
    write({ 'general.seenOnboarding': true });
    onDone?.();
  }

  /** Persist whatever the step that is being left owns. */
  function commit(id) {
    if (id === 'welcome') {
      write({ 'general.ownerName': draft.ownerName.trim() });
    } else if (id === 'look') {
      write(appearancePatch());
    } else if (id === 'control') {
      write({
        'whitelist.players': draft.allowed,
        'whitelist.enabled': draft.allow && draft.allowed.length > 0
      });
    }
  }

  function appearancePatch() {
    return {
      'appearance.theme': draft.theme,
      'appearance.accent': draft.accent,
      'appearance.reduceMotion': !draft.motion,
      'appearance.background': draft.backdrop ? 'aurora' : 'none'
    };
  }

  /**
   * Apply a settings patch.
   *
   * The store is updated first so the UI reacts on the same frame; the IPC
   * round trip that makes it durable follows. A failure to persist is worth a
   * toast but not worth blocking on - the mirror in localStorage means the
   * choice survives to the next launch either way.
   */
  function write(patch) {
    Object.assign(store.state.settings, patch);
    store.applyAppearance();

    bridge.invoke('app.settings.update', patch).catch((err) => {
      console.error('[flora] could not save a setup setting', err);
    });
  }

  // ------------------------------------------------------------ steps

  function heading(title, lead) {
    return h('div.ob__heading', [h('h1', title), lead ? h('p', lead) : null]);
  }

  function welcomeStep() {
    const name = h('input', {
      type: 'text',
      value: draft.ownerName,
      placeholder: 'Your name',
      spellcheck: 'false',
      autocomplete: 'off',
      maxlength: '40',
      oninput: () => { draft.ownerName = name.value; },
      onkeydown: (event) => { if (event.key === 'Enter') go(1); }
    });

    return h('div', [
      heading('Welcome to flora', 'A desktop panel for running Minecraft bots.'),
      h('p.ob__lead', 'Set-up takes about a minute. It chooses how flora looks, signs in your first account, and decides who is allowed to command your bots. Every step can be skipped.'),
      h('div.ob__form', [
        h('label.field__label', { for: 'ob-name' }, 'What should flora call you?'),
        name,
        h('p.field__hint', 'Optional. Used to sign exports and to greet you on the dashboard.')
      ])
    ]);
  }

  function lookStep() {
    const swatches = h('div.ob__swatches', ACCENTS.map((accent) => h(
      `button.ob__swatch${accent.id === draft.accent ? '.is-active' : ''}`,
      {
        type: 'button',
        title: accent.label,
        'aria-label': accent.label,
        dataset: { accent: accent.id },
        onclick: (event) => {
          draft.accent = accent.id;
          for (const node of swatches.children) {
            node.classList.toggle('is-active', node === event.currentTarget);
          }
          preview();
        }
      },
      h('span', { style: { background: accent.color } })
    )));

    const theme = segmented(
      [{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }],
      () => draft.theme,
      (id) => { draft.theme = id; preview(); }
    );

    const motion = toggle(draft.motion, (on) => { draft.motion = on; preview(); });
    const backdrop = toggle(draft.backdrop, (on) => { draft.backdrop = on; preview(); });

    /**
     * Show the choice immediately.
     *
     * Written straight to the live document rather than to a preview swatch:
     * the accent is a decision about the whole window, and the only honest way
     * to offer it is to apply it and let the user look.
     */
    function preview() {
      Object.assign(store.state.settings, appearancePatch());
      store.applyAppearance();
      syncBackdrop();
    }

    return h('div', [
      heading('Make it yours', 'These apply as you click. Nothing here is permanent.'),
      h('div.ob__rows', [
        row('colors', 'Accent', 'The colour flora uses for highlights and controls.', swatches),
        row('settings-04', 'Theme', 'Dark is the default. Light is easier in a bright room.', theme.el),
        row('play', 'Animations', 'Off removes every transition in the app.', motion),
        row('dots-grid', 'Animated backdrop', 'The drifting gradient behind the app.', backdrop)
      ]),
      h('p.ob__lead', 'All four live in Settings, alongside text size and corner rounding.')
    ]);
  }

  function accountsStep() {
    const list = h('div.ob__accounts');

    const paint = () => {
      list.classList.toggle('is-empty', added === 0);
      fill(list, added
        ? [h('p.ob__note.ob__note--ok', [
            icon('check-circle', { size: 15 }),
            h('span', `${added} ${added === 1 ? 'account' : 'accounts'} ready. Sign in to more whenever you like from the Accounts page.`)
          ])]
        : [h('p.ob__note', 'Nothing added yet. You can do all of this later from the Accounts page.')]);
      hydrate(list);
    };

    const signIn = h('button.btn', {
      type: 'button',
      onclick: async () => {
        const { openMicrosoftDialog } = await import('./microsoftDialog.js');
        openMicrosoftDialog();
        // The dialog is modal and non-blocking here, so the count is refreshed
        // when it closes rather than awaited.
        watchAccounts();
      }
    }, [icon('key-01', { size: 16 }), 'Sign in with Microsoft']);

    const importFile = h('button.btn', {
      type: 'button',
      onclick: chooseFile
    }, [icon('file-plus-02', { size: 16 }), 'Import a .txt file']);

    const byToken = h('button.btn', {
      type: 'button',
      onclick: async () => {
        const { openAddAccountDialog } = await import('./accountDialog.js');
        openAddAccountDialog();
        watchAccounts();
      }
    }, [icon('plus', { size: 16 }), 'Add by token']);

    async function chooseFile() {
      let picked;
      try {
        picked = await bridge.ui.openAccountsFile();
      } catch (err) {
        toast.fromError(err, 'Could not open that file');
        return;
      }
      if (!picked || picked.cancelled) return;
      if (picked.text && picked.text.length > MAX_BYTES) {
        toast.warn('That file is too large', 'Try splitting it into smaller lists.');
        return;
      }
      await importText(picked.text, picked.name);
    }

    /**
     * Import through the same two-phase path the Accounts page uses.
     *
     * `import.prepare` parses and de-duplicates without writing anything, so a
     * file that turns out to hold nothing usable is reported rather than
     * silently doing nothing.
     */
    async function importText(text, name) {
      if (!String(text ?? '').trim()) {
        toast.warn('That file was empty', null);
        return;
      }

      try {
        const staged = await bridge.invoke('import.prepare', { text, filename: name ?? '' });
        if (!staged?.ok) {
          toast.error('That file could not be read', staged?.error ?? null);
          return;
        }
        if (!staged.counts.importable) {
          toast.warn('Nothing new to import', staged.counts.duplicates
            ? 'Every account in that file is already in flora.'
            : 'No line in that file could be read.');
          return;
        }

        const result = await bridge.invoke('import.confirm', {
          stageId: staged.stageId,
          label: 'Added during setup',
          verify: false
        });

        if (!result?.ok) {
          toast.error('The import did not run', result?.error ?? null);
          return;
        }

        added += result.added ?? 0;
        paint();
        await store.refreshAccounts({ immediate: true });
        toast.ok(`Imported ${result.added} ${result.added === 1 ? 'account' : 'accounts'}`);
      } catch (err) {
        toast.fromError(err, 'The import failed');
      }
    }

    /**
     * Poll the account count while a dialog is open.
     *
     * A modal that adds accounts has no completion event the setup flow can
     * await, and the number under the buttons is the only feedback this step
     * gives. A second of latency on a step nobody is timing beats threading a
     * callback through two dialogs that do not know about each other.
     */
    let watching = null;
    function watchAccounts() {
      if (watching) clearInterval(watching);
      const before = store.accounts().length;
      watching = setInterval(() => {
        const now = store.accounts().length;
        if (now === before) return;
        added += now - before;
        paint();
        clearInterval(watching);
        watching = null;
      }, 900);
    }

    paint();

    return h('div', [
      heading('Add your first account', 'flora runs bots on accounts you already own.'),
      h('p.ob__lead', 'Sign in with Microsoft for a real session, or bring a list you already have. Nothing is sent anywhere except to Microsoft and Mojang, and only to sign in.'),
      h('div.ob__actions', [signIn, importFile, byToken]),
      list
    ]);
  }

  /**
   * Who is allowed to drive the bots.
   *
   * The one step in the flow that is about a risk rather than a preference, so
   * it states the rule plainly and then lets the list be filled in on the spot.
   * It is written before the first bot exists, which is the only moment the
   * explanation is worth reading: once somebody is on a server typing at a bot,
   * the question "who can do that?" has already been answered by accident.
   *
   * The switch is described as what it is - a lock on the door - and the step
   * says out loud that it stays shut until a name is added, because a setting
   * that quietly opens when it looks untouched is the one thing here that could
   * cost somebody their accounts.
   */
  function controlStep() {
    const chips = h('div.ob__chips');

    const name = h('input', {
      type: 'text',
      placeholder: 'Minecraft username',
      spellcheck: 'false',
      autocomplete: 'off',
      maxlength: '16',
      'aria-label': 'Minecraft username to allow',
      onkeydown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        add();
      }
    });

    const addButton = h('button.btn', {
      type: 'button',
      onclick: () => add()
    }, [icon('plus', { size: 15 }), 'Add']);

    const allow = toggle(draft.allow, (on) => {
      // A lock with nobody behind it opens nothing, so it is refused here
      // rather than silently dropped when the step is saved.
      if (on && draft.allowed.length === 0) {
        allow.querySelector('input').checked = false;
        toast.warn('Add a username first', 'There is nobody on the list to let in yet.');
        return;
      }
      draft.allow = on;
      paint();
    });

    const note = h('p.ob__note');

    function paint() {
      fill(chips, draft.allowed.length
        ? draft.allowed.map((entry) => h('span.chip.chip--removable', [
          h('span', entry),
          h('button.chip__remove', {
            type: 'button',
            title: `Remove ${entry}`,
            'aria-label': `Remove ${entry}`,
            onclick: () => {
              draft.allowed = draft.allowed.filter((value) => value !== entry);
              paint();
            }
          }, [icon('x-close', { size: 11 })])
        ]))
        : [h('span.ob__chips-empty', 'Nobody yet')]);

      // A switch that is on with nothing behind it would be a switch that does
      // nothing, so it follows the list rather than the other way round.
      allow.classList.toggle('is-disabled', draft.allowed.length === 0);
      note.textContent = draft.allowed.length
        ? (draft.allow
            ? 'flora will obey these players, and whisper a refusal to anyone else who tries.'
            : 'Saved. This stays switched off until you turn it on, here or in Settings.')
        : 'Nobody can command your bots, which is how flora starts.';

      hydrate(chips);
    }

    function add() {
      const value = name.value.trim();
      if (!value) return;

      if (!format.isUsername(value)) {
        toast.warn('Not a Minecraft username', 'Usernames are 3 to 16 letters, numbers and underscores.');
        return;
      }
      if (draft.allowed.some((entry) => entry.toLowerCase() === value.toLowerCase())) {
        name.value = '';
        return;
      }

      draft.allowed = [...draft.allowed, value];
      // Adding a name is the whole intent of typing one, so the lock opens with
      // it. The step's own note says so, and the switch is right there to undo.
      if (draft.allowed.length === 1) draft.allow = true;
      allow.querySelector('input').checked = draft.allow;
      name.value = '';
      paint();
    }

    paint();

    return h('div', [
      heading('Who may command your bots', 'Bots listen to chat on the server they are on.'),
      h('p.ob__lead', 'Usernames you add here are the ones that can control your bots. Anyone else who tries is ignored and told they are not on the list.'),
      h('div.ob__form', [
        h('label.field__label', 'Allowed players'),
        h('div.ob__name-entry', [name, addButton]),
        chips,
        note
      ]),
      h('div.ob__rows', [
        row('shield-01', 'Let them command bots',
          'Off means every bot ignores chat entirely, whoever is speaking.', allow),
        row('message-text-square-01', 'Commands',
          `They type ${store.setting('bots.chatPrefix', '.')} first, so ordinary chat is never mistaken for an order.`, null)
      ])
    ]);
  }

  /**
   * How to put a bot in a game.
   *
   * The one step in the flow that is an instruction rather than a question, so
   * it is written as a numbered sequence and names the controls as they are
   * labelled on screen. Every claim in it is checked against the code that does
   * the thing: the version menu really does say Automatic (from the server),
   * the console box really does send a leading `/` as a server command, and
   * selection on the Accounts page really is what limits the start menu.
   */
  function runStep() {
    const version = store.setting('bots.defaultVersion', 'auto') === 'auto';

    return h('div', [
      heading('Start your first bot', 'Four things, and it is standing in the world.'),
      h('ol.ob__steps', [
        numbered(1, 'Open the Bots page',
          'Ctrl+3. The menu behind "Start a bot" lists every account flora knows about.'),
        numbered(2, 'Give it a server',
          'The address you would type in Minecraft, like play.example.net. The version ' +
          (version ? 'stays on Automatic, so flora asks the server what it speaks.' : 'is set by hand, under Settings > Bots.')),
        numbered(3, 'Choose the accounts',
          'One from that menu, or select rows on the Accounts page and start the whole selection together.'),
        numbered(4, 'Press Start',
          'Its console lands on the card: everything it says and hears, and every kick or error. ' +
          'The box beneath it chats as that bot - start a line with / to run a server command instead.')
      ])
    ]);
  }

  /**
   * What the bots answer to.
   *
   * The list is fetched from the backend, the same call the Help dialog makes,
   * rather than written out here. Commands change, addons add more of them, and
   * a guide that recites its own copy of the list is a guide that is wrong by
   * the time somebody reads it.
   */
  function talkStep() {
    const list = h('div.ob__cmds', h('p.ob__note', 'Loading…'));
    const prefix = store.setting('bots.chatPrefix', '.');
    const allowed = draft.allowed;
    const allow = draft.allow && allowed.length > 0;

    const who = allow
      ? `${format.nameList(allowed)} can command them`
      : 'nobody can command them';

    bridge.invoke('bots.commands').then((reference) => {
      const commands = reference?.commands ?? [];
      fill(list, commands.map((entry) => h('div.ob__cmd', [
        h('code', entry.usage),
        h('span', entry.summary),
        // `help` is answered inside flora rather than whispered into the game,
        // which is the one thing about this list anybody wonders about.
        entry.local ? h('span.chip.chip--static', 'in flora') : null,
        entry.addon ? h('span.chip.chip--static', entry.addon) : null
      ])));
    }).catch(() => {
      fill(list, h('p.ob__note', 'The command list could not be read. It is always in Help > What can the bots be told to do?'));
    });

    return h('div', [
      heading('Talking to your bots', 'In game, next to them, or from here.'),
      h('p.ob__lead', `Anyone you allow types "${prefix}" first, so ordinary talk is never an order. ` +
        `Right now ${who}. Addons add commands of their own, marked with the addon they came from.`),
      list
    ]);
  }

  function doneStep() {
    const name = draft.ownerName.trim();
    const accounts = store.accounts().length;
    const proxies = store.proxies().length;

    return h('div', [
      heading(name ? `You're set, ${name}.` : "You're set.", 'flora is ready to use.'),
      h('div.ob__summary', [
        summaryRow('users-01', `${accounts} ${accounts === 1 ? 'account' : 'accounts'}`,
          accounts ? 'Ready to sign in' : 'Add one whenever you like'),
        summaryRow('shield-01', format.nameList(draft.allowed),
          draft.allowed.length
            ? (draft.allow ? 'Can command your bots' : 'Saved, but not switched on')
            : 'Nobody can command your bots'),
        summaryRow('globe-01', `${proxies} ${proxies === 1 ? 'proxy' : 'proxies'}`,
          proxies ? 'Assigned round-robin' : 'Optional, for larger runs'),
        summaryRow('colors', accentLabel(draft.accent),
          `${draft.theme === 'dark' ? 'Dark' : 'Light'} theme, ${draft.motion ? 'animated' : 'still'}`)
      ]),
      h('p.ob__lead', 'Ctrl+K opens the command palette from anywhere. Ctrl+I imports accounts, Ctrl+N adds one by token, ' +
        'and Ctrl+1 to 5 move between the pages. "Run setup again" in the Settings > General menu brings this flow back, ' +
        'and the command list is always under Help > What can the bots be told to do?')
    ]);
  }

  // ------------------------------------------------------------ bits

  function summaryRow(name, value, meta) {
    return h('div.ob__summary-row', [
      h('span.ob__summary-icon', [icon(name, { size: 16 })]),
      h('div', [h('b', value), h('span', meta)])
    ]);
  }

  /**
   * One line of the walkthrough.
   *
   * The digit is a drawn badge rather than an `<ol>` marker, so it sits in a
   * circle in the accent colour instead of in the page's own type. It is hidden
   * from assistive tech, which already gets the position from the list it is in.
   */
  function numbered(index, title, help) {
    return h('li.ob__step', [
      h('span.ob__step-num', { 'aria-hidden': 'true' }, String(index)),
      h('div.ob__step-text', [h('b', title), h('span', help)])
    ]);
  }

  function row(name, title, help, control) {
    return h('div.ob__row', [
      h('span.ob__row-icon', [icon(name, { size: 16 })]),
      h('div.ob__row-text', [h('b', title), h('span', help)]),
      h('div.ob__row-control', [control])
    ]);
  }

  function toggle(on, onChange) {
    const input = h('input', { type: 'checkbox', checked: on });
    input.addEventListener('change', () => onChange(input.checked));
    return h('label.toggle', [input, h('span')]);
  }

  /** A segmented control with its own repaint, for a small exclusive choice. */
  function segmented(options, current, onPick) {
    const buttons = options.map((option) => h('button.ob__seg', {
      type: 'button',
      dataset: { id: option.id },
      onclick: () => { onPick(option.id); paint(); }
    }, option.label));

    const element = h('div.ob__segmented', buttons);

    function paint() {
      const value = current();
      for (const button of buttons) {
        button.setAttribute('aria-pressed', button.dataset.id === value ? 'true' : 'false');
      }
    }
    paint();

    return { el: element };
  }

  function winButton(name, label, onClick) {
    return h(
      'button',
      { type: 'button', title: label, 'aria-label': label, onclick: onClick },
      [icon(name, { size: 20 })]
    );
  }

  return {
    el,
    start() {
      render();
      backdrop.mount();
      syncBackdrop();
      // Focus the first real control once the step has settled. Deferred by a
      // frame so it does not fight the entry animation for the caret.
      nextFrame().then(() => slot.querySelector('input:not([type="checkbox"])')?.focus());
    },
    destroy() {
      // Nothing is written on teardown: a flow that is closed without
      // finishing - the window shutting, say - should leave the settings as
      // they were rather than half-applied.
      backdrop.destroy();
    }
  };
}
