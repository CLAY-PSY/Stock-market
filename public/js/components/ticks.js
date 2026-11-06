import { $, h } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { fmtPrice, fmtLots, trendVs, marketOf } from '../format.js';

const MAX_ROWS = 80;
// 沪市 000xxx、深市 399xxx 为指数代码
const isCnIndex = (symbol) => /^(sh000|sz399)/.test(symbol);
const POLL_MS = 3000;

/**
 * 成交明细。
 * - 沪深京：轮询逐笔成交接口（服务端有 2 秒缓存），带主动买卖方向；
 * - 港股 / 美股：没有公开逐笔接口，根据实时推送的成交量增量推算每次快照之间的成交。
 */
export function initTicks() {
  const list = $('#ticks');
  const hint = $('#ticks-hint');
  let symbol = null;
  let ticks = [];
  let timer = null;
  let ctrl = null;
  let lastVolume = null;
  let seq = 0;

  const render = (newIds = new Set()) => {
    if (!ticks.length) {
      list.replaceChildren(h('li', { class: 'empty' }, marketOf(symbol) === 'cn' ? '暂无成交' : '等待实时成交…'));
      return;
    }
    const q = store.quotes.get(symbol);
    const ref = q?.prevClose;
    const decimals = q?.decimals ?? 2;
    const market = marketOf(symbol);
    const big = market === 'cn' ? 50_000 : 100_000; // 大单阈值：500 手 / 10 万股
    list.replaceChildren(
      ...ticks.map((t) => {
        const side = t.side === 'B' ? h('i', { class: 'up' }, 'B') : t.side === 'S' ? h('i', { class: 'down' }, 'S') : h('i', {}, '');
        return h(
          'li',
          { class: `tick${t.volume >= big ? ' big' : ''}${newIds.has(t.id) ? ' new' : ''}` },
          h('span', { class: 't-time' }, t.time),
          h('span', { class: `t-px ${trendVs(t.price, ref)}` }, fmtPrice(t.price, decimals)),
          h('span', { class: `t-vol ${t.side === 'B' ? 'up' : t.side === 'S' ? 'down' : ''}` }, fmtLots(t.volume, market), side),
        );
      }),
    );
  };

  const fetchTicks = async () => {
    const sym = symbol;
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      const res = await api.ticks(sym, 60, { signal: ctrl.signal });
      if (sym !== symbol) return;
      const known = new Set(ticks.map((t) => t.id));
      const incoming = res.ticks ?? [];
      const fresh = new Set(ticks.length ? incoming.filter((t) => !known.has(t.id)).map((t) => t.id) : []);
      ticks = incoming.slice(0, MAX_ROWS);
      render(fresh);
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!ticks.length) list.replaceChildren(h('li', { class: 'empty' }, `成交明细加载失败：${err.message}`));
    }
  };

  const pollable = () => marketOf(symbol ?? '') === 'cn' && !isCnIndex(symbol) && store.quotes.get(symbol)?.type !== 'index';

  const schedule = () => {
    clearTimeout(timer);
    if (!pollable()) return;
    const open = store.market?.cn?.open ?? true;
    timer = setTimeout(
      async () => {
        if (!document.hidden) await fetchTicks();
        schedule();
      },
      open ? POLL_MS : 60_000,
    );
  };

  const onSelect = (sym) => {
    symbol = sym;
    ticks = [];
    lastVolume = null;
    clearTimeout(timer);
    ctrl?.abort();
    const isCn = marketOf(sym) === 'cn';
    const q = store.quotes.get(sym);
    if (q?.type === 'index' || isCnIndex(sym)) {
      hint.textContent = '';
      list.replaceChildren(h('li', { class: 'empty' }, '指数没有成交明细'));
      return;
    }
    hint.textContent = isCn ? '逐笔 · 单位：手' : '根据实时快照推算 · 单位：股';
    render();
    if (isCn) {
      fetchTicks();
      schedule();
    }
  };

  store.on('select', onSelect);
  store.on('market', () => schedule());
  store.on('quotes', (changes) => {
    for (const { quote } of changes) {
      if (quote.symbol !== symbol) continue;
      if (quote.type === 'index') {
        if (!ticks.length) list.replaceChildren(h('li', { class: 'empty' }, '指数没有成交明细'));
        hint.textContent = '';
        continue;
      }
      if (marketOf(symbol) === 'cn') continue;
      // 港美股：成交量增加即视为一笔（聚合）成交
      if (lastVolume !== null && quote.volume > lastVolume) {
        const id = `s${(seq += 1)}`;
        const prevPrice = ticks[0]?.price ?? quote.prevClose;
        ticks.unshift({
          id,
          time: (quote.time ?? '').slice(11, 19),
          price: quote.price,
          volume: quote.volume - lastVolume,
          side: quote.price > prevPrice ? 'B' : quote.price < prevPrice ? 'S' : 'M',
        });
        ticks = ticks.slice(0, MAX_ROWS);
        render(new Set([id]));
      }
      lastVolume = quote.volume;
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && pollable()) fetchTicks();
  });
  onSelect(store.selected);
}
