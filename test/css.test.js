// 样式表的跨平台约束：防止已修复的问题再次出现
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** 拆出顶层规则：[{ prelude, body }] */
function topLevelRules(source) {
  const rules = [];
  let depth = 0;
  let start = 0;
  let prelude = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      if (depth === 0) {
        prelude = source.slice(start, i).trim();
        start = i + 1;
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        rules.push({ prelude, body: source.slice(start, i) });
        start = i + 1;
      }
    }
  }
  return rules;
}

test('悬停样式只在有悬停能力的设备上生效（触屏点按后不会残留高亮）', () => {
  const offenders = topLevelRules(css)
    .filter((r) => !r.prelude.startsWith('@') && r.prelude.includes(':hover'))
    .map((r) => r.prelude);
  assert.deepEqual(offenders, [], '顶层的 :hover 规则应放进 @media (hover: hover)');
});

test('不使用 inset 简写（iOS 14.0 及以下不支持，绝对定位的图表会失去尺寸）', () => {
  const lines = css.split('\n').filter((l) => /(^|[\s;{])inset\s*:/.test(l));
  assert.deepEqual(lines, []);
});

test('减少动态效果：动画只播放一次，不会以极短周期无限循环', () => {
  const block = topLevelRules(css).find((r) => r.prelude.includes('prefers-reduced-motion: reduce'));
  assert.ok(block, '缺少 prefers-reduced-motion 适配');
  assert.match(block.body, /animation-iteration-count:\s*1\s*!important/);
  assert.match(block.body, /transition-duration/);
});

test('强制颜色模式（Windows 高对比度）：状态圆点保留颜色，选中状态有轮廓', () => {
  const block = topLevelRules(css).find((r) => r.prelude.includes('forced-colors: active'));
  assert.ok(block, '缺少 forced-colors 适配');
  assert.match(block.body, /forced-color-adjust:\s*none/);
  assert.match(block.body, /aria-pressed='true'/);
  assert.match(block.body, /Highlight/);
});

test('依赖 color-mix() 的声明都有旧浏览器兜底', () => {
  const fallback = topLevelRules(css).find((r) => r.prelude.startsWith('@supports not (color: color-mix('));
  assert.ok(fallback, '缺少不支持 color-mix 时的兜底');
  for (const sel of ['--up-soft', '.chart-overlay', '.btn-primary:hover']) assert.ok(fallback.body.includes(sel), sel);
});

test('图表区域隔离层叠上下文（图表库内部的 z-index 不能盖住顶栏和底部导航）', () => {
  const rule = topLevelRules(css).find((r) => r.prelude === '.chart-wrap');
  assert.ok(rule, '缺少 .chart-wrap 规则');
  assert.match(rule.body, /isolation:\s*isolate/);
});

test('iOS 主屏幕 App：文档至少比 100% 高出顶部安全区（提醒和搜索锁定滚动时，底部导航不悬空）', () => {
  const block = topLevelRules(css).find((r) => r.prelude === '@media (display-mode: standalone)');
  assert.ok(block, '缺少主屏幕 App 的适配');
  assert.match(block.body, /@supports \(-webkit-touch-callout: none\)/, '只对 iOS 生效');
  assert.match(block.body, /html\s*\{\s*min-height:\s*calc\(100% \+ env\(safe-area-inset-top, 0px\)\);/);
});

test('主屏幕 App：整页不回弹，导航和列表不选中文字，浅色主题给状态栏垫深色底', () => {
  const rules = topLevelRules(css);
  const find = (sel) => rules.find((r) => r.prelude.split(',').map((s) => s.trim()).includes(sel));
  assert.match(find('html.standalone')?.body ?? '', /overscroll-behavior-y:\s*none/);
  const noSelect = find('html.standalone .tabbar');
  assert.ok(noSelect, '缺少主屏幕 App 的禁止选中规则');
  for (const sel of ['html.standalone button', 'html.standalone .wl-item', 'html.standalone .rank-item']) assert.ok(noSelect.prelude.includes(sel), sel);
  assert.ok(!/input|textarea|\.search\b|\.topbar\b/.test(noSelect.prelude), '不能波及输入框（iOS 上父元素禁止选中会导致输入框无法输入）');
  assert.match(noSelect.body, /-webkit-user-select:\s*none/);
  const strip = find("html.standalone[data-theme='light'] body::before");
  assert.ok(strip, '缺少浅色主题的状态栏底色');
  assert.match(strip.body, /height:\s*env\(safe-area-inset-top, 0px\)/);
  assert.match(strip.body, /pointer-events:\s*none/);
});

test('主屏幕 App 不使用透明状态栏（iOS 26 会在它下方叠一层模糊，标题栏雾蒙蒙）', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(html, /apple-mobile-web-app-status-bar-style/, '不要设置 apple-mobile-web-app-status-bar-style');
  assert.match(html, /<meta name="theme-color"[^>]*prefers-color-scheme: dark/, '状态栏颜色来自 theme-color');
  assert.match(html, /viewport-fit=cover/, '保留 viewport-fit=cover（横屏刘海与底部横条）');
});

test('平板两栏布局优先用 svh（iOS 主屏幕 App 的 100vh 偏大，Safari 工具栏伸缩时左栏不重排）', () => {
  const tablet = topLevelRules(css).find((r) => r.prelude === '@media (max-width: 1280px)');
  assert.ok(tablet, '缺少平板布局');
  assert.match(tablet.body, /@supports \(height: 100svh\)[\s\S]*min-height:\s*100svh[\s\S]*height:\s*calc\(100svh - var\(--topbar-h\)/);
});
