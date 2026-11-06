// 在首屏渲染前应用主题与涨跌配色，避免闪烁（CSP 不允许内联脚本，所以单独成文件）
(function () {
  var root = document.documentElement;
  var settings = {};
  try {
    settings = (JSON.parse(localStorage.getItem('stockpulse:v1') || '{}') || {}).settings || {};
  } catch (e) {
    /* ignore */
  }
  var theme = settings.theme;
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-updown', settings.colorMode === 'intl' ? 'intl' : 'cn');
})();
