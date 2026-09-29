/**
 * Preflight.
 *
 * Runs before packaging and answers one question: is everything this app needs
 * present, and is anything in the tree that must not ship? Both halves matter.
 * A missing renderer entry produces an installer that opens a blank window, and
 * a committed secret produces an installer that leaks it to whoever downloads
 * it - and neither shows up until someone else runs the build.
 *
 * Every check prints one PASS or FAIL line. The exit code is 0 only when all of
 * them pass, so `npm run preflight && npm run dist` is a safe sequence.
 *
 * Run with: npm run preflight
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const MIN_NODE = '22.5.0';                 // first release with node:sqlite, which the database uses
const SOURCE_DIRS = ['src/main', 'src/backend', 'src/preload', 'src/renderer/js'];
const SCAN_DIRS = ['src', 'build', 'scripts'];

/** Directories that are never part of the shipped app and are never scanned. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'flora-data']);

const results = [];

function record(title, ok, details = []) {
  results.push({ title, ok, details });
}

function pass(title, details = []) {
  record(title, true, details);
}

function fail(title, details = []) {
  record(title, false, details);
}

const rel = (target) => path.relative(ROOT, target).split(path.sep).join('/');

function listFiles(dir, { recursive = true } = {}) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) found.push(...listFiles(full, { recursive }));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

/** True for a line that is entirely a comment, so prose cannot fail a check. */
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------- checks

function checkNode() {
  const version = process.versions.node;
  if (compareVersions(version, MIN_NODE) < 0) {
    fail(`Node ${version} is too old`, [
      `node:sqlite backs the whole database and is only available from Node ${MIN_NODE}.`,
      `Run the build with Node ${MIN_NODE} or newer.`
    ]);
    return;
  }
  pass(`Node ${version} (needs >= ${MIN_NODE})`);
}

