/**
 * Shared view scaffolding.
 *
 * Every view is the same shape: a header with a title and a row of actions,
 * then a scrolling body. `shell()` builds that and hands back the pieces a view
 * needs, so no view has to remember the class names or the order.
 *
 * `bag()` is the other half. A view subscribes to store topics and bridge
 * channels on mount and must drop every one of them on destroy; collecting them
 * in one place means a view cannot forget one and leak a listener that fires
 * against a detached DOM tree.
 */
import { h } from '../dom.js';
import { icon } from '../icons.js';

export function shell({ title, subtitle = null, flush = false, page = null }) {
  const titleEl = h('div.view__title', [h('h1', title), subtitle ? h('p', subtitle) : null]);
  const actionsEl = h('div.view__actions');
  const body = h(`div.view__body${flush ? '.view__body--flush' : ''}`);
  const el = h('div.view', [h('header.view__header', [titleEl, actionsEl]), body]);

  const host = page === 'narrow' ? h('div.page.page--narrow') : page === 'wide' ? h('div.page') : null;
  if (host) body.appendChild(host);

  return {
    el,
    /** Where a view's own markup goes: the page wrapper when there is one. */
    body: host ?? body,
    actions: actionsEl,

    /** Append action controls. Nulls are skipped, so `cond && node` works. */
    add(...nodes) {
      for (const node of nodes) if (node) actionsEl.appendChild(node);
      return this;
    },

    setSubtitle(text) {
      const p = titleEl.querySelector('p');
      if (p) p.textContent = text;
      else if (text) titleEl.appendChild(h('p', text));
      return this;
    },

    /** Put the shell into a container and return the root element. */
    mount(container) {
      container.replaceChildren(el);
      return el;
    }
  };
}

/**
 * A collection of disposables with one `dispose()`.
 *
 * `bag.add(fn)` takes anything that returns an unsubscribe function - which is
 * both `store.subscribe` and `bridge.on` - and stores the result.
 */
export function bag() {
  const disposers = [];
  return {
    add(disposer) {
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    dispose() {
      // Reverse order, newest first: a listener added later may depend on one
      // added earlier being still alive while it tears down.
      for (const dispose of disposers.reverse()) {
        try { dispose(); } catch { /* teardown must not throw */ }
      }
      disposers.length = 0;
    }
  };
}

/**
 * A small labelled field.
 *
 * `hint` and `error` are both rendered up front and shown as needed, so a
 * validation message does not shift the layout when it appears.
 */
export function field({ label, control, hint = null, error = null }) {
  const hintEl = hint ? h('p.field__hint', hint) : null;
  const errorEl = h('p.field__error', { hidden: true });

  const el = h('div.field', [
    label ? h('label.field__label', label) : null,
    control,
    hintEl,
    errorEl
  ]);

  return {
    el,
    control,
    hint: hintEl,
    setError(message) {
      errorEl.textContent = message ?? '';
      errorEl.hidden = !message;
      control.setAttribute('aria-invalid', message ? 'true' : 'false');
    }
  };
}

/** A stat card for the dashboard. */
export function statCard({ label, value, meta = null, tone = null, icon: name = null }) {
  return h(`div.stat${tone ? `.stat--${tone}` : ''}`, [
    h('div.stat__label', [name ? icon(name, { size: 13 }) : null, label]),
    h('div.stat__value', value),
    meta ? h('div.stat__meta', meta) : null
  ]);
}

/**
 * A search box, as it appears in a page header.
 *
 * The reference's search field is an ordinary text input with a magnifier in
 * front of it and a clear button behind it - not a separate control. Building
 * it here rather than per view is what keeps a page's search box from drifting
 * into its own shape, which is the usual way a search field stops matching the
 * fields underneath it.
 *
 * The clear button is only in the tree once there is something to clear, so the
 * trailing padding never leaves a gap around an invisible control.
 */
export function searchField({ placeholder = 'Search…', label = null, value = '', onInput = null, width = null } = {}) {
  const input = h('input', {
    type: 'search',
    placeholder,
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': label ?? placeholder,
    value
  });

  const clear = h('button.searchfield__clear', {
    type: 'button',
    'aria-label': 'Clear search',
    hidden: true,
    onclick: () => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }
  }, [icon('x-close', { size: 15 })]);

  const el = h('div.searchfield', { style: width ? { width: `${width}px` } : null }, [
    icon('search-md', { size: 16 }),
    input,
    clear
  ]);

  const sync = () => { clear.hidden = input.value === ''; };
  input.addEventListener('input', sync);
  if (onInput) input.addEventListener('input', () => onInput(input.value));

  return {
    el,
    input,
    clear,
    sync,
    /**
     * Empty the box without going through the input handler.
     *
     * A caller clearing the field as part of a wider reset has already set its
     * own copy of the query and is about to repaint; letting the debounced
     * handler fire as well would repaint a second time for the same result.
     */
    reset() {
      input.value = '';
      sync();
    }
  };
}

/**
 * One setting: icon, title, description, and the control on the right.
 *
 * This is the reference's `settings_row`, and it is the unit a settings page is
 * built out of - every row the same height and the same internal rhythm, so a
 * long page stays scannable.
 *
 * `control` may be a node or an array. An array is for the rows that carry a
 * second, smaller control beside the real one - the revert button on a value
 * that has been changed away from its default - which belongs on the same line
 * rather than stacked under it.
 */
export function settingRow({ icon: name, title, description = null, control = null, onClick = null, dim = false }) {
  const el = h(`div.rowcard${onClick ? '' : '.rowcard--static'}`, {
    style: dim ? { opacity: '0.4' } : null,
    role: onClick ? 'button' : null,
    tabindex: onClick ? '0' : null
  }, [
    name ? h('span.rowcard__icon', [icon(name, { size: 20 })]) : null,
    h('div.rowcard__text', [h('b', title), description ? h('span', description) : null]),
    control ? h('div.rowcard__control', Array.isArray(control) ? control : [control]) : null
  ]);

  if (onClick) {
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(event); }
    });
  }
  return el;
}
