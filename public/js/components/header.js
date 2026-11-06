import { $, h, icons } from '../dom.js';
import { store } from '../store.js';
import { THEME_COLOR, THEME_LABEL, nextThemeMode, normalizeThemeMode, resolveTheme } from '../theme.js';
import { toast } from './toast.js';

const MARKETS = [
  ['cn', '沪深'],
  ['hk', '港股'],
  ['us', '美股'],
];

/** 市场状态文字来自上游接口，只以文本方式插入页面 */
export function renderMarketStatus(status) {
  const el = $('#market-status');
  el.replaceChildren(
    ...MARKETS.map(([key, label]) => {
      const s = status?.[key];
      const text = s && typeof s.text === 'string' ? s.text : '';
      return h(
        'span',
        { class: `mkt${s?.open ? ' open' : ''}`, title: s ? `${label}：${text}` : `${label}：状态未知` },
        h('span', { class: 'mkt-dot' }),
        h('b', {}, label),
        s ? text : '--',
      );
    }),
  );
}

const CONN_TEXT = {
  idle: '未连接',
  connecting: '连接中',
  open: '实时',
  reconnecting: '重连中',
};

export function renderConnection({ state, latency, retryIn, mode = 'server' }) {
  const el = $('#conn');
  const direct = mode === 'static';
  el.classList.toggle('open', state === 'open');
  el.classList.toggle('down', state === 'reconnecting');
  let label = CONN_TEXT[state] ?? state;
  if (state === 'open') label = direct ? '直连' : '实时';
  if (state === 'open' && Number.isFinite(latency)) label = `${label} · ${latency}ms`;
  if (state === 'reconnecting' && retryIn) label = `重连中 (${Math.ceil(retryIn / 1000)}s)`;
  el.querySelector('.conn-label').textContent = label;
  if (direct) {
    el.title = state === 'open' ? '浏览器直接从行情接口轮询（约 3 秒刷新）' : '行情接口暂时无法访问，正在自动重试';
  } else {
    el.title = state === 'open' ? '已通过 WebSocket 接收实时推送' : '与行情服务器的连接已断开，正在自动重连';
  }
}

function startClock() {
  const el = $('#clock');
  const bj = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const ny = new Intl.DateTimeFormat('zh-CN', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
  const tick = () => {
    const now = new Date();
    el.textContent = `北京 ${bj.format(now).replace(/\//g, '-')}`;
    el.title = `纽约 ${ny.format(now)}`;
  };
  tick();
  setInterval(tick, 1000);
}

const systemLight = window.matchMedia('(prefers-color-scheme: light)');
const THEME_ICON = { auto: 'contrast', light: 'sun', dark: 'moon' };

/** 应用主题；返回实际主题是否发生了变化（图表需要按新配色重绘） */
function applyTheme() {
  const mode = normalizeThemeMode(store.settings.theme);
  const theme = resolveTheme(mode, systemLight.matches);
  const root = document.documentElement;
  const changed = root.dataset.theme !== theme;
  root.dataset.theme = theme;
  root.dataset.themeMode = mode;

  // 浏览器地址栏 / 状态栏颜色：跟随系统时两个带 media 的 meta 各管一种系统外观，手动指定时统一成所选主题
  for (const scheme of ['light', 'dark']) {
    document
      .getElementById(`theme-color-${scheme}`)
      ?.setAttribute('content', THEME_COLOR[mode === 'auto' ? scheme : theme]);
  }

  const next = nextThemeMode(mode);
  const btn = $('#btn-theme');
  btn.innerHTML = icons[THEME_ICON[mode]];
  const current = mode === 'auto' ? `跟随系统（当前${THEME_LABEL[theme]}）` : THEME_LABEL[mode];
  btn.title = `主题：${current}，点击切换为「${THEME_LABEL[next]}」`;
  btn.setAttribute('aria-label', btn.title);
  return changed;
}

function applyUpDown() {
  const mode = store.settings.colorMode === 'intl' ? 'intl' : 'cn';
  document.documentElement.dataset.updown = mode;
  $('#btn-updown').textContent = mode === 'cn' ? '红涨绿跌' : '绿涨红跌';
}

export function initHeader({ onThemeChange }) {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    if (!el.innerHTML.trim()) el.innerHTML = icons[el.dataset.icon] ?? '';
  });
  renderMarketStatus(null);
  startClock();
  // 版权年份：2026 起，跨年后显示为「2026–当前年份」
  const year = new Date().getFullYear();
  const years = $('#copyright-years');
  if (years && year > 2026) years.textContent = `2026–${year}`;
  applyTheme();
  applyUpDown();

  // 主题按钮：跟随系统 → 浅色 → 深色 → 跟随系统
  $('#btn-theme').addEventListener('click', () => {
    const mode = nextThemeMode(store.settings.theme);
    store.setSetting('theme', mode);
    if (applyTheme()) onThemeChange();
    const hint = mode === 'auto' ? `，当前为${THEME_LABEL[document.documentElement.dataset.theme]}` : '';
    toast(`主题：${THEME_LABEL[mode]}${hint}`, { duration: 1800 });
  });
  $('#btn-updown').addEventListener('click', () => {
    store.setSetting('colorMode', store.settings.colorMode === 'intl' ? 'cn' : 'intl');
    applyUpDown();
    onThemeChange();
  });
  // 系统切换深浅外观时（手动切换、定时自动切换），「跟随系统」模式下立即跟随
  const onSystemChange = () => {
    if (normalizeThemeMode(store.settings.theme) !== 'auto') return;
    if (applyTheme()) onThemeChange();
  };
  if (systemLight.addEventListener) systemLight.addEventListener('change', onSystemChange);
  else systemLight.addListener?.(onSystemChange); // iOS Safari 13 及更早
  // 从后台切回时再检查一次：部分 App 内浏览器在后台时不派发 change 事件
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) onSystemChange();
  });
}
