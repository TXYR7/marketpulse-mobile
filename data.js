// data.js — 东方财富公开接口客户端封装（零后端，手机浏览器直连）
// 复用 D:\codex\server.js 的接口参数与字段口径；改为手机端直连 + 前端计算。

const EMA = {
  // 东方财富公开 push2 token（非密钥）。可用 localStorage['mp_ema_token'] 或 window.MP_CONFIG.emaToken 覆盖。
  token: (typeof localStorage !== 'undefined' && localStorage.getItem('mp_ema_token'))
    || (typeof window !== 'undefined' && window.MP_CONFIG && window.MP_CONFIG.emaToken)
    || '7eea3edcaed734bea9cbfc24409ed989',
  pool(kind, date) {
    const ep = kind === 'up' ? 'getTopicZTPool' : kind === 'down' ? 'getTopicDTPool' : 'getTopicZBPool';
    const sort = kind === 'down' ? 'fund:asc' : 'fbt:asc';
    return `https://push2ex.eastmoney.com/${ep}?ut=${EMA.token}&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=${sort}&date=${date}`;
  },
  ulist(codes) {
    const secids = codes.map((c) => marketPrefix(c) + c).join(',');
    return `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f12,f14,f2,f17,f18,f62,f66`;
  }
};

function marketPrefix(code) {
  const c = String(code)[0];
  return (c === '6' || c === '5') ? '1.' : '0.'; // 沪市股票(6)/沪市基金(5)→1.，深市(0/3)→0.
}

