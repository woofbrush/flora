/**
 * Stamp the executable, after packing and before the installers are built.
 *
 * electron-builder normally does this itself: it shells out to `app-builder
 * rcedit`, which fetches its winCodeSign bundle first. That bundle contains two
 * macOS dylibs stored as symbolic links, and extracting a symbolic link on
 * Windows needs SeCreateSymbolicLinkPrivilege - which a normal account only has
 * with Developer Mode on. The extraction fails, app-builder retries it four
 * times, and the build dies before NSIS ever runs:
 *
 *   ERROR: Cannot create symbolic link : A required privilege is not held by
 *   the client. : ...\winCodeSign\*\darwin\10.12\lib\libcrypto.dylib
 *
 * The two files that break are for signing a macOS build. Nothing on Windows
 * reads them. So the bundle is fetched here, unpacked with the `darwin` and
 * `linux` trees left out - which sidesteps the symlinks entirely - and the same
 * rcedit binary electron-builder would have used is run directly.
 *
 * `win.signAndEditExecutable` must stay false in electron-builder.yml. Leaving
 * it on re-enables the path above and the build fails again; this hook is what
 * replaces it.
 *
 * Every value rcedit writes is read from the same places electron-builder reads
 * them, so the built file is byte-identical in its metadata to a normal build.
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/**
 * The bundle electron-builder itself would download, pinned by hash.
 *
 * Hard-coding the digest means a mirror that has been tampered with, or a
 * release that was replaced, fails here rather than silently stamping every
 * installer built afterwards.
 */
const BUNDLE = {
  version: '2.6.0',
  size: 5635384,
  sha512: 'e8b408d9df413c2dd7b346684d07b5a37b4f880dbc73bf8f63af50f62fe90fc958e39a6c32d1ee2f0bf7bd1724895af7671d5c6cdc8b94147c493c0275c1f0b4',
  url: 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z'
};

/** Extracted once and reused; node_modules is never packaged or committed. */
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'flora-rcedit');

const sha512 = (buffer) => crypto.createHash('sha512').update(buffer).digest('hex');

function log(message) {
  console.log(`  • rcedit         ${message}`);
}

function fail(message) {
  throw new Error(`after-pack: ${message}`);
}

/** A 7-Zip binary, which electron-builder already depends on. */
function find7za() {
  const candidates = [
    path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'ia32', '7za.exe'),
    path.join(ROOT, 'node_modules', '7zip-bin', 'linux', 'x64', '7za'),
    path.join(ROOT, 'node_modules', '7zip-bin', 'mac', '7za')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  fail('7zip-bin is not installed. Run `npm install` first.');
}

/**
 * The archive, from electron-builder's own cache when a previous build left one
 * there, and from the release URL otherwise.
 */
async function archive() {
  const cacheDir = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'electron-builder', 'Cache', 'winCodeSign'
  );

  try {
    for (const entry of fs.readdirSync(cacheDir)) {
      if (!entry.endsWith('.7z')) continue;
      const candidate = path.join(cacheDir, entry);
      if (fs.statSync(candidate).size !== BUNDLE.size) continue;
      const buffer = fs.readFileSync(candidate);
      if (sha512(buffer) === BUNDLE.sha512) {
        log(`using the cached winCodeSign ${BUNDLE.version}`);
        return candidate;
      }
    }
  } catch { /* no cache directory, which is the normal case on a clean machine */ }

  log(`downloading winCodeSign ${BUNDLE.version}`);
  const response = await fetch(BUNDLE.url, { redirect: 'follow' });
  if (!response.ok) fail(`could not download winCodeSign (HTTP ${response.status})`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const digest = sha512(buffer);
  if (digest !== BUNDLE.sha512) {
    fail(
      'the downloaded winCodeSign does not match its expected hash.\n' +
      `  expected ${BUNDLE.sha512}\n  got      ${digest}`
    );
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const stored = path.join(cacheDir, `winCodeSign-${BUNDLE.version}.7z`);
  fs.writeFileSync(stored, buffer);
  return stored;
}

/** Unpack the bundle once, leaving out the platforms whose links cannot be made. */
async function rcedit() {
  const binary = path.join(CACHE, 'rcedit-x64.exe');
  if (fs.existsSync(binary)) return binary;

  const source = await archive();
  fs.rmSync(CACHE, { recursive: true, force: true });
  fs.mkdirSync(CACHE, { recursive: true });

  execFileSync(find7za(), ['x', '-bd', '-x!darwin', '-x!linux', source, `-o${CACHE}`], { stdio: 'pipe' });

  if (!fs.existsSync(binary)) fail('winCodeSign unpacked without an rcedit binary.');
  // Only the two rcedit binaries are kept; the other 24MB is signing tooling
  // this build has no certificate to use.
  for (const entry of fs.readdirSync(CACHE)) {
    if (entry === 'rcedit-x64.exe' || entry === 'rcedit-ia32.exe') continue;
    fs.rmSync(path.join(CACHE, entry), { recursive: true, force: true });
  }
  return binary;
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  if (!fs.existsSync(exe)) fail(`there is no executable at ${exe}`);

  const appInfo = context.packager.appInfo;
  const config = context.packager.config;
  const version = appInfo.version;

  const tool = await rcedit();
  const icon = path.join(ROOT, 'build', 'icon.ico');

  const args = [
    exe,
    ...[
      ['FileDescription', config.description || appInfo.description || appInfo.productName],
      ['ProductName', appInfo.productName],
      ['CompanyName', typeof config.copyright === 'string' ? config.copyright.replace(/^©\s*/, '') : 'Woofbrush Design LLC'],
      ['LegalCopyright', config.copyright || ''],
      ['InternalName', appInfo.productName],
      ['OriginalFilename', `${appInfo.productFilename}.exe`]
    ].flatMap(([key, value]) => ['--set-version-string', key, String(value ?? '')]),
    '--set-file-version', version,
    '--set-product-version', `${version}.0`
  ];

  if (fs.existsSync(icon)) args.push('--set-icon', icon);
  else log('build/icon.ico is missing, so the executable keeps the Electron icon');

  log(`stamping ${path.basename(exe)} as ${version}`);
  execFileSync(tool, args, { stdio: 'pipe' });
  log('done');
};
