/**
 * In-game commands.
 *
 * A bot is driven from flora's console, but the reason to put a bot on a server
 * is that it is *on the server*: the person who wants it to follow them is
 * standing next to it with a chat box, not sitting at this app. So a bot also
 * listens to chat.
 *
 * That opens the obvious hole - anyone on the server can type - so nothing is
 * obeyed unless the speaker is on the whitelist in Settings. Both switches
 * default to closed: the feature is off, and the list is empty. A fresh install
 * obeys nobody rather than everybody, which is the only safe way round for a
 * setting whose failure mode is "a stranger drove your accounts".
 *
 * Refusals are whispered rather than said. A player who types the prefix by
 * accident gets told once, privately, instead of the bot announcing to the
 * whole server that it takes orders.
 *
 * `help` is the exception to all of that: it is answered here, in flora's own
 * console, and never leaves the client. A bot that recites six command lines
 * into server chat is a bot that gets kicked by whatever anti-spam the server
 * runs, and the person who typed it is the one already looking at this app.
 */
// mineflayer-pathfinder is CommonJS, and only `pathfinder` and `Movements` are
// spotted by Node's named-export detection - `goals` is not among them, so a
// named import of it fails at load with "Named export 'goals' not found". The
// default import is module.exports itself, which has all three.
import pathfinderPkg from 'mineflayer-pathfinder';
import { getSetting } from '../settings.js';
import { addonCommand, addonFor, commandHelp as addonHelp, setReservedCommands } from '../addons/registry.js';

const { goals } = pathfinderPkg;

/**
 * Minecraft refuses a chat line over 256 characters with `chat_too_long`, and
 * mineflayer refuses it a little earlier still: `whisper` is
 * `chatWithHeader('/tell <name> ', text)`, which throws before sending when the
 * text will not fit. So the budget is the wire string's, not a flat number.
 */
const CHAT_LIMIT = 256;

/** Goals that chase a player are re-issued on a timer, so cap the range. */
const FOLLOW_RANGE = 2;
const COME_RANGE = 1;

/** How long a whisper to `username` may be, `/tell ` and the space included. */
export function whisperBudget(username, limit = CHAT_LIMIT) {
  const header = `/tell ${String(username ?? '')} `.length;
  return Math.max(0, limit - header);
}

// ------------------------------------------------------------------ matching

/**
 * Whether `username` is on the list.
 *
 * Case-insensitive and whitespace-tolerant on both sides: the list is typed by
 * hand and Minecraft names are not case-sensitive to look at, so `Notch` and
 * `notch ` must both match.
 */
export function isWhitelisted(username, list) {
  const name = String(username ?? '').trim().toLowerCase();
  if (!name) return false;
  return (list ?? []).some((entry) => String(entry ?? '').trim().toLowerCase() === name);
}

/**
 * Split a chat line into a command, or null if it is not one.
 *
 * Pure, so the parsing rules can be tested without a socket.
 */
export function parse(text, prefix = '.') {
  const raw = String(text ?? '').trim();
  if (!prefix || !raw.startsWith(prefix)) return null;

  const body = raw.slice(prefix.length).trim();
  if (!body) return null;

  const [name, ...args] = body.split(/\s+/);
  return { name: name.toLowerCase(), args };
}

// ------------------------------------------------------------------ commands

/** Send a private line back to whoever asked, if the server will take it. */
function reply(bot, username, text) {
  try {
    bot.whisper(String(username), String(text).slice(0, whisperBudget(username)));
  } catch {
    // A server that refuses whispers is not a reason to fail the command.
  }
}

/** The player's entity, which is what pathfinding actually needs. */
function entityOf(bot, username) {
  const player = bot.players?.[username];
  return player?.entity ?? null;
}

