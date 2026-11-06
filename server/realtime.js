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
 *   S→C {type:'error', message}
 *
 * 防滥用：只接受同源（或 ALLOWED_ORIGINS 中）页面的连接；限制单 IP 连接数、单连接消息频率、
 * 全局订阅代码总数；新订阅的即时拉取合并成批，同一时刻最多一批在途。
 */
import { WebSocketServer } from 'ws';
import { marketOf, normalizeSymbol } from '../shared/symbols.js';
import { logger } from './lib/logger.js';

const UNKNOWN_TTL_MS = 10 * 60_000;
const MAX_BUFFERED = 1 << 20; // 客户端积压超过 1MB 时跳过本轮推送，避免慢客户端拖垮服务
const SNAPSHOT_DELAY_MS = 60; // 新订阅的即时拉取合并窗口
// 单连接消息限速（令牌桶）：平均每秒 4 条、突发 40 条；持续超限的连接会被断开
const MSG_BURST = 40;
const MSG_PER_SEC = 4;
const MAX_VIOLATIONS = 50;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** 客户端 IP：经本机反向代理转发时取代理记录的地址（与 Express 的 trust proxy 'loopback' 一致） */
export function clientIp(req) {
  const remote = req.socket?.remoteAddress ?? 'unknown';
  if (!LOOPBACK.has(remote)) return remote;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return forwarded.at(-1) ?? remote;
}

