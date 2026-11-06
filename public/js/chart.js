/**
 * 行情图表：分时（含 5 日）与 K 线（日 / 周 / 月 / 分钟），基于 TradingView Lightweight Charts v5。
 *
 * - 分时图：价格面积线 + 均价线 + 昨收基准线，左轴涨跌幅、右轴价格，二者以昨收为中心对称、完全对齐；
 *   用一个隐藏的占位序列把时间轴补齐到整个交易日。
 * - K 线：蜡烛图 + MA / BOLL 主图指标，副图成交量 + MACD / KDJ / RSI。
 * - applyQuote() 用 WebSocket 推送的实时报价更新最后一根 K 线 / 最后一分钟，无需重新请求。
 */
import {
  createChart,
  AreaSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  CrosshairMode,
} from '../vendor/lightweight-charts.mjs';
import { sma, boll, macd, kdj, rsi } from './indicators.js';
import { sessionSlots, slotForTime, chartTime, minuteBucket } from './sessions.js';
import { fmtBig, fmtPct, fmtPrice, escapeHtml } from './format.js';

const TickMarkType = { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 };
const pad = (n) => String(n).padStart(2, '0');

const MA_PERIODS = [5, 10, 20, 60];

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function alpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function readTheme() {
  return {
    bg: cssVar('--panel') || '#121722',
    text: cssVar('--text-2') || '#a3abbb',
    textStrong: cssVar('--text') || '#e6e9ef',
    grid: cssVar('--chart-grid') || '#1c2230',
    border: cssVar('--border') || '#232a38',
    crosshair: cssVar('--text-3') || '#6b7486',
    up: cssVar('--up') || '#f0464a',
    down: cssVar('--down') || '#1fae6b',
    flat: cssVar('--text-3') || '#6b7486',
    s1: cssVar('--series-1') || '#3987e5',
    s2: cssVar('--series-2') || '#c98500',
    s3: cssVar('--series-3') || '#d55181',
    s4: cssVar('--series-4') || '#9085e9',
    font: cssVar('--font-ui') || 'system-ui, sans-serif',
  };
}

const utc = (t) => new Date(t * 1000);
const fmtDateTime = (t, withTime) => {
  const d = utc(t);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : date;
};

/** 'YYYY-MM-DD' 所在周的周一，用于判断周 K 是否同一根 */
function weekKey(date) {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - dow * 86400_000).toISOString().slice(0, 10);
}

export class StockChart {
  constructor(container, { onStale } = {}) {
    this.container = container;
    this.onStale = onStale;
    this.chart = null;
    this.series = {};
    this.mode = null;
    this.data = null;
    this.opts = {};
    this.legends = [];
    this.resizeObserver = new ResizeObserver(() => this.layoutLegends());
    this.resizeObserver.observe(container);
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.chart?.remove();
    this.chart = null;
  }

  /* ------------------------------------------------------------ lifecycle */

  createBase({ leftScale = false, decimals = 2, withTime = true, multiDay = false } = {}) {
    this.chart?.remove();
    this.legends.forEach((el) => el.remove());
    this.legends = [];
    this.series = {};
    const t = readTheme();
    this.theme = t;
    this.decimals = decimals;

    this.chart = createChart(this.container, {
      autoSize: true,
      layout: {
        background: { color: t.bg },
        textColor: t.text,
        fontSize: 11,
        fontFamily: t.font,
        attributionLogo: false, // 归属声明放在页脚，见 index.html
        panes: { separatorColor: t.border, separatorHoverColor: alpha(t.s1, 0.25), enableResize: true },
      },
      grid: {
        vertLines: { color: t.grid },
        horzLines: { color: t.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: t.crosshair, labelBackgroundColor: t.border, style: LineStyle.Dashed },
        horzLine: { color: t.crosshair, labelBackgroundColor: t.border, style: LineStyle.Dashed },
      },
      rightPriceScale: { borderColor: t.border, minimumWidth: 64 },
      leftPriceScale: { visible: leftScale, borderColor: t.border, minimumWidth: 56 },
      timeScale: {
        borderColor: t.border,
        timeVisible: withTime,
        secondsVisible: false,
        rightOffset: leftScale ? 0 : 6,
        minBarSpacing: 0.5,
        tickMarkFormatter: (time, type) => {
          const d = utc(time);
          if (type === TickMarkType.Year) return `${d.getUTCFullYear()}`;
          if (type === TickMarkType.Month) return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
          if (type === TickMarkType.DayOfMonth) return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
          return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
        },
      },
      localization: {
        locale: 'zh-CN',
        timeFormatter: (time) => {
          if (!withTime) return fmtDateTime(time, false);
          const d = utc(time);
          const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
          return multiDay || this.mode === 'kline' ? `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${hm}` : hm;
        },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: true } },
    });

