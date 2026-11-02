// Applies the saved app theme before the page draws (no flash). "system" follows the device.
// Loaded as a classic blocking script because the page's policy allows no inline scripts.
(function () {
  var KEY = 'companion-theme', CHOICES = ['system', 'light', 'dark'];
  function saved() { try { var v = localStorage.getItem(KEY); return CHOICES.indexOf(v) >= 0 ? v : 'system'; } catch (e) { return 'system'; } }
  var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function apply(choice) {
    var dark = choice === 'dark' || (choice === 'system' && !!query && query.matches);
    var root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.themeChoice = choice;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#231B22' : '#FFF6EE');
  }
  window.companionTheme = {
    get: saved,
    set: function (choice) {
      if (CHOICES.indexOf(choice) < 0) return;
      try { localStorage.setItem(KEY, choice); } catch (e) { /* Private mode: applies for this visit only. */ }
      apply(choice);
    }
  };
  apply(saved());
  if (query) {
    var follow = function () { if (saved() === 'system') apply('system'); };
    if (query.addEventListener) query.addEventListener('change', follow); else if (query.addListener) query.addListener(follow);
  }
  document.addEventListener('DOMContentLoaded', function () { apply(saved()); });
})();
