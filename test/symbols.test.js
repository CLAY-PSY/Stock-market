import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSymbol, marketOf, parseSymbolList, inferCnExchange } from '../shared/symbols.js';

test('A 股代码自动识别交易所', () => {
  assert.equal(normalizeSymbol('600519'), 'sh600519');
  assert.equal(normalizeSymbol('000001'), 'sz000001');
  assert.equal(normalizeSymbol('300750'), 'sz300750');
  assert.equal(normalizeSymbol('688981'), 'sh688981');
  assert.equal(normalizeSymbol('510300'), 'sh510300');
  assert.equal(normalizeSymbol('159915'), 'sz159915');
  assert.equal(normalizeSymbol('920175'), 'bj920175');
  assert.equal(normalizeSymbol('430047'), 'bj430047');
  assert.equal(inferCnExchange('900901'), 'sh');
});

test('带前缀的写法', () => {
  assert.equal(normalizeSymbol('SH600519'), 'sh600519');
  assert.equal(normalizeSymbol('sz.000001'), 'sz000001');
  assert.equal(normalizeSymbol('hk700'), 'hk00700');
  assert.equal(normalizeSymbol('r_hk00700'), 'hk00700');
  assert.equal(normalizeSymbol('hkHSI'), 'hkHSI');
  assert.equal(normalizeSymbol('usAAPL'), 'usAAPL');
  assert.equal(normalizeSymbol('us.DJI'), 'usDJI');
});

test('港股纯数字代码补齐 5 位', () => {
  assert.equal(normalizeSymbol('700'), 'hk00700');
  assert.equal(normalizeSymbol('09988'), 'hk09988');
});

test('美股代码，含以 SH/US 开头的真实代码', () => {
  assert.equal(normalizeSymbol('aapl'), 'usAAPL');
  assert.equal(normalizeSymbol('AAPL.OQ'), 'usAAPL');
  assert.equal(normalizeSymbol('BABA.N'), 'usBABA');
  assert.equal(normalizeSymbol('SHOP'), 'usSHOP');
  assert.equal(normalizeSymbol('USB'), 'usUSB');
  assert.equal(normalizeSymbol('BRK.B'), 'usBRK.B');
  assert.equal(normalizeSymbol('.DJI'), 'usDJI');
});

test('非法输入返回 null', () => {
  for (const bad of ['', '   ', 'a b', '<script>', 'sh60051', '123ABC', 'x'.repeat(30), null, undefined, 42]) {
    assert.equal(normalizeSymbol(bad), null, String(bad));
  }
});

test('marketOf 与 parseSymbolList', () => {
  assert.equal(marketOf('sh600519'), 'cn');
  assert.equal(marketOf('bj920175'), 'cn');
  assert.equal(marketOf('hk00700'), 'hk');
  assert.equal(marketOf('usAAPL'), 'us');
  assert.deepEqual(parseSymbolList('600519, 600519,aapl  00700,<bad>'), ['sh600519', 'usAAPL', 'hk00700']);
  assert.equal(parseSymbolList(Array.from({ length: 10 }, (_, i) => `60000${i}`).join(','), 3).length, 3);
});
