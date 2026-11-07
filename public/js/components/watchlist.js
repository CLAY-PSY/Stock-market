import { $, $$, h, flash, icons, activatable } from '../dom.js';
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
  let dropAfter = false;
  const clearDropMarks = () =>
    $$('.drop-before, .drop-after', list).forEach((el) => {
      el.classList.toggle('drop-before', false);
      el.classList.toggle('drop-after', false);
    });

  /* 编辑模式：删除 / 置顶 / 上移 / 下移。触屏设备没有悬停，也不支持 HTML5 拖拽，靠它来管理自选 */
  let editing = false;
  const editBtn = $('#wl-edit');
  const setEditing = (on) => {
    editing = on;
    editBtn.textContent = on ? '完成' : '编辑';
    editBtn.setAttribute('aria-pressed', String(on));
    list.classList.toggle('editing', on);
    if (on && sort.key) {
      sort = { key: null, dir: null }; // 调整顺序时按自选原始顺序显示
      $$('button', $('#wl-head')).forEach((b) => delete b.dataset.dir);
    }
    render();
  };
  editBtn.addEventListener('click', () => setEditing(!editing));

  const move = (symbol, where) => {
    const wl = store.watchlist;
    const i = wl.indexOf(symbol);
    if (i < 0) return;
    if (where === 'top' && i > 0) store.moveInWatchlist(symbol, wl[0]);
    if (where === 'up' && i > 0) store.moveInWatchlist(symbol, wl[i - 1]);
    if (where === 'down' && i < wl.length - 1) store.moveInWatchlist(symbol, wl[i + 2]);
  };

  /**
   * 调整顺序 / 删除后列表整体重绘，原来的按钮已不存在。焦点原本在列表里（键盘操作）时：
   * 移动后回到被移动那一行的同一个按钮（已到顶 / 到底而不可用时回到这一行）；删除后移到同一位置的行。
   */
  const keepFocus = (action, { symbol, label, index }) => {
    const hadFocus = list.contains(document.activeElement);
    action();
    if (!hadFocus) return;
    if (symbol && rows.has(symbol)) {
      const row = rows.get(symbol).li;
      const same = label ? row.querySelector(`[aria-label="${label}"]`) : null;
      (same && !same.disabled ? same : row).focus({ preventScroll: true });
      return;
    }
    const all = [...rows.values()];
    const next = all[Math.min(index ?? 0, all.length - 1)];
    if (next) next.li.focus({ preventScroll: true });
    else editBtn.focus({ preventScroll: true });
  };

  const editOps = (symbol) => {
    const wl = store.watchlist;
    const i = wl.indexOf(symbol);
    const btn = (icon, label, action, disabled) => {
      const b = h('button', { type: 'button', class: 'wl-op', title: label, 'aria-label': label, html: icons[icon], disabled });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        keepFocus(action, { symbol, label });
      });
      return b;
    };
    return h(
      'span',
      { class: 'wl-ops' },
      btn('top', '置顶', () => move(symbol, 'top'), i === 0),
      btn('up', '上移', () => move(symbol, 'up'), i === 0),
      btn('down', '下移', () => move(symbol, 'down'), i === wl.length - 1),
    );
  };

  const removeSymbol = (symbol) => {
    const nm = store.nameOf(symbol);
    const index = [...rows.keys()].indexOf(symbol);
    keepFocus(() => store.removeFromWatchlist(symbol), { index });
    toast(`已将 ${nm} 移出自选`, { duration: 2000 });
  };

  const render = () => {
    const syms = visibleSymbols();
    list.replaceChildren();
    rows.clear();
    $('#wl-count').textContent = store.watchlist.length ? `(${store.watchlist.length})` : '';
    if (!syms.length) {
      if (store.pickingDefault) {
        list.append(h('li', { class: 'empty' }, h('div', { class: 'spinner' }), '正在从实时行情中为你挑选自选股…'));
        return;
      }
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
      const deleteBtn = editing
        ? h('button', { class: 'wl-delete', type: 'button', title: '删除', 'aria-label': `删除 ${store.nameOf(symbol)}`, html: icons.minus })
        : null;
      const li = h(
        'li',
        {
          class: 'wl-item',
          role: 'option',
          'aria-selected': String(symbol === store.selected),
          draggable: sort.key || editing ? 'false' : 'true',
          dataset: { symbol },
        },
        deleteBtn,
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
        editing ? editOps(symbol) : removeBtn,
      );
      li.addEventListener('click', () => {
        if (!editing) onPick(symbol);
      });
      activatable(li, () => {
        if (!editing) onPick(symbol);
      });
      deleteBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSymbol(symbol);
      });
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeSymbol(symbol);
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
      // 指针在行的上半部分放到它前面，下半部分放到它后面（这样也能拖到列表最后一位）
      li.addEventListener('dragover', (e) => {
        if (!dragSymbol || dragSymbol === symbol) return;
        e.preventDefault();
        const r = li.getBoundingClientRect();
        dropAfter = e.clientY > r.top + r.height / 2;
        clearDropMarks();
        li.classList.add(dropAfter ? 'drop-after' : 'drop-before');
      });
      li.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragSymbol || dragSymbol === symbol) return;
        if (!dropAfter) {
          store.moveInWatchlist(dragSymbol, symbol);
          return;
        }
        const rest = store.watchlist.filter((s) => s !== dragSymbol);
        store.moveInWatchlist(dragSymbol, rest[rest.indexOf(symbol) + 1] ?? null);
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
    if (!btn || editing) return;
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
    // 带修饰键的组合留给浏览器 / 系统（例如 Mac 上 ⌘↓ 跳到页面底部）
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.target.closest?.('input, textarea, select, dialog[open], .drawer, .rank-list, .search-results')) return;
    const syms = visibleSymbols();
    if (!syms.length) return;
    e.preventDefault();
    const idx = syms.indexOf(store.selected);
    const next = e.key === 'ArrowDown' ? (idx + 1) % syms.length : (idx - 1 + syms.length) % syms.length;
    // 键盘连续切换不写入历史记录，否则返回键要按很多次
    const target = syms[idx < 0 ? 0 : next];
    onPick(target, { replace: true });
    // 焦点原本在自选列表里时，跟着移到新选中的那一行
    if (e.target.closest?.('.wl-list')) rows.get(target)?.li.focus({ preventScroll: true });
  });

  render();
}
