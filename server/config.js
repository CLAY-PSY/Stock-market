// 若项目根目录存在 .env 则加载（已存在的环境变量优先）
try {
  process.loadEnvFile?.();
} catch {
  /* 没有 .env 文件 */
}

const int = (value, fallback, min = -Infinity, max = Infinity) => {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export const config = Object.freeze({
  port: int(process.env.PORT, 3000, 1, 65535),
  host: process.env.HOST || '0.0.0.0',
  provider: (process.env.DATA_PROVIDER || 'tencent').toLowerCase(),
  quoteIntervalMs: int(process.env.QUOTE_INTERVAL_MS, 2000, 500, 60_000),
  idleQuoteIntervalMs: int(process.env.IDLE_QUOTE_INTERVAL_MS, 30_000, 2_000, 600_000),
  marketStatusIntervalMs: 20_000,
  upstreamTimeoutMs: int(process.env.UPSTREAM_TIMEOUT_MS, 8000, 1000, 60_000),
  maxSubscriptions: int(process.env.MAX_SUBSCRIPTIONS, 300, 10, 5000),
  heartbeatMs: 30_000,
});
