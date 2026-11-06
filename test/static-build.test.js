// 验证 GitHub Pages 静态产物：模式标记、所有相对引用的文件都存在（部署在子路径下也不能有绝对路径）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildStatic } from '../scripts/build-static.js';

let tmp;
let out;

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'stockpulse-build-'));
  out = await buildStatic(path.join(tmp, 'site'));
});

after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])));
  return files.flat();
}

test('index.html 写为静态模式，资源均为相对路径', async () => {
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /<meta name="stockpulse-mode" content="static" \/>/);
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:)?\/\//.test(u));
  assert.ok(refs.length >= 4);
  for (const ref of refs) {
    assert.ok(!ref.startsWith('/'), `GitHub Pages 部署在子路径下，不能使用绝对路径：${ref}`);
    assert.ok(await exists(path.join(out, ref)), `缺少文件：${ref}`);
  }
  assert.ok(await exists(path.join(out, '.nojekyll')));
});

test('所有 JS 模块的相对 import 都能在产物中找到', async () => {
  const files = (await walk(out)).filter((f) => f.endsWith('.js') && !f.includes(`${path.sep}vendor${path.sep}`));
  assert.ok(files.length > 10);
  const re = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const spec = m[1] ?? m[2];
      assert.ok(!spec.startsWith('/'), `${path.relative(out, file)} 使用了绝对路径 ${spec}`);
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      assert.ok(await exists(target), `${path.relative(out, file)} 引用的 ${spec} 不存在`);
    }
  }
  assert.ok(await exists(path.join(out, 'vendor/lightweight-charts.mjs')));
});

test('PWA 清单：相对路径，引用的图标都存在', async () => {
  const manifest = JSON.parse(await readFile(path.join(out, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './', '部署在 /<仓库名>/ 子路径下，start_url 必须是相对路径');
  assert.equal(manifest.scope, './');
  assert.ok(manifest.icons.some((i) => i.sizes === '192x192'));
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    assert.ok(!icon.src.startsWith('/'), icon.src);
    assert.ok(await exists(path.join(out, icon.src)), `缺少图标 ${icon.src}`);
  }
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /viewport-fit=cover/, '需要 viewport-fit=cover 才能使用刘海屏安全区');
  assert.match(html, /name="format-detection" content="telephone=no/, 'iOS 不应把价格识别为电话号码');
});

test('拒绝危险的输出目录', async () => {
  await assert.rejects(() => buildStatic(path.resolve('.')), /拒绝/);
  await assert.rejects(() => buildStatic(os.homedir()), /拒绝/);
});

test('静态页面声明内容安全策略，第三方脚本在 sandbox iframe 中加载', async () => {
  const html = await readFile(path.join(out, 'index.html'), 'utf8');
  const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/.exec(html);
  assert.ok(m, '缺少 CSP meta');
  assert.ok(html.indexOf(m[0]) < html.indexOf('<script'), 'CSP 必须出现在所有脚本之前');
  const csp = m[1];
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  for (const host of ['qt.gtimg.cn', 'web.ifzq.gtimg.cn', 'proxy.finance.qq.com']) assert.ok(csp.includes(`https://${host}`), host);

  const frame = await readFile(path.join(out, 'jsonp-frame.html'), 'utf8');
  assert.match(frame, /<script src="js\/jsonp-frame.js"><\/script>/);
  assert.ok(await exists(path.join(out, 'js/jsonp-frame.js')));
  const provider = await readFile(path.join(out, 'js/data/direct-provider.js'), 'utf8');
  assert.match(provider, /setAttribute\('sandbox', 'allow-scripts'\)/, 'iframe 不能带 allow-same-origin');
  assert.doesNotMatch(provider, /allow-same-origin/);
});
