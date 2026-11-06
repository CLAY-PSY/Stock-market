/**
 * 技术指标计算。所有函数返回与输入等长的数组，数据不足的位置为 null。
 * 算法与国内主流行情软件保持一致（MACD 柱 = 2×(DIF−DEA)，RSI/KDJ 使用 SMA(X,N,1) 平滑）。
 */

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i += 1) {
    prev = prev === null ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** 国内软件的 SMA(X, N, M)：Y = (M×X + (N−M)×Y') / N */
function cnSma(values, n, m = 1) {
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i += 1) {
    const x = values[i];
    if (x === null) continue;
    prev = prev === null ? x : (m * x + (n - m) * prev) / n;
    out[i] = prev;
  }
  return out;
}

export function boll(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = n - 1; i < closes.length; i += 1) {
    let sq = 0;
    for (let j = i - n + 1; j <= i; j += 1) sq += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(sq / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const dea = ema(dif, signal);
  const hist = dif.map((d, i) => 2 * (d - dea[i]));
  return { dif, dea, hist };
}

export function kdj(bars, n = 9, m1 = 3, m2 = 3) {
  const len = bars.length;
  const k = new Array(len).fill(null);
  const d = new Array(len).fill(null);
  const j = new Array(len).fill(null);
  let pk = 50;
  let pd = 50;
  for (let i = 0; i < len; i += 1) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let t = Math.max(0, i - n + 1); t <= i; t += 1) {
      hi = Math.max(hi, bars[t].high);
      lo = Math.min(lo, bars[t].low);
    }
    const rsv = hi === lo ? 50 : ((bars[i].close - lo) / (hi - lo)) * 100;
    pk = ((m1 - 1) * pk + rsv) / m1;
    pd = ((m2 - 1) * pd + pk) / m2;
    k[i] = pk;
    d[i] = pd;
    j[i] = 3 * pk - 2 * pd;
  }
  return { k, d, j };
}

export function rsi(closes, n) {
  const up = [null];
  const all = [null];
  for (let i = 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    up.push(Math.max(diff, 0));
    all.push(Math.abs(diff));
  }
  const su = cnSma(up, n);
  const sa = cnSma(all, n);
  return closes.map((_, i) => {
    if (i < n || su[i] === null || !sa[i]) return i < n ? null : 50;
    return (su[i] / sa[i]) * 100;
  });
}
