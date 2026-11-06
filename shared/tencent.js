/**
 * 腾讯财经公开行情接口适配器（服务端与浏览器共用）。
 *
 * 覆盖：沪深京 A 股（含指数、ETF）、港股（实时，r_ 前缀）、美股。
 * 所有返回值都转换为与数据源无关的统一结构，前端只依赖这些结构。
 *
 * 本文件只包含纯逻辑，网络访问通过 createTencentProvider(io) 注入：
 *   io.text(url, encoding)  获取文本（腾讯 qt 接口是 GBK 编码）
 *   io.json(url)            获取 JSON
 *   io.script(url, name)    获取 `name=...` 形式的 JS 变量值（这类接口没有 CORS，浏览器端用 <script> 加载）
 * 服务端见 server/providers/tencent.js，浏览器端见 public/js/data/direct-provider.js。
 */
import { TTLCache } from './cache.js';
import { marketOf, normalizeSymbol } from './symbols.js';
import { NotSupportedError, NotFoundError, UpstreamError } from './errors.js';

const QT = 'https://qt.gtimg.cn/q=';
const IFZQ = 'https://web.ifzq.gtimg.cn/appstock/app';
const MKLINE = 'https://ifzq.gtimg.cn/appstock/app/kline/mkline';
const DETAIL = 'https://stock.gtimg.cn/data/index.php';
const RANK = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList';
const RANK_MOBILE = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/mktHs/rank';
const SMARTBOX = 'https://smartbox.gtimg.cn/s3/';

const TZ = { cn: 'Asia/Shanghai', hk: 'Asia/Hong_Kong', us: 'America/New_York' };
const CURRENCY = { cn: 'CNY', hk: 'HKD', us: 'USD' };

/* ------------------------------------------------------------------ helpers */

export const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Object.hasOwn 的兼容写法（iOS 15.4 以下没有 Object.hasOwn） */
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const scale = (v, factor) => (v === null ? null : Math.round(v * factor * 100) / 100);
const round = (v, digits = 4) => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);

function decimalsOf(raw, fallback = 2) {
  const m = /\.(\d+)$/.exec(String(raw ?? ''));
  if (!m) return fallback;
  return Math.min(4, Math.max(2, m[1].length));
}

/** 计算某时区在给定时刻相对 UTC 的偏移（分钟） */
function tzOffsetMinutes(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** 交易所当地时间（墙钟）→ Unix 毫秒 */
export function wallTimeToEpoch(y, mo, d, h, mi, s, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  return guess - tzOffsetMinutes(new Date(guess), timeZone) * 60000;
}

/** 解析腾讯的多种时间格式：20261106100724 / 2026/11/06 10:08:50 / 2026-11-05 16:00:02 */
export function parseQuoteTime(raw, market) {
  const m = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})[ T]?(\d{2}):?(\d{2}):?(\d{2})?/.exec(String(raw ?? '').trim());
  if (!m) return { time: null, ts: null };
  const [, y, mo, d, h, mi, s = '00'] = m;
  return {
    time: `${y}-${mo}-${d} ${h}:${mi}:${s}`,
    ts: wallTimeToEpoch(+y, +mo, +d, +h, +mi, +s, TZ[market]),
  };
}

function classify(rawType) {
  const t = String(rawType ?? '').toUpperCase();
  if (t.startsWith('ZS')) return 'index';
  if (/ETF|LOF|JJ|FUND|QDII/.test(t)) return 'fund';
  if (t.startsWith('ZQ') || t.includes('KZZ')) return 'bond';
  return 'stock';
}

const qtKey = (symbol) => (marketOf(symbol) === 'hk' ? `r_${symbol}` : symbol);

/* ------------------------------------------------------------------ quotes */

/**
 * 把腾讯 qt 接口的 "~" 分隔字段转换为统一的报价结构。
 * 字段位置对照见 README「数据字段说明」。
 */
