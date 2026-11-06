/**
 * 本地保存的状态（localStorage）的校验与清洗。
 *
 * localStorage 里的内容可能来自旧版本、被浏览器扩展改过或者已损坏，读出来后逐项校验：
 * 代码统一规范化并去重，提醒只保留结构完整的，设置只接受界面上存在的取值，其余丢弃（回落到默认值）。
 * 纯函数，不访问 DOM / localStorage，便于在 Node 中测试。
 *
 * 代码规范化函数（shared/symbols.js 的 normalizeSymbol）由调用方传入：浏览器里 shared/ 位于站点根目录，
 * 与 Node 中的目录结构不同，无法用同一个相对路径导入。
 */
import { ALERT_TYPES, validateAlertInput } from '../alert-rules.js';

/** 自选股数量上限：连同指数和提醒，总订阅数要低于服务端的单连接上限（300） */
export const MAX_WATCHLIST = 200;
/** 提醒数量上限 */
export const MAX_ALERTS = 50;
export const MAX_NOTE_LENGTH = 40;

const oneOf = (...values) => (v) => values.includes(v);

const SETTING_RULES = {
  settingsVersion: (v) => Number.isInteger(v) && v > 0,
  theme: oneOf('auto', 'light', 'dark'),
  colorMode: oneOf('cn', 'intl'),
  period: oneOf('minute', 'minute5', 'day', 'week', 'month', 'm1', 'm5', 'm15', 'm30', 'm60'),
  adjust: oneOf('qfq', 'hfq', ''),
  mainIndicator: oneOf('MA', 'BOLL', 'NONE'),
  subIndicator: oneOf('MACD', 'KDJ', 'RSI', 'NONE'),
  watchFilter: oneOf('all', 'cn', 'hk', 'us'),
  rankSort: oneOf('changePct:desc', 'changePct:asc', 'amount:desc', 'speed:desc', 'volumeRatio:desc', 'amplitude:desc'),
  rankBoard: oneOf('all', 'cyb', 'kcb'),
  sound: (v) => typeof v === 'boolean',
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function sanitizeSettings(raw) {
  if (!isPlainObject(raw)) return {};
  const out = {};
  for (const [key, valid] of Object.entries(SETTING_RULES)) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && valid(raw[key])) out[key] = raw[key];
  }
  return out;
}

/**
 * @param normalizeSymbol shared/symbols.js 中的 normalizeSymbol
 */
export function createStateSanitizer(normalizeSymbol) {
  /** 代码列表：规范化、去重、截断；不是数组时返回 null（由调用方使用默认值） */
  function sanitizeSymbols(raw, limit = MAX_WATCHLIST) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      const sym = typeof item === 'string' ? normalizeSymbol(item) : null;
      if (!sym || seen.has(sym)) continue;
      seen.add(sym);
      out.push(sym);
      if (out.length >= limit) break;
    }
    return out;
  }

  function sanitizeAlert(raw) {
    if (!isPlainObject(raw)) return null;
    const symbol = typeof raw.symbol === 'string' ? normalizeSymbol(raw.symbol) : null;
    if (!symbol || !Object.prototype.hasOwnProperty.call(ALERT_TYPES, raw.type)) return null;
    const value = Number(raw.value);
    if (validateAlertInput(raw.type, value) !== null) return null;
    const id = typeof raw.id === 'string' && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : null;
    if (!id) return null;
    const active = raw.active !== false;
    return {
      id,
      symbol,
      type: raw.type,
      value,
      note: typeof raw.note === 'string' ? raw.note.slice(0, MAX_NOTE_LENGTH) : '',
      createdAt: finiteOrNull(raw.createdAt) ?? Date.now(),
      active,
      triggeredAt: active ? null : finiteOrNull(raw.triggeredAt),
      triggeredPrice: active ? null : finiteOrNull(raw.triggeredPrice),
    };
  }

  function sanitizeAlerts(raw, limit = MAX_ALERTS) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const ids = new Set();
    for (const item of raw) {
      const a = sanitizeAlert(item);
      if (!a || ids.has(a.id)) continue;
      ids.add(a.id);
      out.push(a);
      if (out.length >= limit) break;
    }
    return out;
  }

  function sanitizeNames(raw) {
    if (!isPlainObject(raw)) return {};
    const out = {};
    for (const [key, name] of Object.entries(raw)) {
      const sym = normalizeSymbol(key);
      if (sym && typeof name === 'string' && name.trim()) out[sym] = name.trim().slice(0, 64);
    }
    return out;
  }

  /** 整份保存的状态 → 可放心使用的结构 */
  function sanitizeSaved(raw) {
    const saved = isPlainObject(raw) ? raw : {};
    return {
      settings: isPlainObject(saved.settings) ? sanitizeSettings(saved.settings) : null,
      watchlist: sanitizeSymbols(saved.watchlist),
      alerts: sanitizeAlerts(saved.alerts),
      selected: typeof saved.selected === 'string' ? normalizeSymbol(saved.selected) : null,
      names: sanitizeNames(saved.names),
    };
  }

  return { sanitizeSymbols, sanitizeAlert, sanitizeAlerts, sanitizeNames, sanitizeSaved };
}
