/**
 * 实时推送中心。
 *
 * - 客户端通过 WebSocket (/ws) 声明自己关心的代码集合；
 * - 服务端把所有客户端的订阅合并后批量轮询上游，只把「有变化」的报价推送给订阅了该代码的客户端；
 * - 交易时段按 QUOTE_INTERVAL_MS 刷新，休市市场自动降频；上游异常时指数退避并通知前端。
 *
 * 协议（JSON 文本帧）：
 *   C→S {type:'set', symbols:[...]}            覆盖式声明订阅集合
 *   C→S {type:'subscribe'|'unsubscribe', symbols:[...]}
 *   C→S {type:'ping', t}
 *   S→C {type:'hello', provider, interval, market}
 *   S→C {type:'quotes', data:[quote...], snapshot?:true}
 *   S→C {type:'unknown', symbols:[...]}        上游没有返回数据的代码
 *   S→C {type:'market', data}
 *   S→C {type:'upstream', ok, message?}
 *   S→C {type:'pong', t, serverTime}
 */
import { WebSocketServer } from 'ws';
import { marketOf, normalizeSymbol } from '../shared/symbols.js';
import { logger } from './lib/logger.js';

const UNKNOWN_TTL_MS = 10 * 60_000;
const MAX_BUFFERED = 1 << 20; // 客户端积压超过 1MB 时跳过本轮推送，避免慢客户端拖垮服务

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

export class QuoteHub {
  constructor({ provider, config }) {
    this.provider = provider;
    this.config = config;
    this.clients = new Map(); // ws -> { id, symbols:Set, alive }
    this.refs = new Map(); // symbol -> 订阅计数
    this.quotes = new Map(); // symbol -> 最新报价
    this.sigs = new Map();
    this.lastFetch = new Map();
    this.unknown = new Map(); // symbol -> 标记时间；过期后会重新尝试（应对上游偶发缺数据）
    this.market = null;
    this.failures = 0;
    this.upstreamOk = true;
    this.nextId = 1;
    this.timers = [];
    this.stopped = false;
    this.stats = { pushes: 0, polls: 0, startedAt: Date.now() };
  }

  attach(server) {
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    return this;
  }

  start() {
    this.stopped = false;
    this.refreshMarket();
    this.timers.push(setInterval(() => this.refreshMarket(), this.config.marketStatusIntervalMs));
    this.timers.push(setInterval(() => this.heartbeat(), this.config.heartbeatMs));
    this.scheduleTick(0);
    return this;
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    clearTimeout(this.tickTimer);
    for (const ws of this.clients.keys()) ws.close(1001, 'server shutdown');
    this.wss?.close();
  }

  snapshotStats() {
    return {
      clients: this.clients.size,
      symbols: this.refs.size,
      upstreamOk: this.upstreamOk,
      polls: this.stats.polls,
      pushes: this.stats.pushes,
      uptimeSec: Math.round((Date.now() - this.stats.startedAt) / 1000),
    };
  }

  /* ---------------------------------------------------------------- clients */

