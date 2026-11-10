import { $ } from './dom.js';
import { api, capabilities, useDirectProvider } from './api.js';
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
import { initMobileNav, isMobile } from './components/mobile-nav.js';

const SYMBOL_RE = /^((sh|sz|bj)\d{6}|hk(\d{5}|[A-Z]{2,8})|us[A-Z]{1,8}(\.[A-Z])?)$/;

function symbolFromHash() {
  let raw;
  try {
    raw = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  } catch {
    return null; // 地址栏里的 hash 不是合法的百分号编码（例如 #/%E0%A4%A）
  }
  return SYMBOL_RE.test(raw) ? raw : null;
}

let nav = null;

/**
 * 选中某只股票。通过 hash 路由，浏览器前进 / 后退与分享链接都可用。
 * 手机上从列表（自选 / 排行 / 搜索 / 提醒）进入时切到「行情」视图并新增一条历史记录，返回键回到列表；
 * 如果当前处在搜索 / 提醒面板上，则替换面板那条记录，避免返回时多停一次。
 */
function pick(symbol, { replace = false } = {}) {
  if (!symbol) return;
  const fromList = isMobile() && nav.view !== 'quote';
  const overSheet = Boolean(history.state?.sheet);
  const sameSymbol = symbolFromHash() === symbol;
  const write = (state) =>
    (replace || overSheet ? history.replaceState : history.pushState).call(history, state, '', `#/${symbol}`);
  if (fromList) {
    write({ view: 'quote' });
    nav.apply('quote');
  } else if (!sameSymbol || overSheet) {
    write({ view: nav.view });
  }
  store.select(symbol);
}

/**
 * 运行模式：
 *   server — 由本项目的 Node.js 服务提供数据（WebSocket 推送）；
 *   static — 纯静态托管（GitHub Pages 等），浏览器直连行情接口并在本地轮询。
 * <meta name="stockpulse-mode"> 由托管方声明：Node.js 服务返回页面时写为 server，GitHub Pages 构建时写为 static。
 * 托管方已声明时以它为准（服务端的 CSP 只允许同源请求，强行切到直连模式会被拦截）；
 * 只有 auto（例如用其它静态服务器直接打开 public/）时才看 URL 参数 ?mode=，再自动探测。
 */
async function detectMode() {
  const declared = document.querySelector('meta[name="stockpulse-mode"]')?.content || 'auto';
  if (declared === 'server' || declared === 'static') return declared;
  const forced = new URLSearchParams(location.search).get('mode');
  if (forced === 'server' || forced === 'static') return forced;
  try {
    const res = await fetch('api/health', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (res.ok && (await res.json())?.ok) return 'server';
  } catch {
    /* 没有服务端 */
  }
  return 'static';
}

/* ------------------------------------------------------------- bootstrap */

const mode = await detectMode();
document.documentElement.dataset.mode = mode;
let directProvider = null;
if (mode === 'static') {
  ({ directProvider } = await import('./data/direct-provider.js'));
  useDirectProvider(directProvider);
}

const initial = symbolFromHash();
if (initial) store.selected = initial;

nav = initMobileNav({ hasInitialSymbol: Boolean(initial) });

let chartPanel;
initHeader({ onThemeChange: () => chartPanel?.refreshTheme() });
initSearch({
  onPick: pick,
  sheet: {
    open: (close) => nav.openSheet('search', close),
    closed: () => nav.sheetClosed('search'),
  },
});
initTicker({ onPick: pick });
initWatchlist({ onPick: pick });
const alerts = initAlerts({
  onPick: pick,
  onDrawerChange: (open) => (open ? nav.openSheet('alerts', () => alerts.closeDrawer()) : nav.sheetClosed('alerts')),
});
nav.onChange((view) => {
  if (view === 'alerts') alerts.openDrawer();
});
initQuotePanel({ onAlert: (symbol) => alerts.openDialog(symbol) });

// 新访客：从各市场当前的活跃股（按成交额）中随机挑选默认自选；单个市场取不到时由 store 改用备用股票池
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
store.initDefaultWatchlist(async () => {
  const markets = capabilities().activeMarkets ?? ['cn', 'hk', 'us'];
  const results = await Promise.all(
    markets.map((m) =>
      withTimeout(api.activeStocks(m), 8000).then(
        (res) => [m, res.items],
        () => [m, null],
      ),
    ),
  );
  return Object.fromEntries(results);
});
initOrderbook();
initTicks();
initRank({ onPick: pick });
chartPanel = initChartPanel();

// 前进 / 后退、手动修改地址栏中的代码
const syncFromHash = () => {
  const s = symbolFromHash();
  if (s) store.select(s);
};
window.addEventListener('popstate', syncFromHash);
window.addEventListener('hashchange', syncFromHash);
if (!initial) history.replaceState({ ...(history.state ?? {}), view: nav.view }, '', `#/${store.selected}`);

/* -------------------------------------------------------------- realtime */

let rt;
if (mode === 'static') {
  const { LocalRealtime } = await import('./data/local-hub.js');
  rt = new LocalRealtime(directProvider);
} else {
  const wsUrl = new URL('ws', location.href);
  wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.hash = '';
  wsUrl.search = '';
  rt = new RealtimeClient(wsUrl.href);
}
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
// 服务端的提示（例如订阅数量达到上限）：节流显示，避免刷屏
let lastServerNotice = 0;
rt.on('error', (msg) => {
  if (!msg.message || Date.now() - lastServerNotice < 30_000) return;
  lastServerNotice = Date.now();
  toast(String(msg.message).slice(0, 120), { kind: 'warn', duration: 4000 });
});
rt.on('upstream', (msg) => {
  upstreamMessage = msg.ok ? null : msg.message || '未知错误';
  renderBanner();
  if (msg.ok) {
    toast('行情数据源已恢复', { kind: 'success', duration: 2500 });
    chartPanel.retryIfFailed(); // 图表之前没加载出来的，现在重新加载
  }
});
rt.on('state', (s) => {
  renderConnection({ ...s, latency: rt.latency, mode });
  if (mode === 'static') return; // 直连模式本身就是轮询，无需降级
  if (s.state === 'open') {
    stopFallback();
    if (wasDisconnected) chartPanel.reload();
    wasDisconnected = false;
  } else if (s.state === 'reconnecting') {
    wasDisconnected = true;
    startFallback();
  }
});
rt.on('latency', (latency) => renderConnection({ state: rt.state, latency, mode }));

store.on('subscriptions', () => rt.setSymbols(store.subscriptionSet()));
rt.setSymbols(store.subscriptionSet());
rt.connect();

// 网络恢复、切回前台、页面从缓存恢复（手机上切回浏览器 / 主屏幕 App）：立即刷新行情
window.addEventListener('online', () => rt.reconnectNow());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) rt.reconnectNow();
});
window.addEventListener('pageshow', (e) => {
  if (e.persisted) rt.reconnectNow();
});

/* WebSocket 不可用（例如被公司代理拦截）时，自动降级为 HTTP 轮询，保证页面仍在更新 */
function startFallback() {
  if (fallbackTimer) return;
  const poll = async () => {
    try {
      // 服务端单次最多接受 200 个代码，分批请求
      const symbols = store.subscriptionSet();
      for (let i = 0; i < symbols.length; i += 150) {
        const res = await api.quotes(symbols.slice(i, i + 150));
        store.applyQuotes(res.data ?? []);
        if (res.missing?.length) store.markUnknown(res.missing);
      }
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
