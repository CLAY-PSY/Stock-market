/**
 * 主屏幕 App 底部导航玻璃的边缘折射（Chrome / 安卓 与 iPhone Safari 都有）。
 *
 * 光学模型照搬「双色球 / 大乐透 随机选号」页的 WebGL 玻璃着色器：玻璃边缘是一圈超椭圆（squircle）形的
 * 凸起斜面——边缘处几乎竖直，往里平滑变平；视线在斜面上按斯涅尔定律向里折射，穿过玻璃厚度后落到背后的内容上；
 * 红、绿、蓝三色折射率不同（1.47 / 1.5 / 1.53），蓝光折得最多，边缘出现色散彩边。
 * 偏移量预先算进一张位移贴图，交给 SVG feDisplacementMap。
 *
 * 两条路：
 * 1. Chromium：backdrop-filter: url() 直接弯折导航背后的实时页面。
 * 2. Safari（iPhone）/ Firefox：不支持在 backdrop-filter 里引用 SVG 滤镜（WebKit bug 245510），
 *    改用 samasante/liquid-glass（MIT，https://github.com/samasante/liquid-glass）的思路「折射一份副本」：
 *    在导航玻璃正下方放一层导航大小的窗口，里面是与真实页面逐像素对齐的实时副本（滚动时平移，内容变化时重建，
 *    图表画布单独拷贝像素），对这一层用 filter: url()——Safari 支持对元素本身用 SVG 位移滤镜。
 *    照该项目的 BROWSERS.md 处理 WebKit 的几处问题：贴图只在形状变化时重算；内容变化时换新的滤镜 id
 *    （WebKit 按 id 缓存滤镜结果）；滤镜输入裁到导航大小、不超采样（WebKit 对滤镜输入尺寸有上限）。
 */
const NS = 'http://www.w3.org/2000/svg';
const IOR = [1.47, 1.5, 1.53]; // 红、绿、蓝的折射率
// 斜面宽度与玻璃厚度：导航只有 62px 高、背后是细小的文字，比选号页的大面板（28 / 80）窄一些、薄一些，
// 边缘一圈的内容明显弯折、带彩边，中间仍然清清楚楚
const BEZEL = 20;
const THICK = 48;

const isChromium = () => {
  const brands = navigator.userAgentData?.brands;
  return Array.isArray(brands) && brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand));
};

/** Chromium 能直接弯折背后的页面（Safari 的 CSS.supports 也会对 url() 报告支持，所以按内核判断） */
export function refractionSupported() {
  return isChromium() && typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'url(#a)');
}

/** 圆角矩形的有向距离：q 相对中心，b 为半宽高，r 为圆角；里面为负、外面为正（与选号页 sdBox 相同） */
function sdBox(qx, qy, bx, by, r) {
  const kx = Math.abs(qx) - bx + r;
  const ky = Math.abs(qy) - by + r;
  return Math.hypot(Math.max(kx, 0), Math.max(ky, 0)) + Math.min(Math.max(kx, ky), 0) - r;
}

/**
 * 计算 w×h 胶囊玻璃每个像素的取样偏移（px，按绿光），以及红 / 蓝相对绿光的偏移比例（色散）。
 * 返回 { map: Float32Array(dx, dy, ...), max, ratio: [红, 绿, 蓝] }。
 */
export function computeOffsets(w, h) {
  const bx = w / 2;
  const by = h / 2;
  const r = h / 2; // 胶囊：圆角为半高
  const bezel = Math.min(BEZEL, r - 2);
  const map = new Float32Array(w * h * 2);
  let max = 0;
  const ratioSum = [0, 0, 0];
  let ratioN = 0;
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
      const D = IOR.map((ior) => height * THICK * Math.tan(th - Math.asin(Math.sin(th) / ior))); // 斯涅尔定律
      const i = (y * w + x) * 2;
      map[i] = -nx * D[1]; // 向里取样（绿光）
      map[i + 1] = -ny * D[1];
      max = Math.max(max, Math.abs(D[1]));
      if (D[1] > 1) {
        ratioSum[0] += D[0] / D[1];
        ratioSum[2] += D[2] / D[1];
        ratioN += 1;
      }
    }
  }
  const ratio = ratioN ? [ratioSum[0] / ratioN, 1, ratioSum[2] / ratioN] : [1, 1, 1];
  return { map, max, ratio };
}

/** 把偏移编码成 feDisplacementMap 用的贴图（data: PNG）：R = x 偏移、G = y 偏移，128 为不偏移 */
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

