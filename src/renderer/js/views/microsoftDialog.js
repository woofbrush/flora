/**
 * Sign in with Microsoft.
 *
 * The device-code flow: the app asks Microsoft for a short code, the user types
 * it at Microsoft's own page in their own browser, and the app polls until the
 * sign-in completes. There is no redirect URI anywhere in it, so there is no
 * callback page that can come back "forbidden" - the flow finishes inside the
 * app, not by catching a browser redirect.
 *
 * The dialog is driven by the `auth:login-*` events rather than by polling the
 * backend. A state change is a push, and polling would only add latency to the
 * one screen where the user is sitting and waiting.
 */
import { h, fill } from '../dom.js';
import { icon, hydrate } from '../icons.js';
import * as bridge from '../bridge.js';
import * as store from '../store.js';
import * as format from '../format.js';
import * as toast from '../components/toast.js';
import { modal } from '../components/overlay.js';
import { headElement } from '../lib/heads.js';

/** Every event the backend emits while a sign-in is in flight. */
const EVENTS = [
  'auth:login-started',
  'auth:login-code',
  'auth:login-done',
  'auth:login-failed',
  'auth:login-cancelled'
];

const TERMINAL = new Set(['done', 'error', 'cancelled']);

export function openMicrosoftDialog() {
  /** The public session the backend handed back, kept current from events. */
  let session = null;
  /** True once an event has arrived, so a slow `begin` cannot overwrite it. */
  let sawEvent = false;
  /** True once the sign-in has finished, one way or another. */
  let settled = false;
  let closed = false;

  const stage = h('div');

  const dialog = modal({
    title: 'Sign in with Microsoft',
    subtitle: 'Your password is only ever typed into Microsoft\'s own page.',
    size: 'slim',
    body: stage,
    dismissible: true,
    onClose: () => {
      closed = true;
      // Closing the window while Microsoft is still waiting would otherwise
      // leave a poll running against nobody for the next quarter of an hour.
      if (session?.id && !settled && !TERMINAL.has(session.state)) {
        bridge.invoke('microsoft.cancel', { id: session.id }).catch(() => {});
      }
      offEvents();
    },
    actions: [{ label: 'Cancel' }]
  });

  // The listener goes on before the request, so the very first event cannot
  // arrive before there is anyone listening for it.
  const offEvents = bridge.on('backend:event', ({ event, payload }) => {
    if (!EVENTS.includes(event)) return;
    // Someone else's sign-in, if a second window is ever opened.
    if (session?.id && payload?.id && payload.id !== session.id) return;

    // Each event carries the whole session, so this is a replace, not a merge.
    session = payload;
    sawEvent = true;
    if (!closed) paint();
  });

  start();

  async function start() {
    paint();
    try {
      const initial = await bridge.invoke('microsoft.begin', { label: '' });
      // The backend answers before it has talked to Microsoft, so an event may
      // already have overtaken this reply - in which case it is the newer of
      // the two and this must not clobber it.
      if (!sawEvent) { session = initial; }
      if (!closed) paint();
    } catch (err) {
      settled = true;
      fill(stage, h('div.callout.callout--danger', [
        icon('alert-circle', { size: 15 }),
        h('div', [h('b', 'Could not start the sign-in'), h('p', err.message)])
      ]));
      hydrate(stage);
      dialog.setFooter([
        h('div.spacer'),
        h('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Close')
      ]);
    }
  }

  function paint() {
    const state = session?.state ?? 'starting';
    if (state === 'done') return paintDone();
    if (state === 'error' || state === 'cancelled') return paintFailed(state);
    return paintWaiting(state);
  }

  function paintWaiting(state) {
    const code = session?.userCode ?? null;
    const uri = session?.verificationUri ?? 'https://microsoft.com/link';

    fill(stage, h('div', [
      h('div.callout.callout--info', [
        icon('info-circle', { size: 15 }),
        h('div', [
          h('b', 'Microsoft will ask you for a code'),
          h('p', 'Open the page below, sign in, and type this code. flora never sees your password.')
        ])
      ]),

      h('div', {
        style: {
          margin: '16px 0',
          padding: '18px',
          textAlign: 'center',
          background: 'var(--crust)',
          border: '1px solid var(--surface1)',
          borderRadius: 'var(--r-md)'
        }
      }, code
        ? [
            h('div', {
              style: {
                fontSize: 'var(--fs-xs)',
                color: 'var(--overlay1)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em'
              }
            }, 'Your code'),
            h('div', {
              style: {
                fontFamily: 'var(--mono)',
                fontSize: '30px',
                fontWeight: '600',
                letterSpacing: '0.12em',
                color: 'var(--accent)',
                margin: '8px 0 12px',
                userSelect: 'text'
              }
            }, code),
            h('button.btn.btn--outline.btn--sm', {
              type: 'button',
              onclick: () => copyText(code, 'Code copied')
            }, [icon('copy-01', { size: 14 }), 'Copy the code'])
          ]
        : h('div.row', { style: { justifyContent: 'center', gap: '10px', color: 'var(--overlay1)' } }, [
            h('span.spinner'),
            state === 'awaiting_code' ? 'Contacting Microsoft…' : 'Waiting for Microsoft…'
          ])),

      h('div', { style: { display: 'grid', gap: '6px' } }, [
        h('button.menu__item', {
          type: 'button',
          style: { height: 'auto', padding: '10px' },
          onclick: () => openExternal(uri)
        }, [
          icon('link-external-01', { size: 18 }),
          h('span.grow', [
            h('b', { style: { display: 'block', fontWeight: '500' } }, 'Open Microsoft\'s sign-in page'),
            h('span.muted', { style: { display: 'block', fontSize: 'var(--fs-xs)' } },
              format.truncateMiddle(uri, 28, 10))
          ])
        ]),
        h('button.menu__item', {
          type: 'button',
          style: { height: 'auto', padding: '10px' },
          disabled: !code,
          onclick: () => copyText(`${uri}\nCode: ${code}`, 'Page and code copied')
        }, [
          icon('copy-01', { size: 18 }),
          h('span.grow', [
            h('b', { style: { display: 'block', fontWeight: '500' } }, 'Copy the page and code'),
            h('span.muted', { style: { display: 'block', fontSize: 'var(--fs-xs)' } },
              'For a browser on another device')
          ])
        ])
      ]),

      session?.expiresAt
        ? h('p.muted', { style: { fontSize: 'var(--fs-xs)', marginTop: '12px' } },
            `This code is valid until ${format.clock(session.expiresAt)}.`)
        : null,

      h('p.muted', { style: { fontSize: 'var(--fs-xs)', marginTop: '6px' } },
        'Once you approve it, this account is added to flora and stays signed in ' +
        'without another code.')
    ]));

    hydrate(stage);
  }

  function paintDone() {
    settled = true;
    const name = session?.profile?.name ?? null;
    const account = session?.accountId ? store.accountById(session.accountId) : null;

    fill(stage, h('div', [
      h('div', {
        style: { display: 'grid', justifyItems: 'center', gap: '10px', textAlign: 'center', padding: '8px 0' }
      }, [
        headElement(account?.skinHash ?? null, { name: account?.username ?? null, size: 56 }),
        h('b', { style: { fontSize: 'var(--fs-lg)' } },
          name ? `Signed in as ${name}` : 'Signed in'),
        h('p.muted', { style: { fontSize: 'var(--fs-sm)' } },
          'The account is in your list, ready to connect.')
      ]),

      h('div.callout.callout--ok', { style: { marginTop: '14px' } }, [
        icon('check-circle', { size: 15 }),
        h('div', [
          h('b', 'This account stays signed in'),
          h('p', 'The refresh token is kept in the data folder, so it can be renewed later without another code.')
        ])
      ])
    ]));
    hydrate(stage);

    dialog.setFooter([
      h('div.spacer'),
      h('button.btn', {
        type: 'button',
        onclick: () => {
          dialog.close();
          store.emit(store.TOPICS.NAVIGATE, 'accounts');
        }
      }, 'Show the accounts'),
      h('button.btn.btn--primary', {
        type: 'button',
        onclick: () => { dialog.close(); openMicrosoftDialog(); }
      }, 'Sign in another')
    ]);
  }

  function paintFailed(state) {
    settled = true;
    const cancelled = state === 'cancelled';

    fill(stage, h('div', [
      h(`div.callout.callout--${cancelled ? 'warn' : 'danger'}`, [
        icon(cancelled ? 'alert-triangle' : 'alert-circle', { size: 15 }),
        h('div', [
          h('b', cancelled ? 'Sign-in cancelled' : 'Sign-in failed'),
          h('p', session?.error ?? session?.message ?? 'Microsoft did not complete the request.')
        ])
      ]),
      !cancelled
        ? h('div.callout.callout--info', { style: { marginTop: '14px' } }, [
            icon('info-circle', { size: 15 }),
            h('div', [
              h('b', 'If the code had expired'),
              h('p', 'Codes are short-lived. Start again and enter the new one promptly.')
            ])
          ])
        : null
    ]));
    hydrate(stage);

    dialog.setFooter([
      h('div.spacer'),
      h('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Close'),
      h('button.btn.btn--primary', {
        type: 'button',
        onclick: () => { dialog.close(); openMicrosoftDialog(); }
      }, 'Try again')
    ]);
  }

  async function copyText(text, message) {
    try {
      await bridge.ui.copy(text);
      toast.ok(message, null, { timeout: 1600 });
    } catch (err) {
      toast.fromError(err, 'Could not copy that');
    }
  }

  async function openExternal(url) {
    try {
      await bridge.ui.openExternal(url);
    } catch (err) {
      toast.fromError(err, 'Could not open that page');
    }
  }

  return dialog;
}
