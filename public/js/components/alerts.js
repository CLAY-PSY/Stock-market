import { $, h, icons, prefersReducedMotion } from '../dom.js';
import { isMobile } from './mobile-nav.js';
import { store, MAX_ALERTS } from '../store.js';
import { fmtPrice, fmtPct, displayCode } from '../format.js';
import { ALERT_TYPES, describeAlert, evaluateAlert, validateAlertInput } from '../alert-rules.js';
import { toast } from './toast.js';

let audioCtx = null;
function beep() {
  try {
    audioCtx ??= new AudioContext();
    const now = audioCtx.currentTime;
    [0, 0.18].forEach((offset) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.15);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.16);
    });
  } catch {
    /* 浏览器不支持或未授权自动播放 */
  }
}

function notify(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag, icon: 'favicon.svg' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* 部分移动端浏览器只允许在 Service Worker 中创建通知 */
  }
}

/** 默认值：价格类给出 ±3% 的目标价，百分比类给 5%，避免一创建就立即触发 */
function suggestValue(type, q) {
  if (ALERT_TYPES[type].unit === 'pct') return '5';
  if (!q) return '';
  const factor = type === 'priceAbove' ? 1.03 : 0.97;
  return fmtPrice(q.price * factor, q.decimals);
}

export function initAlerts({ onPick, onDrawerChange = () => {} }) {
  const drawer = $('#alerts-drawer');
  const scrim = $('#scrim');
  const listEl = $('#alert-list');
  const badge = $('#alerts-badge');
  const dialog = $('#alert-dialog');
  const form = $('#alert-form');
  const typeEl = $('#alert-type');
  const valueEl = $('#alert-value');
  const noteEl = $('#alert-note');
  const helpEl = $('#alert-help');
  const errorEl = $('#alert-error');
  const soundEl = $('#alert-sound');
  const tabBadge = $('#tab-alerts-badge');
  let dialogSymbol = null;

  /* <dialog> 兼容：iOS Safari 15.4 以下没有 showModal，退化为普通浮层 */
  const nativeDialog = typeof dialog.showModal === 'function';
  const isDialogOpen = () => dialog.hasAttribute('open');
  const showDialog = () => {
    if (isDialogOpen()) return;
    if (nativeDialog) dialog.showModal();
    else {
      dialog.classList.add('dialog-fallback');
      dialog.setAttribute('open', '');
    }
  };
  const hideDialog = () => {
    if (nativeDialog) dialog.close();
    else dialog.removeAttribute('open');
  };

  /* ------------------------------------------------------------ drawer */

  let opener = null; // 打开抽屉前的焦点，关闭后还给它
  let closeTimer = null;
  const isDrawerOpen = () => !drawer.hidden && !drawer.classList.contains('closing');

  const finishClose = () => {
    clearTimeout(closeTimer);
    drawer.hidden = true;
    scrim.hidden = true;
    drawer.classList.remove('closing');
    scrim.classList.remove('closing');
  };

  const openDrawer = () => {
    if (isDrawerOpen()) return;
    if (!drawer.hidden) finishClose(); // 正在播放收起动画时又被打开
    const active = document.activeElement;
    opener = active && active !== document.body && !drawer.contains(active) ? active : null;
    drawer.hidden = false;
    scrim.hidden = false;
    document.documentElement.classList.add('sheet-open');
    $('#btn-alerts').setAttribute('aria-expanded', 'true');
    renderList();
    drawer.querySelector('[data-close]').focus({ preventScroll: true });
    onDrawerChange(true);
  };
  const closeDrawer = () => {
    if (!isDrawerOpen()) return;
    const focusWasInside = drawer.contains(document.activeElement) || document.activeElement === document.body;
    document.documentElement.classList.remove('sheet-open');
    $('#btn-alerts').setAttribute('aria-expanded', 'false');
    // 桌面：滑出后再隐藏；手机上它是一个「标签页」，直接切换；系统要求减少动态效果时也不播放
    if (!isMobile() && !prefersReducedMotion()) {
      drawer.classList.add('closing');
      scrim.classList.add('closing');
      closeTimer = setTimeout(finishClose, 170);
    } else {
      finishClose();
    }
    if (focusWasInside && opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
    onDrawerChange(false);
  };

  // 标题栏一直可见，再点一次 🔔 收起提醒
  $('#btn-alerts').addEventListener('click', () => (isDrawerOpen() ? closeDrawer() : openDrawer()));
  drawer.querySelector('[data-close]').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isDialogOpen()) {
      if (!nativeDialog) hideDialog(); // 原生 dialog 自己处理 Esc
    } else if (isDrawerOpen()) closeDrawer();
  });
  $('#btn-new-alert').addEventListener('click', () => openDialog(store.selected));
  soundEl.checked = store.settings.sound;
  soundEl.addEventListener('change', () => store.setSetting('sound', soundEl.checked));

  const renderBadge = () => {
    const n = store.alerts.filter((a) => a.active).length;
    for (const el of [badge, tabBadge]) {
      if (!el) continue;
      el.hidden = n === 0;
      el.textContent = String(n);
    }
  };

  const renderList = () => {
    renderBadge();
    if (drawer.hidden) return;
    if (!store.alerts.length) {
      listEl.replaceChildren(h('li', { class: 'empty' }, '暂无提醒。打开任意股票，点击「提醒」即可创建。'));
      return;
    }
    listEl.replaceChildren(
      ...store.alerts.map((a) => {
        const q = store.quotes.get(a.symbol);
        const decimals = q?.decimals ?? 2;
        const title = h(
          'button',
          { class: 'alert-title', type: 'button', title: '打开该股票' },
          store.nameOf(a.symbol),
          h('span', {}, displayCode(a.symbol)),
        );
        title.addEventListener('click', () => {
          onPick(a.symbol);
          closeDrawer();
        });
        const state = a.active
          ? `监控中${q ? ` · 现价 ${fmtPrice(q.price, decimals)}（${fmtPct(q.changePct)}）` : ''}`
          : `已触发 · ${new Date(a.triggeredAt).toLocaleString('zh-CN', { hour12: false })} @ ${fmtPrice(a.triggeredPrice, decimals)}`;
        const ops = h('div', { class: 'alert-ops' });
        if (!a.active) {
          const again = h('button', { class: 'icon-btn', type: 'button', title: '重新启用', 'aria-label': '重新启用', html: icons.refresh });
          again.addEventListener('click', () => store.updateAlert(a.id, { active: true, triggeredAt: null, triggeredPrice: null }));
          ops.append(again);
        }
        const del = h('button', { class: 'icon-btn', type: 'button', title: '删除', 'aria-label': '删除提醒', html: icons.trash });
        del.addEventListener('click', () => store.removeAlert(a.id));
        ops.append(del);
        return h(
          'li',
          { class: `alert-item${a.active ? '' : ' done'}` },
          title,
          h('div', { class: 'alert-cond' }, describeAlert(a, decimals), a.note ? ` · ${a.note}` : ''),
          h('div', { class: `alert-state${a.active ? '' : ' fired'}` }, state),
          ops,
        );
      }),
    );
  };

  /* ------------------------------------------------------------ dialog */

  const updateHelp = () => {
    const q = store.quotes.get(dialogSymbol);
    errorEl.textContent = '';
    if (!q) {
      helpEl.textContent = '';
      return;
    }
    const base = `当前价 ${fmtPrice(q.price, q.decimals)}，涨跌幅 ${fmtPct(q.changePct)}。`;
    const draft = { active: true, type: typeEl.value, value: valueEl.value };
    const already = valueEl.value !== '' && evaluateAlert(draft, q);
    helpEl.textContent = already ? `${base}当前已满足该条件，创建后会立即触发。` : base;
  };

  function openDialog(symbol) {
    dialogSymbol = symbol;
    const q = store.quotes.get(symbol);
    $('#alert-symbol').textContent = `${store.nameOf(symbol)}（${displayCode(symbol)}）`;
    typeEl.value = 'priceAbove';
    valueEl.value = suggestValue('priceAbove', q);
    valueEl.step = q ? String(10 ** -q.decimals) : 'any';
    noteEl.value = '';
    updateHelp();
    showDialog();
    valueEl.focus({ preventScroll: true });
    valueEl.select();
  }

  typeEl.addEventListener('change', () => {
    const q = store.quotes.get(dialogSymbol);
    valueEl.value = suggestValue(typeEl.value, q);
    valueEl.step = ALERT_TYPES[typeEl.value].unit === 'pct' ? '0.1' : q ? String(10 ** -q.decimals) : 'any';
    updateHelp();
  });
  valueEl.addEventListener('input', updateHelp);
  dialog.querySelector('[data-close]').addEventListener('click', hideDialog);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = validateAlertInput(typeEl.value, valueEl.value);
    if (err) {
      errorEl.textContent = err;
      valueEl.focus();
      return;
    }
    const created = store.addAlert({
      symbol: dialogSymbol,
      type: typeEl.value,
      value: Number(valueEl.value),
      note: noteEl.value.trim(),
    });
    if (!created) {
      errorEl.textContent = `提醒最多 ${MAX_ALERTS} 条，请先删除不需要的提醒`;
      return;
    }
    hideDialog();
    toast(`${store.nameOf(dialogSymbol)}：${describeAlert(created)}`, {
      kind: 'success',
      title: '提醒已创建',
      duration: 3000,
    });
    // 条件可能已经满足，立即检查一次（不等待通知授权弹窗，用户可能迟迟不点）
    const q = store.quotes.get(dialogSymbol);
    if (q) check([{ quote: q }]);
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }
    }
  });

  /* ------------------------------------------------------------ trigger */

  const check = (changes) => {
    for (const { quote } of changes) {
      for (const a of store.alerts) {
        if (a.symbol !== quote.symbol || !evaluateAlert(a, quote)) continue;
        store.updateAlert(a.id, { active: false, triggeredAt: Date.now(), triggeredPrice: quote.price });
        const title = `价格提醒：${quote.name}`;
        const body = `${describeAlert(a, quote.decimals)} 已触发，现价 ${fmtPrice(quote.price, quote.decimals)}（${fmtPct(quote.changePct)}）${a.note ? `\n${a.note}` : ''}`;
        toast(body, { kind: 'alert', title, duration: 0 });
        notify(title, body, a.id);
        if (store.settings.sound) beep();
      }
    }
  };

  store.on('quotes', (changes) => {
    check(changes);
    if (isDrawerOpen()) renderList();
  });
  store.on('alerts', renderList);
  renderBadge();

  return { openDialog, openDrawer, closeDrawer, isDrawerOpen };
}
