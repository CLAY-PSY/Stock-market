import { $, h, icons } from '../dom.js';
import { store } from '../store.js';
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

export function initAlerts({ onPick }) {
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
  let dialogSymbol = null;

  /* ------------------------------------------------------------ drawer */

  const openDrawer = () => {
    drawer.hidden = false;
    scrim.hidden = false;
    renderList();
    drawer.querySelector('[data-close]').focus();
  };
  const closeDrawer = () => {
    drawer.hidden = true;
    scrim.hidden = true;
  };

  $('#btn-alerts').addEventListener('click', openDrawer);
  drawer.querySelector('[data-close]').addEventListener('click', closeDrawer);
  scrim.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !drawer.hidden && !dialog.open) closeDrawer();
  });
  $('#btn-new-alert').addEventListener('click', () => openDialog(store.selected));
  soundEl.checked = store.settings.sound;
  soundEl.addEventListener('change', () => store.setSetting('sound', soundEl.checked));

  const renderBadge = () => {
    const n = store.alerts.filter((a) => a.active).length;
    badge.hidden = n === 0;
    badge.textContent = String(n);
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
        const title = h('div', { class: 'alert-title' }, store.nameOf(a.symbol), h('span', {}, displayCode(a.symbol)));
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
    if (!dialog.open) dialog.showModal();
    valueEl.focus();
    valueEl.select();
  }

  typeEl.addEventListener('change', () => {
    const q = store.quotes.get(dialogSymbol);
    valueEl.value = suggestValue(typeEl.value, q);
    valueEl.step = ALERT_TYPES[typeEl.value].unit === 'pct' ? '0.1' : q ? String(10 ** -q.decimals) : 'any';
    updateHelp();
  });
  valueEl.addEventListener('input', updateHelp);
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = validateAlertInput(typeEl.value, valueEl.value);
    if (err) {
      errorEl.textContent = err;
      valueEl.focus();
      return;
    }
    store.addAlert({ symbol: dialogSymbol, type: typeEl.value, value: Number(valueEl.value), note: noteEl.value.trim() });
    dialog.close();
    toast(`${store.nameOf(dialogSymbol)}：${describeAlert({ type: typeEl.value, value: Number(valueEl.value) })}`, {
      kind: 'success',
      title: '提醒已创建',
      duration: 3000,
    });
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        /* ignore */
      }
    }
    // 条件可能已经满足，立即检查一次
    const q = store.quotes.get(dialogSymbol);
    if (q) check([{ quote: q }]);
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
    if (!drawer.hidden) renderList();
  });
  store.on('alerts', renderList);
  renderBadge();

  return { openDialog };
}
