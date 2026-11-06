import { $, h, flash, icons } from '../dom.js';
import { store } from '../store.js';
import {
  fmtPrice,
  fmtChange,
  fmtPct,
  fmtBig,
  fmtVolume,
  fmtNum,
  trend,
  trendVs,
  exchangeTag,
  displayCode,
  MARKET_LABEL,
  TZ_LABEL,
  escapeHtml,
} from '../format.js';
import { toast } from './toast.js';

const TYPE_LABEL = { stock: '股票', index: '指数', fund: '基金', bond: '债券' };

/** 根据市场 / 品种挑选要展示的指标 */
function statsFor(q) {
  const d = q.decimals;
  const px = (v) => ({ text: fmtPrice(v, d), dir: trendVs(v, q.prevClose) });
  const plain = (text) => ({ text });
  const isIndex = q.type === 'index';
  const cur = q.currency === 'CNY' ? '' : ` ${q.currency}`;
  const list = [
    ['今开', px(q.open)],
    ['最高', px(q.high)],
    ['最低', px(q.low)],
    ['昨收', plain(fmtPrice(q.prevClose, d))],
    // 数据源不提供的项不显示（例如港股指数没有成交股数、美股指数没有可靠的成交额）
    q.volume === null || q.volume === undefined ? null : ['成交量', plain(fmtVolume(q.volume, q.market))],
    q.amount === null || q.amount === undefined ? null : ['成交额', plain(fmtBig(q.amount) + (q.amount ? cur : ''))],
    ['振幅', plain(q.amplitude === null ? '--' : `${fmtNum(q.amplitude)}%`)],
  ].filter(Boolean);
  if (!isIndex) {
    list.push(['换手率', plain(q.turnoverRate === null || q.turnoverRate === undefined ? '--' : `${fmtNum(q.turnoverRate)}%`)]);
    list.push(['市盈率TTM', plain(q.pe ? fmtNum(q.pe) : '--')]);
    if (q.pb !== undefined) list.push(['市净率', plain(q.pb ? fmtNum(q.pb) : '--')]);
    list.push(['总市值', plain(fmtBig(q.marketCap) + (q.marketCap ? cur : ''))]);
    list.push(['流通市值', plain(fmtBig(q.floatMarketCap) + (q.floatMarketCap ? cur : ''))]);
  }
  if (q.avgPrice) list.push(['均价', px(q.avgPrice)]);
  if (q.market === 'cn' && !isIndex) {
    list.push(['涨停', { text: fmtPrice(q.limitUp, d), dir: 'up' }]);
    list.push(['跌停', { text: fmtPrice(q.limitDown, d), dir: 'down' }]);
    list.push(['量比', plain(fmtNum(q.volumeRatio))]);
  }
  if (q.dividendYield) list.push(['股息率', plain(`${fmtNum(q.dividendYield)}%`)]);
  list.push(['52周最高', plain(fmtPrice(q.high52w, d))]);
  list.push(['52周最低', plain(fmtPrice(q.low52w, d))]);
  return list;
}

