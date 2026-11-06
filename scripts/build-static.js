/**
 * 生成可直接部署到 GitHub Pages（或任意静态托管）的站点。
 *
 *   node scripts/build-static.js [输出目录，默认 dist]
 *
 * 产物结构与 Node.js 服务端提供的 URL 完全一致：
 *   index.html / css / js     ← public/
 *   shared/                   ← shared/（服务端与浏览器共用的解析逻辑）
 *   vendor/lightweight-charts.mjs ← node_modules
 * 并把 index.html 中的运行模式写为 static，让页面直接在浏览器内请求行情接口。
 */
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 静态部署的内容安全策略：脚本只允许同源；浏览器直连的行情接口逐个列出；
 * 没有 CORS 的接口在同源的 sandbox iframe（jsonp-frame.html）里加载，见 public/js/data/direct-provider.js。
 */
export const STATIC_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https://qt.gtimg.cn https://web.ifzq.gtimg.cn https://ifzq.gtimg.cn https://proxy.finance.qq.com",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');
const require = createRequire(import.meta.url);

export async function buildStatic(outDir = path.join(root, 'dist')) {
  const out = path.resolve(outDir);
  // 输出目录会被清空：拒绝项目根目录、它的上级目录、文件系统根目录和用户主目录
  const forbidden = [root, path.parse(out).root, os.homedir()];
  if (forbidden.includes(out) || root.startsWith(out + path.sep)) {
    throw new Error(`拒绝使用该输出目录：${out}`);
  }
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  await cp(path.join(root, 'public'), out, { recursive: true });
  await cp(path.join(root, 'shared'), path.join(out, 'shared'), { recursive: true });

  const chartsDir = path.dirname(require.resolve('lightweight-charts/package.json'));
  await mkdir(path.join(out, 'vendor'), { recursive: true });
  await cp(
    path.join(chartsDir, 'dist/lightweight-charts.standalone.production.mjs'),
    path.join(out, 'vendor/lightweight-charts.mjs'),
  );

  const indexPath = path.join(out, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  const marker = '<meta name="stockpulse-mode" content="auto" />';
  const charset = '<meta charset="utf-8" />';
  if (!html.includes(marker)) throw new Error('index.html 中缺少 stockpulse-mode 标记');
  if (!html.includes(charset)) throw new Error('index.html 中缺少 charset 声明');
  await writeFile(
    indexPath,
    html
      .replace(marker, '<meta name="stockpulse-mode" content="static" />')
      // 静态托管（GitHub Pages）无法设置响应头，用 <meta> 声明内容安全策略
      .replace(charset, `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${STATIC_CSP}" />`),
  );

  // 关闭 GitHub Pages 的 Jekyll 处理，避免以下划线开头的文件被忽略
  await writeFile(path.join(out, '.nojekyll'), '');
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  const out = await buildStatic(target);
  console.log(`静态站点已生成：${path.relative(process.cwd(), out) || out}`);
}
