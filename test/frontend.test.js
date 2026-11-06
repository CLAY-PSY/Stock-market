// 前端的纯函数模块（不依赖 DOM），可以直接在 Node 中测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, boll, macd, kdj, rsi } from '../public/js/indicators.js';
import { fmtBig, fmtPct, fmtVolume, fmtChange, trend, escapeHtml } from '../public/js/format.js';
import { sessionSlots, slotForTime, chartTime, minuteBucket } from '../public/js/sessions.js';
import { evaluateAlert, describeAlert, validateAlertInput } from '../public/js/alert-rules.js';
import { resolveTheme, nextThemeMode, migrateSettings, normalizeThemeMode } from '../public/js/theme.js';

test('主题：跟随系统 / 浅色 / 深色', () => {
  assert.equal(resolveTheme('auto', true), 'light');
  assert.equal(resolveTheme('auto', false), 'dark');
  assert.equal(resolveTheme('light', false), 'light', '手动指定时不受系统影响');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme(null, true), 'light', '未设置视为跟随系统');
  assert.equal(normalizeThemeMode('purple'), 'auto');
  assert.deepEqual(['auto', 'light', 'dark', 'auto'].slice(1), [nextThemeMode('auto'), nextThemeMode('light'), nextThemeMode('dark')]);
});

test('主题设置迁移：旧版锁定的深 / 浅色恢复为跟随系统，新版设置保持不变', () => {
  assert.equal(migrateSettings({ theme: 'dark', colorMode: 'intl' }).theme, 'auto');
  assert.equal(migrateSettings({ theme: 'dark', colorMode: 'intl' }).colorMode, 'intl', '其它设置不受影响');
  assert.equal(migrateSettings({ theme: 'light', settingsVersion: 2 }).theme, 'light');
  assert.equal(migrateSettings({ settingsVersion: 2 }).theme, 'auto');
  assert.equal(migrateSettings({}).settingsVersion, 2);
});

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('SMA / EMA', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3], 3);
  assert.equal(e[0], 1);
  assert.ok(close(e[1], 1.5));
  assert.ok(close(e[2], 2.25));
});

test('BOLL：常数序列上下轨重合', () => {
  const b = boll(Array(25).fill(10), 20, 2);
  assert.equal(b.mid[18], null);
  assert.equal(b.mid[19], 10);
  assert.equal(b.upper[24], 10);
  assert.equal(b.lower[24], 10);
});

test('MACD：柱 = 2×(DIF−DEA)，常数序列全为 0', () => {
  const m = macd(Array(40).fill(5));
  assert.ok(m.dif.every((v) => close(v, 0)));
  assert.ok(m.hist.every((v) => close(v, 0)));
  const up = macd(Array.from({ length: 60 }, (_, i) => 10 + i));
  assert.ok(up.dif.at(-1) > 0, '持续上涨 DIF 为正');
  assert.ok(close(up.hist.at(-1), 2 * (up.dif.at(-1) - up.dea.at(-1))));
});

test('RSI 取值范围与极端情况', () => {
  const rising = rsi(Array.from({ length: 30 }, (_, i) => i), 6);
  assert.equal(rising[3], null);
  assert.ok(close(rising.at(-1), 100));
  const mixed = rsi([10, 11, 10, 12, 11, 13, 12, 14, 13, 15], 6);
  assert.ok(mixed.filter((v) => v !== null).every((v) => v >= 0 && v <= 100));
});

test('KDJ：收在最高价时 K、D 趋近 100', () => {
  const bars = Array.from({ length: 50 }, (_, i) => ({ high: 10 + i, low: 9 + i, close: 10 + i }));
  const r = kdj(bars);
  assert.ok(r.k.at(-1) > 99);
  assert.ok(r.d.at(-1) > 99);
  assert.ok(close(r.j.at(-1), 3 * r.k.at(-1) - 2 * r.d.at(-1)));
});

test('格式化', () => {
  assert.equal(fmtBig(123456789), '1.23亿');
  assert.equal(fmtBig(1.8e12), '1.80万亿');
  assert.equal(fmtBig(45678), '4.57万');
  assert.equal(fmtBig(null), '--');
  assert.equal(fmtPct(1.234), '+1.23%');
  assert.equal(fmtPct(-0.5), '-0.50%');
  assert.equal(fmtChange(0.1, 3), '+0.100');
  assert.equal(fmtVolume(1_690_400, 'cn'), '1.69万手');
  assert.equal(fmtVolume(1234, 'us'), '1234股');
  assert.equal(trend(0), 'flat');
  assert.equal(trend(-1), 'down');
  assert.equal(escapeHtml('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
});

test('交易时段刻度', () => {
  assert.equal(sessionSlots('cn').length, 241);
  assert.equal(sessionSlots('hk').length, 332);
  assert.equal(sessionSlots('us').length, 391);
  assert.equal(slotForTime('cn', '10:17:48'), '10:18', '以结束时间标记');
  assert.equal(slotForTime('cn', '09:25:03'), '09:30', '集合竞价归入开盘');
  assert.equal(slotForTime('cn', '12:10:00'), '11:30', '午休归入上午收盘');
  assert.equal(slotForTime('cn', '13:00:30'), '13:01');
  assert.equal(slotForTime('cn', '15:00:03'), '15:00');
  assert.equal(slotForTime('hk', '13:00:00'), '13:00');
  assert.equal(chartTime('2026-11-06', '09:30'), Date.UTC(2026, 10, 6, 9, 30) / 1000);
});

test('A 股分钟 K 线归属', () => {
  assert.equal(minuteBucket('m5', '10:17:48'), '10:20');
  assert.equal(minuteBucket('m1', '10:17:48'), '10:18');
  assert.equal(minuteBucket('m30', '09:31:00'), '10:00');
  assert.equal(minuteBucket('m60', '10:45:10'), '11:30');
  assert.equal(minuteBucket('m60', '13:20:00'), '14:00');
  assert.equal(minuteBucket('m15', '12:05:00'), '11:30');
  assert.equal(minuteBucket('m5', '15:00:02'), '15:00');
});

test('价格提醒规则', () => {
  const q = { price: 10.5, changePct: -4.2, noTrade: false };
  assert.equal(evaluateAlert({ active: true, type: 'priceAbove', value: 10 }, q), true);
  assert.equal(evaluateAlert({ active: true, type: 'priceBelow', value: 10 }, q), false);
  assert.equal(evaluateAlert({ active: true, type: 'pctBelow', value: 4 }, q), true);
  assert.equal(evaluateAlert({ active: true, type: 'pctAbove', value: 1 }, q), false);
  assert.equal(evaluateAlert({ active: false, type: 'priceAbove', value: 1 }, q), false, '已触发的不再触发');
  assert.equal(evaluateAlert({ active: true, type: 'priceAbove', value: 1 }, { ...q, noTrade: true }), false);
  assert.equal(describeAlert({ type: 'pctBelow', value: 3 }), '跌幅 ≥ 3.00%');
  assert.equal(validateAlertInput('priceAbove', '-1'), '价格必须大于 0');
  assert.equal(validateAlertInput('priceAbove', 'abc'), '请输入有效的数值');
  assert.equal(validateAlertInput('pctAbove', '5'), null);
});
