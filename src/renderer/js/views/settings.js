/**
 * Settings.
 *
 * Built entirely from the schema the backend publishes, so adding an option
 * there is the whole change - no form to hand-write here, and no way for this
 * screen to drift from what the backend actually accepts.
 *
 * The form is painted once and then patched in place. Repainting on every
 * `settings` event would be simpler, and would also throw away the caret of
 * whatever field is being typed into, which is the one thing a settings screen
 * must not do.
 */
import { h, fill, raf, debounce } from '../dom.js';
import { icon, hydrate } from '../icons.js';
import * as bridge from '../bridge.js';
import * as store from '../store.js';
import * as format from '../format.js';
import * as toast from '../components/toast.js';
import { emptyState } from '../components/table.js';
import { menu, dropdown, confirm as confirmDialog } from '../components/overlay.js';
import { shell, bag, searchField, settingRow } from './shell.js';
import { go, snapshotNow } from '../actions.js';
import { LINKS } from '../links.js';
// A cycle, but a harmless one: app.js imports this module for its view object,
// and this binding is only dereferenced from a click handler long after both
// modules have finished evaluating.
import { openSetup } from '../app.js';

/** Enum values that a naive capitalise would render badly. */
const LABEL_OVERRIDES = {
  ms: 'ms', msa: 'Microsoft', ui: 'Interface', afk: 'AFK', eu: 'EU',
  dark: 'Dark', light: 'Light', auto: 'Automatic'
};

