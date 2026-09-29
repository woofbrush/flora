/**
 * Account import.
 *
 * Reads a .txt or .json file and classifies every line into one of three
 * account kinds. Nothing here touches the database - `validate` returns a plan
 * the UI shows as a preview, and `commit` applies it. That split is what lets
 * the import dialog say "412 valid, 3 duplicates, 1 unreadable" before
 * anything is written.
 *
 * ---------------------------------------------------------------------------
 * SUPPORTED .txt FORMATS
 * ---------------------------------------------------------------------------
 * One account per line. Blank lines are skipped, and a line starting with '#'
 * or '//' is treated as a comment.
 *
 *   1. username
 *        Notch
 *
 *   2. email:password              (offline-mode account)
 *        alice@example.com:hunter2
 *
 *   3. username:password:uuid      (offline-mode, UUID pinned)
 *        Notch:hunter2:069a79f444e94726a5befca90e38aaf5
 *
 *   4. email:accesstoken           (Microsoft access token)
 *        alice@example.com:eyJraWQiOi...
 *
 *   5. accesstoken                 (bare token on its own line)
 *        eyJraWQiOi...
 *
 *   6. uuid:username
 *        069a79f444e94726a5befca90e38aaf5:Notch
 *
 * A separator may be ':', '|', a tab, or a single space; they are equivalent,
 * so a line pasted out of a spreadsheet works without editing.
 *
 * Forms 2 and 4 both look like `a:b`, so the two are told apart by the shape of
 * the right-hand side: a Minecraft access token is a single long run of
 * base64url/JWT characters, a password is short and may contain punctuation.
 * When that guess would be wrong, use the explicit prefixes below.
 *
 *   Explicit prefixes (any of the above, unambiguous):
 *        token:<accesstoken>
 *        offline:<username>:<password>
 *        username:<name>
 *
 * ---------------------------------------------------------------------------
 * SUPPORTED .json FORMATS
 * ---------------------------------------------------------------------------
 *   [{ "accesstoken": "..." }, ...]
 *   { "accesstoken": "..." }
 *   { "accounts": [ ... ] }
 *   { "tokens":   [ ... ] }
 *   ["token", "token"]
 *
 * Recognised keys per object: accesstoken / accessToken / access_token /
 * token, username / name / email, password, uuid / id, label, tags.
 *
 * ---------------------------------------------------------------------------
 * NOT SUPPORTED, ON PURPOSE
 * ---------------------------------------------------------------------------
 * `email:password` pairs for *Microsoft* accounts are read as offline-mode
 * credentials. They are not signed in to Microsoft: that requires the
 * interactive device-code flow (Accounts > Add > Sign in with Microsoft),
 * which is the only way Microsoft lets an application obtain a token for an
 * account. There is deliberately no code path here that submits an email and
 * password to Microsoft.
 */

import { createHash } from 'node:crypto';

const MIN_TOKEN_LENGTH = 60;
const MAX_TOKEN_LENGTH = 8192;
const MAX_LINES = 50000;

const COMMENT = /^\s*(#|\/\/)/;
const SEPARATORS = /[:|\t]| {1}/;

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const USERNAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]+$/;

const TOKEN_KEYS = ['accesstoken', 'accessToken', 'access_token', 'token', 'mcToken'];
const NAME_KEYS = ['username', 'name', 'email', 'login', 'user'];
const KNOWN_KEYS = new Set([
  ...TOKEN_KEYS, ...NAME_KEYS,
  'password', 'pass', 'uuid', 'id', 'label', 'tags', 'type', 'kind'
]);

export const FORMAT_HELP = [
  {
    title: 'Just a username',
    example: 'Notch',
    note: 'Offline-mode account. Used on servers with online-mode=false.'
  },
  {
    title: 'Username and password',
    example: 'alice@example.com:hunter2',
    note: 'Offline-mode account with a password.'
  },
  {
    title: 'Username, password and UUID',
    example: 'Notch:hunter2:069a79f444e94726a5befca90e38aaf5',
    note: 'Pins the UUID so the skin and head resolve correctly.'
  },
  {
    title: 'Email and access token',
    example: 'alice@example.com:eyJraWQiOi...',
    note: 'Real Microsoft account. The token must still be valid.'
  },
  {
    title: 'Access token on its own',
    example: 'eyJraWQiOi...',
    note: 'The username is filled in the first time the account is checked.'
  },
  {
    title: 'JSON',
    example: '[{ "accesstoken": "eyJraWQiOi..." }]',
    note: 'Also accepts { "accounts": [...] } and a bare array of strings.'
  }
];

