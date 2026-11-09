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
