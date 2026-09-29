/**
 * Bounded concurrency.
 *
 * `mapLimit` lives here rather than in the account service because three
 * modules need it and one of them - proxies - is imported *by* the account
 * service. Leaving it where it was would have made `accounts` and `proxies`
 * import each other, and a cycle between two modules that both touch the
 * database at import time is a load-order bug waiting to happen.
 */

/** Run `fn` over `items` with at most `limit` in flight. Order is preserved. */
export async function mapLimit(items, limit, fn, { onProgress } = {}) {
  const list = [...items];
  const results = new Array(list.length);
  let cursor = 0;
  let done = 0;

  const width = Math.max(1, Math.min(limit, list.length));
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= list.length) return;
      try {
        results[index] = await fn(list[index], index);
      } catch (err) {
        results[index] = { ok: false, error: err?.message ?? String(err) };
      }
      done += 1;
      onProgress?.(done, list.length);
    }
  });

  await Promise.all(workers);
  return results;
}
