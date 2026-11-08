/**
 * 主屏幕 App 底部导航玻璃的边缘折射。
 *
 * 光学模型照搬「双色球 / 大乐透 随机选号」页的 WebGL 玻璃着色器：玻璃边缘是一圈超椭圆（squircle）形的
 * 凸起斜面——边缘处几乎竖直，往里平滑变平；视线在斜面上按斯涅尔定律向里折射，穿过玻璃厚度后落到背后的内容上；
 * 红、绿、蓝三色折射率不同（1.47 / 1.5 / 1.53），蓝光折得最多，边缘出现色散彩边。
 *
 * 选号页的背景是自己用 WebGL 画的，可以直接在着色器里取色；这里背后是页面内容，所以把每个位置的偏移量
 * 预先算进三张位移贴图（红 / 绿 / 蓝各一张），交给 SVG feDisplacementMap，经 backdrop-filter: url() 去弯折
 * 导航背后的内容。
 *
 * 只在 Chromium 内核（Chrome / Edge / 安卓）里启用：Safari 暂不支持在 backdrop-filter 里引用 SVG 滤镜
 * （WebKit bug 245510），而且它的 CSS.supports 也会对 url() 报告支持，所以按内核判断，不启用时保持纯 CSS 玻璃。
 */
const NS = 'http://www.w3.org/2000/svg';
const FILTER_ID = 'tabbar-refraction';
const IOR = [1.47, 1.5, 1.53]; // 红、绿、蓝的折射率
// 斜面宽度与玻璃厚度：导航只有 62px 高、背后是细小的文字，比选号页的大面板（28 / 80）弯得轻一些，免得文字扭成一团
const BEZEL = 16;
const THICK = 36;

export function refractionSupported() {
  const brands = navigator.userAgentData?.brands;
  const chromium = Array.isArray(brands) && brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand));
  return chromium && typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'url(#a)');
}

/** 圆角矩形的有向距离：q 相对中心，b 为半宽高，r 为圆角；里面为负、外面为正（与选号页 sdBox 相同） */
function sdBox(qx, qy, bx, by, r) {
  const kx = Math.abs(qx) - bx + r;
  const ky = Math.abs(qy) - by + r;
  return Math.hypot(Math.max(kx, 0), Math.max(ky, 0)) + Math.min(Math.max(kx, ky), 0) - r;
}

/**
 * 计算 w×h 的胶囊玻璃每个像素在三种颜色下的取样偏移（px）。
 * 返回 { maps: [Float32Array(dx,dy...) ×3], max }，max 为所有偏移的最大绝对值。
 */
export function computeOffsets(w, h) {
  const bx = w / 2;
  const by = h / 2;
  const r = h / 2; // 胶囊：圆角为半高
  const bezel = Math.min(BEZEL, r - 2);
  const maps = IOR.map(() => new Float32Array(w * h * 2));
  let max = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const qx = x + 0.5 - bx;
      const qy = y + 0.5 - by;
      const d = sdBox(qx, qy, bx, by, r);
      if (d > 0) continue; // 圆角外面
      const e = 1 - Math.min(Math.max(-d / bezel, 0), 1); // 离边缘多近：边缘 1，进入斜面宽度后为 0
      if (e <= 0.001) continue; // 中间的平面不折射
      // 边缘法线（朝外）：距离函数的差分
      let nx = sdBox(qx + 0.5, qy, bx, by, r) - sdBox(qx - 0.5, qy, bx, by, r);
      let ny = sdBox(qx, qy + 0.5, bx, by, r) - sdBox(qx, qy - 0.5, bx, by, r);
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      const lens = e * e;
      const u = Math.max(1 - lens * lens, 1e-6);
      const height = Math.sqrt(Math.sqrt(u)); // 超椭圆斜面的高度（0～1）
      const th = Math.atan((THICK / bezel) * e * e * e * u ** -0.75); // 表面倾角：边缘处接近 90°
      const i = (y * w + x) * 2;
      IOR.forEach((ior, c) => {
        const D = height * THICK * Math.tan(th - Math.asin(Math.sin(th) / ior)); // 斯涅尔定律：视线偏移多少 px
        maps[c][i] = -nx * D; // 向里取样
        maps[c][i + 1] = -ny * D;
        max = Math.max(max, Math.abs(D));
      });
    }
  }
  return { maps, max };
}

/** 把偏移编码成 feDisplacementMap 用的贴图：R = x 偏移、G = y 偏移，128 为不偏移 */
function encode(map, w, h, max) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let p = 0, i = 0; p < w * h; p += 1, i += 2) {
    img.data[p * 4] = 128 + (map[i] / max) * 127;
    img.data[p * 4 + 1] = 128 + (map[i + 1] / max) * 127;
    img.data[p * 4 + 2] = 128;
    img.data[p * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** 构建（或按新尺寸重建）滤镜：三张贴图各弯一种颜色，再按通道合成 */
function buildFilter(svg, w, h) {
  const { maps, max } = computeOffsets(w, h);
  const scale = Math.max(1, max * 2); // feDisplacementMap 的偏移 = scale × (贴图值 - 0.5)
  const filter = el('filter', {
    id: FILTER_ID,
    x: 0,
    y: 0,
    width: w,
    height: h,
    filterUnits: 'userSpaceOnUse',
    primitiveUnits: 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB', // 贴图数值不做伽马换算
  });
  const channel = ['1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'];
  ['r', 'g', 'b'].forEach((c, k) => {
    filter.append(
      el('feImage', { href: encode(maps[k], w, h, max), x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none', result: `map-${c}` }),
      el('feDisplacementMap', { in: 'SourceGraphic', in2: `map-${c}`, scale, xChannelSelector: 'R', yChannelSelector: 'G', result: `shift-${c}` }),
      el('feColorMatrix', { in: `shift-${c}`, type: 'matrix', values: channel[k], result: `only-${c}` }),
    );
  });
  filter.append(el('feBlend', { in: 'only-r', in2: 'only-g', mode: 'screen', result: 'rg' }), el('feBlend', { in: 'rg', in2: 'only-b', mode: 'screen' }));
  svg.replaceChildren(filter);
}

/**
 * 给底部导航加上边缘折射；导航尺寸变化（旋转屏幕）时重算贴图。
 * @returns 是否已启用
 */
export function initTabbarRefraction(tabbar) {
  if (!tabbar || !refractionSupported()) return false;
  const svg = el('svg', { width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false' });
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  document.body.append(svg);
  let size = '';
  let frame = 0;
  const update = () => {
    frame = 0;
    const w = Math.round(tabbar.offsetWidth);
    const h = Math.round(tabbar.offsetHeight);
    if (!w || !h || `${w}x${h}` === size) return;
    size = `${w}x${h}`;
    buildFilter(svg, w, h);
    tabbar.classList.add('refract');
  };
  new ResizeObserver(() => {
    if (!frame) frame = requestAnimationFrame(update);
  }).observe(tabbar);
  update();
  return true;
}
