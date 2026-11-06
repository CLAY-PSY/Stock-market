/**
 * 默认自选：没有保存过自选的访问者（第一次打开、换了浏览器、清除了网站数据）
 * 从热门股票池中随机挑选一组，挑好后立即保存，之后每次打开都保持这组（见 store.js）。
 * 纯函数，不访问 DOM，便于测试。
 */

/** 股票池：[代码, 名称]。名称只在第一笔行情到达前显示，之后以行情接口返回的名称为准 */
export const WATCHLIST_POOL = {
  cn: [
    ['sh600519', '贵州茅台'],
    ['sz300750', '宁德时代'],
    ['sz002594', '比亚迪'],
    ['sh601318', '中国平安'],
    ['sh600036', '招商银行'],
    ['sz000858', '五粮液'],
    ['sh601899', '紫金矿业'],
    ['sh600900', '长江电力'],
    ['sh601988', '中国银行'],
    ['sh601398', '工商银行'],
    ['sh600276', '恒瑞医药'],
    ['sz000333', '美的集团'],
    ['sz000651', '格力电器'],
    ['sh600030', '中信证券'],
    ['sz300059', '东方财富'],
    ['sh688981', '中芯国际'],
    ['sh601888', '中国中免'],
    ['sz002415', '海康威视'],
    ['sh600309', '万华化学'],
    ['sz300760', '迈瑞医疗'],
    ['sh600887', '伊利股份'],
    ['sz002475', '立讯精密'],
    ['sh601012', '隆基绿能'],
    ['sh600050', '中国联通'],
  ],
  fund: [
    ['sh510300', '沪深300ETF华泰柏瑞'],
    ['sh510500', '中证500ETF南方'],
    ['sz159915', '创业板ETF易方达'],
    ['sh588000', '科创50ETF华夏'],
    ['sh510050', '上证50ETF华夏'],
  ],
  hk: [
    ['hk00700', '腾讯控股'],
    ['hk09988', '阿里巴巴-W'],
    ['hk03690', '美团-W'],
    ['hk01810', '小米集团-W'],
    ['hk09618', '京东集团-SW'],
    ['hk01211', '比亚迪股份'],
    ['hk00941', '中国移动'],
    ['hk00005', '汇丰控股'],
    ['hk01299', '友邦保险'],
    ['hk09999', '网易'],
    ['hk01024', '快手-W'],
    ['hk00388', '香港交易所'],
    ['hk02020', '安踏体育'],
  ],
  us: [
    ['usAAPL', '苹果'],
    ['usNVDA', '英伟达'],
    ['usTSLA', '特斯拉'],
    ['usMSFT', '微软'],
    ['usAMZN', '亚马逊'],
    ['usGOOGL', '谷歌-A'],
    ['usMETA', 'Meta Platforms'],
    ['usNFLX', '奈飞'],
    ['usAMD', '超威半导体'],
    ['usTSM', '台积电'],
    ['usBABA', '阿里巴巴'],
    ['usPDD', '拼多多'],
    ['usAVGO', '博通'],
    ['usBRK.B', '伯克希尔B'],
  ],
};

/** 每个分组挑选的数量（合计 13 只，与原先的默认自选数量一致），按 A 股 → ETF → 港股 → 美股排列 */
export const PICK_COUNT = { cn: 5, fund: 1, hk: 3, us: 4 };

/** 从数组中不重复地随机取 n 个（Fisher–Yates 洗牌的前 n 步） */
function sample(list, n, rand) {
  const copy = list.slice();
  const count = Math.min(n, copy.length);
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(rand() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

/**
 * 随机挑选一组默认自选。
 * @param rand 返回 [0, 1) 的随机数函数，测试时可传入固定序列
 * @returns {{ symbols: string[], names: Record<string, string> }}
 */
export function pickDefaultWatchlist(rand = Math.random) {
  const picked = Object.entries(PICK_COUNT).flatMap(([group, n]) => sample(WATCHLIST_POOL[group], n, rand));
  return {
    symbols: picked.map(([symbol]) => symbol),
    names: Object.fromEntries(picked),
  };
}