function looksLikeToken(value) {
  if (typeof value !== 'string') return false;
  if (value.length < MIN_TOKEN_LENGTH || value.length > MAX_TOKEN_LENGTH) return false;
  if (/\s/.test(value)) return false;
  if (!TOKEN_RE.test(value)) return false;
  // A JWT is the common case and is unambiguous.
  if (/^ey[A-Za-z0-9_-]+\./.test(value)) return true;
  // Otherwise require a long, high-entropy-looking run: a password that long
  // is far less likely than a token.
  return value.length >= 120 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value);
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split one line into fields.
 *
 * Empty fields are kept: `name::uuid` is positional, and dropping the blank
 * would shift the UUID into the password slot. A line with no explicit
 * separator falls back to whitespace, so a pasted column still works.
 */
function splitFields(line) {
  if (/[:|\t]/.test(line)) return line.split(SEPARATORS).map(clean);
  return line.split(/\s+/).map(clean);
}

/** Classify one line of text. Returns { entry } or { error }. */
function parseLine(rawLine, lineNumber) {
  const line = rawLine.trim();
  if (line === '') return null;

  // Explicit prefixes win over every heuristic.
  const prefixed = /^(token|offline|username|msa)\s*[:=]\s*(.+)$/i.exec(line);
  if (prefixed) {
    const kind = prefixed[1].toLowerCase();
    const rest = prefixed[2].trim();
    if (kind === 'token' || kind === 'msa') {
      if (!TOKEN_RE.test(rest) || rest.length < 20) {
        return { error: { line: lineNumber, text: rawLine, reason: 'not a valid access token' } };
      }
      return { entry: { kind: 'token', token: rest, username: '', password: null, uuid: null, line: lineNumber } };
    }
    if (kind === 'username') {
      return { entry: { kind: 'offline', token: null, username: rest, password: null, uuid: null, line: lineNumber } };
    }
    // offline:<user>:<password>
    const parts = rest.split(SEPARATORS).map(clean);
    const entry = {
      kind: 'offline', token: null, username: parts[0] ?? '', password: parts[1] ?? null,
      uuid: parts[2] && UUID_RE.test(parts[2]) ? parts[2] : null, line: lineNumber
    };
    return validateEntry(entry, rawLine);
  }

  const fields = splitFields(line).filter((f, i) => i === 0 || f !== '');

  // One field: either a bare token or a bare username.
  if (fields.length === 1) {
    const only = fields[0];
    if (looksLikeToken(only)) {
      return { entry: { kind: 'token', token: only, username: '', password: null, uuid: null, line: lineNumber } };
    }
    return validateEntry(
      { kind: 'offline', token: null, username: only, password: null, uuid: null, line: lineNumber },
      rawLine
    );
  }

  // Two fields: uuid:name, name:uuid, name:token, or name:password.
  if (fields.length === 2) {
    const [left, right] = fields;

    if (UUID_RE.test(left) && USERNAME_RE.test(right)) {
      return validateEntry(
        { kind: 'offline', token: null, username: right, password: null,
          uuid: left.replace(/-/g, ''), line: lineNumber },
        rawLine
      );
    }

    // The order `serialise` writes offline accounts in. Without this branch an
    // export does not survive a re-import: the UUID is read as a password and
    // the account comes back with a secret it never had. A 32-character hex run
    // is a strong enough signal to win over `name:password`, and it is far too
    // short to be mistaken for a token.
    if (USERNAME_RE.test(left) && UUID_RE.test(right)) {
      return validateEntry(
        { kind: 'offline', token: null, username: left, password: null,
          uuid: right.replace(/-/g, ''), line: lineNumber },
        rawLine
      );
    }

    if (looksLikeToken(right)) {
      return { entry: {
        kind: 'token', token: right,
        username: EMAIL_RE.test(left) || USERNAME_RE.test(left) ? left : '',
        password: null, uuid: null, line: lineNumber
      } };
    }

    return validateEntry(
      { kind: 'offline', token: null, username: left, password: right, uuid: null, line: lineNumber },
      rawLine
    );
  }

  // Three or more: name:password:uuid, with the UUID optional.
  const [username, password, maybeUuid] = fields;
  return validateEntry({
    kind: 'offline', token: null, username, password: password || null,
    uuid: maybeUuid && UUID_RE.test(maybeUuid) ? maybeUuid.replace(/-/g, '') : null,
    line: lineNumber
  }, rawLine);
}

