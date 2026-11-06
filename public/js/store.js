/**
 * 全局状态 + 本地持久化（自选股、提醒、偏好设置）。
 * 组件通过 store.on(event, fn) 订阅变化，避免互相直接依赖。
 */
import { migrateSettings, SETTINGS_VERSION } from './theme.js';

const STORAGE_KEY = 'stockpulse:v1';

export const INDICES = [
  'sh000001',
  'sz399001',
  'sz399006',
  'sh000688',
  'sh000300',
  'hkHSI',
  'hkHSTECH',
  'usDJI',
  'usIXIC',
  'usINX',
];

const DEFAULT_WATCHLIST = [
  'sh600519',
  'sz300750',
  'sz002594',
  'sh601318',
  'sh600036',
  'sh510300',
  'hk00700',
  'hk09988',
  'hk03690',
  'usAAPL',
  'usNVDA',
  'usTSLA',
  'usMSFT',
];

const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  theme: 'auto', // auto 跟随系统 / light / dark
  colorMode: 'cn', // cn: 红涨绿跌；intl: 绿涨红跌
  period: 'minute',
  adjust: 'qfq',
  mainIndicator: 'MA',
  subIndicator: 'MACD',
  watchFilter: 'all',
  rankSort: 'changePct:desc',
  rankBoard: 'all',
  sound: true,
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

class Store {
  constructor() {
    const saved = load() ?? {};
    // 先迁移已保存的设置再合并默认值（否则默认值里的版本号会掩盖旧设置）
    const savedSettings = saved.settings ? migrateSettings(saved.settings) : {};
    this.settings = { ...DEFAULT_SETTINGS, ...savedSettings };
    if (saved.settings && saved.settings.settingsVersion !== SETTINGS_VERSION) this.persist();
    this.watchlist = Array.isArray(saved.watchlist) ? saved.watchlist.filter((s) => typeof s === 'string') : [...DEFAULT_WATCHLIST];
    this.alerts = Array.isArray(saved.alerts) ? saved.alerts : [];
    this.selected = typeof saved.selected === 'string' ? saved.selected : this.watchlist[0] ?? 'sh600519';
    this.quotes = new Map();
    this.names = new Map(Object.entries(saved.names ?? {})); // 代码 → 名称缓存，报价到达前用于展示
    this.unknown = new Set();
    this.market = null;
    this.provider = null;
    this.listeners = new Map();
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  emit(event, payload) {
    this.listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[store] ${event} listener failed`, err);
      }
    });
  }

  persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      try {
        const names = Object.fromEntries(
          [...this.names].filter(([s]) => this.watchlist.includes(s) || this.alerts.some((a) => a.symbol === s) || s === this.selected),
        );
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ settings: this.settings, watchlist: this.watchlist, alerts: this.alerts, selected: this.selected, names }),
        );
      } catch {
        /* 隐私模式或存储已满时忽略 */
      }
    }, 200);
  }

  /* ---------------------------------------------------------------- quotes */

  applyQuotes(list) {
    const changed = [];
    for (const q of list) {
      const prev = this.quotes.get(q.symbol);
      this.quotes.set(q.symbol, q);
      if (q.name) this.names.set(q.symbol, q.name);
      this.unknown.delete(q.symbol);
      changed.push({ quote: q, prev });
    }
    if (changed.length) this.emit('quotes', changed);
  }

  markUnknown(symbols) {
    symbols.forEach((s) => this.unknown.add(s));
    this.emit('unknown', symbols);
  }

  nameOf(symbol) {
    return this.quotes.get(symbol)?.name ?? this.names.get(symbol) ?? symbol.slice(2);
  }

  /** 需要实时推送的全部代码 */
  subscriptionSet() {
    return [...new Set([...INDICES, ...this.watchlist, this.selected, ...this.alerts.filter((a) => a.active).map((a) => a.symbol)])];
  }

  /* -------------------------------------------------------------- selection */

  select(symbol) {
    if (!symbol || symbol === this.selected) return;
    this.selected = symbol;
    this.persist();
    this.emit('select', symbol);
    this.emit('subscriptions');
  }

  /* -------------------------------------------------------------- watchlist */

  inWatchlist(symbol) {
    return this.watchlist.includes(symbol);
  }

  addToWatchlist(symbol, name) {
    if (name) this.names.set(symbol, name);
    if (this.inWatchlist(symbol)) return false;
    this.watchlist = [...this.watchlist, symbol];
    this.persist();
    this.emit('watchlist', this.watchlist);
    this.emit('subscriptions');
    return true;
  }

  removeFromWatchlist(symbol) {
    if (!this.inWatchlist(symbol)) return false;
    this.watchlist = this.watchlist.filter((s) => s !== symbol);
    this.persist();
    this.emit('watchlist', this.watchlist);
    this.emit('subscriptions');
    return true;
  }

  moveInWatchlist(symbol, beforeSymbol) {
    const list = this.watchlist.filter((s) => s !== symbol);
    const idx = beforeSymbol ? list.indexOf(beforeSymbol) : -1;
    if (idx < 0) list.push(symbol);
    else list.splice(idx, 0, symbol);
    this.watchlist = list;
    this.persist();
    this.emit('watchlist', this.watchlist);
  }

  /* ----------------------------------------------------------------- alerts */

  addAlert(alert) {
    const item = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
      active: true,
      triggeredAt: null,
      triggeredPrice: null,
      ...alert,
    };
    this.alerts = [item, ...this.alerts];
    this.persist();
    this.emit('alerts', this.alerts);
    this.emit('subscriptions');
    return item;
  }

  updateAlert(id, patch) {
    this.alerts = this.alerts.map((a) => (a.id === id ? { ...a, ...patch } : a));
    this.persist();
    this.emit('alerts', this.alerts);
    this.emit('subscriptions');
  }

  removeAlert(id) {
    this.alerts = this.alerts.filter((a) => a.id !== id);
    this.persist();
    this.emit('alerts', this.alerts);
    this.emit('subscriptions');
  }

  /* --------------------------------------------------------------- settings */

  setSetting(key, value) {
    if (this.settings[key] === value) return;
    this.settings = { ...this.settings, [key]: value };
    this.persist();
    this.emit('settings', { key, value });
  }
}

export const store = new Store();