function mapImage(url, w, h) {
  const image = el('feImage', { x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none', result: 'rawMap' });
  image.setAttribute('href', url);
  image.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url); // 较早的 Safari 只认 xlink:href
  return image;
}

function defsSvg() {
  const svg = el('svg', { width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false' });
  // 不能用 display:none：WebKit 里被隐藏的 <svg> 中的滤镜会失效
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  document.body.append(svg);
  return svg;
}

/**
 * 构建滤镜：一张位移贴图，按红 / 绿 / 蓝三种强度各弯一次，只留各自的颜色通道，再相加合成（形成色散彩边）。
 * 结构与 samasante/liquid-glass 的折射滤镜相同（arithmetic 合成在各内核里结果一致）。
 */
function buildFilter(svg, id, w, h) {
  const { map, max, ratio } = computeOffsets(w, h);
  const scale = Math.max(1, max * 2); // feDisplacementMap 的偏移 = scale × (贴图值 - 0.5)
  const filter = el('filter', {
    id,
    x: 0,
    y: 0,
    width: w,
    height: h,
    filterUnits: 'userSpaceOnUse',
    primitiveUnits: 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB', // 贴图数值不做伽马换算
  });
  filter.append(
    el('feFlood', { 'flood-color': 'rgb(128,128,128)', 'flood-opacity': 1, result: 'mapBg' }),
    mapImage(encode(map, w, h, max), w, h),
    el('feComposite', { in: 'rawMap', in2: 'mapBg', operator: 'over', result: 'map' }),
  );
  const channel = ['1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'];
  ['r', 'g', 'b'].forEach((c, k) => {
    filter.append(
      el('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: scale * ratio[k], xChannelSelector: 'R', yChannelSelector: 'G', result: `shift-${c}` }),
      el('feColorMatrix', { in: `shift-${c}`, type: 'matrix', values: channel[k], result: `only-${c}` }),
    );
  });
  filter.append(
    el('feComposite', { in: 'only-r', in2: 'only-g', operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0, result: 'rg' }),
    el('feComposite', { in: 'rg', in2: 'only-b', operator: 'arithmetic', k1: 0, k2: 1, k3: 1, k4: 0 }),
  );
  svg.replaceChildren(filter);
  return filter;
}

/* ------------------------------------------------------------ Chromium：弯折背后的实时页面 */

function initBackdrop(tabbar) {
  const svg = defsSvg();
  let size = '';
  let frame = 0;
  const update = () => {
    frame = 0;
    const w = Math.round(tabbar.offsetWidth);
    const h = Math.round(tabbar.offsetHeight);
    if (!w || !h || `${w}x${h}` === size) return;
    size = `${w}x${h}`;
    buildFilter(svg, 'tabbar-refraction', w, h);
    tabbar.classList.add('refract');
  };
  new ResizeObserver(() => {
    if (!frame) frame = requestAnimationFrame(update);
  }).observe(tabbar);
  update();
}

/* ---------------------------------------------- Safari（iPhone）：折射一份与页面对齐的实时副本 */

// 不在 #app 里、但会出现在导航背后的层（手机上的提醒页和它的遮罩）。
// 更高的层（提示条、弹窗、搜索）本来就盖在导航上面，不需要复制
const EXTRA_LAYERS = ['alerts-drawer', 'scrim'];
const QUIET_ATTRS = new Set(['title', 'aria-label', 'aria-live', 'aria-busy', 'aria-describedby', 'aria-labelledby']);

function initMirror(tabbar) {
  const app = document.getElementById('app');
  if (!app) return false;
  const layers = EXTRA_LAYERS.map((id) => document.getElementById(id)).filter(Boolean);
  const svg = defsSvg();

  // 副本层放在 <body> 末尾、紧贴在导航下面（层级 44 / 45）：
  // 页面上原有的元素都排在它前面，按 id 或类名查找时总是先找到真实页面
  const box = document.createElement('div');
  box.className = 'tab-mirror';
  box.setAttribute('aria-hidden', 'true');
  box.inert = true;
  const clip = document.createElement('div'); // 先裁到导航大小，滤镜的输入只有导航这么大（WebKit 对滤镜输入尺寸有上限）
  clip.className = 'tab-mirror-clip';
  const view = document.createElement('div'); // 代表整个屏幕：副本里的 fixed 层相对它定位
  view.className = 'tab-mirror-viewport';
  clip.append(view);
  box.append(clip);
  document.body.append(box);
  tabbar.classList.add('mirror');

  // 滤镜：只在形状（导航尺寸）变化时重算贴图；副本内容变化时换一个新 id 重新指向，
  // 否则 WebKit 会沿用按 id 缓存的旧结果，画面停住（samasante/liquid-glass 的做法）
  let filterEl = null;
  let version = 0;
  let size = '';
  const refreshFilter = () => {
    if (!filterEl) return;
    version += 1;
    filterEl.id = `tabbar-mirror-${version}`;
    box.style.filter = `url(#${filterEl.id})`;
  };
  const applyShape = () => {
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    if (!w || !h || `${w}x${h}` === size) return;
    size = `${w}x${h}`;
    filterEl = buildFilter(svg, 'tabbar-mirror', w, h);
    refreshFilter();
  };

  /* 副本：#app（导航换成占位，保持子元素序号一致）+ 提醒页、遮罩 */
  let page = null;
  let pairs = []; // [真实, 副本]
  let twins = new WeakMap();
  let canvases = [];
  const scrolled = new Set(); // 滚动过的内部区域（指数条、成交明细、提醒列表……）

  const twinOf = (node) => {
    if (twins.has(node)) return twins.get(node);
    let result = null;
    for (const [orig, copy] of pairs) {
      if (!orig.contains(node)) continue;
      const path = [];
      for (let n = node; n !== orig; n = n.parentElement) path.push(Array.prototype.indexOf.call(n.parentElement.children, n));
      result = copy;
      for (let i = path.length - 1; i >= 0 && result; i -= 1) result = result.children[path[i]] || null;
      break;
    }
    twins.set(node, result);
    return result;
  };

  // 克隆不带滚动位置和输入框的当前值，照着真实页面补上
  const syncScroll = () => {
    let changed = false;
    for (const node of scrolled) {
      if (!node.isConnected) {
        scrolled.delete(node);
        continue;
      }
      const twin = twinOf(node);
      if (!twin) continue;
      if (Math.abs(twin.scrollTop - node.scrollTop) >= 1) {
        twin.scrollTop = node.scrollTop;
        changed = true;
      }
      if (Math.abs(twin.scrollLeft - node.scrollLeft) >= 1) {
        twin.scrollLeft = node.scrollLeft;
        changed = true;
      }
    }
    return changed;
  };
  const syncFields = () => {
    for (const [orig, copy] of pairs) {
      const a = orig.querySelectorAll('input, select, textarea');
      const b = copy.querySelectorAll('input, select, textarea');
      a.forEach((f, i) => {
        const t = b[i];
        if (!t) return;
        if (t.value !== f.value) t.value = f.value;
        if ('checked' in f && t.checked !== f.checked) t.checked = f.checked;
      });
    }
  };

  // 图表是画布，克隆出来是空白的：导航附近的画布直接拷贝像素
  const copyCanvases = () => {
    const bar = box.getBoundingClientRect();
    const top = bar.top - THICK;
    const bottom = bar.bottom + THICK;
    let changed = false;
    for (const [orig, copy] of canvases) {
      if (!copy || !orig.width || !orig.height) continue;
      const r = orig.getBoundingClientRect();
      if (!r.width || r.bottom < top || r.top > bottom) continue;
      if (copy.width !== orig.width) copy.width = orig.width;
      if (copy.height !== orig.height) copy.height = orig.height;
      const ctx = copy.getContext('2d');
      if (!ctx) continue;
      ctx.clearRect(0, 0, copy.width, copy.height);
      ctx.drawImage(orig, 0, 0);
      changed = true;
    }
    return changed;
  };

  // 副本与真实页面逐像素对齐：屏幕层抵消导航的位置，页面层跟着滚动，提醒页按真实位置摆放
  let placed = '';
  const place = () => {
    if (!page) return false;
    const bar = box.getBoundingClientRect();
    const a = app.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const extra = layers.map((l) => (l.hidden ? '-' : (({ left, top, width, height }) => [left, top, width, height].join(' '))(l.getBoundingClientRect())));
    const key = [bar.left, bar.top, a.left, a.top, a.width, vw, vh, ...extra].join();
    if (key === placed) return false;
    placed = key;
    view.style.width = `${vw}px`;
    view.style.height = `${vh}px`;
    view.style.transform = `translate(${-bar.left}px, ${-bar.top}px)`;
    page.style.width = `${a.width}px`;
    page.style.transform = `translate(${a.left}px, ${a.top}px)`;
    pairs.slice(1).forEach(([orig, copy]) => {
      if (orig.hidden) return;
      const r = orig.getBoundingClientRect();
      Object.assign(copy.style, { top: `${r.top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px`, right: 'auto', bottom: 'auto' });
    });
    return true;
  };

  const rebuild = () => {
    const clone = app.cloneNode(false);
    for (const child of app.children) {
      if (child === tabbar) {
        const stub = document.createElement('nav'); // 占位：后面元素的序号与真实页面一致
        stub.hidden = true;
        clone.append(stub);
      } else {
        clone.append(child.cloneNode(true));
      }
    }
    clone.classList.add('tab-mirror-page');
    pairs = [[app, clone], ...layers.map((l) => [l, l.cloneNode(true)])];
    twins = new WeakMap();
    view.replaceChildren(...pairs.map(([, copy]) => copy));
    page = clone;
    const copies = clone.querySelectorAll('canvas');
    canvases = [...app.querySelectorAll('canvas')].map((c, i) => [c, copies[i]]);
    placed = '';
    place();
    syncFields();
    syncScroll();
    copyCanvases();
    refreshFilter();
  };

  const shown = () => !document.hidden && tabbar.getClientRects().length > 0;
  let frame = 0;
  const tick = () => {
    frame = 0;
    const visible = shown();
    if (box.hidden === visible) box.hidden = !visible;
    if (!visible || !page) return;
    const moved = place();
    const scrolledInside = syncScroll();
    if (moved || scrolledInside) refreshFilter();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };

  // 内容变化后重建副本：合并成批（0.15 秒），持续变化时最长 0.8 秒更新一次；
  // 正在滚动时稍等，避免掉帧（最多推迟到 1.5 秒）。看不见的元素（手机上隐藏的时钟等）变化不算
  let lastScroll = 0;
  let dirtySince = 0;
  let timer = 0;
  const pending = new Set();
  let force = false;
  const run = () => {
    timer = 0;
    if (!shown()) {
      // 回到前台 / 重新显示时再建
      box.hidden = true;
      return;
    }
    const now = performance.now();
    if (now - lastScroll < 120 && now - dirtySince < 1500) {
      timer = setTimeout(run, 120);
      return;
    }
    const needed = force || !page || [...pending].some((n) => n.isConnected && n.getClientRects().length > 0);
    pending.clear();
    force = false;
    dirtySince = 0;
    box.hidden = false;
    if (needed) rebuild();
  };
  const requestRebuild = (delay = 150) => {
    const now = performance.now();
    if (!dirtySince) dirtySince = now;
    clearTimeout(timer);
    timer = setTimeout(run, now - dirtySince > 800 ? 0 : delay);
  };
  const rebuildNow = () => {
    force = true;
    requestRebuild(0);
  };

  const observer = new MutationObserver((records) => {
    let dirty = false;
    for (const r of records) {
      if (tabbar.contains(r.target)) continue; // 导航自己的变化（滑块、透镜）不算
      if (r.type === 'attributes' && QUIET_ATTRS.has(r.attributeName)) continue; // 不影响画面的属性（隐藏时钟每秒更新的 title 等）
      // 变化所在的容器：它没显示出来，这次变化就看不见
      const host = r.type === 'childList' ? r.target : r.target.parentElement;
      if (!host) continue;
      if (pending.size < 64) pending.add(host);
      else force = true;
      dirty = true;
    }
    if (dirty) requestRebuild();
  });
  const watch = { subtree: true, childList: true, characterData: true, attributes: true };
  observer.observe(app, watch);
  layers.forEach((l) => observer.observe(l, watch));

  document.addEventListener(
    'scroll',
    (e) => {
      const t = e.target;
      lastScroll = performance.now();
      if (t instanceof Element && t !== document.documentElement && t !== document.body) {
        if (box.contains(t) || tabbar.contains(t)) return;
        scrolled.add(t);
      }
      schedule();
    },
    { capture: true, passive: true },
  );
  document.addEventListener('input', () => requestRebuild(), true);
  window.addEventListener('resize', () => {
    applyShape();
    rebuildNow();
  });
  new ResizeObserver(() => {
    applyShape();
    schedule();
  }).observe(box);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) rebuildNow();
  });
  window.visualViewport?.addEventListener('resize', schedule);
  // 图表重绘不会改动 DOM：定时把导航附近的画布拷过来；顺便核对一次位置（导航可能只移动、不改变大小）
  setInterval(() => {
    if (!page || !shown()) return;
    if (copyCanvases()) refreshFilter();
    schedule();
  }, 600);

  applyShape();
  rebuild();
  return true;
}

/**
 * 给底部导航加上边缘折射。Chromium 走 backdrop-filter；其它内核（iPhone Safari 等）折射实时副本。
 * 地址里带 ?glass=mirror 时在 Chromium 上也走副本，方便对照测试。
 * @returns 启用的方式：'backdrop' | 'mirror' | null
 */
export function initTabbarRefraction(tabbar) {
  if (!tabbar) return null;
  const forced = new URLSearchParams(location.search).get('glass');
  if (forced !== 'mirror' && refractionSupported()) {
    initBackdrop(tabbar);
    return 'backdrop';
  }
  if (typeof MutationObserver !== 'function' || typeof ResizeObserver !== 'function') return null;
  return initMirror(tabbar) ? 'mirror' : null;
}
