import { $, $$, h, flash, icons } from '../dom.js';
import { store } from '../store.js';
import { fmtPrice, fmtPct, trend, exchangeTag, displayCode, marketOf, escapeHtml } from '../format.js';
import { toast } from './toast.js';

/**
 * 自选股列表：市场筛选、按列排序、拖拽调整顺序、实时闪烁、键盘 ↑↓ 切换。
 */
export function initWatchlist({ onPick }) {
  const list = $('#watchlist');
  const rows = new Map();
  let sort = { key: null, dir: null };

  const visibleSymbols = () => {
    const filter = store.settings.watchFilter;
    let syms = store.watchlist.filter((s) => filter === 'all' || marketOf(s) === filter);
    if (sort.key) {
      const val = (s) => {
        if (sort.key === 'name') return store.nameOf(s);
        return store.quotes.get(s)?.[sort.key] ?? -Infinity;
      };
      syms = [...syms].sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        const cmp = typeof va === 'string' ? va.localeCompare(vb, 'zh-CN') : va - vb;
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }
    return syms;
  };

  const updateRow = (symbol, prev) => {
    const row = rows.get(symbol);
    if (!row) return;
    const q = store.quotes.get(symbol);
    row.name.textContent = store.nameOf(symbol);
    if (!q) {
      row.price.textContent = store.unknown.has(symbol) ? '无数据' : '--';
      return;
    }
    const dir = trend(q.change);
    row.price.textContent = fmtPrice(q.price, q.decimals);
    row.price.className = `wl-price ${dir}`;
    row.chg.textContent = q.noTrade ? '未成交' : fmtPct(q.changePct);
    row.chg.className = `wl-chg ${q.noTrade ? 'flat' : dir}`;
    if (prev && prev.price !== q.price) flash(row.price, q.price > prev.price ? 'up' : 'down');
  };

  let dragSymbol = null;
  const clearDropMarks = () => $$('.drop-before', list).forEach((el) => el.classList.toggle('drop-before', false));

  const render = () => {
    const syms = visibleSymbols();
    list.replaceChildren();
    rows.clear();
    $('#wl-count').textContent = store.watchlist.length ? `(${store.watchlist.length})` : '';
    if (!syms.length) {
      list.append(
        h(
          'li',
          { class: 'empty' },
          store.watchlist.length ? '该市场下暂无自选股' : '还没有自选股',
          h('br'),
          '在顶部搜索框输入代码或名称，点击 + 加入自选',
        ),
      );
      return;
    }
    for (const symbol of syms) {
      const name = h('b', {}, store.nameOf(symbol));
      const price = h('span', { class: 'wl-price' }, '--');
      const chg = h('span', { class: 'wl-chg flat' }, '--');
      const removeBtn = h('button', { class: 'wl-remove', type: 'button', title: '移出自选', 'aria-label': '移出自选', html: icons.close });
      const li = h(
        'li',
        {
          class: 'wl-item',
          role: 'option',
          'aria-selected': String(symbol === store.selected),
          draggable: sort.key ? 'false' : 'true',
          dataset: { symbol },
        },
        h(
          'span',
          { class: 'wl-name' },
          name,
          h('span', {
            class: 'wl-sub',
            html: `<span class="tag tag-${exchangeTag(symbol)}">${exchangeTag(symbol)}</span>${escapeHtml(displayCode(symbol))}`,
          }),
        ),
        price,
        chg,
        removeBtn,
      );
      li.addEventListener('click', () => onPick(symbol));
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nm = store.nameOf(symbol);
        store.removeFromWatchlist(symbol);
        toast(`已将 ${nm} 移出自选`, { duration: 2000 });
      });
      li.addEventListener('dragstart', (e) => {
        dragSymbol = symbol;
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', symbol);
      });
      li.addEventListener('dragend', () => {
        dragSymbol = null;
        li.classList.toggle('dragging', false);
        clearDropMarks();
      });
      li.addEventListener('dragover', (e) => {
        if (!dragSymbol || dragSymbol === symbol) return;
        e.preventDefault();
        clearDropMarks();
        li.classList.add('drop-before');
      });
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragSymbol && dragSymbol !== symbol) store.moveInWatchlist(dragSymbol, symbol);
      });
      list.append(li);
      rows.set(symbol, { li, name, price, chg });
      updateRow(symbol);
    }
  };

  // 市场筛选
  const filterEl = $('#wl-filter');
  const syncFilter = () =>
    $$('button', filterEl).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === store.settings.watchFilter)));
  filterEl.addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v) return;
    store.setSetting('watchFilter', v);
    syncFilter();
    render();
  });
  syncFilter();

  // 列排序：无 → 降序 → 升序 → 无
  const head = $('#wl-head');
  head.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const key = btn.dataset.sort;
    if (sort.key !== key) sort = { key, dir: 'desc' };
    else if (sort.dir === 'desc') sort = { key, dir: 'asc' };
    else sort = { key: null, dir: null };
    $$('button', head).forEach((b) => {
      if (b.dataset.sort === sort.key) b.dataset.dir = sort.dir;
      else delete b.dataset.dir;
    });
    render();
  });

  let resortTimer = null;
  store.on('quotes', (changes) => {
    for (const { quote, prev } of changes) updateRow(quote.symbol, prev);
    // 按行情排序时节流重排，避免列表每秒跳动
    if (sort.key && sort.key !== 'name' && !resortTimer) {
      resortTimer = setTimeout(() => {
        resortTimer = null;
        render();
      }, 5000);
    }
  });
  store.on('unknown', (symbols) => symbols.forEach((s) => updateRow(s)));
  store.on('watchlist', render);
  store.on('select', (symbol) => {
    for (const [s, row] of rows) row.li.setAttribute('aria-selected', String(s === symbol));
    rows.get(symbol)?.li.scrollIntoView({ block: 'nearest' });
  });

  // 键盘 ↑↓ 在自选股间切换
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (e.target.closest?.('input, textarea, select, dialog[open], .drawer')) return;
    const syms = visibleSymbols();
    if (!syms.length) return;
    e.preventDefault();
    const idx = syms.indexOf(store.selected);
    const next = e.key === 'ArrowDown' ? (idx + 1) % syms.length : (idx - 1 + syms.length) % syms.length;
    onPick(syms[idx < 0 ? 0 : next]);
  });

  render();
}