export function parseQuoteFields(symbol, f) {
  const market = marketOf(symbol);
  let price = num(f[3]);
  const prevClose = num(f[4]);
  const noTrade = !price;
  if (noTrade) price = prevClose;

  const { time, ts } = parseQuoteTime(f[30], market);
  const decimals = decimalsOf(f[3] || f[4]);

  const base = {
    symbol,
    market,
    code: market === 'us' ? symbol.slice(2) : f[2],
    name: f[1],
    currency: CURRENCY[market],
    decimals,
    price,
    prevClose,
    open: num(f[5]) || null,
    high: num(f[33]) || null,
    low: num(f[34]) || null,
    change: noTrade ? 0 : num(f[31]),
    changePct: noTrade ? 0 : num(f[32]),
    amplitude: num(f[43]),
    time,
    ts,
    noTrade,
  };

  if (market === 'cn') {
    const type = classify(f[61]);
    const bids = [];
    const asks = [];
    for (let i = 0; i < 5; i += 1) {
      bids.push({ price: num(f[9 + i * 2]), volume: scale(num(f[10 + i * 2]), 100) });
      asks.push({ price: num(f[19 + i * 2]), volume: scale(num(f[20 + i * 2]), 100) });
    }
    const volume = scale(num(f[6]), 100);
    const amount = scale(num(f[57]) ?? num(f[37]), 10_000);
    return {
      ...base,
      type,
      rawType: f[61] || null,
      volume,
      amount,
      outerVolume: scale(num(f[7]), 100),
      innerVolume: scale(num(f[8]), 100),
      bids: type === 'index' ? [] : bids,
      asks: type === 'index' ? [] : asks,
      turnoverRate: num(f[38]),
      pe: num(f[39]),
      pb: num(f[46]),
      marketCap: scale(num(f[45]), 1e8),
      floatMarketCap: scale(num(f[44]), 1e8),
      limitUp: num(f[47]),
      limitDown: num(f[48]),
      volumeRatio: num(f[49]),
      avgPrice: type === 'index' ? null : num(f[51]) || (volume ? round(amount / volume) : null),
      high52w: num(f[67]),
      low52w: num(f[68]),
      totalShares: num(f[73]),
      floatShares: num(f[72]),
    };
  }

  if (market === 'hk') {
    const type = classify(f[63]);
    // 港股指数没有成交股数：f[6] 与 f[37] 相同，都是成交额，单位万港元（与分时接口第 3、4 列的换算关系一致）
    const hkIndex = type === 'index';
    const volume = hkIndex ? null : num(f[6]);
    const amount = hkIndex ? scale(num(f[37]) ?? num(f[6]), 10_000) : num(f[37]);
    const bid = num(f[9]);
    const ask = num(f[19]);
    return {
      ...base,
      type,
      rawType: f[63] || null,
      nameEn: f[46] || null,
      volume,
      amount,
      bids: bid && type !== 'index' ? [{ price: bid, volume: num(f[10]) || null }] : [],
      asks: ask && type !== 'index' ? [{ price: ask, volume: num(f[20]) || null }] : [],
      turnoverRate: type === 'index' ? null : num(f[59]),
      pe: type === 'index' ? null : num(f[39]),
      pb: type === 'index' ? null : num(f[58]),
      marketCap: type === 'index' ? null : scale(num(f[45]), 1e8),
      floatMarketCap: type === 'index' ? null : scale(num(f[44]), 1e8),
      dividendYield: type === 'index' ? null : num(f[47]),
      high52w: num(f[48]),
      low52w: num(f[49]),
      avgPrice: type === 'index' ? null : num(f[73]) || (volume ? round(amount / volume) : null),
    };
  }

  // us
  const volume = num(f[36]) ?? num(f[6]);
  const type = classify(f[56]);
  // 美股指数的 f[37] 量级不对（道指约 4.4×10^13），不展示
  const amount = type === 'index' ? null : num(f[37]);
  const bid = num(f[9]);
  const ask = num(f[19]);
  return {
    ...base,
    type,
    rawType: f[56] || null,
    nameEn: f[46] || null,
    exchangeCode: f[2] || null, // AAPL.OQ / .DJI，用于 K 线接口
    volume,
    amount,
    bids: bid && type !== 'index' ? [{ price: bid, volume: num(f[10]) || null }] : [],
    asks: ask && type !== 'index' ? [{ price: ask, volume: num(f[20]) || null }] : [],
    turnoverRate: type === 'index' ? null : num(f[38]),
    pe: type === 'index' ? null : num(f[39]),
    marketCap: type === 'index' ? null : scale(num(f[45]), 1e8),
    floatMarketCap: type === 'index' ? null : scale(num(f[44]), 1e8),
    high52w: num(f[48]),
    low52w: num(f[49]),
    avgPrice: type === 'index' || !volume || !amount ? null : round(amount / volume),
  };
}

