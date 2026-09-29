/**
 * Adding an account, and looking at one.
 *
 * Two dialogs that share a file because they share the vocabulary: what a token
 * is, what offline mode means, and which operations only make sense for a
 * Microsoft account. Keeping them side by side is what stops the wording in one
 * from drifting away from the wording in the other.
 */
import { h, fill, debounce } from '../dom.js';
import { icon, hydrate } from '../icons.js';
import * as bridge from '../bridge.js';
import * as store from '../store.js';
import * as format from '../format.js';
import * as toast from '../components/toast.js';
import { modal, confirm as confirmDialog, dropdown, menu } from '../components/overlay.js';
import { headElement, bodyElement } from '../lib/heads.js';
import { field } from './shell.js';
import { openMicrosoftDialog } from './microsoftDialog.js';
import { openSkinPicker } from './skinDialog.js';
import { openNameDialog } from './nameDialog.js';
import { copy, refreshProfile, reveal, testAccounts, removeAccounts } from '../actions.js';

// ---------------------------------------------------------------- add

/**
 * Add an account by hand.
 *
 * Microsoft sign-in is offered first because it is the only route that produces
 * an account flora can keep alive on its own; a pasted token expires and an
 * offline account never had one.
 */
export function openAddAccountDialog({ onAdded = null } = {}) {
  let tab = 'microsoft';

  const body = h('div');
  const footer = h('div');

  const dialog = modal({
    title: 'Add an account',
    subtitle: 'Anything added here stays on this machine.',
    size: 'slim',
    body,
    actions: [{ label: 'Cancel' }]
  });

  function paintTabs() {
    fill(tabs, ['microsoft', 'token', 'offline'].map((id) => h('button.tab', {
      type: 'button',
      'aria-selected': tab === id ? 'true' : 'false',
      onclick: () => { tab = id; paint(); }
    }, TAB_LABEL[id])));
  }

  const tabs = h('div.tabs', { role: 'tablist' });

  function paint() {
    paintTabs();
    fill(body, [
      tabs,
      h('div', { style: { marginTop: '16px' } }, [TAB_BUILDERS[tab]()])
    ]);
    hydrate(body);
  }

  const TAB_LABEL = { microsoft: 'Microsoft', token: 'Token', offline: 'Offline-mode' };

  // ------------------------------------------------------------ microsoft

  function microsoftPane() {
    return h('div', [
      h('div.callout.callout--info', [
        icon('info-circle', { size: 15 }),
        h('div', [
          h('b', 'The recommended way'),
          h('p', 'Microsoft shows you a code, you type it on their own page, and flora is given a token it can renew by itself.')
        ])
      ]),
      h('div', { style: { display: 'grid', gap: '6px', marginTop: '14px' } }, [
        h('button.btn.btn--primary', {
          type: 'button',
          onclick: () => { dialog.close(); openMicrosoftDialog(); }
        }, [icon('key-01', { size: 15 }), 'Sign in with Microsoft'])
      ]),
      h('p.muted', { style: { fontSize: 'var(--fs-sm)', marginTop: '12px' } },
        'Works for any account you own, including ones with two-factor authentication. ' +
        'The password is never entered into flora.')
    ]);
  }

  // ------------------------------------------------------------ token

  function tokenPane() {
    const tokenInput = h('textarea', {
      placeholder: 'eyJraWQiOi…',
      spellcheck: 'false',
      rows: '3',
      style: { fontFamily: 'var(--mono)', fontSize: 'var(--fs-sm)' }
    });

    const labelField = field({
      label: 'Label (optional)',
      control: h('input.input', { type: 'text', placeholder: 'e.g. main', spellcheck: 'false' })
    });

    const verifyBox = h('input', { type: 'checkbox', checked: true });
    const status = h('p.field__hint', { hidden: true });

    const submit = h('button.btn.btn--primary', {
      type: 'button',
      disabled: true,
      onclick: () => addToken()
    }, [icon('plus', { size: 15 }), 'Add the account']);

    tokenInput.addEventListener('input', () => {
      submit.disabled = !tokenInput.value.trim();
      status.hidden = true;
    });

    async function addToken() {
      const token = tokenInput.value.trim();
      if (!token) return;

      submit.disabled = true;
      fill(status, 'Checking the token with Mojang…');
      status.hidden = false;

      try {
        const result = await bridge.invoke('accounts.addToken', {
          token,
          label: labelField.control.value.trim(),
          verify: verifyBox.checked
        });

        const account = result.account;
        onAdded?.(account);

        if (result.duplicate) {
          toast.info('That account was already here', 'Its token has been updated.');
        } else if (verifyBox.checked && !result.verified) {
          toast.warn('Added, but the token did not work',
            result.error ?? 'Mojang did not accept it. It may have expired.');
        } else {
          toast.ok(`Added ${account?.username || 'the account'}`,
            result.verified ? null : 'Not checked.');
        }

        dialog.close();
      } catch (err) {
        submit.disabled = false;
        fill(status, null);
        status.hidden = true;
        toast.fromError(err, 'Could not add that account');
      }
    }

    // The footer exists so `setFooter` works; this pane uses its own button.
    dialog.setFooter([
      h('div.grow.muted', { style: { fontSize: 'var(--fs-xs)' } }, 'Stored encrypted in flora\'s data folder.'),
      h('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel')
    ]);

    return h('div', [
      h('div.callout.callout--warn', [
        icon('alert-triangle', { size: 15 }),
        h('div', [
          h('b', 'A token stops working when it expires'),
          h('p', 'Unlike a Microsoft sign-in, flora cannot renew one. Use this for tokens you have just exported from another tool.')
        ])
      ]),
      h('div', { style: { marginTop: '14px' } }, [
        field({ label: 'Access token', control: tokenInput }).el,
        labelField.el,
        h('div.switchfield', [
          h('div.switchfield__text', [
            h('b', 'Check it before adding'),
            h('span', 'Asks Mojang who the token belongs to, so the name and UUID are filled in.')
          ]),
          h('label.toggle', [verifyBox, h('span')])
        ]),
        status,
        h('div', { style: { marginTop: '14px' } }, [submit])
      ])
    ]);
  }

  // ------------------------------------------------------------ offline

  function offlinePane() {
    const nameField = field({
      label: 'Username',
      control: h('input.input', {
        type: 'text',
        placeholder: 'Notch',
        spellcheck: 'false',
        autocomplete: 'off'
      }),
      hint: 'Exactly as it appears on the server.'
    });

    const passwordField = field({
      label: 'Password (optional)',
      control: h('input.input', { type: 'password', autocomplete: 'new-password' }),
      hint: 'Only needed by servers that ask for one during login.'
    });

    const labelField = field({
      label: 'Label (optional)',
      control: h('input.input', { type: 'text', spellcheck: 'false' })
    });

    const submit = h('button.btn.btn--primary', {
      type: 'button',
      disabled: true,
      onclick: () => addOffline()
    }, [icon('plus', { size: 15 }), 'Add the account']);

    nameField.control.addEventListener('input', () => {
      submit.disabled = !nameField.control.value.trim();
    });

    async function addOffline() {
      const username = nameField.control.value.trim();
      if (!username) return;

      try {
        const result = await bridge.invoke('accounts.addOffline', {
          username,
          password: passwordField.control.value || null,
          label: labelField.control.value.trim()
        });

        onAdded?.(result.account);

        if (result.duplicate) toast.info(`${username} was already here`, 'Its details have been updated.');
        else toast.ok(`Added ${username}`, 'Offline-mode accounts never contact Microsoft.');

        dialog.close();
      } catch (err) {
        toast.fromError(err, 'Could not add that account');
      }
    }

    dialog.setFooter([
      h('div.grow.muted', { style: { fontSize: 'var(--fs-xs)' } }, 'For offline-mode servers only.'),
      h('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel')
    ]);

    return h('div', [
      h('div.callout.callout--info', [
        icon('info-circle', { size: 15 }),
        h('div', [
          h('b', 'No Microsoft account is involved'),
          h('p', 'An offline-mode account can join a server that is not in online mode, and nothing else. ' +
            'It cannot be given a skin, because skins belong to a Mojang profile.')
        ])
      ]),
      h('div', { style: { marginTop: '14px' } }, [
        nameField.el,
        passwordField.el,
        labelField.el,
        h('div', { style: { marginTop: '14px' } }, [submit])
      ])
    ]);
  }

  const TAB_BUILDERS = {
    microsoft: microsoftPane,
    token: tokenPane,
    offline: offlinePane
  };

  // The Microsoft pane has no fields, so its button belongs in the footer where
  // a dialog action normally lives. The other two panes install their own.
  dialog.setFooter([
    h('div.grow'),
    h('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Close')
  ]);

  paint();
  return dialog;
}

