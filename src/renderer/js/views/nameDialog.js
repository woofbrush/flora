/**
 * Changing one account's username.
 *
 * Deliberately not a bulk action, unlike the skin picker next door. Mojang
 * allows one rename per account every 30 days and refuses the rest, so a
 * "change all" button could only ever produce a long list of the same refusal -
 * and it would be a button that looks like it works. The row menu opens this
 * for a single account and there is no select-all path into it.
 *
 * The availability check is Mojang's own public endpoint, called through the
 * account's own proxy and debounced while the user types. It is advisory: the
 * real answer is whatever the rename itself returns, and that is what the user
 * is shown if the two disagree.
 */
import { h, fill, debounce } from '../dom.js';
import { icon, hydrate } from '../icons.js';
import * as bridge from '../bridge.js';
import * as store from '../store.js';
import * as format from '../format.js';
import * as toast from '../components/toast.js';
import { modal, confirm as confirmDialog } from '../components/overlay.js';
import { field } from './shell.js';
import { reload } from '../actions.js';

/**
 * How each answer from the availability endpoint is drawn.
 *
 * These four are verdicts: the name is known not to work, so the button stays
 * shut. A check that *failed* is deliberately not one of them - it says nothing
 * about the name, and blocking on it would leave someone with an expired token
 * unable to rename at all.
 */
const STATUS = {
  AVAILABLE: { tone: 'ok', icon: 'check-circle' },
  DUPLICATE: { tone: 'bad', icon: 'x-close' },
  NOT_ALLOWED: { tone: 'bad', icon: 'alert-circle' },
  INVALID: { tone: 'bad', icon: 'alert-triangle' },
  CURRENT: { tone: 'muted', icon: 'info-circle' },
  UNKNOWN: { tone: 'warn', icon: 'alert-triangle' }
};

/** Answers that mean "this name will not work", as opposed to "not known". */
const BLOCKING = new Set(['DUPLICATE', 'NOT_ALLOWED', 'INVALID', 'CURRENT']);

const TONE_COLOR = {
  ok: 'var(--green)',
  bad: 'var(--red)',
  warn: 'var(--yellow)',
  muted: 'var(--subtext0)'
};

const HINT = '3 to 16 characters. Letters, numbers and underscores only.';
const NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

/**
 * The palette and menu path in.
 *
 * Unlike skins there is no sensible reading of "all the selected ones" - a
 * rename is one account, once, and doing it to a selection would be doing it
 * to whichever account happened to be first. So this insists on exactly one
 * rather than choosing on the user's behalf.
 */
export function openNamePicker() {
  const selected = [...new Set(store.selectedIds().map(Number).filter(Number.isFinite))];

  if (selected.length === 1) return openNameDialog(selected[0]);

  toast.info(
    selected.length ? 'Pick one account' : 'Pick an account first',
    'A username can only be changed one account at a time.'
  );
  return null;
}

