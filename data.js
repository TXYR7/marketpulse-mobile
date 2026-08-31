// data.js — 东方财富公开接口客户端封装（零后端，手机浏览器直连）
// 复用 D:\codex\server.js 的接口参数与字段口径；改为手机端直连 + 前端计算。

// B6:token 存取器——设置页可改且即时生效（免重启）。优先级：localStorage → MP_CONFIG → 内置默认。
let emaToken = (typeof localStorage !== 'undefined' && localStorage.getItem('mp_ema_token'))
  || (typeof window !== 'undefined' && window.MP_CONFIG && window.MP_CONFIG.emaToken)
  || '7eea3edcaed734bea9cbfc24409ed989';
export function setEmaToken(value) {
  const v = String(value || '').trim();
  emaToken = v
    || (typeof localStorage !== 'undefined' && localStorage.getItem('mp_ema_token'))
    || '7eea3edcaed734bea9cbfc24409ed989';
}
const EMA = {
  get token() { return emaToken; },
  pool(kind, date) {
    const ep = kind === 'up' ? 'getTopicZTPool' : kind === 'down' ? 'getTopicDTPool' : 'getTopicZBPool';
    const sort = kind === 'down' ? 'fund:asc' : 'fbt:asc';
    return `https://push2ex.eastmoney.com/${ep}?ut=${EMA.token}&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=${sort}&date=${date}`;
  },
  ulist(codes) {
    const secids = codes.map((c) => marketPrefix(c) + c).join(',');
    // `_` 缓存穿透：与桌面 server.js 口径一致——不加则 CDN/浏览器 HTTP 缓存可返回陈旧响应（主力/超大单冻结的根因之一）
    return `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f12,f14,f2,f17,f18,f62,f66&_=${Date.now()}`;
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

// B1:手动刷新是否需要重拉预期差报价。开盘价 09:25 集合竞价定型后同日缓存永有效；
// 仅 09:30 前手动刷才作废（此前 gap 可能基于昨收/缺开盘价）；回看历史日(manualDate)数据不变，永不作废。
export function shouldRefetchGap(now, manualDate) {
  if (manualDate) return false;
  const h = now.getHours();
  return h < 9 || (h === 9 && now.getMinutes() < 30);
}

// 在途请求共享：同 URL 并发请求只外呼一次（首刷期间切视图/开抽屉时，loadGap/fetchOpenPct/
// loadWatch/openSheet 的批量报价不再重复打同一接口）；settle 即出表，不缓存结果，不会吃到陈旧数据。
const inflightGetJSON = new Map();
async function getJSON(url, tries = 3, timeoutMs = 9000) {
  const existing = inflightGetJSON.get(url);
  if (existing) return existing;
  const promise = (async () => {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url, {
          headers: { accept: 'application/json,text/plain,*/*' },
          signal: AbortSignal.timeout(timeoutMs),
          cache: 'no-store', // 行情接口不吃任何层缓存：URL 已带 `_` 穿透 CDN，这里再禁浏览器 HTTP 缓存
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
  })();
  inflightGetJSON.set(url, promise);
  const release = () => inflightGetJSON.delete(url);
  promise.then(release, release);
  return promise;
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
  // 停牌/缺字段时东财可能返回 '-'：统一 toNum 清洗成 null，下游 toFixed/pctText 只判 null（fetchQuotes 已同口径）
  const zdp = toNum(row.zdp);
  const fund = toNum(row.fund);
  const hs = toNum(row.hs);
  const zbc = toNum(row.zbc) ?? 0;
  const ltsz = toNum(row.ltsz);
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
    // fbt 是 92500 这类数字，直显会渲染成「92500」；统一转 HH:MM:SS（fmtTime 与桌面 fmtSealTime 同口径）
    firstSealTime: row.fbt != null && row.fbt !== '' ? fmtTime(row.fbt) : '',
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
    amount: toNum(row.amount), // 成交额(元)
    circ: ltsz,
    circulatingValue: ltsz, // 流通市值(元)
    total: toNum(row.tshare),
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

// opts.tries / opts.timeoutMs 供调用方按场景调节：冷启动（无任何本地数据可先渲染）用
// fail-fast 配置快速给出离线态，热刷新（SWR 有旧数据垫底）保持完整重试韧性。
export async function fetchPools(date, opts = {}) {
  const tries = opts.tries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 9000;
  const settled = await Promise.allSettled([
    getJSON(EMA.pool('up', date), tries, timeoutMs),
    getJSON(EMA.pool('down', date), tries, timeoutMs),
    getJSON(EMA.pool('broken', date), tries, timeoutMs),
  ]);
  return mergePools(date, settled);
}

const ULIST_CHUNK = 60; // 单次 ulist secids 上限，超出的分块
// 分块后并发拉取（并发上限 6），避免 300+ 代码串行往返拖慢首屏；单块失败仅缺失该块，其余正常返回。
// opts 透传 fail-fast 参数（tries/timeoutMs）给 getJSON——抽屉后台补价等「有本地数据兜底」的调用方应传短超时。
// 停牌/缺字段时东财返回 '-'（字符串）：统一清洗成 null，下游 toFixed/fmtMoney 只判 null（曾致抽屉 toFixed 抛错打不开）。
const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
export async function fetchQuotes(codes, opts = {}) {
  const list = (codes || []).map(String);
  if (!list.length) return {};
  const chunks = [];
  for (let i = 0; i < list.length; i += ULIST_CHUNK) chunks.push(list.slice(i, i + ULIST_CHUNK));
  const out = {};
  let failedChunks = 0; // 单块失败不再纯静默：计数+warn，调用方(状态条/health)可见，避免资金流大面积缺失不可知
  let idx = 0;
  const worker = async () => {
    while (idx < chunks.length) {
      const ch = chunks[idx++];
      try {
        const data = await getJSON(EMA.ulist(ch), opts.tries ?? 3, opts.timeoutMs ?? 9000);
        for (const row of data?.data?.diff || []) {
          out[String(row.f12)] = {
            code: String(row.f12),
            name: row.f14,
            price: toNum(row.f2),
            open: toNum(row.f17),
            prevClose: toNum(row.f18),
            main: toNum(row.f62), // 主力净流入
            super: toNum(row.f66), // 超大单净流入
          };
        }
      } catch (e) {
        failedChunks += 1;
        console.warn('fetchQuotes 块失败(该块资金流缺失):', e?.message || e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, chunks.length) }, () => worker()));
  out.__failedChunks = failedChunks;
  return out;
}

// 轻量日K（仅供 S/A/B 梯队股的晋级评估：量能阶变/缺口保护维度），取近 lmt 根日线
// push2his 并发闸：竞价采集(9:15-9:30 与 K 线预热同窗)与 K 线预热都打 push2his，叠加会超浏览器单 host 6 连接上限
// → 排队/重置。模块级信号量共享上限 5，两类请求合流过闸。
const PUSH2HIS_MAX_CONCURRENCY = 5;
let push2hisActive = 0;
const push2hisQueue = [];
function withPush2HisSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      push2hisActive += 1;
      Promise.resolve().then(fn).then(
        (value) => { push2hisActive -= 1; nextPush2His(); resolve(value); },
        (error) => { push2hisActive -= 1; nextPush2His(); reject(error); }
      );
    };
    if (push2hisActive < PUSH2HIS_MAX_CONCURRENCY) run();
    else push2hisQueue.push(run);
  });
}
function nextPush2His() {
  if (push2hisActive < PUSH2HIS_MAX_CONCURRENCY && push2hisQueue.length) push2hisQueue.shift()();
}
const klineCacheByDate = new Map(); // code -> { dateKey, bars }
const KLINE_CACHE_CAP = 200; // 会话内防膨胀（抽屉 60 根日K 也进缓存，容量放宽避免翻页清缓存导致会话内重抓）
export async function fetchKlineLite(code, lmt = 8) {
  const secid = marketPrefix(code) + code;
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=${lmt}`;
  const data = await withPush2HisSlot(() => getJSON(url));
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
    // 停牌/缺字段时东财返回 '-'：清洗成 null，否则 r.price.toFixed 直接抛错、pctText 渲染 NaN%
    price: toNum(row.f2),
    changePct: toNum(row.f3),
    volume: toNum(row.f5), // 手
    amount: toNum(row.f6), // 元
    industry: row.f100 || '—',
    update: row.f124,
  }));
  return { total, page, pageSize, rows, market };
}

// 按名称/代码搜索（轻量；用于全市场搜索框）。B5:f2/f3 现价与涨跌幅——停牌 '-' 转 null 优雅降级
export function mapSearchRow(row) {
  return {
    code: String(row.f12),
    market: row.f13,
    name: row.f14,
    price: Number.isFinite(Number(row.f2)) ? Number(row.f2) : null,
    changePct: Number.isFinite(Number(row.f3)) ? Number(row.f3) : null,
  };
}
export async function searchStock(q) {
  const url = `https://push2.eastmoney.com/api/qt/search/get?fltt=2&key=${encodeURIComponent(q)}&fields=f12,f13,f14,f2,f3&ut=${EMA.token}`;
  const data = await getJSON(url);
  return (data?.data?.diff || []).map(mapSearchRow);
}

