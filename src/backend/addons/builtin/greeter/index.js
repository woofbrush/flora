/**
 * Greeter.
 *
 * Waves at players who come near a bot. It exists as an addon rather than a core
 * feature because "does this bot feel alive" is a taste, not a setting: some
 * people want their accounts to look like people, and some want them silent.
 *
 * It is also the worked example of the one thing the event API cannot cover.
 * flora has no `player joined` event of its own, because the only thing worth
 * doing with one is deciding whether the newcomer is close enough to matter, and
 * that needs the bot's own world. So this addon takes the bot out of `bot:spawn`
 * and hangs its own listener on it, then takes it back off in `deactivate`.
 * That teardown is not optional: a listener left on a mineflayer bot outlives
 * the addon that added it, and the bot would keep saying hello on behalf of a
 * switched-off addon.
 */

/** Bots this addon is listening to, so `deactivate` can let go of every one. */
const watching = new Map();

flora.settings.define({
  message: {
    type: 'string',
    label: 'Greeting',
    help: 'What the bot says. {player} is replaced with their name.',
    default: 'Welcome, {player}!'
  },
  radius: {
    type: 'number',
    label: 'Greeting distance',
    help: 'How close a player has to be, in blocks.',
    default: 16,
    min: 2,
    max: 128
  },
  whisper: {
    type: 'bool',
    label: 'Whisper instead of talking',
    help: 'A whisper is seen only by the player it is meant for. Useful on a busy server.',
    default: false
  }
});

/**
 * Greet one player, if they are close enough and have not been greeted already.
 *
 * `greeted` is passed in rather than held here because the two ways into this -
 * a join event and the sweep for players who were already around - have to share
 * one set, or a player who joins just before the sweep is greeted twice.
 *
 * A player who is too far away is deliberately left unmarked: they may walk
 * closer, and the greeting is for arriving, not for existing.
 */
function greet(bot, accountId, player, greeted) {
  const name = player && player.username;
  if (!name || name === bot.username || greeted.has(name)) return false;

  // A player with no entity is in the tab list but not in the world, which is
  // the difference between "online" and "here".
  const here = bot.entity && bot.entity.position;
  const there = player.entity && player.entity.position;
  if (!here || !there) return false;
  if (here.distanceTo(there) > flora.settings.get('radius')) return false;

  greeted.add(name);

  const text = String(flora.settings.get('message') ?? '').replace('{player}', name);
  if (text.trim()) {
    if (flora.settings.get('whisper')) flora.bots.whisper(accountId, name, text);
    else flora.bots.chat(accountId, text);
  }
  return true;
}

function watch(accountId, bot) {
  if (!bot || watching.has(accountId)) return;

  // Once per player per session. Without this, a player walking in and out of
  // range is greeted every time they cross the line, which reads as a bug to
  // everyone standing nearby.
  const greeted = new Set();

  const onJoin = (player) => {
    // A player spawns a moment after they join, so at the instant of the event
    // their entity is usually still missing and there is no distance to measure.
    // Giving them a beat to appear is what makes the radius work at all.
    flora.after(750, () => greet(bot, accountId, player, greeted));
  };

  bot.on('playerJoined', onJoin);
  watching.set(accountId, { bot, onJoin });

  // A player who was already here when the bot arrived never fires
  // `playerJoined`, so the ones in range are greeted on the way in instead.
  flora.after(1500, () => {
    for (const player of Object.values(bot.players ?? {})) greet(bot, accountId, player, greeted);
  });
}

function unwatch(accountId) {
  const entry = watching.get(accountId);
  if (!entry) return;
  try { entry.bot.removeListener('playerJoined', entry.onJoin); } catch { /* already gone */ }
  watching.delete(accountId);
}

flora.on('bot:spawn', (event) => watch(event.accountId, event.bot));
flora.on('bot:end', (event) => unwatch(event.accountId));

function deactivate() {
  for (const accountId of [...watching.keys()]) unwatch(accountId);
}

flora.log('Greeter ready.');