/** Open the rename dialog for one account. */
export function openNameDialog(id) {
  const accountId = Number(id);
  const account = store.accountById(accountId);

  const dialog = modal({
    title: 'Change username',
    subtitle: account ? `For ${account.username || `account ${accountId}`}, and only that one.` : null,
    actions: [{ label: 'Close' }]
  });

  const body = dialog.element.querySelector('.modal__body');

  if (!account) {
    fill(body, h('div.callout.callout--danger', [
      icon('alert-circle', { size: 15 }),
      h('div', [h('b', 'That account is gone'), h('p', 'It was removed while this dialog was open.')])
    ]));
    hydrate(body);
    return dialog;
  }

  // An offline-mode account has no Mojang profile, so there is nothing to
  // rename here. Saying so beats offering a field that always fails.
  if (account.kind === 'offline') {
    fill(body, h('div.callout.callout--warn', [
      icon('alert-triangle', { size: 15 }),
      h('div', [
        h('b', 'Offline-mode accounts cannot be renamed'),
        h('p', 'This account is a username for offline-mode servers. It has no Mojang profile, so its name is set when you add it rather than through Microsoft.')
      ])
    ]));
    hydrate(body);
    return dialog;
  }

  let status = null;
  let checking = false;
  let submitting = false;
  // Every keystroke starts a request and they do not come back in order. Only
  // the newest is allowed to paint, so each one takes a ticket.
  let generation = 0;

  // ------------------------------------------------------------ chrome

  const input = h('input.input', {
    type: 'text',
    value: '',
    maxlength: '16',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: account.username || 'New username',
    'aria-label': 'New username'
  });

  const nameField = field({ label: 'New username', control: input, hint: HINT });
  const statusHost = h('div', { style: { minHeight: '20px', marginTop: '10px' } });

  const submit = h('button.btn.btn--primary', {
    type: 'button',
    disabled: true,
    onclick: () => run()
  }, [icon('pencil-01', { size: 15 }), 'Change username']);

  function setStatus(next, { pending = false } = {}) {
    generation += 1;
    status = next;
    checking = pending;
    paint();
  }

  input.addEventListener('input', () => {
    const value = input.value.trim();

    // A refusal from an earlier attempt belongs to the name that was refused,
    // not to whatever is in the box now.
    nameField.setError(null);

    if (!value) return setStatus(null);
    if (value === account.username) {
      return setStatus({ status: 'CURRENT', message: 'That is already this account\'s username.' });
    }
    if (!NAME_PATTERN.test(value)) return setStatus({ status: 'INVALID', message: HINT });

    // Claim the ticket before the debounce timer starts, so a reply that is
    // already in flight for a shorter prefix cannot paint over this one.
    const mine = ++generation;
    status = null;
    checking = true;
    paint();
    check(value, mine);
  });

  // Waiting for a pause is the whole point: checking per keystroke would be
  // eight requests for an eight-letter name, and Mojang rate limits this
  // endpoint per address.
  const check = debounce(async (value, mine) => {
    let next;
    try {
      next = await bridge.invoke('accounts.checkName', { id: accountId, name: value });
    } catch (err) {
      next = { ok: false, status: 'UNKNOWN', error: err?.message ?? 'Could not check that name.' };
    }
    if (mine !== generation) return;
    status = next;
    checking = false;
    paint();
  }, 320);

  function paint() {
    const key = checking ? null : status?.status;
    const tone = STATUS[key]?.tone ?? 'muted';
    const iconName = checking ? 'loading-02' : (STATUS[key]?.icon ?? 'pencil-01');
    const message = checking
      ? 'Checking with Mojang…'
      : (status?.ok === false ? status.error : status?.message) ?? '';

    // The empty box keeps the placeholder line rather than showing nothing, so
    // the panel does not resize as the user types.
    fill(statusHost, h('div.row', {
      style: { gap: '6px', alignItems: 'center', color: TONE_COLOR[tone], fontSize: 'var(--fs-sm)' }
    }, [
      icon(iconName, { size: 14 }),
      h('span', message || 'Pick a name that is not already taken.')
    ]));
    hydrate(statusHost);

    // Enabled on a failed check as well as a clear one. The rename itself is
    // the authority - this endpoint is only a courtesy - so a check that could
    // not be made must not be the thing that stops someone renaming.
    const value = input.value.trim();
    submit.disabled = submitting || checking || !value || BLOCKING.has(status?.status);
  }

  fill(body, [
    h('div.row', {
      style: {
        gap: '10px',
        alignItems: 'center',
        padding: '10px 12px',
        background: 'var(--crust)',
        border: '1px solid var(--surface1)',
        borderRadius: 'var(--r-md)',
        marginBottom: '16px'
      }
    }, [
      icon('onboarding-account', { size: 18 }),
      h('span.grow', [
        h('b', { style: { display: 'block', fontWeight: '500' } }, account.username || `Account ${accountId}`),
        h('span.muted', { style: { fontSize: 'var(--fs-xs)' } }, 'Current username')
      ]),
      account.uuid
        ? h('span.muted', { style: { fontSize: 'var(--fs-xs)' } }, format.truncateMiddle(account.uuid, 8, 4))
        : null
    ]),

    nameField.el,
    statusHost,

    h('div.callout.callout--info', { style: { marginTop: '16px' } }, [
      icon('info-circle', { size: 15 }),
      h('div', [
        h('b', 'Mojang allows this once every 30 days'),
        h('p', 'The old name is released and can be taken by someone else straight away, so it will not come back if you change your mind.')
      ])
    ])
  ]);
  hydrate(body);

  dialog.setFooter([
    h('div.grow.muted', { style: { fontSize: 'var(--fs-sm)' } }, 'Only this account will change.'),
    h('button.btn', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
    submit
  ]);

  paint();
  setTimeout(() => input.focus(), 0);

  // ------------------------------------------------------------ running

  async function run() {
    const wanted = input.value.trim();
    // The same rule the button was enabled under, re-checked here because the
    // button's state is a rendering of it rather than the rule itself.
    if (submitting || checking || !wanted || BLOCKING.has(status?.status)) return;

    const confirmed = await confirmDialog({
      title: `Rename to ${wanted}?`,
      message: `${account.username || `Account ${accountId}`} becomes ${wanted}.`,
      detail: status?.status === 'AVAILABLE'
        ? 'Mojang will not let this account be renamed again for 30 days, and the current name is released straight away.'
        : 'Mojang would not confirm that this name is free, so the change may be refused. It will not let this account be renamed again for 30 days either way.',
      confirmLabel: 'Change it',
      danger: true
    });
    if (!confirmed) return;

    submitting = true;
    paint();
    const handle = toast.info('Renaming…', `Asking Mojang to change ${account.username || 'this account'}.`, {
      id: 'account-rename', timeout: 0
    });

    try {
      const result = await bridge.invoke('accounts.changeName', { id: accountId, name: wanted });
      handle.close();
      toast.ok('Username changed', `${result.previous} is now ${result.username}.`);
      await reload();
      dialog.close();
    } catch (err) {
      handle.close();
      // A refusal is a normal outcome here rather than a bug - the 30-day
      // cooldown is the usual one - so it is pinned to the field the user is
      // looking at as well as raised as a toast. The status line above keeps
      // showing the check result, which is what withholds the button.
      const message = err?.message ?? 'Could not change that username.';
      nameField.setError(message);
      toast.fromError(err, 'Could not change that username');
    } finally {
      submitting = false;
      paint();
    }
  }

  return dialog;
}
