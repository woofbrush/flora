/**
 * Icon generation.
 *
 * Rasterises the flora mark into the PNGs electron-builder needs, using the
 * Electron that is already a dev dependency to do the rasterising. Adding sharp
 * or resvg for one build-time step would mean a second native toolchain to
 * install and keep working on every platform; Electron is already here, already
 * pinned, and renders SVG exactly the way the app itself does.
 *
 * The work happens in a short-lived Electron process with a hidden offscreen
 * window. `capturePage()` is read after the load has finished and the compositor
 * has settled - a capture taken too early returns a blank frame, which is the
 * usual way this kind of script fails silently.
 *
 * Run with: npm run icons
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const SVG = path.join(ROOT, 'src', 'renderer', 'assets', 'logo', 'flora-mark.svg');
const OUT_DIR = path.join(ROOT, 'build');
const ICO = path.join(OUT_DIR, 'icon.ico');

/**
 * The two PNGs that are consumed directly.
 *
 * tray.png goes to the notification area, where src/main/tray.js resizes it to
 * 16x16. It is rendered at 32px so that downscaled copy stays sharp on a
 * high-DPI display; the shell is much better at discarding detail than at
 * inventing it.
 */
const TARGETS = [
  { file: 'icon.png', size: 512 },
  { file: 'tray.png', size: 32 }
];