    this.chart.subscribeCrosshairMove((param) => this.renderLegend(param));
  }

  priceFormat(decimals) {
    return { type: 'price', precision: decimals, minMove: 10 ** -decimals };
  }

  addLegend(paneIndex) {
    const el = document.createElement('div');
    el.className = 'chart-legend';
    el.dataset.pane = String(paneIndex);
    this.container.append(el);
    this.legends[paneIndex] = el;
    return el;
  }

  layoutLegends() {
    if (!this.chart) return;
    const panes = this.chart.panes();
    let left = 10;
    try {
      if (this.chart.options().leftPriceScale.visible) left += this.chart.priceScale('left', 0).width();
    } catch {
      /* 价格轴尚未完成布局 */
    }
    let top = 0;
    panes.forEach((pane, i) => {
      const el = this.legends[i];
      if (el) {
        el.style.top = `${top + 6}px`;
        el.style.left = `${left}px`;
      }
      top += pane.getHeight() + 1;
    });
  }

  /* ------------------------------------------------------------- intraday */

  /**
   * @param payload  /api/minute 的返回值
   * @param opts.days 1 或 5
   */
  showIntraday(payload, { days = 1 } = {}) {
    this.mode = 'intraday';
    this.data = payload;
    this.opts = { days };
    this.render();
  }

  renderIntraday() {
    const { sessions, market } = this.data;
    const decimals = this.data.decimals ?? 2;
    const base = sessions[0]?.prevClose ?? this.data.prevClose;
    const multiDay = sessions.length > 1;
    this.base = base;
    this.createBase({ leftScale: true, decimals, multiDay });
    const t = this.theme;

    const points = [];
    const axis = [];
    const slots = sessionSlots(market);
    sessions.forEach((s, si) => {
      const isLast = si === sessions.length - 1;
      const byTime = new Map(s.points.map((p) => [p.time, p]));
      const allSlots = [...new Set([...slots, ...s.points.map((p) => p.time)])].sort();
      for (const slot of allSlots) {
        const time = chartTime(s.date, slot);
        const p = byTime.get(slot);
        if (p) points.push({ ...p, time, slot, date: s.date });
        if (p || isLast) axis.push({ time });
      }
    });
    this.points = points;
    this.pointIndex = new Map(points.map((p, i) => [p.time, i]));

    const symmetric = (center, minSpan) => (original) => {
      const res = original();
      if (!res?.priceRange) return res;
      const { minValue, maxValue } = res.priceRange;
      const d = Math.max(Math.abs(maxValue - center), Math.abs(center - minValue), minSpan);
      return { priceRange: { minValue: center - d, maxValue: center + d } };
    };

    // 隐藏的占位序列：只有空白点，用来把时间轴撑满整个交易日
    this.series.axis = this.chart.addSeries(LineSeries, {
      priceScaleId: 'axis-pad',
      lineVisible: false,
      color: 'rgba(0,0,0,0)',
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
    });
    this.series.axis.setData(axis);

    this.series.price = this.chart.addSeries(AreaSeries, {
      lineColor: t.s1,
      topColor: alpha(t.s1, 0.28),
      bottomColor: alpha(t.s1, 0.02),
      lineWidth: 2,
      priceFormat: this.priceFormat(decimals),
      autoscaleInfoProvider: symmetric(base, base * 0.002),
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: t.bg,
      crosshairMarkerBorderWidth: 2,
      priceLineVisible: false,
    });
    this.series.price.setData(points.map((p) => ({ time: p.time, value: p.price })));
    this.series.price.createPriceLine({
      price: base,
      color: t.crosshair,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: multiDay ? '基准' : '昨收',
    });

    if (points.some((p) => p.avg !== null && p.avg !== undefined)) {
      this.series.avg = this.chart.addSeries(LineSeries, {
        color: t.s2,
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        priceFormat: this.priceFormat(decimals),
      });
      this.series.avg.setData(points.map((p) => (p.avg ? { time: p.time, value: p.avg } : { time: p.time })));
    }

    // 左轴：涨跌幅，与右轴价格以昨收为中心对称，刻度天然对齐
    this.series.pct = this.chart.addSeries(LineSeries, {
      priceScaleId: 'left',
      lineVisible: false,
      color: 'rgba(0,0,0,0)',
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: symmetric(0, 0.2),
      priceFormat: { type: 'custom', formatter: (v) => `${v.toFixed(2)}%`, minMove: 0.01 },
    });
    this.series.pct.setData(points.map((p) => ({ time: p.time, value: ((p.price - base) / base) * 100 })));

    for (const side of ['left', 'right']) {
      this.chart.priceScale(side, 0).applyOptions({ scaleMargins: { top: 0.06, bottom: 0.06 } });
    }

    this.series.volume = this.chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: 'custom', formatter: (v) => fmtBig(v, 1), minMove: 1 },
        lastValueVisible: false,
        priceLineVisible: false,
      },
      1,
    );
    const volFactor = market === 'cn' ? 0.01 : 1;
    this.series.volume.setData(
      points.map((p, i) => ({
        time: p.time,
        value: p.volume * volFactor,
        color: alpha(p.price >= (i ? points[i - 1].price : base) ? t.up : t.down, 0.75),
      })),
    );
    this.volFactor = volFactor;
    this.chart.panes()[0].setStretchFactor(3);
    this.chart.panes()[1]?.setStretchFactor(1);

    this.addLegend(0);
    this.addLegend(1);
    // 显示完整交易时段（含尚未到来的时间）。注意不能用 fixRightEdge：它会把右边界钉在最后一个有数据的点上
    this.chart.timeScale().applyOptions({ fixLeftEdge: true, lockVisibleTimeRangeOnResize: true });
    this.chart.timeScale().setVisibleLogicalRange({ from: 0, to: Math.max(1, axis.length - 1) });

    // 实时更新所需的状态
    const last = points.at(-1);
    const totalVol = points.filter((p) => p.date === last?.date).reduce((sum, p) => sum + p.volume, 0);
    this.live = last
      ? { date: last.date, slot: last.slot, cumBefore: totalVol - last.volume, lastCum: totalVol }
      : { date: sessions.at(-1)?.date, slot: null, cumBefore: 0, lastCum: null };
  }

  applyIntradayQuote(q) {
    const sessions = this.data.sessions;
    const lastSession = sessions.at(-1);
    const date = q.time.slice(0, 10);
    if (!lastSession || date !== lastSession.date) {
      if (date > (lastSession?.date ?? '') && q.volume > 0) this.onStale?.();
      return;
    }
    const slot = slotForTime(this.data.market, q.time.slice(11));
    const time = chartTime(date, slot);
    const t = this.theme;
    const live = this.live;
    if (live.slot === null || slot > live.slot) {
      live.cumBefore = live.lastCum ?? q.volume;
      live.slot = slot;
    } else if (slot < live.slot) {
      return; // 乱序的旧报价
    }
    const volume = Math.max(0, q.volume - live.cumBefore);
    live.lastCum = q.volume;

    const point = { time, slot, date, price: q.price, avg: q.avgPrice ?? null, volume };
    const idx = this.pointIndex.get(time);
    if (idx !== undefined) this.points[idx] = point;
    else {
      this.points.push(point);
      this.pointIndex.set(time, this.points.length - 1);
    }
    const prev = this.points[this.points.length - 2];

    this.series.price.update({ time, value: q.price });
    this.series.pct.update({ time, value: ((q.price - this.base) / this.base) * 100 });
    if (this.series.avg && q.avgPrice) this.series.avg.update({ time, value: q.avgPrice });
    this.series.volume.update({
      time,
      value: volume * this.volFactor,
      color: alpha(q.price >= (prev?.price ?? this.base) ? t.up : t.down, 0.75),
    });
    if (!this.hovering) this.renderLegend({});
  }

  /* ---------------------------------------------------------------- k-line */

  showKline(payload, opts) {
    this.mode = 'kline';
    this.data = { ...payload, bars: payload.bars.slice() };
    this.opts = { ...opts };
    this.render();
  }

  setIndicators(main, sub) {
    this.opts.main = main;
    this.opts.sub = sub;
    if (this.mode === 'kline') this.render();
  }

  computeIndicators() {
    const bars = this.data.bars;
    const closes = bars.map((b) => b.close);
    const ind = {};
    if (this.opts.main === 'MA') ind.ma = MA_PERIODS.map((n) => sma(closes, n));
    if (this.opts.main === 'BOLL') ind.boll = boll(closes, 20, 2);
    if (this.opts.sub === 'MACD') ind.macd = macd(closes);
    if (this.opts.sub === 'KDJ') ind.kdj = kdj(bars);
    if (this.opts.sub === 'RSI') ind.rsi = [6, 12, 24].map((n) => rsi(closes, n));
    this.ind = ind;
    return ind;
  }

  lineSeries(color, paneIndex = 0, extra = {}) {
    return this.chart.addSeries(
      LineSeries,
      {
        color,
        lineWidth: 1,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        priceFormat: this.priceFormat(this.decimals),
        ...extra,
      },
      paneIndex,
    );
  }

  /** 指标序列的定义：[key, 颜色, 取值函数, 面板, 额外选项] */
  indicatorDefs() {
    const t = this.theme;
    const defs = [];
    const fmt2 = { type: 'price', precision: 2, minMove: 0.01 };
    if (this.ind.ma) {
      const colors = [t.s1, t.s2, t.s3, t.s4];
      MA_PERIODS.forEach((n, k) => defs.push({ key: `ma${n}`, label: `MA${n}`, color: colors[k], pane: 0, get: (i) => this.ind.ma[k][i] }));
    }
    if (this.ind.boll) {
      defs.push({ key: 'bollUp', label: 'UPPER', color: t.s1, pane: 0, get: (i) => this.ind.boll.upper[i] });
      defs.push({ key: 'bollMid', label: 'MID', color: t.s2, pane: 0, get: (i) => this.ind.boll.mid[i] });
      defs.push({ key: 'bollLow', label: 'LOWER', color: t.s3, pane: 0, get: (i) => this.ind.boll.lower[i] });
    }
    if (this.ind.macd) {
      defs.push({ key: 'macdHist', label: 'MACD', color: t.s3, pane: 2, hist: true, get: (i) => this.ind.macd.hist[i], extra: { priceFormat: fmt2 } });
      defs.push({ key: 'dif', label: 'DIF', color: t.s1, pane: 2, get: (i) => this.ind.macd.dif[i], extra: { priceFormat: fmt2 } });
      defs.push({ key: 'dea', label: 'DEA', color: t.s2, pane: 2, get: (i) => this.ind.macd.dea[i], extra: { priceFormat: fmt2 } });
    }
    if (this.ind.kdj) {
      defs.push({ key: 'k', label: 'K', color: t.s1, pane: 2, get: (i) => this.ind.kdj.k[i], extra: { priceFormat: fmt2 } });
      defs.push({ key: 'd', label: 'D', color: t.s2, pane: 2, get: (i) => this.ind.kdj.d[i], extra: { priceFormat: fmt2 } });
      defs.push({ key: 'j', label: 'J', color: t.s3, pane: 2, get: (i) => this.ind.kdj.j[i], extra: { priceFormat: fmt2 } });
    }
    if (this.ind.rsi) {
      const colors = [t.s1, t.s2, t.s3];
      [6, 12, 24].forEach((n, k) =>
        defs.push({ key: `rsi${n}`, label: `RSI${n}`, color: colors[k], pane: 2, get: (i) => this.ind.rsi[k][i], extra: { priceFormat: fmt2 } }),
      );
    }
    return defs;
  }

  indicatorPoint(def, i) {
    const time = this.barTimes[i];
    const v = def.get(i);
    if (v === null || v === undefined || !Number.isFinite(v)) return { time };
    if (def.hist) return { time, value: v, color: alpha(v >= 0 ? this.theme.up : this.theme.down, 0.8) };
    return { time, value: v };
  }

  renderKline() {
    const { bars, market } = this.data;
    const period = this.opts.period;
    const minute = period.startsWith('m');
    const decimals = this.data.decimals ?? 2;
    this.createBase({ decimals, withTime: minute });
    const t = this.theme;
    const toTime = (b) => (minute ? chartTime(b.time.slice(0, 10), b.time.slice(11, 16)) : chartTime(b.time));
    this.barTimes = bars.map(toTime);
    this.barIndex = new Map(this.barTimes.map((time, i) => [time, i]));
    this.volFactor = market === 'cn' ? 0.01 : 1;

    this.series.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: t.up,
      downColor: t.down,
      borderUpColor: t.up,
      borderDownColor: t.down,
      wickUpColor: t.up,
      wickDownColor: t.down,
      priceFormat: this.priceFormat(decimals),
      priceLineColor: t.crosshair,
      priceLineStyle: LineStyle.Dotted,
    });
    this.series.candles.setData(bars.map((b, i) => ({ time: this.barTimes[i], open: b.open, high: b.high, low: b.low, close: b.close })));

    this.series.volume = this.chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: 'custom', formatter: (v) => fmtBig(v, 1), minMove: 1 },
        lastValueVisible: false,
        priceLineVisible: false,
      },
      1,
    );
    this.series.volume.setData(bars.map((b, i) => this.volumePoint(b, i)));

    this.computeIndicators();
    this.defs = this.indicatorDefs();
    this.indSeries = {};
    for (const def of this.defs) {
      const s = def.hist
        ? this.chart.addSeries(HistogramSeries, { lastValueVisible: false, priceLineVisible: false, priceFormat: def.extra?.priceFormat }, def.pane)
        : this.lineSeries(def.color, def.pane, def.extra);
      s.setData(bars.map((_, i) => this.indicatorPoint(def, i)));
      this.indSeries[def.key] = s;
    }
    if (this.ind.rsi) {
      const s = this.indSeries.rsi6;
      [70, 30].forEach((price) =>
        s.createPriceLine({ price, color: alpha(t.crosshair, 0.6), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false }),
      );
    }

    const panes = this.chart.panes();
    panes[0].setStretchFactor(3.2);
    panes[1]?.setStretchFactor(1);
    panes[2]?.setStretchFactor(1.1);
    panes.forEach((_, i) => this.addLegend(i));

    const n = bars.length;
    const visible = minute ? 160 : 130;
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(-2, n - visible), to: n + 4 });
    this.live = { cum: null };
  }

  volumePoint(b, i) {
    return {
      time: this.barTimes[i],
      value: b.volume * this.volFactor,
      color: alpha(b.close >= b.open ? this.theme.up : this.theme.down, 0.7),
    };
  }

  applyKlineQuote(q) {
    if (this.opts.adjust === 'hfq') return; // 后复权价格与实时成交价不在同一尺度
    const bars = this.data.bars;
    const last = bars.at(-1);
    if (!last || !q.time || q.noTrade) return;
    const date = q.time.slice(0, 10);
    const hms = q.time.slice(11);
    const period = this.opts.period;
    const prevCum = this.live.cum;
    const delta = prevCum !== null && q.volume >= prevCum ? q.volume - prevCum : 0;
    this.live.cum = q.volume;

    let bar = null;
    let append = false;
    if (period === 'day') {
      const lastDate = last.time.slice(0, 10);
      if (date === lastDate) bar = { ...last, open: q.open ?? last.open, high: q.high ?? last.high, low: q.low ?? last.low, close: q.price, volume: q.volume };
      else if (date > lastDate && q.volume > 0) {
        bar = { time: date, open: q.open ?? q.price, high: q.high ?? q.price, low: q.low ?? q.price, close: q.price, volume: q.volume };
        append = true;
      }
    } else if (period === 'week' || period === 'month') {
      const same = period === 'week' ? weekKey(date) === weekKey(last.time) : date.slice(0, 7) === last.time.slice(0, 7);
      if (same) bar = { ...last, high: Math.max(last.high, q.price), low: Math.min(last.low, q.price), close: q.price, volume: last.volume + delta };
      else if (date > last.time && q.volume > 0) {
        bar = { time: date, open: q.open ?? q.price, high: q.high ?? q.price, low: q.low ?? q.price, close: q.price, volume: q.volume };
        append = true;
      }
    } else {
      if (this.data.market !== 'cn') return;
      const key = `${date} ${minuteBucket(period, hms)}`;
      if (key === last.time) bar = { ...last, high: Math.max(last.high, q.price), low: Math.min(last.low, q.price), close: q.price, volume: last.volume + delta };
      else if (key > last.time) {
        bar = { time: key, open: q.price, high: q.price, low: q.price, close: q.price, volume: delta };
        append = true;
      }
    }
    if (!bar) return;

    const minute = period.startsWith('m');
    const time = minute ? chartTime(bar.time.slice(0, 10), bar.time.slice(11, 16)) : chartTime(bar.time);
    if (append) {
      bars.push(bar);
      this.barTimes.push(time);
      this.barIndex.set(time, bars.length - 1);
    } else {
      bars[bars.length - 1] = bar;
    }
    const i = bars.length - 1;
    this.series.candles.update({ time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    this.series.volume.update(this.volumePoint(bar, i));
    this.computeIndicators();
    for (const def of this.defs) this.indSeries[def.key]?.update(this.indicatorPoint(def, i));
    if (!this.hovering) this.renderLegend({});
  }

  /* ---------------------------------------------------------------- shared */

  render() {
    if (!this.data) return;
    if (this.mode === 'intraday') this.renderIntraday();
    else this.renderKline();
    requestAnimationFrame(() => {
      this.layoutLegends();
      this.renderLegend({});
    });
  }

  /** 主题 / 涨跌配色变化后重绘 */
  refreshTheme() {
    if (!this.data) return;
    const range = this.chart?.timeScale().getVisibleLogicalRange();
    this.render();
    if (range && this.mode === 'kline') this.chart.timeScale().setVisibleLogicalRange(range);
  }

  applyQuote(q) {
    if (!this.chart || !this.data || q.symbol !== this.data.symbol || !q.time) return;
    try {
      if (this.mode === 'intraday') this.applyIntradayQuote(q);
      else this.applyKlineQuote(q);
    } catch (err) {
      // 极端情况下（例如数据回退）更新失败，不影响页面其它部分
      console.warn('[chart] live update skipped', err);
    }
  }

  renderLegend(param) {
    if (!this.chart || !this.legends.length) return;
    this.hovering = param?.time !== undefined;
    this.layoutLegends();
    if (this.mode === 'intraday') this.renderIntradayLegend(param);
    else this.renderKlineLegend(param);
  }

  renderIntradayLegend(param) {
    const pts = this.points ?? [];
    let p = param?.time !== undefined ? pts[this.pointIndex.get(param.time)] : undefined;
    if (!p) p = pts.at(-1);
    const [main, vol] = this.legends;
    if (!p) {
      main.innerHTML = '<span class="muted">暂无分时数据</span>';
      if (vol) vol.innerHTML = '';
      return;
    }
    const d = this.decimals;
    const pct = ((p.price - this.base) / this.base) * 100;
    const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const dateLabel = this.data.sessions.length > 1 ? `${p.date.slice(5)} ` : '';
    main.innerHTML = '<div class="lg-row">' + [
      `<span class="lg-time">${dateLabel}${p.slot}</span>`,
      `<span class="lg-item"><i class="sw" style="background:${this.theme.s1}"></i>价格 <b class="${dir}">${fmtPrice(p.price, d)}</b></span>`,
      `<span class="lg-item">涨跌 <b class="${dir}">${fmtPct(pct)}</b></span>`,
      p.avg ? `<span class="lg-item"><i class="sw" style="background:${this.theme.s2}"></i>均价 <b>${fmtPrice(p.avg, d)}</b></span>` : '',
    ].join('') + '</div>';
    const unit = this.data.market === 'cn' ? '手' : '股';
    if (vol) vol.innerHTML = `<span class="lg-item">成交量 <b>${fmtBig(p.volume * this.volFactor, 2)}${unit}</b></span>`;
  }

  renderKlineLegend(param) {
    const bars = this.data.bars;
    let i = param?.time !== undefined ? this.barIndex.get(param.time) : undefined;
    if (i === undefined) i = bars.length - 1;
    const b = bars[i];
    const [main, vol, sub] = this.legends;
    if (!b) {
      main.innerHTML = '<span class="muted">暂无 K 线数据</span>';
      return;
    }
    const d = this.decimals;
    const prevClose = i > 0 ? bars[i - 1].close : b.open;
    const chg = ((b.close - prevClose) / prevClose) * 100;
    const amp = ((b.high - b.low) / prevClose) * 100;
    const dir = (v) => (v > prevClose ? 'up' : v < prevClose ? 'down' : 'flat');
    const minute = this.opts.period.startsWith('m');
    const items = (pane) =>
      this.defs
        .filter((def) => def.pane === pane)
        .map((def) => {
          const v = def.get(i);
          const val = v === null || v === undefined || !Number.isFinite(v) ? '--' : v.toFixed(pane === 0 ? d : 2);
          return `<span class="lg-item"><i class="sw" style="background:${def.color}"></i>${escapeHtml(def.label)} <b>${val}</b></span>`;
        })
        .join('');
    main.innerHTML = `
      <div class="lg-row">
        <span class="lg-time">${escapeHtml(b.time.slice(0, minute ? 16 : 10))}</span>
        <span class="lg-item">开 <b class="${dir(b.open)}">${fmtPrice(b.open, d)}</b></span>
        <span class="lg-item">高 <b class="${dir(b.high)}">${fmtPrice(b.high, d)}</b></span>
        <span class="lg-item">低 <b class="${dir(b.low)}">${fmtPrice(b.low, d)}</b></span>
        <span class="lg-item">收 <b class="${dir(b.close)}">${fmtPrice(b.close, d)}</b></span>
        <span class="lg-item">涨跌 <b class="${chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat'}">${fmtPct(chg)}</b></span>
        <span class="lg-item">振幅 <b>${amp.toFixed(2)}%</b></span>
      </div>
      <div class="lg-row">${items(0)}</div>`;
    const unit = this.data.market === 'cn' ? '手' : '股';
    if (vol) vol.innerHTML = `<span class="lg-item">VOL <b>${fmtBig(b.volume * this.volFactor, 2)}${unit}</b></span>`;
    if (sub) {
      const title = { MACD: 'MACD(12,26,9)', KDJ: 'KDJ(9,3,3)', RSI: 'RSI(6,12,24)' }[this.opts.sub] ?? '';
      sub.innerHTML = `<span class="lg-time">${title}</span>${items(2)}`;
    }
  }
}
