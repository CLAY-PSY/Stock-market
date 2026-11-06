import { h, icons } from '../dom.js';

const root = () => document.getElementById('toasts');

/**
 * 轻提示。kind: info | success | warn | error | alert
 * duration 为 0 时需要手动关闭。
 */
export function toast(message, { kind = 'info', title, duration = 4000 } = {}) {
  const close = h('button', { class: 'toast-close', 'aria-label': '关闭', html: icons.close });
  const el = h(
    'div',
    { class: `toast toast-${kind}`, role: kind === 'error' || kind === 'alert' ? 'alert' : 'status' },
    h('div', { class: 'toast-body' }, title ? h('div', { class: 'toast-title' }, title) : null, h('div', { class: 'toast-msg' }, message)),
    close,
  );
  const dismiss = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  close.addEventListener('click', dismiss);
  root().append(el);
  // 最多保留 5 条
  while (root().children.length > 5) root().firstElementChild.remove();
  if (duration) setTimeout(dismiss, duration);
  return dismiss;
}
