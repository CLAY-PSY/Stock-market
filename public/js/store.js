/**
 * 全局状态 + 本地持久化（自选股、提醒、偏好设置）。
 * 组件通过 store.on(event, fn) 订阅变化，避免互相直接依赖。
 */
import { migrateSettings, SETTINGS_VERSION } from './theme.js';
import { createStateSanitizer, MAX_WATCHLIST, MAX_ALERTS } from './data/saved-state.js';
import { normalizeSymbol } from '../shared/symbols.js';
import { pickDefaultWatchlist } from './default-watchlist.js';

const { sanitizeSaved } = createStateSanitizer(normalizeSymbol);

export { MAX_WATCHLIST, MAX_ALERTS };

const STORAGE_KEY = 'stockpulse:v1';

/**
 * 多个标签页之间同步的设置（外观与提示音）。周期、指标、筛选、排行等属于各自页面的浏览状态，
 * 不同步，免得在一个标签页里切换周期时另一个标签页的图表跟着跳。
 */
const SHARED_SETTINGS = ['theme', 'colorMode', 'sound'];

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
    return null; // 隐私模式下不可用，或内容已损坏
  }
}

class Store {
  constructor() {
    // 本地保存的内容可能已损坏或被改动：逐项校验，不合法的回落到默认值
    const saved = sanitizeSaved(load());
    // 先迁移已保存的设置再合并默认值（否则默认值里的版本号会掩盖旧设置）
    const savedSettings = saved.settings ? migrateSettings(saved.settings) : {};
    this.settings = { ...DEFAULT_SETTINGS, ...savedSettings };
    if (saved.settings && saved.settings.settingsVersion !== SETTINGS_VERSION) this.persist();
    this.alerts = saved.alerts;
    this.quotes = new Map();
    this.names = new Map(Object.entries(saved.names)); // 代码 → 名称缓存，报价到达前用于展示
    // 没有保存过自选（第一次打开 / 换浏览器 / 清除了数据）：先留空，由 initDefaultWatchlist() 从实时活跃股中随机挑选
    this.watchlist = saved.watchlist ?? [];
    this.pickingDefault = !saved.watchlist;
    // 新访客默认打开上证指数，挑好自选后不会再跳到别的股票
    this.selected = saved.selected ?? this.watchlist[0] ?? 'sh000001';
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
    this.persistTimer = setTimeout(() => this.flush(), 200);
  }

  /** 立即写入（页面隐藏 / 关闭前调用，避免 200ms 防抖期间的改动丢失） */
  flush() {
    if (this.persistTimer == null) return; // 没有待写入的改动
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
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
  }

  /**
   * 另一个标签页保存了改动：同步自选、提醒、名称缓存与外观设置。
   * 否则本页下次保存时会用自己手里的旧列表把对方刚加的自选 / 提醒覆盖掉。
   * 当前选中的股票属于各自页面，不同步。
   */
  syncFromOtherTab(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const saved = sanitizeSaved(parsed);
    let subscriptionsChanged = false;
    for (const [symbol, name] of Object.entries(saved.names)) if (!this.names.has(symbol)) this.names.set(symbol, name);
    if (saved.watchlist && saved.watchlist.join(',') !== this.watchlist.join(',')) {
      this.watchlist = saved.watchlist;
      this.pickingDefault = false; // 对方已经挑好了默认自选，本页不再另挑一组
      this.emit('watchlist', this.watchlist);
      subscriptionsChanged = true;
    }
    if (JSON.stringify(saved.alerts) !== JSON.stringify(this.alerts)) {
      this.alerts = saved.alerts;
      this.emit('alerts', this.alerts);
      subscriptionsChanged = true;
    }
    const remote = saved.settings ? migrateSettings(saved.settings) : null;
    for (const key of SHARED_SETTINGS) {
      if (remote?.[key] === undefined || remote[key] === this.settings[key]) continue;
      this.settings = { ...this.settings, [key]: remote[key] };
      this.emit('settings', { key, value: remote[key] });
    }
    if (subscriptionsChanged) this.emit('subscriptions');
  }

  /**
   * 新访客的默认自选：从各市场实时活跃股中随机挑选，挑好后立即保存，之后每次打开保持不变。
   * @param load 返回各市场候选 { cn?: [{symbol, name}], ... }；取不到的市场使用备用股票池
   */
  async initDefaultWatchlist(load) {
    if (!this.pickingDefault) return null;
    let candidates = {};
    try {
      candidates = (await load()) ?? {};
    } catch {
      /* 全部失败：使用备用股票池 */
    }
    this.pickingDefault = false;
    let picked = null;
    // 挑选期间用户已经自己加了自选的，以用户的为准
    if (!this.watchlist.length) {
      picked = pickDefaultWatchlist(candidates);
      for (const [symbol, name] of Object.entries(picked.names)) if (!this.names.has(symbol)) this.names.set(symbol, name);
      this.watchlist = picked.symbols;
    }
    this.persist();
    this.emit('watchlist', this.watchlist);
    this.emit('subscriptions');
    return picked;
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

  /** @returns true 已加入；false 已在自选中；'full' 自选数量已达上限 */
  addToWatchlist(symbol, name) {
    if (name) this.names.set(symbol, name);
    if (this.inWatchlist(symbol)) return false;
    if (this.watchlist.length >= MAX_WATCHLIST) return 'full';
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

  /** @returns 新建的提醒；数量已达上限时返回 null */
  addAlert(alert) {
    if (this.alerts.length >= MAX_ALERTS) return null;
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

// 页面切到后台 / 关闭前把尚未写入的改动立即保存（手机上切走后页面可能直接被系统回收）
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => store.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) store.flush();
  });
  // 其它标签页写入了本地存储（本页自己写入时不会收到这个事件）
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && e.newValue) store.syncFromOtherTab(e.newValue);
  });
}
