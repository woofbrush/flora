/**
 * Settings.
 *
 * One flat key/value table, but the shape of every key is declared here with a
 * type and a default. That gives three things for free:
 *
 *   - the renderer can build the Settings screen from the schema instead of
 *     hard-coding a form per option,
 *   - an unknown or hand-edited value is coerced back to something valid
 *     rather than crashing a view,
 *   - adding an option is one line, with no migration.
 *
 * Values are stored as JSON so booleans and numbers keep their type.
 */
import { get, all, run } from './db/index.js';

/** key -> { type, default, group, label, help? , min?, max?, options? } */
export const SCHEMA = {
  // ---- general -----------------------------------------------------
  'general.ownerName': {
    type: 'string', default: '', group: 'general', label: 'Your name',
    help: 'Shown in the window title and used to sign exports.'
  },
  'general.confirmQuit': {
    type: 'bool', default: true, group: 'general', label: 'Confirm before quitting',
    help: 'Warn when bots are running so a stray Ctrl+Q does not drop them all.'
  },
  'general.restoreWindow': {
    type: 'bool', default: true, group: 'general', label: 'Remember window size and position'
  },
  'general.startMinimised': {
    type: 'bool', default: false, group: 'general', label: 'Start minimised to tray'
  },
  'general.launchOnStartup': {
    type: 'bool', default: false, group: 'general', label: 'Open flora when I sign in to Windows'
  },
  'general.tray': {
    type: 'bool', default: false, group: 'general', label: 'Show a tray icon',
    help: 'Adds a flora icon to the notification area with a shortcut back to the window.'
  },
  'general.closeToTray': {
    type: 'bool', default: false, group: 'general', label: 'Keep running when the window is closed',
    help: 'Bots stay connected after the window closes. Quit from the tray icon or with Ctrl+Q.'
  },
  'general.seenOnboarding': {
    type: 'bool', default: false, group: 'general', label: 'Setup complete',
    help: 'Internal. Set once the first-run setup has been finished or skipped.',
    // Kept out of the Settings screen: it is a record of what has happened, not
    // a preference, and a switch for it would be a switch for nothing. The
    // setup flow is replayed from the General group's menu instead.
    hidden: true
  },

  // ---- appearance --------------------------------------------------
  'appearance.theme': {
    type: 'enum', default: 'dark', group: 'appearance', label: 'Theme',
    options: ['dark', 'light']
  },
  'appearance.accent': {
    type: 'enum', default: 'mauve', group: 'appearance', label: 'Accent colour',
    options: ['mauve', 'pink', 'blue', 'teal', 'green', 'yellow', 'peach', 'red', 'custom']
  },
  'appearance.accentCustom': {
    type: 'string', default: '#ba60ff', group: 'appearance', label: 'Custom accent',
    help: 'Any CSS colour. Only used when the accent above is set to "custom".'
  },
  'appearance.radius': {
    type: 'enum', default: 'soft', group: 'appearance', label: 'Corner rounding',
    options: ['square', 'soft', 'round']
  },
  'appearance.density': {
    type: 'enum', default: 'comfortable', group: 'appearance', label: 'Row density',
    options: ['compact', 'comfortable', 'spacious']
  },
  'appearance.fontScale': {
    type: 'number', default: 1, min: 0.85, max: 1.25, group: 'appearance',
    label: 'Text size', help: 'Scales every font in the app.'
  },
  'appearance.reduceMotion': {
    type: 'bool', default: false, group: 'appearance', label: 'Reduce motion',
    help: 'Turns off transitions and the animated backdrop.'
  },
  'appearance.background': {
    type: 'enum', default: 'aurora', group: 'appearance', label: 'Backdrop',
    options: ['aurora', 'none'],
    help: '"Aurora" is the drifting gradient. "None" paints a flat page colour.'
  },
  'appearance.headStyle': {
    type: 'enum', default: 'shaded', group: 'appearance', label: 'Head rendering',
    options: ['flat', 'shaded'],
    help: '"Shaded" draws the hat layer over each head and a soft shadow behind it. "Flat" shows the bare face.'
  },
  'appearance.headService': {
    type: 'bool', default: true, group: 'appearance',
    label: 'Look up heads for accounts with no skin',
    help: 'An account with no skin on record has its head drawn from api.mcheads.org and kept on this machine. ' +
          'Only the username is sent. Turn this off to keep every account name local, at the cost of a coloured initial.'
  },

  // ---- accounts ----------------------------------------------------
  'accounts.defaultSkinModel': {
    type: 'enum', default: 'classic', group: 'accounts', label: 'Default skin model',
    options: ['classic', 'slim'],
    help: 'Used when a skin PNG does not already declare slim arms.'
  },
  'accounts.showTokenHints': {
    type: 'bool', default: true, group: 'accounts', label: 'Show token hints in lists',
    help: 'Displays the last four characters. The full token is never shown anywhere.'
  },
  'accounts.confirmBulkDelete': {
    type: 'bool', default: true, group: 'accounts', label: 'Confirm bulk deletes'
  },
  'accounts.sortBy': {
    type: 'enum', default: 'added', group: 'accounts', label: 'Default sort',
    options: ['added', 'name', 'status', 'tested']
  },
  'accounts.sortDir': {
    type: 'enum', default: 'desc', group: 'accounts', label: 'Sort direction',
    options: ['asc', 'desc']
  },

  // ---- bots --------------------------------------------------------
  'bots.defaultServer': {
    type: 'string', default: '', group: 'bots', label: 'Default server',
    help: 'host or host:port. Used to pre-fill the connect dialog.'
  },
  'bots.defaultVersion': {
    type: 'string', default: 'auto', group: 'bots', label: 'Minecraft version',
    help: '"auto" lets mineflayer pick from the server ping.'
  },
  'bots.autoReconnect': {
    type: 'bool', default: true, group: 'bots', label: 'Reconnect dropped bots'
  },
  'bots.reconnectDelayMs': {
    type: 'number', default: 5000, min: 1000, max: 120000, group: 'bots',
    label: 'Reconnect delay (ms)'
  },
  'bots.maxReconnectAttempts': {
    type: 'number', default: 0, min: 0, max: 100, group: 'bots', label: 'Reconnect attempts',
    help: '0 means keep trying forever.'
  },
  'bots.viewDistance': {
    type: 'enum', default: 'normal', group: 'bots', label: 'View distance',
    options: ['far', 'normal', 'short', 'tiny'],
    help: 'Lower distances use noticeably less CPU per bot.'
  },
  'bots.maxConcurrent': {
    type: 'number', default: 12, min: 1, max: 200, group: 'bots',
    label: 'Maximum bots online',
    help: 'Caps how many bots connect at once. Per-bot CPU adds up quickly past a few dozen.'
  },
  'bots.antiAfk': {
    type: 'bool', default: false, group: 'bots', label: 'Anti-AFK by default',
    help: 'New bots nudge themselves periodically so the server does not kick them.'
  },
  'bots.antiAfkIntervalMs': {
    type: 'number', default: 30000, min: 5000, max: 600000, group: 'bots',
    label: 'Anti-AFK interval (ms)'
  },
  'bots.chatPrefix': {
    type: 'string', default: '.', group: 'bots', label: 'Command prefix',
    help: 'What whitelisted players type before a command in server chat, and before a command typed here.'
  },
  'bots.logChat': {
    type: 'bool', default: true, group: 'bots', label: 'Record chat to the console'
  },
  'bots.quickMode': {
    type: 'bool', default: false, group: 'bots', label: 'Quick mode',
    help: 'Puts the server and version straight in the Bots tab, so starting one is two fields instead of a trip through Settings.'
  },
  'bots.vanillaPhysics': {
    type: 'bool', default: true, group: 'bots', label: 'Simulate real movement',
    help: 'Bots run the same movement simulation a vanilla client does, so they fall, ' +
          'take knockback, get pushed by pistons and water, and can be moved by the server ' +
          'like any other player. Turning this off makes a bot hold its position instead, ' +
          'which some servers read as a frozen client.'
  },

  // ---- discord -----------------------------------------------------
  'discord.richPresence': {
    type: 'bool', default: false, group: 'discord', label: 'Show what flora is doing in Discord',
    help: 'Adds a line to your Discord profile saying how many bots are running. It goes to the ' +
          'Discord client on this machine and nowhere else: no account names, no server ' +
          'addresses and no tokens are ever included.'
  },
  'discord.clientId': {
    type: 'string', default: '1554567015522631802', group: 'discord', label: 'Discord application ID',
    help: 'Rich Presence is keyed to a Discord application, and this is flora\'s. Replace it with ' +
          'the Application ID of one of your own if you would rather the profile showed your ' +
          'own application name and artwork.'
  },

  // ---- addons ------------------------------------------------------
  'addons.enabled': {
    type: 'bool', default: true, group: 'addons', label: 'Enable addons',
    help: 'The master switch. With this off no addon is loaded at all, whatever the ' +
          'individual switches in the list below say.'
  },
  'addons.allowChatCommands': {
    type: 'bool', default: true, group: 'addons', label: 'Let addons add chat commands',
    help: 'Commands an addon registers are answered in server chat like the built-in ones, ' +
          'and obey the same whitelist. Turn this off to keep addon commands out of chat ' +
          'without unloading the addons themselves.'
  },

  // ---- whitelist ---------------------------------------------------
  // The one setting in flora whose failure mode is "a stranger drove your
  // accounts", so both halves start closed: off, and empty. See
  // bots/commands.js for what the list actually gates.
  'whitelist.enabled': {
    type: 'bool', default: false, group: 'whitelist', label: 'Let whitelisted players command bots',
    help: 'Off by default, and nobody is on the list, so a fresh install obeys no one.'
  },
  'whitelist.players': {
    type: 'list', default: [], group: 'whitelist', label: 'Whitelisted players',
    help: 'Minecraft usernames allowed to type bot commands in chat. Anyone else is refused.'
  },

  // ---- proxies -----------------------------------------------------
  'proxies.enabled': {
    type: 'bool', default: false, group: 'proxies', label: 'Use proxies',
    help: 'Off by default. Nothing below is consulted, and every connection is made directly.'
  },
  'proxies.routeApi': {
    type: 'bool', default: true, group: 'proxies', label: 'Route account traffic too',
    help: 'Sends sign-in, skin and username changes out through the same proxies. Bulk work is what gets rate limited, so this is worth leaving on.'
  },
  'proxies.mode': {
    type: 'enum', default: 'preferred', group: 'proxies', label: 'Assignment',
    options: ['preferred', 'rotate', 'random'],
    help: '"preferred" keeps an account on the proxy it was assigned. "rotate" walks the list. "random" picks each time.'
  },
  'proxies.testTimeoutMs': {
    type: 'number', default: 8000, min: 1000, max: 60000, group: 'proxies',
    label: 'Check timeout (ms)'
  },

  // ---- logging -----------------------------------------------------
  'logging.level': {
    type: 'enum', default: 'info', group: 'logging', label: 'Log level',
    options: ['debug', 'info', 'warn', 'error']
  },
  'logging.retentionDays': {
    type: 'number', default: 14, min: 1, max: 365, group: 'logging', label: 'Keep logs (days)'
  },
  'logging.toFile': {
    type: 'bool', default: true, group: 'logging', label: 'Write a daily log file'
  },
  'logging.maxRows': {
    type: 'number', default: 50000, min: 1000, max: 1000000, group: 'logging',
    label: 'Activity rows to keep',
    help: 'Oldest rows are trimmed once this is reached.'
  },

  // ---- notifications -----------------------------------------------
  'notify.botDisconnect': {
    type: 'bool', default: true, group: 'notifications', label: 'Notify when a bot disconnects'
  },
  'notify.botError': {
    type: 'bool', default: true, group: 'notifications', label: 'Notify on bot errors'
  },
  'notify.accountTest': {
    type: 'bool', default: false, group: 'notifications', label: 'Notify when an account check finishes'
  },
  'notify.sound': {
    type: 'bool', default: false, group: 'notifications', label: 'Play a sound'
  },

  // ---- data --------------------------------------------------------
  'data.autoBackup': {
    type: 'bool', default: true, group: 'data', label: 'Back up the database daily'
  },
  'data.backupKeep': {
    type: 'number', default: 7, min: 1, max: 90, group: 'data', label: 'Backups to keep'
  }
};

