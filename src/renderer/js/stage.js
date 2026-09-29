/**
 * The animated backdrop.
 *
 * A slow mesh gradient sitting behind the whole app, offset a little by the
 * pointer. The motion is deliberately small: the backdrop should read as depth,
 * not as something moving. If it is noticed at all it is noticed as the window
 * feeling less flat, which is the whole point.
 *
 * The reference client does this with a photograph panned inside an overscanned
 * crop. flora has no photograph, so the art is drawn instead - soft colour
 * fields in the brand's own violets. Same motion, same maths, an asset that
 * scales to any window and ships as a few hundred bytes of code.
 *
 * Rendering is split in two:
 *
 *   - The colour fields are painted once into an offscreen canvas at
 *     `SCALE` times the viewport, and repainted only on resize.
 *   - Each frame blits that offscreen canvas at an offset. One drawImage per
 *     frame is cheap enough to run at 30fps indefinitely without touching the
 *     main thread's budget.
 *
 * Nothing here runs when the user has motion reduced or has turned the dynamic
 * background off; in that case a single static frame is painted and the loop
 * never starts.
 */

/** Overscan. The art is drawn this much larger than the window so panning can
 *  never expose an edge. Matches the reference client's crop scale. */
const SCALE = 1.10;

/** How much of the viewport the art shifts at full deflection. Small on
 *  purpose - 1% of the width reads as parallax, 5% reads as a bug. */
const STRENGTH = 0.01;

/** Per-frame easing toward the pointer, and the frame interval. The reference
 *  runs 0.12 at 30fps; the lag that produces is what makes the motion feel
 *  weighted rather than glued to the cursor. */
const STEP = 0.12;
const FRAME_MS = 33;

/** Below this the remaining distance is not worth a frame. */
const SETTLE = 0.002;

/** Colour fields, in fractions of the art. The first is the brightest and sits
 *  where the vignette's spotlight is, so the two agree about where the light is
 *  coming from. The palette is the brand violet carried by cooler neighbours -
 *  an indigo under it and a cyan at the far corner - so the whole field reads
 *  blue-violet rather than warm. The one warm field the first draft had is gone:
 *  amber on a cool ground fights the accent instead of supporting it. */
const FIELDS = [
  { x: 0.78, y: 0.30, r: 0.62, color: [124, 58, 237], alpha: 0.55 },
  { x: 0.90, y: 0.12, r: 0.34, color: [186, 96, 255], alpha: 0.50 },
  { x: 0.60, y: 0.66, r: 0.50, color: [109, 74, 255], alpha: 0.34 },
  { x: 0.16, y: 0.82, r: 0.46, color: [59, 130, 246], alpha: 0.26 },
  { x: 0.34, y: 0.98, r: 0.32, color: [56, 189, 248], alpha: 0.12 },
  { x: 0.04, y: 0.16, r: 0.38, color: [49, 46, 129], alpha: 0.32 }
];

/** The base the fields sit on. The same value as `--crust`, so the art and the
 *  veil that covers its lower half meet without a seam. */
const BASE = '#11131c';

