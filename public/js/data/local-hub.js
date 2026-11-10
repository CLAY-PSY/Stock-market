/**
 * 浏览器内的行情轮询中心，在没有服务端（GitHub Pages）时代替 WebSocket。
 *
 * 对外接口与 RealtimeClient 一致（on / setSymbols / connect / reconnectNow / state / latency），
 * 发出的事件也相同（hello / quotes / unknown / market / upstream / state / latency），
 * 所以页面其余部分不需要区分两种模式。
 */
import { marketOf } from '../../shared/symbols.js';
import { withDeadline } from '../../shared/deadline.js';

const UNKNOWN_TTL_MS = 10 * 60_000;
// 一次请求最长等待：请求自身 10 秒超时之外再留余量。到点还没结果就放弃，轮询照常继续
const REQUEST_DEADLINE_MS = 15_000;
// 看门狗：每隔一段时间检查轮询是否还在转
const WATCHDOG_MS = 10_000;

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
  constructor(
    provider,
    { interval = 3000, idleInterval = 30_000, marketInterval = 20_000, requestDeadline = REQUEST_DEADLINE_MS, watchdog = WATCHDOG_MS } = {},
  ) {
    this.provider = provider;
    this.interval = interval;
    this.idleInterval = idleInterval;
    this.marketInterval = marketInterval;
    this.requestDeadline = requestDeadline;
    this.watchdogInterval = watchdog;
    this.round = 0; // 轮询的轮次：卡住的一轮被放弃后，它迟到的收尾不再影响后面的轮询
    this.reqSeq = 0; // 请求序号：迟到的旧结果不覆盖已经显示的新结果
    this.okSeq = 0;
    this.appliedSeq = new Map();
    this.roundStartedAt = 0;
    this.lastRoundAt = 0;
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
    this.watchdogTimer = setInterval(() => this.checkStalled(), this.watchdogInterval);
    this.schedule(0);
  }

  /**
   * 回到前台 / 网络恢复 / 页面从缓存恢复：立即刷新一次。
   * 手机切走期间页面被挂起，回来时上一轮请求可能还挂着（不管它是刚发出还是发出很久了），
   * 直接放弃它、马上重新请求；它之后即使返回，旧结果也不会覆盖新结果
   */
  reconnectNow() {
    if (!this.running) return this.connect();
    if (this.ticking) this.abandonRound();
    this.refreshMarket();
    this.schedule(0);
    return undefined;
  }

  /** 停止轮询 */
  close() {
    this.running = false;
    this.round += 1;
    clearTimeout(this.timer);
    clearInterval(this.marketTimer);
    clearInterval(this.watchdogTimer);
  }

  /** 放弃正在进行（已卡住）的一轮，马上开始新的一轮 */
  abandonRound() {
    this.round += 1;
    this.ticking = false;
    this.schedule(0);
  }

  /** 看门狗：一轮拉取远超截止时间仍未结束，或很久没有完成过一轮（计时器丢失），就重启轮询 */
  checkStalled() {
    if (!this.running) return;
    const now = Date.now();
    if (this.ticking) {
      if (now - this.roundStartedAt > this.requestDeadline * 2) this.abandonRound();
      return;
    }
    // 正常情况下两轮之间最长：收盘后的间隔（或失败退避，最长 30 秒）+ 一次请求的截止时间
    const longest = Math.max(this.idleInterval, Math.min(30_000, this.interval * 16)) + this.requestDeadline;
    if (now - this.lastRoundAt > longest * 2) this.schedule(0);
  }

  setSymbols(list) {
    const next = new Set(list);
    const added = [...next].filter((s) => !this.symbols.has(s));
    for (const s of this.symbols) {
      if (!next.has(s)) {
        this.sigs.delete(s);
        this.lastFetch.delete(s);
        this.appliedSeq.delete(s);
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
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick(), delay);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    this.round += 1;
    const round = this.round;
    this.roundStartedAt = Date.now();
    try {
      const now = Date.now();
      const due = [...this.symbols].filter((s) => {
        if (this.isUnknown(s)) return false;
        const wait = this.isOpen(marketOf(s)) ? this.interval : this.idleInterval;
        return now - (this.lastFetch.get(s) ?? 0) >= wait - 100;
      });
      if (due.length) await this.fetch(due);
    } catch (err) {
      console.error('[local-hub] poll failed', err); // 意外错误也不能让轮询停下
    } finally {
      if (round === this.round) {
        this.ticking = false;
        this.lastRoundAt = Date.now();
      }
    }
    if (round !== this.round) return; // 这一轮已被放弃，新的一轮已经在跑
    const backoff = this.failures ? Math.min(30_000, this.interval * 2 ** Math.min(this.failures, 4)) : this.interval;
    this.schedule(backoff);
  }

  async fetch(symbols, { snapshot = false } = {}) {
    this.reqSeq += 1;
    const seq = this.reqSeq;
    const started = Date.now();
    let quotes;
    try {
      quotes = await withDeadline(this.provider.getQuotes(symbols), this.requestDeadline);
    } catch (err) {
      if (seq < this.okSeq) return; // 之后发出的请求已经成功，这次迟到的失败不算
      this.failures += 1;
      if (this.upstreamOk) {
        this.upstreamOk = false;
        this.emit('upstream', { type: 'upstream', ok: false, message: err.message });
      }
      const retryIn = Math.min(30_000, this.interval * 2 ** Math.min(this.failures, 4));
      this.setState('reconnecting', { retryIn });
      return;
    }
    this.okSeq = Math.max(this.okSeq, seq);
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
      if (this.symbols.has(s)) this.lastFetch.set(s, started); // 拉取期间被取消订阅的不再记录
      const q = quotes.get(s);
      if (!q) {
        if (!this.isUnknown(s)) unknown.push(s);
        this.unknown.set(s, started);
        continue;
      }
      this.unknown.delete(s);
      if (!this.symbols.has(s)) continue;
      if ((this.appliedSeq.get(s) ?? 0) > seq) continue; // 已经显示了更新的结果
      this.appliedSeq.set(s, seq);
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
      const status = await withDeadline(this.provider.getMarketStatus(), this.requestDeadline);
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
