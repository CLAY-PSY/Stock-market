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

test('触屏设备隐藏滚动条（整页上下滑动时右侧不出现竖条），鼠标设备保留', () => {
  const rules = topLevelRules(css);
  const touch = rules.find((r) => r.prelude === '@media (hover: none) and (pointer: coarse)' && r.body.includes('scrollbar-width'));
  assert.ok(touch, '缺少触屏设备的滚动条规则');
  for (const sel of ['html,', 'html *', '.wl-list', '.rank-list', '.ticks', '.alert-list', '.search-results']) assert.ok(touch.body.includes(sel), sel);
  assert.match(touch.body, /scrollbar-width:\s*none/);
  assert.match(touch.body, /html::-webkit-scrollbar,\s*html \*::-webkit-scrollbar\s*\{\s*display:\s*none/);
  // 按类名设置细滚动条的列表，在触屏规则里都要覆盖到（否则类选择器优先级更高，滚动条仍会出现）
  const thin = rules.filter((r) => !r.prelude.startsWith('@') && /scrollbar-width:\s*thin/.test(r.body));
  for (const r of thin) for (const sel of r.prelude.split(',').map((s) => s.trim())) assert.ok(touch.body.includes(sel), `触屏规则未覆盖 ${sel}`);
});

test('价格与涨跌上下平衡：行情页两行涨跌与大号价格居中，指数条涨跌与点数居中', () => {
  const rules = topLevelRules(css);
  const block = rules.find((r) => r.prelude === '.q-price-block');
  assert.match(block?.body ?? '', /align-items:\s*center/, '大号价格与两行涨跌应上下居中（按基线对齐时第二行会垂到价格下方）');
  const chg = rules.find((r) => r.prelude === '.tk-chg');
  assert.match(chg?.body ?? '', /align-self:\s*center/, '指数条涨跌应与点数上下居中（贴底对齐会显得往下沉）');
});

test('手机上行情页的第一块面板与自选、排行页同高（隐藏左栏后不再多出栏间距）', () => {
  const mobile = topLevelRules(css).filter((r) => r.prelude === '@media (max-width: 899px)').map((r) => r.body).join('\n');
  assert.match(mobile, /\.app\[data-view='quote'\] \.col-main\s*\{\s*margin-top:\s*0;/);
});

test('手机上成交明细到一定高度后在框内滑动（不把整页拉长，也不截断行数）', () => {
  const mobile = topLevelRules(css).filter((r) => r.prelude === '@media (max-width: 899px)').map((r) => r.body).join('\n');
  const ticks = mobile.match(/\n\s*\.ticks\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(ticks, /max-height:\s*320px/);
  assert.match(ticks, /overflow-y:\s*auto/);
  assert.match(ticks, /overscroll-behavior-y:\s*contain/);
  assert.doesNotMatch(mobile, /\.tick:nth-child\(n \+ \d+\)\s*\{\s*display:\s*none/, '不要再隐藏第 31 行以后的成交');
});

test('主屏幕 App 的液体玻璃底部导航（与选号页同款材质）：通透玻璃、高光描边、透镜滑块，内容可滚到玻璃上方', () => {
  const rules = topLevelRules(css).filter((r) => r.prelude === '@media (max-width: 899px)').map((r) => r.body).join('\n');
  assert.match(rules, /html\.standalone \{[^}]*--tabbar-space:\s*calc\(var\(--glass-bottom\) \+ var\(--glass-h\) \+ 10px\)/, '内容底部留白要算上悬浮导航');
  // 透明：几乎无色的底色，背景滤镜里不模糊（背后的内容和不隔玻璃时一样清楚）
  assert.match(rules, /--glass-bg:\s*rgba\(20, 22, 40, 0\.04\)/);
  assert.match(rules, /--glass-bg:\s*rgba\(255, 255, 255, 0\.04\)/);
  const filters = [...rules.matchAll(/--glass-blur:\s*([^;]+);/g)].map((m) => m[1]);
  assert.equal(filters.length, 2);
  for (const f of filters) assert.doesNotMatch(f, /blur\(/, `玻璃不模糊：${f}`);
  // 选中滑块也是透明玻璃（浅色不超过 50% 白）
  assert.match(rules, /--thumb-bg:\s*rgba\(255, 255, 255, 0\.45\)/);
  assert.match(rules, /--thumb-bg:\s*rgba\(255, 255, 255, 0\.12\)/);
  assert.match(rules, /html\.standalone \.tabbar \{[^}]*border-radius:\s*calc\(var\(--glass-h\) \/ 2\)[^}]*backdrop-filter:\s*var\(--glass-blur\)/s, '胶囊形毛玻璃');
  // 高光描边：渐变 + 两层遮罩相减成一圈
  assert.match(rules, /html\.standalone \.tabbar::before,\s*html\.standalone \.tab-thumb::before \{[^}]*background:\s*var\(--glass-rim\)[^}]*mask-composite/s);
  // 选中滑块：随当前标签滑动，按住时放大成透镜
  assert.match(rules, /html\.standalone \.tab-thumb \{[^}]*translate:\s*calc\(var\(--tab-i, 0\) \* 100%\) 0/s);
  assert.match(rules, /html\.standalone \.tabbar\.pressing \.tab-thumb \{[^}]*--thumb-s:\s*1\.1/s);
  assert.match(rules, /html\.standalone \.alert-list \{[^}]*padding-bottom:\s*var\(--tabbar-space\)/, '提醒列表最后一条能滚到玻璃上方');
  // 浏览器里不显示滑块
  assert.ok(topLevelRules(css).some((r) => r.prelude === '.tab-thumb' && /display:\s*none/.test(r.body)));
  // 其它地方都按 --tabbar-space 计算，不再直接用导航高度 + 安全区（否则悬浮导航下会被遮住）
  const uses = css.match(/calc\(var\(--tabbar-h\) \+ var\(--safe-bottom\)\)/g) ?? [];
  assert.equal(uses.length, 2, '只有变量定义和普通底部导航自身的高度直接用 --tabbar-h + --safe-bottom');
});

test('横屏底部导航的「提醒」角标不盖住文字（图标与文字左右排列时，角标右边缘固定在文字左侧）', () => {
  const land = topLevelRules(css).find((r) => r.prelude === '@media (max-width: 899px) and (orientation: landscape) and (max-height: 520px)' && r.body.includes('.tabbar .badge'));
  assert.ok(land, '缺少横屏底部导航规则');
  assert.match(land.body, /\.tabbar \.badge\s*\{[^}]*right:\s*calc\(50% \+ 1px\)/);
});