function checkElectron() {
  const moduleDir = path.join(ROOT, 'node_modules', 'electron');
  const binary = path.join(moduleDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');

  if (!fs.existsSync(moduleDir)) {
    fail('electron is installed', ['node_modules/electron is missing. Run `npm install`.']);
    return;
  }
  if (!fs.existsSync(binary)) {
    fail('the electron binary is present', [
      `Expected ${rel(binary)}.`,
      'The electron package is installed but its binary was never downloaded - reinstall it.'
    ]);
    return;
  }
  pass('the electron binary is present', [rel(binary)]);
}

function checkDependencies() {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (err) {
    fail('package.json is readable', [err.message]);
    return;
  }

  const names = Object.keys(manifest.dependencies ?? {});
  if (!names.length) {
    pass('runtime dependencies resolve', ['none declared']);
    return;
  }

  const missing = [];
  for (const name of names) {
    try {
      // import.meta.resolve understands the exports map, which is what a
      // packaged build will go through; require.resolve is the fallback for a
      // package that only declares CommonJS.
      import.meta.resolve(name);
    } catch {
      try {
        require.resolve(name);
      } catch (err) {
        missing.push(`${name} - ${err.message.split('\n')[0]}`);
      }
    }
  }

  if (missing.length) fail('runtime dependencies resolve', missing);
  else pass(`runtime dependencies resolve (${names.length})`);
}

function checkSyntax() {
  const files = SOURCE_DIRS.flatMap((dir) => listFiles(path.join(ROOT, dir)))
    .filter((file) => /\.(js|mjs|cjs)$/i.test(file));

  if (!files.length) {
    fail('source files parse', [`Found no JavaScript under ${SOURCE_DIRS.join(', ')}.`]);
    return;
  }

  const broken = [];
  for (const file of files) {
    const run = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (run.status !== 0) {
      const reason = (run.stderr ?? '').trim().split('\n').find((l) => l.includes('Error')) ?? 'parse error';
      broken.push(`${rel(file)} - ${reason.trim()}`);
    }
  }

  if (broken.length) fail(`${files.length} source files parse`, broken);
  else pass(`${files.length} source files parse`);
}

function checkRendererAssets() {
  const required = [
    'src/renderer/index.html',
    'src/renderer/styles/tokens.css',
    'src/renderer/styles/base.css',
    'src/renderer/styles/layout.css',
    'src/renderer/styles/components.css',
    'src/renderer/js/app.js',
    'src/renderer/assets/logo/flora-mark.svg'
  ];

  const missing = required.filter((file) => !fs.existsSync(path.join(ROOT, file)));
  if (missing.length) fail('the renderer ships complete', missing.map((file) => `missing ${file}`));
  else pass(`the renderer ships complete (${required.length} files)`);
}

function checkSecrets() {
  // Assembled from pieces so this file cannot match its own pattern - a scanner
  // that flags itself is a scanner nobody trusts.
  const privateKey = new RegExp('-----BEGIN' + ' [A-Z ]*PRIVATE' + ' KEY-----');
  const forbiddenNames = new Set([
    'art.pem', 'secret.key', 'session.secret', 'login.txt', 'flora.sqlite'
  ]);
  const forbiddenExtensions = new Set(['.pem', '.key', '.sqlite', '.db']);

  const candidates = [
    ...SCAN_DIRS.flatMap((dir) => listFiles(path.join(ROOT, dir))),
    // The repository root, one level only: a stray key file is dropped here,
    // and walking it recursively would mean walking node_modules.
    ...listFiles(ROOT, { recursive: false })
  ];

  const offences = [];
  for (const file of new Set(candidates)) {
    const name = path.basename(file).toLowerCase();
    const ext = path.extname(name);

    if (forbiddenNames.has(name)) {
      offences.push(`${rel(file)} - this is a credential file, not source`);
      continue;
    }
    if (forbiddenExtensions.has(ext)) {
      offences.push(`${rel(file)} - key, certificate and database files must never be committed`);
      continue;
    }

    let content;
    try {
      // latin1 keeps every byte, so a UTF-16 or binary file is still searched.
      content = fs.readFileSync(file, 'latin1');
    } catch {
      continue;
    }
    if (privateKey.test(content)) {
      offences.push(`${rel(file)} - contains a PEM private key block`);
    }
  }

  if (offences.length) {
    fail(`no secrets in the tree (scanned ${new Set(candidates).size} files)`, offences);
  } else {
    pass(`no secrets in the tree (scanned ${new Set(candidates).size} files)`);
  }
}

function checkOffline() {
  const addressPatterns = [/\blocalhost\b/, /\b127\.0\.0\.1\b/, /\b0\.0\.0\.0\b/];
  const serverPatterns = [/createServer\s*\(/, /(^|[^\w.])express\s*\(/, /\.listen\s*\(/];

  /**
   * The one occurrence of "localhost" in executable code, and why it is not a
   * listen address: bots/connect.js skips the SRV lookup when the target is the
   * local machine, and the local machine has no SRV record to find. Nothing is
   * bound and nothing is served.
   */
  const ALLOWED = [
    { file: 'src/backend/bots/connect.js', text: "host === 'localhost'" }
  ];

  const offences = [];
  const allowed = [];
  const files = listFiles(path.join(ROOT, 'src'))
    .filter((file) => /\.(js|mjs|cjs|html|css|json|svg)$/i.test(file));

  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const where = `${rel(file)}:${index + 1}`;
      const at = `${where}: ${line.trim().slice(0, 100)}`;

      if (!isCommentLine(line)) {
        for (const pattern of serverPatterns) {
          if (pattern.test(line)) {
            offences.push(`${at} - flora is IPC-only and must not open a listening socket`);
          }
        }
        for (const pattern of addressPatterns) {
          if (!pattern.test(line)) continue;
          const exempt = ALLOWED.some((a) => a.file === rel(file) && line.includes(a.text));
          if (exempt) allowed.push(at);
          else offences.push(`${at} - a bind address or a local URL has no place in the app`);
        }
      }
    });
  }

  const details = [...offences, ...allowed.map((a) => `allowed: ${a}`)];
  if (offences.length) fail('no HTTP server and no bind addresses', details);
  else pass(`no HTTP server and no bind addresses (${allowed.length} known exception${allowed.length === 1 ? '' : 's'})`, details);
}

// ---------------------------------------------------------------- run

console.log('\nflora preflight\n');

checkNode();
checkElectron();
checkDependencies();
checkSyntax();
checkRendererAssets();
checkSecrets();
checkOffline();

for (const result of results) {
  console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.title}`);
  for (const detail of result.details) console.log(`        ${detail}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed\n`);

if (failed.length) {
  console.log('Packaging would produce a broken or unsafe build. Fix the failures above.\n');
  process.exit(1);
}
process.exit(0);
