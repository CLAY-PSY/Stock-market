// 行情轮询不能被挂住的请求卡死：手机切后台 / 锁屏后个别请求可能既不成功也不失败，之前会让行情永远停住，只有刷新页面才恢复
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { TTLCache } from '../shared/cache.js';
import { withDeadline } from '../shared/deadline.js';

// 浏览器代码按网站路径引用 ../../shared/（服务端把仓库里的 shared/ 挂在 /shared），在 Node 里映射回仓库目录
register(
  'data:text/javascript,' +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (context.parentURL && context.parentURL.includes('/public/js/') && specifier.includes('/shared/')) {
          return next(new URL(specifier, context.parentURL).href.replace('/public/shared/', '/shared/'), context);
        }
        return next(specifier, context);
      }
    `),
);
const { LocalRealtime } = await import('../public/js/data/local-hub.js');

const OPEN = { cn: { open: true, text: '交易中' }, hk: { open: true, text: '交易中' }, us: { open: true, text: '交易中' } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const never = () => new Promise(() => {});

/** 假数据源：可以让第一次报价请求挂住，或者延迟返回一个旧价格 */
function fakeProvider({ first } = {}) {
  let calls = 0;
  let price = 100;
  const quote = (symbol, p) => ({ symbol, price: p, volume: p, time: `2026-11-10 10:00:${String(p % 60).padStart(2, '0')}`, bids: [], asks: [] });
  return {
    name: 'fake',
    label: 'fake',
    get calls() {
      return calls;
    },
    async getQuotes(symbols) {
      calls += 1;
      if (calls === 1 && first === 'hang') return never();
      if (calls === 1 && first === 'late') {
        await wait(250);
        return new Map(symbols.map((s) => [s, quote(s, 1)]));
      }
      price += 1;
      return new Map(symbols.map((s) => [s, quote(s, price)]));
    },
    async getMarketStatus() {
      return OPEN;
    },
  };
}

function start(provider, opts = {}) {
  const rt = new LocalRealtime(provider, { interval: 20, idleInterval: 50, marketInterval: 5_000, requestDeadline: 150, watchdog: 50, ...opts });
  const got = [];
  rt.on('quotes', (m) => got.push(...m.data));
  rt.setSymbols(['sh600519']);
  rt.connect();
  return { rt, got };
}

test('报价请求挂住时，到截止时间放弃它，轮询继续拉到新价格', async () => {
  const { rt, got } = start(fakeProvider({ first: 'hang' }));
  try {
    await wait(700);
    assert.ok(got.length >= 3, `挂住之后应继续收到报价，实际 ${got.length} 次`);
    assert.ok(got.at(-1).price > got[0].price, '价格在持续更新');
  } finally {
    rt.close();
  }
});

test('切回前台（reconnectNow）时立即放弃挂住的一轮，不用等截止时间', async () => {
  const { rt, got } = start(fakeProvider({ first: 'hang' }), { requestDeadline: 60_000, watchdog: 60_000 });
  try {
    await wait(60);
    assert.equal(got.length, 0, '第一轮挂住，还没有报价');
    rt.reconnectNow();
    await wait(150);
    assert.ok(got.length >= 1, `切回前台后马上拉到报价，实际 ${got.length} 次`);
  } finally {
    rt.close();
  }
});

test('请求刚发出就挂住、紧接着切回前台：同样马上重新请求', async () => {
  const { rt, got } = start(fakeProvider({ first: 'hang' }), { interval: 3000, requestDeadline: 60_000, watchdog: 60_000 });
  try {
    await wait(30); // 挂住的请求才发出 30 毫秒，远小于轮询间隔
    rt.reconnectNow();
    await wait(150);
    assert.ok(got.length >= 1, `切回前台后马上拉到报价，实际 ${got.length} 次`);
  } finally {
    rt.close();
  }
});

test('被放弃的请求迟到返回时，旧价格不覆盖已经显示的新价格', async () => {
  const { rt, got } = start(fakeProvider({ first: 'late' }), { requestDeadline: 60_000, watchdog: 60_000 });
  try {
    await wait(40);
    rt.reconnectNow(); // 放弃第一轮（250ms 后才返回旧价格 1）
    await wait(500);
    assert.ok(got.length >= 2);
    assert.ok(!got.some((q) => q.price === 1), '迟到的旧价格被丢弃');
  } finally {
    rt.close();
  }
});

test('看门狗：排好的下一轮计时器丢了（手机挂起页面后可能发生）时自动重启轮询', async () => {
  const { rt, got } = start(fakeProvider(), { interval: 20, idleInterval: 40, requestDeadline: 60, watchdog: 30 });
  try {
    await wait(150);
    assert.ok(got.length >= 2, '先正常轮询');
    // 模拟计时器丢失：取消已经排好的下一轮，并让轮询以为一直没有完成过
    clearTimeout(rt.timer);
    rt.schedule = function lostOnce(delay) {
      rt.schedule = LocalRealtime.prototype.schedule; // 只丢这一次
      void delay;
    };
    const before = got.length;
    await wait(1500); // 看门狗在「两轮最长间隔 × 2」（这里约 0.76 秒）后介入
    assert.ok(got.length > before + 2, `看门狗让轮询恢复，之后又收到 ${got.length - before} 次报价`);
  } finally {
    rt.close();
  }
});

test('请求合并缓存：挂住太久的请求不再被后来的调用复用；它迟到的旧结果也不覆盖新结果', async () => {
  const cache = new TTLCache({ inflightMaxMs: 50 });
  let resolveOld;
  const first = cache.wrap('marketStat', 10_000, () => new Promise((r) => (resolveOld = r)));
  await wait(80);
  const second = await withDeadline(cache.wrap('marketStat', 10_000, async () => 'new'), 500);
  assert.equal(second, 'new', '后来的调用重新请求，而不是一直等挂住的那个');
  resolveOld('old');
  assert.equal(await first, 'old');
  assert.equal(cache.get('marketStat'), 'new', '迟到的旧结果不覆盖新结果');
});

test('请求合并缓存：正常情况下同一时间的请求仍然合并', async () => {
  const cache = new TTLCache();
  let n = 0;
  const loader = async () => {
    n += 1;
    await wait(20);
    return n;
  };
  const [a, b] = await Promise.all([cache.wrap('k', 1000, loader), cache.wrap('k', 1000, loader)]);
  assert.equal(n, 1);
  assert.equal(a, b);
});

test('withDeadline：到点没结果就按超时失败，正常结果原样返回', async () => {
  await assert.rejects(withDeadline(never(), 30), /超时/);
  assert.equal(await withDeadline(Promise.resolve(7), 30), 7);
});

/* ---------------------------------- 页面切走 / 离开（往返缓存）期间没返回的请求 */

/** 第一次报价请求由测试手动结束（模拟页面切走时它还没返回） */
function controlledProvider() {
  let calls = 0;
  let price = 100;
  const pending = {};
  pending.promise = new Promise((resolve, reject) => Object.assign(pending, { resolve, reject }));
  const quotes = (symbols, p) => new Map(symbols.map((s) => [s, { symbol: s, price: p, volume: p, time: `2026-11-10 10:00:${String(p % 60).padStart(2, '0')}`, bids: [], asks: [] }]));
  return {
    name: 'fake',
    label: 'fake',
    pending,
    quotes,
    async getQuotes(symbols) {
      calls += 1;
      if (calls === 1) return pending.promise.then(() => quotes(symbols, 1));
      price += 1;
      return quotes(symbols, price);
    },
    async getMarketStatus() {
      return OPEN;
    },
  };
}

test('页面切走时还没返回的请求：回来后才返回，不把停住的时间当成延迟显示', async () => {
  const p = controlledProvider();
  const rt = new LocalRealtime(p, { interval: 20, idleInterval: 50, marketInterval: 5_000, requestDeadline: 60_000, watchdog: 60_000 });
  const latencies = [];
  rt.on('latency', (ms) => latencies.push(ms));
  rt.setSymbols(['sh600519']);
  rt.connect();
  try {
    await wait(20);
    rt.suspend(); // 页面切走 / 进入往返缓存
    await wait(250); // 页面停住了一段时间
    p.pending.resolve(); // 回来后，那个请求才返回
    await wait(10);
    assert.ok(latencies.every((ms) => ms < 200), `不应出现包含停住时间的延迟，实际 ${latencies.join(', ')}`);
    rt.reconnectNow();
    await wait(120);
    assert.ok(latencies.length >= 1 && latencies.every((ms) => ms < 200), `回来后的新请求正常测出延迟：${latencies.join(', ')}`);
  } finally {
    rt.close();
  }
});

test('页面切走时还没返回的请求失败了（浏览器离开页面时取消）：状态不变成「重连中」，也不提示数据源不可用', async () => {
  const p = controlledProvider();
  const rt = new LocalRealtime(p, { interval: 20, idleInterval: 50, marketInterval: 5_000, requestDeadline: 60_000, watchdog: 60_000 });
  const states = [];
  const upstream = [];
  rt.on('state', (s) => states.push(s.state));
  rt.on('upstream', (m) => upstream.push(m.ok));
  rt.setSymbols(['sh600519']);
  rt.connect();
  try {
    await wait(20);
    rt.suspend();
    p.pending.reject(new Error('Load failed'));
    await wait(10);
    assert.ok(!states.includes('reconnecting'), `状态：${states.join(' → ')}`);
    assert.deepEqual(upstream, [], '没有「数据源不可用」提示');
    rt.reconnectNow();
    await wait(120);
    assert.equal(rt.state, 'open');
  } finally {
    rt.close();
  }
});

test('返回上一页时 pageshow 和 visibilitychange 接连触发：只重新请求一次', async () => {
  let calls = 0;
  const provider = {
    name: 'fake',
    label: 'fake',
    async getQuotes(symbols) {
      calls += 1;
      await wait(30);
      return new Map(symbols.map((s) => [s, { symbol: s, price: calls, volume: calls, time: `t${calls}`, bids: [], asks: [] }]));
    },
    async getMarketStatus() {
      return OPEN;
    },
  };
  const rt = new LocalRealtime(provider, { interval: 1000, idleInterval: 1000, marketInterval: 5_000, requestDeadline: 60_000, watchdog: 60_000 });
  rt.setSymbols(['sh600519']);
  rt.connect();
  try {
    await wait(80); // 第一轮结束，下一轮要 1 秒后
    const before = calls;
    rt.suspend();
    rt.lastFetch.clear(); // 离开了很久，回来时数据已经过期
    rt.reconnectNow(); // pageshow
    await wait(5);
    rt.reconnectNow(); // visibilitychange
    await wait(80);
    assert.equal(calls - before, 1, `只应重新请求一次，实际 ${calls - before} 次`);
  } finally {
    rt.close();
  }
});
