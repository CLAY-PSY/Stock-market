// 本地保存状态的校验：损坏 / 被篡改的数据不能进入页面
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStateSanitizer, MAX_WATCHLIST, MAX_ALERTS } from '../public/js/data/saved-state.js';
import { normalizeSymbol } from '../shared/symbols.js';

const { sanitizeSaved, sanitizeSymbols, sanitizeAlerts } = createStateSanitizer(normalizeSymbol);

test('非对象 / 空值回落到默认', () => {
  for (const raw of [null, undefined, 5, 'x', [], true]) {
    const s = sanitizeSaved(raw);
    assert.equal(s.settings, null);
    assert.equal(s.watchlist, null, '没有保存过自选时使用默认自选');
    assert.deepEqual(s.alerts, []);
    assert.equal(s.selected, null);
    assert.deepEqual(s.names, {});
  }
});

test('自选：规范化、去重、过滤非法项、限制数量', () => {
  assert.deepEqual(sanitizeSymbols(['sh600519', '600519', 'hk700', '<img src=x onerror=alert(1)>', 42, null, 'usBRK.B']), [
    'sh600519',
    'hk00700',
    'usBRK.B',
  ]);
  const many = Array.from({ length: 500 }, (_, i) => `sh${String(600000 + i)}`);
  assert.equal(sanitizeSymbols(many).length, MAX_WATCHLIST);
  assert.deepEqual(sanitizeSymbols([]), [], '用户清空了自选：保持为空，不恢复默认');
});

test('提醒：只保留结构完整的', () => {
  const good = { id: 'a1', symbol: 'sh600519', type: 'priceAbove', value: 10, note: 'x'.repeat(100), active: true, createdAt: 1 };
  const out = sanitizeAlerts([
    good,
    { ...good, id: 'a2', type: 'constructor' },
    { ...good, id: 'a3', symbol: '"><script>' },
    { ...good, id: 'a4', value: -1 },
    { ...good, id: 'a5', value: 'abc' },
    { ...good, id: '<b>' },
    { ...good }, // 重复 id
    { ...good, id: 'a6', active: false, triggeredAt: 5, triggeredPrice: 11 },
    'not an object',
  ]);
  assert.deepEqual(out.map((a) => a.id), ['a1', 'a6']);
  assert.equal(out[0].note.length, 40);
  assert.equal(out[1].triggeredPrice, 11);
  const many = Array.from({ length: 80 }, (_, i) => ({ ...good, id: `x${i}` }));
  assert.equal(sanitizeAlerts(many).length, MAX_ALERTS);
});

test('设置：只接受界面上存在的取值', () => {
  const s = sanitizeSaved({
    settings: { theme: 'dark', colorMode: 'purple', rankSort: 'constructor:desc', period: 'm5', sound: 'yes', settingsVersion: 2, extra: 1 },
    selected: 'hk700',
    names: { sh600519: '贵州茅台', bad: 'x', usAAPL: 42 },
  });
  assert.deepEqual(s.settings, { theme: 'dark', period: 'm5', settingsVersion: 2 });
  assert.equal(s.selected, 'hk00700');
  assert.deepEqual(s.names, { sh600519: '贵州茅台', usBAD: 'x' });
});