/* ---------------- 集合竞价（push2his trends/get 免费源，与桌面 server.js 同口径） ---------------- */
// 字段口径（2026-08-31 实测）：f2=YYMMDDHHMM；f3=价格×100；f8=参考价×1000（竞价段=昨收）；
// f14/f15=买卖未成交申报量（股；一字板撮合后 f14=涨停价真实排队买盘=9:25 真实封单）；f9=竞价成交额（元）；f10=竞价量（手）。
const AUCTION_CHUNK_SIZE = 4;      // push2his 对突发并发敏感（同 K 线结论），小批量+轮次间隔
const AUCTION_CHUNK_GAP_MS = 150;
const AUCTION_SNAPSHOT_MAX = 150;  // 昨日池上限（极端爆量日截断并诚实标注）
const AUCTION_CORE_MAX = 12;       // 核心票逐分钟过程采集上限

// 纯函数：trends/get 响应 → { minutes, matched }。按 f2 过滤当日 0915-0926 并升序（防御乱序/跨日段）。
// 与桌面 server.js:parseAuctionTrend 逐行同体（平行副本同步义务）。
export function parseAuctionTrend(payload, todayCompact = todayStr()) {
  const raw = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.data?.trends) ? payload.data.trends.map((line) => {
      // trends 字符串形态 "09:15,价,vol,amount" 与对象形态不同源，仅取时间+价两列作降级
      const parts = String(line).split(',');
      const hhmm = String(parts[0] || '').replace(':', '');
      return { f2: `${todayCompact.slice(2)}${hhmm}`, f3: Number(parts[1]) * 100 };
    }) : [];
  const dayKey = String(todayCompact).slice(2); // YYMMDD
  const points = raw
    .map((row) => ({ f2: String(row.f2 || ''), f3: Number(row.f3), f8: Number(row.f8), f9: Number(row.f9), f10: Number(row.f10), f14: Number(row.f14), f15: Number(row.f15) }))
    .filter((p) => p.f2.length >= 10 && p.f2.slice(0, 6) === dayKey)
    .map((p) => ({ ...p, hhmm: p.f2.slice(-4) }))
    .filter((p) => p.hhmm >= '0915' && p.hhmm <= '0926')
    .sort((a, b) => (a.hhmm < b.hhmm ? -1 : a.hhmm > b.hhmm ? 1 : 0));
  const minutes = [];
  let matched = null;
  for (const p of points) {
    const row = {
      hhmm: p.hhmm,
      price: Number.isFinite(p.f3) ? p.f3 / 100 : null,
      refPrice: Number.isFinite(p.f8) ? p.f8 / 1000 : null,
      bidShares: Number.isFinite(p.f14) ? p.f14 : null,
      askShares: Number.isFinite(p.f15) ? p.f15 : null
    };
    if (p.hhmm === '0926') matched = { price: row.price, amount: Number.isFinite(p.f9) ? p.f9 : null, volumeHands: Number.isFinite(p.f10) ? p.f10 : null, sealedBuyShares: row.bidShares };
    else minutes.push(row);
  }
  return { minutes, matched };
}

