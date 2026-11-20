// 开屏页：页面结构与样式约束，以及 js/splash.js 的进度逻辑（用最小的假 DOM 运行）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('css/app.css').replace(/\/\*[\s\S]*?\*\//g, '');
const script = read('js/splash.js');

const MEDIA = '(max-width: 899px), (pointer: coarse)'; // 手机 / 平板：窄屏，或以触屏为主的设备

test('开屏页紧跟在 <body> 后面，进度脚本紧跟开屏页同步执行，主程序之前；壁纸只在手机 / 平板上预加载', () => {
  const body = html.indexOf('<body>');
  const splash = html.indexOf('<div class="splash" id="splash"');
  const splashJs = html.indexOf('<script src="js/splash.js"></script>');
  const app = html.indexOf('<div class="app" id="app"');
  const main = html.indexOf('<script type="module" src="js/main.js"></script>');
  assert.ok(body < splash && splash < splashJs && splashJs < app && app < main, '顺序：body → 开屏页 → splash.js → 页面 → main.js');
  assert.match(html, /<div class="splash" id="splash" aria-hidden="true">/);
  assert.ok(html.includes(`<link rel="preload" href="images/splash.jpg" as="image" media="${MEDIA}" />`));
  // 开屏期间的状态栏颜色：写在 <head> 里、排在其它 theme-color 前面（第一帧就生效），只对窄屏生效
  const metas = [...html.matchAll(/<meta name="theme-color"[^>]*>/g)].map((m) => m[0]);
  assert.ok(metas[0].includes(`id="theme-color-splash" media="${MEDIA}" content="#01122f"`), metas[0]);
  // 显示条件三处一致：页面 media、CSS、splash.js
  assert.ok(script.includes(`matchMedia('${MEDIA}')`));
  assert.ok(css.includes(`@media ${MEDIA} {\n  .splash {`));
  assert.ok(existsSync(new URL('../public/images/splash-bg.jpg', import.meta.url)));
  // boot.js 手动主题时改写 theme-color，不能把开屏的颜色也改掉
  assert.match(read('js/boot.js'), /metas\[i\]\.id !== 'theme-color-splash'/);
  assert.ok(existsSync(new URL('../public/images/splash.jpg', import.meta.url)));
});

