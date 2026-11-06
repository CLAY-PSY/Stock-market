import { $, icons } from '../dom.js';
import { store } from '../store.js';

const MARKETS = [
  ['cn', '沪深'],
  ['hk', '港股'],
  ['us', '美股'],
];

export function renderMarketStatus(status) {
  const el = $('#market-status');
  el.innerHTML = '';
  for (const [key, label] of MARKETS) {
    const s = status?.[key];
    const chip = document.createElement('span');
    chip.className = `mkt${s?.open ? ' open' : ''}`;
    chip.title = s ? `${label}：${s.text}` : `${label}：状态未知`;
    chip.innerHTML = `<span class="mkt-dot"></span><b>${label}</b>${s ? s.text : '--'}`;
    el.append(chip);
  }
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

function applyTheme() {
  const theme = store.settings.theme ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  // 手机浏览器地址栏 / 状态栏颜色
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#11161f' : '#ffffff');
  $('#btn-theme').innerHTML = theme === 'dark' ? icons.sun : icons.moon;
  $('#btn-theme').title = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
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
  applyTheme();
  applyUpDown();

  $('#btn-theme').addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    store.setSetting('theme', current === 'dark' ? 'light' : 'dark');
    applyTheme();
    onThemeChange();
  });
  $('#btn-updown').addEventListener('click', () => {
    store.setSetting('colorMode', store.settings.colorMode === 'intl' ? 'cn' : 'intl');
    applyUpDown();
    onThemeChange();
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (store.settings.theme) return;
    applyTheme();
    onThemeChange();
  });
}
