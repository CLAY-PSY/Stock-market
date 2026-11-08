/**
 * 手机 / 平板竖屏的「应用式」导航。
 *
 * 宽度 ≤ 899px 时页面一次只显示一个视图（自选 / 行情 / 排行），由底部导航栏切换；
 * 提醒、搜索以全屏面板打开。视图记录在 history.state 中：
 * - 从列表点进某只股票会新增一条历史记录，系统返回键 / 手势返回会回到列表；
 * - 打开面板时也会压入一条记录，返回键先关闭面板。
 * 桌面布局不受影响（CSS 只在窄屏下按视图隐藏区域）。
 */
import { $, $$ } from '../dom.js';

const MOBILE_QUERY = '(max-width: 899px)';
const mq = window.matchMedia(MOBILE_QUERY);
export const isMobile = () => mq.matches;

const VIEWS = new Set(['watch', 'quote', 'rank']);

export function initMobileNav({ hasInitialSymbol }) {
  const app = $('#app');
  const tabbar = $('#tabbar');
  const side = $('#side');
  const sheets = new Map(); // name -> close 回调
  let view = VIEWS.has(history.state?.view) ? history.state.view : hasInitialSymbol ? 'quote' : 'watch';
  let openSheetName = null;
  const listeners = new Set();

  /* ---------------------------------------- 主屏幕 App 液体玻璃导航（外观见 CSS .tab-thumb） */
  const thumb = tabbar.querySelector('.tab-thumb');
  let thumbIndex = null;
  // 切换标签时滑块带回弹滑过去，同时播放一次液态拉伸
  const moveThumb = (i) => {
    if (i === thumbIndex) return;
    const first = thumbIndex === null;
    thumbIndex = i;
    tabbar.style.setProperty('--tab-i', String(i));
    if (first || !thumb) return;
    thumb.classList.remove('morph');
    void thumb.offsetWidth; // 读一次布局，才能重新播放动画
    thumb.classList.add('morph');
  };
  thumb?.addEventListener('animationend', () => thumb.classList.remove('morph'));

  // 按住导航：滑块变成透镜（放大、更透）；手指处的触摸发光跟着手指走，并带亮整条玻璃
  const lit = [tabbar, thumb].filter(Boolean);
  const placeGlow = (e) => {
    for (const el of lit) {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--lx', `${e.clientX - r.left}px`);
      el.style.setProperty('--ly', `${e.clientY - r.top}px`);
    }
  };
  const release = () => {
    tabbar.classList.remove('pressing');
    lit.forEach((el) => el.classList.remove('lit'));
    document.removeEventListener('pointermove', placeGlow);
  };
  tabbar.addEventListener('pointerdown', (e) => {
    placeGlow(e);
    tabbar.classList.add('pressing');
    lit.forEach((el) => el.classList.add('lit'));
    document.addEventListener('pointermove', placeGlow, { passive: true });
  });
  document.addEventListener('pointerup', release);
  document.addEventListener('pointercancel', release);

  const syncTabs = () => {
    $$('button', tabbar).forEach((b, i) => {
      const active = openSheetName === 'alerts' ? b.dataset.view === 'alerts' : b.dataset.view === view;
      b.setAttribute('aria-current', active ? 'page' : 'false');
      if (active) moveThumb(i);
    });
  };

  /** 切换视图（不新增历史记录） */
  const apply = (next, { scroll = true } = {}) => {
    if (!VIEWS.has(next)) return;
    const changed = next !== view;
    view = next;
    app.dataset.view = next;
    syncTabs();
    if (changed && scroll && isMobile()) window.scrollTo(0, 0);
    if (changed) listeners.forEach((fn) => fn(next));
  };

  const remember = () => {
    history.replaceState({ ...(history.state ?? {}), view }, '', location.href);
  };

  const setView = (next) => {
    apply(next);
    remember();
  };

  /* ---------------------------------------------------------------- sheets */

  /** 打开全屏面板（搜索 / 提醒）：手机上压入一条历史记录，返回键即可关闭 */
  const openSheet = (name, close) => {
    sheets.set(name, close);
    openSheetName = name;
    syncTabs();
    if (isMobile() && history.state?.sheet !== name) {
      history.pushState({ ...(history.state ?? {}), view, sheet: name }, '', location.href);
    }
  };

  /** 面板已通过界面关闭：撤销对应的历史记录 */
  const sheetClosed = (name) => {
    if (openSheetName === name) openSheetName = null;
    sheets.delete(name);
    syncTabs();
    if (history.state?.sheet === name) history.back();
  };

  /* -------------------------------------------------------------- history */

  window.addEventListener('popstate', (e) => {
    const state = e.state ?? {};
    // 返回键关闭面板
    for (const [name, close] of [...sheets]) {
      if (state.sheet !== name) {
        sheets.delete(name);
        if (openSheetName === name) openSheetName = null;
        close();
      }
    }
    apply(VIEWS.has(state.view) ? state.view : 'quote');
  });

  /* ------------------------------------------------------------- controls */

  tabbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    const target = btn.dataset.view;
    if (target === 'alerts') {
      listeners.forEach((fn) => fn('alerts'));
      return;
    }
    // 在面板打开时点了底部导航：先关面板。先把历史记录里的面板标记去掉，
    // 这样 sheetClosed 不会再调用 history.back()（异步的 popstate 会把视图切回去）
    for (const [name, close] of [...sheets]) {
      sheets.delete(name);
      if (history.state?.sheet === name) history.replaceState({ ...history.state, sheet: undefined }, '', location.href);
      close();
    }
    openSheetName = null;
    setView(target);
  });

  // 盘口 / 成交明细切换（窄屏）
  $('#side-tabs').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (!v) return;
    side.dataset.tab = v;
    $$('#side-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
  });

  apply(view, { scroll: false });
  remember();

  return {
    get view() {
      return view;
    },
    apply,
    setView,
    openSheet,
    sheetClosed,
    onChange: (fn) => listeners.add(fn),
  };
}
