/**
 * 简单的 TTL 缓存，带并发请求合并（同一个 key 正在请求时复用同一个 Promise），
 * 避免多个客户端同时打开同一只股票时重复请求上游。
 */
// 同一个请求最多合并这么久：超过还没结果（例如手机切后台后挂住的请求），后来的调用不再等它，重新请求
const INFLIGHT_MAX_MS = 30_000;

export class TTLCache {
  constructor({ maxEntries = 2000, inflightMaxMs = INFLIGHT_MAX_MS } = {}) {
    this.maxEntries = maxEntries;
    this.inflightMaxMs = inflightMaxMs;
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
    if (pending && Date.now() - pending.at <= this.inflightMaxMs) return pending.promise;
    const entry = { at: Date.now(), promise: null };
    entry.promise = (async () => {
      try {
        const value = await loader();
        // 迟到的旧请求不覆盖后来请求已经缓存的新结果
        const current = this.store.get(key);
        if (!current || (current.from ?? 0) <= entry.at) {
          this.set(key, value, ttlMs);
          this.store.get(key).from = entry.at;
        }
        return value;
      } finally {
        // 只清理自己：挂住的旧请求很久之后才结束时，不能把后来的新请求从表里删掉
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, entry);
    return entry.promise;
  }
}
