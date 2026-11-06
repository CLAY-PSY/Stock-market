// 默认自选：优先从实时活跃股中随机挑选，取不到的市场使用备用股票池
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDefaultWatchlist, WATCHLIST_POOL, PICK_COUNT } from '../public/js/default-watchlist.js';
import { normalizeSymbol, marketOf } from '../shared/symbols.js';

/** 可复现的伪随机数 */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 模拟实时活跃股列表 */
const live = {
  cn: Array.from({ length: 1000 }, (_, i) => ({ symbol: `sz${String(300000 + i)}`, name: `A股${i}` })),
  hk: Array.from({ length: 300 }, (_, i) => ({ symbol: `hk${String(1000 + i).padStart(5, '0')}`, name: `港股${i}` })),
  us: Array.from({ length: 200 }, (_, i) => ({ symbol: `usT${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`, name: `美股${i}` })),
};

test('备用股票池里的代码都是规范的内部代码，且不重复', () => {
  const all = Object.values(WATCHLIST_POOL).flat().map(([s]) => s);
  assert.equal(new Set(all).size, all.length);
  for (const s of all) assert.equal(normalizeSymbol(s), s, s);
  for (const [market, list] of Object.entries(WATCHLIST_POOL)) {
    assert.ok(list.length >= PICK_COUNT[market] * 3, `${market} 备用池的候选要明显多于挑选数量`);
    assert.ok(list.every(([s]) => marketOf(s) === market), `${market} 备用池混入了其它市场`);
  }
});

test('有实时数据时从实时活跃股中挑选：20 只、不重复、按 A 股 → 港股 → 美股排列', () => {
  const { symbols, names, sources } = pickDefaultWatchlist(live, seeded(1));
  assert.deepEqual(sources, { cn: 'live', hk: 'live', us: 'live' });
  assert.equal(symbols.length, 20);
  assert.equal(new Set(symbols).size, 20);
  assert.deepEqual(symbols.map(marketOf), [...Array(10).fill('cn'), ...Array(5).fill('hk'), ...Array(5).fill('us')]);
  const liveSet = new Set(Object.values(live).flat().map((c) => c.symbol));
  assert.ok(symbols.every((s) => liveSet.has(s)), '全部来自实时列表');
  for (const s of symbols) assert.match(names[s], /^(A股|港股|美股)\d+$/);
});

test('某个市场取不到或数量太少时，只有这个市场改用备用股票池', () => {
  const { symbols, sources } = pickDefaultWatchlist({ cn: live.cn, hk: live.hk.slice(0, 4), us: null }, seeded(2));
  assert.deepEqual(sources, { cn: 'live', hk: 'pool', us: 'pool' });
  const pool = new Set(Object.values(WATCHLIST_POOL).flat().map(([s]) => s));
  assert.ok(symbols.filter((s) => marketOf(s) !== 'cn').every((s) => pool.has(s)));
  assert.equal(symbols.length, 20);

  const offline = pickDefaultWatchlist({}, seeded(3));
  assert.deepEqual(offline.sources, { cn: 'pool', hk: 'pool', us: 'pool' });
  assert.equal(offline.symbols.length, 20, '全部取不到时也能给出完整的默认自选');
});

test('不同的随机数得到不同的组合；同一随机序列结果相同', () => {
  const combos = new Set();
  for (let i = 0; i < 200; i += 1) combos.add(pickDefaultWatchlist(live, seeded(i + 7)).symbols.join(','));
  assert.equal(combos.size, 200);
  assert.deepEqual(pickDefaultWatchlist(live, seeded(42)), pickDefaultWatchlist(live, seeded(42)));
});

test('忽略格式不对的候选项', () => {
  const messy = { cn: [...live.cn.slice(0, 30), null, { symbol: 1 }, 'x'], hk: live.hk, us: live.us };
  const { symbols } = pickDefaultWatchlist(messy, seeded(5));
  assert.ok(symbols.every((s) => typeof s === 'string'));
});
