// 使用离线模拟数据源启动完整服务，验证 REST 接口与 WebSocket 推送协议（不依赖外网）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { QuoteHub } from '../server/realtime.js';
import { mockProvider } from '../server/providers/mock.js';

const config = {
  quoteIntervalMs: 200,
  idleQuoteIntervalMs: 2000,
  marketStatusIntervalMs: 60_000,
  maxSubscriptions: 50,
  heartbeatMs: 60_000,
};

let server;
let hub;
let base;

before(async () => {
  hub = new QuoteHub({ provider: mockProvider, config });
  server = http.createServer(createApp({ provider: mockProvider, hub }));
  hub.attach(server).start();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `127.0.0.1:${server.address().port}`;
});

after(async () => {
  hub.stop();
  await new Promise((resolve) => server.close(resolve));
});

const get = async (path) => {
  const res = await fetch(`http://${base}${path}`);
  return { status: res.status, body: await res.json(), headers: res.headers };
};

test('GET /api/health', async () => {
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.provider, 'mock');
});

test('GET /api/quotes 规范化代码并返回报价', async () => {
  const { status, body, headers } = await get('/api/quotes?symbols=600519,700,aapl');
  assert.equal(status, 200);
  assert.deepEqual(
    body.data.map((q) => q.symbol),
    ['sh600519', 'hk00700', 'usAAPL'],
  );
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.match(headers.get('content-security-policy'), /default-src 'self'/);
});

test('参数校验与错误码', async () => {
  assert.equal((await get('/api/quotes')).status, 400);
  assert.equal((await get('/api/kline/<bad>')).status, 400);
  assert.equal((await get('/api/kline/hk00700?period=m5')).status, 422, '港股分钟 K 不支持');
  assert.equal((await get('/api/kline/sh600519?period=year')).status, 422);
  assert.equal((await get('/api/ticks/usAAPL')).status, 422);
  assert.equal((await get('/api/does-not-exist')).status, 404);
});

test('K 线 / 分时 / 排行 / 搜索', async () => {
  const k = await get('/api/kline/sh600519?period=day&count=50');
  assert.equal(k.status, 200);
  assert.equal(k.body.bars.length, 50);
  const bar = k.body.bars.at(-1);
  assert.ok(bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close));

  const m = await get('/api/minute/sh600519?days=5');
  assert.equal(m.body.sessions.length, 5);

  const r = await get('/api/rank?sort=changePct&order=desc&count=5');
  const pcts = r.body.items.map((i) => i.changePct);
  assert.deepEqual(pcts, [...pcts].sort((a, b) => b - a));

  const s = await get('/api/search?q=茅台');
  assert.equal(s.body.data[0].symbol, 'sh600519');
});

test('页面与图表库静态资源', async () => {
  const page = await fetch(`http://${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /StockPulse/);
  // 服务端返回的页面固定为 server 模式，不会回落到被 CSP 拦截的直连模式
  assert.match(html, /<meta name="stockpulse-mode" content="server" \/>/);
  for (const path of ['/index.html', '/some/deep/link']) {
    const res = await fetch(`http://${base}${path}`, { headers: { Accept: 'text/html' } });
    assert.match(await res.text(), /content="server"/, path);
  }
  const shared = await fetch(`http://${base}/shared/tencent.js`);
  assert.equal(shared.status, 200);
  const lib = await fetch(`http://${base}/vendor/lightweight-charts.mjs`);
  assert.equal(lib.status, 200);
  assert.match(lib.headers.get('content-type'), /javascript/);
});

function connect() {
  const ws = new WebSocket(`ws://${base}/ws`);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  const next = (pred, timeout = 3000) =>
    new Promise((resolve, reject) => {
      const i = queue.findIndex(pred);
      if (i >= 0) return resolve(queue.splice(i, 1)[0]);
      const timer = setTimeout(() => reject(new Error('等待消息超时')), timeout);
      waiters.push({ pred, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  return { ws, next, opened: new Promise((r) => ws.once('open', r)) };
}

test('WebSocket：hello → 订阅快照 → 持续推送 → 心跳', async () => {
  const c = connect();
  await c.opened;
  const hello = await c.next((m) => m.type === 'hello');
  assert.equal(hello.provider, 'mock');

  c.ws.send(JSON.stringify({ type: 'set', symbols: ['600519', 'usAAPL', 'not a symbol'] }));
  const snap = await c.next((m) => m.type === 'quotes' && m.snapshot);
  assert.deepEqual(new Set(snap.data.map((q) => q.symbol)), new Set(['sh600519', 'usAAPL']));

  const update = await c.next((m) => m.type === 'quotes' && !m.snapshot);
  assert.ok(update.data.every((q) => ['sh600519', 'usAAPL'].includes(q.symbol)), '只推送已订阅的代码');

  c.ws.send(JSON.stringify({ type: 'ping', t: 123 }));
  const pong = await c.next((m) => m.type === 'pong');
  assert.equal(pong.t, 123);

  c.ws.send('not json');
  assert.equal((await c.next((m) => m.type === 'error')).type, 'error');

  assert.equal(hub.snapshotStats().symbols, 2);
  c.ws.close();
  await new Promise((r) => c.ws.once('close', r));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hub.snapshotStats().symbols, 0, '断开后释放订阅');
});

test('WebSocket：多个客户端共享订阅计数', async () => {
  const a = connect();
  const b = connect();
  await Promise.all([a.opened, b.opened]);
  a.ws.send(JSON.stringify({ type: 'subscribe', symbols: ['sz300750'] }));
  b.ws.send(JSON.stringify({ type: 'subscribe', symbols: ['sz300750', 'hk00700'] }));
  await a.next((m) => m.type === 'quotes');
  await b.next((m) => m.type === 'quotes');
  assert.equal(hub.refs.get('sz300750'), 2);
  b.ws.send(JSON.stringify({ type: 'unsubscribe', symbols: ['sz300750'] }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hub.refs.get('sz300750'), 1);
  a.ws.close();
  b.ws.close();
});