const COMMANDS = {
  help: {
    usage: 'help',
    summary: 'List what this bot can do, here in flora',
    // Answered in the app rather than in server chat. See the note at the top.
    local: true,
    run(bot, args, ctx) {
      ctx.log('command', `Commands ${bot.username} accepts, as typed in server chat:`);
      for (const entry of commandHelp(ctx.prefix)) {
        // Addon commands are marked, because "which of these came with flora"
        // is the first question someone asks when a command they did not
        // install turns up in the list.
        const from = entry.addon ? `  [${entry.addon}]` : '';
        ctx.log('command', `${entry.usage}  ${entry.summary}${from}`);
      }
    }
  },

  say: {
    usage: 'say <text>',
    summary: 'Make the bot repeat something',
    run(bot, args, ctx) {
      const text = args.join(' ').replace(/[\r\n]+/g, ' ').trim();
      if (!text) return reply(bot, ctx.username, `Usage: ${ctx.prefix}say <text>`);
      bot.chat(text.slice(0, CHAT_LIMIT));
    }
  },

  come: {
    usage: 'come',
    summary: 'Walk to whoever asked',
    run(bot, args, ctx) {
      if (!bot.pathfinder) return reply(bot, ctx.username, 'This bot has no pathfinder loaded.');
      const entity = entityOf(bot, ctx.username);
      if (!entity) return reply(bot, ctx.username, 'I cannot see you yet - move closer.');

      const { x, y, z } = entity.position;
      bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, COME_RANGE));
      reply(bot, ctx.username, 'On my way.');
    }
  },

  follow: {
    usage: 'follow',
    summary: 'Follow whoever asked until told to stop',
    run(bot, args, ctx) {
      if (!bot.pathfinder) return reply(bot, ctx.username, 'This bot has no pathfinder loaded.');
      const entity = entityOf(bot, ctx.username);
      if (!entity) return reply(bot, ctx.username, 'I cannot see you yet - move closer.');

      // `true` makes the goal dynamic, so it tracks the player rather than
      // aiming at wherever they happened to be when the command was sent.
      bot.pathfinder.setGoal(new goals.GoalFollow(entity, FOLLOW_RANGE), true);
      reply(bot, ctx.username, 'Following you.');
    }
  },

  stop: {
    usage: 'stop',
    summary: 'Stop moving',
    run(bot, args, ctx) {
      if (!bot.pathfinder) return reply(bot, ctx.username, 'This bot has no pathfinder loaded.');
      bot.pathfinder.setGoal(null);
      reply(bot, ctx.username, 'Stopped.');
    }
  },

  status: {
    usage: 'status',
    summary: 'Health, food and where the bot is',
    run(bot, args, ctx) {
      const { x, y, z } = bot.entity?.position ?? {};
      const where = Number.isFinite(x)
        ? `${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}`
        : 'nowhere yet';
      reply(
        bot,
        ctx.username,
        `flora bot ${bot.username} on ${ctx.server ?? 'unknown'} - ` +
        `health ${Math.round(bot.health ?? 0)}/20, food ${Math.round(bot.food ?? 0)}/20, at ${where}.`
      );
    }
  }
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

// Told to the addon registry at load, so it can refuse an addon command that
// would shadow a built-in. One direction only - the registry never imports
// this file - which is what keeps the two from becoming a cycle.
setReservedCommands(COMMAND_NAMES);

/**
 * Every command, in the form the UI and the in-console listing both render.
 *
 * One source of truth on purpose: a help screen that is written out separately
 * from the dispatcher is a help screen that eventually lists a command that was
 * renamed, or misses one that was added.
 */
export function commandHelp(prefix = getSetting('bots.chatPrefix') || '.') {
  const builtIn = Object.entries(COMMANDS).map(([name, command]) => ({
    name,
    usage: `${prefix}${command.usage}`,
    summary: command.summary,
    // Where the answer appears: in flora's console, or in server chat.
    local: Boolean(command.local)
  }));

  // Addon commands are listed alongside the built-ins rather than under a
  // heading of their own. From the person typing `.help` in chat there is one
  // set of things this bot answers to, and splitting the list would make them
  // look up two places to find out what that set is.
  return [...builtIn, ...addonHelp(prefix)].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Run one chat line against one bot.
 *
 * Returns what happened, which is what the tests assert on: 'ignored' for
 * ordinary chat, 'disabled' or 'denied' for the two ways a command can be
 * turned away, 'unknown' for a name that is not a command, and 'ran'. A 'ran'
 * carries `local: true` when the bot answered in flora rather than in chat.
 */
export function handle(bot, record, { username, message, log = () => {} }) {
  const prefix = getSetting('bots.chatPrefix') || '.';
  const parsed = parse(message, prefix);
  if (!parsed) return { outcome: 'ignored' };

  // Off entirely. Silently, because a server where nobody has switched this on
  // should not have its chat answered by a bot that is not listening.
  if (!getSetting('whitelist.enabled')) return { outcome: 'disabled' };

  if (!isWhitelisted(username, getSetting('whitelist.players'))) {
    reply(bot, username, 'flora: you are not on this bot\'s whitelist.');
    log('warn', `Refused ${prefix}${parsed.name} from ${username} - not whitelisted.`);
    return { outcome: 'denied', username };
  }

  // An addon command is looked up only when no built-in has the name, and the
  // registry refuses to register one that shadows a built-in, so the order here
  // is belt and braces rather than the actual guard.
  const command = COMMANDS[parsed.name] ?? addonCommand(parsed.name);
  if (!command) {
    reply(bot, username, `flora: no such command. Try ${prefix}help`);
    return { outcome: 'unknown', name: parsed.name };
  }

  const addon = COMMANDS[parsed.name] ? null : addonFor(parsed.name);

  // Logged before running, not after, so the console reads as the request and
  // then whatever it produced - which matters for `help`, whose whole output is
  // the lines that follow this one.
  log('command', `${username} ran ${prefix}${parsed.name}${addon ? ` (${addon.name})` : ''}`);

  try {
    command.run(bot, parsed.args, { ...record, username, prefix, log });
    return { outcome: 'ran', name: parsed.name, username, local: Boolean(command.local), addon: addon?.name ?? null };
  } catch (err) {
    log('error', `${prefix}${parsed.name} failed: ${err.message}`);
    reply(bot, username, `flora: that failed - ${err.message}`);
    return { outcome: 'failed', name: parsed.name, error: err.message, addon: addon?.name ?? null };
  }
}