// 上海时区（UTC+8，无夏令时）。把 epoch 偏移成「本地 getter 即上海墙钟」的 Date，
// 避免设备时区≠中国时区时交易时段判定/日期键漂移（与桌面 server.js:shanghaiClock 口径一致）。
const SHANGHAI_OFFSET_MS = 8 * 3600000;
export function shanghaiNow() {
  const n = new Date();
  return new Date(n.getTime() + SHANGHAI_OFFSET_MS + n.getTimezoneOffset() * 60000);
}
export function shanghaiOf(ts) {
  const n = new Date(ts);
  return new Date(n.getTime() + SHANGHAI_OFFSET_MS + n.getTimezoneOffset() * 60000);
}
export function todayStr(d = shanghaiNow()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtTime(n) {
  if (n == null) return '--';
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

async function getJSON(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json,text/plain,*/*' },
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    } catch (e) {
      lastErr = e;
      // 4xx（除 429 限流）重试无意义，直接失败；网络/超时/5xx 用带抖动的退避重试
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) break;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1) + Math.floor(Math.random() * 250)));
    }
  }
  throw lastErr;
}

// 封单质量：与桌面 server.js:sealQuality 保持同步（平行副本同步义务），供评分引擎读取 sealStars。
export function sealQuality({ sealAmount, circulatingValue, breakCount = 0 }) {
  if (sealAmount === null || sealAmount === undefined || sealAmount === '' || circulatingValue === null || circulatingValue === undefined || circulatingValue === '') return null;
  const seal = Number(sealAmount);
  const circ = Number(circulatingValue);
  if (!Number.isFinite(seal) || !Number.isFinite(circ) || circ <= 0 || seal < 0) return null;
  const ratio = (seal / circ) * 100;
  let stars = ratio >= 5 ? 5 : ratio >= 3 ? 4 : ratio >= 1.5 ? 3 : ratio >= 0.8 ? 2 : 1;
  stars = Math.max(1, stars - (Number(breakCount) || 0));
  return { ratio: Math.round(ratio * 100) / 100, stars, label: ['极弱', '弱', '一般', '强', '极强'][stars - 1] };
}

// 涨停/跌停/炸板池字段映射：同时暴露「移动端旧字段」与「桌面 analytics 期望字段」，便于评分逻辑直连。
// 字段口径与桌面 server.js:mapStocks 对齐，确保同一只股票在两端的归一化输入一致（否则评分分层会漂移）。
function mapPool(row) {
  const boards = Number(row.lbc || row.zttj?.ct || 1); // 与桌面一致：缺 lbc 时回退 zttj.ct，且 0 也视为有效
  const zdp = row.zdp;
  const fund = row.fund ?? null;
  const hs = row.hs;
  const zbc = row.zbc ?? 0;
  const ltsz = row.ltsz ?? null;
  const seal = sealQuality({ sealAmount: fund, circulatingValue: ltsz, breakCount: zbc });
  return {
    code: String(row.c),
    market: row.m,
    name: row.n,
    price: (row.p || 0) / 1000, // 池价格单位为厘，÷1000 得元
    changePct: zdp,
    changePercent: zdp,
    boards,
    firstSeal: row.fbt,
    firstSealTime: row.fbt,
    lastSeal: row.lbt,
    breaks: zbc,
    breakCount: zbc,
    turnover: hs,
    turnoverRate: hs,
    seal: fund,
    sealAmount: fund, // 封单资金(元)
    sealStars: seal ? seal.stars : null, // 桌面 mapStocks 计算，移动端此前缺失 → 封单维度被静默清零
    sealRatio: seal ? seal.ratio : null,
    sealLabel: seal ? seal.label : null,
    amount: row.amount ?? null, // 成交额(元)
    circ: ltsz,
    circulatingValue: ltsz, // 流通市值(元)
    total: row.tshare ?? null,
    industry: row.hybk || '未分类',
    zttj: row.zttj || null,
  };
}

// 合并三池请求结果（Promise.allSettled 形态）：任一源成功即返回部分数据并标记失败源，全败才抛错。
// 纯函数，便于离线回归测试。
export function mergePools(date, settled) {
  const val = (r) => (r && r.status === 'fulfilled' ? r.value : null);
  const up = val(settled[0]), down = val(settled[1]), broken = val(settled[2]);
  if (!up && !down && !broken) {
    const firstErr = settled.find((r) => r.status === 'rejected');
    throw (firstErr && firstErr.reason) || new Error('行情接口全部失败');
  }
  const ups = (up?.data?.pool || []).map(mapPool);
  const downs = (down?.data?.pool || []).map(mapPool);
  const brokens = (broken?.data?.pool || []).map(mapPool);
  const failed = [];
  if (!up) failed.push('涨停池');
  if (!down) failed.push('跌停池');
  if (!broken) failed.push('炸板池');
  return {
    date: up?.data?.qdate || down?.data?.qdate || broken?.data?.qdate || date,
    up: ups,
    down: downs,
    broken: brokens,
    upCount: up ? (up.data?.tc ?? ups.length) : 0,
    downCount: down ? (down.data?.tc ?? downs.length) : 0,
    brokenCount: broken ? (broken.data?.tc ?? brokens.length) : 0,
    sources: { up: !!up, down: !!down, broken: !!broken },
    partial: failed.length > 0,
    partialMissing: failed,
  };
}

export async function fetchPools(date) {
  const settled = await Promise.allSettled([
    getJSON(EMA.pool('up', date)),
    getJSON(EMA.pool('down', date)),
    getJSON(EMA.pool('broken', date)),
  ]);
  return mergePools(date, settled);
}

const ULIST_CHUNK = 60; // 单次 ulist secids 上限，超出的分块
// 分块后并发拉取（并发上限 6），避免 300+ 代码串行往返拖慢首屏；单块失败仅缺失该块，其余正常返回。
export async function fetchQuotes(codes) {
  const list = (codes || []).map(String);
  if (!list.length) return {};
  const chunks = [];
  for (let i = 0; i < list.length; i += ULIST_CHUNK) chunks.push(list.slice(i, i + ULIST_CHUNK));
  const out = {};
  let idx = 0;
  const worker = async () => {
    while (idx < chunks.length) {
      const ch = chunks[idx++];
      try {
        const data = await getJSON(EMA.ulist(ch));
        for (const row of data?.data?.diff || []) {
          out[String(row.f12)] = {
            code: String(row.f12),
            name: row.f14,
            price: row.f2,
            open: row.f17,
            prevClose: row.f18,
            main: row.f62, // 主力净流入
            super: row.f66, // 超大单净流入
          };
        }
      } catch (e) { /* 单块失败仅缺失该块数据，调用方按缺值降级 */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, chunks.length) }, () => worker()));
  return out;
}