// ---------------------------------------------------------------- detail

const SKIN_MODEL_LABEL = { classic: 'Classic', slim: 'Slim' };

/**
 * Everything known about one account, and everything that can be done to it.
 *
 * Edits are held until Save rather than written on every keystroke: a label is
 * a field the user types a whole word into, and each keystroke is not a save.
 */
export function openAccountDetail(id, { onChanged = null } = {}) {
  const account = () => store.accountById(id);

  let draft = null;
  let live = null;

  const bodyEl = h('div');

  const dialog = modal({
    title: account()?.username || `Account ${id}`,
    size: 'wide',
    body: bodyEl,
    onClose: () => { /* nothing to clean up; the dialog owns no timers */ },
    actions: [{ label: 'Close' }]
  });

  function seed() {
    live = account();
    draft = {
      label: live?.label ?? '',
      notes: live?.notes ?? '',
      tags: (live?.tags ?? []).join(', '),
      favorite: Boolean(live?.favorite),
      proxyId: live?.proxyId ?? null
    };
  }

  const dirty = () => {
    if (!live || !draft) return false;
    return draft.label !== (live.label ?? '')
      || draft.notes !== (live.notes ?? '')
      || draft.tags !== (live.tags ?? []).join(', ')
      || draft.favorite !== Boolean(live.favorite)
      || draft.proxyId !== (live.proxyId ?? null);
  };

  function paint() {
    live = account();
    if (!live) {
      fill(bodyEl, h('div.callout.callout--warn', [
        icon('alert-triangle', { size: 15 }),
        h('div', [
          h('b', 'That account is gone'),
          h('p', 'It was removed, in this window or another one.')
        ])
      ]));
      hydrate(bodyEl);
      dialog.setFooter([h('div.spacer'), h('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Close')]);
      return;
    }

    if (!draft) seed();

    const bot = store.botFor(id);
    const proxy = live.proxyId ? store.proxyById(live.proxyId) : null;
    const editable = true;

    // ---------------------------------------------------------- identity

    const identity = h('div', {
      style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }
    }, [
      headElement(live.skinHash, { name: live.username, size: 64 }),
      h('div.grow', { style: { minWidth: '0' } }, [
        h('div.row', { style: { gap: '8px', flexWrap: 'wrap' } }, [
          h('b', { style: { fontSize: 'var(--fs-xl)', letterSpacing: '-0.02em' } }, live.username || 'Unnamed'),
          h(`span.badge.badge--${format.kindTone(live.kind)}`, format.kindLabel(live.kind)),
          h(`span.badge.badge--${format.statusTone(bot.status)}${bot.status === 'online' ? '.badge--live' : ''}`,
            format.statusLabel(bot.status))
        ]),
        h('p.mono-sm.muted', { style: { marginTop: '4px' } }, live.uuid || 'no UUID on record'),
        bot.server
          ? h('p.muted', { style: { fontSize: 'var(--fs-sm)' } }, `Connected to ${format.server(bot.server)}`)
          : null
      ]),
      h('button.btn.btn--ghost.btn--icon', {
        type: 'button',
        'aria-label': draft.favorite ? 'Remove from favourites' : 'Add to favourites',
        onclick: () => { draft.favorite = !draft.favorite; paint(); }
      }, [icon('check-circle', { size: 16 })]),
      h('button.btn.btn--ghost.btn--icon', {
        type: 'button',
        'aria-label': 'More actions',
        onclick: (event) => actionsMenu(event.currentTarget)
      }, [icon('dots-vertical', { size: 16 })])
    ]);

    // ---------------------------------------------------------- last check

    const check = live.lastTestedAt
      ? h(`div.callout.callout--${live.lastTestOk ? 'ok' : 'danger'}`, [
          icon(live.lastTestOk ? 'check-circle' : 'alert-circle', { size: 15 }),
          h('div', [
            h('b', live.lastTestOk ? 'The token works' : 'The token was rejected'),
            h('p', live.lastTestOk
              ? `Checked ${format.ago(live.lastTestedAt)}.`
              : `${live.lastTestError ?? 'No reason given.'} (checked ${format.ago(live.lastTestedAt)}.)`)
          ])
        ])
      : h('div.callout.callout--idle', [
          icon('help-circle', { size: 15 }),
          h('div', [
            h('b', 'Never checked'),
            h('p', 'Run a check to find out whether the stored token still works.')
          ])
        ]);

    // ---------------------------------------------------------- fields

    const labelInput = h('input.input', {
      type: 'text',
      value: draft.label,
      placeholder: 'e.g. main',
      spellcheck: 'false'
    });
    labelInput.addEventListener('input', () => { draft.label = labelInput.value; paintFooter(); });

    const notesInput = h('textarea', {
      rows: '3',
      value: draft.notes,
      placeholder: 'Anything worth remembering about this account.'
    });
    notesInput.addEventListener('input', () => { draft.notes = notesInput.value; paintFooter(); });

    const tagsInput = h('input.input', {
      type: 'text',
      value: draft.tags,
      placeholder: 'main, fishing, alt',
      spellcheck: 'false'
    });
    tagsInput.addEventListener('input', () => { draft.tags = tagsInput.value; paintFooter(); });

    // A dropdown rather than a `<select>`: an option carrying a host, a port and
    // a label has no width the native popup will respect, so the longest entry
    // sets how wide the list opens and a long label runs off the screen edge.
    const proxyPicker = dropdown({
      options: [
        { value: '', label: 'No proxy - connect directly' },
        ...store.proxies().map((entry) => ({
          value: String(entry.id),
          label: `${entry.host}:${entry.port}${entry.label ? ` (${entry.label})` : ''}`
        }))
      ],
      value: draft.proxyId == null ? '' : String(draft.proxyId),
      label: 'Proxy',
      wide: true,
      onChange: (next) => {
        draft.proxyId = next ? Number(next) : null;
        paintFooter();
      }
    });

    // ---------------------------------------------------------- assemble

    fill(bodyEl, h('div', [
      identity,
      h('hr.divider'),
      check,

      h('div.section-title', 'Actions'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '6px' } }, [
        actionButton('clipboard-check', 'Check the token', () => testAccounts([id])),
        actionButton('refresh-cw-01', 'Refresh name and skin', () => refreshProfile(id),
          { disabled: live.kind === 'offline' }),
        actionButton('paint-pour', 'Change the skin', () => openSkinPicker([id]),
          { disabled: live.kind === 'offline' }),
        actionButton('pencil-01', 'Change the username', () => openNameDialog(id),
          { disabled: live.kind === 'offline' }),
        actionButton('key-01', 'Copy the access token', () => revealAndCopy('token'),
          { disabled: !live.hasToken }),
        actionButton('log-out-01', 'Copy the password', () => revealAndCopy('password'),
          { disabled: !live.hasPassword }),
        actionButton('copy-01', 'Copy the username', () => copy(live.username, 'Username'),
          { disabled: !live.username }),
        actionButton('copy-01', 'Copy the UUID', () => copy(live.uuid, 'UUID'),
          { disabled: !live.uuid }),
        actionButton('trash-01', 'Remove from flora', () => remove(), { danger: true })
      ]),

      h('hr.divider'),

      h('div.section-title', 'Details'),
      editable
        ? h('div', [
            field({ label: 'Label', control: labelInput, hint: 'A name for this account that only flora shows.' }).el,
            field({ label: 'Tags', control: tagsInput, hint: 'Comma separated. Used by the tag filter in the account list.' }).el,
            field({ label: 'Notes', control: notesInput }).el,
            field({ label: 'Proxy', control: proxyPicker.el, hint: 'Used the next time this account connects.' }).el
          ])
        : null,

      h('div', { style: { marginTop: '14px' } }, [
        h('dl.kv', [
          h('dt', 'Type'), h('dd', format.kindLabel(live.kind)),
          h('dt', 'Token'), h('dd.mono-sm', live.hasToken
            ? (live.tokenHint ?? 'stored')
            : (live.kind === 'offline' ? 'not applicable' : 'none stored')),
          h('dt', 'Renewable'), h('dd', live.canRefresh ? 'Yes, from the saved Microsoft sign-in' : 'No'),
          h('dt', 'Skin model'), h('dd', live.skinModel ? (SKIN_MODEL_LABEL[live.skinModel] ?? live.skinModel) : '—'),
          h('dt', 'Proxy'), h('dd.mono-sm', proxy ? `${proxy.host}:${proxy.port}` : 'none'),
          h('dt', 'Added'), h('dd', format.stamp(live.createdAt)),
          h('dt', 'Updated'), h('dd', format.ago(live.updatedAt ?? live.createdAt))
        ])
      ]),

      live.proxyId && !proxy
        ? h('div.callout.callout--warn', { style: { marginTop: '14px' } }, [
            icon('alert-triangle', { size: 15 }),
            h('div', [
              h('b', 'Its proxy has been removed'),
              h('p', 'This account will connect directly until it is given another one.')
            ])
          ])
        : null
    ]));

    hydrate(bodyEl);
    dialog.setTitle(live.username || `Account ${id}`);
    paintFooter();
  }

  function actionButton(iconName, label, run, { disabled = false, danger = false } = {}) {
    return h(`button.btn.btn--outline${danger ? '.btn--danger' : ''}`, {
      type: 'button',
      disabled,
      style: { justifyContent: 'flex-start' },
      onclick: run
    }, [icon(iconName, { size: 14 }), label]);
  }

  function paintFooter() {
    const changed = dirty();

    dialog.setFooter([
      h('button.btn.btn--ghost.btn--danger', {
        type: 'button',
        onclick: () => remove()
      }, [icon('trash-01', { size: 14 }), 'Remove']),
      h('div.spacer'),
      h('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Close'),
      h('button.btn.btn--primary', {
        type: 'button',
        disabled: !changed,
        onclick: () => save()
      }, changed ? 'Save changes' : 'Saved')
    ]);
  }

  async function save() {
    const patch = {
      label: draft.label.trim(),
      notes: draft.notes,
      tags: draft.tags.split(',').map((t) => t.trim()).filter(Boolean),
      favorite: draft.favorite,
      proxyId: draft.proxyId
    };

    try {
      await bridge.invoke('accounts.update', { id, patch });
      live = { ...live, ...patch };
      seed();
      onChanged?.();
      paint();
      toast.ok('Saved', null, { timeout: 1400 });
    } catch (err) {
      toast.fromError(err, 'Could not save those changes');
    }
  }

  async function remove() {
    const confirmed = await confirmDialog({
      title: 'Remove this account?',
      message: `${live?.username || `Account ${id}`} will be removed from flora.`,
      detail: 'The Minecraft account itself is not affected. This cannot be undone.',
      confirmLabel: 'Remove',
      danger: true
    });
    if (!confirmed) return;

    const removed = await removeAccounts([live]);
    if (removed) { dialog.close(); onChanged?.(); }
  }

  async function revealAndCopy(kind) {
    const value = await reveal(id, kind);
    if (value) await copy(value, kind === 'token' ? 'Access token' : 'Password');
  }

  function actionsMenu(anchor) {
    const bot = store.botFor(id);
    const running = bot.status !== 'offline';
    const account = live;

    menu(anchor, [
      { header: true, label: account.username || `Account ${id}` },
      running
        ? { icon: 'square', label: 'Disconnect', onClick: async () => { await bridge.invoke('bots.stop', { id }); onChanged?.(); } }
        : { icon: 'play', label: 'Connect to a server', onClick: () => store.emit(store.TOPICS.NAVIGATE, 'bots') },
      { icon: 'terminal', label: 'Show the console', onClick: () => store.emit(store.TOPICS.NAVIGATE, 'bots') },
      { separator: true },
      {
        icon: 'check-circle',
        label: account.favorite ? 'Remove from favourites' : 'Add to favourites',
        onClick: async () => {
          draft.favorite = !account.favorite;
          await save();
        }
      },
      {
        icon: 'download-cloud-02',
        label: 'Refresh just the skin',
        disabled: account.kind === 'offline',
        onClick: async () => {
          try {
            await bridge.invoke('skins.fetch', { id, force: true });
            toast.ok('Skin refreshed');
            onChanged?.();
            paint();
          } catch (err) {
            toast.fromError(err, 'Could not refresh that skin');
          }
        }
      },
      {
        icon: 'copy-01',
        label: 'Copy everything as JSON',
        onClick: async () => {
          const { bot: _bot, ...rest } = account;
          await copy(JSON.stringify(rest, null, 2), 'Account details');
        }
      }
    ]);
  }

  seed();
  paint();

  // A refresh that changes the row underneath - a skin fetched, a token
  // checked - should be reflected here, but not while the user is typing.
  const unsubscribe = store.subscribe(store.TOPICS.ACCOUNTS, () => {
    if (bodyEl.contains(document.activeElement)) return;
    seed();
    paint();
  });

  const originalClose = dialog.close;
  return {
    ...dialog,
    close: () => { unsubscribe(); originalClose(); }
  };
}
