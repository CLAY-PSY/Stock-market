/**
 * 代码规范化。
 *
 * 统一使用「市场前缀 + 代码」作为内部标识：
 *   沪市 sh600519 / 深市 sz000001 / 北交所 bj920175
 *   港股 hk00700 / 港股指数 hkHSI
 *   美股 usAAPL / 美股指数 usDJI
 */

const CN_PREFIXES = new Set(['sh', 'sz', 'bj']);
const HK_INDICES = new Set(['HSI', 'HSTECH', 'HSCEI', 'HSCCI']);

/** 根据 6 位数字代码推断沪/深/北交所 */
export function inferCnExchange(code) {
  if (/^(92|8[3-9]|4[0-9])/.test(code)) return 'bj';
  if (/^(6|5|9|11)/.test(code)) return 'sh';
  return 'sz';
}

/**
 * 把用户输入（600519 / SH600519 / 00700 / hk700 / aapl / AAPL.OQ / sh000001）转为内部标识。
 * 无法识别时返回 null。
 */
export function normalizeSymbol(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s || s.length > 24) return null;

  // 腾讯实时港股前缀 r_hk00700
  s = s.replace(/^r_/i, '');

  // 注意：SHOP、USB 之类的美股代码本身就以 sh/us 开头，所以只在前缀后面的部分符合该市场格式时才当作前缀
  const cn = /^(sh|sz|bj)\.?(\d{6})$/i.exec(s);
  if (cn) return `${cn[1].toLowerCase()}${cn[2]}`;

  const hk = /^hk\.?(\d{1,5}|[A-Za-z]+)$/i.exec(s);
  if (hk) {
    if (/^\d+$/.test(hk[1])) return `hk${hk[1].padStart(5, '0')}`;
    if (HK_INDICES.has(hk[1].toUpperCase())) return `hk${hk[1].toUpperCase()}`;
  }

  // 显式美股前缀：内部格式 usAAPL（小写 us），或 us.AAPL / US.AAPL
  const us = /^(?:us\.?|US\.)(.+)$/.exec(s);
  if (us) return normalizeUs(us[1]);

  if (/^\d{6}$/.test(s)) return `${inferCnExchange(s)}${s}`;
  if (/^\d{1,5}$/.test(s)) return `hk${s.padStart(5, '0')}`;
  return normalizeUs(s);
}

function normalizeUs(code) {
  // 去掉交易所后缀：AAPL.OQ / BABA.N / TCEHY.PS；保留类似 BRK.B 的份额类别
  let c = code.replace(/^\./, '');
  const m = /^([A-Za-z]+)\.(OQ|N|AM|PS)$/i.exec(c);
  if (m) c = m[1];
  if (!/^[A-Za-z]{1,8}(\.[A-Za-z])?$/.test(c)) return null;
  return `us${c.toUpperCase()}`;
}

/** 内部标识 → 市场（cn / hk / us） */
export function marketOf(symbol) {
  const p = symbol.slice(0, 2);
  if (CN_PREFIXES.has(p)) return 'cn';
  return p === 'hk' ? 'hk' : 'us';
}

/** 解析逗号分隔的代码列表并去重 */
export function parseSymbolList(raw, limit = 200) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw ?? '').split(/[\s,]+/)) {
    const sym = normalizeSymbol(part);
    if (sym && !seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
      if (out.length >= limit) break;
    }
  }
  return out;
}