// 轻量日K（仅供 S/A/B 梯队股的晋级评估：量能阶变/缺口保护维度），取近 lmt 根日线
const klineCacheByDate = new Map(); // code -> { dateKey, bars }
const KLINE_CACHE_CAP = 200; // 会话内防膨胀（抽屉 60 根日K 也进缓存，容量放宽避免翻页清缓存导致会话内重抓）
export async function fetchKlineLite(code, lmt = 8) {
  const secid = marketPrefix(code) + code;
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=${lmt}`;
  const data = await getJSON(url);
  const bars = (data?.data?.klines || []).map((line) => {
    const p = String(line).split(',');
    return { date: p[0], open: Number(p[1]), close: Number(p[2]), high: Number(p[3]), low: Number(p[4]), volume: Number(p[5]) };
  }).filter((b) => b.close > 0 && b.volume > 0);
  return bars;
}
export function cachedKlineBars(code, tradeDate) {
  const hit = klineCacheByDate.get(String(code));
  return hit && hit.dateKey === String(tradeDate) ? hit.bars : null;
}
export function storeKlineBars(code, tradeDate, bars) {
  if (!bars || !bars.length) return;
  if (klineCacheByDate.size > KLINE_CACHE_CAP) klineCacheByDate.clear();
  klineCacheByDate.set(String(code), { dateKey: String(tradeDate), bars });
}
// SW 重载后从 IndexedDB 水合，避免当日完整预热（历史日K 日内不变，dateKey 不匹配即自然 miss，安全）
export function hydrateKlineCache(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const [code, v] of Object.entries(obj)) {
    if (v && v.dateKey && Array.isArray(v.bars) && v.bars.length) klineCacheByDate.set(String(code), { dateKey: String(v.dateKey), bars: v.bars });
  }
}
export function exportKlineCache() {
  const out = {};
  for (const [code, v] of klineCacheByDate) out[code] = { dateKey: v.dateKey, bars: v.bars };
  return out;
}

// 全市场：clist 分页。market: '' | 'sh' | 'sz' | 'bj'
const FS_ALL = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
const FS_MAP = { '': FS_ALL, sh: 'm:1+t:2,m:1+t:23', sz: 'm:0+t:80,m:0+t:6', bj: 'm:0+t:81+s:2048' };
export async function fetchAllMarket({ market = '', page = 1, pageSize = 60, sort = 'f6', order = 'desc' } = {}) {
  const fs = FS_MAP[market] || FS_ALL;
  const po = order === 'desc' ? 0 : 1; // 0=降序 1=升序
  const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=${pageSize}&po=${po}&np=1&fltt=2&invt=2&fid=${sort}&fs=${encodeURIComponent(fs)}&fields=f12,f13,f14,f2,f3,f5,f6,f100,f124&ut=${EMA.token}`;
  const data = await getJSON(url);
  const total = data?.data?.total ?? 0;
  const rows = (data?.data?.diff || []).map((row) => ({
    code: String(row.f12),
    market: row.f13,
    name: row.f14,
    price: row.f2,
    changePct: row.f3,
    volume: row.f5, // 手
    amount: row.f6, // 元
    industry: row.f100 || '—',
    update: row.f124,
  }));
  return { total, page, pageSize, rows, market };
}

// 按名称/代码搜索（轻量；用于全市场搜索框）
export async function searchStock(q) {
  const url = `https://push2.eastmoney.com/api/qt/search/get?fltt=2&key=${encodeURIComponent(q)}&fields=f12,f13,f14&ut=${EMA.token}`;
  const data = await getJSON(url);
  return (data?.data?.diff || []).map((row) => ({
    code: String(row.f12),
    market: row.f13,
    name: row.f14,
  }));
}
