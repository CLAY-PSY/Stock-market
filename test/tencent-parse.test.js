import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseQuoteResponse,
  parseQuoteTime,
  parseMarketStatus,
  parseMinuteRows,
  parseKlineRows,
  parseTickRows,
  parseSearchResponse,
} from '../server/providers/tencent.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('解析 A 股报价：价格、五档盘口、单位换算', () => {
  const q = parseQuoteResponse(fixture('qt-sample.txt')).get('sh600519');
  assert.equal(q.name, '贵州茅台');
  assert.equal(q.market, 'cn');
  assert.equal(q.type, 'stock');
  assert.equal(q.price, 1443.89);
  assert.equal(q.prevClose, 1452);
  assert.equal(q.changePct, -0.56);
  assert.equal(q.decimals, 2);
  assert.equal(q.volume, 15708 * 100, '成交量由手换算为股');
  assert.equal(q.bids.length, 5);
  assert.equal(q.asks.length, 5);
  assert.deepEqual(q.bids[0], { price: 1443.77, volume: 100 });
  assert.equal(q.limitUp, 1597.2);
  assert.equal(q.limitDown, 1306.8);
  assert.equal(q.marketCap, 18049.8 * 1e8);
  assert.equal(q.time, '2026-11-06 10:09:54');
  assert.equal(q.ts, Date.UTC(2026, 10, 6, 2, 9, 54), '北京时间 = UTC+8');
});

test('解析港股实时报价（r_ 前缀）', () => {
  const q = parseQuoteResponse(fixture('qt-sample.txt')).get('hk00700');
  assert.ok(q, '应把 r_hk00700 归一为 hk00700');
  assert.equal(q.market, 'hk');
  assert.equal(q.currency, 'HKD');
  assert.equal(q.decimals, 3);
  assert.equal(q.nameEn, 'TENCENT');
  assert.equal(q.high52w, 656.7);
  assert.equal(q.low52w, 375.2);
  assert.equal(q.bids.length, 1);
});

test('解析美股报价，并按美东时间（含夏令时规则）换算时间戳', () => {
  const q = parseQuoteResponse(fixture('qt-sample.txt')).get('usNVDA');
  assert.equal(q.code, 'NVDA');
  assert.equal(q.exchangeCode, 'NVDA.OQ');
  assert.equal(q.currency, 'USD');
  assert.equal(q.time, '2026-11-05 16:00:02');
  // 2026-11-05 美国已结束夏令时（11 月 1 日），美东 = UTC-5
  assert.equal(q.ts, Date.UTC(2026, 10, 5, 21, 0, 2));
});

test('ETF 与北交所代码', () => {
  const quotes = parseQuoteResponse(fixture('qt-sample.txt'));
  assert.equal(quotes.get('sh510300').type, 'fund');
  assert.equal(quotes.get('sh510300').decimals, 3);
  assert.equal(quotes.get('bj920175').market, 'cn');
});

test('指数没有盘口，无效代码被忽略', () => {
  const quotes = parseQuoteResponse(fixture('qt-index.txt'));
  assert.equal(quotes.get('sh000001').type, 'index');
  assert.equal(quotes.get('sh000001').bids.length, 0);
  assert.equal(quotes.get('usDJI').type, 'index');
  assert.equal(quotes.get('hkHSI').type, 'index');
  assert.equal(quotes.get('hkHSI').bids.length, 0);
  assert.equal(quotes.has('sh999999'), false);
});

test('parseQuoteTime 支持三种时间格式', () => {
  assert.equal(parseQuoteTime('20261106100724', 'cn').time, '2026-11-06 10:07:24');
  assert.equal(parseQuoteTime('2026/11/06 10:08:50', 'hk').time, '2026-11-06 10:08:50');
  const summer = parseQuoteTime('2026-07-01 09:30:00', 'us');
  assert.equal(summer.ts, Date.UTC(2026, 6, 1, 13, 30), '夏令时美东 = UTC-4');
  assert.equal(parseQuoteTime('', 'cn').ts, null);
});

test('市场状态', () => {
  const s = parseMarketStatus(
    'v_marketStat="2026-11-06 10:10:28|HK_open_交易中|SH_open_交易中|SZ_open_交易中|US_close_已收盘|UK_close_未开盘";',
  );
  assert.deepEqual(s.cn, { open: true, text: '交易中' });
  assert.deepEqual(s.hk, { open: true, text: '交易中' });
  assert.deepEqual(s.us, { open: false, text: '已收盘' });
  assert.throws(() => parseMarketStatus('garbage'));
});

test('分时：累计量转换为每分钟增量，计算均价，丢弃盘后固定价格交易', () => {
  const rows = ['0930 10.00 100 100000', '0931 10.10 150 150500', '0932 10.20 150 150500', '1505 10.20 160 160700'];
  const pts = parseMinuteRows(rows, { market: 'cn' });
  assert.equal(pts.length, 3);
  assert.deepEqual(
    pts.map((p) => p.volume),
    [10000, 5000, 0],
  );
  assert.equal(pts[0].time, '09:30');
  assert.equal(pts[1].avg, Math.round((150500 / 15000) * 1e4) / 1e4, '均价保留 4 位小数');
});

test('分时：美股无成交额时用成交量加权计算均价', () => {
  const pts = parseMinuteRows(['0930 10 100', '0931 20 200'], { market: 'us' });
  assert.equal(pts[1].volume, 100);
  assert.equal(pts[1].avg, 15);
});

test('K 线行解析', () => {
  const bars = parseKlineRows(
    [
      ['2026-11-05', '1446.700', '1452.000', '1466.000', '1430.000', '46712.000'],
      ['bad'],
    ],
    { market: 'cn' },
  );
  assert.deepEqual(bars, [{ time: '2026-11-05', open: 1446.7, high: 1466, low: 1430, close: 1452, volume: 4671200 }]);
  const m = parseKlineRows([['202611061010', '1', '2', '3', '0.5', '10', {}, '0.1']], { market: 'cn', minute: true });
  assert.equal(m[0].time, '2026-11-06 10:10');
});

test('逐笔成交解析', () => {
  const ticks = parseTickRows('840/10:13:21/1440.54/-0.01/4/576198/B|841/10:13:24/1439.98/-0.56/165/23759364/S|842/10:13:27/1439.97/-0.01/25/3597892/M');
  assert.equal(ticks.length, 3);
  assert.deepEqual(ticks[0], { id: 840, time: '10:13:21', price: 1440.54, change: -0.01, volume: 400, amount: 576198, side: 'B' });
  assert.equal(ticks[2].side, 'M');
});

test('搜索结果解析：解码 \\u 转义、过滤涡轮、规范化代码', () => {
  const raw =
    'v_hint="sh~600519~\\u8d35\\u5dde\\u8305\\u53f0~gzmt~GP-A^us~aapl.oq~\\u82f9\\u679c~pg~GP^us~dji~\\u9053\\u743c\\u65af~dqs~ZS^hk~13005~\\u817e\\u8baf\\u6cd5\\u5174~txfx~QZ^jj~180003~\\u94f6\\u534e~yh~KJ"';
  const items = parseSearchResponse(raw);
  assert.deepEqual(
    items.map((i) => [i.symbol, i.name, i.type]),
    [
      ['sh600519', '贵州茅台', 'stock'],
      ['usAAPL', '苹果', 'stock'],
      ['usDJI', '道琼斯', 'index'],
    ],
  );
  assert.deepEqual(parseSearchResponse('v_hint="N";'), []);
});