function pretty(value) {
  const text = String(value);
  if (LABEL_OVERRIDES[text]) return LABEL_OVERRIDES[text];
  return text.charAt(0).toUpperCase() + text.slice(1).replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** A short description of what a value means, for the control's tooltip. */
function describeValue(field, value) {
  if (field.type === 'bool') return value ? 'On' : 'Off';
  if (field.type === 'number') return format.num(value);
  if (field.type === 'string') return String(value ?? '').trim() || 'empty';
  if (field.type === 'list') return format.nameList(value);
  return pretty(value);
}

/**
 * The icon on a settings row.
 *
 * Named per key where a glyph says something the group's does not, and falling
 * back to the group's own icon otherwise. That fallback is the point: every row
 * in Appearance carrying the brush is the reference's rhythm, and it reads far
 * better than leaving the icon column empty on the twenty-odd keys that have no
 * obvious glyph of their own. A per-key icon for all forty would be invented
 * noise; a per-key icon only where the key has one is signal.
 */
const FIELD_ICONS = {
  'general.ownerName': 'pencil-01',
  'general.confirmQuit': 'alert-triangle',
  'general.restoreWindow': 'layout-top',
  'general.startMinimised': 'minus',
  'general.launchOnStartup': 'rocket-02',
  'general.tray': 'layout-top',
  'general.closeToTray': 'x-close',
  'appearance.theme': 'moon-01',
  'appearance.accent': 'colors',
  'appearance.accentCustom': 'paint-pour',
  'appearance.radius': 'square',
  'appearance.density': 'paragraph-wrap',
  'appearance.fontScale': 'paragraph-wrap',
  'appearance.reduceMotion': 'moon-01',
  'appearance.background': 'brush-01',
  'appearance.headStyle': 'onboarding-account',
  'appearance.headService': 'download-cloud-02',
  'accounts.defaultSkinModel': 'onboarding-account',
  'accounts.showTokenHints': 'key-01',
  'accounts.confirmBulkDelete': 'alert-triangle',
  'accounts.sortBy': 'bar-chart-square-02',
  'accounts.sortDir': 'arrow-right',
  'bots.defaultServer': 'globe-01',
  'bots.defaultVersion': 'code-snippet-02',
  'bots.autoReconnect': 'refresh-cw-01',
  'bots.reconnectDelayMs': 'clock-rewind',
  'bots.maxReconnectAttempts': 'refresh-ccw-02',
  'bots.viewDistance': 'eye',
  'bots.maxConcurrent': 'users-01',
  'bots.antiAfk': 'clock-rewind',
  'bots.antiAfkIntervalMs': 'clock-rewind',
  'bots.chatPrefix': 'message-text-square-01',
  'bots.logChat': 'clipboard-check',
  'whitelist.enabled': 'shield-01',
  'whitelist.players': 'users-01',
  'bots.vanillaPhysics': 'zap',
  'discord.richPresence': 'discord',
  'discord.clientId': 'key-01',
  'addons.enabled': 'zap',
  'addons.allowChatCommands': 'message-text-square-01',
  'proxies.enabled': 'globe-01',
  'proxies.mode': 'sliders-04',
  'proxies.testTimeoutMs': 'clock-rewind',
  'logging.level': 'file-02',
  'logging.retentionDays': 'calendar',
  'logging.toFile': 'folder-download',
  'logging.maxRows': 'database-01',
  'notify.botDisconnect': 'bell-01',
  'notify.botError': 'alert-circle',
  'notify.accountTest': 'check-circle',
  'notify.sound': 'bell-01',
  'data.autoBackup': 'database-01',
  'data.backupKeep': 'folder-check'
};

export default {
  mount(container) {
    const subscriptions = bag();
    const view = shell({ title: 'Settings', subtitle: 'Everything is stored locally.', flush: true });

    let group = null;           // null = whichever group is first
    let query = '';

    // The group list on the left, the fields for the selected group on the
    // right. Declared here so every painter below can reach them.
    //
    // The gutter is `--page-pad` like every other page's, and the two panes are
    // 24px apart rather than 20: the left pane is a list of buttons with their
    // own backgrounds, so it needs more air before the right pane's first row
    // than two plain columns would.
    //
    // No cap on the width. A row is a label on the left and its control on the
    // right, and the gap between them is the space the value has to cross to
    // read as belonging to its label - so a wide window *should* push the two
    // apart, and a maximised one leaves the rows stretching to the window edge
    // rather than stopping in the middle of it with a band of empty page beside
    // them. What keeps a row readable at that width is not the cap but the
    // description's own measure, which is clamped in the stylesheet.
    const groupsEl = h('div');
    const leftPane = h('div', { style: { position: 'sticky', top: '0' } }, [groupsEl]);
    const bodyEl = h('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: '225px minmax(0, 1fr)',
        gap: '24px',
        alignItems: 'start',
        padding: '0 var(--page-pad) 40px'
      }
    }, [leftPane]);
    const searchBox = searchField({
      placeholder: 'Search settings…',
      label: 'Search settings',
      onInput: debounce((value) => {
        query = value.trim().toLowerCase();
        paint();
      }, 140)
    });

    view.add(
      h('button.btn.btn--ghost', { type: 'button', onclick: (event) => openMenu(event.currentTarget) }, [
        icon('dots-vertical', { size: 15 })
      ])
    );

    // ------------------------------------------------------------ reading

    const schema = () => store.state.settingsSchema ?? { groups: [], fields: [] };
    const valueOf = (key) => store.state.settings[key];
    const currentGroups = () => schema().groups ?? [];

    function fieldsFor(id) {
      return (schema().fields ?? []).filter((field) => field.group === id);
    }

    /** Fields matching the search, across every group. */
    function searchResults() {
      return (schema().fields ?? []).filter((field) =>
        `${field.label} ${field.key} ${field.help ?? ''}`.toLowerCase().includes(query));
    }

    // ------------------------------------------------------------ writing

    let pendingPaint = false;

    /**
     * Persist one setting.
     *
     * `quiet` is for the controls that fire continuously - a slider, a text
     * field - where a toast per keystroke would be noise. The value is applied
     * locally first so the UI never lags the interaction.
     */
    async function commit(key, value, { quiet = false } = {}) {
      const previous = store.state.settings[key];
      store.state.settings[key] = value;
      store.applyAppearance();

      try {
        const result = await bridge.invoke('app.settings.update', { [key]: value });
        // The backend returns everything it holds; taking it wholesale keeps
        // this mirror honest about coercion (a clamped number, a rejected enum).
        if (result) store.state.settings = result;
        store.applyAppearance();
        if (!quiet) {
          const field = (schema().fields ?? []).find((entry) => entry.key === key);
          toast.ok('Saved', field ? `${field.label}: ${describeValue(field, store.state.settings[key])}` : null, { timeout: 1600 });
        }
      } catch (err) {
        store.state.settings[key] = previous;
        store.applyAppearance();
        toast.fromError(err, 'Could not save that setting');
      }

      paintDirty();
    }

    // ------------------------------------------------------------ controls

    /**
     * Every control below returns `{ control, revert }`.
     *
     * `control` is what sits at the right-hand end of the row and `revert` says
     * whether a reset button belongs beside it. Splitting them this way is what
     * lets one `row()` below own the shape of every row on the page, so the
     * four types cannot drift into four different layouts.
     */
    const iconFor = (field) => FIELD_ICONS[field.key]
      ?? currentGroups().find((entry) => entry.id === field.group)?.icon
      ?? null;

    /**
     * Wrap a control in the reference's setting row.
     *
     * The revert button is the first thing in the control group, not an overlay
     * on the row. It used to be absolutely positioned at the row's top-right
     * corner, which put it directly on top of whatever the row's control was -
     * on a dropdown it covered the chevron, and on a slider it covered the end
     * of the track. Inline, it takes its own space and the row grows by the
     * 30-odd pixels rather than the control being obscured.
     */
    function row(field, control, { revert = true, description = null } = {}) {
      const parts = [];

      if (revert) {
        const button = h('button.btn.btn--ghost.btn--icon.btn--sm', {
          type: 'button',
          hidden: true,
          'aria-label': `Reset ${field.label} to its default`,
          title: `Reset to ${describeValue(field, field.default)}`,
          onclick: () => commit(field.key, field.default)
        }, [icon('refresh-ccw-02', { size: 13 })]);

        revertHosts.push({ key: field.key, value: field.default, el: button });
        parts.push(button);
      }

      parts.push(control);

      return settingRow({
        icon: iconFor(field),
        title: field.label,
        description: description ?? field.help,
        control: parts
      });
    }

    function boolRow(field) {
      const on = Boolean(valueOf(field.key));
      const state = h('span.rowcard__state', on ? 'On' : 'Off');
      const input = h('input', { type: 'checkbox', checked: on, 'aria-label': field.label });

      input.addEventListener('change', () => {
        state.textContent = input.checked ? 'On' : 'Off';
        commit(field.key, input.checked);
      });

      // No revert on a switch: the row already states the value in words, and a
      // second control that only ever says "put it back" is noise on a row whose
      // whole job is to show which of two states it is in.
      return row(field, [state, h('label.toggle', [input, h('span')])], { revert: false });
    }

    function enumRow(field) {
      return row(field, dropdown({
        options: (field.options ?? []).map((option) => ({ value: option, label: pretty(option) })),
        value: valueOf(field.key),
        label: field.label,
        onChange: (next) => commit(field.key, next)
      }).el);
    }

    /**
     * A colour, as a swatch next to a box.
     *
     * `type="color"` on its own is a swatch that opens the system picker and
     * *only* the system picker, so the hex value - which is what the setting
     * actually stores, and what someone pasting a colour from elsewhere has -
     * would be unreadable and uneditable. The two are one control here: the
     * swatch opens the picker, the box takes the hex directly, and either one
     * moves the other.
     */
    function colorRow(field) {
      const swatch = h('input', {
        type: 'color',
        value: /^#[0-9a-f]{6}$/i.test(String(valueOf(field.key))) ? valueOf(field.key) : '#ba60ff',
        'aria-label': `${field.label} picker`
      });

      const text = h('input.input', {
        type: 'text',
        value: String(valueOf(field.key) ?? ''),
        spellcheck: 'false',
        autocomplete: 'off',
        'aria-label': field.label,
        style: { width: '140px', fontFamily: 'var(--mono)', fontSize: 'var(--fs-xs)' }
      });

      let timer = null;
      const save = (value, { quiet }) => {
        clearTimeout(timer);
        if (quiet) timer = setTimeout(() => commit(field.key, value, { quiet: true }), 400);
        else commit(field.key, value, { quiet: false });
      };

      // Live while dragging the picker, so the accent follows the wheel; saved
      // once the picker closes, which is when `change` fires.
      swatch.addEventListener('input', () => {
        text.value = swatch.value;
        commit(field.key, swatch.value, { quiet: true });
      });
      swatch.addEventListener('change', () => save(swatch.value, { quiet: false }));

      text.addEventListener('input', () => {
        // Only chase the swatch once the text is a colour the input can hold.
        if (/^#[0-9a-f]{6}$/i.test(text.value)) swatch.value = text.value;
        save(text.value.trim(), { quiet: true });
      });
      text.addEventListener('blur', () => save(text.value.trim(), { quiet: false }));

      return row(field, [swatch, text]);
    }

    /**
     * A number, as a slider next to a box.
     *
     * The slider is for feel and the box is for exactness - a 1..120000 range
     * is unusable by drag alone, and a bare box makes it tedious to explore.
     *
     * Both live in the row's control group rather than under a label, so the
     * range is 220px and the number reads as the slider's readout. The bounds go
     * into the row's description rather than under the track, which is what
     * keeps the row the same one-line height as every other row.
     */
    function numberRow(field) {
      const min = field.min ?? 0;
      const max = field.max ?? 100;
      const step = max - min > 2000 ? 100 : max - min > 200 ? 1 : max - min > 20 ? 1 : 0.05;

      const range = h('input', {
        type: 'range',
        min: String(min), max: String(max), step: String(step),
        value: String(valueOf(field.key)),
        'aria-label': field.label
      });

      const box = h('input.input', {
        type: 'number',
        min: String(min), max: String(max), step: String(step),
        value: String(valueOf(field.key)),
        'aria-label': `${field.label} value`,
        style: { width: '96px', textAlign: 'right' }
      });

      // The filled part of the trough is a gradient sized off `--fill`, because
      // Chromium has no pseudo-element for the progress the way Firefox does.
      // Rounded, because the raw division lands values like 37.50000000000001%.
      const paintFill = () => {
        const pct = max > min ? ((Number(range.value) - min) / (max - min)) * 100 : 0;
        range.style.setProperty('--fill', `${Math.round(pct * 100) / 100}%`);
      };
      paintFill();

      const push = (raw, { quiet }) => {
        const next = Number(raw);
        if (!Number.isFinite(next)) return;
        range.value = String(next);
        box.value = String(next);
        paintFill();
        commit(field.key, next, { quiet });
      };

      // Dragging is continuous, so it saves without a toast; letting go of the
      // slider is the moment worth confirming.
      range.addEventListener('input', () => push(range.value, { quiet: true }));
      range.addEventListener('change', () => push(range.value, { quiet: false }));
      box.addEventListener('change', () => push(box.value, { quiet: false }));

      return row(field, [range, box], {
        description: `${field.help ? `${field.help} ` : ''}Between ${format.num(min)} and ${format.num(max)}.`
      });
    }

    function stringField(field) {
      const input = h('input.input', {
        type: 'text',
        value: valueOf(field.key) ?? '',
        placeholder: field.default ? String(field.default) : '',
        spellcheck: 'false',
        autocomplete: 'off',
        'aria-label': field.label,
        style: { width: '300px' }
      });

      let timer = null;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => commit(field.key, input.value, { quiet: true }), 400);
      });
      input.addEventListener('blur', () => {
        clearTimeout(timer);
        if (input.value !== String(valueOf(field.key) ?? '')) commit(field.key, input.value, { quiet: true });
      });

      return row(field, input);
    }

    /**
     * A list of names, edited in place.
     *
     * Chips rather than a comma-separated text box: every entry has to be a
     * Minecraft username, and a chip that can only be removed whole makes it
     * obvious that a half-typed name was never saved. The backend drops
     * anything that is not a username, so a rejected entry comes back as the
     * list being unchanged - which is why the chips are repainted from what was
     * actually stored rather than from what was typed.
     */
    function listRow(field) {
      const current = () => (Array.isArray(valueOf(field.key)) ? valueOf(field.key) : []);

      const chips = h('div.row', { style: { flexWrap: 'wrap', gap: '6px', justifyContent: 'flex-end' } });

      const input = h('input.input', {
        type: 'text',
        value: '',
        maxlength: '16',
        spellcheck: 'false',
        autocomplete: 'off',
        placeholder: 'Add a username',
        'aria-label': `Add a username to ${field.label}`,
        style: { width: '170px' }
      });

      function paintChips() {
        const names = current();
        fill(chips, names.length
          ? names.map((name) => h('span.chip.chip--removable', [
            h('span', name),
            h('button.chip__remove', {
              type: 'button',
              title: `Remove ${name}`,
              'aria-label': `Remove ${name}`,
              onclick: async () => { await commit(field.key, current().filter((n) => n !== name)); paintChips(); }
            }, [icon('x-close', { size: 11 })])
          ]))
          : [h('span.muted', { style: { fontSize: 'var(--fs-sm)' } }, 'Nobody yet')]);
        hydrate(chips);
      }

      async function add() {
        const value = input.value.trim();
        if (!value) return;

        // The same rule the backend enforces. Rejecting here as well means the
        // reason is shown against the field instead of the name silently not
        // appearing once the save comes back.
        if (!format.isUsername(value)) {
          toast.warn('Not a Minecraft username', 'Usernames are 3 to 16 letters, numbers and underscores.');
          return;
        }
        if (current().some((name) => name.toLowerCase() === value.toLowerCase())) {
          input.value = '';
          return;
        }

        input.value = '';
        await commit(field.key, [...current(), value]);
        paintChips();
      }

      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        add();
      });

      const addButton = h('button.btn.btn--sm', {
        type: 'button',
        'aria-label': `Add the username to ${field.label}`,
        onclick: () => add()
      }, [icon('plus', { size: 14 }), 'Add']);

      paintChips();

      return row(field, h('div', {
        style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }
      }, [
        chips,
        h('div.row', { style: { gap: '6px' } }, [input, addButton])
      ]));
    }

    function renderField(field) {
      // The custom accent is a colour, not a string, and the schema types it as
      // one only because "any CSS colour" has no enum to draw from. It gets the
      // swatch control rather than a bare text box.
      if (field.key === 'appearance.accentCustom') return colorRow(field);

      switch (field.type) {
        case 'bool': return boolRow(field);
        case 'enum': return enumRow(field);
        case 'number': return numberRow(field);
        case 'list': return listRow(field);
        default: return stringField(field);
      }
    }

    // ------------------------------------------------------------ dirty marks

    /**
     * Show a revert button on every field that differs from its default.
     *
     * The buttons are registered by `row()` as it builds them and their
     * visibility is toggled here rather than by repainting: a repaint on every
     * save would take the caret out of a text field mid-edit.
     */
    const revertHosts = [];

    function paintDirty() {
      for (const entry of revertHosts) {
        const dirty = store.state.settings[entry.key] !== entry.value;
        entry.el.hidden = !dirty;
      }
    }

    // ------------------------------------------------------------ groups

    function paintGroups() {
      const groups = currentGroups();
      const active = activeGroup();

      fill(groupsEl, [
        h('div', { style: { padding: '2px 0 12px' } }, [searchBox.el]),
        ...groups.map((entry) => h('button.navitem.navitem--pane', {
          type: 'button',
          'aria-current': entry.id === active ? 'page' : null,
          onclick: () => { query = ''; searchBox.reset(); group = entry.id; paint(); }
        }, [
          icon(entry.icon ?? 'settings-01', { size: 18 }),
          h('span.grow', entry.label),
          h('span.navitem__badge', format.num(fieldsFor(entry.id).length))
        ]))
      ]);
      hydrate(groupsEl);
    }

    function activeGroup() {
      if (group && currentGroups().some((entry) => entry.id === group)) return group;
      return currentGroups()[0]?.id ?? 'general';
    }

    function groupActions(id) {
      return [
        { header: true, label: 'This group' },
        ...(id === 'general'
          ? [{ icon: 'onboarding-complete', label: 'Run setup again', onClick: () => replaySetup() }]
          : []),
        { icon: 'refresh-ccw-02', label: 'Reset every option here', onClick: () => resetGroup(id) },
        { separator: true },
        { header: true, label: 'Everything' },
        { icon: 'download-01', label: 'Export settings…', onClick: () => exportSettings() },
        { icon: 'trash-01', label: 'Reset all settings', danger: true, onClick: () => resetAll() }
      ];
    }

    /**
     * Replay the first-run flow.
     *
     * Deliberately does not clear `seenOnboarding` first: the flow rewrites it
     * on the way out either way, and leaving it set means closing the window
     * mid-replay does not send the user through setup again on the next launch.
     */
    function replaySetup() {
      openSetup();
    }

    async function resetGroup(id) {
      const keys = fieldsFor(id).map((field) => field.key);
      const confirmed = await confirmDialog({
        title: `Reset ${currentGroups().find((g) => g.id === id)?.label ?? id}?`,
        message: `${format.plural(keys.length, 'option')} will go back to their defaults.`,
        confirmLabel: 'Reset',
        danger: true
      });
      if (!confirmed) return;

      try {
        const result = await bridge.invoke('app.settings.reset', { keys });
        if (result) store.state.settings = result;
        store.applyAppearance();
        toast.ok('Reset to defaults');
        paint();
      } catch (err) {
        toast.fromError(err, 'Could not reset those options');
      }
    }

    async function resetAll() {
      const confirmed = await confirmDialog({
        title: 'Reset every setting?',
        message: 'The whole configuration goes back to how flora shipped.',
        detail: 'Accounts, bots and logs are not touched.',
        confirmLabel: 'Reset everything',
        danger: true
      });
      if (!confirmed) return;

      try {
        const result = await bridge.invoke('app.settings.reset', {});
        if (result) store.state.settings = result;
        store.applyAppearance();
        toast.ok('Everything is back to its defaults');
        paint();
      } catch (err) {
        toast.fromError(err, 'Could not reset the settings');
      }
    }

    async function exportSettings() {
      const lines = Object.entries(store.state.settings)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
        .join('\n');

      try {
        const saved = await bridge.ui.saveText({
          title: 'Export settings',
          defaultName: 'flora-settings.txt',
          contents: lines
        });
        if (saved?.cancelled) return;
        toast.ok('Settings exported', format.truncateMiddle(saved.path, 22, 14));
      } catch (err) {
        toast.fromError(err, 'Could not export the settings');
      }
    }

    function openMenu(anchor) {
      menu(anchor, [
        { header: true, label: 'Settings' },
        { icon: 'download-01', label: 'Export settings…', onClick: () => exportSettings() },
        { icon: 'refresh-cw-01', label: 'Reload from the backend', onClick: () => reload() },
        { separator: true },
        { icon: 'trash-01', label: 'Reset all settings', danger: true, onClick: () => resetAll() }
      ], { align: 'end' });
    }

    // ------------------------------------------------------------ body

    /**
     * The extra panel under the Data group.
     *
     * These are the maintenance actions that belong next to the settings that
     * govern them, rather than on a screen of their own.
     */
    function dataTools() {
      const skinCache = store.state.stats?.skins ?? null;

      const button = (label, iconName, run, hint = null) => h('button.menu__item', {
        type: 'button',
        style: { height: 'auto', padding: '9px 10px' },
        onclick: run
      }, [
        icon(iconName, { size: 18 }),
        h('span.grow', [
          h('b', { style: { display: 'block', fontWeight: '500' } }, label),
          hint ? h('span.muted', { style: { display: 'block', fontSize: 'var(--fs-xs)' } }, hint) : null
        ])
      ]);

      return h('div.card', { style: { marginTop: '16px' } }, [
        h('header.card__header', [
          h('div.grow', [h('h3', 'Maintenance'), h('p', 'The housekeeping that goes with these options.')])
        ]),
        h('div', { style: { padding: '6px' } }, [
          button('Back up the database now', 'database-01', () => snapshotNow(), 'Writes a copy next to the original.'),
          button('Show the data folder', 'folder', () => revealDataFolder(), 'Where the database, logs and cached skins live.'),
          button('Clear the skin cache', 'folder-download', () => clearSkinCache(), skinCache ? `${format.plural(skinCache.files ?? 0, 'file')} · ${format.bytes(skinCache.bytes ?? 0)}` : 'Heads are re-downloaded as they are needed.'),
          button('Open the command history', 'clock-rewind', () => go('activity'), null)
        ])
      ]);
    }

    /** The data root is not in the store; it is asked for when it is wanted. */
    async function revealDataFolder() {
      try {
        const info = await bridge.invoke('app.info');
        await bridge.ui.revealPath(info.dataRoot);
      } catch (err) {
        toast.fromError(err, 'Could not open that folder');
      }
    }

    async function clearSkinCache() {
      const confirmed = await confirmDialog({
        title: 'Clear the cached skins?',
        message: 'Every stored head and skin file is deleted. They are downloaded again the next time they are needed.',
        confirmLabel: 'Clear',
        danger: true
      });
      if (!confirmed) return;

      try {
        const result = await bridge.invoke('skins.clearCache');
        toast.ok(`Deleted ${format.plural(result.removed ?? 0, 'file')}`);
        await store.refreshStats();
        paint();
      } catch (err) {
        toast.fromError(err, 'Could not clear the cache');
      }
    }

    // ------------------------------------------------------------ addons

    /**
     * The Addons pane.
     *
     * Everything here reads `store.state.addons`, which the backend pushes on
     * `addons:changed` after every load, unload, install and setting write. This
     * screen never has to guess what the registry did; it is told, so a failed
     * addon appears as a failed addon rather than as a missing one.
     *
     * The value controls are built here rather than through `renderField`,
     * because an addon's settings live in that addon's own store and are written
     * through `addons.setting` rather than the settings table. A control wired
     * to the wrong writer looks right and quietly saves nothing, which is the
     * one failure this screen could not recover from.
     */

    const masterOn = () => store.state.settings['addons.enabled'] !== false;
    const chatPrefix = () => store.state.settings['bots.chatPrefix'] || '.';

    /**
     * A switch, built the same way the settings rows build theirs.
     *
     * `title` carries the reason when the control is disabled, so a greyed-out
     * toggle says why rather than just refusing.
     */
    function switchControl({ checked, label, onChange, disabled = false, title = null }) {
      const state = h('span.rowcard__state', checked ? 'On' : 'Off');
      const input = h('input', { type: 'checkbox', checked, disabled, 'aria-label': label, title });
      input.addEventListener('change', () => {
        state.textContent = input.checked ? 'On' : 'Off';
        onChange(input.checked);
      });
      return [state, h('label.toggle', [input, h('span')])];
    }

    async function commitAddonSetting(id, key, value) {
      try {
        const result = await bridge.invoke('addons.setting', { id, key, value });
        // The backend clamps and coerces, so what it hands back is what to show
        // rather than what was typed into the box.
        const addon = (store.state.addons ?? []).find((entry) => entry.id === id);
        if (addon && result) addon.values = { ...addon.values, [key]: result.value };
      } catch (err) {
        toast.fromError(err, 'Could not save that addon setting');
      }
    }

    async function setAddonEnabled(id, enabled) {
      try {
        await bridge.invoke('addons.enable', { id, enabled });
        // The registry pushes the new list, which repaints this pane.
      } catch (err) {
        toast.fromError(err, 'Could not change that addon');
        await store.refreshAddons();
        paintBody();
      }
    }

    function addonFieldRow(addon, spec) {
      const value = addon.values?.[spec.key] ?? spec.default;

      if (spec.type === 'bool') {
        return settingRow({
          icon: 'sliders-04',
          title: spec.label,
          description: spec.help,
          control: switchControl({
            checked: Boolean(value),
            label: spec.label,
            onChange: (next) => commitAddonSetting(addon.id, spec.key, next)
          })
        });
      }

      let control;
      if (spec.type === 'enum') {
        control = dropdown({
          options: (spec.options ?? []).map((option) => ({ value: option, label: pretty(option) })),
          value,
          label: spec.label,
          onChange: (next) => commitAddonSetting(addon.id, spec.key, next)
        }).el;
      } else if (spec.type === 'number') {
        control = h('input.input', {
          type: 'number',
          value: String(value ?? 0),
          min: spec.min ?? null,
          max: spec.max ?? null,
          'aria-label': spec.label,
          style: { width: '110px' }
        });
        control.addEventListener('change', () =>
          commitAddonSetting(addon.id, spec.key, Number(control.value)));
      } else {
        control = h('input.input', {
          type: 'text',
          value: String(value ?? ''),
          'aria-label': spec.label,
          style: { width: '190px' }
        });
        control.addEventListener('change', () =>
          commitAddonSetting(addon.id, spec.key, control.value));
      }

      return settingRow({ icon: 'sliders-04', title: spec.label, description: spec.help, control });
    }

    /**
     * One addon in the list: the name, what it does, and the switch that decides
     * whether it runs.
     *
     * The list row carries only what somebody scanning it needs. Everything an
     * addon configures for itself is in a card of its own below, because eight
     * addons that each unfold into a form is not a list anybody can read.
     *
     * A failed addon says so here, in its own words. The message comes from the
     * vm wrapper or from the addon's own `activate()`, and paraphrasing it would
     * only make it harder for whoever wrote the addon to act on.
     */
    function addonRow(addon) {
      const master = masterOn();

      const description = addon.error
        ? h('span', { style: { color: 'var(--danger)' } }, addon.error)
        : addon.description;

      return settingRow({
        icon: 'zap',
        // The name is a node rather than a string so the badge can sit beside it.
        // `settingRow` puts the title inside its own `b`, which is why the badge
        // keeps its own styling: the row's text rules only reach direct children.
        title: addon.builtin
          ? h('span.row', { style: { gap: '10px' } }, [
            addon.name,
            h('span.badge.badge--ok', 'Built in')
          ])
          : addon.name,
        description,
        control: [
          // Built-ins cannot be removed, only switched off, so they get no
          // button that would only ever refuse.
          addon.builtin ? null : h('button.btn.btn--ghost.btn--icon.btn--sm', {
            type: 'button',
            'aria-label': `Remove ${addon.name}`,
            title: 'Remove this addon',
            onclick: () => removeAddon(addon)
          }, [icon('trash-01', { size: 14 })]),
          switchControl({
            checked: addon.enabled,
            label: `Enable ${addon.name}`,
            disabled: !master,
            title: master ? null : 'Addons are switched off.',
            onChange: (next) => setAddonEnabled(addon.id, next)
          })
        ].filter(Boolean)
      });
    }

    /**
     * What one addon added: the commands it answers to, and the settings it
     * declared.
     *
     * Only the addons with something to show get one of these. An addon that
     * just registers a chat command and takes no options still gets a card, so
     * that the commands are discoverable somewhere, but an addon with nothing at
     * all gets nothing.
     *
     * Declared settings only appear while the addon is running: they are read
     * through the live api, so on an addon that never loaded they would be
     * defaults being written into a store nobody is going to read back.
     */
    function addonDetailCard(addon) {
      const prefix = chatPrefix();
      const commands = addon.commands ?? [];
      const live = addon.enabled && addon.loaded;
      const fields = live ? addon.fields ?? [] : [];
      if (!commands.length && !fields.length) return null;

      const meta = [
        addon.version ? `v${addon.version}` : null,
        addon.author ? `by ${addon.author}` : null
      ].filter(Boolean).join(' · ');

      return h('div.card', [
        h('header.card__header', [
          h('span.rowcard__icon', [icon('zap', { size: 20 })]),
          h('div.grow', [
            h('h3', addon.name),
            meta ? h('p', { style: { fontSize: 'var(--fs-xs)' } }, meta) : null
          ]),
          commands.length
            ? h('div.row', { style: { gap: '6px', flexWrap: 'wrap' } }, commands.map((name) =>
              h('span.chip.chip--static', { title: `Typed in chat as ${prefix}${name}` },
                [icon('terminal', { size: 15 }), `${prefix}${name}`])))
            : null
        ]),
        fields.length
          ? h('div', { style: { padding: '0 12px 12px' } },
            fields.map((spec) => addonFieldRow(addon, spec)))
          : null
      ]);
    }

    function addonAction(label, iconName, run, { danger = false } = {}) {
      return h(`button.btn.btn--ghost.btn--sm${danger ? '.btn--danger' : ''}`, {
        type: 'button',
        onclick: run
      }, [icon(iconName, { size: 14 }), h('span', label)]);
    }

    /**
     * The installed addons, as a list.
     *
     * This is the centre of the pane and the answer to "what is running and how
     * do I stop it": one row per addon, each with its own switch, in the same
     * shape as every other row in Settings. Install, Reload and the folder
     * actions live in the header because they are about the set rather than
     * about any one addon.
     */
    function addonsListCard() {
      const addons = store.state.addons ?? [];
      const running = addons.filter((addon) => addon.loaded).length;

      return h('div.card', [
        h('header.card__header', [
          h('span.rowcard__icon', [icon('zap', { size: 20 })]),
          h('div.grow', [
            h('h3', 'Installed addons'),
            h('p', addons.length
              ? `${format.plural(addons.length, 'addon')}, ${format.num(running)} running.`
              : 'Addons add commands to your bots and let them react to what happens in game.')
          ]),
          h('div.row-gap', [
            addonAction('Install…', 'file-plus-02', () => installAddon()),
            addonAction('Reload', 'refresh-cw-01', () => reloadAddons()),
            h('button.btn.btn--ghost.btn--icon.btn--sm', {
              type: 'button',
              'aria-label': 'More addon actions',
              onclick: (event) => menu(event.currentTarget, [
                { icon: 'folder', label: 'Open the addons folder', onClick: () => showAddonFolder() },
                { icon: 'claude', label: 'Copy the Claude prompt', onClick: () => copyAddonPrompt() }
              ], { align: 'end' })
            }, [icon('dots-vertical', { size: 14 })])
          ])
        ]),
        // The rows are inset by the same 12px the other card bodies use, so a
        // row lines up with the header's icon column rather than with its edge.
        addons.length
          ? h('div', { style: { padding: '0 12px 12px' } }, addons.map(addonRow))
          : h('div', { style: { padding: '0 12px 12px' } }, emptyState({
            icon: 'zap',
            title: 'No addons installed',
            body: 'Install one from a folder, or copy the prompt below and write your own with Claude.'
          }))
      ]);
    }

    async function installAddon() {
      let picked;
      try {
        picked = await bridge.ui.openAddonFolder();
      } catch (err) {
        toast.fromError(err, 'Could not open the folder picker');
        return;
      }
      if (picked?.cancelled) return;

      try {
        const addon = await bridge.invoke('addons.install', { path: picked.path });
        toast.ok(`${addon?.name ?? 'The addon'} is installed`, 'It is switched on and running.');
        await store.refreshAddons();
        paintBody();
      } catch (err) {
        toast.fromError(err, 'That folder is not an addon');
      }
    }

    async function reloadAddons() {
      try {
        await bridge.invoke('addons.reload');
        await store.refreshAddons();
        toast.ok('Addons reloaded');
        paintBody();
      } catch (err) {
        toast.fromError(err, 'Could not reload the addons');
      }
    }

    async function showAddonFolder() {
      try {
        const { path } = await bridge.invoke('addons.folder');
        await bridge.ui.openPath(path);
      } catch (err) {
        toast.fromError(err, 'Could not open that folder');
      }
    }

    async function removeAddon(addon) {
      const confirmed = await confirmDialog({
        title: `Remove ${addon.name}?`,
        message: 'The addon folder and anything it stored are deleted. This cannot be undone.',
        confirmLabel: 'Remove',
        danger: true
      });
      if (!confirmed) return;

      try {
        await bridge.invoke('addons.remove', { id: addon.id });
        toast.ok(`${addon.name} removed`);
        await store.refreshAddons();
        paintBody();
      } catch (err) {
        toast.fromError(err, 'Could not remove that addon');
      }
    }

    /**
     * Hand the addon-writing prompt to the clipboard.
     *
     * The text comes from the backend rather than living here, so the
     * instructions and the API they describe change in one place.
     */
    async function copyAddonPrompt() {
      try {
        const { text } = await bridge.invoke('addons.prompt');
        if (!text) throw new Error('The prompt is empty.');
        await bridge.ui.copy(text);
        toast.ok('Prompt copied', 'Paste it into Claude and describe the addon you want.');
      } catch (err) {
        toast.fromError(err, 'Could not copy the prompt');
      }
    }

    function addonPromptCard() {
      return h('div.card', [
        h('header.card__header', [
          h('span.rowcard__icon', [icon('claude', { size: 20 })]),
          h('div.grow', [
            h('h3', 'Write your own'),
            h('p', 'An addon is a folder with an addon.json and an index.js. Copy the prompt below into Claude, say what you want the addon to do, and drop the folder back in here with Install.')
          ]),
          addonAction('Copy the prompt', 'claude', () => copyAddonPrompt())
        ]),
        h('div.row', { style: { gap: '6px', flexWrap: 'wrap', padding: '0 20px 18px' } }, [
          h('span.chip.chip--static', [icon('terminal', { size: 15 }), 'Registers chat commands']),
          h('span.chip.chip--static', [icon('message-text-square-01', { size: 15 }), 'Reads chat and events']),
          h('span.chip.chip--static', [icon('sliders-04', { size: 15 }), 'Adds its own settings']),
          h('span.chip.chip--static', [icon('database-01', { size: 15 }), 'Keeps its own storage'])
        ])
      ]);
    }

    // ------------------------------------------------------------ discord

    /**
     * The community, offered where addons are.
     *
     * Deliberately in this pane rather than buried in About: an addon is the one
     * thing in flora somebody might want to write themselves, and the people who
     * have already written one are in the Discord. The title bar carries the
     * same link for anyone who is not in Settings.
     */
    function discordCard() {
      return h('div.card', [
        h('header.card__header', [
          h('span.rowcard__icon', [icon('discord', { size: 20 })]),
          h('div.grow', [
            h('h3', 'Discord'),
            h('p', 'Addons other people have written, help when a bot will not connect, and release notes. ' +
              'Ask for an addon there and somebody has usually written it.')
          ]),
          h('button.btn.btn--primary.btn--sm', {
            type: 'button',
            onclick: () => openLink(LINKS.discord)
          }, [icon('link-external-01', { size: 15 }), 'Join the Discord'])
        ]),
        h('div.row', { style: { gap: '6px', flexWrap: 'wrap', padding: '0 20px 18px' } }, [
          h('span.chip.chip--static', [icon('zap', { size: 15 }), 'Addons and snippets']),
          h('span.chip.chip--static', [icon('help-circle', { size: 15 }), 'Help with a server']),
          h('span.chip.chip--static', [icon('announcement-01', { size: 15 }), 'Release notes'])
        ])
      ]);
    }

    /** Hand a link to the user's own browser. Never opens here. */
    async function openLink(url) {
      try {
        await bridge.ui.openExternal(url);
      } catch (err) {
        toast.fromError(err, 'Could not open that link');
      }
    }

    // ------------------------------------------------------------ presence

    /**
     * Whether the profile is actually being updated.
     *
     * The two switches above say what was asked for; neither can say whether it
     * happened. There are three ways for a correctly configured presence to
     * show nothing - Discord is not running, it was closed since, or the switch
     * is off - and they need different answers, so the panel asks the backend
     * and names which one it is.
     */
    function discordPanel() {
      const host = h('div.card');

      const paintStatus = async () => {
        let info = null;
        try {
          info = (await bridge.invoke('app.info')).discord ?? null;
        } catch { /* the first branch below covers it */ }

        const state = readPresence(info);

        fill(host, [
          h('header.card__header', [
            h('span.rowcard__icon', [icon('discord', { size: 20 })]),
            h('div.grow', [
              h('h3', 'Rich Presence'),
              h('p', 'Whether your profile currently says what flora is doing.')
            ])
          ]),
          h('div.row', { style: { gap: '10px', alignItems: 'flex-start', padding: '0 20px 18px' } }, [
            h(`span.presence__dot.presence__dot--${state.tone}`),
            h('div.grow', [
              h('b', { style: { display: 'block', fontSize: 'var(--fs-sm)' } }, state.title),
              h('span.muted', { style: { display: 'block', fontSize: 'var(--fs-xs)', marginTop: '2px' } },
                state.detail)
            ])
          ])
        ]);
        hydrate(host);
      };

      paintStatus();
      return host;
    }

    /**
     * Turn the backend's answer into a sentence.
     *
     * Four states, because they need four different answers: the switch is off,
     * there is no application to attach to, Discord is shut, or it worked.
     * "Not connected" on its own would send someone looking in the wrong place.
     */
    function readPresence(info) {
      if (!info) {
        return {
          tone: 'warn',
          title: 'The backend did not answer',
          detail: 'The presence is set by the backend, so this needs it running.'
        };
      }
      if (!info.enabled) {
        return {
          tone: 'off',
          title: 'Switched off',
          detail: 'Nothing is sent to Discord. The switch is the one above.'
        };
      }
      if (!info.configured) {
        return {
          tone: 'warn',
          title: 'No application ID',
          detail: 'Rich Presence attaches to a Discord application, and the field above is empty.'
        };
      }
      if (info.connected) {
        return {
          tone: 'ok',
          title: 'Connected',
          detail: 'Discord has your bot count. It goes to the client on this machine and nowhere else.'
        };
      }
      return {
        tone: 'warn',
        title: 'Discord is not running',
        detail: 'Open the Discord desktop app and this will connect within a few seconds.'
      };
    }

    // ------------------------------------------------------------ audio

    /**
     * The voice chat audio library.
     *
     * The tracks are ordinary files in a folder under the data root, so this
     * list is the folder. Adding one copies the bytes in; nothing on this side
     * decodes or converts anything.
     */
    function voiceAudioCard() {
      const tracks = store.state.audio?.tracks ?? [];
      const stats = store.state.audio?.stats ?? null;

      const rows = tracks.length
        ? tracks.map((track) => settingRow({
          icon: 'play',
          title: track.name,
          description: format.bytes(track.size),
          control: h('button.btn.btn--ghost.btn--icon.btn--sm', {
            type: 'button',
            'aria-label': `Remove ${track.name}`,
            onclick: () => removeTrack(track.name)
          }, [icon('trash-01', { size: 14 })])
        }))
        : [h('div', { style: { padding: '0 20px 18px' } }, [
          h('span.muted', { style: { fontSize: 'var(--fs-sm)' } }, 'No tracks yet. Anything the bots can play goes here.')
        ])];

      return h('div.card', [
        h('header.card__header', [
          h('span.rowcard__icon', [icon('play', { size: 20 })]),
          h('div.grow', [
            h('h3', 'Voice chat audio'),
            h('p', stats && stats.count
              ? `${format.plural(stats.count, 'track')} · ${format.bytes(stats.bytes)} on disk.`
              : 'Drop in your own ogg, mp3, wav, m4a or flac and a bot with voice chat can play it.')
          ]),
          addonAction('Add tracks…', 'file-plus-02', () => addTracks())
        ]),
        h('div', { style: { padding: '0 12px 12px' } }, rows)
      ]);
    }

    async function addTracks() {
      let picked;
      try {
        picked = await bridge.ui.openAudioFiles();
      } catch (err) {
        toast.fromError(err, 'Could not open the file picker');
        return;
      }
      if (picked?.cancelled) return;

      try {
        const result = await bridge.invoke('audio.add', { files: picked.files ?? [] });
        const added = (result?.results ?? []).filter((entry) => entry.added).length;
        const failed = (result?.results ?? []).filter((entry) => !entry.added);

        if (added) toast.ok(`Added ${format.plural(added, 'track')}`);
        // A batch is allowed to half-succeed: one unreadable file should not
        // cost the user the four that copied in beside it.
        if (failed.length) {
          toast.warn(
            `${format.plural(failed.length, 'file')} skipped`,
            failed.map((entry) => `${entry.name}: ${entry.error}`).join('   ·   ')
          );
        }

        await store.refreshAudio();
        paintBody();
      } catch (err) {
        toast.fromError(err, 'Could not add those tracks');
      }
    }

    async function removeTrack(name) {
      try {
        await bridge.invoke('audio.remove', { name });
        await store.refreshAudio();
        paintBody();
      } catch (err) {
        toast.fromError(err, 'Could not remove that track');
      }
    }

    function addonsPanel() {
      const addons = store.state.addons ?? [];
      const master = masterOn();

      // The master switch is a schema field and is painted above this panel by
      // the generic renderer. What it cannot say there is what it did, so the
      // panel says it here rather than letting a list of dead toggles speak for
      // itself.
      const notice = master ? null : h('div.row', {
        style: {
          gap: '8px',
          alignItems: 'center',
          padding: '12px 16px',
          borderRadius: 'var(--r-md)',
          background: 'var(--warn-soft)',
          color: 'var(--warn)',
          fontSize: 'var(--fs-sm)'
        }
      }, [
        icon('alert-triangle', { size: 15 }),
        h('span', 'Addons are switched off. Nothing below is running.')
      ]);

      // `stack` spaces the children and holds them off the last setting row
      // above, which is the gap a card butted against a row would otherwise
      // swallow.
      return h('div.stack', [
        notice,
        addonsListCard(),
        ...addons.map(addonDetailCard),
        voiceAudioCard(),
        addonPromptCard(),
        discordCard()
      ]);
    }

    const paintBody = raf(() => {
      revertHosts.length = 0;

      if (!(schema().fields ?? []).length) {
        fill(rightPane, h('div.loading-block', [h('span.spinner'), 'Reading the schema…']));
        return;
      }

      // A section header, then that section's rows. Rows are painted in the
      // schema's own order rather than sorted by type: the backend's order is
      // the order someone sat down and decided on, and the type-based shuffle
      // that used to happen here is why the appearance switches all floated to
      // the top of their group away from the options they belong with.
      const section = (label, hint, fields, action = null) => [
        h('h2.section-title', [
          label,
          hint ? h('span.section-title__hint', hint) : null,
          action
        ]),
        ...fields.map(renderField)
      ];

      if (query) {
        const matches = searchResults();

        if (!matches.length) {
          fill(rightPane, emptyState({
            icon: 'search-md',
            title: 'No setting matches that',
            body: 'Try a shorter word, or the name of the option.'
          }));
          return;
        }

        // Grouped under the heading they came from, so a result off the
        // Appearance page is not mistaken for one off General.
        const byGroup = new Map();
        for (const field of matches) {
          if (!byGroup.has(field.group)) byGroup.set(field.group, []);
          byGroup.get(field.group).push(field);
        }

        fill(rightPane, [...byGroup].flatMap(([id, fields]) => section(
          currentGroups().find((entry) => entry.id === id)?.label ?? id,
          format.plural(fields.length, 'option'),
          fields
        )));

        hydrate(rightPane);
        paintDirty();
        return;
      }

      const id = activeGroup();
      const entry = currentGroups().find((item) => item.id === id);
      const fields = fieldsFor(id);

      if (!fields.length) {
        fill(rightPane, emptyState({
          icon: 'settings-01',
          title: 'Nothing to configure here',
          body: 'This group has no options of its own.'
        }));
        return;
      }

      // The group's own actions live in its heading rather than in a card
      // header: "reset this group" is about the group, and the heading is where
      // the group is named.
      const actions = h('button.btn.btn--ghost.btn--icon.btn--sm', {
        type: 'button',
        style: { marginLeft: 'auto' },
        'aria-label': `${entry?.label ?? 'Group'} actions`,
        onclick: (event) => menu(event.currentTarget, groupActions(id), { align: 'end' })
      }, [icon('dots-vertical', { size: 14 })]);

      fill(rightPane, [
        ...section(entry?.label ?? 'Settings', `${format.plural(fields.length, 'option')}.`, fields, actions),
        id === 'data' ? dataTools() : null,
        id === 'addons' ? addonsPanel() : null,
        id === 'discord' ? discordPanel() : null
      ].filter(Boolean));

      hydrate(rightPane);
      paintDirty();
    });

    function paint() {
      paintGroups();
      paintBody();
      const fields = schema().fields ?? [];
      view.setSubtitle(fields.length
        ? `${format.plural(fields.length, 'option')} across ${format.plural(currentGroups().length, 'group')}.`
        : 'Loading…');
    }

    async function reload() {
      await store.refreshSettings();
      try { store.state.settingsSchema = await bridge.invoke('app.settings.describe'); } catch { /* keep the old schema */ }
      paint();
    }

    // ------------------------------------------------------------ mount

    // A group list on the left, the fields for the selected group on the right.
    const rightPane = h('div', { style: { minWidth: '0' } });
    bodyEl.appendChild(rightPane);

    view.body.append(bodyEl);
    view.mount(container);

    paint();
    store.refreshStats();

    /**
     * The schema the left pane was last painted against.
     *
     * On a cold start this screen can mount before the backend has answered with
     * the schema, and the group list and subtitle would then be drawn against
     * nothing. Comparing identity is what lets the body keep its cheap
     * repaint-only path while a late schema still fills in the pane around it.
     */
    let paintedSchema = schema();

    subscriptions.add(store.subscribe(store.TOPICS.SETTINGS, () => {
      // Values changed underneath the form - a reset, or the backend coercing
      // something. Repaint only when nothing in the form has focus, so a
      // half-typed value is never yanked out from under the user.
      if (bodyEl.contains(document.activeElement)) return;

      if (schema() !== paintedSchema) {
        paintedSchema = schema();
        paint();
        return;
      }
      paintBody();
    }));

    // The addon list arrives from the registry after every load and unload, and
    // the audio library after every add. Same focus guard, for the same reason:
    // a repaint mid-word in an addon's own setting field would eat the edit.
    const repaintAddons = () => {
      if (activeGroup() === 'addons' && !bodyEl.contains(document.activeElement)) paintBody();
    };

    subscriptions.add(store.subscribe(store.TOPICS.ADDONS, repaintAddons));
    subscriptions.add(store.subscribe(store.TOPICS.AUDIO, repaintAddons));

    return {
      refresh: () => reload(),
      destroy: () => subscriptions.dispose()
    };
  }
};
