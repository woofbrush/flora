/**
 * The addon sandbox.
 *
 * Addon code is read from disk as text and run inside a `node:vm` context. It
 * is never handed to `import()`, and that is the whole point: an imported ESM
 * module gets `require`, `process`, `fs` and the network for free, so the only
 * way to give an addon a smaller world than Node is to not give it Node.
 *
 * What the context contains is exactly the `flora` object, a `console` that
 * writes to flora's own log, and the standard JavaScript built-ins that come
 * with any fresh context. There is no module system in there to reach for, and
 * `eval` and `new Function` are switched off, so an addon cannot build itself a
 * way out of the box it was put in.
 *
 * On what this is and is not worth: `node:vm` is documented by Node as not
 * being a security mechanism, and it should be read that way here. It is a real
 * structural boundary - addon code has no name for the filesystem, so it cannot
 * touch one by accident or by copying a snippet off the internet - but a
 * determined author who wanted out would find a way. The threat being defended
 * against is an addon that breaks things, not an adversary. Addons are code the
 * user chose to install, and the UI says so before the folder is dropped in.
 */
import vm from 'node:vm';

/** How long an addon may spend running at load time before it is cut off. */
const LOAD_TIMEOUT_MS = 5000;

/**
 * Run one addon's source.
 *
 * The source is wrapped in a function taking `flora`, so the API is a parameter
 * rather than a global - there is no name inside the sandbox that reaches it
 * except the one the addon was handed.
 *
 * The wrapper returns the addon's two optional lifecycle hooks. A script that
 * declares neither is still a valid addon: registering a command at the top
 * level is the common case and needs no ceremony.
 */
export function loadAddon({ manifest, source, api }) {
  const context = vm.createContext(Object.create(null), {
    name: `flora-addon:${manifest.id}`,
    // Blocking the string-compilation path closes `eval` and `new Function`,
    // which are the obvious ways to get from inside a context back out of it.
    codeGeneration: { strings: false, wasm: false }
  });

  // Addons get a console, because a person writing one will reach for it and a
  // `console is not defined` at line one is a poor first experience. It is
  // routed to flora's log rather than stdout so the output lands somewhere the
  // user can actually read it - the Activity view, tagged with the addon.
  context.console = Object.freeze({
    log: (...args) => api.log(args.map(String).join(' '), 'info'),
    info: (...args) => api.log(args.map(String).join(' '), 'info'),
    warn: (...args) => api.log(args.map(String).join(' '), 'warn'),
    error: (...args) => api.log(args.map(String).join(' '), 'error'),
    debug: (...args) => api.log(args.map(String).join(' '), 'debug')
  });

  const wrapped = `(function (flora) {\n"use strict";\n${source}\n\nreturn {\n` +
    `  activate: typeof activate === "function" ? activate : null,\n` +
    `  deactivate: typeof deactivate === "function" ? deactivate : null\n` +
    `};\n})`;

  let factory;
  try {
    factory = vm.runInContext(wrapped, context, {
      filename: `${manifest.id}/${manifest.main}`,
      timeout: LOAD_TIMEOUT_MS,
      displayErrors: true
    });
  } catch (err) {
    return { ok: false, error: formatError(err) };
  }

  if (typeof factory !== 'function') {
    return { ok: false, error: 'The addon did not evaluate to a script.' };
  }

  try {
    const hooks = factory(api);
    return { ok: true, hooks: hooks ?? {} };
  } catch (err) {
    return { ok: false, error: formatError(err) };
  }
}

/**
 * Run one call into addon code.
 *
 * Every entry point - a command handler, an event listener, a timer - goes
 * through here, so a single addon that throws cannot take down a bot's event
 * loop or stop the other addons from hearing the same event. The error is
 * returned rather than swallowed so the caller can put it in the log next to
 * the addon's name.
 */
export function guard(fn, onError) {
  return (...args) => {
    try {
      const result = fn(...args);
      // A handler that returns a rejected promise is a mistake nothing else
      // here would catch, since the throw happens after this frame has returned.
      if (result && typeof result.then === 'function') {
        result.then(undefined, (err) => onError(formatError(err)));
      }
      return result;
    } catch (err) {
      onError(formatError(err));
      return undefined;
    }
  };
}

/**
 * Errors out of a vm context carry a filename that already names the addon, so
 * the message only needs the stack trimmed to something that fits in a log row.
 */
function formatError(err) {
  const message = err?.message ?? String(err);
  const where = err?.stack ? /at .*\(?([^()\s]+:\d+:\d+)\)?/.exec(err.stack.split('\n')[1] ?? '') : null;
  return where ? `${message} (${where[1]})` : message;
}
