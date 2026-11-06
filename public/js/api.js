export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
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

const q = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null)).toString();

export const api = {
  health: () => request('/api/health'),
  marketStatus: () => request('/api/market-status'),
  quotes: (symbols) => request(`/api/quotes?${q({ symbols: symbols.join(',') })}`),
  search: (text, opts) => request(`/api/search?${q({ q: text })}`, opts),
  minute: (symbol, days = 1, opts) => request(`/api/minute/${encodeURIComponent(symbol)}?${q({ days })}`, opts),
  kline: (symbol, { period, adjust, count = 500 }, opts) =>
    request(`/api/kline/${encodeURIComponent(symbol)}?${q({ period, adjust, count })}`, opts),
  ticks: (symbol, limit = 60, opts) => request(`/api/ticks/${encodeURIComponent(symbol)}?${q({ limit })}`, opts),
  rank: (params, opts) => request(`/api/rank?${q(params)}`, opts),
};
