/* DeskFlow AI — Theme Engine v2  (light / dark + system detection) */
(function () {
  var html = document.documentElement;

  /* 1. Determine initial theme */
  var saved = localStorage.getItem('df-theme');
  var theme;
  if (saved === 'light' || saved === 'dark') {
    theme = saved;
  } else {
    /* First visit — mirror OS preference */
    theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
      ? 'light' : 'dark';
  }
  if (theme === 'light') html.setAttribute('data-theme', 'light');

  /* 2. Sync icon(s) */
  function _syncIcons() {
    var isLight = html.getAttribute('data-theme') === 'light';
    document.querySelectorAll('.df-theme-icon').forEach(function (el) {
      el.className = (isLight ? 'ti ti-moon-stars' : 'ti ti-sun') + ' df-theme-icon';
    });
  }

  /* 3. Public API */
  window.DFTheme = {
    toggle: function () {
      var isLight = html.getAttribute('data-theme') === 'light';
      var next = isLight ? 'dark' : 'light';
      html.setAttribute('data-theme', next);
      localStorage.setItem('df-theme', next);
      _syncIcons();
    },
    set: function (t) {
      html.setAttribute('data-theme', t);
      localStorage.setItem('df-theme', t);
      _syncIcons();
    },
    current: function () {
      return html.getAttribute('data-theme') || 'dark';
    }
  };

  /* 4. Sync on DOM ready */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _syncIcons);
  } else {
    _syncIcons();
  }

  /* 5. React to OS preference changes (only if user hasn't set a manual preference) */
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function (e) {
      if (!localStorage.getItem('df-theme')) {
        window.DFTheme.set(e.matches ? 'light' : 'dark');
      }
    });
  }
})();
