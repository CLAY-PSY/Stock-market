// 默认自选：首次打开从热门股票池随机挑选
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

test('股票池里的代码都是规范的内部代码，且不重复', () => {
  const all = Object.values(WATCHLIST_POOL).flat().map(([s]) => s);
  assert.equal(new Set(all).size, all.length);
  for (const s of all) assert.equal(normalizeSymbol(s), s, s);
  for (const [group, list] of Object.entries(WATCHLIST_POOL)) {
    assert.ok(list.length > PICK_COUNT[group], `${group} 组的候选要多于挑选数量，才谈得上随机`);
  }
});

test('每次挑出 13 只、不重复，按 A 股 → ETF → 港股 → 美股排列，并带上名称', () => {
  const { symbols, names } = pickDefaultWatchlist(seeded(1));
  assert.equal(symbols.length, 13);
  assert.equal(new Set(symbols).size, 13);
  assert.deepEqual(
    symbols.map(marketOf),
    ['cn', 'cn', 'cn', 'cn', 'cn', 'cn', 'hk', 'hk', 'hk', 'us', 'us', 'us', 'us'],
  );
  for (const s of symbols) assert.ok(names[s], `${s} 缺少名称`);
});

test('不同的随机数得到不同的组合，覆盖整个股票池', () => {
  const seen = new Set();
  const combos = new Set();
  for (let i = 0; i < 300; i += 1) {
    const { symbols } = pickDefaultWatchlist(seeded(i + 7));
    symbols.forEach((s) => seen.add(s));
    combos.add(symbols.join(','));
  }
  assert.ok(combos.size > 290, `组合应几乎各不相同（${combos.size}/300）`);
  assert.equal(seen.size, Object.values(WATCHLIST_POOL).flat().length, '池中每只股票都有机会被选中');
  // 同一个随机序列结果相同（便于复现）
  assert.deepEqual(pickDefaultWatchlist(seeded(42)), pickDefaultWatchlist(seeded(42)));
});