/** 解析 `v_sh600519="...";` 形式的响应 */
export function parseQuoteResponse(text) {
  const out = new Map();
  for (const m of text.matchAll(/v_([\w.]+)="([^"]*)"/g)) {
    const fields = m[2].split('~');
    if (fields.length < 35) continue; // v_pv_none_match="1" 等无效代码
    const symbol = normalizeSymbol(m[1]);
    if (!symbol) continue;
    out.set(symbol, parseQuoteFields(symbol, fields));
  }
  return out;
}

/* ------------------------------------------------------------ market status */

const STATUS_KEYS = { cn: ['SH', 'SZ'], hk: ['HK'], us: ['US'] };

export function parseMarketStatus(text) {
  const m = /v_marketStat="([^"]*)"/.exec(text);
  if (!m) throw new UpstreamError('市场状态数据格式异常');
  const [time, ...items] = m[1].split('|');
  const raw = {};
  for (const item of items) {
    const [key, state, ...rest] = item.split('_');
    raw[key] = { open: state === 'open', text: rest.join('_') };
  }
  const pick = (keys) => {
    const found = keys.map((k) => raw[k]).filter(Boolean);
    if (!found.length) return { open: false, text: '未知' };
    return found.find((s) => s.open) || found[0];
  };
  return {
    time,
    cn: pick(STATUS_KEYS.cn),
    hk: pick(STATUS_KEYS.hk),
    us: pick(STATUS_KEYS.us),
  };
}

/* --------------------------------------------------------------- intraday */

const isIndexLike = (quote) => quote?.type === 'index';

/**
 * 解析分时数据行。腾讯的成交量 / 成交额是当日累计值，这里换算为每分钟增量。
 * A 股成交量单位为「手」，转换为股。
 */
export function parseMinuteRows(rows, { market, withAvg = true, volumeFromAmount = false }) {
  const points = [];
  let prevVol = 0;
  let vwapNum = 0;
  let vwapDen = 0;
  const volFactor = market === 'cn' ? 100 : 1;
  for (const row of rows) {
    const [hhmm, p, v, a] = String(row).trim().split(/\s+/);
    if (!/^\d{4}$/.test(hhmm)) continue;
    if (market === 'cn' && hhmm > '1500') break; // 盘后固定价格交易不画进分时
    const price = num(p);
    if (price === null) continue;
    // 港股指数没有成交股数，量柱改用累计成交额（第 4 列，港元）
    const cumVol = volumeFromAmount ? num(a) ?? 0 : (num(v) ?? 0) * volFactor;
    const cumAmt = num(a);
    const volume = Math.max(0, cumVol - prevVol);
    prevVol = Math.max(prevVol, cumVol);
    let avg = null;
    if (withAvg) {
      if (cumAmt !== null && cumVol > 0) {
        avg = cumAmt / cumVol;
      } else if (volume > 0 || vwapDen > 0) {
        vwapNum += price * volume;
        vwapDen += volume;
        avg = vwapDen ? vwapNum / vwapDen : price;
      }
    }
    points.push({
      time: `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`,
      price,
      volume,
      avg: avg === null ? null : round(avg),
    });
  }
  return points;
}