export function initQuotePanel({ onAlert }) {
  const root = $('#quote');
  let els = null;
  let current = null;
  let statsExpanded = false;

  const build = (symbol) => {
    current = symbol;
    const star = h('button', { class: 'btn', type: 'button' });
    const alertBtn = h('button', {
      class: 'btn',
      type: 'button',
      title: '设置价格提醒',
      'aria-label': '设置价格提醒',
      html: `${icons.bell}<span>提醒</span>`,
    });
    const price = h('span', { class: 'q-price num' }, '--');
    const change = h('span', { class: 'q-change' }, h('span', {}, '--'), h('span', {}, '--'));
    const name = h('h1', {}, store.nameOf(symbol));
    const status = h('span', { class: 'q-status' }, '');
    const typeTag = h('span', { class: 'tag' }, '');
    const meta = h('div', { class: 'q-meta' }, '正在加载行情…');
    const stats = h('dl', { class: `q-stats${statsExpanded ? '' : ' collapsed'}` });
    // 手机上默认只显示前几项指标
    const more = h('button', { class: 'q-more mobile-only', type: 'button', 'aria-expanded': String(statsExpanded) });
    const syncMore = () => {
      more.textContent = statsExpanded ? '收起 ▴' : '更多数据 ▾';
      more.setAttribute('aria-expanded', String(statsExpanded));
      stats.classList.toggle('collapsed', !statsExpanded);
    };
    more.addEventListener('click', () => {
      statsExpanded = !statsExpanded;
      syncMore();
    });
    syncMore();

    root.replaceChildren(
      h(
        'div',
        { class: 'q-top' },
        h(
          'div',
          { class: 'q-ident' },
          h(
            'div',
            { class: 'q-name' },
            name,
            h('span', { class: 'q-code', html: `${escapeHtml(displayCode(symbol))}` }),
            h('span', { class: `tag tag-${exchangeTag(symbol)}` }, exchangeTag(symbol)),
            typeTag,
            status,
          ),
          meta,
        ),
        h('div', { class: 'q-price-block' }, price, change),
        h('div', { class: 'q-actions' }, star, alertBtn),
      ),
      stats,
      more,
    );

    star.addEventListener('click', () => {
      const nm = store.nameOf(symbol);
      if (store.inWatchlist(symbol)) {
        store.removeFromWatchlist(symbol);
        toast(`已将 ${nm} 移出自选`, { duration: 2000 });
      } else {
        store.addToWatchlist(symbol, nm);
        toast(`已将 ${nm} 加入自选`, { kind: 'success', duration: 2000 });
      }
    });
    alertBtn.addEventListener('click', () => onAlert(symbol));

    els = { star, price, change, name, status, typeTag, meta, stats };
    syncStar();
    syncStatus();
    const q = store.quotes.get(symbol);
    if (q) update(q);
    else if (store.unknown.has(symbol)) showUnknown();
  };

  const syncStar = () => {
    if (!els) return;
    const on = store.inWatchlist(current);
    els.star.classList.toggle('on', on);
    els.star.innerHTML = `${icons.star}<span>${on ? '已自选' : '加自选'}</span>`;
    els.star.title = on ? '移出自选' : '加入自选';
    els.star.setAttribute('aria-label', els.star.title); // 小屏只显示图标时供读屏使用
  };

  const syncStatus = () => {
    if (!els) return;
    const market = current.startsWith('hk') ? 'hk' : current.startsWith('us') ? 'us' : 'cn';
    const s = store.market?.[market];
    els.status.textContent = s ? `${MARKET_LABEL[market]} ${s.text}` : MARKET_LABEL[market];
    els.status.classList.toggle('open', Boolean(s?.open));
  };

  const showUnknown = () => {
    els.meta.textContent = '未找到该代码的行情数据，请确认代码是否正确';
    els.price.textContent = '--';
  };

  const update = (q, prev) => {
    if (!els || q.symbol !== current) return;
    const dir = trend(q.change);
    els.name.textContent = q.name;
    els.typeTag.textContent = TYPE_LABEL[q.type] ?? '';
    els.typeTag.hidden = !TYPE_LABEL[q.type];
    els.price.textContent = fmtPrice(q.price, q.decimals);
    els.price.className = `q-price num ${dir}`;
    // 价格很长（如恒指 24534.190）时手机上一行放不下价格 + 两个按钮：按钮改为只显示图标
    els.price.closest('.q-top')?.classList.toggle('long-price', els.price.textContent.length >= 8);
    const [abs, pct] = els.change.children;
    abs.textContent = fmtChange(q.change, q.decimals);
    pct.textContent = fmtPct(q.changePct);
    els.change.className = `q-change ${dir}`;
    if (prev && prev.price !== q.price) flash(els.price, q.price > prev.price ? 'up' : 'down');
    const tz = TZ_LABEL[q.market];
    els.meta.textContent = `${q.noTrade ? '暂无成交 · ' : ''}更新于 ${q.time ?? '--'}（${tz}）${q.currency ? ` · ${q.currency}` : ''}`;

    els.stats.replaceChildren(
      ...statsFor(q).map(([label, v]) => h('div', {}, h('dt', {}, label), h('dd', { class: v.dir ?? '', title: v.text }, v.text))),
    );
  };

  store.on('select', build);
  store.on('watchlist', syncStar);
  store.on('market', syncStatus);
  store.on('quotes', (changes) => {
    for (const { quote, prev } of changes) if (quote.symbol === current) update(quote, prev);
  });
  store.on('unknown', (symbols) => {
    if (symbols.includes(current)) showUnknown();
  });
  build(store.selected);
}
