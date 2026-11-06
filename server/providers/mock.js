/**
 * 离线模拟数据源（DATA_PROVIDER=mock）。
 *
 * 用于无网络环境下的开发、演示和自动化测试。价格按几何布朗运动随机游走，
 * 接口返回结构与真实数据源完全一致，前端会显示「模拟数据」标记。
 */
import { marketOf } from '../../shared/symbols.js';
import { NotFoundError, NotSupportedError } from '../../shared/errors.js';

const UNIVERSE = [
  ['sh000001', '上证指数', 3640, 'index'],
  ['sz399001', '深证成指', 11200, 'index'],
  ['sz399006', '创业板指', 2470, 'index'],
  ['sh000688', '科创50', 1240, 'index'],
  ['sh000300', '沪深300', 4050, 'index'],
  ['hkHSI', '恒生指数', 24600, 'index'],
  ['hkHSTECH', '恒生科技指数', 4090, 'index'],
  ['usDJI', '道琼斯', 51500, 'index'],
  ['usIXIC', '纳斯达克', 24300, 'index'],
  ['usINX', '标普500', 7350, 'index'],
  ['sh600519', '贵州茅台', 1444, 'stock', 'gzmt'],
  ['sz300750', '宁德时代', 262.8, 'stock', 'ndsd'],
  ['sz002594', '比亚迪', 98.5, 'stock', 'byd'],
  ['sh601318', '中国平安', 56.2, 'stock', 'zgpa'],
  ['sh600036', '招商银行', 42.3, 'stock', 'zsyh'],
  ['sz000858', '五粮液', 128.4, 'stock', 'wly'],
  ['sh601899', '紫金矿业', 19.6, 'stock', 'zjky'],
  ['sh510300', '沪深300ETF', 4.128, 'fund', 'hs300etf'],
  ['hk00700', '腾讯控股', 424.2, 'stock', 'txkg'],
  ['hk09988', '阿里巴巴-W', 158.3, 'stock', 'albb'],
  ['hk03690', '美团-W', 98.6, 'stock', 'mt'],
  ['usAAPL', '苹果', 344.17, 'stock', 'pg'],
  ['usNVDA', '英伟达', 181.6, 'stock', 'ywd'],
  ['usTSLA', '特斯拉', 412.5, 'stock', 'tsl'],
  ['usMSFT', '微软', 498.2, 'stock', 'wr'],
].map(([symbol, name, base, type, pinyin = '']) => ({ symbol, name, base, type, pinyin }));

const BY_SYMBOL = new Map(UNIVERSE.map((u) => [u.symbol, u]));
const CURRENCY = { cn: 'CNY', hk: 'HKD', us: 'USD' };

function hash(str) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** 可复现的伪随机数（mulberry32） */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gauss = (rand) => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
const r = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function info(symbol) {
  const known = BY_SYMBOL.get(symbol);
  if (known) return known;
  const rand = rng(hash(symbol));
  return { symbol, name: symbol.slice(2).toUpperCase(), base: r(5 + rand() * 200), type: 'stock', pinyin: '' };
}

const state = new Map();

function live(symbol) {
  let s = state.get(symbol);
  const now = Date.now();
  if (!s) {
    const meta = info(symbol);
    const rand = rng(hash(symbol) ^ 0x9e3779b9);
    const prevClose = meta.base;
    const open = r(prevClose * (1 + gauss(rand) * 0.006), 3);
    s = { meta, rand, prevClose, open, price: open, high: open, low: open, volume: 0, amount: 0, updated: now };
    state.set(symbol, s);
  }
  const dt = Math.min(10, (now - s.updated) / 1000);
  if (dt > 0.2) {
    const sigma = s.meta.type === 'index' ? 0.00035 : 0.0009;
    const step = Math.exp(gauss(s.rand) * sigma * Math.sqrt(dt));
    const limit = marketOf(symbol) === 'cn' && s.meta.type !== 'index' ? 0.1 : 0.3;
    s.price = Math.min(s.prevClose * (1 + limit), Math.max(s.prevClose * (1 - limit), s.price * step));
    s.high = Math.max(s.high, s.price);
    s.low = Math.min(s.low, s.price);
    const vol = Math.round((s.meta.type === 'index' ? 2e6 : 2e3) * (0.5 + s.rand()) * dt) * 100;
    s.volume += vol;
    s.amount += vol * s.price;
    s.updated = now;
  }
  return s;
}

