import { config } from '../config.js';

export class UpstreamError extends Error {
  constructor(message, { status, url, cause } = {}) {
    super(message, { cause });
    this.name = 'UpstreamError';
    this.status = status;
    this.url = url;
  }
}

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Referer: 'https://gu.qq.com/',
  Accept: '*/*',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 请求上游并按指定编码解码为文本。腾讯行情接口返回 GBK 编码，需要显式解码。
 * 网络错误和 5xx 会自动重试。
 */
export async function fetchText(url, { encoding = 'utf-8', timeoutMs = config.upstreamTimeoutMs, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: DEFAULT_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new UpstreamError(`上游返回 HTTP ${res.status}`, { status: res.status, url });
      }
      const buf = await res.arrayBuffer();
      return new TextDecoder(encoding).decode(buf);
    } catch (err) {
      lastError = err instanceof UpstreamError ? err : new UpstreamError(describe(err), { url, cause: err });
      const retryable = !(err instanceof UpstreamError) || (err.status ?? 0) >= 500;
      if (!retryable || attempt === retries) break;
      await sleep(250 * (attempt + 1));
    }
  }
  throw lastError;
}

export async function fetchJson(url, options) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UpstreamError('上游返回的数据不是合法 JSON', { url, cause: err });
  }
}

function describe(err) {
  if (err?.name === 'TimeoutError') return '上游请求超时';
  const code = err?.cause?.code || err?.code;
  return code ? `上游网络错误 (${code})` : `上游请求失败: ${err?.message || err}`;
}
