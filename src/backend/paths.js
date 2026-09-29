/**
 * Filesystem layout.
 *
 * Everything flora writes lives under one root so "reset the app" and "back up
 * my accounts" are both a single folder operation. The root is Electron's
 * per-user data directory, which means a packaged install never writes next to
 * the .exe (Program Files is read-only for standard users) and a portable build
 * can redirect the whole tree by setting FLORA_DATA_DIR before launch.
 *
 *   <root>/
 *     flora.db          accounts, proxies, settings, bot state
 *     secret.key        AES key for account tokens
 *     auth-cache/       prismarine-auth refresh tokens, one dir per account
 *     skins/            cached skin PNGs, named by texture hash
 *     heads/            cached head PNGs, named by username
 *     logs/             daily rotated application logs
 *     addons/           user-installed addons, one folder each
 *     addon-data/       per-addon storage, one JSON file per addon
 *
 * `heads/` is written by the main process rather than the backend - it backs
 * the `flora://app/head/<name>` route in protocol.js - but it is declared here
 * so that the layout has one definition and the maintenance actions in Settings
 * can count and clear it alongside the skins it sits next to.
 */
import fs from 'node:fs';
import path from 'node:path';

let root = process.env.FLORA_DATA_DIR || null;

/** Called once by the worker with the path resolved by Electron. */
export function setDataRoot(dir) {
  root = dir;
  for (const d of [dir, authCacheDir(), skinCacheDir(), headCacheDir(), logsDir(), addonsDir(), addonDataDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function dataRoot() {
  if (!root) throw new Error('Data root not initialised.');
  return root;
}

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const dbFile = () => path.join(dataRoot(), 'flora.db');
export const secretKeyFile = () => path.join(dataRoot(), 'secret.key');
export const authCacheDir = () => path.join(dataRoot(), 'auth-cache');
export const skinCacheDir = () => path.join(dataRoot(), 'skins');
export const headCacheDir = () => path.join(dataRoot(), 'heads');
export const logsDir = () => path.join(dataRoot(), 'logs');
export const backupsDir = () => ensure(path.join(dataRoot(), 'backups'));

/**
 * Where addons live.
 *
 * Under the data root rather than next to the executable, for the same reason
 * as everything else: a packaged install cannot write to Program Files, and a
 * portable build redirects the whole tree by setting FLORA_DATA_DIR. It also
 * means the built-in addons and the user's own are two different directories
 * with the same shape, so the loader has one code path rather than two.
 */
export const addonsDir = () => path.join(dataRoot(), 'addons');
export const addonDataDir = () => path.join(dataRoot(), 'addon-data');

/** The storage file for one addon. Named by id, which the manifest validates. */
export function addonStoreFile(id) {
  return path.join(addonDataDir(), `${id}.json`);
}

export function authCacheFor(cacheId) {
  return ensure(path.join(authCacheDir(), cacheId));
}

/** True when a path stays inside the data root. Guards every user-supplied filename. */
export function isInsideRoot(target) {
  const rel = path.relative(dataRoot(), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