/**
 * The sizes packed into build/icon.ico.
 *
 * This is the full set Windows asks for. Every one is rendered from the vector
 * rather than scaled down from the 512, because the shell picks whichever entry
 * matches the current DPI and a resampled 16 would be visibly softer than one
 * drawn at 16. 256 is the size Explorer uses for extra-large thumbnails, and is
 * also the ceiling: an ICO directory entry stores width in a single byte.
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function fail(message) {
  console.error(`\nmake-icons: ${message}\n`);
  process.exit(1);
}

function findElectron() {
  // The electron package exports the path to its own binary, which is what a
  // packaged install would use. node_modules/.bin/electron is the shim and works
  // everywhere else, so it is the fallback rather than the first choice.
  try {
    const exported = require('electron');
    if (typeof exported === 'string' && fs.existsSync(exported)) return exported;
  } catch { /* not installed, or not resolvable outside Electron */ }

  const candidates = [
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
    path.join(ROOT, 'node_modules', '.bin', 'electron')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The renderer that runs inside Electron.
 *
 * Kept as a string and written into a temp directory rather than shipped as a
 * second file: it is only meaningful next to this script, and a stray .js in
 * scripts/ would be picked up by the syntax check in preflight.js.
 */
const RENDERER = `const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const job = JSON.parse(fs.readFileSync(path.join(__dirname, 'job.json'), 'utf8'));

// Offscreen compositing on a build machine, sometimes without a GPU or a
// visible session, is the combination that most often refuses to start.
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

// A window on a 150% display captures at 150%, so a 32px icon would come back
// as 48 physical pixels and every size check below would fail. Pinning the
// scale factor makes the output depend only on the size asked for.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

// Each size gets its own window, and the default "quit on the last window
// closed" behaviour would take the app down between the first icon and the
// second. This handler is what keeps the process alive to finish the job; the
// exit below is explicit instead.
app.on('window-all-closed', () => {});

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function page(svg, size) {
  // The SVG carries width/height attributes of its own; a CSS rule wins over
  // those presentation attributes, which is what makes one file serve every
  // size without rewriting it.
  return '<!doctype html><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}' +
    'svg{display:block;width:' + size + 'px;height:' + size + 'px}</style>' +
    svg;
}

/**
 * Straight-alpha BGRA, which is what a 32-bit icon entry stores.
 *
 * Skia keeps its bitmaps premultiplied, but that is an implementation detail
 * and guessing wrong shows up as a dark fringe around every antialiased edge.
 * The two are distinguishable without knowing which one this is: premultiplied
 * data can never have a colour channel above its own alpha, so a single pixel
 * that does proves the buffer is already straight.
 */
function straighten(bitmap) {
  for (let i = 0; i < bitmap.length; i += 4) {
    const a = bitmap[i + 3];
    if (bitmap[i] > a || bitmap[i + 1] > a || bitmap[i + 2] > a) return bitmap;
  }

  const out = Buffer.alloc(bitmap.length);
  for (let i = 0; i < bitmap.length; i += 4) {
    const a = bitmap[i + 3];
    // Fully transparent and fully opaque pixels are the same in both formats,
    // and dividing by zero is the one case that would corrupt them.
    if (a === 0 || a === 255) {
      bitmap.copy(out, i, i, i + 4);
      continue;
    }
    out[i] = Math.min(255, Math.round((bitmap[i] * 255) / a));
    out[i + 1] = Math.min(255, Math.round((bitmap[i + 1] * 255) / a));
    out[i + 2] = Math.min(255, Math.round((bitmap[i + 2] * 255) / a));
    out[i + 3] = a;
  }
  return out;
}

async function render(target) {
  const win = new BrowserWindow({
    width: target.size,
    height: target.size,
    show: false,
    frame: false,
    transparent: true,
    // Anything other than a fully transparent background defeats the alpha
    // channel before capturePage ever sees it.
    backgroundColor: '#00000000',
    webPreferences: {
      offscreen: true,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // An unfocused hidden window is throttled by default, which stops the
      // frame from ever being produced.
      backgroundThrottling: false
    }
  });

  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(job.svg, target.size)));
    await settle(600);

    const image = await win.webContents.capturePage({
      x: 0, y: 0, width: target.size, height: target.size
    });
    const png = image.toPNG();
    if (!png.length) throw new Error('the captured frame was empty');

    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fs.writeFileSync(target.path, png);

    // The 256 entry is stored as a PNG, so nothing above 128 needs its pixels.
    if (target.raw) {
      fs.writeFileSync(target.path + '.raw', straighten(image.toBitmap()));
    }
    return png.length;
  } finally {
    win.destroy();
  }
}

(async () => {
  const written = [];
  try {
    // A window cannot be constructed before this resolves, and app.exit() below
    // is what keeps the process from lingering on an open handle.
    await app.whenReady();
    for (const target of job.targets) {
      written.push({ ...target, bytes: await render(target) });
    }
  } catch (err) {
    console.log('RESULT ' + JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
    app.exit(1);
    return;
  }

  console.log('RESULT ' + JSON.stringify({ ok: true, written }));
  app.exit(0);
})();
`;

/** Read width/height straight out of the PNG header, so a bad capture is caught here. */
function pngSize(file) {
  const header = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, header, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!header.subarray(0, 8).equals(signature)) return null;
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/**
 * One icon entry in the uncompressed form: a BITMAPINFOHEADER followed by the
 * pixels and a mask.
 */
function dib(bgra, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // this header is 40 bytes
  header.writeInt32LE(size, 4);
  // Doubled, because an icon DIB stacks the colour image over a 1-bit AND mask
  // and the header's height has to cover both.
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12); // colour planes
  header.writeUInt16LE(32, 14); // bits per pixel
  header.writeUInt32LE(0, 16); // BI_RGB: uncompressed

  // DIB rows run bottom-up, so they are flipped on the way in.
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const from = (size - 1 - y) * size * 4;
    bgra.copy(xor, y * size * 4, from, from + size * 4);
  }

  // Nothing on a modern shell reads the AND mask of a 32-bit icon, but the
  // entry is malformed without it and it has to be padded to a 4-byte row.
  const and = Buffer.alloc(Math.ceil(size / 32) * 4 * size);

  return Buffer.concat([header, xor, and]);
}

/**
 * Pack the rendered sizes into build/icon.ico.
 *
 * The file is a directory followed by the images themselves. Everything up to
 * 128 is written as a plain DIB and only 256 is a PNG: PNG entries are a Vista
 * and later feature, and while NSIS 3 reads them, the installer's own icon
 * handling is the one place worth being conservative. 256 is compressed
 * because as a DIB it alone would be a quarter of a megabyte.
 */
