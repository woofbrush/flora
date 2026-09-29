/**
 * Account token encryption.
 *
 * Tokens are sealed with AES-256-GCM under a key that lives in
 * `secret.key` in the data directory, never in the database. Someone who
 * copies flora.db alone gets nothing usable: the key has to travel with it,
 * and the key file is what the app tells users to keep private.
 *
 * The stored string is self-describing so a future format change can be
 * detected rather than silently mis-decrypted:
 *
 *   v1.<iv-b64>.<tag-b64>.<ciphertext-b64>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { secretKeyFile, dataRoot } from '../paths.js';

const PREFIX = 'v1';
const ALGO = 'aes-256-gcm';

let cachedKey = null;

/**
 * Load the encryption key, generating it on first run.
 *
 * The file is created with mode 0600 so other accounts on a shared machine
 * cannot read it. On Windows the mode is advisory, but the file still lands in
 * the user's own profile.
 */
export function key() {
  if (cachedKey) return cachedKey;
  const file = secretKeyFile();

  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      throw new Error(
        `secret.key is corrupt (expected 32 bytes, found ${buf.length}). ` +
        'Restore it from a backup - account tokens cannot be read without the original key.'
      );
    }
    cachedKey = buf;
    return cachedKey;
  }

  const fresh = crypto.randomBytes(32);
  fs.writeFileSync(file, fresh.toString('base64'), { mode: 0o600 });
  cachedKey = fresh;
  return cachedKey;
}

/** Encrypt a token. Returns the versioned string that goes in the database. */
export function seal(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('Refusing to encrypt an empty token.');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

/** Decrypt a sealed token. Throws if the value was tampered with or the key is wrong. */
export function open(sealed) {
  if (typeof sealed !== 'string') throw new Error('No stored token.');
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error('Stored token is not in a recognised format.');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * Stable one-way fingerprint of a token.
 *
 * Used to detect duplicates without keeping a second copy of the secret: the
 * same access token always hashes to the same value, and the hash is useless
 * on its own.
 */
export function fingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** A short, non-reversible label so the UI can tell two accounts apart. */
export function hint(token) {
  const s = String(token);
  if (s.length <= 8) return '••••';
  return `••••••••${s.slice(-4)}`;
}

/** True when the key file exists but cannot be read - surfaced as a UI warning. */
export function keyHealth() {
  try {
    key();
    return { ok: true, file: secretKeyFile() };
  } catch (err) {
    return { ok: false, file: secretKeyFile(), error: err.message };
  }
}

/** Wipe the in-memory key. Only used by tests. */
export function forgetKey() {
  cachedKey = null;
}

export { dataRoot };
