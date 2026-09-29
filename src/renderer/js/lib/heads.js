/**
 * Minecraft head and skin rendering.
 *
 * The first choice is always the skin the backend has already cached: it is
 * drawn locally, costs nothing, and needs no network. That covers every account
 * whose skin has been fetched.
 *
 * For the ones it does not cover - a row imported a moment ago, an offline-mode
 * name, an account whose skin was never downloaded - there is a second source.
 * `head/<name>.png` is a flora:// URL served by the main process, which fetches
 * a head from a public head service once per username and keeps it on disk. So
 * the request happens behind the app's own origin, the renderer's CSP still
 * says `img-src 'self'`, and the second view of a name is a local file. It can
 * be switched off in Settings > Appearance; `usesService()` is that switch.
 *
 * The coordinates for the local path are the standard skin layout. In the 64x64
 * format:
 *
 *   head   8x8  @ (8,8)     hat overlay      @ (40,8)
 *   body   8x12 @ (20,20)   jacket overlay   @ (20,36)
 *   r.arm  4x12 @ (44,20)   sleeve overlay   @ (44,36)
 *   l.arm  4x12 @ (36,52)   sleeve overlay   @ (52,52)
 *   r.leg  4x12 @ (4,20)    trouser overlay  @ (4,36)
 *   l.leg  4x12 @ (20,52)   trouser overlay  @ (4,52)
 *
 * Legacy 64x32 skins have no leg regions; the arms are mirrored down instead,
 * which is what the game itself does.
 */
import { setting } from '../store.js';

/** Decoded images, keyed by content hash. */
const images = new Map();
/** In-flight loads, so a list of identical hashes fetches once. */
const loading = new Map();

/** Resolve a content hash to a same-origin URL served by the main process. */
export function skinUrl(hash) {
  if (!hash || !/^[a-f0-9]{8,64}$/i.test(hash)) return null;
  return `skin/${hash}.png`;
}

/**
 * A username as a same-origin head URL, or null when it cannot be one.
 *
 * Usernames are 3-16 of `[A-Za-z0-9_]`; anything else - an empty string, a
 * display label, a name with a space in it - has no head to ask for and would
 * only produce a 404.
 */
export function headUrl(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(name)) return null;
  return `head/${encodeURIComponent(name.toLowerCase())}.png`;
}

/** Whether the head service may be used at all. */
const usesService = () => setting('appearance.headService', true) !== false;

/** Whether heads are drawn with the hat layer. */
const shaded = () => setting('appearance.headStyle', 'shaded') !== 'flat';

/**
 * Load and cache a skin image.
 *
 * Resolves to null when the hash is missing or the file has been evicted from
 * the cache, which callers treat as "draw a placeholder" rather than an error.
 */
export function loadSkin(hash) {
  if (!hash) return Promise.resolve(null);
  if (images.has(hash)) return Promise.resolve(images.get(hash));
  if (loading.has(hash)) return loading.get(hash);

  const url = skinUrl(hash);
  if (!url) return Promise.resolve(null);

  const request = new Promise((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => { images.set(hash, image); resolve(image); };
    image.onerror = () => resolve(null);
    image.src = url;
  }).finally(() => loading.delete(hash));

  loading.set(hash, request);
  return request;
}

/** Drop decoded images. Called when the backend clears its skin cache. */
export function forget(hash = null) {
  if (hash) images.delete(hash);
  else images.clear();
}

/**
 * Draw a source rectangle 1:1 into a destination, scaled.
 *
 * `imageSmoothingEnabled = false` is the whole trick: without it a 4x12 arm
 * drawn at 8x would come out blurred, and a blurred Minecraft skin reads as a
 * mistake rather than as pixel art.
 */
function blit(ctx, image, sx, sy, sw, sh, dx, dy, scale) {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, sx, sy, sw, sh, dx * scale, dy * scale, sw * scale, sh * scale);
}

function isLegacy(image) {
  return image.naturalHeight === 32;
}

/**
 * Render a head.
 *
 * `overlay` controls the hat layer, which is what makes a head recognisable for
 * anyone who wears one - so it is on by default.
 */
export function drawHead(canvas, image, { overlay = true } = {}) {
  const ctx = canvas.getContext('2d');
  const scale = canvas.width / 8;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!image) return false;

  blit(ctx, image, 8, 8, 8, 8, 0, 0, scale);
  if (overlay) blit(ctx, image, 40, 8, 8, 8, 0, 0, scale);
  return true;
}

/**
 * Render a full front-facing body.
 *
 * Used by the skin dialog, where showing the whole skin is the point: a head
 * alone cannot tell you whether the upload worked.
 */
