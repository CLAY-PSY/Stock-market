/**
 * 简单的 TTL 缓存，带并发请求合并（同一个 key 正在请求时复用同一个 Promise），
 * 避免多个客户端同时打开同一只股票时重复请求上游。
 */
export class TTLCache {
  constructor({ maxEntries = 2000 } = {}) {
    this.maxEntries = maxEntries;
    this.store = new Map();
    this.inflight = new Map();
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.store.size >= this.maxEntries) {
      // Map 按插入顺序迭代，删除最早写入的一项
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }

  /**
   * 读取缓存，未命中时调用 loader，并把结果缓存 ttlMs 毫秒。
   */
  async wrap(key, ttlMs, loader) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = (async () => {
      try {
        const value = await loader();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }
}
