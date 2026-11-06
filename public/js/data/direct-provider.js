/**
 * 浏览器直连数据源（用于 GitHub Pages 等纯静态托管，没有 Node.js 服务端时）。
 *
 * 与服务端共用 shared/tencent.js 中的解析与业务逻辑，只替换网络访问方式：
 * - 报价 / 分时 / K 线 / 排行接口返回了 Access-Control-Allow-Origin: *，直接 fetch；
 * - 搜索与逐笔成交接口没有 CORS 头，但返回 `v_xxx=...` 形式的 JS，用 <script> 标签加载后读取全局变量。
 */
import { createTencentProvider } from '../../shared/tencent.js';
import { UpstreamError } from '../../shared/errors.js';

const TIMEOUT_MS = 10_000;

async function request(url) {
  let res;
  try {
    res = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new UpstreamError(err?.name === 'TimeoutError' ? '行情接口请求超时' : '无法连接行情接口', { url, cause: err });
  }
  if (!res.ok) throw new UpstreamError(`行情接口返回 HTTP ${res.status}`, { status: res.status, url });
  return res;
}

async function text(url, encoding = 'utf-8') {
  const res = await request(url);
  return new TextDecoder(encoding).decode(await res.arrayBuffer());
}

async function json(url) {
  const res = await request(url);
  try {
    return await res.json();
  } catch (err) {
    throw new UpstreamError('行情接口返回的数据格式异常', { url, cause: err });
  }
}

/* 同名全局变量的请求必须串行，否则后一个脚本会覆盖前一个的结果 */
const scriptQueues = new Map();

function clearGlobal(name) {
  try {
    delete window[name];
  } catch {
    window[name] = undefined;
  }
}

function loadScriptOnce(url, name) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      el.onload = null;
      el.onerror = null;
      el.parentNode?.removeChild(el);
    };
    timer = setTimeout(() => {
      done();
      clearGlobal(name);
      reject(new UpstreamError('行情接口请求超时', { url }));
    }, TIMEOUT_MS);
    el.onload = () => {
      const value = window[name];
      done();
      clearGlobal(name);
      resolve(value ?? null);
    };
    el.onerror = () => {
      done();
      reject(new UpstreamError('无法连接行情接口', { url }));
    };
    el.async = true;
    el.referrerPolicy = 'no-referrer';
    el.src = url;
    clearGlobal(name);
    document.head.append(el);
  });
}

function script(url, name) {
  const previous = scriptQueues.get(name) ?? Promise.resolve();
  const run = previous.then(
    () => loadScriptOnce(url, name),
    () => loadScriptOnce(url, name),
  );
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  scriptQueues.set(name, tail);
  tail.then(() => {
    if (scriptQueues.get(name) === tail) scriptQueues.delete(name);
  });
  return run;
}

export const directProvider = createTencentProvider(
  { text, json, script },
  { name: 'tencent-direct', label: '腾讯财经（浏览器直连）', rankSource: 'mobile' },
);
