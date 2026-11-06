import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import express from 'express';
import { normalizeSymbol, parseSymbolList } from '../shared/symbols.js';
import { UpstreamError } from '../shared/errors.js';
import { logger } from './lib/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(here, '../public');
const SHARED_DIR = path.resolve(here, '../shared'); // 服务端与浏览器共用的模块
const MODE_META_AUTO = '<meta name="stockpulse-mode" content="auto" />';
const MODE_META_SERVER = '<meta name="stockpulse-mode" content="server" />';
const require = createRequire(import.meta.url);
const CHARTS_FILE = path.join(
  path.dirname(require.resolve('lightweight-charts/package.json')),
  'dist/lightweight-charts.standalone.production.mjs',
);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'BadRequestError';
    this.status = status;
  }
}

function requireSymbol(raw) {
  const symbol = normalizeSymbol(String(raw ?? ''));
  if (!symbol) throw new HttpError(400, `无法识别的代码：${raw}`);
  return symbol;
}

const intParam = (v, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** 极简的每 IP 滑动窗口限流，防止脚本误用把上游打爆 */
function rateLimit({ windowMs = 10_000, max = 300 } = {}) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, entry] of hits) if (entry.start < cutoff) hits.delete(ip);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    let entry = hits.get(ip);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      hits.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.start + windowMs - now) / 1000));
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    return next();
  };
}

export function createApp({ provider, hub }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.set('json spaces', 0);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
      ].join('; '),
    );
    next();
  });

  const api = express.Router();
  api.use(rateLimit());
  api.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  api.get('/health', (req, res) => {
    res.json({ ok: true, provider: provider.name, providerLabel: provider.label, ...hub.snapshotStats() });
  });

  api.get('/market-status', async (req, res) => {
    res.json(await provider.getMarketStatus());
  });

  api.get('/quotes', async (req, res) => {
    const symbols = parseSymbolList(req.query.symbols, 200);
    if (!symbols.length) throw new HttpError(400, '请通过 symbols 参数提供至少一个代码');
    const quotes = await provider.getQuotes(symbols);
    res.json({
      data: symbols.map((s) => quotes.get(s)).filter(Boolean),
      missing: symbols.filter((s) => !quotes.has(s)),
    });
  });

  api.get('/quote/:symbol', async (req, res) => {
    res.json(await provider.getQuote(requireSymbol(req.params.symbol)));
  });

  api.get('/search', async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    if (!q) return res.json({ data: [] });
    return res.json({ data: await provider.search(q) });
  });

  api.get('/minute/:symbol', async (req, res) => {
    const days = intParam(req.query.days, 1) > 1 ? 5 : 1;
    res.json(await provider.getMinute(requireSymbol(req.params.symbol), { days }));
  });

  api.get('/kline/:symbol', async (req, res) => {
    const symbol = requireSymbol(req.params.symbol);
    const period = String(req.query.period ?? 'day');
    const adjust = req.query.adjust === undefined ? 'qfq' : String(req.query.adjust);
    const count = intParam(req.query.count, 320);
    res.json(await provider.getKline(symbol, { period, adjust, count }));
  });

  api.get('/ticks/:symbol', async (req, res) => {
    const symbol = requireSymbol(req.params.symbol);
    res.json(await provider.getTicks(symbol, { limit: intParam(req.query.limit, 60) }));
  });

  // 某个市场当前的活跃股（按成交额），前端据此给新访客随机挑选默认自选
  api.get('/active-stocks', async (req, res) => {
    const market = String(req.query.market ?? '');
    if (!['cn', 'hk', 'us'].includes(market)) throw new HttpError(400, 'market 只能是 cn / hk / us');
    res.json({ market, items: await provider.getActiveStocks(market) });
  });

  api.get('/rank', async (req, res) => {
    const { board = 'all', sort = 'changePct', order = 'desc' } = req.query;
    res.json(
      await provider.getRank({
        board: String(board),
        sort: String(sort),
        order: order === 'asc' ? 'asc' : 'desc',
        offset: intParam(req.query.offset, 0),
        count: intParam(req.query.count, 20),
      }),
    );
  });

  api.use((req, res) => res.status(404).json({ error: `接口不存在：${req.method} ${req.originalUrl}` }));

  app.use('/api', api);

  app.get('/vendor/lightweight-charts.mjs', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('application/javascript').sendFile(CHARTS_FILE);
  });

  app.use('/shared', express.static(SHARED_DIR, { etag: true, maxAge: '5m' }));

  // 首页由服务端改写运行模式为 server：页面不会再探测或回落到浏览器直连模式，
  // 否则直连请求会被上面的 CSP（connect-src / script-src 'self'）拦截
  const sendIndex = async (req, res) => {
    const html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html.replace(MODE_META_AUTO, MODE_META_SERVER));
  };
  app.get(['/', '/index.html'], sendIndex);

  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      etag: true,
      setHeaders(res, filePath) {
        // HTML 始终回源校验，静态资源允许短期缓存（ETag 负责更新）
        res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=300');
      },
    }),
  );

  // 未匹配的页面路由回落到首页（前端用 hash 路由，这里只是兜底）。
  // 带扩展名的路径是缺失的静态资源，返回 404，而不是用 200 的 HTML 冒充脚本 / 样式
  app.use((req, res, next) => {
    if (req.method !== 'GET' || path.extname(req.path) || req.accepts(['html', 'json']) !== 'html') return next();
    return sendIndex(req, res);
  });
  app.use((req, res) => res.status(404).type('text/plain').send('Not Found'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 502;
    // 4xx 与上游错误的提示是给用户看的；其它服务端异常只记录日志，不把内部细节返回给客户端
    const expose = status < 500 || err instanceof UpstreamError;
    if (status >= 500) logger.warn(`${req.method} ${req.originalUrl} -> ${status}: ${err.stack || err.message}`);
    res.status(status).json({
      error: expose ? err.message || '请求失败' : '服务器内部错误',
      code: expose ? err.name : 'InternalError',
    });
  });

  return app;
}
