/*
 * Pre-paint bootstrap.
 *
 * A classic script, loaded synchronously in <head>, for one reason: the theme
 * has to be on <html> before the first frame is painted, or anyone who changed
 * the accent sees a flash of the default on every launch.
 *
 * The authoritative values live in the settings table, which needs an IPC round
 * trip. These are a mirror of the last known ones, kept in localStorage purely
 * to cover the window between paint and the first settings event. If they are
 * missing or stale the defaults in tokens.css stand, and the real values arrive
 * a moment later.
 */
(function () {
  var KEYS = ['theme', 'accent', 'radius', 'density', 'accentCustom'];

  function apply(saved) {
    if (!saved || typeof saved !== 'object') return;
    var root = document.documentElement;
    for (var i = 0; i < KEYS.length; i++) {
      var key = KEYS[i];
      if (!saved[key]) continue;
      if (key === 'accentCustom') root.style.setProperty('--accent', saved[key]);
      else root.dataset[key] = saved[key];
    }
  }

  try {
    apply(JSON.parse(localStorage.getItem('flora.appearance') || 'null'));
  } catch (err) {
    // A corrupt entry should not be able to stop the app from starting.
    try { localStorage.removeItem('flora.appearance'); } catch (e) { /* ignore */ }
  }

  // Exposed so the settings view can keep the mirror current without a second
  // copy of these key names.
  window.__floraAppearance = { keys: KEYS, apply: apply };
})();
