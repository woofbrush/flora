/**
 * The reference dialogs.
 *
 * Both lists are fetched from the backend rather than written here, so neither
 * can describe something the app does not actually accept.
 */
import { h, fill } from '../dom.js';
import { icon, hydrate } from '../icons.js';
import * as bridge from '../bridge.js';
import * as toast from '../components/toast.js';
import { modal } from '../components/overlay.js';

/**
 * What the bots can be told to do.
 *
 * One audience: someone standing next to a bot in game. That is the only place
 * these can be typed, because a bot ignores its own chat and so a command sent
 * from flora's own console would be answered by nobody - the subtitle says so
 * rather than leaving it to be discovered.
 *
 * The list itself is fetched from the dispatcher, so it cannot describe a
 * command that does not exist or miss one that was added.
 */
export async function openBotCommands() {
  const dialog = modal({
    title: 'Bot commands',
    subtitle: 'Typed in server chat by anyone on your whitelist, while standing near the bot.',
    size: 'wide',
    body: h('div.loading-block', [h('span.spinner'), 'Loading…']),
    actions: [{ label: 'Close' }]
  });

  const body = dialog.element.querySelector('.modal__body');

  try {
    const reference = await bridge.invoke('bots.commands');
    const prefix = reference?.prefix ?? '.';

    fill(body, [
      h('div.callout.callout--info', [
        icon('zap', { size: 15 }),
        h('div', [
          h('b', `The prefix is "${prefix}"`),
          h('p', `Anyone on the whitelist types ${prefix} followed by a command. Change the prefix under Settings > Bots, and turn the whole feature on under Settings > Whitelist.`)
        ])
      ]),

      h('div', { style: { display: 'grid', gap: '4px', marginTop: '16px' } },
        (reference?.commands ?? []).map((entry) => h('div', {
          style: {
            display: 'flex',
            alignItems: 'baseline',
            gap: '12px',
            padding: '11px 14px',
            background: 'var(--mantle)',
            border: '1px solid var(--surface0)',
            borderRadius: 'var(--r-sm)'
          }
        }, [
          h('code', {
            style: {
              flex: 'none',
              minWidth: '132px',
              color: 'var(--accent)',
              fontSize: 'var(--fs-md)',
              userSelect: 'text'
            }
          }, entry.usage),
          h('span.muted', { style: { fontSize: 'var(--fs-sm)' } }, entry.summary),
          // `help` is the odd one out, and saying so here is the whole reason
          // anyone would wonder why the bot went quiet in game.
          entry.local
            ? h('span.chip.chip--static', { style: { marginLeft: 'auto', height: '22px', fontSize: 'var(--fs-xs)' } }, 'answered in flora')
            : null
        ]))),

      h('div.callout.callout--warn', { style: { marginTop: '16px' } }, [
        icon('alert-triangle', { size: 15 }),
        h('div', [
          h('b', 'These are not vanilla commands'),
          h('p', 'They are read out of server chat, so they work on any server, but a bot only obeys people on the whitelist. Without one, every bot ignores chat entirely.')
        ])
      ])
    ]);
    hydrate(dialog.element);
  } catch (err) {
    fill(body, h('div.callout.callout--danger', [
      icon('alert-circle', { size: 15 }),
      h('div', [h('b', 'Could not load the command list'), h('p', err.message)])
    ]));
    toast.fromError(err, 'Could not load the command list');
  }

  return dialog;
}

/** Which account formats the importer accepts. */
export async function openImportHelp() {
  const dialog = modal({
    title: 'Account file formats',
    subtitle: 'A .txt with one account per line, or a .json file.',
    size: 'wide',
    body: h('div.loading-block', [h('span.spinner'), 'Loading…']),
    actions: [{ label: 'Close' }]
  });

  const body = dialog.element.querySelector('.modal__body');

  try {
    const formats = await bridge.invoke('import.help');
    fill(body, [
      h('div.callout.callout--info', [
        icon('info-circle', { size: 15 }),
        h('div', [
          h('b', 'A separator can be a colon, a pipe, a tab or a space'),
          h('p', 'So a line copied out of a spreadsheet works without editing. Blank lines are skipped, and a line starting with # or // is a comment.')
        ])
      ]),

      h('div', { style: { display: 'grid', gap: '4px', marginTop: '16px' } },
        (formats ?? []).map((entry) => h('div', {
          style: {
            padding: '12px 14px',
            background: 'var(--mantle)',
            border: '1px solid var(--surface0)',
            borderRadius: 'var(--r-sm)'
          }
        }, [
          h('div.row', { style: { justifyContent: 'space-between', gap: '10px', marginBottom: '8px' } }, [
            h('b', { style: { fontSize: 'var(--fs-md)' } }, entry.title),
            h('span.muted', { style: { fontSize: 'var(--fs-xs)', textAlign: 'right' } }, entry.note)
          ]),
          h('code', {
            style: {
              display: 'block',
              padding: '8px 10px',
              background: 'var(--crust)',
              border: '1px solid var(--surface0)',
              borderRadius: 'var(--r-xs)',
              fontSize: 'var(--fs-sm)',
              overflowX: 'auto',
              whiteSpace: 'pre',
              userSelect: 'text'
            }
          }, entry.example)
        ]))),

      h('div.callout.callout--warn', { style: { marginTop: '16px' } }, [
        icon('alert-triangle', { size: 15 }),
        h('div', [
          h('b', 'An email and password is read as an offline-mode account'),
          h('p', 'It is not signed in to Microsoft - that needs the interactive device-code flow under "Sign in with Microsoft", which is the only way Microsoft issues a token to an application. flora never sends an email and password anywhere.')
        ])
      ])
    ]);
    hydrate(dialog.element);
  } catch (err) {
    fill(body, h('div.callout.callout--danger', [
      icon('alert-circle', { size: 15 }),
      h('div', [h('b', 'Could not load the format list'), h('p', err.message)])
    ]));
    toast.fromError(err, 'Could not load the format list');
  }

  return dialog;
}
