/**
 * 浏览器直连数据源（用于 GitHub Pages 等纯静态托管，没有 Node.js 服务端时）。
 *
 * 与服务端共用 shared/tencent.js 中的解析与业务逻辑，只替换网络访问方式：
 * - 报价 / 分时 / K 线 / 排行接口返回了 Access-Control-Allow-Origin: *，直接 fetch；
 * - 搜索与逐笔成交接口没有 CORS 头，但返回 `v_xxx=...` 形式的 JS：在隔离的 sandbox iframe 中
 *   用 <script> 标签加载后读取全局变量，再以纯数据传回（见 jsonp-frame.html）。
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

/*
 * 没有 CORS 的接口以 <script> 方式加载。第三方脚本不放在主页面里执行，而是交给一个
 * sandbox="allow-scripts" 的 iframe（jsonp-frame.html，独立的不透明源）：
 * 它拿不到本页面的 DOM、Cookie 与 localStorage，结果只以纯数据的形式通过 postMessage 传回。
 */
const FRAME_READY_TIMEOUT_MS = 8_000;
const pending = new Map(); // 请求 id → { resolve, reject, timer, url }
let frameReady = null;
let seq = 0;

function getFrame() {
  if (frameReady) return frameReady;
  frameReady = new Promise((resolve, reject) => {
    const el = document.createElement('iframe');
    el.setAttribute('sandbox', 'allow-scripts');
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('tabindex', '-1');
    el.title = '行情数据通道';
    el.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    const onMessage = (ev) => {
      if (ev.source !== el.contentWindow || !ev.source) return;
      const data = ev.data;
      if (data?.ready) {
        clearTimeout(readyTimer);
        resolve(el);
        return;
      }
      const req = pending.get(data?.id);
      if (!req) return;
      pending.delete(data.id);
      clearTimeout(req.timer);
      if (data.ok) req.resolve(data.value ?? null);
      else req.reject(new UpstreamError('无法连接行情接口', { url: req.url }));
    };
    const readyTimer = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      el.parentNode?.removeChild(el);
      frameReady = null; // 下次请求时重建
      reject(new UpstreamError('行情数据通道加载失败'));
    }, FRAME_READY_TIMEOUT_MS);
    window.addEventListener('message', onMessage);
    el.src = new URL('jsonp-frame.html', document.baseURI).href;
    document.body.append(el);
  });
  return frameReady;
}

async function loadScriptOnce(url, name) {
  const frame = await getFrame();
  return new Promise((resolve, reject) => {
    seq += 1;
    const id = seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new UpstreamError('行情接口请求超时', { url }));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, url });
    frame.contentWindow.postMessage({ id, url, name }, '*');
  });
}

/* 同名全局变量的请求必须串行，否则后一个脚本会覆盖前一个的结果 */
const scriptQueues = new Map();

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
