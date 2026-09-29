/**
 * Playtime, the worked example addon.
 *
 * An addon is a folder holding an `addon.json` beside an `index.js`. The
 * manifest is read and checked first; this file is then run once, in a sandbox,
 * with a single `flora` object passed to it. There is no import in here, no
 * require, and no way to reach the filesystem or the network. Everything this
 * addon can do is a method on `flora`.
 *
 * What it does: it remembers how long each account has been connected, carries
 * that total across restarts, and answers a `playtime` command with the current
 * session and the running total.
 *
 * It is small on purpose, but it touches the four things an addon normally
 * needs - a command, some settings, some events and some storage of its own -
 * and the teardown at the bottom is the part most first addons leave out.
 */

// ------------------------------------------------------------------ settings

flora.settings.define({
  announce: {
    type: 'bool',
    label: 'Announce on connect',
    help: "Write the running total into flora's log when a bot connects.",
    default: false
  },
  minimum: {
    type: 'number',
    label: 'Shortest session to bank',
    help: 'A session shorter than this many seconds is not added to the total.',
    default: 60,
    min: 0,
    max: 86400
  }
});

// ------------------------------------------------------------------ storage

/**
 * Totals are keyed by username rather than by account id, because a username is
 * the thing a person recognises. This file sits on disk and can be edited by
 * hand, so anything that is not a positive number is read back as zero.
 */
const keyFor = (username) => 'banked:' + String(username || '').toLowerCase();

function banked(username) {
  const value = Number(flora.store.get(keyFor(username), 0));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// ------------------------------------------------------------------ helpers

const pad = (n) => (n < 10 ? '0' + n : String(n));

/** Milliseconds as "2h 05m", "14m 09s" or "38s". Chat answers stay short. */
function spell(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours) return hours + 'h ' + pad(minutes) + 'm';
  if (minutes) return minutes + 'm ' + pad(seconds) + 's';
  return seconds + 's';
}

// ------------------------------------------------------------------ sessions

/** accountId -> { startedAt, username }, for the bots connected right now. */
const sessions = new Map();

/**
 * Add one finished session to its account's total, then forget it.
 *
 * Called both when a bot disconnects and when the addon is switched off, so it
 * reads the map itself rather than being handed a session.
 */
function bank(accountId) {
  const session = sessions.get(accountId);
  if (!session) return;
  sessions.delete(accountId);

  const elapsed = Date.now() - session.startedAt;
  if (elapsed / 1000 < Number(flora.settings.get('minimum'))) return;

  flora.store.set(keyFor(session.username), banked(session.username) + elapsed);
}

flora.on('bot:spawn', (event) => {
  sessions.set(event.accountId, { startedAt: Date.now(), username: event.username });

  if (flora.settings.get('announce')) {
    flora.log(event.username + ' connected. Banked so far: ' + spell(banked(event.username)) + '.');
  }
});

flora.on('bot:end', (event) => bank(event.accountId));

// ------------------------------------------------------------------ command

flora.commands.register({
  name: 'playtime',
  usage: 'playtime',
  summary: 'How long this bot has been connected',
  run(bot, args, ctx) {
    // ctx.username is the player who asked; bot.username is the account being
    // asked about. They are different, and confusing the two is the mistake
    // this comment exists to prevent.
    const session = sessions.get(ctx.accountId);
    const running = session ? Date.now() - session.startedAt : 0;

    bot.whisper(ctx.username, 'this session ' + spell(running) +
      ', total ' + spell(banked(bot.username) + running) + '.');
  }
});

// ------------------------------------------------------------------ teardown

/**
 * Switching the addon off has to bank whatever is still running.
 *
 * A bot that is connected when the addon is switched off never fires `bot:end`
 * for that session, because the listener has already been removed by then.
 * Without this the session would simply be lost. It is the half of the contract
 * that is easy to forget: whatever you start, stop it here.
 */
function deactivate() {
  for (const accountId of Array.from(sessions.keys())) bank(accountId);
  flora.log('Playtime stopped.');
}

flora.log('Playtime ready.');