function quoteOf(symbol) {
  const s = live(symbol);
  const market = marketOf(symbol);
  const decimals = market === 'hk' || s.meta.type === 'fund' ? 3 : 2;
  const price = r(s.price, decimals);
  const change = r(price - s.prevClose, decimals);
  const tick = 10 ** -decimals;
  const isIndex = s.meta.type === 'index';
  const levels = market === 'cn' ? 5 : 1;
  const bids = [];
  const asks = [];
  if (!isIndex) {
    for (let i = 0; i < levels; i += 1) {
      bids.push({ price: r(price - tick * (i + 1), decimals), volume: Math.round(s.rand() * 500 + 1) * 100 });
      asks.push({ price: r(price + tick * (i + 1), decimals), volume: Math.round(s.rand() * 500 + 1) * 100 });
    }
  }
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const local = new Date(now.getTime() + 8 * 3600_000);
  const time = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  const cap = s.meta.base * 1e9;
  return {
    symbol,
    market,
    code: symbol.slice(2),
    name: s.meta.name,
    currency: CURRENCY[market],
    decimals,
    price,
    prevClose: s.prevClose,
    open: s.open,
    high: r(s.high, decimals),
    low: r(s.low, decimals),
    change,
    changePct: r((change / s.prevClose) * 100),
    amplitude: r(((s.high - s.low) / s.prevClose) * 100),
    time,
    ts: now.getTime(),
    noTrade: false,
    type: s.meta.type,
    rawType: s.meta.type,
    volume: s.volume,
    amount: r(s.amount),
    outerVolume: market === 'cn' ? Math.round(s.volume * 0.52) : undefined,
    innerVolume: market === 'cn' ? Math.round(s.volume * 0.48) : undefined,
    bids,
    asks,
    turnoverRate: isIndex ? null : r((s.volume / (cap / s.meta.base)) * 100, 2),
    pe: isIndex ? null : r(10 + (hash(symbol) % 400) / 10),
    pb: isIndex || market === 'us' ? null : r(1 + (hash(symbol) % 80) / 10),
    marketCap: isIndex ? null : cap,
    floatMarketCap: isIndex ? null : cap * 0.8,
    limitUp: market === 'cn' && !isIndex ? r(s.prevClose * 1.1) : undefined,
    limitDown: market === 'cn' && !isIndex ? r(s.prevClose * 0.9) : undefined,
    volumeRatio: market === 'cn' ? r(0.5 + s.rand() * 2) : undefined,
    avgPrice: isIndex || !s.volume ? null : r(s.amount / s.volume, decimals),
    high52w: r(s.meta.base * 1.35, decimals),
    low52w: r(s.meta.base * 0.72, decimals),
  };
}

const SESSIONS = {
  cn: [
    ['09:30', '11:30'],
    ['13:01', '15:00'],
  ],
  hk: [
    ['09:30', '12:00'],
    ['13:00', '16:00'],
  ],
  us: [['09:30', '16:00']],
};

function sessionMinutes(market) {
  const out = [];
  for (const [from, to] of SESSIONS[market]) {
    let [h, m] = from.split(':').map(Number);
    const [th, tm] = to.split(':').map(Number);
    while (h < th || (h === th && m <= tm)) {
      out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
      m += 1;
      if (m === 60) {
        h += 1;
        m = 0;
      }
    }
  }
  return out;
}

function today() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

function minuteSession(symbol, date, prevClose, fraction, endPrice) {
  const market = marketOf(symbol);
  const all = sessionMinutes(market);
  const count = Math.max(1, Math.round(all.length * fraction));
  const rand = rng(hash(symbol + date));
  const isIndex = info(symbol).type === 'index';
  let p = prevClose * (1 + gauss(rand) * 0.004);
  const raw = [];
  for (let i = 0; i < count; i += 1) {
    p *= Math.exp(gauss(rand) * (isIndex ? 0.0006 : 0.0015));
    raw.push(p);
  }
  // 让最后一个点与实时价格衔接
  const shift = endPrice ? endPrice / raw.at(-1) : 1;
  let cumV = 0;
  let cumA = 0;
  return all.slice(0, count).map((time, i) => {
    const price = r(raw[i] * (1 + (shift - 1) * (i / Math.max(1, count - 1))), 3);
    const volume = Math.round((isIndex ? 4e6 : 2e4) * (0.3 + rand() * (i < 15 ? 3 : 1))) * 100;
    cumV += volume;
    cumA += volume * price;
    return { time, price, volume, avg: isIndex ? null : r(cumA / cumV, 3) };
  });
}

async function getMinute(symbol, { days = 1 } = {}) {
  const q = quoteOf(symbol);
  const sessions = [];
  const date = today();
  let prev = q.prevClose;
  for (let d = days - 1; d >= 1; d -= 1) {
    const day = new Date(Date.parse(date) - d * 86400_000).toISOString().slice(0, 10);
    const pts = minuteSession(symbol, day, prev * (1 - d * 0.003), 1);
    sessions.push({ date: day, prevClose: r(prev * (1 - d * 0.003)), points: pts });
  }
  sessions.push({ date, prevClose: q.prevClose, points: minuteSession(symbol, date, q.prevClose, 0.55, q.price) });
  prev = q.prevClose;
  return { symbol, market: q.market, decimals: q.decimals, prevClose: prev, sessions };
}

