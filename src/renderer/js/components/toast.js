/**
 * Toasts.
 *
 * The app's acknowledgement that something happened. Toasts are for outcomes
 * the user did not ask to see in detail - "18 accounts imported", "that token
 * has expired" - and never for information the UI is already showing.
 *
 * Failures do not auto-dismiss. A success that vanishes after four seconds is
 * fine; an error that vanishes before it is read is the same as no error
 * message at all.
 */
import { h, fill, nextFrame } from '../dom.js';
import { icon } from '../icons.js';

const ICONS = {
  info: 'info-circle',
  ok: 'check-circle',
  warn: 'alert-triangle',
  error: 'alert-circle'
};

const DEFAULT_TIMEOUT = 4500;
const MAX_VISIBLE = 4;

let host = null;
const live = [];

function container() {
  if (!host) host = document.getElementById('toasts');
  return host;
}

/**
 * Show a toast.
 *
 * `actions` is a list of `{ label, onClick, primary }`. Clicking one dismisses
 * the toast, because an action button on a still-visible toast reads as "did
 * that work?".
 */
export function toast({
  tone = 'info',
  title,
  body = null,
  actions = [],
  timeout = null,
  id = null
} = {}) {
  const parent = container();
  if (!parent) return { close() {} };

  // The same id means "replace": a repeating error should update the toast that
  // is already there rather than stack a fifth copy of itself.
  if (id) {
    const existing = live.find((entry) => entry.id === id);
    if (existing) {
      existing.update({ tone, title, body, actions });
      return existing.handle;
    }
  }

  const text = h('div.toast__text', [
    h('b', title),
    body ? h('p', body) : null
  ]);

  const actionsHost = h('div.row', { style: { marginTop: '8px', gap: '6px' } });

  const el = h(`div.toast.toast--${tone}`, { role: tone === 'error' ? 'alert' : 'status' }, [
    h('span.toast__icon', [icon(ICONS[tone] ?? ICONS.info, { size: 16 })]),
    text,
    h('button.toast__close', {
      type: 'button',
      'aria-label': 'Dismiss',
      onclick: () => dismiss()
    }, [icon('x', { size: 13 })])
  ]);

  text.appendChild(actionsHost);

  let timer = null;
  let closed = false;

  function renderActions(list) {
    fill(actionsHost, list.map((action) => h(
      `button.btn.btn--sm${action.primary ? '.btn--primary' : ''}`,
      {
        type: 'button',
        onclick: () => {
          try { action.onClick?.(); } finally { dismiss(); }
        }
      },
      action.label
    )));
    actionsHost.hidden = list.length === 0;
  }

  function arm() {
    clearTimeout(timer);
    // Warnings and errors stay until dismissed; a notice gets a few seconds.
    const delay = timeout ?? (tone === 'error' || tone === 'warn' ? 0 : DEFAULT_TIMEOUT);
    if (delay > 0) timer = setTimeout(dismiss, delay);
  }

  function dismiss() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);

    // The exit animation is driven by an attribute, so a toast that is removed
    // by its own transition and one removed by the fallback timer both end up
    // in the same state.
    el.dataset.leaving = 'true';
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);

    const index = live.findIndex((entry) => entry.el === el);
    if (index !== -1) live.splice(index, 1);
  }

  const update = (patch) => {
    const nextTone = patch.tone ?? tone;
    el.className = `toast toast--${nextTone}`;
    el.querySelector('.toast__icon').replaceChildren(icon(ICONS[nextTone] ?? ICONS.info, { size: 16 }));
    fill(text, [
      h('b', patch.title ?? title),
      patch.body ? h('p', patch.body) : null,
      actionsHost
    ]);
    renderActions(patch.actions ?? []);
    // Restart the dismissal clock: the replacement is a new thing to read.
    el.removeAttribute('data-leaving');
    arm();
  };

  const handle = { close: dismiss, element: el };

  renderActions(actions);
  parent.appendChild(el);
  live.push({ id, el, update, handle });

  // Trim from the oldest end, so a burst cannot fill the corner of the screen.
  while (live.length > MAX_VISIBLE) live[0].handle.close();

  arm();
  return handle;
}

export const info = (title, body, extra) => toast({ tone: 'info', title, body, ...extra });
export const ok = (title, body, extra) => toast({ tone: 'ok', title, body, ...extra });
export const warn = (title, body, extra) => toast({ tone: 'warn', title, body, ...extra });
export const error = (title, body, extra) => toast({ tone: 'error', title, body, ...extra });

/**
 * Turn a rejected promise into a toast.
 *
 * Used wherever a call would otherwise become an unhandled rejection. An
 * `AbortError` is silent: it means the user navigated away, which is not a
 * failure worth reporting.
 */
export function fromError(err, title = 'Something went wrong') {
  if (err?.name === 'AbortError') return null;
  return error(title, err?.message ?? String(err));
}

export function clear() {
  for (const entry of [...live]) entry.handle.close();
}

export const count = () => live.length;