/** Shared field checks for offline entries. */
function validateEntry(entry, rawLine) {
  if (!entry.username) {
    return { error: { line: entry.line, text: rawLine, reason: 'no username on this line' } };
  }
  if (!USERNAME_RE.test(entry.username) && !EMAIL_RE.test(entry.username)) {
    return {
      error: {
        line: entry.line, text: rawLine,
        reason: 'username must be 1-16 letters, digits or underscores (or an email address)'
      }
    };
  }
  if (entry.password != null && entry.password.length > 256) {
    return { error: { line: entry.line, text: rawLine, reason: 'password is implausibly long' } };
  }
  return { entry };
}

/** Parse JSON input into the same entry shape. */
function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { error: `That file is not valid JSON: ${err.message}` };
  }

  let list;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object' && Array.isArray(data.accounts)) list = data.accounts;
  else if (data && typeof data === 'object' && Array.isArray(data.tokens)) list = data.tokens;
  else if (data && typeof data === 'object') list = [data];
  else return { error: 'JSON must be an object or an array.' };

  if (list.length === 0) return { error: 'That file contained no accounts.' };
  if (list.length > MAX_LINES) return { error: `Too many entries (limit ${MAX_LINES}).` };

  const entries = [];
  const errors = [];
  const unknownKeys = new Set();

  list.forEach((raw, index) => {
    const line = index + 1;

    if (typeof raw === 'string') {
      const value = raw.trim();
      if (looksLikeToken(value)) {
        entries.push({ kind: 'token', token: value, username: '', password: null, uuid: null, line });
      } else if (USERNAME_RE.test(value) || EMAIL_RE.test(value)) {
        entries.push({ kind: 'offline', token: null, username: value, password: null, uuid: null, line });
      } else {
        errors.push({ line, text: value.slice(0, 60), reason: 'not a recognisable token or username' });
      }
      return;
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ line, text: JSON.stringify(raw)?.slice(0, 60) ?? '', reason: 'entry is not an object' });
      return;
    }

    for (const key of Object.keys(raw)) if (!KNOWN_KEYS.has(key)) unknownKeys.add(key);

    const pick = (keys) => {
      for (const k of keys) if (raw[k] != null && raw[k] !== '') return String(raw[k]).trim();
      return '';
    };

    const token = pick(TOKEN_KEYS);
    const username = pick(NAME_KEYS);
    const password = pick(['password', 'pass']);
    const uuidRaw = pick(['uuid', 'id']);

    if (token) {
      if (!TOKEN_RE.test(token)) {
        errors.push({ line, text: `${token.slice(0, 24)}…`, reason: 'token contains unexpected characters' });
        return;
      }
      if (token.length < 20) {
        errors.push({ line, text: `${token.slice(0, 24)}…`, reason: 'token is too short' });
        return;
      }
      entries.push({
        kind: 'token', token,
        username: USERNAME_RE.test(username) || EMAIL_RE.test(username) ? username : '',
        password: null,
        uuid: uuidRaw && UUID_RE.test(uuidRaw) ? uuidRaw.replace(/-/g, '') : null,
        line
      });
      return;
    }

    const entry = {
      kind: 'offline', token: null, username, password: password || null,
      uuid: uuidRaw && UUID_RE.test(uuidRaw) ? uuidRaw.replace(/-/g, '') : null,
      line
    };
    const checked = validateEntry(entry, JSON.stringify(raw).slice(0, 60));
    if (checked.error) errors.push(checked.error);
    else entries.push(checked.entry);
  });

  return { entries, errors, unknownKeys: [...unknownKeys] };
}

/**
 * Parse a file's contents.
 *
 * `filename` only picks the initial strategy - the content decides. A .txt
 * file that happens to contain JSON is parsed as JSON, because that is
 * obviously what was meant.
 */