const fmtDate = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/* ------------------------------------------------------------------ k-line */

const DAY_PERIODS = new Set(['day', 'week', 'month']);
const MINUTE_PERIODS = new Set(['m1', 'm5', 'm15', 'm30', 'm60']);
const ADJUSTS = new Set(['qfq', 'hfq', '']);

export function parseKlineRows(rows, { market, minute = false }) {
  const volFactor = market === 'cn' ? 100 : 1;
  const bars = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const [t, o, c, h, l, v] = r;
    const open = num(o);
    const close = num(c);
    const high = num(h);
    const low = num(l);
    if ([open, close, high, low].some((x) => x === null)) continue;
    const ts = String(t);
    const time = minute
      ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}`
      : ts.slice(0, 10);
    bars.push({ time, open, high, low, close, volume: (num(v) ?? 0) * volFactor });
  }
  return bars;
}

/* ------------------------------------------------------------------- ticks */

/** 从 `v_xxx=<JSON>;` 形式的响应中取出变量值；找不到或无法解析时返回 null */
export function extractJsVar(text, name) {
  const re = new RegExp(`(?:^|[;\\s])${name.replace(/[$.]/g, '\\$&')}\\s*=`);
  const m = re.exec(text);
  if (!m) return null;
  let rest = text.slice(m.index + m[0].length).trim();
  const end = rest.search(/;\s*(?:\n|$)/);
  if (end >= 0) rest = rest.slice(0, end);
  try {
    return JSON.parse(rest);
  } catch {
    return null;
  }
}

export function parseTickRows(raw) {
  return String(raw ?? '')
    .split('|')
    .map((row) => row.split('/'))
    .filter((p) => p.length >= 7)
    .map(([idx, time, price, change, vol, amount, side]) => ({
      id: Number(idx),
      time,
      price: num(price),
      change: num(change),
      volume: (num(vol) ?? 0) * 100,
      amount: num(amount),
      side: side === 'B' ? 'B' : side === 'S' ? 'S' : 'M',
    }));
}

/* -------------------------------------------------------------------- rank */

const RANK_SORT = {
  changePct: 'priceRatio',
  amount: 'turnover',
  volume: 'volume',
  speed: 'speed',
  volumeRatio: 'volumeRatio',
  amplitude: 'amplitude',
};
const RANK_BOARDS = { all: 'aStock', cyb: 'cyb', kcb: 'kcb' };

/** 腾讯手机版排行（mktHs/rank，支持 CORS，供浏览器直连模式使用；仅支持全部 A 股的涨跌幅排序） */
export function parseMobileRankItems(list) {
  return (Array.isArray(list) ? list : [])
    .map((r) => ({
      symbol: normalizeSymbol(String(r.code ?? '')),
      name: r.name,
      price: num(r.zxj),
      change: num(r.zd),
      changePct: num(r.zdf),
      speed: num(r.zs),
      turnoverRate: num(r.hsl),
      volumeRatio: num(r.lb),
      amplitude: num(r.zf),
      amount: null,
      volume: scale(num(r.cjl), 100),
    }))
    .filter((i) => i.symbol);
}

/* ------------------------------------------------------------------ search */

const SEARCH_MARKETS = new Set(['sh', 'sz', 'bj', 'hk', 'us']);

/**
 * 搜索关键字只保留文字、数字、空格和 . - 等代码里会出现的字符：
 * 尖括号、引号之类的字符对搜索没有意义，还会被上游的防火墙直接拒绝（HTTP 501）。
 */
export function sanitizeSearchQuery(query) {
  return String(query ?? '')
    .replace(/[^\p{L}\p{N}\s.\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

export function parseSearchResponse(text) {
  return parseSearchValue(extractJsVar(text, 'v_hint'));
}

/** v_hint 的值（已解码的字符串）→ 搜索结果 */
export function parseSearchValue(decoded) {
  if (typeof decoded !== 'string' || !decoded || decoded === 'N') return [];
  const out = [];
  const seen = new Set();
  for (const item of decoded.split('^')) {
    const [mkt, code, name, pinyin, rawType] = item.split('~');
    if (!SEARCH_MARKETS.has(mkt) || !code || !name) continue;
    if (/^QZ|^NX/.test(rawType ?? '')) continue; // 涡轮/牛熊证噪音太多
    const symbol = normalizeSymbol(mkt === 'us' ? `us.${code}` : `${mkt}${code}`);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push({
      symbol,
      market: marketOf(symbol),
      code: symbol.slice(2),
      name,
      pinyin: pinyin && pinyin !== '*' ? pinyin : '',
      type: classify(rawType),
      rawType: rawType ?? '',
    });
  }
  return out;
}

/* ---------------------------------------------------------------- provider */

/**
 * @param io       网络访问实现，见文件头注释
 * @param options.rankSource 'board'（完整排行，需服务端代理）| 'mobile'（支持 CORS，仅涨跌幅）
 */
export function createTencentProvider(io, { name = 'tencent', label = '腾讯财经', rankSource = 'board' } = {}) {
  const cache = new TTLCache({ maxEntries: 5000 });
  const mobileRank = rankSource === 'mobile';

  async function getQuotes(symbols) {
    const list = [...new Set(symbols)];
    const chunks = [];
    for (let i = 0; i < list.length; i += 60) chunks.push(list.slice(i, i + 60));
    const results = await Promise.all(
      chunks.map((chunk) => io.text(QT + chunk.map(qtKey).join(','), 'gbk').then(parseQuoteResponse)),
    );
    const merged = new Map();
    for (const map of results) for (const [k, v] of map) merged.set(k, v);
    for (const q of merged.values()) {
      if (q.market === 'us' && q.exchangeCode) cache.set(`uscode:${q.symbol}`, q.exchangeCode, 12 * 3600_000);
    }
    return merged;
  }

  async function getQuote(symbol) {
    const quotes = await cache.wrap(`quote:${symbol}`, 1000, () => getQuotes([symbol]));
    const q = quotes.get(symbol);
    if (!q) throw new NotFoundError(`未找到代码 ${symbol}`);
    return q;
  }

  async function getMarketStatus() {
    return cache.wrap('marketStat', 10_000, async () =>
      parseMarketStatus(await io.text(`${QT}marketStat`, 'gbk')),
    );
  }

  async function getMinute(symbol, { days = 1 } = {}) {
    const market = marketOf(symbol);
    const quote = await getQuote(symbol);
    const withAvg = !isIndexLike(quote);
    const hkIndex = market === 'hk' && isIndexLike(quote);
    const volumeKind = hkIndex ? 'amount' : 'volume';

    if (days > 1) {
      return cache.wrap(`minute5:${symbol}`, 20_000, async () => {
        const path = market === 'us' ? 'dayus/query' : 'day/query';
        const json = await io.json(`${IFZQ}/${path}?code=${symbol}`);
        const node = json?.data?.[symbol];
        if (!node || !Array.isArray(node.data)) throw new NotFoundError(`没有 ${symbol} 的多日分时数据`);
        const sessions = node.data
          .slice(0, days)
          .reverse()
          .map((day) => ({
            date: fmtDate(day.date),
            prevClose: num(day.prec),
            points: parseMinuteRows(day.data ?? [], { market, withAvg, volumeFromAmount: hkIndex }),
          }));
        return { symbol, market, decimals: quote.decimals, volumeKind, prevClose: sessions.at(-1)?.prevClose ?? quote.prevClose, sessions };
      });
    }

    return cache.wrap(`minute:${symbol}`, 3_000, async () => {
      const path = market === 'us' ? 'UsMinute/query' : 'minute/query';
      const json = await io.json(`${IFZQ}/${path}?code=${symbol}`);
      const node = json?.data?.[symbol];
      const rows = node?.data?.data;
      if (!Array.isArray(rows)) throw new NotFoundError(`没有 ${symbol} 的分时数据`);
      const date = node.data.date ? fmtDate(String(node.data.date)) : (quote.time ?? '').slice(0, 10);
      return {
        symbol,
        market,
        decimals: quote.decimals,
        prevClose: quote.prevClose,
        volumeKind,
        sessions: [{ date, prevClose: quote.prevClose, points: parseMinuteRows(rows, { market, withAvg, volumeFromAmount: hkIndex }) }],
      };
    });
  }

  async function usKlineCode(symbol) {
    const cached = cache.get(`uscode:${symbol}`);
    if (cached) return `us${cached}`;
    const q = await getQuote(symbol);
    return q.exchangeCode ? `us${q.exchangeCode}` : symbol;
  }

  async function getKline(symbol, { period = 'day', count = 320, adjust = 'qfq' } = {}) {
    const market = marketOf(symbol);
    if (!DAY_PERIODS.has(period) && !MINUTE_PERIODS.has(period)) throw new NotSupportedError(`不支持的周期 ${period}`);
    if (!ADJUSTS.has(adjust)) throw new NotSupportedError(`不支持的复权方式 ${adjust}`);
    const n = Math.min(640, Math.max(10, count | 0));

    if (MINUTE_PERIODS.has(period)) {
      if (market !== 'cn') throw new NotSupportedError('分钟 K 线目前仅支持沪深京市场');
      const limit = Math.min(800, n);
      return cache.wrap(`mk:${symbol}:${period}:${limit}`, 8_000, async () => {
        const json = await io.json(`${MKLINE}?param=${symbol},${period},,${limit}`);
        const rows = json?.data?.[symbol]?.[period];
        if (!Array.isArray(rows)) throw new NotFoundError(`没有 ${symbol} 的分钟 K 线`);
        const quote = await getQuote(symbol);
        return { symbol, market, period, adjust: '', decimals: quote.decimals, bars: parseKlineRows(rows, { market, minute: true }) };
      });
    }

    return cache.wrap(`k:${symbol}:${period}:${n}:${adjust}`, 20_000, async () => {
      const quote = await getQuote(symbol);
      const index = isIndexLike(quote);
      const adj = index ? '' : adjust;
      let code = symbol;
      let endpoint = 'fqkline/get';
      if (market === 'us') {
        code = await usKlineCode(symbol);
        if (!index) endpoint = 'usfqkline/get';
      }
      const json = await io.json(`${IFZQ}/${endpoint}?param=${code},${period},,,${n},${adj}`);
      const node = json?.data?.[code];
      const rows = node?.[`${adj}${period}`] ?? node?.[period];
      if (!Array.isArray(rows)) throw new NotFoundError(`没有 ${symbol} 的 K 线数据`);
      const volumeKind = market === 'hk' && index ? 'amount' : 'volume';
      return { symbol, market, period, adjust: adj, decimals: quote.decimals, volumeKind, bars: parseKlineRows(rows, { market }) };
    });
  }

  async function getTicks(symbol, { limit = 60 } = {}) {
    if (marketOf(symbol) !== 'cn') throw new NotSupportedError('逐笔成交目前仅支持沪深京市场');
    const n = Math.min(200, Math.max(10, limit | 0));
    return cache.wrap(`ticks:${symbol}:${n}`, 2_000, async () => {
      const timeline = await io.script(`${DETAIL}?appn=detail&action=timeline&c=${symbol}`, `v_detail_time_${symbol}`);
      const pages = Array.isArray(timeline) && timeline[1] ? String(timeline[1]).split('|').length : 0;
      if (!pages) return { symbol, supported: true, ticks: [] };
      let ticks = [];
      for (let p = pages - 1; p >= 0 && ticks.length < n; p -= 1) {
        const data = await io.script(`${DETAIL}?appn=detail&action=data&c=${symbol}&p=${p}`, `v_detail_data_${symbol}`);
        if (!Array.isArray(data)) break;
        ticks = parseTickRows(data[1]).concat(ticks);
        if (p < pages - 3) break; // 最多回溯 3 页
      }
      return { symbol, supported: true, ticks: ticks.slice(-n).reverse() };
    });
  }

  async function getRank({ board = 'all', sort = 'changePct', order = 'desc', offset = 0, count = 20 } = {}) {
    if (mobileRank) return getMobileRank({ board, sort, order, offset, count });
    // 只认自有属性，避免 sort=constructor / __proto__ 之类的参数命中原型链
    const sortType = hasOwn(RANK_SORT, sort) ? RANK_SORT[sort] : null;
    const boardCode = hasOwn(RANK_BOARDS, board) ? RANK_BOARDS[board] : null;
    if (!sortType) throw new NotSupportedError(`不支持的排序字段 ${sort}`);
    if (!boardCode) throw new NotSupportedError(`不支持的板块 ${board}`);
    const direct = order === 'asc' ? 'up' : 'down';
    const n = Math.min(100, Math.max(1, count | 0));
    const off = Math.max(0, offset | 0);
    return cache.wrap(`rank:${boardCode}:${sortType}:${direct}:${off}:${n}`, 5_000, async () => {
      const url = `${RANK}?_appver=11.17.0&board_code=${boardCode}&sort_type=${sortType}&direct=${direct}&offset=${off}&count=${n}`;
      const json = await io.json(url);
      if (json?.code !== 0) throw new UpstreamError(`排行接口错误: ${json?.msg ?? '未知'}`);
      const items = (json.data?.rank_list ?? []).map((r) => ({
        symbol: normalizeSymbol(r.code),
        name: r.name,
        price: num(r.zxj),
        change: num(r.zd),
        changePct: num(r.zdf),
        speed: num(r.speed),
        turnoverRate: num(r.hsl),
        volumeRatio: num(r.lb),
        amplitude: num(r.zf),
        amount: scale(num(r.turnover), 10_000),
        volume: scale(num(r.volume), 100),
        pe: num(r.pe_ttm),
        marketCap: scale(num(r.zsz), 1e8),
        floatMarketCap: scale(num(r.ltsz), 1e8),
      }));
      return { board, sort, order, offset: off, total: json.data?.total ?? items.length, items: items.filter((i) => i.symbol) };
    });
  }

  async function search(query) {
    const q = sanitizeSearchQuery(query);
    if (!q) return [];
    return cache.wrap(`search:${q.toLowerCase()}`, 10 * 60_000, async () =>
      parseSearchValue(await io.script(`${SMARTBOX}?v=2&t=all&q=${encodeURIComponent(q)}`, 'v_hint')).slice(0, 15),
    );
  }

  async function getMobileRank({ board, sort, order, offset, count }) {
    if (sort !== 'changePct') throw new NotSupportedError('当前模式下排行仅支持涨跌幅');
    if (board !== 'all') throw new NotSupportedError('当前模式下排行仅支持全部 A 股');
    const n = Math.min(100, Math.max(1, count | 0));
    const page = Math.floor(Math.max(0, offset | 0) / n) + 1;
    const o = order === 'asc' ? 1 : 0;
    return cache.wrap(`mrank:${o}:${page}:${n}`, 5_000, async () => {
      const json = await io.json(`${RANK_MOBILE}?l=${n}&p=${page}&t=ranka/chr&ordertype=&o=${o}`);
      if (json?.code !== 0) throw new UpstreamError(`排行接口错误: ${json?.msg ?? '未知'}`);
      const items = parseMobileRankItems(json.data);
      return { board, sort, order, offset: (page - 1) * n, total: items.length, items };
    });
  }

  return {
    name,
    label,
    capabilities: {
      rank: mobileRank ? { sorts: ['changePct'], boards: ['all'] } : null,
    },
    getQuotes,
    getQuote,
    getMarketStatus,
    getMinute,
    getKline,
    getTicks,
    getRank,
    search,
  };
}
