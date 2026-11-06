import { $, $$, h } from '../dom.js';
import { api, capabilities } from '../api.js';
import { store } from '../store.js';
import { fmtPrice, fmtPct, fmtBig, fmtNum, trend, displayCode } from '../format.js';

const METRIC = {
  changePct: (r) => ({ text: fmtPct(r.changePct), dir: trend(r.changePct) }),
  amount: (r) => ({ text: fmtBig(r.amount), dir: '' }),
  speed: (r) => ({ text: fmtPct(r.speed), dir: trend(r.speed) }),
  volumeRatio: (r) => ({ text: fmtNum(r.volumeRatio), dir: '' }),
  amplitude: (r) => ({ text: `${fmtNum(r.amplitude)}%`, dir: '' }),
};

/** 沪深京市场排行榜（涨幅 / 跌幅 / 成交额 / 涨速 / 量比 / 振幅） */
export function initRank({ onPick }) {
  const list = $('#rank-list');
  const tabs = $('#rank-tabs');
  const board = $('#rank-board');
  let timer = null;
  let ctrl = null;

  // 静态部署（浏览器直连）时数据源只支持部分排行，其余选项置灰
  const caps = capabilities().rank;
  if (caps) {
    $$('button', tabs).forEach((b) => {
      const ok = caps.sorts.includes(b.dataset.v.split(':')[0]);
      b.disabled = !ok;
      if (!ok) b.title = 'GitHub Pages 静态部署下仅支持涨幅 / 跌幅榜';
    });
    [...board.options].forEach((o) => {
      o.disabled = !caps.boards.includes(o.value);
    });
    if (!caps.sorts.includes(store.settings.rankSort.split(':')[0])) store.setSetting('rankSort', 'changePct:desc');
    if (!caps.boards.includes(store.settings.rankBoard)) store.setSetting('rankBoard', 'all');
  }

  const syncTabs = () => $$('button', tabs).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === store.settings.rankSort)));

  const load = async () => {
    const [sort, order] = store.settings.rankSort.split(':');
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      const res = await api.rank({ sort, order, board: store.settings.rankBoard, count: 30 }, { signal: ctrl.signal });
      const metric = METRIC[sort] ?? METRIC.changePct;
      if (!res.items.length) {
        list.replaceChildren(h('li', { class: 'empty' }, '暂无数据'));
        return;
      }
      list.replaceChildren(
        ...res.items.map((r, i) => {
          const m = metric(r);
          const li = h(
            'li',
            { class: 'rank-item', title: `${r.name} ${displayCode(r.symbol)}` },
            h('span', { class: 'rank-no' }, String(i + 1)),
            h('span', { class: 'rank-name' }, h('b', {}, r.name), h('span', {}, displayCode(r.symbol))),
            h('span', { class: `rank-price ${trend(r.changePct)}` }, fmtPrice(r.price, 2)),
            h('span', { class: `rank-metric ${m.dir}` }, m.text),
          );
          li.addEventListener('click', () => {
            store.names.set(r.symbol, r.name);
            onPick(r.symbol);
          });
          return li;
        }),
      );
    } catch (err) {
      if (err.name === 'AbortError') return;
      list.replaceChildren(h('li', { class: 'empty' }, `排行加载失败：${err.message}`));
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    const open = store.market?.cn?.open ?? true;
    timer = setTimeout(
      async () => {
        if (!document.hidden) await load();
        schedule();
      },
      open ? 10_000 : 120_000,
    );
  };

  tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    const v = btn?.dataset.v;
    if (!v || btn.disabled) return;
    store.setSetting('rankSort', v);
    syncTabs();
    load();
    schedule();
  });
  board.value = store.settings.rankBoard;
  board.addEventListener('change', () => {
    store.setSetting('rankBoard', board.value);
    load();
    schedule();
  });
  store.on('market', schedule);
  syncTabs();
  load();
  schedule();
}
