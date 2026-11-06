/** 服务端腾讯行情数据源：由 Node.js 代为请求上游，支持完整排行接口 */
import { createTencentProvider, extractJsVar } from '../../shared/tencent.js';
import { fetchJson, fetchText } from '../lib/http.js';

export const tencentProvider = createTencentProvider(
  {
    text: (url, encoding) => fetchText(url, { encoding }),
    json: (url) => fetchJson(url),
    script: async (url, name) => extractJsVar(await fetchText(url, { encoding: 'gbk' }), name),
  },
  { name: 'tencent', label: '腾讯财经', rankSource: 'board' },
);
