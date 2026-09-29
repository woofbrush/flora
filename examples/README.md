# Addon examples

An addon is a folder with an `addon.json` and an `index.js` in it. Drop the
folder into flora's addons directory, turn it on in **Settings > Addons**, and
whatever it registers is available to every bot straight away.

```
%APPDATA%\flora\data\addons\
  playtime\
    addon.json
    index.js
```

The addons directory is `addons\` inside your data folder. If you run the
portable build with a `flora-data` folder beside the `.exe`, it is there
instead. The paths are listed under **Where your data lives** in the main
README.

## playtime

The example is a working addon that remembers how long each account has been
connected, keeps that total across restarts, and answers a `playtime` command.

To try it, copy `playtime` into the addons directory and switch it on. The
command is answered by whichever bot is asked, so it needs at least one account
connected and your username on the whitelist.

It is deliberately small, and it is not clever. Its value is that it uses each
part of the API exactly once, so it can be read in one sitting:

| What it uses | Where | What it is for |
| --- | --- | --- |
| `flora.commands.register` | the command at the bottom | Adding a command the bot answers to |
| `flora.settings.define` | at the top | Two settings that appear in the Addons pane |
| `flora.on('bot:spawn')` | the sessions section | Starting a timer when a bot connects |
| `flora.on('bot:end')` | the sessions section | Stopping it when the bot disconnects |
| `flora.store` | the storage section | Data that survives a restart |
| `deactivate` | at the very bottom | Cleaning up when the addon is switched off |

`deactivate` is the one worth reading twice. A bot that is connected when the
addon is switched off never fires `bot:end`, because its listener has already
been removed, so the session would be lost. Anything you start, stop there.

## Writing your own

**Settings > Addons > Copy the Claude prompt** puts a complete description of
the API on your clipboard, including the manifest fields, the event names and
the rules. Paste it into an assistant along with what you want the addon to do,
drop the folder it gives you into the addons directory, and turn it on.

Three addons ship with flora and are ordinary addons reading the same folder,
so they can be turned off or read as further examples. `src/backend/addons/builtin`
in this repository holds their source.
