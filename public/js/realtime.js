/**
 * WebSocket 实时行情客户端：自动重连（指数退避 + 抖动）、断线后自动恢复订阅、心跳测延迟。
 */
export class RealtimeClient {
  constructor(url) {
    this.url = url;
    this.symbols = [];
    this.handlers = new Map();
    this.retry = 0;
    this.state = 'idle';
    this.latency = null;
    this.lastMessageAt = 0;
    this.suspendedAt = 0;
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
        console.error(`[realtime] ${type} handler failed`, err);
      }
    });
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', { state, latency: this.latency, retryIn: this.retryIn });
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.setState(this.retry ? 'reconnecting' : 'connecting');
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retry = 0;
      this.retryIn = 0;
      this.setState('open');
      this.sendSet();
      this.ping();
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(), 15_000);
    });

    ws.addEventListener('message', (ev) => {
      this.lastMessageAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        clearTimeout(this.pongTimer);
        // 页面切走前发出的心跳：往返时间里包含页面停住的时间，不是网络延迟
        if (msg.t < this.suspendedAt) return;
        this.latency = Date.now() - msg.t;
        this.emit('latency', this.latency);
        return;
      }
      this.emit(msg.type, msg);
    });

    ws.addEventListener('close', () => {
      clearInterval(this.pingTimer);
      clearTimeout(this.pongTimer);
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      /* close 事件会随后触发，在那里统一处理 */
    });
  }

  scheduleReconnect() {
    if (this.manualClose) return;
    const base = Math.min(30_000, 1000 * 2 ** this.retry);
    this.retryIn = Math.round(base * (0.75 + Math.random() * 0.5));
    this.retry += 1;
    this.state = 'reconnecting';
    this.emit('state', { state: 'reconnecting', retryIn: this.retryIn });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), this.retryIn);
  }

  /**
   * 页面切到后台 / 离开 / 被冻结：停掉心跳超时计时。否则页面停住的时间也算进等待回应的 10 秒，
   * 回来时会误判连接已失效而断开重连（指示灯闪成「重连中」）。回来后 reconnectNow 会立即重新检查
   */
  suspend() {
    this.suspendedAt = Date.now();
    clearTimeout(this.pongTimer);
  }

  /**
   * 网络恢复 / 页面重新可见时立即重连，不等退避计时。
   * 连接看起来还开着时立即发一次心跳：手机切后台期间连接可能已经断了（半开连接），10 秒内没回应就重连
   */
  reconnectNow() {
    if (this.state === 'open') {
      this.ping();
      return;
    }
    this.retry = 0;
    this.connect();
  }

  ping() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
    clearTimeout(this.pongTimer);
    // 10 秒没有回应视为连接已失效（例如经过代理的半开连接）
    this.pongTimer = setTimeout(() => this.ws?.close(), 10_000);
  }

  setSymbols(symbols) {
    const next = [...new Set(symbols)].sort();
    if (next.join(',') === this.symbols.join(',')) return;
    this.symbols = next;
    this.sendSet();
  }

  sendSet() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'set', symbols: this.symbols }));
    }
  }
}
