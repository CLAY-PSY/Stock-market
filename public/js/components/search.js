import { $, h, icons } from '../dom.js';
import { api } from '../api.js';
import { store, MAX_WATCHLIST } from '../store.js';
import { exchangeTag, displayCode, escapeHtml } from '../format.js';
import { normalizeSymbol } from '../../shared/symbols.js';
import { toast } from './toast.js';

const TYPE_LABEL = { stock: '股票', index: '指数', fund: '基金', bond: '债券' };

/** 搜索没有结果、但输入本身是合法代码时（例如 BRK.B），提供「按代码打开」 */
function directItem(text) {
  const symbol = normalizeSymbol(text);
  return symbol ? { symbol, name: displayCode(symbol), type: null, direct: true } : null;
}

/**
 * 搜索框 + 「键盘精灵」：在页面任意位置直接输入代码/拼音即可唤起搜索。
 * 窄屏下搜索框收起为顶栏按钮，点击后以全屏面板打开。
 */
export function initSearch({ onPick, sheet }) {
  const root = $('#search');
  const input = $('#search-input');
  const list = $('#search-results');
  let items = [];
  let active = -1;
  let ctrl = null;
  let timer = null;
  let lastQuery = '';

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  /* ------------------------------------------------- 全屏搜索面板（窄屏） */

  const isOverlay = () => root.classList.contains('open');

  const openOverlay = () => {
    if (isOverlay()) return;
    root.classList.add('open');
    document.documentElement.classList.add('sheet-open', 'search-open');
    // iOS 只有在用户手势的同一调用栈里 focus 才会弹出键盘，所以这里同步调用
    input.focus();
    sheet?.open(closeOverlay);
    if (!input.value) {
      items = [];
      lastQuery = '';
      render();
    }
  };

  function closeOverlay() {
    if (!isOverlay()) return;
    root.classList.remove('open');
    document.documentElement.classList.remove('sheet-open', 'search-open');
    input.value = '';
    input.blur();
    close();
    sheet?.closed();
  }

  $('#btn-search').addEventListener('click', openOverlay);
  $('#search-cancel').addEventListener('click', closeOverlay);

  const open = () => {
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const highlight = (i) => {
    active = i;
    [...list.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    list.children[i]?.scrollIntoView({ block: 'nearest' });
  };

  const pick = (item) => {
    if (!item) return;
    if (!item.direct) store.names.set(item.symbol, item.name);
    onPick(item.symbol);
    input.value = '';
    input.blur();
    close();
    closeOverlay();
  };

  const render = () => {
    list.innerHTML = '';
    if (!items.length) {
      list.append(h('li', { class: 'sr-empty' }, lastQuery ? `没有找到与「${lastQuery}」相关的结果` : '输入代码、名称或拼音首字母'));
      open();
      return;
    }
    items.forEach((item, i) => {
      const inList = store.inWatchlist(item.symbol);
      const add = h('button', {
        class: `sr-add${inList ? ' added' : ''}`,
        type: 'button',
        title: inList ? '已在自选中' : '加入自选',
        'aria-label': inList ? '已在自选中' : '加入自选',
        html: inList ? icons.check : icons.plus,
      });
      add.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const added = store.addToWatchlist(item.symbol, item.direct ? undefined : item.name);
        if (added === 'full') toast(`自选股最多 ${MAX_WATCHLIST} 只，请先移除一些`, { kind: 'warn', duration: 3000 });
        else if (added) toast(`已将 ${item.name} 加入自选`, { kind: 'success', duration: 2000 });
        render();
        highlight(i);
      });
      const li = h(
        'li',
        { role: 'option', 'aria-selected': String(i === active), id: `sr-${i}` },
        h('span', { class: `tag tag-${exchangeTag(item.symbol)}` }, exchangeTag(item.symbol)),
        h('span', { html: `<span class="sr-name">${escapeHtml(item.name)}</span><span class="sr-code">${escapeHtml(displayCode(item.symbol))}</span>` }),
        h('span', { class: 'sr-type' }, item.direct ? '按代码打开' : TYPE_LABEL[item.type] ?? ''),
        add,
      );
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(item);
      });
      li.addEventListener('mousemove', () => active !== i && highlight(i));
      list.append(li);
    });
    open();
    if (active < 0) highlight(0);
  };

  const query = async (text) => {
    lastQuery = text;
    ctrl?.abort();
    if (!text) {
      items = [];
      close();
      return;
    }
    ctrl = new AbortController();
    try {
      const res = await api.search(text, { signal: ctrl.signal });
      if (text !== input.value.trim()) return;
      items = Array.isArray(res.data) ? res.data : [];
      if (!items.length) items = [directItem(text)].filter(Boolean);
      active = -1;
      render();
    } catch (err) {
      if (err.name === 'AbortError') return;
      items = [];
      list.innerHTML = '';
      list.append(h('li', { class: 'sr-empty' }, `搜索失败：${err.message}`));
      open();
    }
  };

  const scheduleQuery = () => {
    clearTimeout(timer);
    timer = setTimeout(() => query(input.value.trim()), 160);
  };
  // 拼音等输入法组字过程中输入框里是「teng'xun」这样的中间文本：不搜索，组字结束（选定汉字）后再搜
  input.addEventListener('input', (e) => {
    if (e.isComposing) return;
    scheduleQuery();
  });
  input.addEventListener('compositionend', scheduleQuery);
  input.addEventListener('focus', () => {
    if (input.value.trim()) render();
  });
  input.addEventListener('blur', () => {
    // 全屏面板里滚动结果列表会收起键盘（触发 blur），此时不能关掉结果
    if (!isOverlay()) setTimeout(close, 120);
  });
  input.addEventListener('keydown', (e) => {
    // 输入法组字中的回车（确认拼音）、方向键（挑候选字）、Esc（取消组字）都交给输入法，
    // 否则回车会直接打开半截拼音匹配到的第一条结果、Esc 会清空搜索框。
    // Safari 确认组字的那次 keydown 不带 isComposing，但 keyCode 为 229
    if (e.isComposing || e.keyCode === 229) return undefined;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length) highlight((active + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) highlight((active - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[active]) pick(items[active]);
      else if (input.value.trim()) query(input.value.trim()).then(() => items[0] && pick(items[0]));
    } else if (e.key === 'Escape') {
      if (isOverlay()) return closeOverlay();
      input.value = '';
      input.blur();
      close();
    }
    return undefined;
  });

  // 窄屏下搜索框收起为按钮，需要先打开全屏面板
  const collapsed = () => getComputedStyle($('#btn-search')).display !== 'none';
  const focusSearch = () => {
    if (collapsed()) openOverlay();
    else input.focus();
  };

  // 键盘精灵：不在输入框内时，直接键入字母 / 数字开始搜索；按 / 聚焦搜索框
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    if (target.closest?.('input, textarea, select, [contenteditable], dialog[open]')) return;
    if (e.key === '/') {
      e.preventDefault();
      focusSearch();
      input.select();
    } else if (/^[a-zA-Z0-9]$/.test(e.key)) {
      e.preventDefault();
      focusSearch();
      input.value = e.key;
      input.dispatchEvent(new Event('input'));
    }
  });
}
