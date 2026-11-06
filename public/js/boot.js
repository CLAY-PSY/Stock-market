// 首屏渲染前执行（普通脚本，CSP 不允许内联脚本，所以单独成文件）：
// 1. 为较旧的移动端浏览器补齐页面用到的新 API；
// 2. 应用主题与涨跌配色，避免闪烁；
// 3. 标记触屏 / 主屏幕（PWA）启动等环境，供 CSS 使用。
(function () {
  /* ---------------------------------------------------------------- polyfills */

  // Array.prototype.at：iOS Safari 15.4 以下没有
  if (!Array.prototype.at) {
    Object.defineProperty(Array.prototype, 'at', {
      configurable: true,
      writable: true,
      value: function at(n) {
        var i = Math.trunc(n) || 0;
        if (i < 0) i += this.length;
        return i < 0 || i >= this.length ? undefined : this[i];
      },
    });
  }

  // AbortSignal.timeout：iOS Safari 16 以下、部分国产浏览器内核没有
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
    AbortSignal.timeout = function timeout(ms) {
      var ctrl = new AbortController();
      setTimeout(function () {
        var reason;
        try {
          reason = new DOMException('signal timed out', 'TimeoutError');
        } catch (e) {
          reason = new Error('signal timed out');
          reason.name = 'TimeoutError';
        }
        ctrl.abort(reason);
      }, ms);
      return ctrl.signal;
    };
  }

  // Element.replaceChildren：iOS Safari 14 以下没有
  if (typeof Element !== 'undefined' && !Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function replaceChildren() {
      while (this.lastChild) this.removeChild(this.lastChild);
      this.append.apply(this, arguments);
    };
  }

  /* ------------------------------------------------------------ theme & env */

  var root = document.documentElement;
  var settings = {};
  try {
    settings = (JSON.parse(localStorage.getItem('stockpulse:v1') || '{}') || {}).settings || {};
  } catch (e) {
    /* 隐私模式等情况下 localStorage 不可用 */
  }
  var theme = settings.theme;
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-updown', settings.colorMode === 'intl' ? 'intl' : 'cn');

  // 浏览器地址栏 / 状态栏颜色与主题一致
  var themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute('content', theme === 'dark' ? '#11161f' : '#ffffff');

  var mq = function (q) {
    return !!(window.matchMedia && window.matchMedia(q).matches);
  };
  if (mq('(pointer: coarse)') || 'ontouchstart' in window) root.classList.add('touch');
  if (mq('(display-mode: standalone)') || window.navigator.standalone) root.classList.add('standalone');
  if (/MicroMessenger/i.test(navigator.userAgent)) root.classList.add('wechat');
})();