export function parse(text, filename = '') {
  const body = stripBom(String(text ?? ''));
  if (body.trim() === '') return { ok: false, error: 'That file is empty.' };

  const trimmed = body.trim();
  const looksJson = trimmed.startsWith('[') || trimmed.startsWith('{') ||
    /\.json$/i.test(filename);

  if (looksJson) {
    const result = parseJson(trimmed);
    if (result.error) return { ok: false, error: result.error };
    return {
      ok: true,
      format: 'json',
      entries: result.entries,
      errors: result.errors,
      unknownKeys: result.unknownKeys ?? []
    };
  }

  const lines = body.split(/\r?\n/);
  if (lines.length > MAX_LINES) {
    return { ok: false, error: `That file has ${lines.length} lines (limit ${MAX_LINES}).` };
  }

  const entries = [];
  const errors = [];
  let comments = 0;

  lines.forEach((raw, index) => {
    if (COMMENT.test(raw)) { comments += 1; return; }
    const result = parseLine(raw, index + 1);
    if (!result) return;
    if (result.error) errors.push(result.error);
    else entries.push(result.entry);
  });

  if (!entries.length && !errors.length) {
    return { ok: false, error: 'No accounts found. Every line was blank or a comment.' };
  }

  return { ok: true, format: 'text', entries, errors: errors.slice(0, 200),
           errorCount: errors.length, comments };
}

/**
 * Turn parsed entries into a plan, flagging duplicates.
 *
 * `existing` is a Set of token fingerprints already in the database, and
 * `existingNames` a Set of lowercased usernames, so a file that is imported
 * twice reports the second run as duplicates instead of silently doubling.
 */
export function plan(parsed, { existing = new Set(), existingNames = new Set() } = {}) {
  const seenTokens = new Set();
  const seenNames = new Set();

  const fresh = [];
  const duplicates = [];
  const invalid = [...(parsed.errors ?? [])];

  for (const entry of parsed.entries) {
    if (entry.kind === 'token') {
      const fp = fingerprintOf(entry.token);
      if (seenTokens.has(fp)) {
        duplicates.push({ line: entry.line, hint: entry.username || '•'.repeat(8) + entry.token.slice(-4),
                          reason: 'repeated inside this file' });
        continue;
      }
      if (existing.has(fp)) {
        duplicates.push({ line: entry.line, hint: entry.username || '•'.repeat(8) + entry.token.slice(-4),
                          reason: 'already in flora' });
        continue;
      }
      seenTokens.add(fp);
    } else {
      const name = entry.username.toLowerCase();
      if (seenNames.has(name)) {
        duplicates.push({ line: entry.line, hint: entry.username, reason: 'repeated inside this file' });
        continue;
      }
      if (existingNames.has(name)) {
        duplicates.push({ line: entry.line, hint: entry.username, reason: 'already in flora' });
        continue;
      }
      seenNames.add(name);
    }
    fresh.push(entry);
  }

  const byKind = fresh.reduce((acc, e) => {
    acc[e.kind] = (acc[e.kind] ?? 0) + 1;
    return acc;
  }, {});

  return {
    total: parsed.entries.length + (parsed.errors?.length ?? 0),
    fresh,
    duplicates,
    invalid,
    counts: {
      total: parsed.entries.length + (parsed.errors?.length ?? 0),
      importable: fresh.length,
      tokens: byKind.token ?? 0,
      offline: byKind.offline ?? 0,
      duplicates: duplicates.length,
      invalid: invalid.length
    }
  };
}

/**
 * Fingerprint a token for duplicate detection.
 *
 * Same construction as auth/crypto's `fingerprint`, reimplemented here so this
 * module stays pure: parsing and de-duplicating a file must not require the
 * encryption key to be loaded.
 */
function fingerprintOf(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** Redacted preview for the UI. Never includes a token or password. */
export function preview(planned, sampleSize = 40) {
  return {
    counts: planned.counts,
    sample: planned.fresh.slice(0, sampleSize).map((e) => ({
      line: e.line,
      kind: e.kind,
      username: e.username || null,
      uuid: e.uuid,
      masked: e.token ? `${'•'.repeat(8)}${e.token.slice(-4)}` : null
    })),
    duplicates: planned.duplicates.slice(0, sampleSize),
    invalid: planned.invalid.slice(0, sampleSize),
    truncated: Math.max(0, planned.fresh.length - sampleSize)
  };
}

/** One-line-per-account export. Tokens are included only when asked for. */
export function serialise(accounts, { includeSecrets = false, revealToken = null } = {}) {
  const lines = [];
  for (const account of accounts) {
    if (account.kind === 'token' && includeSecrets && revealToken) {
      const token = revealToken(account.id);
      if (token) { lines.push(token); continue; }
    }
    if (account.kind === 'offline') {
      lines.push(account.uuid ? `${account.username}:${account.uuid}` : account.username);
      continue;
    }
    if (account.username) lines.push(account.username);
  }
  return lines.join('\n') + '\n';
}

export const CONSTANTS = { MIN_TOKEN_LENGTH, MAX_TOKEN_LENGTH, MAX_LINES };
export { looksLikeToken, parseLine };
