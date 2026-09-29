/**
 * Secret redaction.
 *
 * Access tokens, passwords and proxy credentials travel through log calls and
 * error messages all the time - an auth library putting the token in its error
 * text is the usual way it leaks. Everything written to a log sink, a console,
 * or the UI passes through `scrub` first.
 *
 * The patterns are intentionally broad. Over-redacting a log line costs
 * nothing; under-redacting one writes a live credential to a file the user
 * might paste into a support thread.
 */

/** JWT-shaped strings: three dot-separated base64url segments. */
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;

/** Minecraft access tokens are long opaque base64-ish runs. */
const MC_TOKEN = /\b[A-Za-z0-9._~+/=-]{80,}\b/g;

/** key: value / key=value where the key names a secret. */
const KEYED = /\b(access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd|authorization|bearer|token|secret|api[_-]?key|session)\b(\s*[:=]\s*)("?)([^\s",;)}\]]+)/gi;

/** Proxy credentials inside a URL: scheme://user:pass@host */
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/gi;

/** A bare "Bearer xxx". */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** Email addresses are personal data; keep the domain, mask the local part. */
const EMAIL = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

const MASK = '«redacted»';

/**
 * Mask every secret-looking substring in a string.
 * Order matters: URL credentials and Bearer headers go first so the generic
 * long-token rule cannot chew through them in pieces first.
 */
export function scrub(input) {
  if (typeof input !== 'string' || input.length === 0) return input;

  let out = input
    .replace(URL_CREDS, (_m, scheme, user) => `${scheme}${user}:${MASK}@`)
    .replace(BEARER, `Bearer ${MASK}`)
    .replace(JWT, MASK)
    .replace(KEYED, (_m, name, sep, quote) => `${name}${sep}${quote}${MASK}`)
    .replace(MC_TOKEN, MASK)
    .replace(EMAIL, (_m, first, domain) => `${first}•••@${domain}`);

  return out;
}

/**
 * Scrub a value of any shape.
 *
 * Objects are walked, but only a few levels deep and never into anything
 * cyclic - a log call must not be able to hang the app.
 */
export function scrubDeep(value, depth = 0, seen = new WeakSet()) {
  if (depth > 6) return '[deep]';
  if (value == null) return value;
  if (typeof value === 'string') return scrub(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'function') return '[fn]';
  if (value instanceof Error) {
    return { name: value.name, message: scrub(value.message), stack: scrub(value.stack ?? '') };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubDeep(v, depth + 1, seen));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (n++ > 50) { out['…'] = 'truncated'; break; }
      out[k] = scrubDeep(v, depth + 1, seen);
    }
    return out;
  }
  return String(value);
}

/**
 * Reduce an account row or token to something safe to display.
 * Used by the UI for "show me what you have" affordances.
 */
export function maskToken(token) {
  if (typeof token !== 'string' || token.length === 0) return '';
  if (token.length <= 8) return '•'.repeat(token.length);
  return `${'•'.repeat(8)}${token.slice(-4)}`;
}

export const PATTERNS = { JWT, MC_TOKEN, KEYED, URL_CREDS, BEARER, EMAIL };
