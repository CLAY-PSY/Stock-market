import { $, h } from '../dom.js';
import { store } from '../store.js';
import { fmtPrice, fmtLots, fmtVolume, trendVs } from '../format.js';

const LABELS_ASK = ['卖五', '卖四', '卖三', '卖二', '卖一'];
const LABELS_BID = ['买一', '买二', '买三', '买四', '买五'];

/** 五档盘口（沪深京）/ 一档买卖盘（港美股） */
export function initOrderbook() {
  const root = $('#orderbook');
  const hint = $('#book-hint');
  let current = null;

  const empty = (text) => {
    root.replaceChildren(h('div', { class: 'empty' }, text));
  };

  const row = (cls, label, level, q, maxVol) => {
    const price = level?.price;
    const vol = level?.volume;
    const width = maxVol && vol ? Math.max(2, (vol / maxVol) * 100) : 0;
    return h(
      'div',
      { class: `book-row ${cls}` },
      h('span', { class: 'lbl' }, label),
      h('span', { class: `px ${price ? trendVs(price, q.prevClose) : ''}` }, price ? fmtPrice(price, q.decimals) : '--'),
      h('span', { class: 'vol' }, vol ? fmtLots(vol, q.market) : '--'),
      h('i', { class: 'book-bar', style: `width:${width.toFixed(1)}%` }),
    );
  };

  const render = (q) => {
    if (!q) return empty('等待行情…');
    if (q.type === 'index') {
      hint.textContent = '';
      return empty('指数没有买卖盘口');
    }
    const asks = q.asks ?? [];
    const bids = q.bids ?? [];
    if (!asks.length && !bids.length) {
      hint.textContent = '';
      return empty('暂无盘口数据');
    }
    const depth = q.market === 'cn' ? 5 : 1;
    hint.textContent = q.market === 'cn' ? '单位：手' : '一档买卖盘 · 单位：股';
    const maxVol = Math.max(...asks.map((a) => a.volume ?? 0), ...bids.map((b) => b.volume ?? 0), 0);
    const askLabels = depth === 5 ? LABELS_ASK : ['卖一'];
    const bidLabels = depth === 5 ? LABELS_BID : ['买一'];
    const askRows = askLabels.map((label, i) => row('ask', label, asks[depth - 1 - i], q, maxVol));
    const bidRows = bidLabels.map((label, i) => row('bid', label, bids[i], q, maxVol));

    const parts = [];
    if (q.market === 'cn') {
      const sumBid = bids.reduce((s, b) => s + (b.volume ?? 0), 0);
      const sumAsk = asks.reduce((s, a) => s + (a.volume ?? 0), 0);
      const total = sumBid + sumAsk;
      const ratio = total ? ((sumBid - sumAsk) / total) * 100 : 0;
      const diff = (sumBid - sumAsk) / 100;
      parts.push(
        h(
          'div',
          { class: 'book-summary' },
          h('span', {}, '委比 ', h('b', { class: ratio > 0 ? 'up' : ratio < 0 ? 'down' : '' }, `${ratio.toFixed(2)}%`)),
          h('span', {}, '委差 ', h('b', { class: diff > 0 ? 'up' : diff < 0 ? 'down' : '' }, String(Math.round(diff)))),
        ),
      );
    }
    parts.push(h('div', { class: 'book-rows' }, ...askRows, h('div', { class: 'book-mid' }), ...bidRows));

    if (q.market === 'cn' && (q.outerVolume || q.innerVolume)) {
      const outer = q.outerVolume ?? 0;
      const inner = q.innerVolume ?? 0;
      const pct = outer + inner ? (outer / (outer + inner)) * 100 : 50;
      parts.push(
        h('div', { class: 'book-ratio', title: `外盘占比 ${pct.toFixed(1)}%` }, h('span', { style: `width:${pct.toFixed(1)}%` })),
        h(
          'div',
          { class: 'book-foot' },
          h('span', {}, '外盘 ', h('b', { class: 'up' }, fmtVolume(outer, 'cn', { unit: false }))),
          h('span', {}, '内盘 ', h('b', { class: 'down' }, fmtVolume(inner, 'cn', { unit: false }))),
        ),
      );
    }
    root.replaceChildren(...parts);
  };

  store.on('select', (symbol) => {
    current = symbol;
    render(store.quotes.get(symbol));
  });
  store.on('quotes', (changes) => {
    for (const { quote } of changes) if (quote.symbol === current) render(quote);
  });
  current = store.selected;
  render(store.quotes.get(current));
}
