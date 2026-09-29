/**
 * DOM helpers.
 *
 * A dozen small functions instead of a framework. The UI is a handful of views
 * over a data set that changes on events, and a template library would cost
 * more in indirection than it saves here.
 *
 * The one thing worth knowing: `h()` sets properties directly rather than
 * parsing HTML, so a username containing `<script>` is text and never markup.
 * Nothing in this app ever assigns to `innerHTML` with user data.
 */

/**
 * Create an element.
 *
 *   h('div.card', { onclick }, [h('span', 'hi')])
 *
 * The tag accepts `tag.class1.class2` shorthand. Children may be a node, a
 * string, or an array of either; null and undefined are skipped so a conditional
 * child can be written inline as `cond && h(...)`.
 */
export function h(tag, props = null, children = null) {
  const [name, ...classes] = String(tag).split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');

  if (props && typeof props === 'object' && !isNode(props) && !Array.isArray(props)) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'html') el.innerHTML = value;              // only ever used with literals
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'value') el.value = value;
      else if (key === 'checked' || key === 'disabled' || key === 'selected') el[key] = Boolean(value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  } else if (props != null) {
    children = props;
  }

  append(el, children);
  return el;
}

function isNode(value) {
  return value instanceof Node;
}

/** Append a child, a string, or an array of either. Nulls are skipped. */
export function append(parent, children) {
  if (children == null || children === false) return parent;

  if (Array.isArray(children)) {
    for (const child of children) append(parent, child);
    return parent;
  }

  parent.appendChild(isNode(children) ? children : document.createTextNode(String(children)));
  return parent;
}

/** Replace an element's contents. */
export function fill(parent, children) {
  parent.replaceChildren();
  append(parent, children);
  return parent;
}

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/** Delegated listener: fire when the event's target matches `selector`. */
export function delegate(root, type, selector, handler) {
  root.addEventListener(type, (event) => {
    const match = event.target.closest(selector);
    if (match && root.contains(match)) handler(event, match);
  });
  return () => root.removeEventListener(type, handler);
}

/** Class toggling that reads as intent rather than as string manipulation. */
export function setClass(el, name, on) {
  if (!el) return;
  el.classList.toggle(name, Boolean(on));
}

/** An element that is only in the DOM while `visible` is true. */
export function toggle(el, visible) {
  if (!el) return;
  el.hidden = !visible;
  return el;
}

/** Wait for the next frame, so a mutation is painted before the next one. */
export const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Coalesce rapid calls into one on the next frame.
 *
 * Used by anything that redraws a list on a burst of events - a hundred
 * accounts finishing a check at once should cause one render, not a hundred.
 */
export function raf(fn) {
  let scheduled = false;
  let lastArgs = null;

  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  };
}

/** Trailing-edge debounce, in milliseconds. */
export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Delegated keyboard activation for elements with role="button". */
export function clickable(el) {
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      el.click();
    }
  });
  return el;
}

/** Build a DocumentFragment from a list of nodes, for cheap bulk insertion. */
export function fragment(children) {
  const frag = document.createDocumentFragment();
  append(frag, children);
  return frag;
}

/** Focus the first focusable element inside a container. */
export function focusFirst(container) {
  const target = container.querySelector(
    'input:not([type=hidden]):not([disabled]), select, textarea, button:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  target?.focus();
  return target;
}

/**
 * Keep Tab inside `container` while it is open.
 *
 * A modal that lets focus escape to the window controls behind it is a modal
 * that is not really modal.
 */
export function trapFocus(container) {
  const onKey = (event) => {
    if (event.key !== 'Tab') return;
    const focusable = [...container.querySelectorAll(
      'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )].filter((el) => el.offsetParent !== null || el === document.activeElement);

    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKey);
  return () => container.removeEventListener('keydown', onKey);
}