// 单票竞价趋势（抽屉 adhoc 亦用：trends/get 全天含竞价段，任意时点可取当日竞价过程）
export async function fetchAuctionTrend(code, opts = {}) {
  const secid = marketPrefix(code) + code;
  const url = `https://push2his.eastmoney.com/api/qt/stock/trends/get?ut=${EMA.token}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0&secid=${secid}&_=${Date.now()}`;
  const payload = await withPush2HisSlot(() => getJSON(url, opts.tries ?? 2, opts.timeoutMs ?? 8000));
  return parseAuctionTrend(payload);
}

// 近 N 根日K（任意 dateKey 缓存均可：日K 不可变，昨日缓存的 bar 今日依旧有效），剔除当日未定型 bar
export function lastBarsFor(code, todayCompact, n = 8) {
  const hit = klineCacheByDate.get(String(code));
  if (!hit) return [];
  const today = String(todayCompact).replace(/-/g, '');
  return hit.bars.filter((b) => String(b.date).replace(/-/g, '') !== today).slice(-n);
}

// 竞价量比：竞价量(手) / (近5日均量(手)/240)；K线与竞价量同为手，口径一致；缺 K 线返 null（诚实降级）
export function auctionVolRatio(bars = [], volumeHands = null) {
  if (!Number.isFinite(Number(volumeHands)) || Number(volumeHands) <= 0) return null;
  const vols = (bars || []).map((bar) => Number(bar.volume)).filter((v) => Number.isFinite(v) && v > 0);
  if (vols.length < 3) return null;
  const avg = vols.reduce((sum, v) => sum + v, 0) / vols.length;
  if (!avg) return null;
  return Number((Number(volumeHands) / (avg / 240)).toFixed(2));
}

