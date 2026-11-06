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
  // 全部客户端合计订阅的不同代码数上限，防止被恶意客户端放大成对上游的海量请求
  maxTotalSymbols: int(process.env.MAX_TOTAL_SYMBOLS, 3000, 100, 50_000),
  // 同一 IP 同时保持的 WebSocket 连接数上限
  maxConnectionsPerIp: int(process.env.MAX_CONNECTIONS_PER_IP, 20, 1, 1000),
  // 允许跨域连接 WebSocket 的页面来源（逗号分隔，例如 https://a.example.com）。同源页面始终允许
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  heartbeatMs: 30_000,
});
