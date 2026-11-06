import { $ } from './dom.js';
import { api } from './api.js';
import { store } from './store.js';
import { RealtimeClient } from './realtime.js';
import { fmtPrice, fmtPct } from './format.js';
import { initHeader, renderConnection, renderMarketStatus } from './components/header.js';
import { initSearch } from './components/search.js';
import { initTicker } from './components/ticker.js';
import { initWatchlist } from './components/watchlist.js';
import { initQuotePanel } from './components/quote.js';
import { initOrderbook } from './components/orderbook.js';
import { initTicks } from './components/ticks.js';
import { initRank } from './components/rank.js';
import { initAlerts } from './components/alerts.js';
import { initChartPanel } from './components/chart-panel.js';
import { toast } from './components/toast.js';

const SYMBOL_RE = /^((sh|sz|bj)\d{6}|hk(\d{5}|[A-Z]{2,8})|us[A-Z]{1,8}(\.[A-Z])?)$/;

function symbolFromHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  return SYMBOL_RE.test(raw) ? raw : null;
}

/** 选中某只股票：通过 hash 路由，使浏览器前进 / 后退与分享链接都可用 */
function pick(symbol) {
  if (!symbol) return;
  if (symbolFromHash() === symbol) store.select(symbol);
  else location.hash = `#/${symbol}`;
}

/* ------------------------------------------------------------- bootstrap */

const initial = symbolFromHash();
if (initial) store.selected = initial;

let chartPanel;
initHeader({ onThemeChange: () => chartPanel?.refreshTheme() });
initSearch({ onPick: pick });
initTicker({ onPick: pick });
initWatchlist({ onPick: pick });
const alerts = initAlerts({ onPick: pick });
initQuotePanel({ onAlert: (symbol) => alerts.openDialog(symbol) });
initOrderbook();
initTicks();
initRank({ onPick: pick });
chartPanel = initChartPanel();

window.addEventListener('hashchange', () => {
  const s = symbolFromHash();
  if (s) store.select(s);
});
if (!initial) history.replaceState(null, '', `#/${store.selected}`);

/* -------------------------------------------------------------- realtime */

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const rt = new RealtimeClient(wsUrl);
const banner = $('#banner');
let upstreamMessage = null;
let wasDisconnected = false;
let fallbackTimer = null;

function renderBanner() {
  const parts = [];
  if (store.provider?.provider === 'mock') parts.push('当前为离线演示模式：行情为模拟数据，与真实市场无关。');
  if (upstreamMessage) parts.push(`行情数据源暂时不可用（${upstreamMessage}），正在自动重试，页面显示的是最后一次成功获取的数据。`);
  banner.hidden = parts.length === 0;
  banner.textContent = parts.join(' ');
}

function setMarket(status) {
  store.market = status;
  renderMarketStatus(status);
  store.emit('market', status);
}

rt.on('hello', (msg) => {
  store.provider = msg;
  $('#provider-label').textContent = msg.providerLabel ?? '腾讯财经';
  upstreamMessage = msg.upstreamOk === false ? '上游无响应' : null;
  if (msg.market) setMarket(msg.market);
  renderBanner();
});
rt.on('quotes', (msg) => store.applyQuotes(msg.data ?? []));
rt.on('unknown', (msg) => store.markUnknown(msg.symbols ?? []));
rt.on('market', (msg) => setMarket(msg.data));
rt.on('upstream', (msg) => {
  upstreamMessage = msg.ok ? null : msg.message || '未知错误';
  renderBanner();
  if (msg.ok) toast('行情数据源已恢复', { kind: 'success', duration: 2500 });
});
rt.on('state', (s) => {
  renderConnection({ ...s, latency: rt.latency });
  if (s.state === 'open') {
    stopFallback();
    if (wasDisconnected) chartPanel.reload();
    wasDisconnected = false;
  } else if (s.state === 'reconnecting') {
    wasDisconnected = true;
    startFallback();
  }
});
rt.on('latency', (latency) => renderConnection({ state: rt.state, latency }));

store.on('subscriptions', () => rt.setSymbols(store.subscriptionSet()));
rt.setSymbols(store.subscriptionSet());
rt.connect();

window.addEventListener('online', () => rt.reconnectNow());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) rt.reconnectNow();
});

/* WebSocket 不可用（例如被公司代理拦截）时，自动降级为 HTTP 轮询，保证页面仍在更新 */
function startFallback() {
  if (fallbackTimer) return;
  const poll = async () => {
    try {
      const res = await api.quotes(store.subscriptionSet());
      store.applyQuotes(res.data ?? []);
      if (res.missing?.length) store.markUnknown(res.missing);
      if (!store.market) setMarket(await api.marketStatus());
    } catch {
      /* 服务器也不可达时保持静默，连接指示器已提示 */
    }
  };
  poll();
  fallbackTimer = setInterval(poll, 5000);
}
function stopFallback() {
  clearInterval(fallbackTimer);
  fallbackTimer = null;
}

/* ------------------------------------------------------- document title */

store.on('quotes', (changes) => {
  for (const { quote } of changes) {
    if (quote.symbol !== store.selected) continue;
    document.title = `${quote.name} ${fmtPrice(quote.price, quote.decimals)} ${fmtPct(quote.changePct)} · StockPulse`;
  }
});
store.on('select', (symbol) => {
  document.title = `${store.nameOf(symbol)} · StockPulse`;
});
