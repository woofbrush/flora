/**
 * Essentials.
 *
 * The four questions someone standing next to a bot in game actually asks it.
 * They are here rather than in the built-in command table because they are
 * exactly what an addon is for: small, self-contained, and the sort of thing a
 * person might reasonably want to switch off.
 *
 * It doubles as the worked example. Everything the addon API offers that is not
 * a bot event is used once here - a command with arguments, a command with no
 * arguments, a declared setting, and a piece of stored state - so someone
 * writing their own has a file in front of them rather than a list of methods.
 */

/** Minecraft runs a 24000-tick day, and the clock starts at 06:00. */
function clock(tick) {
  if (!Number.isFinite(tick)) return 'unknown';
  const hours = Math.floor(((tick / 1000) + 6) % 24);
  const minutes = Math.floor((tick % 1000) / 1000 * 60);
  return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
}

/** Whatever the bot is standing next to, described the way a player would. */
function describeSurroundings(bot) {
  const position = bot.entity && bot.entity.position;
  if (!position) return 'nowhere yet';

  const block = bot.blockAt(position.offset(0, -1, 0));
  const on = block && block.name && block.name !== 'air'
    ? block.name.replace(/_/g, ' ')
    : 'nothing';
  return Math.round(position.x) + ', ' + Math.round(position.y) + ', ' + Math.round(position.z) + ' on ' + on;
}

flora.settings.define({
  radius: {
    type: 'number',
    label: 'Nearby radius',
    help: 'How far away a player can be and still count as nearby, in blocks.',
    default: 64,
    min: 8,
    max: 256
  }
});

flora.commands.register({
  name: 'where',
  usage: 'where',
  summary: 'Where the bot is, and what it is standing on',
  run(bot, args, ctx) {
    bot.whisper(ctx.username, bot.username + ' is at ' + describeSurroundings(bot) + '.');
  }
});

flora.commands.register({
  name: 'who',
  usage: 'who',
  summary: 'Which players are close by',
  run(bot, args, ctx) {
    const position = bot.entity && bot.entity.position;
    const radius = flora.settings.get('radius');
    const nearby = [];

    for (const name of Object.keys(bot.players || {})) {
      if (name === bot.username) continue;
      const entity = bot.players[name].entity;
      // A player in the tab list who is not in the world has no entity, which
      // is the difference between "online" and "here".
      if (!entity || !position) continue;
      if (entity.position.distanceTo(position) <= radius) nearby.push(name);
    }

    bot.whisper(ctx.username, nearby.length
      ? 'Nearby: ' + nearby.slice(0, 8).join(', ') + (nearby.length > 8 ? ' and ' + (nearby.length - 8) + ' more' : '')
      : 'Nobody within ' + radius + ' blocks.');
  }
});

flora.commands.register({
  name: 'clock',
  usage: 'clock',
  summary: 'The in-game time',
  run(bot, args, ctx) {
    const time = bot.time && bot.time.timeOfDay;
    bot.whisper(ctx.username, 'In game it is ' + clock(time) + '.');
  }
});

flora.commands.register({
  name: 'ping',
  usage: 'ping',
  summary: 'Round-trip time to the server',
  run(bot, args, ctx) {
    const player = bot.players && bot.players[ctx.username];
    if (!player || player.ping === undefined) {
      bot.whisper(ctx.username, 'I cannot measure that from here.');
      return;
    }
    bot.whisper(ctx.username, 'Your ping is ' + player.ping + 'ms.');
  }
});

/**
 * Remember the last bot that spawned, so `where` can answer for a bot that has
 * since disconnected. Small, but it is the one thing here that outlives the
 * connection, which is what makes it worth storing rather than holding.
 */
flora.on('bot:spawn', function (event) {
  flora.store.set('lastSpawn', { username: event.username, at: Date.now() });
});

flora.on('bot:end', function (event) {
  const last = flora.store.get('lastSpawn', null);
  if (last && last.username === event.username) {
    flora.log(event.username + ' disconnected. Last spawn was ' +
      Math.round((Date.now() - last.at) / 1000) + 's ago.');
  }
});

flora.log('Essentials ready: where, who, clock, ping.');