test('开屏页样式：电脑上不显示；手机 / 平板全屏覆盖并盖在所有层之上；竖屏铺满、横屏虚化背景铺满；减少动态效果时不显示流光', () => {
  assert.match(css, /\n\.splash \{\s*display: none;\s*\}/, '默认（电脑）不显示');
  const narrow = css.match(/@media \(max-width: 899px\), \(pointer: coarse\) \{\s*\.splash \{([^}]*)\}/)?.[1] ?? '';
  assert.match(narrow, /display: block/);
  assert.match(narrow, /position: fixed/);
  const z = Number(narrow.match(/z-index: (\d+)/)?.[1]);
  const others = [...css.replace(narrow, '').matchAll(/z-index: (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(z > Math.max(...others), `开屏页 z-index ${z} 要高于其它所有层（最高 ${Math.max(...others)}）`);
  assert.match(css, /\.splash\.splash-hide \{[^}]*opacity: 0[^}]*visibility: hidden/s, '淡出');
  assert.match(css, /\.splash-art \{[^}]*width: max\(100vw, 66\.667vh\);\s*height: max\(150vw, 100vh\)[^}]*url\('\.\.\/images\/splash\.jpg'\)/s);
  assert.match(css, /\.splash-bar \{[^}]*left: 26\.95%;\s*width: 46%;\s*top: 86\.85%/s, '进度条在壁纸原来的位置');
  // 横屏（比 3:4 宽，19/25 = 0.76）：整屏铺虚化背景，清晰壁纸按高度完整显示；3:4 的竖屏平板仍直接铺满
  const wide = css.match(/@media \(min-aspect-ratio: 19\/25\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(wide, /\.splash::before \{[^}]*top: 0;[^}]*bottom: 0;[^}]*url\('\.\.\/images\/splash-bg\.jpg'\) center \/ cover/s);
  assert.match(wide, /\.splash-art \{[^}]*width: 66\.667vh;\s*height: 100vh/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.splash-shine \{\s*display: none;/);
});

/** 用最小的假 DOM 运行 splash.js；返回控制对象与观测到的状态 */
function runSplash({ narrow = true } = {}) {
  const classes = new Set();
  const fill = { style: { width: '' } };
  const head = { removeChild(node) { node.parentNode = null; } };
  const meta = { parentNode: head, content: '#01122f' };
  const body = { removeChild(node) { node.parentNode = null; } };
  const splash = {
    parentNode: body,
    classList: { add: (c) => classes.add(c) },
    querySelector: (sel) => (sel === '.splash-fill' ? fill : null),
  };
  const document = {
    head,
    getElementById: (id) => ({ splash, 'theme-color-splash': meta })[id] ?? null,
  };
  const window = {
    matchMedia: () => ({ matches: narrow }),
    requestAnimationFrame: (fn) => setTimeout(fn, 16),
  };
  const timers = [];
  const ctx = vm.createContext({
    window,
    document,
    Date,
    Math,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; },
    clearInterval,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); timers.push(t); return t; },
  });
  vm.runInContext(script, ctx);
  return {
    api: window.StockPulseSplash,
    width: () => parseFloat(fill.style.width) || 0,
    hiding: () => classes.has('splash-hide'),
    removed: () => splash.parentNode === null,
    themeMeta: () => (meta.parentNode ? meta.content : null),
    cleanup: () => timers.forEach((t) => { clearTimeout(t); clearInterval(t); }),
  };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('开屏进度：一开始就在动，按加载阶段前进且只进不退；加载完成后走满，至少显示 1.2 秒再淡出移除，并恢复状态栏颜色', async () => {
  const s = runSplash();
  try {
    assert.equal(s.themeMeta(), '#01122f', '开屏期间状态栏用壁纸的深蓝');
    await wait(150);
    const w1 = s.width();
    assert.ok(w1 > 0, `没有任何阶段报告时也在缓慢前进（${w1}%）`);
    s.api.step(0.6);
    await wait(250);
    const w2 = s.width();
    assert.ok(w2 > w1 && w2 > 40, `到达 60% 阶段后追上去（${w2}%）`);
    s.api.step(0.3); // 迟到的、更早的阶段不让进度倒退
    await wait(80);
    assert.ok(s.width() >= w2);
    s.api.done();
    await wait(400);
    assert.equal(s.width(), 100, '加载完成后走满');
    assert.ok(!s.hiding(), '不到 1.2 秒不淡出');
    await wait(700);
    assert.ok(s.hiding(), '1.2 秒后淡出');
    assert.equal(s.themeMeta(), null, '状态栏颜色恢复');
    await wait(700);
    assert.ok(s.removed(), '淡出后从页面移除');
  } finally {
    s.cleanup();
  }
});

test('电脑（宽屏）上不显示开屏页：直接移除，接口照常可调用', () => {
  const s = runSplash({ narrow: false });
  try {
    assert.ok(s.removed());
    assert.equal(s.themeMeta(), null);
    s.api.step(0.5);
    s.api.done();
  } finally {
    s.cleanup();
  }
});

test('还没报告任何加载阶段时（网络慢、页面脚本还在下载）：进度条先快后慢地前进，不会停在原地，也不会自己走满', async () => {
  const s = runSplash();
  try {
    await wait(300);
    const w1 = s.width();
    assert.ok(w1 >= 5, `0.3 秒时已有明显进度（${w1}%）`);
    await wait(700);
    const w2 = s.width();
    assert.ok(w2 >= 20 && w2 > w1, `1 秒时继续前进（${w2}%）`);
    await wait(600);
    assert.ok(s.width() < 90, `没有加载完成就不会走满（${s.width()}%）`);
    assert.ok(!s.hiding());
  } finally {
    s.cleanup();
  }
});