export function createStage(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return inert();

  const art = document.createElement('canvas');
  const artCtx = art.getContext('2d');

  let width = 0;
  let height = 0;
  let dpr = 1;

  // Pointer position, normalised to -1..1 across each axis, and the eased value
  // actually used to draw. `target` is where the pointer is, `current` where the
  // art has caught up to.
  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;

  let timer = null;
  let running = false;
  let enabled = true;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  /** Paint the colour fields into the offscreen canvas at the current size. */
  function paintArt() {
    if (!width || !height) return;

    const w = Math.round(width * SCALE);
    const h = Math.round(height * SCALE);
    art.width = w;
    art.height = h;

    artCtx.fillStyle = BASE;
    artCtx.fillRect(0, 0, w, h);

    // Additive blending: overlapping fields brighten each other the way light
    // does, instead of the last one drawn simply covering the others.
    artCtx.globalCompositeOperation = 'lighter';

    for (const field of FIELDS) {
      const cx = field.x * w;
      const cy = field.y * h;
      const radius = field.r * Math.max(w, h);
      const [r, g, b] = field.color;

      const gradient = artCtx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${field.alpha})`);
      // A squared falloff: a linear ramp leaves a visible ring at the edge of
      // each field, where the gradient meets its own transparent end.
      gradient.addColorStop(0.45, `rgba(${r}, ${g}, ${b}, ${field.alpha * 0.38})`);
      gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

      artCtx.fillStyle = gradient;
      artCtx.beginPath();
      artCtx.arc(cx, cy, radius, 0, Math.PI * 2);
      artCtx.fill();
    }

    artCtx.globalCompositeOperation = 'source-over';
  }

  /** Blit the art at the current offset. */
  function draw() {
    if (!width || !height) return;

    const w = Math.round(width * SCALE);
    const h = Math.round(height * SCALE);

    // The art is larger than the viewport by the overscan; the offset slides it
    // within that slack. Multiplying by the overscan keeps the pan proportional
    // to the visible area rather than to the canvas.
    const panX = currentX * width * 0.5 * STRENGTH * SCALE;
    const panY = currentY * height * 0.5 * STRENGTH * SCALE;

    // Never let the crop leave the art, whatever the pointer does.
    const maxX = Math.max(0, (w - width) / 2);
    const maxY = Math.max(0, (h - height) / 2);
    const dx = Math.max(-maxX, Math.min(maxX, -panX));
    const dy = Math.max(-maxY, Math.min(maxY, -panY));

    ctx.drawImage(art, (w - width) / 2 + dx, (h - height) / 2 + dy, width, height, 0, 0, width, height);
  }

  function frame() {
    const dX = targetX - currentX;
    const dY = targetY - currentY;

    if (Math.abs(dX) > SETTLE || Math.abs(dY) > SETTLE) {
      currentX += dX * STEP;
      currentY += dY * STEP;
      draw();
    }
  }

  function loop() {
    frame();
    // `setTimeout` rather than `requestAnimationFrame`: this is a slow ambient
    // effect, and rAF ties it to the display's refresh rate for no benefit.
    // 30fps of a 1% pan is indistinguishable from 144.
    timer = setTimeout(loop, FRAME_MS);
  }

  function start() {
    if (running || !enabled) return;
    running = true;
    loop();
  }

  function stop() {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const nextW = Math.max(1, Math.round(rect.width));
    const nextH = Math.max(1, Math.round(rect.height));

    // Cap the backing store: a 4K window at devicePixelRatio 2 would be a
    // 7680px-wide canvas for a picture with no fine detail in it.
    const nextDpr = Math.min(window.devicePixelRatio || 1, 1.5);

    if (nextW === width && nextH === height && nextDpr === dpr) return;

    width = nextW;
    height = nextH;
    dpr = nextDpr;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    paintArt();
    draw();
  }

  function onPointer(event) {
    if (!enabled) return;
    // Normalised to -1..1, which is what the reference uses: the sign is what
    // matters, not the pixel distance, so the strength stays constant whatever
    // the window size.
    targetX = (event.clientX / width) * 2 - 1;
    targetY = (event.clientY / height) * 2 - 1;
  }

  function apply() {
    const on = enabled && !reduced.matches;
    if (on) start();
    else {
      stop();
      // Settle to centre so a disabled backdrop is not left mid-pan.
      targetX = 0;
      targetY = 0;
      currentX = 0;
      currentY = 0;
      draw();
    }
  }

  const onResize = () => { resize(); };

  return {
    mount() {
      resize();
      apply();
      window.addEventListener('resize', onResize);
      window.addEventListener('pointermove', onPointer, { passive: true });
      reduced.addEventListener('change', apply);
    },
    /** Turn the motion on or off; the art stays either way. */
    setEnabled(value) {
      enabled = Boolean(value);
      apply();
    },
    destroy() {
      stop();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointer);
      reduced.removeEventListener('change', apply);
    }
  };

  /** A stage that does nothing, for a browser without a 2d context. */
  function inert() {
    return { mount() {}, setEnabled() {}, destroy() {} };
  }
}