export const GROUPS = [
  { id: 'general',       label: 'General',       icon: 'settings-01' },
  { id: 'appearance',    label: 'Appearance',    icon: 'brush-01' },
  { id: 'accounts',      label: 'Accounts',      icon: 'users-01' },
  { id: 'bots',          label: 'Bots',          icon: 'rocket-02' },
  { id: 'addons',        label: 'Addons',        icon: 'zap' },
  { id: 'whitelist',     label: 'Whitelist',     icon: 'shield-01' },
  { id: 'discord',       label: 'Discord',       icon: 'discord' },
  { id: 'proxies',       label: 'Proxies',       icon: 'globe-01' },
  { id: 'notifications', label: 'Notifications', icon: 'bell-01' },
  { id: 'logging',       label: 'Logging',       icon: 'file-02' },
  { id: 'data',          label: 'Data',          icon: 'database-01' }
];

let cache = null;

/** The shape every list entry has to have. A Minecraft username, and nothing else. */
const LIST_ENTRY = /^[A-Za-z0-9_]{3,16}$/;

function coerce(spec, raw) {
  switch (spec.type) {
    case 'bool':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === 1 || raw === '1') return true;
      if (raw === 'false' || raw === 0 || raw === '0') return false;
      return spec.default;
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return spec.default;
      const min = spec.min ?? -Infinity;
      const max = spec.max ?? Infinity;
      return Math.min(max, Math.max(min, n));
    }
    case 'enum':
      return spec.options.includes(raw) ? raw : spec.default;
    case 'list': {
      if (!Array.isArray(raw)) return spec.default;
      // Cleaned rather than rejected wholesale: the list is typed by hand, and
      // dropping every name because one of them has a typo would lose the rest.
      // Anything that is not a username is dropped, and duplicates differing
      // only in case collapse to the first spelling.
      const seen = new Set();
      const out = [];
      for (const entry of raw) {
        const value = String(entry ?? '').trim();
        if (!LIST_ENTRY.test(value)) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(value);
      }
      return out;
    }
    default:
      return typeof raw === 'string' ? raw : spec.default;
  }
}

