import { tencentProvider } from './tencent.js';
import { mockProvider } from './mock.js';

const PROVIDERS = { tencent: tencentProvider, mock: mockProvider };

export function createProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`未知的数据源 "${name}"，可选：${Object.keys(PROVIDERS).join(' / ')}`);
  }
  return provider;
}