function buildIco(images) {
  const entries = images.map((image) => ({
    size: image.size,
    data: image.size >= 256 ? image.png : dib(image.bgra, image.size)
  }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 is an icon; 2 would be a cursor
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const at = index * 16;
    // 256 does not fit in a byte, and zero is the agreed way to write it.
    const dimension = entry.size >= 256 ? 0 : entry.size;
    directory.writeUInt8(dimension, at);
    directory.writeUInt8(dimension, at + 1);
    directory.writeUInt8(0, at + 2); // palette entries, none for 32-bit
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

function main() {
  if (!fs.existsSync(SVG)) fail(`the source mark is missing: ${SVG}`);

  const electron = findElectron();
  if (!electron) fail('Electron is not installed. Run `npm install` first.');

  const svg = fs.readFileSync(SVG, 'utf8');

  // The ICO sizes are rendered into a scratch directory and deleted once they
  // have been packed; only icon.png, tray.png and icon.ico are build inputs and
  // six stray PNGs next to them would just be six files to wonder about.
  const scratch = path.join(OUT_DIR, '.ico');
  fs.rmSync(scratch, { recursive: true, force: true });

  const targets = [
    ...TARGETS.map((t) => ({ ...t, raw: false, path: path.join(OUT_DIR, t.file) })),
    // 256 is stored as a PNG entry, so it is the one size that needs no pixels.
    ...ICO_SIZES.map((size) => ({
      file: `icon-${size}.png`,
      size,
      raw: size < 256,
      path: path.join(scratch, `${size}.png`)
    }))
  ];

  // A directory with its own package.json is the one form of app path Electron
  // always accepts, on every platform.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flora-icons-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'flora-icons', main: 'main.cjs' }));
  fs.writeFileSync(path.join(tmp, 'main.cjs'), RENDERER);
  fs.writeFileSync(path.join(tmp, 'job.json'), JSON.stringify({ svg, targets }));

  let result;
  try {
    const run = spawnSync(electron, [tmp], { encoding: 'utf8', timeout: 180000 });

    if (run.error) fail(`could not start Electron: ${run.error.message}`);

    const line = (run.stdout ?? '').split(/\r?\n/).find((l) => l.startsWith('RESULT '));
    if (!line) {
      const detail = (run.stderr ?? '').trim().split(/\r?\n/).slice(-8).join('\n');
      fail(`Electron exited without reporting a result${detail ? `:\n${detail}` : '.'}`);
    }
    result = JSON.parse(line.slice('RESULT '.length));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (!result.ok) fail(result.error);

  // A silently mistyped size would only surface after packaging, so every
  // header is checked rather than trusted.
  for (const written of result.written) {
    const size = pngSize(written.path);
    if (!size || size.width !== written.size || size.height !== written.size) {
      fail(`${path.basename(written.path)} came out as ${size ? `${size.width}x${size.height}` : 'not a PNG'}, expected ${written.size}x${written.size}`);
    }
  }

  const packed = ICO_SIZES.map((size) => {
    const file = path.join(scratch, `${size}.png`);
    const raw = `${file}.raw`;
    return {
      size,
      png: fs.readFileSync(file),
      bgra: fs.existsSync(raw) ? fs.readFileSync(raw) : null
    };
  });

  for (const image of packed) {
    if (image.size >= 256) continue;
    const expected = image.size * image.size * 4;
    if (image.bgra?.length !== expected) {
      fail(`the ${image.size}px pixels are ${image.bgra?.length ?? 0} bytes, expected ${expected}.`);
    }
  }

  fs.writeFileSync(ICO, buildIco(packed));

  console.log(`flora icons -> ${path.relative(ROOT, OUT_DIR)}${path.sep}\n`);
  for (const written of result.written) {
    if (written.file.startsWith('icon-')) continue;
    console.log(`  ${written.file.padEnd(14)} ${String(written.size).padStart(3)}x${String(written.size).padEnd(3)}  ${written.bytes.toLocaleString('en-US')} bytes`);
  }
  console.log(`  ${'icon.ico'.padEnd(14)} ${ICO_SIZES.join(', ')}  ${fs.statSync(ICO).size.toLocaleString('en-US')} bytes`);

  fs.rmSync(scratch, { recursive: true, force: true });

  console.log('\n  icon.ico is what the .exe and the installer wear. win.icon points at it because');
  console.log('  the app is stamped by scripts/after-pack.cjs, not by electron-builder.');
}

main();