// 核心票挑选：昨日池按连板数降序（移动端历史记录无封单额，同板按代码稳定排序），取前 N
export function pickAuctionCoreCodes(stocks = [], limit = AUCTION_CORE_MAX) {
  return [...stocks]
    .sort((a, b) => (Number(b.boards) || 1) - (Number(a.boards) || 1) || String(a.code).localeCompare(String(b.code)))
    .slice(0, Math.max(1, limit))
    .map((stock) => stock.code);
}

// 批量采集：mode='live' 只抓核心票逐分钟过程（≤12 只）；mode='final' 抓全池撮合终态（≤150 只）
// 与桌面 collectAuctionSnapshot 同体，仅量比数据源从 DB K线换为本地 K线缓存。
export async function collectAuctionSnapshot(mode = 'final', stocks = [], coreCodes = [], todayCompact = todayStr()) {
  const targets = mode === 'live'
    ? stocks.filter((stock) => coreCodes.includes(stock.code))
    : stocks.slice(0, AUCTION_SNAPSHOT_MAX);
  const byCode = new Map(targets.map((stock) => [stock.code, stock]));
  if (coreCodes.length && mode === 'final') for (const code of coreCodes) if (!byCode.has(code)) byCode.set(code, { code });
  const codes = [...byCode.keys()];
  const trends = new Map();
  let failed = 0;
  for (let offset = 0; offset < codes.length; offset += AUCTION_CHUNK_SIZE) {
    if (offset > 0) await new Promise((resolve) => setTimeout(resolve, AUCTION_CHUNK_GAP_MS));
    const chunk = codes.slice(offset, offset + AUCTION_CHUNK_SIZE);
    const settled = await Promise.allSettled(chunk.map((code) => fetchAuctionTrend(code)));
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') trends.set(chunk[index], result.value);
      else failed += 1;
    });
  }
  const items = [];
  const core = [];
  for (const [code, trend] of trends) {
    const stock = byCode.get(code) || {};
    const preClose = (trend.minutes[0]?.refPrice ?? trend.minutes[trend.minutes.length - 1]?.refPrice) ?? null;
    const matched = trend.matched;
    const livePrice = matched?.price ?? trend.minutes[trend.minutes.length - 1]?.price ?? null;
    const matchPct = matched?.price && preClose ? Number(((matched.price / preClose - 1) * 100).toFixed(2)) : null;
    const livePct = livePrice && preClose ? Number(((livePrice / preClose - 1) * 100).toFixed(2)) : null;
    const volRatio = auctionVolRatio(lastBarsFor(code, todayCompact), matched?.volumeHands ?? null);
    items.push({
      code, name: stock.name || null, boards: Number(stock.boards) || null,
      matched: Boolean(matched), matchPrice: matched?.price ?? null, matchPct, livePct,
      preClose, auctionAmount: matched?.amount ?? null, volumeHands: matched?.volumeHands ?? null,
      volRatio, sealedBuyShares: matched?.sealedBuyShares ?? null
    });
    if (coreCodes.includes(code)) core.push({ code, name: stock.name || null, boards: Number(stock.boards) || null, minutes: trend.minutes, matched });
  }
  return { date: String(todayCompact), mode, count: items.length, failed, truncated: mode === 'final' && stocks.length > AUCTION_SNAPSHOT_MAX, items, core };
}
