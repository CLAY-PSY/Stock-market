import { $, h, flash } from '../dom.js';
import { store, INDICES } from '../store.js';
import { fmtPrice, fmtPct, fmtChange, trend, MARKET_LABEL, marketOf } from '../format.js';

const SHORT = {
  sh000001: '上证指数',
  sz399001: '深证成指',
  sz399006: '创业板指',
  sh000688: '科创50',
  sh000300: '沪深300',
  hkHSI: '恒生指数',
  hkHSTECH: '恒生科技',
  usDJI: '道琼斯',
  usIXIC: '纳斯达克',
  usINX: '标普500',
};

const cells = new Map();

export function initTicker({ onPick }) {
  const root = $('#ticker');
  for (const symbol of INDICES) {
    const name = h('span', { class: 'tk-name' }, SHORT[symbol] ?? symbol);
    const mkt = h('span', { class: 'tk-market' }, MARKET_LABEL[marketOf(symbol)]);
    const price = h('span', { class: 'tk-price num' }, '--');
    const chg = h('span', { class: 'tk-chg' }, '--');
    const btn = h('button', { class: 'tk', type: 'button', title: SHORT[symbol] }, name, mkt, price, chg);
    btn.addEventListener('click', () => onPick(symbol));
    root.append(btn);
    cells.set(symbol, { btn, price, chg });
  }
  store.on('quotes', (changes) => {
    for (const { quote, prev } of changes) {
      const cell = cells.get(quote.symbol);
      if (!cell) continue;
      const dir = trend(quote.change);
      cell.price.textContent = fmtPrice(quote.price, quote.decimals);
      cell.price.className = `tk-price num ${dir}`;
      cell.chg.textContent = `${fmtChange(quote.change, quote.decimals)}  ${fmtPct(quote.changePct)}`;
      cell.chg.className = `tk-chg ${dir}`;
      cell.btn.title = `${quote.name} ${quote.time ?? ''}`;
      if (prev && prev.price !== quote.price) flash(cell.price, quote.price > prev.price ? 'up' : 'down');
    }
  });
  store.on('select', markActive);
  markActive(store.selected);
  initScrollHints(root);
}

/**
 * 指数条放不下时可以横向滚动：边缘渐隐提示还有内容；
 * 鼠标滚轮（纵向）也能横向滚动，桌面端不必按住 Shift。
 */
function initScrollHints(root) {
  const update = () => {
    const max = root.scrollWidth - root.clientWidth;
    root.classList.toggle('fade-left', root.scrollLeft > 2);
    root.classList.toggle('fade-right', root.scrollLeft < max - 2);
  };
  root.addEventListener('scroll', update, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(update).observe(root);
  else window.addEventListener('resize', update);
  root.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // 触控板横向滑动 / 缩放手势交给浏览器
      const max = root.scrollWidth - root.clientWidth;
      if (max <= 0) return;
      const atEdge = (e.deltaY < 0 && root.scrollLeft <= 0) || (e.deltaY > 0 && root.scrollLeft >= max - 1);
      if (atEdge) return; // 到头了就让页面正常滚动
      e.preventDefault();
      root.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  update();
}

function markActive(symbol) {
  for (const [s, cell] of cells) cell.btn.classList.toggle('active', s === symbol);
}
