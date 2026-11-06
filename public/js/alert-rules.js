/** 价格提醒规则（纯函数，便于测试） */

export const ALERT_TYPES = {
  priceAbove: { label: '价格 ≥', unit: 'price' },
  priceBelow: { label: '价格 ≤', unit: 'price' },
  pctAbove: { label: '涨幅 ≥', unit: 'pct' },
  pctBelow: { label: '跌幅 ≥', unit: 'pct' },
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function evaluateAlert(alert, quote) {
  if (!alert?.active || !quote || quote.noTrade) return false;
  const v = Number(alert.value);
  if (!Number.isFinite(v)) return false;
  // 缺少价格 / 涨跌幅时不判断（null <= 10 在 JS 里为 true，会误触发）
  switch (alert.type) {
    case 'priceAbove':
      return isNum(quote.price) && quote.price >= v;
    case 'priceBelow':
      return isNum(quote.price) && quote.price <= v;
    case 'pctAbove':
      return isNum(quote.changePct) && quote.changePct >= v;
    case 'pctBelow':
      return isNum(quote.changePct) && quote.changePct <= -Math.abs(v);
    default:
      return false;
  }
}

export function describeAlert(alert, decimals = 2) {
  const t = ALERT_TYPES[alert.type];
  if (!t) return '未知条件';
  const v = Number(alert.value);
  return t.unit === 'pct' ? `${t.label} ${Math.abs(v).toFixed(2)}%` : `${t.label} ${v.toFixed(decimals)}`;
}

export function validateAlertInput(type, raw) {
  const t = ALERT_TYPES[type];
  if (!t) return '请选择提醒条件';
  const v = Number(raw);
  if (raw === '' || raw === null || !Number.isFinite(v)) return '请输入有效的数值';
  if (t.unit === 'price' && v <= 0) return '价格必须大于 0';
  if (t.unit === 'pct' && (v <= 0 || v > 1000)) return '百分比应在 0 ~ 1000 之间';
  return null;
}
