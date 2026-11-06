import { $, $$, h } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { marketOf } from '../format.js';
import { StockChart } from '../chart.js';

const INTRADAY = new Set(['minute', 'minute5']);
const MINUTE_K = new Set(['m1', 'm5', 'm15', 'm30', 'm60']);
const KLINE_COUNT = { day: 500, week: 500, month: 400, m1: 480, m5: 480, m15: 400, m30: 400, m60: 400 };

/** 图表区域：周期 / 复权 / 指标工具栏 + 数据加载 + 实时更新 */
export function initChartPanel() {
  const overlay = $('#chart-overlay');
  const periodTabs = $('#period-tabs');
  const opts = $('#chart-opts');
  const adjustEl = $('#adjust');
  const mainInd = $('#main-ind');
  const subInd = $('#sub-ind');
  let token = 0;
  let ctrl = null;
  let loadedKey = null;
  let refreshTimer = null;

  // 新交易日开始时分时图需要整体重载；节流，避免上游尚未切换日期时每次推送都重载
  let lastStaleReload = 0;
  const chart = new StockChart($('#chart'), {
    onStale: () => {
      if (Date.now() - lastStaleReload < 60_000) return;
      lastStaleReload = Date.now();
      load({ quiet: true });
    },
  });

  const effectivePeriod = () => {
    const p = store.settings.period;
    if (MINUTE_K.has(p) && marketOf(store.selected) !== 'cn') return 'day';
    return p;
  };

  const syncToolbar = () => {
    const period = effectivePeriod();
    const isCn = marketOf(store.selected) === 'cn';
    $$('button', periodTabs).forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.v === period));
      if (MINUTE_K.has(b.dataset.v)) {
        b.disabled = !isCn;
        b.title = isCn ? '' : '分钟 K 线目前仅支持沪深京市场';
      }
    });
    opts.dataset.mode = INTRADAY.has(period) ? 'intraday' : 'kline';
    adjustEl.value = store.settings.adjust;
    adjustEl.disabled = MINUTE_K.has(period);
    $$('button', mainInd).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === store.settings.mainIndicator)));
    $$('button', subInd).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === store.settings.subIndicator)));
  };

  const showOverlay = (content) => {
    overlay.replaceChildren(...[content].flat());
    overlay.hidden = false;
  };

  const load = async ({ quiet = false } = {}) => {
    const symbol = store.selected;
    const period = effectivePeriod();
    const adjust = MINUTE_K.has(period) ? '' : store.settings.adjust;
    const key = `${symbol}|${period}|${adjust}`;
    const my = (token += 1);
    ctrl?.abort();
    ctrl = new AbortController();
    syncToolbar();
    if (!quiet || loadedKey !== key) showOverlay(h('div', {}, h('div', { class: 'spinner' }), '正在加载图表…'));
    try {
      if (INTRADAY.has(period)) {
        const days = period === 'minute5' ? 5 : 1;
        const data = await api.minute(symbol, days, { signal: ctrl.signal });
        if (my !== token) return;
        chart.showIntraday(data, { days });
      } else {
        const data = await api.kline(symbol, { period, adjust, count: KLINE_COUNT[period] }, { signal: ctrl.signal });
        if (my !== token) return;
        chart.showKline(data, {
          period,
          adjust: data.adjust,
          main: store.settings.mainIndicator,
          sub: store.settings.subIndicator,
        });
      }
      loadedKey = key;
      overlay.hidden = true;
      // 用最新推送的报价把图表补到最新
      const q = store.quotes.get(symbol);
      if (q) chart.applyQuote(q);
    } catch (err) {
      if (err.name === 'AbortError' || my !== token) return;
      const retry = h('button', { class: 'btn', type: 'button', style: 'margin-top:10px' }, '重试');
      retry.addEventListener('click', () => load());
      showOverlay(h('div', {}, h('div', {}, `图表加载失败：${err.message}`), retry));
    }
    scheduleRefresh();
  };

  // 定期用服务端数据校准（成交量等字段由实时推送推算，长时间运行会有细微偏差）
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    const market = marketOf(store.selected);
    const open = store.market?.[market]?.open;
    if (!open) return;
    const period = effectivePeriod();
    const delay = INTRADAY.has(period) ? 5 * 60_000 : MINUTE_K.has(period) ? 60_000 : 3 * 60_000;
    refreshTimer = setTimeout(() => {
      if (document.hidden) scheduleRefresh();
      else load({ quiet: true });
    }, delay);
  };

  periodTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    store.setSetting('period', btn.dataset.v);
    load();
  });
  adjustEl.addEventListener('change', () => {
    store.setSetting('adjust', adjustEl.value);
    load();
  });
  mainInd.addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v) return;
    store.setSetting('mainIndicator', v);
    syncToolbar();
    chart.setIndicators(store.settings.mainIndicator, store.settings.subIndicator);
  });
  subInd.addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v) return;
    store.setSetting('subIndicator', v);
    syncToolbar();
    chart.setIndicators(store.settings.mainIndicator, store.settings.subIndicator);
  });

  store.on('select', () => load());
  store.on('market', scheduleRefresh);
  store.on('quotes', (changes) => {
    for (const { quote } of changes) if (quote.symbol === store.selected) chart.applyQuote(quote);
  });

  load();
  return {
    refreshTheme: () => chart.refreshTheme(),
    reload: () => load({ quiet: true }),
  };
}
