<picture>
  <source media="(prefers-color-scheme: dark)" srcset="src/renderer/assets/logo/flora-lockup.svg">
  <img src=".github/assets/flora-lockup-light.svg" alt="flora" width="400">
</picture>

flora is a Windows desktop app for managing Minecraft accounts and running bots.
It keeps a list of accounts, tests and refreshes their credentials, applies skins
in bulk, and connects any number of them to a server through
[mineflayer](https://github.com/PrismarineJS/mineflayer), directly or through a
pool of proxies. It is built by
[Woofbrush Design LLC](https://woofbrush.com).

flora is not a launcher. It does not download or start Minecraft, and it does not
give you the game. It manages accounts and connections, and nothing else.

[![Licence: MIT](https://img.shields.io/badge/licence-MIT-9333EA)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-9333EA)](#install)
[![Node: 22.5+](https://img.shields.io/badge/node-22.5%2B-9333EA)](#building-from-source)
[![Tests](https://img.shields.io/badge/tests-254%20passing-9333EA)](#building-from-source)

<img src=".github/assets/screens/01-home.png" alt="flora's home screen, showing accounts, bots and proxies at a glance">

> **flora is not affiliated with Mojang Studios or Microsoft.** It is an
> independent tool. "Minecraft" is a trademark of Mojang Synergies AB. See the
> [LICENSE](LICENSE) for the full statement.

## What it does

- **Accounts.** Import a plain text or JSON file, or sign in with Microsoft.
  Check credentials in bulk, see which ones still work, and keep them grouped
  with tags.
- **Skins.** Apply a PNG to a selection of accounts, change the model, or reset
  to the default. Heads are cached locally so lists render instantly.
- **Bots.** Connect accounts to a server with the pathfinder and PvP plugins
  loaded. Auto-reconnect, anti-AFK, per-account consoles and a command bar.
- **Proxies.** Paste a list, have each entry checked, then assign them to
  accounts by keeping, rotating or randomising.
- **Addons.** Extend what bots can do without rebuilding the app. See
  [Addons](#addons).
- **No telemetry.** Nothing is sent anywhere except the Mojang and Microsoft
  requests an account of yours actually needs. See [Privacy](#privacy).

## Screens

<table>
  <tr>
    <td width="50%"><img src=".github/assets/screens/02-accounts.png" alt="The accounts list, with tags, test results and per-account actions"></td>
    <td width="50%"><img src=".github/assets/screens/03-bots.png" alt="The bots view, with live connection state and a per-bot console"></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screens/04-proxies.png" alt="The proxies view, showing checked entries and their latency"></td>
    <td width="50%"><img src=".github/assets/screens/05-activity.png" alt="The activity log, filtered by scope and level"></td>
  </tr>
  <tr>
    <td width="50%"><img src=".github/assets/screens/06-addons.png" alt="The Addons settings pane, with the master switch and the three built-in addons"></td>
    <td width="50%"><img src=".github/assets/screens/07-discord.png" alt="The Discord settings pane, showing the Rich Presence switch and status"></td>
  </tr>
</table>

## Install

Two builds are published for Windows, and they hold the same application:

- **`flora-plus-<version>.exe`** is an installer. It asks where to put flora,
  creates Start menu and desktop shortcuts, and shows the licence before it
  copies anything. Uninstalling it leaves your data alone, so reinstalling finds
  every account where you left it.
- **`flora-plus-<version>-portable.exe`** is a single file that runs without
  installing. Useful from a USB stick or a locked-down machine.

The portable build looks for a folder called `flora-data` next to the `.exe`. If
that folder exists, flora keeps everything inside it (accounts, settings, skins,
logs) and nothing is written to `%APPDATA%`. If it does not exist, the portable
build behaves like the installed one. Creating that folder by hand is all it
takes to make a portable copy genuinely self-contained.

flora runs one copy at a time. Launching it again brings the existing window to
the front instead of opening a second one.

The builds are unsigned, so Windows SmartScreen will warn you the first time you
run one. Choose **More info** then **Run anyway**, or build it yourself from
source if you would rather not take that on trust.

## First run

The first launch walks you through the app in seven short steps: what flora is
for, how to pick a theme, how to get accounts in, how the bot controls work, how
to start a bot, how to talk to one, and where to find everything afterwards. It
takes about a minute and every step can be skipped.

<img src=".github/assets/screens/08-setup.png" alt="The first step of flora's setup, asking what to call you">

If you skip it, or want it back, open **Settings**, stay on the **General**
pane, and choose **Run setup again** from the menu in that pane's header.

## Account formats

flora imports a plain `.txt` or `.json` file. Importing does not write anything
until you confirm the preview, which reports how many lines are usable, how many
are duplicates and how many cannot be read.

### Text files

One account per line. Blank lines are skipped, and a line starting with `#` or
`//` is a comment. A separator may be `:`, `|`, a tab or a single space, and they
mean the same thing, so a column pasted out of a spreadsheet works without
editing.

| Format | Example | What flora stores |
| --- | --- | --- |
| `username` | `Notch` | Offline account |
| `email:password` | `alice@example.com:hunter2` | Offline account with a password |
| `username:password:uuid` | `Notch:hunter2:069a79f444e94726a5befca90e38aaf5` | Offline account, UUID pinned |
| `email:accesstoken` | `alice@example.com:eyJraWQiOi...` | Microsoft account, token stored |
| `accesstoken` | `eyJraWQiOi...` | Microsoft account, token stored |
| `uuid:username` | `069a79f444e94726a5befca90e38aaf5:Notch` | Offline account, UUID pinned |

UUIDs are stored without dashes, so `069a79f4-44e9-4726-a5be-fca90e38aaf5` and
`069a79f444e94726a5befca90e38aaf5` are the same account.

### How flora tells a token from a password

The third column, when there is one, is read as a UUID if it looks like one. The
second column is read as an access token if it starts with `eyJ`, because every
Microsoft token is a JWT and no password is. Everything else is treated as a
password for an offline account. A line with an email address and a
non-JWT second column is read as an offline account with that email as the
username, which is usually what someone pasting a leaked combo list means.

### JSON files

Either an array of objects or an object with an `accounts` array. These keys are
recognised, and unknown keys are ignored:

| Key | Meaning |
| --- | --- |
| `username`, `name`, `email` | The account name |
| `password`, `pass` | A password, for offline accounts |
| `token`, `accessToken`, `access_token` | A Microsoft access token |
| `uuid`, `id` | A UUID, with or without dashes |
| `kind`, `type` | `msa`, `token` or `offline`, to force the interpretation |
| `label`, `note`, `notes` | Free text attached to the account |
| `tags` | A comma separated list, an array, or a single string |

### Duplicates and limits

An account is a duplicate when its token fingerprint, or its username for an
offline account, is already in the list. Duplicates are reported and skipped
rather than overwritten, so importing the same file twice is harmless.

A single import is capped at 5000 lines. Past that the preview refuses rather
than opening a dialog that will take minutes to finish.

### What flora will not do

flora does not crack passwords, does not generate accounts, and does not check an
offline account's password against a server. A password is stored because
offline-mode servers ask for one, and for no other reason.

## Adding accounts

**Sign in with Microsoft** opens the device code flow. flora shows a code and a
link, you enter the code in a browser, and the account appears with a refresh
token that flora can renew on its own. This is the only way to get an account
that can sign chat or own a skin.

**Import a file** takes a `.txt` or `.json` file as described above.

Either way, nothing is written until you confirm the preview.

## Skins

Select accounts, then **Skins**, then drop in a PNG. flora can apply the same
skin to the whole selection or walk a folder of them, one per account, in
order. Every account gets its own result, so a partial failure is reported as a
partial failure rather than being hidden.

**A skin needs a real Microsoft account.** Offline-mode accounts cannot have one,
because there is no account on Mojang's side to attach it to. flora says so up
front rather than letting the upload fail. An offline account that has a UUID can
still have its head fetched, since textures are readable for any UUID.

The **Default skin model** setting (classic or slim) decides which model is used
when a PNG does not declare its own.

## Bots

flora connects bots with [mineflayer](https://github.com/PrismarineJS/mineflayer),
with the pathfinder and PvP plugins loaded. A bot is keyed by account *and*
server, so the same account can be connected to several servers at once, and the
account list shows the first live connection.

Bots run on real vanilla physics. flora does not cancel movement packets, does
not swallow server packets and does not hold a position the server did not send.
A bot moves because the server moved it, gets knocked back when it is hit, and
can be teleported, pushed or corrected like any other client. That costs more
CPU than a frozen bot would, and it is the reason bots behave normally on
servers that check.

What each account kind connects with:

- **Microsoft**: mineflayer's own Microsoft auth, using the refresh token flora
  stored. This is the only kind that gets chat-signing certificates, so it is the
  only kind that can sign chat on 1.19 and later.
- **Token**: the stored access token is handed to mineflayer directly. No
  certificates, so chat signing is off.
- **Offline**: `auth: 'offline'`, a plain username, for servers with
  `online-mode=false`.

Other behaviour worth knowing:

- **Version** defaults to `auto`, which lets the server's ping decide. Set a
  version explicitly if a server reports one that mineflayer guesses wrongly.
- **Auto-reconnect** is on by default. flora backs off as attempts pile up, up to
  two minutes between tries, and with the default settings keeps trying forever.
  Set a limit if you would rather it gave up.
- **Anti-AFK** is off by default. When on, a bot nudges its view and hops on an
  interval, which is enough to defeat an idle timer without looking like real
  movement.
- **Maximum bots online** defaults to 12. Each bot costs CPU, and a few dozen at
  once will make themselves felt.
- **Closing flora disconnects every bot.** The bot connections live in the app's
  own process, so quitting stops them all cleanly. If you want bots to keep
  running after you close the window, turn on *Keep running when the window is
  closed* in Settings. The tray icon and Ctrl+Q then become the way out.
- Bot state is stored in the database, and any row that still said "online" when
  flora was last killed is reset to offline on the next start. Nothing ever
  pretends to be connected when it is not.

## Proxies

Proxy support is **off by default**. With it off, every bot connects directly and
nothing on the Proxies screen is consulted.

Paste a list, one entry per line. These formats are accepted:

```
host:port
host:port:user:pass
user:pass@host:port
scheme://user:pass@host:port
host port user pass
```

`scheme://` may be `socks5`, `socks5h`, `socks4`, `socks4a`, `http` or `https`.
`socks5h` is read as socks5 and `socks4a` as socks4, since the difference is in
how the name is resolved and flora resolves it itself. Anything without a scheme
is stored as socks5 unless you pass a different default. Blank lines, and lines
starting with `#` or `//`, are ignored, so a list copied off a provider's page
with its headings still imports.

Ports must be between 1 and 65535. Lines that repeat an entry already in the same
paste are reported rather than imported twice. Each imported proxy is checked
individually, and a failed check records the reason against that row.

Once proxies are enabled, three assignment modes decide which account uses which:

- **Preferred** keeps an account on the proxy it was assigned, and only moves it
  if that proxy leaves the pool.
- **Rotate** walks the list, handing each new bot the least-used proxy.
- **Random** picks for each connection.

Assigning proxies to a selection wraps around when there are more accounts than
proxies, so a pool of ten covers a hundred accounts.

A check opens a TCP connection to `api.minecraftservices.com:443` through the
proxy, a Minecraft endpoint, because that is the thing that actually has to
work. A proxy that blocks the game's ports should not pass.

Note that proxy credentials are stored in the clear, unlike account tokens. That
is deliberate: a proxy login is not a Microsoft credential, it is usually shared
across a whole pool, and encrypting it would mean you could not read back a list
you pasted in yourself. It is still inside your own data directory.

## Addons

An addon teaches the bots new commands. Drop a folder into the addons directory,
turn it on in **Settings > Addons**, and its commands are available to every bot
straight away.

```
%APPDATA%\flora\data\addons\
  my-addon\
    addon.json
    index.js
```

`addon.json` names the addon and points at its entry file:

```json
{
  "id": "my-addon",
  "name": "My Addon",
  "version": "1.0.0",
  "description": "What it does, in one line.",
  "author": "you",
  "api": 1,
  "main": "index.js"
}
```

The `id` has to be lowercase letters, digits and dashes, because it becomes a
folder name, a storage file name and a command namespace. A manifest that fails
to validate is refused with a sentence naming the field, rather than loading
halfway.

`index.js` is plain JavaScript with one argument, `flora`:

```js
export function setup(flora) {
  flora.commands.register('greet', {
    description: 'Say hello to whoever is nearby',
    run: ({ bot, args }) => {
      bot.chat(`Hello ${args[0] ?? 'world'}`);
    }
  });

  flora.on('bot:chat', ({ bot, username, message }) => {
    if (message === 'hi') bot.chat(`Hi ${username}`);
  });

  // Anything you schedule is cleaned up when the addon is switched off.
  flora.every(60000, () => flora.log('still here'));

  return () => flora.log('goodbye');
}
```

The surface is deliberately small:

| | |
| --- | --- |
| `flora.commands.register(name, spec)` | Add a command. `unregister` and `list` are there too. |
| `flora.on(event, handler)` | Listen for `bot:login`, `bot:spawn`, `bot:chat`, `bot:message`, `bot:kicked`, `bot:error`, `bot:end`. |
| `flora.bots` | `list`, `get`, `online`, plus `chat`, `whisper`, `command` and `log` to drive a bot. |
| `flora.store` | A small JSON file of your own, with `get`, `set`, `delete` and `all`. |
| `flora.settings` | Declare settings and they appear in the Addons pane with a real control. |
| `flora.every(ms, fn)` / `flora.after(ms, fn)` | Timers that are cleared when the addon stops. |
| `flora.log` / `warn` / `error` | Goes to flora's own log, tagged with the addon name. |

There is no Node in there. An addon runs in a `node:vm` context with no
`require`, no `process`, no filesystem and no network, and code generation is
switched off so it cannot reach any of them. The only way out is the `flora`
object, and everything it exposes is scoped to the addon that called it: your
storage is your own file, your timers die with the addon, and your commands
disappear when it is switched off. An addon that throws is caught and logged
against its own name, and never takes the app or another addon down with it.

### Built in

Three addons ship with flora and are on by default. They are ordinary addons,
reading the same folder as yours, so you can turn them off or read them as
worked examples.

| Addon | Commands |
| --- | --- |
| **Essentials** | `.where`, `.who`, `.clock`, `.ping` |
| **Greeter** | Greets players who come within range, with a configurable message and delay |
| **Responder** | Replies when a message matches one of your keywords |

### Writing one with an assistant

**Settings > Addons > Copy the Claude prompt** puts a prompt on your clipboard
that describes the whole API, the manifest format, the events and the rules, and
asks for an addon implementing whatever you have in mind. Paste it into Claude or
any other assistant, drop the folder it gives you into the addons directory, and
turn it on.

### Sound files

An addon can play audio. Drop `.ogg`, `.oga`, `.mp3`, `.wav`, `.m4a` or `.flac`
files into `%APPDATA%\flora\data\addon-data\voice-chat\` and an addon that plays
audio can reference them by name. Decoding happens inside the app through
Chromium's own audio decoders, so there is no ffmpeg to install and nothing extra
to ship.

## Discord

flora can put a line on your Discord profile saying how many bots are running.
It is **off by default**.

Turn on **Settings > Discord > Show what flora is doing in Discord** and the
presence attaches to the Discord client on the same machine. If Discord is not
running, flora waits and quietly retries; opening Discord later connects within a
few seconds, and quitting flora clears the line.

Nothing about your accounts leaves the machine. The presence carries a bot count
and how long flora has been open, and that is all. No usernames, no server
addresses and no tokens are ever included.

The application ID field is there if you would rather the profile showed an
application of your own. Leave it as it is to use flora's.

There are also links to the [flora Discord](https://discord.gg/zbAH77TECp) in
the title bar and in the same settings pane.

## Where your data lives

Everything flora writes lives under one folder:

```
%APPDATA%\flora\data\
  flora.db          accounts, proxies, settings, bot state
  secret.key        the AES key your account tokens are sealed with
  prefs.json        window and tray preferences the main process needs early
  addons\           addons you have installed
  addon-data\       one folder per addon, for whatever it wants to keep
  auth-cache\       one folder per Microsoft account, holding its refresh token
  heads\            cached player heads
  skins\            cached skin PNGs, named by content hash
  logs\             daily rotated logs
  backups\          copies of the database taken before destructive operations
```

The portable build uses `flora-data` beside the `.exe` instead, when that folder
exists. Setting the `FLORA_DATA_DIR` environment variable overrides both.

**`secret.key` matters.** Access tokens and passwords are encrypted with
AES-256-GCM under a key that is generated on first run and stored only in that
file, never in the database. A copy of `flora.db` on its own is useless: without
the key nothing in it can be read. Keep it with your backups, and do not share
it, because anyone who has both the database and the key has your accounts.

**Nothing is uploaded anywhere.** flora has no cloud service, no sync, no account
of its own, and no analytics. The database never leaves your machine unless you
copy it there.

## Privacy

flora collects no telemetry, sends no crash reports, and checks for updates
nowhere. The only outbound requests it makes are:

- to **Microsoft** during the device-code sign-in, and to refresh an existing
  sign-in;
- to **`api.minecraftservices.com`** to check a token and to upload or reset a
  skin;
- to **`sessionserver.mojang.com`** to look up a profile by UUID;
- to **`textures.minecraft.net`** to fetch a skin image.

Those requests are made on behalf of the accounts you added and for no other
purpose. There is no HTTP server inside flora at all (the interface and the
backend talk over Electron's IPC) and the app's content security policy forbids
loading anything from a remote origin.

## Troubleshooting

| Symptom | What it means | What to do |
| --- | --- | --- |
| "This account has no usable credential" | A token account whose token has expired, and which cannot renew itself | Add it again with a fresh token, or use Sign in with Microsoft so it can renew |
| "This account has no username yet" | A token was added without verification, so flora never learned the profile | Use **Check** on the account once, then start the bot |
| A bot disconnects immediately after starting | Wrong version, wrong port, or the server rejected the login | Check the account's console, where the kick reason is recorded |
| Applying a skin fails | The account is offline-mode | Use a real Microsoft account; offline accounts cannot own skins |
| Microsoft sign-in never completes | The device code expired before it was entered | Start the sign-in again and enter the new code |
| "Microsoft needs you to sign in again" | The stored refresh token is gone or was revoked | Delete the account and sign it in again |
| "secret.key is corrupt (expected 32 bytes...)" | The key file was truncated or overwritten | Restore it from a backup. Without the original key, stored tokens cannot be recovered |
| Bots stop when the window closes | That is the default | Turn on *Keep running when the window is closed* in Settings, then quit from the tray icon |
| Proxy checks all fail | The check dials `api.minecraftservices.com:443` | Confirm the proxy allows that host and port, and that the credentials are right |
| Every line of an import is a duplicate | The file was imported before | Nothing is wrong; duplicates are skipped rather than re-added |
| An addon does not appear | Its manifest failed to validate, or the folder is in the wrong place | Check the message beside the addons list; it names the field that was wrong |

## Building from source

Requires Node 22.5 or newer. The database uses `node:sqlite`, which ships with
the Node runtime Electron embeds, and that is why there is no native module to
compile and nothing to rebuild per Electron version.

```bash
npm install        # dependencies, including Electron and electron-builder
npm run icons      # render build/icon.png and build/tray.png from the SVG mark
npm run preflight  # check the tree is complete and contains no secrets
npm test           # unit tests for the pure parts of the backend and UI
npm run dist       # build the NSIS installer and the portable .exe into dist/
```

`npm start` runs the app from source; `npm run dev` does the same with the
development flag set.

`npm run icons` uses the Electron that is already installed to rasterise
`src/renderer/assets/logo/flora-mark.svg`, so there is no image toolchain to
install. `npm run preflight` is worth running before any release: it verifies the
Node version, the dependencies, that every source file parses, that the renderer's
files are all present, that no key or database file has been committed, and that
nothing in the source opens a listening socket.

## Contributing

Issues and pull requests are welcome at
<https://github.com/woofbrush/flora>. The tests are plain `node --test` with no
framework, and `npm run preflight` is the same check CI would run, so running
those two is enough to know a change is sound.

## Licence

flora is released under the [MIT licence](LICENSE).

It is not affiliated with, endorsed by or associated with Mojang Studios, Mojang
Synergies AB or Microsoft Corporation. "Minecraft" is a trademark of Mojang
Synergies AB. flora does not distribute, download or modify the game, and it
grants no rights to any Mojang or Microsoft property.

Build bots for servers where you have permission to do so. That is a rule in the
licence's spirit and, more practically, the fastest way to get banned from
somewhere you wanted to be.
