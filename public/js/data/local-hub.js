/**
 * 浏览器内的行情轮询中心，在没有服务端（GitHub Pages）时代替 WebSocket。
 *
 * 对外接口与 RealtimeClient 一致（on / setSymbols / connect / reconnectNow / state / latency），
 * 发出的事件也相同（hello / quotes / unknown / market / upstream / state / latency），
 * 所以页面其余部分不需要区分两种模式。
 */
import { marketOf } from '../../shared/symbols.js';

const UNKNOWN_TTL_MS = 10 * 60_000;

function signature(q) {
  return [
    q.price,
    q.volume,
    q.high,
    q.low,
    q.time,
    q.bids?.map((b) => `${b.price}:${b.volume}`).join(','),
    q.asks?.map((a) => `${a.price}:${a.volume}`).join(','),
  ].join('|');
}

export class LocalRealtime {
  constructor(provider, { interval = 3000, idleInterval = 30_000, marketInterval = 20_000 } = {}) {
    this.provider = provider;
    this.interval = interval;
    this.idleInterval = idleInterval;
    this.marketInterval = marketInterval;
    this.handlers = new Map();
    this.symbols = new Set();
    this.sigs = new Map();
    this.lastFetch = new Map();
    this.unknown = new Map();
    this.market = null;
    this.failures = 0;
    this.upstreamOk = true;
    this.state = 'idle';
    this.latency = null;
    this.running = false;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type).delete(fn);
  }

  emit(type, payload) {
    this.handlers.get(type)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[local-hub] ${type} handler failed`, err);
      }
    });
  }

  setState(state, extra = {}) {
    this.state = state;
    this.emit('state', { state, latency: this.latency, ...extra });
  }

  connect() {
    if (this.running) return;
    this.running = true;
    this.setState('connecting');
    this.emit('hello', {
      type: 'hello',
      provider: this.provider.name,
      providerLabel: this.provider.label,
      mode: 'direct',
      interval: this.interval,
      market: null,
      upstreamOk: true,
    });
    this.refreshMarket();
    this.marketTimer = setInterval(() => this.refreshMarket(), this.marketInterval);
    this.schedule(0);
  }

  reconnectNow() {
    if (!this.running) return this.connect();
    if (this.failures) this.schedule(0);
    return undefined;
  }

  setSymbols(list) {
    const next = new Set(list);
    const added = [...next].filter((s) => !this.symbols.has(s));
    for (const s of this.symbols) {
      if (!next.has(s)) {
        this.sigs.delete(s);
        this.lastFetch.delete(s);
      }
    }
    this.symbols = next;
    // 新增的代码立即拉取一次，不等下一轮
    const fresh = added.filter((s) => !this.isUnknown(s));
    if (this.running && fresh.length) this.fetch(fresh, { snapshot: true });
  }

  isUnknown(symbol) {
    const ts = this.unknown.get(symbol);
    if (ts === undefined) return false;
    if (Date.now() - ts > UNKNOWN_TTL_MS) {
      this.unknown.delete(symbol);
      return false;
    }
    return true;
  }

  isOpen(market) {
    return this.market ? Boolean(this.market[market]?.open) : true;
  }

  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const due = [...this.symbols].filter((s) => {
        if (this.isUnknown(s)) return false;
        const wait = this.isOpen(marketOf(s)) ? this.interval : this.idleInterval;
        return now - (this.lastFetch.get(s) ?? 0) >= wait - 100;
      });
      if (due.length) await this.fetch(due);
    } finally {
      this.ticking = false;
    }
    const backoff = this.failures ? Math.min(30_000, this.interval * 2 ** Math.min(this.failures, 4)) : this.interval;
    this.schedule(backoff);
  }

  async fetch(symbols, { snapshot = false } = {}) {
    const started = Date.now();
    let quotes;
    try {
      quotes = await this.provider.getQuotes(symbols);
    } catch (err) {
      this.failures += 1;
      if (this.upstreamOk) {
        this.upstreamOk = false;
        this.emit('upstream', { type: 'upstream', ok: false, message: err.message });
      }
      const retryIn = Math.min(30_000, this.interval * 2 ** Math.min(this.failures, 4));
      this.setState('reconnecting', { retryIn });
      return;
    }
    this.latency = Date.now() - started;
    this.emit('latency', this.latency);
    if (!this.upstreamOk) {
      this.upstreamOk = true;
      this.emit('upstream', { type: 'upstream', ok: true });
    }
    this.failures = 0;
    if (this.state !== 'open') this.setState('open');

    const changed = [];
    const unknown = [];
    for (const s of symbols) {
      this.lastFetch.set(s, started);
      const q = quotes.get(s);
      if (!q) {
        if (!this.isUnknown(s)) unknown.push(s);
        this.unknown.set(s, started);
        continue;
      }
      this.unknown.delete(s);
      if (!this.symbols.has(s)) continue;
      const sig = signature(q);
      if (snapshot || this.sigs.get(s) !== sig) {
        this.sigs.set(s, sig);
        changed.push(q);
      }
    }
    if (changed.length) this.emit('quotes', { type: 'quotes', data: changed, snapshot: snapshot || undefined });
    if (unknown.length) this.emit('unknown', { type: 'unknown', symbols: unknown });
  }

  async refreshMarket() {
    try {
      const status = await this.provider.getMarketStatus();
      const key = (m) => JSON.stringify(m && [m.cn, m.hk, m.us]);
      const changed = key(status) !== key(this.market);
      this.market = status;
      if (changed) {
        this.emit('market', { type: 'market', data: status });
        this.schedule(0);
      }
    } catch {
      /* 市场状态获取失败时沿用上一次结果 */
    }
  }
}
