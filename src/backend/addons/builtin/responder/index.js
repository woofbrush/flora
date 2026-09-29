/**
 * Responder.
 *
 * The bot answers when someone says one of your words. It ships enabled and does
 * nothing at all until a keyword is filled in, which is deliberate: a bot that
 * replies is the fastest way to get an account muted, so the switch is on but
 * the trigger list starts empty.
 *
 * It is the worked example of the chat path. `bot:chat` carries a player's line
 * with the sender already separated out, and the reply goes back out through
 * `flora.bots.chat` rather than through the bot object, so it passes the same
 * rate limiting and logging as anything else flora sends.
 */

/**
 * When each bot last replied.
 *
 * Keyed by account and then by player: a keyword that four people say at once
 * should get one answer per person, not four answers from one person and none
 * for the rest.
 */
const lastReply = new Map();

flora.settings.define({
  keywords: {
    type: 'string',
    label: 'Keywords',
    help: 'Comma-separated. The bot replies when a chat line contains one. Leave empty to do nothing.',
    default: ''
  },
  reply: {
    type: 'string',
    label: 'Reply',
    help: 'What it says back. {player} is their name, {word} is what they said.',
    default: '{player}, one moment.'
  },
  cooldown: {
    type: 'number',
    label: 'Cooldown',
    help: 'Seconds before the same player can be answered again.',
    default: 30,
    min: 0,
    max: 3600
  },
  caseSensitive: {
    type: 'bool',
    label: 'Match case',
    help: 'Off means "Hello" and "hello" both count.',
    default: false
  }
});

/** The keyword list, cleaned up, as the settings store it and as matching wants it. */
function keywords() {
  const raw = String(flora.settings.get('keywords') ?? '');
  return raw.split(',')
    .map((word) => word.trim())
    .filter(Boolean);
}

/**
 * The word this line contains, or null.
 *
 * A whole-word test rather than a substring, so a keyword of "hi" does not fire
 * on "this" or "thing" - which is the difference between an addon somebody keeps
 * and one they switch off after five minutes.
 */
function match(message) {
  const words = keywords();
  if (!words.length) return null;

  const sensitive = flora.settings.get('caseSensitive');
  const haystack = sensitive ? message : message.toLowerCase();

  for (const word of words) {
    const needle = sensitive ? word : word.toLowerCase();
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `\b` is not enough on its own: it treats an underscore as a word
    // character, so "hi" would not match "hi_there" but "hi5" would match.
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}([^\\p{L}\\p{N}_]|$)`, 'u').test(haystack)) return word;
  }
  return null;
}

flora.on('bot:chat', (event) => {
  const { accountId, username, message } = event;
  if (!username || !message) return;

  const word = match(message);
  if (!word) return;

  const cooldown = Number(flora.settings.get('cooldown')) * 1000;
  const now = Date.now();
  const seen = lastReply.get(accountId) ?? new Map();
  lastReply.set(accountId, seen);

  const at = seen.get(username) ?? 0;
  if (now - at < cooldown) return;
  seen.set(username, now);

  const text = String(flora.settings.get('reply') ?? '')
    .replace('{player}', username)
    .replace('{word}', word);

  if (text.trim()) flora.bots.chat(accountId, text);
});

flora.on('bot:end', (event) => lastReply.delete(event.accountId));

function deactivate() {
  lastReply.clear();
}

flora.log('Responder ready. No keywords set, so it will stay quiet.');
