// 开屏页：显示品牌壁纸，底部进度条跟着真实的加载进度走（页面脚本 → 数据源 → 各个面板 → 第一批行情），
// 拿到行情后走满并淡出。两个阶段之间进度条缓慢前进，不会停住不动；网络很慢或出错时最多显示 8 秒。
// 普通脚本（CSP 不允许内联脚本），紧跟在开屏页标记后面同步执行，保证第一帧就开始动。
// 对外：window.StockPulseSplash.step(进度 0～1) 报告到达的加载阶段，.done() 表示加载完成。
(function () {
  var noop = function () {};
  var api = { step: noop, done: noop };
  window.StockPulseSplash = api;

  var el = document.getElementById('splash');
  if (!el) return;
  // 只在手机 / 平板（窄屏）上显示；电脑上直接移除，不挡页面
  if (!(window.matchMedia && window.matchMedia('(max-width: 899px)').matches)) {
    el.parentNode.removeChild(el);
    return;
  }

  var fill = el.querySelector('.splash-fill');
  var MIN_MS = 1200; // 至少显示这么久，让开屏能看清
  var MAX_MS = 8000; // 最多显示这么久：网络很慢或出错时也不挡住页面
  var start = Date.now();
  var last = start;
  var shown = 0; // 进度条当前显示的进度（0～1）
  var reached = 0; // 已经到达的加载阶段
  var creep = 0; // 两个阶段之间缓慢前进的进度
  var finished = false;
  var closed = false;
  var timer = 0;

  // 开屏期间把状态栏 / 地址栏颜色换成壁纸的深蓝：放在最前面的 theme-color 优先生效；结束后移除，恢复主题色
  var meta = document.createElement('meta');
  meta.setAttribute('name', 'theme-color');
  meta.setAttribute('content', '#01122f');
  document.head.insertBefore(meta, document.head.firstChild);

  var raf =
    window.requestAnimationFrame ||
    function (fn) {
      return setTimeout(fn, 16);
    };

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    el.classList.add('splash-hide'); // 淡出（CSS 过渡）
    if (meta.parentNode) meta.parentNode.removeChild(meta);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 600);
  }

  // 更新一帧进度
  function update() {
    if (closed) return;
    var now = Date.now();
    var dt = Math.min(100, now - last);
    last = now;
    if (now - start > MAX_MS) finished = true;
    var target = 1;
    if (!finished) {
      creep = Math.min(0.92, Math.max(creep, reached) + dt * 0.00008); // 约每秒前进 8%，最多到 92%
      target = Math.max(reached, creep);
    }
    // 平滑地追上目标进度；加载完成后加快，约 0.3 秒走满
    shown += (target - shown) * Math.min(1, dt * (finished ? 0.012 : 0.006));
    if (finished && 1 - shown < 0.004) shown = 1;
    fill.style.width = (shown * 100).toFixed(2) + '%';
    if (finished && shown >= 1 && now - start >= MIN_MS) close();
  }

  function frame() {
    update();
    if (!closed) raf(frame);
  }

  api.step = function (p) {
    if (p > reached) reached = Math.min(0.95, p);
  };
  api.done = function () {
    finished = true;
  };
  raf(frame);
  // 兜底：个别情况下逐帧回调迟迟不来（页面还在忙着加载等），用定时器接着推进，进度条不会停住
  timer = setInterval(function () {
    if (Date.now() - last > 120) update();
  }, 100);
})();
