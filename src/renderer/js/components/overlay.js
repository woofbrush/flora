/**
 * Overlays: modals, context menus, confirmations.
 *
 * All three mount into #overlays rather than into a view, so a view that
 * re-renders or is replaced cannot orphan an open dialog. Each returns a handle
 * with `close()`, and every one traps focus and closes on Escape.
 *
 * Only one *modal* is open at a time - stacking them is a way to lose track of
 * what is being confirmed. Menus are separate and can appear over a modal.
 */
import { h, fill, nextFrame, focusFirst, trapFocus, clickable } from '../dom.js';
import { icon, hydrate } from '../icons.js';

const host = () => document.getElementById('overlays');

let currentModal = null;

/**
 * Open a modal.
 *
 * `body` is a node or an array of nodes. `actions` is a list of
 * `{ label, tone, onClick, close }`; `close: false` keeps the modal open so a
 * form can report a validation error without the user losing what they typed.
 */
export function modal({
  title,
  subtitle = null,
  body = null,
  actions = [],
  size = null,
  dismissible = true,
  onClose = null,
  initialFocus = true
} = {}) {
  closeModal();

  const scrim = h('div.scrim', { role: 'presentation' });
  const panel = h(`div.modal${size ? `.modal--${size}` : ''}`, {
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': typeof title === 'string' ? title : 'Dialog'
  });

  const footer = actions.length ? h('footer.modal__footer') : null;

  const header = h('header.modal__header', [
    // `grow`, so the close button is pushed to the far edge of the header
    // instead of sitting against the end of the title. The stylesheet already
    // carries a `.modal__header .grow` rule for it.
    h('div.grow', [
      h('h2', title),
      subtitle ? h('p', subtitle) : null
    ]),
    dismissible
      ? h('button.btn.btn--ghost.btn--icon', {
          type: 'button',
          'aria-label': 'Close',
          onclick: () => close()
        }, [icon('x', { size: 15 })])
      : null
  ]);

  panel.append(header, h('div.modal__body', body ?? null));
  if (footer) panel.appendChild(footer);

  if (footer) {
    fill(footer, actions.map((action) => h(
      `button.btn${action.tone ? `.btn--${action.tone}` : ''}`,
      {
        type: 'button',
        disabled: action.disabled,
        onclick: async (event) => {
          if (!action.onClick) { close(); return; }
          const button = event.currentTarget;
          // A slow action gets a busy button rather than a second click.
          const restore = action.busyLabel ? label(button, action.busyLabel) : null;
          button.disabled = true;
          try {
            const result = await action.onClick({ close, button });
            if (result === false) return;          // the handler declined to close
            if (action.close !== false) close();
          } finally {
            button.disabled = false;
            restore?.();
          }
        }
      },
      action.label
    )));
  }

  host().appendChild(scrim);

  const releaseTrap = trapFocus(panel);

  function onKeydown(event) {
    if (event.key === 'Escape' && dismissible) {
      event.stopPropagation();
      close();
    }
  }

  // Only a click on the scrim itself dismisses; a click that started inside the
  // panel and ended on the scrim (a drag that selected text) must not.
  function onScrimDown(event) {
    if (event.target === scrim && dismissible) close();
  }

  document.addEventListener('keydown', onKeydown, true);
  scrim.addEventListener('mousedown', onScrimDown);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    releaseTrap();
    document.removeEventListener('keydown', onKeydown, true);
    scrim.remove();
    if (currentModal?.close === close) currentModal = null;
    onClose?.();
  }

  scrim.appendChild(panel);
  // An overlay is built outside every view, so no view's own hydrate pass will
  // ever reach it: the header's close button and whatever the body carries would
  // stay as empty boxes. The call has to come after the panel is in the
  // document, because a fill that lands while the element is still detached is
  // dropped - `hydrate` skips anything that is no longer connected by the time
  // its fetch resolves.
  hydrate(panel);
  if (initialFocus) nextFrame().then(() => focusFirst(panel));

  const handle = {
    close,
    element: panel,
    setBody: (next) => {
      const body = panel.querySelector('.modal__body');
      fill(body, next);
      hydrate(body);
    },
    setFooter: (next) => {
      if (!footer) return;
      fill(footer, next);
      hydrate(footer);
    },
    setTitle: (next) => { panel.querySelector('.modal__header h2').textContent = next; },
    setSubtitle: (next) => {
      const el = panel.querySelector('.modal__header p');
      if (el) el.textContent = next;
      else panel.querySelector('.modal__header div').appendChild(h('p', next));
    }
  };

  currentModal = handle;
  return handle;
}

