/** 数字与文本格式化工具（纯函数，前后端测试共用） */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const MARKET_LABEL = { cn: '沪深', hk: '港股', us: '美股' };
export const TZ_LABEL = { cn: '北京时间', hk: '香港时间', us: '美东时间' };

export function fmtPrice(v, decimals = 2) {
  return isNum(v) ? v.toFixed(decimals) : '--';
}

export function fmtChange(v, decimals = 2) {
  if (!isNum(v)) return '--';
  const s = v.toFixed(decimals);
  return v > 0 ? `+${s}` : s;
}

export function fmtPct(v, digits = 2) {
  if (!isNum(v)) return '--';
  const s = `${v.toFixed(digits)}%`;
  return v > 0 ? `+${s}` : s;
}

/** 大数字：1.23万 / 4.56亿 / 7.89万亿 */
export function fmtBig(v, digits = 2) {
  if (!isNum(v)) return '--';
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(digits)}万亿`;
  if (a >= 1e8) return `${(v / 1e8).toFixed(digits)}亿`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(digits)}万`;
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

/** 成交量：A 股以「手」为单位展示，港美股以「股」 */
export function fmtVolume(shares, market, { unit = true } = {}) {
  if (!isNum(shares)) return '--';
  if (market === 'cn') return `${fmtBig(Math.round(shares / 100))}${unit ? '手' : ''}`;
  return `${fmtBig(Math.round(shares))}${unit ? '股' : ''}`;
}

/** 盘口 / 逐笔里的小数量（手 / 股），不带单位 */
export function fmtLots(shares, market) {
  if (!isNum(shares)) return '--';
  const n = market === 'cn' ? Math.round(shares / 100) : Math.round(shares);
  return n >= 1e5 ? fmtBig(n, 1) : String(n);
}

export function fmtNum(v, digits = 2) {
  return isNum(v) ? v.toFixed(digits) : '--';
}

export function trend(v) {
  if (!isNum(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}

/** 价格相对昨收的涨跌方向 */
export function trendVs(price, ref) {
  if (!isNum(price) || !isNum(ref)) return 'flat';
  return trend(price - ref);
}

export function exchangeTag(symbol) {
  const p = symbol.slice(0, 2);
  return { sh: 'SH', sz: 'SZ', bj: 'BJ', hk: 'HK', us: 'US' }[p] ?? p.toUpperCase();
}

export function displayCode(symbol) {
  return symbol.slice(2);
}

export function marketOf(symbol) {
  const p = symbol.slice(0, 2);
  if (p === 'sh' || p === 'sz' || p === 'bj') return 'cn';
  return p === 'hk' ? 'hk' : 'us';
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
