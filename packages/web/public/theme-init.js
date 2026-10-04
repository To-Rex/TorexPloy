(function () {
  try {
    var theme = localStorage.getItem('ploy.theme') || 'system';
    var dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    var locale = localStorage.getItem('ploy.locale');
    if (locale === 'uz' || locale === 'ru' || locale === 'en') document.documentElement.lang = locale;
  } catch (error) {
    document.documentElement.dataset.theme = 'light';
  }
})();
