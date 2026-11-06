/**
 * 主题模式：跟随系统（auto）/ 浅色 / 深色。
 * 纯函数，便于测试；首屏的 boot.js 是普通脚本，里面有一份同样的最小实现。
 */
export const THEME_MODES = ['auto', 'light', 'dark'];
export const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
/** 浏览器地址栏 / 状态栏颜色，与 CSS 中 --panel 一致 */
export const THEME_COLOR = { light: '#ffffff', dark: '#11161f' };

/** 设置结构版本：v2 起主题支持「跟随系统」 */
export const SETTINGS_VERSION = 2;

export function normalizeThemeMode(mode) {
  return mode === 'light' || mode === 'dark' ? mode : 'auto';
}

/** 模式 + 系统偏好 → 实际使用的主题 */
export function resolveTheme(mode, systemPrefersLight) {
  const m = normalizeThemeMode(mode);
  if (m !== 'auto') return m;
  return systemPrefersLight ? 'light' : 'dark';
}

/** 主题按钮循环：跟随系统 → 浅色 → 深色 → 跟随系统 */
export function nextThemeMode(mode) {
  const i = THEME_MODES.indexOf(normalizeThemeMode(mode));
  return THEME_MODES[(i + 1) % THEME_MODES.length];
}

/**
 * 旧版设置迁移：v1 的主题按钮只有深 / 浅两档，点过一次就固定、再也回不到跟随系统，
 * 升级时统一恢复为「跟随系统」。
 */
export function migrateSettings(settings = {}) {
  const s = { ...settings };
  if ((Number(s.settingsVersion) || 1) < SETTINGS_VERSION) {
    s.theme = 'auto';
    s.settingsVersion = SETTINGS_VERSION;
  }
  s.theme = normalizeThemeMode(s.theme);
  return s;
}
