// 底部导航玻璃的折射贴图：边缘向里取样、中间不弯折、蓝光折得最多（色散）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOffsets } from '../public/js/glass-refraction.js';

const W = 358;
const H = 62;
const { map, max, ratio } = computeOffsets(W, H);
const at = (x, y) => [map[(y * W + x) * 2], map[(y * W + x) * 2 + 1]];

test('折射贴图：边缘一圈向玻璃里面取样，越靠边弯得越多', () => {
  assert.ok(max > 20 && max < 40, `最大偏移 ${max}px`);
  const cx = Math.floor(W / 2);
  assert.ok(at(cx, 1)[1] > 20, '上边缘向下取样');
  assert.ok(at(cx, H - 2)[1] < -20, '下边缘向上取样');
  assert.ok(at(1, H / 2)[0] > 20, '左边缘向右取样');
  assert.ok(at(W - 2, H / 2)[0] < -20, '右边缘向左取样');
  assert.ok(at(cx, 2)[1] < at(cx, 1)[1] && at(cx, 8)[1] < at(cx, 2)[1], '离边缘越远弯得越少');
});

test('折射贴图：中间的平面和胶囊圆角外面都不偏移', () => {
  assert.deepEqual(at(Math.floor(W / 2), Math.floor(H / 2)).map(Math.abs), [0, 0]);
  assert.deepEqual(at(Math.floor(W / 2), 25).map(Math.abs), [0, 0]);
  assert.deepEqual(at(0, 0).map(Math.abs), [0, 0], '圆角外面');
});

test('色散：红光折得最少、蓝光最多（折射率 1.47 / 1.5 / 1.53）', () => {
  assert.equal(ratio[1], 1);
  assert.ok(ratio[0] < 1 && ratio[0] > 0.9, `红 ${ratio[0]}`);
  assert.ok(ratio[2] > 1 && ratio[2] < 1.1, `蓝 ${ratio[2]}`);
});

test('WebKit 兼容：滤镜区域按元素边框盒（objectBoundingBox），副本滚动时不换滤镜 id', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/js/glass-refraction.js', import.meta.url), 'utf8');
  // WebKit 里 HTML 元素的 user space 原点与 Chromium 不同，整套用 userSpaceOnUse 时滤镜区域落到别处、玻璃里什么都不显示
  assert.match(src, /filterUnits:\s*'objectBoundingBox'/);
  assert.doesNotMatch(src, /filterUnits:\s*'userSpaceOnUse'/);
  // 只有形状变化（applyShape）时才设置新的 filter: url()；每帧换 id 会让 Safari 每帧重建滤镜、滚动卡顿
  assert.equal((src.match(/box\.style\.filter\s*=/g) ?? []).length, 1);
});