/** Lists need comparing by value; `===` would report every array as changed. */
function unchanged(spec, a, b) {
  if (spec.type !== 'list') return a === b;
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Whole settings object, schema defaults merged with stored overrides. */
export function all_settings() {
  if (cache) return cache;
  const out = {};
  for (const [key, spec] of Object.entries(SCHEMA)) out[key] = spec.default;

  for (const row of all('SELECT key, value FROM settings')) {
    const spec = SCHEMA[row.key];
    if (!spec) continue;                    // key from an older build; ignore
    let parsed;
    try { parsed = JSON.parse(row.value); } catch { parsed = row.value; }
    out[row.key] = coerce(spec, parsed);
  }

  cache = out;
  return out;
}

export function getSetting(key) {
  if (!(key in SCHEMA)) throw new Error(`Unknown setting: ${key}`);
  return all_settings()[key];
}

/** Validate and persist a patch. Returns the settings that actually changed. */
export function updateSettings(patch) {
  const current = all_settings();
  const changed = {};

  for (const [key, raw] of Object.entries(patch ?? {})) {
    const spec = SCHEMA[key];
    if (!spec) throw new Error(`Unknown setting: ${key}`);
    const next = coerce(spec, raw);
    if (unchanged(spec, current[key], next)) continue;
    changed[key] = next;
  }

  const keys = Object.keys(changed);
  if (keys.length) {
    for (const key of keys) {
      run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key, JSON.stringify(changed[key])
      );
    }
    cache = null;                            // forces a re-read on next access
    all_settings();
  }
  return changed;
}

export function resetSettings(keys = null) {
  if (keys?.length) {
    for (const key of keys) run('DELETE FROM settings WHERE key = ?', key);
  } else {
    run('DELETE FROM settings');
  }
  cache = null;
  return all_settings();
}

/** Schema in a renderer-friendly shape for the Settings screen. */
export function describe() {
  return {
    groups: GROUPS,
    // A `hidden` field is still stored and still read by the app; it just has no
    // business being offered as a checkbox. Filtering here rather than in the
    // view means no future screen can forget to.
    fields: Object.entries(SCHEMA)
      .filter(([, spec]) => !spec.hidden)
      .map(([key, spec]) => ({
        key,
        type: spec.type,
        group: spec.group,
        label: spec.label,
        help: spec.help ?? null,
        options: spec.options ?? null,
        min: spec.min ?? null,
        max: spec.max ?? null,
        default: spec.default
      }))
  };
}

/** Used by tests and by "reset everything" flows. */
export function invalidate() {
  cache = null;
}
