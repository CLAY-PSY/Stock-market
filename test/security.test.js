// 安全与防滥用：WebSocket 来源校验、连接数 / 消息频率 / 订阅总数限制，错误信息不外泄，响应头
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../server/app.js';
import { QuoteHub, clientIp, isAllowedOrigin } from '../server/realtime.js';
import { mockProvider } from '../server/providers/mock.js';

const config = {
  quoteIntervalMs: 200,
  idleQuoteIntervalMs: 2000,
  marketStatusIntervalMs: 60_000,
  maxSubscriptions: 50,
  maxTotalSymbols: 6,
  maxConnectionsPerIp: 3,
  allowedOrigins: ['https://trusted.example'],
  heartbeatMs: 60_000,
};

// 在模拟数据源基础上制造一个内部异常（例如代码缺陷导致的 TypeError）
const provider = {
  ...mockProvider,
  async getTicks() {
    throw new TypeError("Cannot read properties of undefined (reading 'secret/internal/path')");
  },
};

let server;
let hub;
let base;

before(async () => {
  hub = new QuoteHub({ provider, config });
  server = http.createServer(createApp({ provider, hub }));
  hub.attach(server).start();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `127.0.0.1:${server.address().port}`;
});

after(async () => {
  hub.stop();
  await new Promise((resolve) => server.close(resolve));
});

/** 打开连接；被拒绝时返回 HTTP 状态码 */
const open = (headers = {}) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://${base}/ws`, { headers });
    ws.once('open', () => resolve({ ws }));
    ws.once('unexpected-response', (req, res) => resolve({ status: res.statusCode }));
    ws.once('error', () => {});
  });

const closeAll = async (list) => {
  await Promise.all(
    list.map(
      (ws) =>
        new Promise((r) => {
          if (ws.readyState === WebSocket.CLOSED) return r();
          ws.once('close', r);
          ws.close();
        }),
    ),
  );
  await new Promise((r) => setTimeout(r, 30));
};

test('同源判断与客户端 IP', () => {
  const req = (headers, remoteAddress = '203.0.113.9') => ({ headers, socket: { remoteAddress } });
  assert.equal(isAllowedOrigin(req({ host: 'a.com' })), true, '无 Origin（非浏览器）放行');
  assert.equal(isAllowedOrigin(req({ host: 'a.com', origin: 'https://a.com' })), true);
  assert.equal(isAllowedOrigin(req({ host: 'a.com', origin: 'https://evil.com' })), false);
  assert.equal(isAllowedOrigin(req({ host: 'a.com', origin: 'null' })), false);
  assert.equal(isAllowedOrigin(req({ host: 'a.com', origin: 'https://b.com' }), ['https://b.com']), true);
  // 本机反向代理转发时看 X-Forwarded-Host；外部直连时伪造的转发头无效
  assert.equal(isAllowedOrigin(req({ host: '127.0.0.1:3000', 'x-forwarded-host': 'a.com', origin: 'https://a.com' }, '127.0.0.1')), true);
  assert.equal(isAllowedOrigin(req({ host: 'evil.com', 'x-forwarded-host': 'a.com', origin: 'https://a.com' })), false);
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, '127.0.0.1')), '2.2.2.2');
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.1.1.1' })), '203.0.113.9', '非代理来源忽略转发头');
});

test('WebSocket：拒绝跨站页面的连接，允许同源与白名单', async () => {
  assert.equal((await open({ Origin: 'https://evil.example' })).status, 403);
  const same = await open({ Origin: `http://${base}` });
  const trusted = await open({ Origin: 'https://trusted.example' });
  assert.ok(same.ws && trusted.ws);
  await closeAll([same.ws, trusted.ws]);
});

test('WebSocket：限制同一 IP 的连接数', async () => {
  const conns = [];
  for (let i = 0; i < 3; i += 1) conns.push((await open()).ws);
  assert.ok(conns.every(Boolean));
  assert.equal((await open()).status, 429);
  await closeAll(conns);
  const again = await open();
  assert.ok(again.ws, '断开后名额释放');
  await closeAll([again.ws]);
});

test('WebSocket：消息洪泛被限速并断开，ping 只回显数字', async () => {
  const { ws } = await open();
  const msgs = [];
  ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
  ws.send(JSON.stringify({ type: 'ping', t: 'x'.repeat(1000) }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(msgs.find((m) => m.type === 'pong').t, null);
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));
  for (let i = 0; i < 200; i += 1) ws.send(JSON.stringify({ type: 'ping', t: i }));
  assert.equal(await closed, 1008);
  assert.ok(msgs.some((m) => m.type === 'error' && /频繁/.test(m.message)));
  assert.ok(msgs.filter((m) => m.type === 'pong').length <= 45, '超出突发额度的消息被丢弃');
});

test('WebSocket：全局订阅总数有上限，新订阅合并成批拉取', async () => {
  const { ws } = await open();
  const msgs = [];
  ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
  const polls = hub.stats.polls;
  // 连续 4 条订阅消息：逐条拉取会打 4 次上游，合并后只需 1 次（另加可能赶上的 1 次常规轮询）
  for (const sym of ['sh600519', 'sz300750', 'hk00700', 'usAAPL']) ws.send(JSON.stringify({ type: 'subscribe', symbols: [sym] }));
  await new Promise((r) => setTimeout(r, 150));
  // 新订阅的报价要么来自合并后的即时拉取（snapshot），要么来自常规轮询，客户端都能收到
  const received = new Set(msgs.filter((m) => m.type === 'quotes').flatMap((m) => m.data.map((q) => q.symbol)));
  assert.deepEqual(received, new Set(['sh600519', 'sz300750', 'hk00700', 'usAAPL']));
  assert.ok(hub.stats.polls - polls <= 2, `两条订阅消息合并成一次拉取（实际 ${hub.stats.polls - polls} 次）`);

  ws.send(JSON.stringify({ type: 'subscribe', symbols: ['usNVDA', 'usTSLA', 'usMSFT', 'sh601318'] }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hub.refs.size, 6, '超出上限的新代码不再加入');
  assert.ok(msgs.some((m) => m.type === 'error' && /上限/.test(m.message)));
  await closeAll([ws]);
  assert.equal(hub.refs.size, 0);
  assert.equal(hub.lastFetch.size, 0, '取消订阅后不残留拉取记录');
});

test('REST：内部异常不向客户端泄露细节，原型链上的参数不被接受', async () => {
  const res = await fetch(`http://${base}/api/ticks/sh600519`);
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error, '服务器内部错误');
  assert.doesNotMatch(JSON.stringify(body), /secret|TypeError/);

  for (const q of ['sort=constructor', 'sort=__proto__', 'board=constructor', 'board=toString']) {
    const r = await fetch(`http://${base}/api/rank?${q}`);
    assert.equal(r.status, 422, q);
  }
});

test('REST：缺失的静态资源返回 404，安全响应头齐全', async () => {
  const missing = await fetch(`http://${base}/js/does-not-exist.js`);
  assert.equal(missing.status, 404);
  assert.doesNotMatch(missing.headers.get('content-type'), /html/);
  const page = await fetch(`http://${base}/`);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.ok(page.headers.get('permissions-policy'));
});