/** Swap a button's label for a busy one, returning a restore function. */
function label(button, text) {
  const original = button.textContent;
  button.textContent = text;
  return () => { button.textContent = original; };
}

export function closeModal() {
  currentModal?.close();
}

export function modalOpen() {
  return currentModal !== null;
}

/**
 * A yes/no confirmation.
 *
 * Resolves true when confirmed. `danger` turns the confirm button red, which is
 * reserved for actions that destroy something.
 */
export function confirm({
  title,
  message,
  detail = null,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false
} = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (value) => { if (!answered) { answered = true; resolve(value); } };

    modal({
      title,
      size: 'slim',
      body: h('div', [
        h('p', message),
        detail ? h('p.muted', detail) : null
      ]),
      actions: [
        { label: cancelLabel, onClick: () => done(false) },
        { label: confirmLabel, tone: danger ? 'danger' : 'primary', onClick: () => done(true) }
      ],
      onClose: () => done(false)
    });
  });
}

/**
 * A single-field prompt.
 *
 * Resolves the trimmed string, or null when cancelled. An empty value resolves
 * as `''` rather than null, because "clear this field" is a real intent.
 */
export function prompt({
  title,
  message = null,
  label: fieldLabel = null,
  value = '',
  placeholder = '',
  confirmLabel = 'Save',
  validate = null
} = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (result) => { if (!answered) { answered = true; resolve(result); } };

    const input = h('input.input', {
      type: 'text',
      value,
      placeholder,
      spellcheck: 'false',
      autocomplete: 'off'
    });

    const errorLine = h('p.field__error', { hidden: true });
    const dialog = modal({
      title,
      size: 'slim',
      body: h('div', [
        message ? h('p.muted', message) : null,
        fieldLabel ? h('label.field__label', fieldLabel) : null,
        input,
        errorLine
      ]),
      actions: [
        { label: 'Cancel', onClick: () => done(null) },
        {
          label: confirmLabel,
          tone: 'primary',
          close: false,
          onClick: () => {
            const next = input.value.trim();
            const problem = validate?.(next) ?? null;
            if (problem) {
              errorLine.textContent = problem;
              errorLine.hidden = false;
              input.focus();
              return false;
            }
            done(next);
            dialog.close();
          }
        }
      ],
      onClose: () => done(null)
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        dialog.element.querySelector('.modal__footer .btn--primary').click();
      }
    });

    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

// ---------------------------------------------------------------- menus

let openMenu = null;

/**
 * A context menu anchored to an element.
 *
 * Positioned to stay inside the window: a menu opened on the last row of a
 * table would otherwise render off the bottom and look broken.
 */
export function menu(anchor, items, { align = 'start', onClose = null } = {}) {
  closeMenu();

  const list = h('div.menu', { role: 'menu' });
  fill(list, items.map((item) => {
    if (item.separator) return h('div.menu__sep');
    if (item.header) return h('div.menu__label', item.label);

    return h(`button.menu__item${item.danger ? '.menu__item--danger' : ''}`, {
      type: 'button',
      role: 'menuitem',
      disabled: item.disabled,
      'data-tip': item.hint ?? null,
      onclick: () => {
        closeMenu();
        item.onClick?.();
      }
    }, [
      item.icon ? icon(item.icon, { size: 18 }) : null,
      h('span.grow', item.label),
      item.shortcut ? h('kbd', item.shortcut) : null,
      item.checked ? icon('check', { size: 14 }) : null
    ]);
  }));

  const rect = anchor.getBoundingClientRect();
  list.style.visibility = 'hidden';
  host().appendChild(list);
  // Same reason as a modal: the items are built detached and nothing else
  // hydrates this subtree. Before the measurement below, so the `.icon` class
  // that sets each element's box is already applied when it is measured.
  hydrate(list);

  // Measure first, then place - the menu's height depends on its contents.
  const { width, height } = list.getBoundingClientRect();
  const gutter = 8;
  const maxX = window.innerWidth - width - gutter;
  const maxY = window.innerHeight - height - gutter;

  let x = align === 'end' ? rect.right - width : rect.left;
  x = Math.max(gutter, Math.min(x, maxX));

  let y = rect.bottom + 4;
  if (y > maxY) y = Math.max(gutter, rect.top - height - 4);
  y = Math.max(gutter, Math.min(y, maxY));

  list.style.left = `${Math.round(x)}px`;
  list.style.top = `${Math.round(y)}px`;
  list.style.visibility = '';

  // Focus the first live item so the menu is usable from the keyboard the
  // moment it opens - arrow keys and Enter then work with no extra wiring.
  list.querySelector('button:not([disabled])')?.focus();

  const scrim = h('div.menu-scrim', { onmousedown: () => closeMenu() });
  const onKey = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); closeMenu(); }
  };
  const onScroll = () => closeMenu();

  host().appendChild(scrim);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onScroll);
  window.addEventListener('scroll', onScroll, true);

  function close() {
    scrim.remove();
    list.remove();
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('scroll', onScroll, true);
    if (openMenu?.close === close) openMenu = null;
    // Runs whichever way the menu went away - Escape, a click outside, a
    // scroll, or an item. A control that reports itself as expanded has to be
    // told, and it cannot tell by watching for the element's removal.
    onClose?.();
  }

  openMenu = { close };
  return { close, element: list };
}

