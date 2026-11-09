/**
 * 数据访问层。
 * - 服务端模式：请求同源的 REST 接口（相对路径，部署在子路径下也能工作）；
 * - 静态模式（GitHub Pages）：useDirectProvider() 之后改为在浏览器内直接调用数据源，返回结构与 REST 接口一致。
 */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

let direct = null;

/** 切换到浏览器直连数据源 */
export function useDirectProvider(provider) {
  direct = provider;
}

/** 当前数据源的能力限制（例如静态模式下排行只支持涨跌幅）；服务端模式下为空对象 */
export function capabilities() {
  return direct?.capabilities ?? {};
}

async function request(path, { timeout = 12_000, signal } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeout);
  const onAbort = () => ctrl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(path, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* 非 JSON 响应 */
    }
    if (!res.ok) throw new ApiError(body?.error || `请求失败 (HTTP ${res.status})`, res.status);
    return body;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err?.name === 'AbortError' && signal?.aborted) throw err;
    if (err?.name === 'TimeoutError' || ctrl.signal.reason?.name === 'TimeoutError') throw new ApiError('请求超时', 0);
    throw new ApiError('网络连接失败', 0);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 直连模式下统一错误类型，并在调用方取消时丢弃结果 */
/** 取消信号触发时立即结束等待（直连的数据源不认识取消信号，挂住的请求不会自己结束） */
function untilAborted(signal) {
  return new Promise((_, reject) => {
    const abort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

async function viaDirect(fn, signal) {
  try {
    const result = await (signal ? Promise.race([fn(), untilAborted(signal)]) : fn());
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return result;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(err?.message || '数据获取失败', err?.status ?? 0);
  }
}

const q = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();

export const api = {
  marketStatus: () => (direct ? viaDirect(() => direct.getMarketStatus()) : request('api/market-status')),

  quotes: (symbols) =>
    direct
      ? viaDirect(async () => {
          const map = await direct.getQuotes(symbols);
          return { data: symbols.map((s) => map.get(s)).filter(Boolean), missing: symbols.filter((s) => !map.has(s)) };
        })
      : request(`api/quotes?${q({ symbols: symbols.join(',') })}`),

  search: (text, opts = {}) =>
    direct ? viaDirect(async () => ({ data: await direct.search(text) }), opts.signal) : request(`api/search?${q({ q: text })}`, opts),

  minute: (symbol, days = 1, opts = {}) =>
    direct
      ? viaDirect(() => direct.getMinute(symbol, { days }), opts.signal)
      : request(`api/minute/${encodeURIComponent(symbol)}?${q({ days })}`, opts),

  kline: (symbol, { period, adjust, count = 500 }, opts = {}) =>
    direct
      ? viaDirect(() => direct.getKline(symbol, { period, adjust, count }), opts.signal)
      : request(`api/kline/${encodeURIComponent(symbol)}?${q({ period, adjust, count })}`, opts),

  ticks: (symbol, limit = 60, opts = {}) =>
    direct
      ? viaDirect(() => direct.getTicks(symbol, { limit }), opts.signal)
      : request(`api/ticks/${encodeURIComponent(symbol)}?${q({ limit })}`, opts),

  /** 某个市场的活跃股列表 → { market, items: [{symbol, name}] }；静态模式下美股不可用（抛出错误） */
  activeStocks: (market, opts = {}) =>
    direct
      ? viaDirect(async () => ({ market, items: await direct.getActiveStocks(market) }), opts.signal)
      : request(`api/active-stocks?${q({ market })}`, opts),

  rank: (params, opts = {}) =>
    direct ? viaDirect(() => direct.getRank(params), opts.signal) : request(`api/rank?${q(params)}`, opts),
};
