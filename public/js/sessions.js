/** 各市场的连续竞价时段（交易所当地时间），用于分时图补齐全天时间轴 */
export const SESSIONS = {
  cn: [
    ['09:30', '11:30'],
    ['13:01', '15:00'],
  ],
  hk: [
    ['09:30', '12:00'],
    ['13:00', '16:00'],
  ],
  us: [['09:30', '16:00']],
};

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

const slotCache = new Map();

/** 某市场一个交易日的全部分钟刻度：['09:30', '09:31', ...] */
export function sessionSlots(market) {
  if (slotCache.has(market)) return slotCache.get(market);
  const out = [];
  for (const [from, to] of SESSIONS[market] ?? SESSIONS.cn) {
    for (let m = toMin(from); m <= toMin(to); m += 1) out.push(toHHMM(m));
  }
  slotCache.set(market, out);
  return out;
}

/**
 * 把报价时间 'HH:MM:SS' 映射到分时图上的分钟刻度。
 * 国内行情软件的分钟线以结束时间标记（10:17:48 的成交属于 10:18 这根），
 * 午休 / 收盘后的时间归到最近的上一刻度，开盘前归到第一个刻度。
 */
export function slotForTime(market, hhmmss) {
  const [h, m, s = '0'] = hhmmss.split(':');
  let minute = Number(h) * 60 + Number(m);
  if (Number(s) > 0) minute += 1;
  const slots = sessionSlots(market);
  let best = slots[0];
  for (const slot of slots) {
    if (toMin(slot) <= minute) best = slot;
    else break;
  }
  return best;
}

/** 'YYYY-MM-DD' + 'HH:MM' → 图表使用的时间戳（把交易所当地时间当作 UTC，保证坐标轴显示当地时间） */
export function chartTime(date, hhmm = '00:00') {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) / 1000;
}

/** A 股分钟 K 线的归属时间（以结束时间标记，按上午 / 下午时段分别对齐） */
export function minuteBucket(period, hhmmss) {
  const n = Number(period.slice(1));
  const [h, m, s] = hhmmss.split(':').map(Number);
  let minute = h * 60 + m + (s > 0 ? 1 : 0);
  const AM_START = 570;
  const AM_END = 690;
  const PM_START = 780;
  const PM_END = 900;
  if (minute <= AM_START) minute = AM_START + 1;
  if (minute > AM_END && minute <= PM_START) minute = AM_END;
  if (minute > PM_END) minute = PM_END;
  const base = minute <= AM_END ? AM_START : PM_START;
  const end = minute <= AM_END ? AM_END : PM_END;
  const bucket = Math.min(end, base + Math.ceil((minute - base) / n) * n);
  return toHHMM(bucket);
}
