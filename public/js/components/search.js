import { $, h, icons } from '../dom.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { exchangeTag, displayCode, escapeHtml } from '../format.js';
import { toast } from './toast.js';

const TYPE_LABEL = { stock: '股票', index: '指数', fund: '基金', bond: '债券' };

/**
 * 搜索框 + 「键盘精灵」：在页面任意位置直接输入代码/拼音即可唤起搜索。
 */
export function initSearch({ onPick }) {
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
    store.names.set(item.symbol, item.name);
    onPick(item.symbol);
    input.value = '';
    input.blur();
    close();
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
        if (store.addToWatchlist(item.symbol, item.name)) {
          toast(`已将 ${item.name} 加入自选`, { kind: 'success', duration: 2000 });
        }
        render();
        highlight(i);
      });
      const li = h(
        'li',
        { role: 'option', 'aria-selected': String(i === active), id: `sr-${i}` },
        h('span', { class: `tag tag-${exchangeTag(item.symbol)}` }, exchangeTag(item.symbol)),
        h('span', { html: `<span class="sr-name">${escapeHtml(item.name)}</span><span class="sr-code">${escapeHtml(displayCode(item.symbol))}</span>` }),
        h('span', { class: 'sr-type' }, TYPE_LABEL[item.type] ?? ''),
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
      items = res.data ?? [];
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

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => query(input.value.trim()), 160);
  });
  input.addEventListener('focus', () => {
    if (input.value.trim()) render();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
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
      input.value = '';
      input.blur();
      close();
    }
  });

  // 键盘精灵：不在输入框内时，直接键入字母 / 数字开始搜索；按 / 聚焦搜索框
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    if (target.closest?.('input, textarea, select, [contenteditable], dialog[open]')) return;
    if (e.key === '/') {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (/^[a-zA-Z0-9]$/.test(e.key)) {
      e.preventDefault();
      input.focus();
      input.value = e.key;
      input.dispatchEvent(new Event('input'));
    }
  });
}