export function closeMenu() {
  openMenu?.close();
}

/** Close whichever overlay is on top: menu first, then modal. */
export function closeTop() {
  if (openMenu) { closeMenu(); return true; }
  if (currentModal) { closeModal(); return true; }
  return false;
}

export const anyOpen = () => openMenu !== null || currentModal !== null;

/**
 * A button that opens a menu.
 *
 * Wired here rather than at each call site so every dropdown in the app opens
 * the same way - including from the keyboard.
 */
export function menuButton(content, items, { className = 'btn btn--ghost btn--icon', align = 'start', label: aria = 'More actions' } = {}) {
  const button = h(`button.${className}`, { type: 'button', 'aria-label': aria, 'aria-haspopup': 'menu' }, content);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    menu(button, typeof items === 'function' ? items() : items, { align });
  });
  clickable(button);
  return button;
}

/**
 * A dropdown: the reference's select box.
 *
 * A native `<select>` cannot be styled past its closed state, because Windows
 * draws the popup itself. That is why one reads as a system control sitting in
 * the middle of a themed page no matter what is done to the element. This is a
 * button wearing the trigger's geometry, opening the same `.menu` every other
 * dropdown in flora uses - so the list matches the menus, the keyboard
 * behaviour comes for free, and the whole thing follows the accent.
 *
 * `options` are `{ value, label, icon?, hint? }`, or bare strings for the
 * common case where the value is its own label.
 */
export function dropdown({
  options = [], value = null, onChange = null,
  label = null, icon: leading = null, wide = false, align = 'start', disabled = false, width = null
} = {}) {
  const read = (list) => list.map((option) => (
    typeof option === 'string' ? { value: option, label: option } : option
  ));

  let entries = read(options);
  let current = value;
  const text = h('span.select__text');

  const trigger = h(`button.select${wide ? '.select--wide' : ''}`, {
    type: 'button',
    disabled,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': label ?? null,
    style: width ? { minWidth: `${width}px` } : null
  }, [
    leading ? icon(leading, { size: 14 }) : null,
    text,
    icon('chevron-down', { size: 14, className: 'select__caret' })
  ]);

  const paint = () => {
    const found = entries.find((entry) => entry.value === current);
    text.textContent = found?.label ?? '—';
    trigger.dataset.empty = found ? 'false' : 'true';
  };
  paint();

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    trigger.setAttribute('aria-expanded', 'true');
    menu(trigger, entries.map((entry) => ({
      label: entry.label,
      icon: entry.icon ?? null,
      hint: entry.hint ?? null,
      checked: entry.value === current,
      onClick: () => {
        if (entry.value === current) return;
        current = entry.value;
        paint();
        onChange?.(current);
      }
    })), {
      align,
      // However the menu closed - Escape, a click outside, an item - the
      // trigger has to stop claiming to be expanded.
      onClose: () => trigger.setAttribute('aria-expanded', 'false')
    });
  });

  clickable(trigger);

  return {
    el: trigger,
    get value() { return current; },

    /** Set the value without firing `onChange` - for a caller syncing state. */
    set(next) { current = next; paint(); },

    /**
     * Replace the option list.
     *
     * The activity log's scopes are whatever the loaded rows happen to contain,
     * so they change as rows arrive; a list captured once when the toolbar was
     * built would be stale within seconds of opening the page.
     */
    setOptions(next, selected = current) {
      entries = read(next);
      current = selected;
      paint();
    }
  };
}
