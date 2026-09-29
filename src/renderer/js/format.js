/**
 * Formatting.
 *
 * One place for every string the UI shows that is derived from a value, so
 * "3 accounts" reads the same in a toast, a table cell and a tray tooltip.
 */

const NBSP = ' ';

/** 1,234 */
export function num(value) {
  return Number(value ?? 0).toLocaleString('en-US');
}

/** "3 accounts", "1 account" */
export function plural(count, singular, pluralForm = null) {
  const n = Number(count ?? 0);
  return `${num(n)}${NBSP}${n === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

/**
 * A relative time that reads naturally at every scale, from "just now" to a
 * date. Anything older than a week becomes a date, because "43d ago" is not
 * something anyone converts in their head.
 */
export function ago(timestamp) {
  if (!timestamp) return 'never';
  const seconds = Math.floor((Date.now() - Number(timestamp)) / 1000);

  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(Number(timestamp)).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    year: new Date(Number(timestamp)).getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  });
}

/** "14:32:07" - a clock time, for log lines. */
export function clock(timestamp) {
  return new Date(Number(timestamp)).toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
}

/** "2 Sep, 14:32" - an absolute stamp, for tooltips. */
export function stamp(timestamp) {
  if (!timestamp) return 'never';
  return new Date(Number(timestamp)).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

/** "4m 12s", "1h 3m", "2d 4h" - a duration that never shows empty units. */
export function duration(ms) {
  const total = Math.max(0, Math.floor(Number(ms ?? 0) / 1000));
  if (total < 60) return `${total}s`;

  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

/** Time since a start timestamp, live-formatted. */
export function since(startedAt) {
  if (!startedAt) return '-';
  return duration(Date.now() - Number(startedAt));
}

/** "18.4 MB", "412 KB" */
export function bytes(value) {
  const n = Number(value ?? 0);
  if (n < 1024) return `${n}${NBSP}B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = n / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size < 10 ? size.toFixed(1) : Math.round(size)}${NBSP}${units[unit]}`;
}

/** "1.2s", "840ms" */
export function latency(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '-';
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
}

/** "a3f9…c21b" - a fingerprint shown to a human, never a whole secret. */
export function truncateMiddle(value, head = 6, tail = 4) {
  const text = String(value ?? '');
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** Tidy a server address for display: drop a redundant :25565. */
export function server(address) {
  const text = String(address ?? '');
  return text.endsWith(':25565') ? text.slice(0, -6) : text;
}

/** Initials for a fallback avatar. */
export function initials(name) {
  const text = String(name ?? '').trim();
  if (!text) return '?';
  const parts = text.split(/[\s_.-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** A stable hue from a string, for colouring tags and offline accounts. */
export function hue(value) {
  let hash = 0;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

const STATUS_LABELS = {
  online: 'Online',
  connecting: 'Connecting',
  stopping: 'Stopping',
  offline: 'Offline',
  error: 'Error',
  unknown: 'Unknown'
};

export const statusLabel = (status) => STATUS_LABELS[status] ?? 'Unknown';

/** Tone name used by badges: ok, warn, danger, info, muted. */
export function statusTone(status) {
  switch (status) {
    case 'online': return 'ok';
    case 'connecting': return 'info';
    case 'stopping': return 'warn';
    case 'error': return 'danger';
    default: return 'muted';
  }
}

const KIND_LABELS = {
  msa: 'Microsoft',
  token: 'Token',
  offline: 'Offline'
};

export const kindLabel = (kind) => KIND_LABELS[kind] ?? 'Unknown';

export function kindTone(kind) {
  switch (kind) {
    case 'msa': return 'ok';
    case 'token': return 'info';
    default: return 'muted';
  }
}

/** "never", "3m ago", or an absolute stamp when it is recent. */
export const lastSeen = (timestamp) => (timestamp ? ago(timestamp) : 'never');

/**
 * What a Minecraft username looks like.
 *
 * The same rule the backend applies to list settings, kept here so the Settings
 * whitelist and the setup step that fills it reject a name for the same reason
 * and can say so at the field, rather than letting it vanish on save.
 */
export const USERNAME = /^[A-Za-z0-9_]{3,16}$/;

export function isUsername(value) {
  return USERNAME.test(String(value ?? '').trim());
}

/** "Notch, jeb_ and 2 others" - a list squeezed into one line. */
export function nameList(names, max = 2) {
  const list = (Array.isArray(names) ? names : []).map((name) => String(name ?? '')).filter(Boolean);
  if (!list.length) return 'nobody';
  if (list.length === 1) return list[0];
  if (list.length <= max + 1) return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${list.slice(0, max).join(', ')} and ${list.length - max} others`;
}
