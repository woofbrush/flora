/**
 * About flora.
 *
 * Also the diagnostics panel: the version, the runtime and the data folder are
 * the three things worth knowing when something is wrong, and they belong
 * somewhere the user can find them without being told a path.
 */
import { h, fill } from '../dom.js';
import { icon, hydrate, mark } from '../icons.js';
import * as bridge from '../bridge.js';
import * as toast from '../components/toast.js';
import { modal } from '../components/overlay.js';
import { LINKS } from '../links.js';

const BUILT_ON = [
  ['Electron', 'the desktop runtime'],
  ['mineflayer', 'the bot client'],
  ['minecraft-protocol', 'the wire protocol'],
  ['prismarine-auth', 'Microsoft sign-in'],
  ['Poppins & JetBrains Mono', 'typefaces'],
  ['Lucide', 'icon set']
];

/** Open a link in the user's own browser; never in this window. */
async function openExternal(url) {
  try {
    await bridge.ui.openExternal(url);
  } catch (err) {
    toast.fromError(err, 'Could not open that link');
  }
}

export function openAboutDialog() {
  const infoHost = h('div', { style: { marginTop: '14px' } });
  const versionLine = h('span.muted', { style: { fontSize: 'var(--fs-sm)' } }, 'Reading version…');

  const dialog = modal({
    title: 'About flora',
    size: 'slim',
    body: h('div', [
      h('div', { style: { display: 'grid', justifyItems: 'center', gap: '10px', textAlign: 'center', padding: '6px 0 4px' } }, [
        mark(72),
        h('div', [
          h('b', { style: { fontSize: 'var(--fs-xl)', letterSpacing: '-0.02em' } }, 'flora'),
          h('div', versionLine)
        ]),
        h('p.muted', { style: { fontSize: 'var(--fs-sm)', maxWidth: '320px' } },
          'Accounts, proxies and Minecraft bots, kept on this machine and nowhere else.')
      ]),

      infoHost,

      h('hr.divider'),

      h('div', { style: { display: 'grid', gap: '8px' } }, [
        h('button.menu__item', {
          type: 'button',
          style: { height: 'auto', padding: '9px 10px' },
          onclick: () => openExternal(LINKS.website)
        }, [
          icon('link-external-01', { size: 18 }),
          h('span.grow', [
            h('b', { style: { display: 'block', fontWeight: '500' } }, 'Woofbrush Design LLC'),
            h('span.muted', { style: { display: 'block', fontSize: 'var(--fs-xs)' } }, 'woofbrush.com')
          ])
        ]),
        h('button.menu__item', {
          type: 'button',
          style: { height: 'auto', padding: '9px 10px' },
          onclick: () => openExternal(LINKS.discord)
        }, [
          icon('discord', { size: 18 }),
          h('span.grow', [
            h('b', { style: { display: 'block', fontWeight: '500' } }, 'Discord'),
            h('span.muted', { style: { display: 'block', fontSize: 'var(--fs-xs)' } }, 'Help, updates and other people using flora')
          ])
        ])
      ]),

      h('hr.divider'),

      h('div.section-title', 'Built with'),
      h('div', { style: { display: 'grid', gap: '4px' } }, BUILT_ON.map(([name, what]) => h('div.row', {
        style: { justifyContent: 'space-between', gap: '10px', fontSize: 'var(--fs-sm)' }
      }, [
        h('span', name),
        h('span.muted', { style: { fontSize: 'var(--fs-xs)' } }, what)
      ]))),

      h('p.muted', { style: { fontSize: 'var(--fs-xs)', marginTop: '14px', lineHeight: '1.6' } },
        'flora is not affiliated with, endorsed by or connected to Mojang Studios or Microsoft. ' +
        'Minecraft is a trademark of Mojang Synergies AB.')
    ]),
    actions: [
      { label: 'Copy diagnostics', onClick: () => copyDiagnostics() },
      { label: 'Close' }
    ]
  });

  bridge.invoke('app.info').then((info) => {
    versionLine.textContent = `version ${info.version}`;
    fill(infoHost, h('dl.kv', { style: { marginTop: '16px' } }, [
      h('dt', 'Version'), h('dd', info.version),
      h('dt', 'Electron'), h('dd', info.electron ?? '—'),
      h('dt', 'Node'), h('dd', info.node),
      h('dt', 'Database'), h('dd', info.db?.file ?? info.dbFile ?? '—'),
      h('dt', 'Data folder'), h('dd', info.dataRoot)
    ]));
    hydrate(infoHost);
  }).catch((err) => {
    versionLine.textContent = 'version unknown';
    fill(infoHost, h('div.callout.callout--warn', { style: { marginTop: '14px' } }, [
      icon('alert-triangle', { size: 15 }),
      h('div', [h('b', 'The backend did not answer'), h('p', err.message)])
    ]));
    hydrate(infoHost);
  });

  async function copyDiagnostics() {
    try {
      const info = await bridge.invoke('app.info');
      const lines = [
        `flora ${info.version}`,
        `Electron ${info.electron ?? '—'} · Node ${info.node}`,
        `Database schema v${info.db?.version ?? '—'}`,
        `Data folder: ${info.dataRoot}`,
        `Database: ${info.db?.file ?? info.dbFile ?? '—'}`
      ];
      await bridge.ui.copy(lines.join('\n'));
      toast.ok('Diagnostics copied', null, { timeout: 1600 });
    } catch (err) {
      toast.fromError(err, 'Could not read the diagnostics');
    }
  }

  return dialog;
}