  onConnection(ws, req) {
    const client = { id: this.nextId++, symbols: new Set(), alive: true, ip: req.socket.remoteAddress };
    this.clients.set(ws, client);
    logger.debug(`ws#${client.id} connected from ${client.ip}`);

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return this.send(ws, { type: 'error', message: '消息格式错误' });
      }
      this.onMessage(ws, client, msg);
    });
    ws.on('close', () => {
      this.updateSubscriptions(client, new Set());
      this.clients.delete(ws);
      logger.debug(`ws#${client.id} closed`);
    });
    ws.on('error', (err) => logger.warn(`ws#${client.id} error: ${err.message}`));

    this.send(ws, {
      type: 'hello',
      provider: this.provider.name,
      providerLabel: this.provider.label,
      interval: this.config.quoteIntervalMs,
      market: this.market,
      upstreamOk: this.upstreamOk,
      serverTime: Date.now(),
    });
  }

  onMessage(ws, client, msg) {
    switch (msg?.type) {
      case 'ping':
        return this.send(ws, { type: 'pong', t: msg.t, serverTime: Date.now() });
      case 'set':
        return this.applySubscription(ws, client, new Set(this.cleanSymbols(msg.symbols)));
      case 'subscribe': {
        const next = new Set(client.symbols);
        this.cleanSymbols(msg.symbols).forEach((s) => next.add(s));
        return this.applySubscription(ws, client, next);
      }
      case 'unsubscribe': {
        const next = new Set(client.symbols);
        this.cleanSymbols(msg.symbols).forEach((s) => next.delete(s));
        return this.applySubscription(ws, client, next);
      }
      default:
        return this.send(ws, { type: 'error', message: `未知消息类型 ${msg?.type}` });
    }
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

  cleanSymbols(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
      const sym = normalizeSymbol(String(item));
      if (sym) out.push(sym);
      if (out.length >= this.config.maxSubscriptions) break;
    }
    return out;
  }

  applySubscription(ws, client, next) {
    const added = [...next].filter((s) => !client.symbols.has(s));
    this.updateSubscriptions(client, next);

    // 新增代码：有缓存直接下发快照，没有的立即拉取一次，不等下一轮轮询
    const cached = added.map((s) => this.quotes.get(s)).filter(Boolean);
    if (cached.length) this.send(ws, { type: 'quotes', data: cached, snapshot: true });
    const missing = added.filter((s) => !this.quotes.has(s));
    const unknown = added.filter((s) => this.isUnknown(s));
    if (unknown.length) this.send(ws, { type: 'unknown', symbols: unknown });
    const toFetch = missing.filter((s) => !this.isUnknown(s));
    if (toFetch.length) this.fetchAndDispatch(toFetch, { snapshotFor: ws });
  }

  updateSubscriptions(client, next) {
    for (const s of client.symbols) {
      if (!next.has(s)) this.release(s);
    }
    for (const s of next) {
      if (!client.symbols.has(s)) this.refs.set(s, (this.refs.get(s) ?? 0) + 1);
    }
    client.symbols = next;
  }

  release(symbol) {
    const n = (this.refs.get(symbol) ?? 1) - 1;
    if (n > 0) {
      this.refs.set(symbol, n);
      return;
    }
    this.refs.delete(symbol);
    this.quotes.delete(symbol);
    this.sigs.delete(symbol);
    this.lastFetch.delete(symbol);
  }

  send(ws, payload) {
    if (ws.readyState !== ws.OPEN) return false;
    if (ws.bufferedAmount > MAX_BUFFERED) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }

  broadcast(payload) {
    for (const ws of this.clients.keys()) this.send(ws, payload);
  }

  heartbeat() {
    for (const [ws, client] of this.clients) {
      if (!client.alive) {
        ws.terminate();
        continue;
      }
      client.alive = false;
      ws.ping();
    }
  }

  /* ---------------------------------------------------------------- polling */

  isOpen(market) {
    if (!this.market) return true; // 状态未知时按交易时段处理，宁可多刷新
    return Boolean(this.market[market]?.open);
  }

  scheduleTick(delay) {
    if (this.stopped) return;
    clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => this.tick(), delay);
  }

  async tick() {
    if (this.ticking) return; // 上一轮还没结束，由它负责安排下一轮
    this.ticking = true;
    try {
      const now = Date.now();
      const due = [];
      for (const sym of this.refs.keys()) {
        if (this.isUnknown(sym)) continue;
        const interval = this.isOpen(marketOf(sym)) ? this.config.quoteIntervalMs : this.config.idleQuoteIntervalMs;
        if (now - (this.lastFetch.get(sym) ?? 0) >= interval - 100) due.push(sym);
      }
      if (due.length) await this.fetchAndDispatch(due);
    } catch (err) {
      logger.error(`轮询异常：${err.stack || err}`);
    } finally {
      this.ticking = false;
    }

    const base = this.config.quoteIntervalMs;
    const backoff = this.failures ? Math.min(30_000, base * 2 ** Math.min(this.failures, 5)) : base;
    this.scheduleTick(backoff);
  }

  async fetchAndDispatch(symbols, { snapshotFor } = {}) {
    const started = Date.now();
    let quotes;
    try {
      quotes = await this.provider.getQuotes(symbols);
      this.stats.polls += 1;
    } catch (err) {
      this.failures += 1;
      if (this.upstreamOk || this.failures === 1) {
        logger.warn(`行情拉取失败（第 ${this.failures} 次）：${err.message}`);
      }
      if (this.upstreamOk) {
        this.upstreamOk = false;
        this.broadcast({ type: 'upstream', ok: false, message: err.message });
      }
      return;
    }

    if (!this.upstreamOk) {
      logger.info('行情数据源已恢复');
      this.upstreamOk = true;
      this.broadcast({ type: 'upstream', ok: true });
    }
    this.failures = 0;

    const changed = new Map();
    const newlyUnknown = [];
    for (const sym of symbols) {
      this.lastFetch.set(sym, started);
      const q = quotes.get(sym);
      if (!q) {
        if (!this.isUnknown(sym)) newlyUnknown.push(sym);
        this.unknown.set(sym, started);
        continue;
      }
      this.unknown.delete(sym);
      if (!this.refs.has(sym)) continue; // 拉取期间已被取消订阅
      const sig = signature(q);
      if (this.sigs.get(sym) !== sig) {
        this.sigs.set(sym, sig);
        this.quotes.set(sym, q);
        changed.set(sym, q);
      }
    }
    if (this.unknown.size > 5000) this.unknown.clear();

    const requested = new Set(symbols);
    for (const [ws, client] of this.clients) {
      const isSnapshotTarget = ws === snapshotFor;
      const data = [];
      for (const sym of client.symbols) {
        const q = changed.get(sym) ?? (isSnapshotTarget && requested.has(sym) ? this.quotes.get(sym) : undefined);
        if (q) data.push(q);
      }
      if (data.length && this.send(ws, { type: 'quotes', data, snapshot: isSnapshotTarget || undefined })) {
        this.stats.pushes += 1;
      }
      const unknown = newlyUnknown.filter((s) => client.symbols.has(s));
      if (unknown.length) this.send(ws, { type: 'unknown', symbols: unknown });
    }
  }

  async refreshMarket() {
    try {
      const status = await this.provider.getMarketStatus();
      const changed = JSON.stringify(status && { cn: status.cn, hk: status.hk, us: status.us }) !==
        JSON.stringify(this.market && { cn: this.market.cn, hk: this.market.hk, us: this.market.us });
      this.market = status;
      if (changed) {
        this.broadcast({ type: 'market', data: status });
        // 有市场刚开盘时立即刷新一轮
        this.scheduleTick(0);
      }
    } catch (err) {
      logger.warn(`市场状态获取失败：${err.message}`);
    }
  }
}
