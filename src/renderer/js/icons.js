/**
 * Icons.
 *
 * The SVGs under assets/icons are stroke-based line art using `currentColor`, so
 * an icon inherits the colour and size of whatever it sits in. They are fetched
 * once and cached as markup, then injected into any element carrying
 * `data-icon="name"`.
 *
 * Lazy fetching rather than a generated sprite sheet: a session uses perhaps
 * thirty of the seventy-seven, and over flora://app a fetch is a local file read,
 * so preloading all of them would be work nobody asked for.
 */

const cache = new Map();
const pending = new Map();

/** Where the icon set lives, relative to the app origin. */
const BASE = 'assets/icons';

/**
 * Inject every `[data-icon]` element inside `root` that has not been filled yet.
 *
 * Synchronous-looking so callers can build a tree and call it once at the end;
 * the fetches resolve a tick later and fill in place.
 */
export function hydrate(root = document) {
  const targets = root.querySelectorAll('[data-icon]:not([data-icon-done])');
  for (const el of targets) {
    el.dataset.iconDone = '1';
    const name = el.dataset.icon;
    // `data-icon-art` marks the handful of files that are drawn pictures rather
    // than line icons. They carry their own colours, so they must not get
    // `.icon` - that class flattens everything inside to `currentColor`.
    el.classList.add(el.dataset.iconArt === '1' ? 'illus' : 'icon');

    load(name).then((markup) => {
      // The element may have been removed while the fetch was in flight.
      if (!el.isConnected) return;
      el.innerHTML = markup;
    }).catch(() => {
      // A missing icon is a cosmetic problem; leave the space and move on.
      delete el.dataset.iconDone;
    });
  }
}

/** Fetch and cache one icon's inner markup. */
export function load(name) {
  if (cache.has(name)) return Promise.resolve(cache.get(name));
  if (pending.has(name)) return pending.get(name);

  const request = fetch(`${BASE}/${encodeURIComponent(name)}.svg`)
    .then((response) => {
      if (!response.ok) throw new Error(`No icon named "${name}".`);
      return response.text();
    })
    .then((text) => {
      const markup = normalise(text);
      cache.set(name, markup);
      pending.delete(name);
      return markup;
    })
    .catch((err) => {
      pending.delete(name);
      throw err;
    });

  pending.set(name, request);
  return request;
}

/**
 * Reduce an icon file to the part worth inlining.
 *
 * The wrapper is rebuilt with a relative size so the caller's element decides
 * how large the icon is, but it is *kept*: a `<path>` injected into an HTML
 * `<span>` is not an SVG element and renders as nothing at all. Everything the
 * file declares about its own geometry - the viewBox, the fill, the line caps -
 * is carried across, since those are what the artwork was drawn against.
 */
function normalise(text) {
  const match = /<svg([^>]*)>([\s\S]*?)<\/svg>/i.exec(text);
  if (!match) return text;

  const root = match[1]
    .replace(/\bwidth\s*=\s*"[^"]*"/i, '')
    .replace(/\bheight\s*=\s*"[^"]*"/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return `<svg ${root} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">${match[2].trim()}</svg>`;
}

/**
 * An icon element.
 *
 * `size` is in pixels; omit it and the CSS in base.css decides, which is what
 * most call sites want. `art` selects a full-colour illustration instead of a
 * line icon - see `data-icon-art` in `hydrate`.
 */
export function icon(name, { size = null, className = '', title = null, art = false } = {}) {
  const el = document.createElement('span');
  el.className = className;
  el.dataset.icon = name;
  if (art) el.dataset.iconArt = '1';
  if (size) {
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
  }
  if (title) {
    el.title = title;
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', title);
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  hydrate(el.parentNode ?? document);
  return el;
}

/**
 * The flora mark.
 *
 * `art`, because the mark carries its own gradient rather than taking
 * `currentColor` - see assets/icons/flora-mark.svg. That gradient is built from
 * `var(--accent)`, so the mark follows the theme on its own and there is
 * nothing to re-render when Settings changes the accent.
 */
export function mark(size, className = '') {
  return icon('flora-mark', { size, className, art: true });
}

/** Names known to ship with the app, for the icon picker in Settings. */
export const NAMES = [
  'alert-circle', 'alert-triangle', 'announcement-01', 'arrow-left', 'arrow-right',
  'bar-chart-square-02', 'bell-01', 'brush-01', 'calendar', 'check', 'check-circle',
  'chevron-down', 'chevron-right', 'chevrons-left', 'chevrons-right', 'claude',
  'clipboard-check',
  'clock-rewind', 'code-snippet-02', 'colors', 'copy-01', 'curseforge', 'database-01',
  'discord', 'dots-grid', 'dots-vertical', 'download-01', 'download-cloud-02', 'eye',
  'file-02', 'file-plus-02', 'file-x-02', 'flora-mark', 'folder', 'folder-check',
  'folder-download', 'globe-01', 'help-circle', 'info-circle', 'key-01', 'layout-top',
  'line-chart-up-01', 'link-03', 'link-external-01', 'loading-02', 'log-out-01',
  'maximize-01', 'message-text-square-01', 'minus', 'modrinth', 'moon-01',
  'onboarding-account', 'onboarding-complete', 'onboarding-control', 'onboarding-language',
  'onboarding-preferences', 'onboarding-run', 'onboarding-talk', 'onboarding-welcome', 'paint-pour', 'paragraph-wrap',
  'pencil-01', 'play', 'plus', 'refresh-ccw-02', 'refresh-cw-01', 'rocket-02',
  'search-md', 'settings-01', 'settings-02', 'settings-04', 'shield-01', 'sliders-04',
  'square', 'terminal', 'trash-01', 'users-01', 'x', 'x-close', 'zap'
];