/** 浏览器发起的 WebSocket 连接必须来自同源页面或白名单；不带 Origin 的（脚本、命令行工具）放行 */
export function isAllowedOrigin(req, allowedOrigins = []) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (allowedOrigins.includes(url.origin)) return true;
  const viaProxy = LOOPBACK.has(req.socket?.remoteAddress) && req.headers['x-forwarded-host'];
  const host = String(viaProxy || req.headers.host || '').split(',')[0].trim().toLowerCase();
  return Boolean(host) && url.host.toLowerCase() === host;
}

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
    this.config = { maxTotalSymbols: 3000, maxConnectionsPerIp: 20, allowedOrigins: [], ...config };
    this.clients = new Map(); // ws -> { id, symbols:Set, alive }
    this.refs = new Map(); // symbol -> 订阅计数
    this.quotes = new Map(); // symbol -> 最新报价
    this.sigs = new Map();
    this.lastFetch = new Map();
    this.unknown = new Map(); // symbol -> 标记时间；过期后会重新尝试（应对上游偶发缺数据）
    this.ipConnections = new Map(); // ip -> 当前连接数
    this.pendingFetch = new Set(); // 等待即时拉取的新订阅代码
    this.pendingTargets = new Set(); // 等待快照的连接
    this.flushTimer = null;
    this.flushing = null;
    this.market = null;
    this.failures = 0;
    this.upstreamOk = true;
    this.nextId = 1;
    this.timers = [];
    this.stopped = false;
    this.stats = { pushes: 0, polls: 0, startedAt: Date.now() };
  }

  attach(server) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      maxPayload: 64 * 1024,
      verifyClient: (info, done) => {
        if (!isAllowedOrigin(info.req, this.config.allowedOrigins)) {
          logger.warn(`拒绝跨域 WebSocket 连接：${info.req.headers.origin}`);
          return done(false, 403, 'Forbidden');
        }
        const ip = clientIp(info.req);
        if ((this.ipConnections.get(ip) ?? 0) >= this.config.maxConnectionsPerIp) {
          return done(false, 429, 'Too Many Connections');
        }
        return done(true);
      },
    });
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
    clearTimeout(this.flushTimer);
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
    const ip = clientIp(req);
    const client = { id: this.nextId++, symbols: new Set(), alive: true, ip, tokens: MSG_BURST, refilledAt: Date.now(), violations: 0 };
    this.clients.set(ws, client);
    this.ipConnections.set(ip, (this.ipConnections.get(ip) ?? 0) + 1);
    logger.debug(`ws#${client.id} connected from ${client.ip}`);

    ws.on('pong', () => {
      client.alive = true;
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      if (!this.allowMessage(ws, client)) return;
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
      this.pendingTargets.delete(ws);
      const n = (this.ipConnections.get(ip) ?? 1) - 1;
      if (n > 0) this.ipConnections.set(ip, n);
      else this.ipConnections.delete(ip);
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

  /** 令牌桶限速：超限的消息直接丢弃，持续超限则断开连接 */
  allowMessage(ws, client) {
    const now = Date.now();
    client.tokens = Math.min(MSG_BURST, client.tokens + ((now - client.refilledAt) / 1000) * MSG_PER_SEC);
    client.refilledAt = now;
    if (client.tokens >= 1) {
      client.tokens -= 1;
      return true;
    }
    client.violations += 1;
    if (client.violations === 1) this.send(ws, { type: 'error', message: '消息过于频繁，部分请求已被忽略' });
    if (client.violations > MAX_VIOLATIONS) {
      logger.warn(`ws#${client.id} (${client.ip}) 消息过于频繁，已断开`);
      ws.close(1008, 'rate limit');
    }
    return false;
  }

  onMessage(ws, client, msg) {
    switch (msg?.type) {
      case 'ping':
        return this.send(ws, { type: 'pong', t: Number.isFinite(msg.t) ? msg.t : null, serverTime: Date.now() });
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
        return this.send(ws, { type: 'error', message: `未知消息类型 ${String(msg?.type).slice(0, 32)}` });
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

  applySubscription(ws, client, requested) {
    // 全局订阅总数达到上限时，不再接受此前没有任何人订阅的新代码
    let next = requested;
    const fresh = [...requested].filter((s) => !client.symbols.has(s) && !this.refs.has(s));
    const room = Math.max(0, this.config.maxTotalSymbols - this.refs.size);
    if (fresh.length > room) {
      const rejected = new Set(fresh.slice(room));
      next = new Set([...requested].filter((s) => !rejected.has(s)));
      this.send(ws, { type: 'error', message: '服务器订阅数量已达上限，部分代码暂时无法实时更新' });
    }
    const added = [...next].filter((s) => !client.symbols.has(s));
    this.updateSubscriptions(client, next);

    // 新增代码：有缓存直接下发快照，没有的立即拉取一次，不等下一轮轮询
    const cached = added.map((s) => this.quotes.get(s)).filter(Boolean);
    if (cached.length) this.send(ws, { type: 'quotes', data: cached, snapshot: true });
    const missing = added.filter((s) => !this.quotes.has(s));
    const unknown = added.filter((s) => this.isUnknown(s));
    if (unknown.length) this.send(ws, { type: 'unknown', symbols: unknown });
    const toFetch = missing.filter((s) => !this.isUnknown(s));
    if (toFetch.length) this.queueSnapshot(ws, toFetch);
  }

  /** 新订阅的代码合并成批即时拉取（同一时刻最多一批在途），避免逐条消息直接打到上游 */
  queueSnapshot(ws, symbols) {
    symbols.forEach((s) => this.pendingFetch.add(s));
    this.pendingTargets.add(ws);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushSnapshots(), SNAPSHOT_DELAY_MS);
  }

  async flushSnapshots() {
    this.flushTimer = null;
    if (this.flushing) {
      await this.flushing;
      if (this.flushTimer || !this.pendingFetch.size) return;
    }
    const symbols = [...this.pendingFetch].filter((s) => this.refs.has(s) && !this.quotes.has(s));
    const targets = new Set(this.pendingTargets);
    this.pendingFetch.clear();
    this.pendingTargets.clear();
    if (!symbols.length || this.stopped) return;
    this.flushing = this.fetchAndDispatch(symbols, { snapshotFor: targets }).finally(() => {
      this.flushing = null;
    });
    await this.flushing;
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
      if (this.refs.has(sym)) this.lastFetch.set(sym, started);
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
      const isSnapshotTarget = Boolean(snapshotFor?.has(ws));
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
