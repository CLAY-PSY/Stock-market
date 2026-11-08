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
  /*
   * 仿 iOS 26：按住导航，选中滑块鼓成一个透镜跳到手指处，左右拖动跟着手指走，透镜里的图标放大显示；
   * 松手后弹回最近的标签并切换过去（轻点也走同一条路，带一下果冻效果）。
   * 位置 --tab-pos（0～3，可为小数）与透镜大小都是注册过的 CSS 变量，由 CSS 过渡做回弹。
   */
  const thumb = tabbar.querySelector('.tab-thumb');
  const buttons = $$('button', tabbar);
  const isGlass = () => Boolean(thumb) && document.documentElement.classList.contains('standalone') && isMobile();
  let thumbIndex = null;
  let thumbW = 0;
  const measure = () => {
    thumbW = (tabbar.clientWidth - 8) / buttons.length;
    tabbar.style.setProperty('--thumb-w', `${thumbW}px`);
  };
  new ResizeObserver(measure).observe(tabbar);
  measure();
  const setPos = (pos) => tabbar.style.setProperty('--tab-pos', pos.toFixed(3));

  // 切换标签时滑块带回弹滑过去，同时播放一次液态拉伸
  const moveThumb = (i) => {
    if (i === thumbIndex) return;
    const first = thumbIndex === null;
    thumbIndex = i;
    setPos(i);
    if (first || !thumb) return;
    thumb.classList.toggle('morph', false);
    void thumb.offsetWidth; // 读一次布局，才能重新播放动画
    thumb.classList.add('morph');
  };
  thumb?.addEventListener('animationend', () => thumb.classList.toggle('morph', false));

  // 透镜里的内容：一份对齐导航的图标 + 文字副本，放大后显示（第一次按下时再建，此时图标已经画好）
  let lensRow = null;
  const buildLens = () => {
    if (lensRow || !thumb) return;
    lensRow = document.createElement('div');
    lensRow.className = 'tab-lens';
    lensRow.setAttribute('aria-hidden', 'true');
    for (const b of buttons) {
      const item = document.createElement('span');
      item.className = 'tab-lens-item';
      const icon = b.querySelector('[data-icon] svg');
      if (icon) item.append(icon.cloneNode(true));
      const label = document.createElement('span');
      label.textContent = b.querySelectorAll(':scope > span')[1]?.textContent ?? '';
      item.append(label);
      lensRow.append(item);
    }
    thumb.append(lensRow);
  };

  // 透镜正下方的原图标挖空（由放大的副本代替），否则会叠出两层
  const updateHoles = () => {
    const l = thumb.getBoundingClientRect();
    for (const b of buttons) {
      const r = b.getBoundingClientRect();
      b.style.setProperty('--hole-a', `${(l.left - r.left).toFixed(1)}px`);
      b.style.setProperty('--hole-b', `${(l.right - r.left).toFixed(1)}px`);
    }
  };

  // 触摸发光：光晕跟着手指走，并带亮整条玻璃
  const lit = [tabbar, thumb].filter(Boolean);
  const placeGlow = (e) => {
    for (const el of lit) {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--lx', `${e.clientX - r.left}px`);
      el.style.setProperty('--ly', `${e.clientY - r.top}px`);
    }
  };

  let drag = null; // { id, pos }
  let frame = 0;
  let suppressClick = false;
  const posAt = (clientX) => {
    const r = tabbar.getBoundingClientRect();
    const p = (clientX - r.left - tabbar.clientLeft - 4) / thumbW - 0.5;
    return Math.min(buttons.length - 1, Math.max(0, p));
  };
  const loop = () => {
    updateHoles();
    frame = drag ? requestAnimationFrame(loop) : 0;
  };
  tabbar.addEventListener('pointerdown', (e) => {
    if (!isGlass() || e.button > 0) return;
    buildLens();
    measure();
    drag = { id: e.pointerId, pos: posAt(e.clientX) };
    tabbar.setPointerCapture?.(e.pointerId);
    setPos(drag.pos);
    tabbar.classList.add('dragging');
    placeGlow(e);
    lit.forEach((el) => el.classList.add('lit'));
    updateHoles();
    if (!frame) frame = requestAnimationFrame(loop);
  });
  tabbar.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.pos = posAt(e.clientX);
    setPos(drag.pos);
    placeGlow(e);
  });
  const finish = (e, commit) => {
    if (!drag || e.pointerId !== drag.id) return;
    const index = Math.round(drag.pos);
    drag = null;
    tabbar.classList.toggle('dragging', false);
    lit.forEach((el) => el.classList.toggle('lit', false));
    if (!commit) {
      setPos(thumbIndex ?? 0); // 被系统打断：回到原来的标签
      return;
    }
    setPos(index); // 弹回最近的标签
    // 由这里切换，接下来浏览器补发的 click 不再重复处理
    suppressClick = true;
    setTimeout(() => {
      suppressClick = false;
    }, 400);
    selectTab(buttons[index]);
  };
  tabbar.addEventListener('pointerup', (e) => finish(e, true));
  tabbar.addEventListener('pointercancel', (e) => finish(e, false));

  const syncTabs = () => {
    buttons.forEach((b, i) => {
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
    if (suppressClick) return;
    selectTab(e.target.closest('button[data-view]'));
  });

  function selectTab(btn) {
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
  }

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