async function getKline(symbol, { period = 'day', count = 320 } = {}) {
  const market = marketOf(symbol);
  const minute = period.startsWith('m');
  if (minute && market !== 'cn') throw new NotSupportedError('分钟 K 线目前仅支持沪深京市场');
  const q = quoteOf(symbol);
  const n = Math.min(640, Math.max(10, count | 0));
  const rand = rng(hash(symbol + period));
  const stepMs = { day: 86400_000, week: 7 * 86400_000, month: 30 * 86400_000, m1: 60_000, m5: 300_000, m15: 900_000, m30: 1_800_000, m60: 3_600_000 }[period];
  if (!stepMs) throw new NotSupportedError(`不支持的周期 ${period}`);
  const vol = { day: 0.018, week: 0.04, month: 0.08 }[period] ?? 0.003;
  const closes = [q.price];
  for (let i = 1; i < n; i += 1) closes.unshift(closes[0] / Math.exp(gauss(rand) * vol + 0.0002));
  const end = Date.now() + 8 * 3600_000;
  const bars = closes.map((close, i) => {
    const open = i === 0 ? close * (1 - gauss(rand) * vol * 0.3) : closes[i - 1];
    const high = Math.max(open, close) * (1 + rand() * vol * 0.6);
    const low = Math.min(open, close) * (1 - rand() * vol * 0.6);
    const t = new Date(end - (n - 1 - i) * stepMs).toISOString();
    return {
      time: minute ? `${t.slice(0, 10)} ${t.slice(11, 16)}` : t.slice(0, 10),
      open: r(open, q.decimals),
      high: r(high, q.decimals),
      low: r(low, q.decimals),
      close: r(close, q.decimals),
      volume: Math.round((q.type === 'index' ? 3e6 : 3e4) * (0.4 + rand() * 1.6)) * 100,
    };
  });
  return { symbol, market, period, adjust: '', decimals: q.decimals, bars };
}

async function getTicks(symbol, { limit = 60 } = {}) {
  if (marketOf(symbol) !== 'cn') throw new NotSupportedError('逐笔成交目前仅支持沪深京市场');
  const q = quoteOf(symbol);
  const rand = rng(hash(symbol) ^ Math.floor(Date.now() / 3000));
  const ticks = [];
  let t = Date.now() + 8 * 3600_000;
  let p = q.price;
  for (let i = 0; i < limit; i += 1) {
    const time = new Date(t).toISOString().slice(11, 19);
    const side = rand() > 0.5 ? 'B' : 'S';
    const volume = Math.round(rand() * 300 + 1) * 100;
    ticks.push({ id: limit - i, time, price: r(p, q.decimals), change: 0, volume, amount: r(volume * p), side });
    p *= 1 + (rand() - 0.5) * 0.001;
    t -= 3000;
  }
  return { symbol, supported: true, ticks };
}

async function getRank({ sort = 'changePct', order = 'desc', count = 20 } = {}) {
  const items = UNIVERSE.filter((u) => marketOf(u.symbol) === 'cn' && u.type !== 'index').map((u) => {
    const q = quoteOf(u.symbol);
    return {
      symbol: u.symbol,
      name: u.name,
      price: q.price,
      change: q.change,
      changePct: q.changePct,
      speed: r((rand01(u.symbol) - 0.5) * 2),
      turnoverRate: q.turnoverRate,
      volumeRatio: q.volumeRatio,
      amplitude: q.amplitude,
      amount: q.amount,
      volume: q.volume,
      pe: q.pe,
      marketCap: q.marketCap,
      floatMarketCap: q.floatMarketCap,
    };
  });
  const key = sort in items[0] ? sort : 'changePct';
  items.sort((a, b) => (order === 'asc' ? a[key] - b[key] : b[key] - a[key]));
  return { board: 'all', sort, order, offset: 0, total: items.length, items: items.slice(0, count) };
}

const rand01 = (s) => rng(hash(s) ^ Math.floor(Date.now() / 5000))();

async function search(query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  return UNIVERSE.filter(
    (u) => u.symbol.toLowerCase().includes(q) || u.name.toLowerCase().includes(q) || u.pinyin.includes(q),
  )
    .slice(0, 15)
    .map((u) => ({ symbol: u.symbol, market: marketOf(u.symbol), code: u.symbol.slice(2), name: u.name, pinyin: u.pinyin, type: u.type, rawType: u.type }));
}

export const mockProvider = {
  name: 'mock',
  label: '模拟数据',
  async getQuotes(symbols) {
    return new Map(symbols.map((s) => [s, quoteOf(s)]));
  },
  async getQuote(symbol) {
    if (!symbol) throw new NotFoundError('未找到代码');
    return quoteOf(symbol);
  },
  async getMarketStatus() {
    const open = { open: true, text: '模拟交易中' };
    return { time: new Date().toISOString(), cn: open, hk: open, us: open };
  },
  getMinute,
  getKline,
  getTicks,
  getRank,
  search,
};