export function drawBody(canvas, image, { overlay = true } = {}) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!image) return false;

  // The figure is 16 units wide (arm + body + arm) and 32 tall (head 8 + body
  // 12 + legs 12), which is 1:2 - so the canvas is sized to that ratio by the
  // caller and the scale is derived from the width.
  const scale = canvas.width / 16;
  const legacy = isLegacy(image);

  // Legs, or a mirrored copy of the arms on a 64x32 skin.
  const legs = legacy
    ? { r: [44, 20], l: [36, 20] }
    : { r: [4, 20], l: [20, 52] };
  const legOverlay = legacy
    ? { r: [44, 36], l: [36, 36] }
    : { r: [4, 36], l: [4, 52] };

  // Right side of the player appears on the viewer's left.
  blit(ctx, image, legs.r[0], legs.r[1], 4, 12, 0, 20, scale);
  blit(ctx, image, 20, 20, 8, 12, 4, 8, scale);
  blit(ctx, image, legs.l[0], legs.l[1], 4, 12, 12, 20, scale);

  if (overlay) {
    blit(ctx, image, legOverlay.r[0], legOverlay.r[1], 4, 12, 0, 20, scale);
    blit(ctx, image, 20, 36, 8, 12, 4, 8, scale);
    blit(ctx, image, legOverlay.l[0], legOverlay.l[1], 4, 12, 12, 20, scale);
  }

  blit(ctx, image, 44, 20, 4, 12, 0, 8, scale);
  blit(ctx, image, 36, 52, 4, 12, 12, 8, scale);

  if (overlay) {
    blit(ctx, image, 44, 36, 4, 12, 0, 8, scale);
    blit(ctx, image, 52, 52, 4, 12, 12, 8, scale);
  }

  blit(ctx, image, 8, 8, 8, 8, 4, 0, scale);
  if (overlay) blit(ctx, image, 40, 8, 8, 8, 4, 0, scale);

  return true;
}

/**
 * A head as an element, from whichever source can supply one.
 *
 * `size` is the CSS size; the canvas backing store is drawn at 4x so the pixel
 * art stays crisp on a high-DPI display without needing to know the device
 * ratio. The service path does not need that, because the PNG it gets back is
 * already at 128px, and `.mchead` samples it with `image-rendering: pixelated`.
 *
 * `overlay` is normally left null so the Appearance setting decides; it is a
 * parameter only for the few places that want the bare face regardless.
 */
export function headElement(hash, { name = null, size = 32, overlay = null, className = '' } = {}) {
  const url = hash ? null : (usesService() ? headUrl(name) : null);
  if (url) return serviceHead(url, { size, className, seed: name });

  const canvas = document.createElement('canvas');
  canvas.className = `mchead ${className}`.trim();
  canvas.width = 8 * 4;
  canvas.height = 8 * 4;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.setAttribute('aria-hidden', 'true');

  const drawOverlay = overlay ?? shaded();

  if (!hash) {
    // Seeded by the name, not left to the default: this is the path a head
    // takes when there is no stored skin to draw and the lookup service is off,
    // and a list of heads all reading "FL" in the same colour is a list nobody
    // can tell apart.
    drawPlaceholder(canvas, name);
    return canvas;
  }

  loadSkin(hash).then((image) => {
    if (!canvas.isConnected) return;
    if (!image) { drawPlaceholder(canvas, hash); return; }
    drawHead(canvas, image, { overlay: drawOverlay });
  });

  return canvas;
}

/**
 * A head from the local service route.
 *
 * An `<img>` rather than a canvas, because the file is already a PNG of the
 * right thing and decoding it into a canvas to redraw it would only lose the
 * browser's own image cache. If it fails to load - offline, or a name the
 * service does not know - it is replaced by the same placeholder the account
 * would have shown anyway, rather than being left as a broken image.
 */
function serviceHead(url, { size, className, seed }) {
  const image = document.createElement('img');
  image.className = `mchead ${className}`.trim();
  image.src = url;
  image.width = size;
  image.height = size;
  image.alt = '';
  image.decoding = 'async';
  image.setAttribute('aria-hidden', 'true');

  image.addEventListener('error', () => {
    if (!image.isConnected) return;
    const canvas = document.createElement('canvas');
    canvas.className = image.className;
    canvas.width = 8 * 4;
    canvas.height = 8 * 4;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    canvas.setAttribute('aria-hidden', 'true');
    drawPlaceholder(canvas, seed);
    image.replaceWith(canvas);
  });

  return image;
}

/** A body preview element, for the skin dialog. */
export function bodyElement(hash, { height = 220, overlay = null, className = '' } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = `mcbody ${className}`.trim();
  canvas.width = 16 * 6;
  canvas.height = 32 * 6;
  canvas.style.height = `${height}px`;
  canvas.style.width = `${height / 2}px`;
  canvas.setAttribute('aria-hidden', 'true');

  if (!hash) {
    drawPlaceholder(canvas, hash);
    return canvas;
  }

  loadSkin(hash).then((image) => {
    if (!canvas.isConnected) return;
    if (!image) { drawPlaceholder(canvas, hash); return; }
    drawBody(canvas, image, { overlay: overlay ?? shaded() });
  });

  return canvas;
}

/**
 * A deterministic stand-in for an account with no cached skin.
 *
 * Derived from the hash or name so the same account always gets the same
 * colour - a list of identical grey squares is much harder to scan than a list
 * of distinct ones, and it makes "this account has no skin" legible at a glance
 * rather than looking like a loading state.
 */
function drawPlaceholder(canvas, seed) {
  const ctx = canvas.getContext('2d');
  const text = String(seed ?? 'flora');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  const hueValue = Math.abs(hash) % 360;

  ctx.fillStyle = `hsl(${hueValue} 28% 26%)`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = `hsl(${hueValue} 38% 52%)`;
  ctx.font = `${Math.round(canvas.width * 0.34)}px "JetBrains Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?',
    canvas.width / 2, canvas.height / 2 + 1);
}

export const loaded = () => images.size;
