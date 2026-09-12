// app.js — 编排层：数据加载、刷新循环、导航、共享渲染、详情抽屉、历史补录
import { fetchPools, fetchQuotes, fetchKlineLite, cachedKlineBars, storeKlineBars, hydrateKlineCache, exportKlineCache, todayStr, fmtTime, shanghaiNow, shanghaiOf, setEmaToken, shouldRefetchGap, fetchAuctionTrend, collectAuctionSnapshot, pickAuctionCoreCodes, boardTag, isTradingDay, lastTradingDate } from './data.js';
import {
  calculateBreakRate, calculatePromotionStats, buildThemeRanking, rankCoreLeaders, rankOpportunities,
  calculateEmotionState, yesterdayPremium, buildRiskRadar, buildMarketStructure, buildPlan, buyTypeOf,
  buildExpectationGap, buildSignal, applyGate,
  assessPromotion, klineFeatures, cycleOf, winratePosition, contextNotes, stockSimilarCases
} from './analytics.js';
import { getWatch, putWatch, delWatch, clearWatch, getKV, setKV, getAllHistory, putHistory, pruneHistoryKeep } from './store.js';
import { renderOpportunity, renderLadder, renderStructure, esc, fmtMoney, pctClass, pctText, tierBadge, signalTag, setHTML, patchCardList } from './views.js'; // 2026-09-12 折叠版批:BD_LABELS 已随评分构成条删除(唯一调用方)
// 2026-09-11 一屏到底批:renderReview import 已随复盘视图整删(store.js 复盘数据层保留,旧记录不丢)

const state = {
  pools: null, quotes: {}, watch: [], view: 'intraday',
  refreshMs: 15000, manualDate: '', timer: null,
  emotion: null, themes: [], leaders: [], opportunities: null, riskRadar: null, structure: null, plan: null, breakRate: null, phase: null,
  lastPayload: null, history: [], historyLoading: false, historyLoaded: false,
  // 2026-09-11 一屏到底批:reviews/reviewsLoaded/trades 状态已随复盘+交易视图整删
  allMarket: null, marketPage: 1, gap: null, prevPremium: null,
  fromSnapshot: false, lastGoodAt: 0, lastSuccessAt: 0, lastErrorAt: 0, quotesAt: 0, lastFetchMs: null,
  openPctByCode: {}, openPctDate: '', promoInFlight: false, positionAdvice: null, mentalNotes: [],
  auction: null, auctionByCode: null, auctionPctByCode: {}, auctionMatchedSeen: 0, // 集合竞价：payload/单票索引/撮合涨幅 map/已见撮合数（首见触发重算）
  sheetCode: null, // 当前打开的详情抽屉（openSheet 设 / closeSheet 清）：后台补价与 promo 回填的守卫
  // 2026-09-11 一屏到底批:lastSignalSnapshot/notifySignals 已随通知链整删
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 并发限额执行：把 items 分给 limit 个 worker 并行处理（避免 24 次串行 K 线等重网络往返拖慢首屏）
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx], idx); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/* ---------------- 派生计算 ---------------- */
// state.history 恒为按日期升序（init/loadHistory 写入前已排序），派生结果按 history+交易日 缓存，
// 盘中每 tick 不再重复全量重算晋级率/昨板映射。
let histMemo = { key: '', promo: null, prevBoards: null, prevStocks: [] };
function historyDerived(poolsDate) {
  const h = state.history || [];
  const key = h.length + ':' + (h.length ? h[h.length - 1].date : '') + '|' + (poolsDate || '');
  if (histMemo.key !== key) {
    // prevStocks 取严格早于今日的最后一条（无兜底：无更早历史时宁缺毋滥，不拿今日自比得 flat）
    const prevRec = h.filter((x) => poolsDate && String(x.date) < String(poolsDate)).pop();
    histMemo = { key, promo: computePromotionFromHistory(h, poolsDate), prevBoards: prevDayBoards(h, poolsDate), prevStocks: prevRec?.stocks || [] };
  }
  return histMemo;
}
function computePromotionFromHistory(hist, today) {
  if (hist.length < 2) return { available: false, firstBoardRate: null, multiBoardRate: null, prevMaxBoard: null, prevMultiBoardCount: null };
  const prev = hist.filter((h) => today && String(h.date) < String(today)).pop() || hist[hist.length - 2];
  const prevStocks = prev.stocks || [];
  const prevMaxBoard = prevStocks.reduce((m, x) => Math.max(m, x.boards || 1), 0);
  const prevMulti = prevStocks.filter((x) => (x.boards || 1) > 1).length;
  const byBoard = new Map();
  for (let i = 1; i < hist.length; i += 1) {
    const r = calculatePromotionStats(hist[i - 1].stocks, hist[i].stocks);
    if (!r.available) continue;
    for (const g of r.byBoard) {
      if (!byBoard.has(g.board)) byBoard.set(g.board, { board: g.board, denominator: 0, promoted: 0 });
      const e = byBoard.get(g.board); e.denominator += g.denominator; e.promoted += g.promoted;
    }
  }
  const first = byBoard.get(1);
  const multiEntries = [...byBoard.values()].filter((g) => g.board >= 2);
  const multiDen = multiEntries.reduce((s, g) => s + g.denominator, 0);
  const multiProm = multiEntries.reduce((s, g) => s + g.promoted, 0);
  return {
    available: true,
    firstBoardRate: first && first.denominator ? Number((first.promoted / first.denominator * 100).toFixed(1)) : null,
    multiBoardRate: multiDen ? Number((multiProm / multiDen * 100).toFixed(1)) : null,
    prevMaxBoard, prevMultiBoardCount: prevMulti,
  };
}

function prevDayBoards(hist, today) {
  const prev = hist.filter((h) => today && String(h.date) < String(today)).pop() || hist[hist.length - 1];
  const map = {};
  (prev?.stocks || []).forEach((s) => { map[s.code] = s.boards; });
  return map;
}

function deriveSig(pools) {
  const up = pools.up || [];
  const hist = state.history || [];
  const hk = hist.length ? (hist[hist.length - 1].date + ':' + hist.length) : '-';
  // 含 breakCount：断板率/市场断板率依赖池内个股的炸板次数，回封（breakCount 0→N）不改变成员但改变指标，须入签名
  const codes = up.map((s) => s.code + ':' + (s.boards || 1) + ':' + (s.breakCount || 0)).sort().join(',');
  // 昨日溢价指纹：loadGap 报价到达后触发一次重算（此前 premium 为空 → 指标诚实显示 —）
  const prem = state.prevPremium && state.prevPremium.date === pools.date
    ? (state.prevPremium.firstBoardPremium + '/' + state.prevPremium.highBoardPremium) : '';
  // 竞价指纹：live→final 相变 / 撮合数据首落位时重算派生（health 竞价源、预期差/晋级评估吃撮合口径）
  const auc = state.auction && state.auction.available
    ? (state.auction.phase + ':' + state.auction.items.length + ':' + Object.keys(state.auctionPctByCode || {}).length) : '';
  return pools.date + '|' + up.length + '|' + codes + '|' + hk + '|' + prem + '|' + auc;
}
function computeDerived(pools) {
  // M4 结构签名记忆化：结构字段(boards/成员/日期/历史)日内稳定，派生结果恒定，跳过重算省 CPU（不碰实时价）
  // 返回布尔：true=完成（或早退但派生已有），false=签名相同早退——loadGap 溢价就绪后据此决定是否重渲染
  const sig = deriveSig(pools);
  if (sig === state.derivedSig && state.derived) {
    // 2026-09-08 评审批：早退 tick 上 refresh() 换进来的裸对象没有 tier/signal/role/themeSize——
    // 用上一轮富化暂存回填，否则卡片徽标消失、S/A/B 筛选清空、promoContextOf 上下文逐 tick 漂移 ~10 分
    const stash = state.enrichByCode || {};
    for (const s of pools.up || []) {
      const e = stash[s.code];
      if (!e) continue;
      if (s.tier === undefined) s.tier = e.tier;
      if (s.score === undefined) s.score = e.score;
      if (!s.signal) s.signal = e.signal;
      if (!s.gate) s.gate = e.gate;
      if (!s.role) s.role = e.role;
      if (s.themeName === undefined) s.themeName = e.themeName;
      if (s.themeScore === undefined) s.themeScore = e.themeScore;
      if (s.themeSize == null) s.themeSize = e.themeSize;
      if (!s.breakdown) s.breakdown = e.breakdown;
      if (!s.buyType) s.buyType = e.buyType;
    }
    state.lastPayload = state.derived.lastPayload;
    return false;
  }
  const up = pools.up || [];
  // 2026-09-08 评审批：缺源计数为 null（此前 0 会让情绪「跌停 0 家」绿灯、炸板率 0% 满乐观）——null 走 na 诚实降级
  const upCount = pools.sources && pools.sources.up === false ? null : (pools.upCount ?? up.length);
  const downCount = pools.sources && pools.sources.down === false ? null : (pools.downCount ?? (pools.down || []).length);
  const brokenCount = pools.sources && pools.sources.broken === false ? null : (pools.brokenCount ?? (pools.broken || []).length);
  const maxBoard = up.reduce((m, x) => Math.max(m, x.boards || 1), 0);
  const multiBoardCount = up.filter((x) => (x.boards || 1) > 1).length;
  const breakRate = calculateBreakRate({ limitUpCount: upCount ?? 0, brokenCount: brokenCount ?? 0, available: brokenCount !== null });
  const memo = historyDerived(pools.date);
  const promo = memo.promo;
  // G9 情绪三指标：市场断板率同步可算（池内炸板回封占比）；昨首板/昨高位溢价读 loadGap 落位的缓存（date 不匹配则诚实显示 —）
  const marketBreakRate = up.length ? Math.round(up.filter((s) => Number(s.breakCount) > 0).length / up.length * 100) : null;
  const premium = state.prevPremium && state.prevPremium.date === pools.date ? state.prevPremium : null;
  const emotion = calculateEmotionState({
    limitUpCount: upCount, limitDownCount: downCount, multiBoardCount, maxBoard, breakRate,
    firstBoardPromotionRate: promo.firstBoardRate, multiBoardPromotionRate: promo.multiBoardRate,
    previousMaxBoard: promo.prevMaxBoard, previousMultiBoardCount: promo.prevMultiBoardCount,
    marketBreakRate,
    firstBoardPremium: premium?.firstBoardPremium ?? null,
    highBoardPremium: premium?.highBoardPremium ?? null,
  });
  const phase = emotion.phase;
  const themes = buildThemeRanking(up, memo.prevStocks || []);
  const leaders = rankCoreLeaders(up, themes);
  const prevBoards = memo.prevBoards;
  up.forEach((s) => { s.buyType = buyTypeOf({ boards: s.boards, previousBoard: prevBoards[s.code] ?? null }); });
  const opportunities = rankOpportunities(up, { leaders, themes, phase });
  const riskRadar = buildRiskRadar({ stocks: up, leaders, emotion, breakRate, phase });

  const attach = (s) => {
    s.gate = applyGate(s, {
      emotionLevel: emotion.level, emotionPhase: phase, breakRate: breakRate.rate,
      score: s.score, themeScore: s.themeScore, riskItems: riskRadar.items,
      mode: s.buyType, phaseRisk: ['退潮初期', '退潮', '冰点'].includes(phase),
    });
    s.signal = buildSignal(s, { phase, breakRate: breakRate.rate });
    return s;
  };
  ['S', 'A', 'B'].forEach((k) => opportunities.tiers[k].forEach(attach));
  opportunities.eliminated.forEach(attach);

  // 把评级/信号写回原始池对象，供盘中列表与自选复用
  const byCode = {};
  ['S', 'A', 'B'].forEach((k) => opportunities.tiers[k].forEach((s) => { byCode[s.code] = s; }));
  opportunities.eliminated.forEach((s) => { byCode[s.code] = s; });
  up.forEach((s) => { const m = byCode[s.code]; if (m) Object.assign(s, { tier: m.tier, score: m.score, signal: m.signal, role: m.role, themeName: m.themeName, themeScore: m.themeScore, themeSize: m.themeSize, breakdown: m.breakdown }); });
  // 富化暂存：deriveSig 早退的 tick 上 refresh() 换进来的裸对象没有 role/themeSize——promoContextOf 据此兜底
  const enrichByCode = {};
  up.forEach((s) => { enrichByCode[s.code] = { tier: s.tier, score: s.score, signal: s.signal, gate: s.gate, role: s.role, themeName: s.themeName, themeScore: s.themeScore, themeSize: s.themeSize, breakdown: s.breakdown, buyType: s.buyType }; });
  state.enrichByCode = enrichByCode;

  const structure = buildMarketStructure({ stocks: up, themes, leaders });
  const plan = buildPlan({ phase, riskRadar, emotion, opportunities });

  // 交易体系 payload 级输出：养家赢面仓位档（情绪指数作赢面代理）+ 按阶段浮现的心法
  const promoCycle = cycleOf(phase);
  const positionAdvice = { ...winratePosition(emotion.emotionIndex), cycle: promoCycle, faultTolerance: promoCycle ? ({ '主升': 0.8, '修复': 0.5, '退潮': 0.15 })[promoCycle] : null };
  const mentalNotes = contextNotes({ phase, limit: 3 });

  Object.assign(state, { themes, leaders, opportunities, emotion, riskRadar, structure, plan, breakRate, phase, positionAdvice, mentalNotes });
  state.lastPayload = {
    tradeDate: pools.date, limitUpCount: upCount, limitDownCount: downCount,
    status: { phase: emotion.phase, level: emotion.level, emotionIndex: emotion.emotionIndex, maxBoard },
    stats: { breakRate }, themes, leaders, riskRadar, opportunities,
    health: {
      ok: !pools.partial,
      sources: (() => {
        // 集合竞价：增强源，仅在已有数据时列出（非竞价窗口不显示，避免决策助手误报「异常」）
        const sources = { '东方财富行情': { ok: !pools.partial, missing: pools.partialMissing || [] } };
        if (state.auction && state.auction.available && (state.auction.items || []).length) sources['集合竞价'] = { ok: true, missing: [] };
        return sources;
      })(),
      latencyMs: state.lastFetchMs, // 本轮 fetchPools 实测耗时（降延迟批：从恒 null 改为真实值，诊断页可见）
    },
  };
  state.derivedSig = sig;
  state.derived = { lastPayload: state.lastPayload };
  return true;
}

/* ---------------- 渲染：状态条 ---------------- */
function hhmm(ts) { const d = shanghaiOf(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function hhmmss(ts) { const d = shanghaiOf(ts); return hhmm(ts) + ':' + String(d.getSeconds()).padStart(2, '0'); }
function renderStatus() {
  const s = $('#statusStrip');
  if (!state.pools) { setHTML(s, '<div class="chip"><span>状态</span><strong>连接中</strong></div>'); return; }
  const p = state.pools;
  const maxBoard = p.up.reduce((m, x) => Math.max(m, x.boards || 1), 0);
  const em = state.emotion || {};
  // 数据新鲜度：正常显示更新时间(到秒)；只有快照时标注「快照」；最近一次刷新失败且无更新则提示
  const failed = state.lastErrorAt > state.lastSuccessAt;
  // 2026-09-12 合并批:更新时间并入顶栏日期旁(#freshAt),横幅 freshChip/风险 chip 删——
  // 风险 chip 显示的是阶段名与徽标重复且误标(阶段≠风险),风险本体=雷达星级
  const freshAt = $('#freshAt');
  if (freshAt) {
    if (failed) { freshAt.textContent = ' · 失败'; freshAt.className = 'fresh-at bad'; freshAt.title = '最近刷新失败,展示上次数据'; }
    else if (state.lastSuccessAt) { freshAt.textContent = ' · ' + hhmmss(state.lastSuccessAt); freshAt.className = 'fresh-at'; freshAt.title = '更新于 ' + hhmmss(state.lastSuccessAt) + (state.lastFetchMs != null ? ` · 本轮抓取 ${state.lastFetchMs}ms` : ''); }
    else if (state.lastGoodAt) { freshAt.textContent = ' · 快照 ' + hhmm(state.lastGoodAt); freshAt.className = 'fresh-at stale'; freshAt.title = '离线快照(未成功连上实时源)'; }
    else { freshAt.textContent = ''; freshAt.className = 'fresh-at'; freshAt.title = ''; }
  }
  const partialChip = p.partial && p.partialMissing && p.partialMissing.length
    ? '<div class="chip risk-mid"><span>缺源</span><strong>' + esc(p.partialMissing.join('/')) + '</strong></div>'
    : '';
  // 建议仓位档（养家赢面表，情绪指数作赢面代理）
  const pa = state.positionAdvice;
  const posChip = pa && pa.label !== '--'
    ? '<div class="chip ' + (pa.label === '观望' ? 'risk-mid' : 'sent') + '" title="' + esc((pa.cycle || '--') + '周期容错 ' + (pa.faultTolerance != null ? Math.round(pa.faultTolerance * 100) + '%' : '--') + ' · ' + pa.note) + '"><span>仓位</span><strong>' + esc(pa.label) + '</strong></div>'
    : '';
  const triple = '<div class="chip triple"><span>涨/跌/炸</span><strong><b class="up-c">' + (p.upCount ?? '--') + '</b><b>/</b><b class="down-c">' + (p.downCount ?? '--') + '</b><b>/</b><b>' + (p.brokenCount ?? '--') + '</b></strong></div>';
  const emoChip = '<div class="chip sent chip-emo" id="emoChip" role="button" tabindex="0" title="点击查看分指标明细"><span>情绪</span><strong>' + (em.emotionIndex ?? '--') + ' ›</strong></div>';
  const html = [
    emoChip,
    triple,
    posChip,
    partialChip,
  ].join('');
  // 2026-09-11 卡顿修:strip 签名守卫(结构态+各 chip 数据)——时间已移顶栏原地更新
  const sig = [em.emotionIndex, p.upCount, p.downCount, p.brokenCount, pa?.label, p.partial, (p.partialMissing || []).join('/')].join('|');
  if (s.__sig !== sig) { if (setHTML(s, html)) s.__sig = sig; }
  // 2026-09-10:阶段徽标分色(桌面 phase-badge 同款语义色)——旧版不分期全 teal,「分歧期」蓝底毫无警示感被吐槽丑
  const badge = $('#phaseBadge');
  badge.textContent = em.phase || '连接中';
  const lvl = em.level || 'yellow';
  badge.className = 'phase-badge ' + (lvl === 'green' ? 'ok' : lvl === 'red' ? 'bad' : 'warn');
  // 2026-09-11 拆解融合批:ladderHint 已随独立 section 删,最高板并入涨停池 hint
  $('#ztHint').textContent = '最高 ' + maxBoard + ' 板 · ' + (p.upCount != null ? '共 ' + p.upCount + ' 只' : '--');
}
// 2026-09-12 检查批:chip() 助手已删——顶栏合并批后零调用方(横幅四颗全是字面模板)

/* ---------------- 渲染：盘中涨停池 ---------------- */
// 竞价信息（卡片行/抽屉共用）：撮合口径优先，竞价中用虚拟价；回看历史日不显示（竞价仅当日有效）
function aucInfoOf(code) {
  if (state.manualDate || !state.auction?.available || !state.auctionByCode) return null;
  const it = state.auctionByCode.get(code);
  if (!it) return null;
  const pct = it.matched ? it.matchPct : (it.livePct ?? null);
  return pct == null ? null : { pct, matched: !!it.matched };
}
function ztCard(x) {
  const bcls = x.boards >= 4 ? 'boards-tag hi' : x.boards === 1 ? 'boards-tag b1' : 'boards-tag';
  const pv = x.promo && x.promo.available !== false ? x.promo : null;
  const pvc = pv ? (pv.verdict === '可接力' ? 'pass' : pv.verdict === '观望' ? 'warn' : 'fail') : '';
  const pvTip = pv ? esc(pv.score + ' 分 · ' + ((pv.hardFails || []).length ? pv.hardFails.join('；') : '点开看八维检查表')) : '';
  const auc = aucInfoOf(x.code);
  return '<div class="card" data-code="' + x.code + '" data-boards="' + (x.boards || 1) + '">' + // data-boards 供板位条点格定位(2026-09-11 拆解融合批)
    '<div class="' + bcls + '">' + (x.boards || 1) + '板</div>' +
    '<div><div class="name">' + esc(x.name) + boardTag(x.code) + '</div>' +
    '<div class="code">' + x.code + ' · ' + esc(x.industry) + (x.role && x.role !== '后排' ? ' · ' + esc(x.role) : '') + '</div>' +
    (auc ? '<div class="auc">竞价 <b class="' + pctClass(auc.pct) + '">' + pctText(auc.pct) + '</b><em>' + (auc.matched ? '撮合' : '虚拟') + '</em></div>' : '') + '</div>' +
    '<div class="right">' +
    (pv ? '<span class="promo-badge ' + pvc + '" title="' + pvTip + '">' + esc(pv.verdict) + '</span> ' : '') +
    (x.tier ? tierBadge(x.tier) : '') + (x.signal ? '<div style="margin-top:4px">' + signalTag(x.signal.state) + '</div>' : '') +
    '<div class="price" style="margin-top:4px">' + (x.price ? x.price.toFixed(2) : '--') + '</div>' +
    '<div class="pct ' + pctClass(x.changePct) + '">' + pctText(x.changePct) + '</div>' +
    '<div class="meta">封 ' + fmtMoney(x.seal) + ' · 换 ' + (x.turnover != null ? x.turnover.toFixed(1) + '%' : '--') + '</div></div>' +
    '</div>';
}
function filterZt() {
  // 2026-09-10 减法批:搜索/排序/过滤 UI 已砍——固定连板降序·封单次序(与连板梯队视角一致)
  const p = state.pools;
  if (!p) return [];
  return p.up.slice().sort((a, b) => (b.boards || 1) - (a.boards || 1) || (b.seal || 0) - (a.seal || 0));
}
// 涨停池卡片签名：结构（连板数/评级/信号/角色/自选星/晋级结论/竞价行）变了才整卡重建；数值（价/涨跌/封单/换手）变了只原地改字段
function ztStructSig(x) {
  const pv = x.promo && x.promo.available !== false ? x.promo.verdict : '';
  const auc = aucInfoOf(x.code);
  const aucKey = auc ? (auc.pct + (auc.matched ? 'm' : 'v')) : '';
  return [x.boards || 1, x.tier || '', x.signal ? x.signal.state : '', x.role || '', pv, aucKey].join('|');
}
function pctFieldSig(x) { return [x.price ?? '', x.changePct ?? '', x.seal ?? '', x.turnover ?? ''].join('|'); }
function downFieldSig(x) { return [x.price ?? '', x.changePct ?? '', x.turnover ?? ''].join('|'); }
function patchPricePct(node, x) {
  const pc = pctClass(x.changePct);
  const priceEl = node.querySelector('.price');
  if (priceEl) {
    const pt = x.price ? x.price.toFixed(2) : '--';
    if (priceEl.textContent !== pt) priceEl.textContent = pt;
    if (priceEl.className !== 'price ' + pc) priceEl.className = 'price ' + pc;
  }
  const pctEl = node.querySelector('.pct');
  if (pctEl) {
    const pv = pctText(x.changePct);
    if (pctEl.textContent !== pv) pctEl.textContent = pv;
    if (pctEl.className !== 'pct ' + pc) pctEl.className = 'pct ' + pc;
  }
}
function patchZtCard(node, x) {
  patchPricePct(node, x);
  const metaEl = node.querySelector('.meta');
  if (metaEl) {
    const mt = '封 ' + fmtMoney(x.seal) + ' · 换 ' + (x.turnover != null ? x.turnover.toFixed(1) + '%' : '--');
    if (metaEl.textContent !== mt) metaEl.textContent = mt;
  }
}
function patchDownCard(node, x) {
  patchPricePct(node, x);
  const metaEl = node.querySelector('.meta');
  if (metaEl) {
    const mt = '换 ' + (x.turnover != null ? x.turnover.toFixed(1) + '%' : '--');
    if (metaEl.textContent !== mt) metaEl.textContent = mt;
  }
}
function showOfflineEmpty(err) {
  // 冷启动拉不到数据且无任何池（含快照水合失败）：清掉骨架屏给显式离线态，替代无限 shimmer
  const msg = err && err.message ? String(err.message) : '网络不可用或接口暂不可达';
  const tokenIssue = err && (err.status === 401 || err.status === 403); // getJSON 抛错带 .status
  setHTML($('#ztList'), '<div class="empty">暂无行情数据<br /><span class="muted">' + esc(msg) + '</span>' +
    (tokenIssue ? '<br /><span style="color:var(--amber)">Token 可能失效：设置 → 数据接口 Token 更换后重试</span>' : '') +
    '<br /><button class="btn" id="retryBtn" style="flex:0 0 auto;margin:14px auto 0;padding:0 22px">↻ 重试</button></div>');
  $('#ztList').__seq = '';
  $('#ztHint').textContent = '--';
}
function renderZt() {
  const list = $('#ztList');
  if (!state.pools) return; // 首屏骨架由 index.html 提供，数据到达前不覆盖
  const rows = filterZt();
  // 2026-09-11 拆解融合批:最高板并入此 hint(梯队 section 已删);updateBanner 与此处同写,口径一致
  const maxB = state.pools.up.reduce((m, x) => Math.max(m, x.boards || 1), 0);
  $('#ztHint').textContent = '最高 ' + maxB + ' 板 · ' + (state.pools.upCount != null ? '共 ' + state.pools.upCount + ' 只' : '--');
  patchCardList(list, rows, ztCard, ztStructSig, pctFieldSig, patchZtCard);
}
function downCard(x) {
  return '<div class="card" data-code="' + x.code + '">' +
    '<div class="boards-tag b1">' + (x.boards || 1) + '板</div>' +
    '<div><div class="name">' + esc(x.name) + '</div><div class="code">' + x.code + ' · ' + esc(x.industry) + '</div></div>' +
    '<div class="right"><div class="price">' + (x.price ? x.price.toFixed(2) : '--') + '</div>' +
    '<div class="pct ' + pctClass(x.changePct) + '">' + pctText(x.changePct) + '</div>' +
    '<div class="meta">换 ' + (x.turnover != null ? x.turnover.toFixed(1) + '%' : '--') + '</div></div></div>';
}
function renderDowns() {
  const p = state.pools; if (!p) return;
  $('#dtCount').textContent = p.downCount != null ? p.downCount : '--';
  $('#zbCount').textContent = p.brokenCount != null ? p.brokenCount : '--';
  // 折叠时不构建内部 DOM（炸板池常 50~150 行），首次展开才渲染
  if ($('#dtFold').open) patchCardList($('#dtList'), p.down, downCard, (x) => (x.boards || 1), downFieldSig, patchDownCard, '<div class="empty">今日无跌停</div>');
  if ($('#zbFold').open) patchCardList($('#zbList'), p.broken, downCard, (x) => (x.boards || 1), downFieldSig, patchDownCard, '<div class="empty">今日无炸板</div>');
}
// 2026-09-11 拆解融合批:题材/龙头折叠组展开才渲染(同 dtFold 惰性口径);驾驶舱 hero 已删,structure 只出龙头+题材
function renderStructFold() {
  const hint = $('#structHint');
  if (hint) hint.textContent = state.themes?.length ? state.themes.length + ' 条主线' : '--';
  if (!$('#structFold').open) return;
  renderStructure({ state, toast, actions: { loadHistory } });
}

/* ---------------- 昨日涨停 · 今日开盘预期差 ---------------- */
function renderGap(gap) {
  const sum = $('#gapSummary');
  const c = gap.counts || { beat: 0, meet: 0, miss: 0 };
  sum.textContent = `超 ${c.beat} / 符 ${c.meet} / 不及 ${c.miss}` + (state.auction?.phase === 'live' ? ' · 竞价进行中' : '');
  setHTML($('#gapRows'), gap.candidates.length ? gap.candidates.map((g) => {
    const cls = g.status === '超预期' ? 'up-c' : g.status === '不及预期' ? 'down-c' : '';
    return '<div class="ledger-row"><div><div class="nm">' + esc(g.name) + ' <span class="pill">' + g.buyType + '</span></div>' +
      '<div class="meta">预期中值 ' + g.expectedMid + '% · 实际 ' + (g.actualOpen != null ? g.actualOpen.toFixed(2) + '%' : '—') + '</div></div>' +
      '<div class="pnl ' + cls + '">' + g.status + (g.diff != null ? ' (' + (g.diff >= 0 ? '+' : '') + g.diff + ')' : '') + '</div></div>';
  }).join('') : '<div class="muted">暂无数据</div>');
}
let gapSeq = 0; // 序号守卫：并发/先后两轮 loadGap，只有最新一轮可写 state.gap
async function loadGap(force = false) {
  const mySeq = ++gapSeq;
  const gapEl = $('#gapRows');
  const sum = $('#gapSummary');
  const yest = (state.history || []).filter((h) => state.pools && String(h.date) < String(state.pools.date)).pop();
  if (!yest) { sum.textContent = '需历史'; setHTML(gapEl, '<div class="muted">需先「补录历史」或次日数据后才能计算昨日涨停今日开盘预期差。</div>'); return; }
  const candidates = (yest.stocks || []).map((c) => ({ code: c.code, name: c.name, boards: c.boards, industry: c.industry }));
  if (!candidates.length) { sum.textContent = '--'; setHTML(gapEl, '<div class="muted">昨日无涨停缓存</div>'); return; }
  // 同一交易日且已有结果：直接用缓存，不重复打行情接口
  if (!force && state.gapDate === state.pools.date && state.gap) { renderGap(state.gap); return; }
  try {
    let quotes;
    try { quotes = await fetchQuotes(candidates.map((c) => c.code)); }
    catch (e) {
      // 拉不到报价：保留上次的好结果，不用空数据覆盖
      if (mySeq === gapSeq && state.gap) sum.textContent = '报价失败 · 保留上次结果';
      return;
    }
    if (mySeq !== gapSeq) return; // 过期响应，丢弃
    const actualMap = {};
    candidates.forEach((c) => { const q = quotes[c.code]; if (q && q.open != null && q.prevClose) actualMap[c.code] = (q.open - q.prevClose) / q.prevClose * 100; });
    // 竞价撮合涨幅优先（9:26 即有真值；9:30 后与今开相等无缝衔接；非当日回落开盘价代理）——对齐桌面 previousOpenMap 口径
    for (const [code, pct] of Object.entries(state.auctionPctByCode || {})) {
      if (Number.isFinite(pct) && candidates.some((c) => c.code === code)) actualMap[code] = pct;
    }
    const ctx = { ctxFor: (s) => { const ld = state.leaders.find((l) => l.code === s.code); return { buyType: buyTypeOf({ boards: s.boards, previousBoard: null }), phase: state.phase, role: ld?.role || '板块龙头', themeScore: ld?.themeScore ?? null }; } };
    const nextGap = buildExpectationGap(candidates, actualMap, ctx);
    if (mySeq !== gapSeq) return;
    state.gap = nextGap;
    state.gapDate = state.pools.date;
    // G9：同一份开盘报价顺手算昨日涨停溢价（首板/高位两组均值）→ 情绪驾驶舱两指标
    state.prevPremium = { ...yesterdayPremium(candidates, actualMap), date: state.pools.date };
    renderGap(state.gap);
    // 溢价就绪 → 重算派生并刷新（签名含溢价指纹，此前已算过的会触发本轮重算；无递归：loadGap 同日缓存早退）
    if (computeDerived(state.pools)) { renderStatus(); renderCurrentView(); }
  } catch (e) { /* 静默：预期差属增强信息 */ }
}

/* ---------------- 风险雷达 ---------------- */
function renderRadar() {
  const el = $('#radar');
  const r = state.riskRadar;
  if (!r || !r.available) { setHTML(el, '<div class="muted">暂无风险数据</div>'); return; }
  const items = r.items.map((it) => {
    const lvCls = it.level === 'red' ? 'red' : it.level === 'orange' ? 'orange' : it.level === 'yellow' ? 'yellow' : it.level === 'green' ? 'green' : 'gray';
    return '<div class="risk-item"><div class="top"><span class="lab">' + esc(it.label) + '</span><span class="lv ' + lvCls + '">' + it.score + '</span><span class="score"></span></div>' +
      '<div class="action">' + esc(it.action) + '</div>' +
      (it.reasons && it.reasons.length ? '<div class="reasons">' + it.reasons.map((x) => esc(x)).join(' · ') + '</div>' : '') + '</div>';
  }).join('');
  const cannot = (r.cannotDo || []).map((x) => '<span class="ci">' + esc(x) + '</span>').join('');
  // 2026-09-11 拆解融合批:驾驶舱「今日操作风格」落位雷达顶(与「禁止」同层——都是今天该怎么打的答案)
  const em = state.emotion || {};
  const advice = em.advice ? '<div class="radar-style"><span>今日操作风格</span><b>' + esc(em.advice) + '</b></div>' : '';
  // 2026-09-11 修下拉卡顿:签名守卫(星级+各项分+操作风格),不变跳过重建
  const sig = [r.riskStars, advice, ...r.items.map((it) => it.label + it.score + it.action)].join('|');
  if (el.__radarSig === sig) return;
  if (setHTML(el, advice + items + '<div style="margin-top:8px;font-size:13px">风险星级 <span class="stars">' + '★'.repeat(r.riskStars) + '☆'.repeat(5 - r.riskStars) + '</span></div>' +
    (cannot ? '<div class="cannot-do">禁止：' + cannot + '</div>' : ''))) el.__radarSig = sig;
}

function renderIntraday() {
  // 2026-09-11 拆解融合批:renderStructure 改为 structFold 展开时惰性渲染;梯队→涨停池头部(批②)
  const ctx = { state, toast, actions: { loadHistory } };
  renderOpportunity(ctx);
  renderLadder(ctx);
  renderStructFold();
  renderZt(); renderDowns(); renderRadar();
  // 2026-09-10:日期紧凑格式 09-10 周四;2026-09-13 休市批:显示数据的日期而非今天
  // (休市日回拉上一交易日,标签必须跟着数据走,否则周六显示"09-13 周六"配周五数据)
  const d = state.manualDate || state.pools?.date || todayStr();
  const wd = ['日', '一', '二', '三', '四', '五', '六'][new Date(d.slice(0, 4), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8))).getDay()];
  $('#dateLabel').textContent = d.slice(4, 6) + '-' + d.slice(6, 8) + ' 周' + wd;
  $('#dateLabel').title = d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
  updateBanner();
  loadGap();
}

/* ---------------- 渲染:自选已删(2026-09-10 全盘对齐桌面) ----------------
   renderWatch/loadWatch/recordFor/卡片星标/抽屉加自选按钮/设置清空自选 随 view-watch 整链删除——
   实盘在同花顺/东财,详情抽屉主操作改「复制代码去同花顺」(同桌面 2026-09-09 口径)。
   store.js 的 getWatch/putWatch 数据层保留(旧数据不丢);state.watch 仅剩详情抽屉
   对池外历史卡片的兜底寻名——无害残留。 */
/* renderWatch/loadWatch 已随自选页删除(2026-09-10) */

/* ---------------- 详情抽屉 ---------------- */
// 报价新鲜度按只计时（mergeQuotes 盖章 t；无 t 的旧条目回退全局 quotesAt）。
// 报价来源：fetchOpenPct 每日首刷回流全池、openSheet 后台补价成功后入缓存 → 周期内重开抽屉零网络。
// 池内股即使报价过期，抽屉也先用池价（15s 刷新本身即新鲜）立即弹出，报价只补主力/超大单维度。
function freshQuote(code) {
  const q = state.quotes[code];
  if (!q) return null;
  const ttl = Math.min(state.refreshMs || 15000, 15000);
  return Date.now() - (q.t ?? state.quotesAt ?? 0) < ttl ? q : null;
}
function mergeQuotes(q) {
  for (const [c, x] of Object.entries(q || {})) {
    if (x && x.price != null) state.quotes[c] = Object.assign({}, x, { t: Date.now() });
  }
}
async function openSheet(code) {
  const scrim = $('#scrim'), sheet = $('#sheet');
  let stock = null;
  if (state.pools) stock = state.pools.up.find((x) => x.code === code) || state.pools.down.find((x) => x.code === code) || state.pools.broken.find((x) => x.code === code);
  if (!stock) { const w = state.watch.find((x) => x.code === code); if (w) stock = { code, name: (state.quotes[code] && state.quotes[code].name) || w.name || code, boards: 1, industry: '—', changePct: null, price: null }; }
  if (!stock) return;
  state.sheetCode = code;
  // 先渲染后补数：本地数据（池内价 + 缓存报价）立即弹抽屉，网络往返不再挡在渲染之前
  //（旧版渲染前 await 报价，弱网下最坏 3×9s 抽屉不出现，体感「点了没反应」）
  let d = freshQuote(code) || {};
  if (d.price == null && stock.price == null && state.quotes[code]) d = state.quotes[code]; // 池外票：回退最近缓存报价展示，后台再刷
  const pct = d.price != null && d.prevClose ? ((d.price - d.prevClose) / d.prevClose * 100) : (stock.changePct != null ? stock.changePct : null);
  const body = $('#sheetBody');
  let head = '<div class="s-head"><div><div class="s-name">' + esc(stock.name || code) + '</div>' +
    '<div class="s-code">' + code + ' · ' + esc(stock.industry || '—') + (stock.boards ? ' · ' + stock.boards + '板' : '') + '</div></div>' +
    '<div class="s-price" id="sheetPrice"><b class="' + pctClass(pct) + '">' + (d.price != null ? d.price.toFixed(2) : (stock.price ? stock.price.toFixed(2) : '--')) + '</b>' +
    '<small class="' + pctClass(pct) + '">' + pctText(pct) + '</small></div></div>';

  // 2026-09-12 折叠版批(用户拍板「先做折叠版感受一下」):抽屉改两层——
  // 10秒层=结论行/信号/关键数字四格常驻;检查表/竞价/相似/行情明细收进折叠组。
  // 评分构成条砍(与八维检查表信息重复);竞价 9:15-9:26 窗口自动展开(盘中决策刚需)。
  const pv = stock.promo && stock.promo.available !== false;
  let verdictHtml = '<div class="s-verdict">';
  if (stock.tier) verdictHtml += '<span class="sv-line">' + tierBadge(stock.tier) + ' <b>评分 ' + (stock.score ?? '--') + '</b></span>';
  if (pv) {
    const vcls = stock.promo.verdict === '可接力' ? 'pass' : stock.promo.verdict === '观望' ? 'warn' : 'fail';
    verdictHtml += '<span class="sp-verdict verdict-' + vcls + '"><b>' + esc(stock.promo.verdict) + '</b><span>' + stock.promo.score +
      ' · 容错 ' + (stock.promo.faultTolerance != null ? Math.round(stock.promo.faultTolerance * 100) + '%' : '--') + '</span></span>';
    if ((stock.promo.hardFails || []).length) verdictHtml += '<span class="sv-fail">硬否决：' + esc(stock.promo.hardFails.join('、')) + '</span>';
  } else if (!stock.tier) verdictHtml += '<span class="muted">暂无评级</span>';
  verdictHtml += '</div>';

  let signalHtml = '';
  if (stock.signal) {
    const sg = stock.signal;
    signalHtml = '<div class="s-signal"><div class="st">' + signalTag(sg.state) + '</div>' +
      (sg.triggers && sg.triggers.length ? '<div class="muted">触发条件：' + sg.triggers.join(' / ') + '</div>' : '') +
      (sg.risks && sg.risks.length ? '<div class="muted" style="color:var(--red)">风险：' + sg.risks.join(' / ') + '</div>' : '') + '</div>';
  }
  // 晋级八维检查表 → 折叠组内容(verdict 行已上移 10 秒层)
  let promoFoldInner = '';
  if (pv && Array.isArray(stock.promo.checklist)) {
    const icons = { pass: '✓', warn: '!', fail: '✕', na: '–' };
    promoFoldInner = '<div class="s-promo">' +
      stock.promo.checklist.map((row) => '<div class="promo-row status-' + row.status + '"><i>' + (icons[row.status] || '·') + '</i><span class="k">' + esc(row.label) + '</span><em>' + esc(row.note) + '</em></div>').join('') +
      '<div class="muted" style="margin-top:6px">体系规则参考，非投资建议</div></div>';
  }
  // 竞价窗口(9:15-9:26 上海时间):竞价组默认展开——盘中点开连板股看竞价是刚需场景
  const aucWin = !state.manualDate && (() => { const n = shanghaiNow(); const m = n.getHours() * 60 + n.getMinutes(); return m >= 555 && m <= 566; })();
  body.innerHTML = head + verdictHtml + signalHtml +
    '<div id="sheetKvEss">' + kvEss(stock) + '</div>' +
    '<div class="muted" id="sheetQuoteErr" style="margin-top:6px"></div>' +
    (promoFoldInner ? '<details class="fold sheet-fold" id="promoFold"><summary><span class="fold-title">晋级检查表 · 八维</span></summary><div class="body">' + promoFoldInner + '</div></details>' : '') +
    (state.manualDate ? '' : '<details class="fold sheet-fold" id="aucFold"' + (aucWin ? ' open' : '') + '><summary><span class="fold-title">集合竞价 · 09:15-09:25</span></summary><div class="body"><div class="s-auction" id="detailAuction"></div></div></details>') +
    '<details class="fold sheet-fold" id="simFold"><summary><span class="fold-title">相似案例</span><span class="hint">点开加载</span></summary><div class="body"><div class="s-similar" id="detailSimilarCases"></div></div></details>' +
    '<details class="fold sheet-fold" id="detFold"><summary><span class="fold-title">行情明细</span></summary><div class="body"><div id="sheetKvDet">' + kvDet(stock, d) + '</div></div></details>' +
    '<div class="s-actions"><button class="btn primary" id="sheetClose">关闭</button></div>';
  scrim.classList.add('show'); sheet.classList.add('show');
  // 深挖层惰性加载:相似案例首次展开才拉 60 根日K(旧版每次开抽屉都拉);
  // 竞价窗口外首次展开才拉;窗口内(默认展开)立即拉
  const simFold = $('#simFold');
  if (simFold) simFold.addEventListener('toggle', () => { if (simFold.open && !simFold.dataset.loaded) { simFold.dataset.loaded = '1'; loadSimilarCases(code); } });
  const aucFold = $('#aucFold');
  if (aucFold) {
    if (aucWin) loadAuctionDetail(code);
    else aucFold.addEventListener('toggle', () => { if (aucFold.open && !aucFold.dataset.loaded) { aucFold.dataset.loaded = '1'; loadAuctionDetail(code); } });
  }
  $('#sheetClose').addEventListener('click', closeSheet);
  // 后台补实时报价：报价不新鲜才拉（15s 刷新周期内已回流则连请求都不发）；
  // fail-fast 快速失败，失败只提示不阻塞——抽屉早已用池内数据弹出
  if (!freshQuote(code)) {
    const q = await fetchQuotes([code], { tries: 2, timeoutMs: 5000 }).catch(() => ({}));
    const nd = q[code];
    if (nd && nd.price != null) mergeQuotes(q);
    if (state.sheetCode !== code) return; // 已关抽屉/切到别的股：丢弃补数
    if (nd && nd.price != null) patchSheetQuote(stock, nd);
    else { const err = $('#sheetQuoteErr'); if (err) err.textContent = '实时报价获取失败，展示最近数据'; }
  }
}
// 原地补数：只重写价格区与 kvGrid（主力/超大单净流入随行更新），不打扰相似案例异步填充区
function patchSheetQuote(stock, d) {
  const pct = d.price != null && d.prevClose ? ((d.price - d.prevClose) / d.prevClose * 100) : (stock.changePct != null ? stock.changePct : null);
  const el = $('#sheetPrice');
  if (el) el.innerHTML = '<b class="' + pctClass(pct) + '">' + (d.price != null ? d.price.toFixed(2) : (stock.price ? stock.price.toFixed(2) : '--')) + '</b>' +
    '<small class="' + pctClass(pct) + '">' + pctText(pct) + '</small>';
  // 2026-09-12 折叠版批:报价回填只更新行情明细组(主力/超大单随行);10秒层四格是池字段不随报价变
  const kv = $('#sheetKvDet');
  if (kv) kv.innerHTML = kvDet(stock, d);
}
// 2026-09-12 折叠版批:kv 拆两层——四格决策关键数常驻(10秒层),五格研究明细进折叠组
function kvEss(s) {
  const rows = [
    ['封单资金', s.seal != null ? fmtMoney(s.seal) : '--'],
    ['换手率', s.turnover != null ? s.turnover.toFixed(1) + '%' : '--'],
    ['首封', fmtTime(s.firstSeal)],
    ['炸板次数', s.breaks != null ? s.breaks : '--'],
  ];
  return '<div class="kv-grid">' + rows.map((r) => '<div class="kv"><span>' + r[0] + '</span><strong>' + r[1] + '</strong></div>').join('') + '</div>';
}
function kvDet(s, d) {
  const rows = [
    ['成交额', s.amount != null ? fmtMoney(s.amount) : '--'],
    ['流通市值', s.circ != null ? fmtMoney(s.circ) : '--'],
    ['末封', fmtTime(s.lastSeal)],
    ['主力净流入', d.main != null ? fmtMoney(d.main) : '--'],
    ['超大单净流入', d.super != null ? fmtMoney(d.super) : '--'],
  ];
  return '<div class="kv-grid">' + rows.map((r) => '<div class="kv"><span>' + r[0] + '</span><strong>' + r[1] + '</strong></div>').join('') + '</div>';
}
function closeSheet() { state.sheetCode = null; $('#scrim').classList.remove('show'); $('#sheet').classList.remove('show'); }

// 2026-09-11 拆解融合批:情绪 chip 点开分指标明细(驾驶舱移入横幅的归宿)——复用 scrim+sheet,不动 sheetCode
function openEmoSheet() {
  const em = state.emotion || {};
  const inds = (em.indicators || []).map((i) =>
    '<div class="ind ' + (i.available ? i.status : 'unavailable') + '"><span class="dot"></span><span class="k">' + esc(i.label) + '</span><span class="v">' + (i.value == null ? '—' : i.value) + '</span></div>'
  ).join('');
  const reasons = (em.reasons || []).map((r) => '<span>' + esc(r) + '</span>').join('');
  const head = '<div class="s-head"><div><div class="s-name">情绪分指标</div><div class="s-code">' + esc(em.phase || '--') + ' · 指数 ' + (em.emotionIndex ?? '--') + ' · 置信度 ' + (em.confidence ?? '--') + '%</div></div></div>';
  $('#sheetBody').innerHTML = head +
    (inds ? '<div class="emo-indicators">' + inds + '</div>' : '<div class="muted">暂无指标数据</div>') +
    (reasons ? '<div class="emo-reasons">' + reasons + '</div>' : '') +
    '<div class="s-actions"><button class="btn primary" id="emoSheetClose">关闭</button></div>';
  $('#scrim').classList.add('show'); $('#sheet').classList.add('show');
  $('#emoSheetClose').addEventListener('click', closeSheet);
}

// 个股相似案例（对齐桌面 G24）：拉取更长日K（≥26 根才能滑窗匹配），复用 analytics.stockSimilarCases，
// 展示 top-3 相似形态 + 六维特征 delta + 后续表现按相似度加权。仅在打开抽屉时按需拉取。
async function loadSimilarCases(code) {
  const el = $('#detailSimilarCases');
  if (!el) return;
  // B3:先查 K 线缓存（enrichPromo 只存 8 根，不够滑窗须重拉）；拉到 60 根后入缓存——
  // 同一只票二次开抽屉秒出相似案例，且当日 enrichPromo 的 missing 直接消失
  const dateKey = state.pools?.date || todayStr();
  let bars = cachedKlineBars(code, dateKey);
  if (bars && bars.length < 26) bars = null;
  if (!bars) {
    try { bars = await fetchKlineLite(code, 60); } catch (e) { bars = null; }
    if (bars && bars.length) storeKlineBars(code, dateKey, bars);
  }
  if (!bars || bars.length < 26) { el.innerHTML = '<div class="muted">暂无足够历史日K，无法匹配相似形态</div>'; return; }
  const r = stockSimilarCases(bars, { window: 20, horizon: 5, limit: 3 });
  if (!r.available || !r.similar.length) { el.innerHTML = '<div class="muted">暂未匹配到相似历史形态</div>'; return; }
  const sim = r.similar.map((c) => {
    const feats = c.features.map((f) => {
      const cur = f.cur == null ? '–' : f.cur;
      const arrow = f.cur == null ? '' : f.cur > 0.001 ? '↑' : f.cur < -0.001 ? '↓' : '→';
      return '<div class="sf-row"><span>' + esc(f.label) + '</span><b>' + arrow + ' ' + cur + '</b><i>' + (f.hist == null ? '–' : f.hist) + '</i></div>';
    }).join('');
    return '<div class="sim-card"><div class="sim-top"><b>' + esc(c.date) + '</b><span class="sim-score">相似度 ' + c.score + '%</span></div><div class="sf-grid">' + feats + '</div></div>';
  }).join('');
  const o = r.outcome || {};
  const outBar = '<div class="outcome">后续表现（按相似度加权）：<b class="up-c">涨 ' + (o.up ?? 0) + '%</b> / <b>平 ' + (o.flat ?? 0) + '%</b> / <b class="down-c">跌 ' + (o.down ?? 0) + '%</b></div>';
  el.innerHTML = sim + outBar + '<div class="muted" style="font-size:11px;margin-top:6px">' + esc(r.vectorNote) + '</div>';
}

/* ---------------- 详情抽屉：集合竞价区 ---------------- */
// 申报量（股）人类可读：亿股/万股
function fmtShares(v) {
  if (v == null || !Number.isFinite(Number(v))) return '--';
  const n = Number(v), a = Math.abs(n);
  if (a >= 1e8) return (n / 1e8).toFixed(2) + '亿股';
  if (a >= 1e4) return (n / 1e4).toFixed(0) + '万股';
  return n + '股';
}
// 竞价价格走势内联 SVG（零依赖 sparkline）：虚拟撮合价折线 + 昨收虚线基线
function auctionSparkline(minutes, refPrice) {
  const pts = (minutes || []).filter((m) => m.price != null);
  if (pts.length < 2) return '';
  const w = 260, h = 56, pad = 5;
  const prices = pts.map((m) => m.price).concat(refPrice != null ? [refPrice] : []);
  const min = Math.min(...prices), max = Math.max(...prices);
  const span = (max - min) || 1;
  const x = (i) => pad + (i * (w - 2 * pad)) / (pts.length - 1);
  const y = (p) => h - pad - ((p - min) / span) * (h - 2 * pad);
  const line = pts.map((m, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(m.price).toFixed(1)).join('');
  const ref = refPrice != null && refPrice >= min && refPrice <= max
    ? '<line class="ref" x1="' + pad + '" y1="' + y(refPrice).toFixed(1) + '" x2="' + (w - pad) + '" y2="' + y(refPrice).toFixed(1) + '"/>' : '';
  const lastDot = '<circle cx="' + x(pts.length - 1).toFixed(1) + '" cy="' + y(pts[pts.length - 1].price).toFixed(1) + '" r="2.5"/>';
  return '<svg class="auc-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' + ref + '<path class="line" d="' + line + '"/>' + lastDot + '</svg>';
}
// 竞价区主体：minutes（核心票过程）或 item（全池快照行）二选一，至少给其一
function renderAuctionBody(minutes = [], matched = null, item = null) {
  const preClose = minutes[0]?.refPrice ?? item?.preClose ?? null;
  const lastPrice = matched?.price ?? minutes[minutes.length - 1]?.price ?? null;
  const pct = lastPrice && preClose ? Number(((lastPrice / preClose - 1) * 100).toFixed(2)) : null;
  const rows = [];
  if (matched?.amount != null) rows.push(['竞价额', fmtMoney(matched.amount)]);
  if (matched?.volumeHands != null) rows.push(['竞价量', matched.volumeHands + ' 手']);
  if (item?.volRatio != null) rows.push(['量比', item.volRatio]);
  if (matched?.sealedBuyShares > 0) rows.push(['一字封单', fmtShares(matched.sealedBuyShares)]);
  const last = minutes[minutes.length - 1];
  if (last && (last.bidShares != null || last.askShares != null)) {
    rows.push(['末点申报', '买 ' + fmtShares(last.bidShares) + ' / 卖 ' + fmtShares(last.askShares)]);
  }
  const head = '<div class="auc-summary"><b>' + (matched ? '撮合' : '虚拟') + ' ' + (lastPrice != null ? lastPrice.toFixed(2) : '--') + '</b>' +
    (pct != null ? '<span class="' + pctClass(pct) + '">' + pctText(pct) + '</span>' : '') + '</div>';
  return head + auctionSparkline(minutes, preClose) +
    (rows.length ? '<div class="auc-kv">' + rows.map((r) => '<span>' + r[0] + ' <b>' + r[1] + '</b></span>').join('') + '</div>' : '');
}
// 本地可得（核心票过程 / 快照行）→ 渲染；否则 null（调用方走 adhoc 单票拉取）
function auctionDetailHtml(code) {
  const a = state.auction;
  if (!a?.available || state.manualDate) return null;
  const core = (a.core || []).find((c) => c.code === code);
  const item = state.auctionByCode?.get(code);
  if (!core && !item) return null;
  if (core) return renderAuctionBody(core.minutes || [], core.matched, item || null);
  const matched = item && item.matched ? { price: item.matchPrice, amount: item.auctionAmount, volumeHands: item.volumeHands, sealedBuyShares: item.sealedBuyShares } : null;
  return renderAuctionBody([], matched, item);
}
// 2026-09-12 折叠版批:AUC_HEAD 删(折叠组标题已含「集合竞价 · 09:15-09:25」)
async function loadAuctionDetail(code) {
  const el = $('#detailAuction');
  if (!el || state.sheetCode !== code) return;
  const local = auctionDetailHtml(code);
  if (local) { el.innerHTML = local; return; }
  // 非核心/池外股：adhoc 单票拉取（trends/get 全天含竞价段，任意时点可取当日竞价）
  try {
    const trend = await fetchAuctionTrend(code, { tries: 2, timeoutMs: 6000 });
    if (state.sheetCode !== code || !$('#detailAuction')) return;
    if (!trend.minutes.length && !trend.matched) { el.innerHTML = '<div class="muted">今日无竞价数据（非交易日或未开始）</div>'; return; }
    el.innerHTML = renderAuctionBody(trend.minutes, trend.matched, null);
  } catch (e) {
    if (state.sheetCode === code) el.innerHTML = '<div class="muted">竞价数据获取失败</div>';
  }
}
// 竞价采集落位后：若抽屉正开着该股且有本地数据，原地刷新竞价区（不覆盖 adhoc 进行中的加载态）
function refreshAuctionDetail() {
  if (!state.sheetCode || state.manualDate) return;
  const el = $('#detailAuction');
  if (!el) return;
  const local = auctionDetailHtml(state.sheetCode);
  if (local) el.innerHTML = local;
}

/* ---------------- 导航(2026-09-11 一屏到底批:复盘/设置已删,单视图无需切换) ----------------
   switchView/renderView 简化为 renderCurrentView 直渲染盘中;视图切换的痕迹
   (state.view==='intraday' 判断)保留——省得全文件改判空 */
function renderCurrentView() { renderIntraday(); }

/* ---------------- 侧滑菜单已删(2026-09-11 减法批) ---------------- */

/* ---------------- 刷新 ---------------- */
let refreshing = false;
// 图标旋转走 WAAPI:按钮是 44×38 非正方形,转按钮会晃;只转内层 .ic(inline-block 可 transform)。
// 停止时从当前角度 ease-out 滑完本圈归位(360°≡0°),避免直接摘 class 瞬间跳回 0° 的急停感。
let spinAnim = null;
function spinStart() {
  const icon = $('#refreshBtn .ic');
  if (!icon?.animate || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  icon.getAnimations().forEach(a => a.cancel()); // 清理上次减速尾动画,防快速连点角度跳变
  spinAnim = icon.animate(
    [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
    { duration: 800, iterations: Infinity, easing: 'linear' }
  );
}
function spinStop() {
  if (!spinAnim) return;
  const t = spinAnim.currentTime % 800;
  const angle = (t / 800) * 360;
  spinAnim.cancel(); spinAnim = null;
  $('#refreshBtn .ic').animate(
    [{ transform: `rotate(${angle}deg)` }, { transform: 'rotate(360deg)' }],
    { duration: Math.max((360 - angle) / 360 * 800, 260), easing: 'cubic-bezier(0.3, 0, 0.2, 1)' }
  );
}
async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  // B1:手动刷新不再无条件作废预期差缓存(省 1-5 个报价请求)——09:30 后开盘价已定型
  if (force && shouldRefetchGap(shanghaiNow(), state.manualDate)) state.gapDate = null;
  spinStart();
  const fetchStart = performance.now();
  try {
    // 2026-09-13 休市批:休市日自动回拉最近交易日的池——不再拿周六/节假日打空接口
    // (空响应还会把 IDB 里的上一交易日好快照覆盖成空池);手动指定日期不拦(用户显式要求)
    const today = todayStr();
    state.marketClosed = !state.manualDate && !isTradingDay(today);
    const date = state.manualDate || (state.marketClosed ? lastTradingDate(today) : today);
    if (state.pools) renderCurrentView(); // SWR：先即时渲染上一份数据，后台拉取成功后再增量 patch，避免空白/loading 闪
    // 冷启动（无本地数据垫底）用 fail-fast 配置：挂起/离线时最坏 ~13s 落到离线态（此前 3×9s≈28s）；
    // 热刷新保持完整重试韧性（有 SWR 旧数据在屏，慢点无妨）
    const pools = await fetchPools(date, state.pools ? {} : { tries: 2, timeoutMs: 6000 });
    state.lastFetchMs = Math.round(performance.now() - fetchStart);
    state.fromSnapshot = false;
    state.lastSuccessAt = Date.now();
    persistLastGood(pools); // 先落原始池（未挂派生字段，体积小），失败静默
    computeDerived(pools);
    state.pools = pools;
    renderStatus();
    renderCurrentView(); // 2026-09-11 一屏到底:单视图直渲染
    // M2 竞价抓取与梯队晋级评估并发（K线尾巴与竞价抓取重叠，墙钟取 max 而非相加）；两者 settle 后把当日预热持久化到 IDB，SW 重载即命中免重抓
    const openPctP = fetchOpenPct(pools);
    openPctP.catch(() => {});
    Promise.allSettled([openPctP, enrichPromo(pools, openPctP)]).then(() => { persistWarmCache(); }).catch(() => {}); // 2026-09-11:notifySignalChanges 调用已随通知链删
  } catch (e) {
    state.lastErrorAt = Date.now();
    renderStatus();
    if (!state.pools) showOfflineEmpty(e); // 无任何可用数据（含快照）：清骨架屏给显式离线态
    toast('刷新失败：' + e.message);
  }
  finally { spinStop(); refreshing = false; }
}
// lastGood 落盘节流：此前每 15s tick 全量直写 IDB（整池结构克隆+写盘，低端机可感知卡顿）；
// 收敛为至多 30s 一次，隐藏/关闭时立即冲刷，离线快照最多旧 30s（冷启动 SWR 完全可接受）。
const LAST_GOOD_MIN_INTERVAL = 30_000;
let lastGoodLastWrite = 0;
let lastGoodTimer = null;
let lastGoodPending = null;
function flushLastGood() {
  if (lastGoodTimer) { clearTimeout(lastGoodTimer); lastGoodTimer = null; }
  if (!lastGoodPending) return;
  const payload = lastGoodPending;
  lastGoodPending = null;
  lastGoodLastWrite = Date.now();
  setKV('lastGood', payload).catch(() => {});
}
function persistLastGood(pools) {
  lastGoodPending = { date: pools.date, pools, savedAt: Date.now() };
  const wait = lastGoodLastWrite + LAST_GOOD_MIN_INTERVAL - Date.now();
  if (wait <= 0) return flushLastGood();
  if (!lastGoodTimer) lastGoodTimer = setTimeout(flushLastGood, wait);
}
document.addEventListener('pagehide', flushLastGood);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushLastGood(); });

// 2026-09-11 一屏到底批:信号通知链(buildSignalSnapshot/notifySignalChanges)已随设置页整删——
// 开关无法再打开(恒 false);analytics.js 的 diffSignalSnapshot 函数保留(同步哨兵锁同名一致性)
// M1 预热持久化：把当日 K线 + 竞价代理 + 竞价终态写入 IDB（防抖），SW 发版/重开 app 后首屏命中内存缓存，免去 ~29 请求完整预热
// 竞价终态当日定型（hydrate 端按 date === 今日校验），重开 app 不再重抓全池
let warmPersistTimer = null;
function persistWarmCache() {
  clearTimeout(warmPersistTimer);
  warmPersistTimer = setTimeout(() => {
    setKV('warmCache', { kline: exportKlineCache(), openPct: state.openPctByCode, openPctDate: state.openPctDate, auction: state.auction && state.auction.available ? state.auction : null }).catch(() => {});
  }, 2000);
}

/* ---------------- 交易体系规则引擎：竞价代理 + 梯队股晋级评估 ---------------- */
const PROMO_TIER_CAP = 24; // 仅对 S/A/B 梯队前 N 只拉轻量K线（控流量），其余股票量能维度诚实标 na
// 今开/昨收%（真竞价快照免费源没有，用开盘价代理；每个交易日只拉一次全池）
async function fetchOpenPct(pools) {
  const codes = [...(pools.up || []), ...(pools.down || [])].map((s) => s.code);
  if (!codes.length) return;
  if (state.openPctDate === pools.date && Object.keys(state.openPctByCode).length >= Math.min(codes.length, 30)) return;
  const quotes = await fetchQuotes(codes).catch(() => ({}));
  mergeQuotes(quotes); // 全池报价回流 state.quotes（fetchOpenPct 每日只跑一次）：当日首刷后 15s 内点开抽屉命中缓存零网络
  const map = {};
  for (const [code, q] of Object.entries(quotes)) {
    if (q && q.open != null && q.prevClose) map[code] = Number(((q.open - q.prevClose) / q.prevClose * 100).toFixed(2));
  }
  if (Object.keys(map).length) { state.openPctByCode = map; state.openPctDate = pools.date; }
}

/* ---------------- 集合竞价（真实竞价源，对齐桌面 2026-08-31 过程版） ---------------- */
// 采集对象=昨日涨停池（竞价窗口内今日池尚未生成，与桌面 runAuctionCollection 同口径）。
// 与主刷新完全解耦：refreshTick 触发、单飞封装、失败静默（增强源，不拦截信号不弹错）。
// live=核心 12 只逐分钟过程（60s 节流，9:15-9:30）；final=全池撮合终态一次（9:31 后，当日定型入预热缓存）。
let auctionInflight = null;
let auctionLiveAt = 0;
let auctionFinalTries = 0;
function applyAuctionPayload(payload) {
  state.auction = payload;
  state.auctionByCode = payload?.available ? new Map((payload.items || []).map((i) => [i.code, i])) : new Map();
  // 撮合涨幅 map：仅 matched 项（对齐桌面 auctionPctByCode；竞价中的虚拟价只用于展示，不进评估链路）
  const pct = {};
  for (const it of (payload?.items || [])) if (it.matched && Number.isFinite(it.matchPct)) pct[it.code] = it.matchPct;
  state.auctionPctByCode = pct;
}
let auctionPoolFallback = null; // { fetchedFor, date, stocks }：无历史记录时直抓的最近交易日池（当日缓存）
async function yesterdayPoolForAuction() {
  const today = todayStr();
  const rec = (state.history || []).filter((h) => String(h.date) < today).pop();
  if (rec && rec.stocks?.length) return rec;
  // 盘前兜底：今日池尚未生成，state.pools 即昨日池（qdate 早于今日）
  if (state.pools && String(state.pools.date) < today && state.pools.up?.length) return { date: state.pools.date, stocks: state.pools.up };
  // 全新安装无任何历史（盘中首开 app）：直抓最近交易日涨停池，当日缓存防重复外呼
  if (auctionPoolFallback && auctionPoolFallback.fetchedFor === today && auctionPoolFallback.stocks?.length) return auctionPoolFallback;
  for (const dt of tradingDatesBack(5).slice(0, 3)) { // 最多回看 3 个工作日（防节假日空池），首个有涨停的即用
    try {
      const p = await fetchPools(dt);
      if (p.upCount > 0) {
        auctionPoolFallback = { fetchedFor: today, date: dt, stocks: p.up };
        return auctionPoolFallback;
      }
    } catch (e) { /* 单日失败试下一日 */ }
  }
  return null;
}
async function runAuctionCollect(mode) {
  const rec = await yesterdayPoolForAuction();
  if (!rec) return null;
  const today = todayStr();
  const result = await collectAuctionSnapshot(mode, rec.stocks, pickAuctionCoreCodes(rec.stocks), today);
  if (!(result.items || []).some((i) => i.matched) && !(result.core || []).length) return result; // 无可用数据：不落位（final 会重试）
  applyAuctionPayload({ available: true, phase: mode === 'live' ? 'live' : 'final', date: today, ...result });
  // 撮合数据首落位/扩量：预期差按撮合口径重算（作废同日缓存）、晋级评估立即定稿、终态入预热缓存
  const matchedCount = Object.keys(state.auctionPctByCode).length;
  if (matchedCount > state.auctionMatchedSeen) {
    state.auctionMatchedSeen = matchedCount;
    state.gapDate = null;
    if (state.view === 'intraday') { renderZt(); loadGap(true); }
    if (state.pools) enrichPromo(state.pools).catch(() => {});
    if (mode === 'final') persistWarmCache();
  } else if (state.view === 'intraday') {
    renderZt(); // 竞价行（虚拟价逐分钟更新）随结构签名行级重建
  }
  refreshAuctionDetail();
  return result;
}
function triggerAuction(mode) {
  if (auctionInflight) return auctionInflight;
  auctionInflight = runAuctionCollect(mode)
    .catch(() => null) // 竞价为增强源：失败静默，不打断主链路（对齐桌面「不触发 pausesSignals」纪律）
    .finally(() => { auctionInflight = null; });
  return auctionInflight;
}
// 竞价调度（refreshTick 每 15s 顺带检查；窗口判定与桌面 scheduler DAILY_WINDOWS 同口径）：
// live 窗口 555-570（9:15-9:30）60s 节流；final 窗口 571 起当日单次（trends/get 全天含竞价段，
// 午后首开 app 也能补抓当日竞价），无数据重试至多 8 次防打转。
function maybeAuctionTick() {
  if (state.manualDate || document.hidden) return;
  const d = shanghaiNow();
  if (d.getDay() === 0 || d.getDay() === 6) return;
  const t = d.getHours() * 60 + d.getMinutes();
  if (t >= 555 && t < 571) {
    if (Date.now() - auctionLiveAt >= 60_000) { auctionLiveAt = Date.now(); triggerAuction('live'); }
  } else if (t >= 571 && t <= 900) {
    const done = state.auction && String(state.auction.date) === todayStr() && (state.auction.items || []).some((i) => i.matched);
    if (!done && auctionFinalTries < 8) { auctionFinalTries += 1; triggerAuction('final'); }
  }
}
// 组装评估 ctx：昨日同码（烂板/换手，历史记录含 breaks/turnoverRate 才有）
function promoContextOf(s, pools) {
  let prevDay = null;
  const hist = state.history || [];
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    if (String(hist[i].date) < String(pools.date)) { prevDay = (hist[i].stocks || []).find((x) => x.code === s.code) || null; break; }
  }
  // 题材梯队真实口径（2026-09-08 评审批三修）：
  // ① 富化优先：写回值/暂存兜底（deriveSig 早退 tick 上裸对象无 role/themeSize，否则检查表分数逐 tick 摆动 ~10 分）
  // ② '未分类' 是 mapPool 缺 hybk 的兜底桶不是真题材 → null（na），杜绝假「孤立独板」硬否决/假梯队加分
  // ③ 现场计数用 trim 归一（与 groupThemes 展示口径一致），防尾随空格使同一行业数不齐
  const stash = (state.enrichByCode || {})[s.code] || {};
  let themeSize = s.themeSize != null ? s.themeSize : (stash.themeSize != null ? stash.themeSize : null);
  if (themeSize === null && s.industry && s.industry !== '未分类') {
    const key = String(s.industry).trim();
    themeSize = 0;
    for (const x of pools.up || []) if (String(x.industry || '').trim() === key) themeSize += 1;
  }
  return {
    phase: state.phase,
    themeSize,
    role: s.role || stash.role || null,
    // 竞价撮合%优先（9:26 即有真值，applyAuctionPayload 已做当日校验）；今开代理必须同日才可信——
    // warmCache 水合的昨日 gap% 会把存量股硬否决成「竞价避雷」（2026-09-08 评审批）
    openPct: state.auctionPctByCode[s.code] ?? (state.openPctDate === pools.date ? state.openPctByCode[s.code] : undefined) ?? null,
    prevDay: prevDay ? { boards: prevDay.boards, breakCount: prevDay.breaks, turnoverRate: prevDay.turnoverRate } : null,
  };
}
let promoRunSeq = 0; // 序号守卫：新一轮行情到达后旧一轮评估作废
async function enrichPromo(pools, openPctReady = Promise.resolve()) {
  if (state.promoInFlight) return;
  const mySeq = ++promoRunSeq;
  state.promoInFlight = true;
  try {
    const seen = new Set();
    const tierCodes = new Set();
    for (const k of ['S', 'A', 'B']) {
      for (const t of (state.opportunities?.tiers?.[k] || [])) {
        if (seen.size >= PROMO_TIER_CAP) break;
        if (seen.has(t.code)) continue;
        seen.add(t.code); tierCodes.add(t.code);
      }
      if (seen.size >= PROMO_TIER_CAP) break;
    }
    const byCode = {};
    for (const s of pools.up || []) byCode[s.code] = s;
    // 先同步：所有股用本地缓存/空量能维度挂晋级评估（不阻塞 UI）
    const missing = [];
    for (const s of pools.up || []) {
      let feats = {};
      if (tierCodes.has(s.code)) {
        const bars = cachedKlineBars(s.code, pools.date);
        // B3:缓存可能是抽屉拉的 60 根(数据超集)，统一取尾部 8 根喂特征
        if (bars && bars.length >= 2) feats = klineFeatures(bars.slice(-8));
        else if (!bars) missing.push(s.code);
      }
      s.promo = assessPromotion(s, {
        ...promoContextOf(s, pools),
        volChg: feats.volChg1d ?? null,
        gapUnfilled: feats.gapUnfilled ?? null,
        pullbackFirstBoard: feats.pullbackFirstBoard === true,
      });
    }
    if (mySeq !== promoRunSeq) return;
    // 再并发限额拉取缺失的轻量 K 线（最多 PROMO_TIER_CAP 只），数量少时几乎瞬时
    await mapWithConcurrency(missing, 6, async (code) => {
      if (mySeq !== promoRunSeq) return;
      const bars = await fetchKlineLite(code, 8).catch(() => null);
      if (!bars) return;
      storeKlineBars(code, pools.date, bars);
      const s = byCode[code];
      if (!s) return;
      const feats = bars.length >= 2 ? klineFeatures(bars) : {};
      s.promo = assessPromotion(s, {
        ...promoContextOf(s, pools),
        volChg: feats.volChg1d ?? null,
        gapUnfilled: feats.gapUnfilled ?? null,
        pullbackFirstBoard: feats.pullbackFirstBoard === true,
      });
    });
    if (mySeq === promoRunSeq) {
      await openPctReady; // 竞价维度就绪后再定稿（与 K线抓取并发，墙钟不增加）
      if (mySeq !== promoRunSeq) return;
      // 定稿：用内存缓存的 K线 + 已就绪的竞价，对梯队股重算晋级评估（无网络），保证 open-pct 维度不缺失
      for (const code of tierCodes) {
        const s = byCode[code]; if (!s) continue;
        const bars = cachedKlineBars(code, pools.date);
        const feats = bars && bars.length >= 2 ? klineFeatures(bars.slice(-8)) : {}; // B3:同上,尾部 8 根统一口径
        s.promo = assessPromotion(s, {
          ...promoContextOf(s, pools),
          volChg: feats.volChg1d ?? null,
          gapUnfilled: feats.gapUnfilled ?? null,
          pullbackFirstBoard: feats.pullbackFirstBoard === true,
        });
      }
      renderZt(); // 徽标随行级 diff 原地更新
      // 抽屉正开着池内涨停股时同步重渲染：promo 刚定稿立即回填检查表
      //（此前只刷 renderZt，开着抽屉点开的股检查表永不出现）。
      // 此时报价已被 fetchOpenPct 回流、K线在缓存 → 重渲染零网络、瞬时完成。
      // 2026-09-12 检查批修:promo 回填走整抽屉重渲染,会把用户已展开的折叠组收起+
      // 相似案例 loaded 标记丢失(再点重复拉)——快照 open/loaded,渲染后恢复
      // (先恢复 loaded 再置 open:toggle 事件会触发惰性加载分支,loaded 已在则跳过)
      if (state.sheetCode && byCode[state.sheetCode]) {
        const openFolds = $$('.sheet-fold').filter((f) => f.open).map((f) => ({ id: f.id, loaded: f.dataset.loaded || '' }));
        openSheet(state.sheetCode);
        for (const snap of openFolds) {
          const f = document.getElementById(snap.id);
          if (!f) continue;
          if (snap.loaded) f.dataset.loaded = snap.loaded;
          f.open = true;
        }
      }
    }
  } finally { state.promoInFlight = false; }
}
function updateBanner() {
  const p = state.pools;
  const banner = $('#intradayBanner');
  if (!p.upCount && !p.downCount) {
    banner.classList.remove('hide');
    banner.textContent = '未获取到行情数据（可能非交易时段，或该日期无数据）。可长按顶部日期输入交易日，或交易时段再试。'; // 2026-09-12:设置页已删,引导改长按日期
  } else if (state.marketClosed) {
    // 2026-09-13 休市批:周末/节假日明示——数据定格在上一交易日,数字不动是正常的
    const d = p.date || '';
    banner.classList.remove('hide');
    banner.textContent = '休市中 · 显示 ' + d.slice(4, 6) + '-' + d.slice(6, 8) + ' 快照（数据定格，下拉可复检）';
  } else if (!tradingNow()) {
    banner.classList.remove('hide');
    banner.textContent = '非交易时段 · 显示最近交易日快照（手动点 ↻ 获取最新）';
  } else if (state.mentalNotes && state.mentalNotes.length) {
    // 交易时段：用横幅位浮现当前阶段的第一条体系心法
    const n = state.mentalNotes[0];
    banner.classList.remove('hide');
    banner.textContent = '【' + n.topic + '】' + n.text;
  } else banner.classList.add('hide');
}
function tradingNow() {
  // 2026-09-13 休市批:周六日判断升级为交易日历(节假日也拦,如十一);窗口不变
  if (!isTradingDay(todayStr())) return false;
  const t = shanghaiNow();
  const m = t.getHours() * 60 + t.getMinutes();
  return (m >= 555 && m <= 690) || (m >= 780 && m <= 900);
}
function applyRefreshTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  if (state.refreshMs > 0) state.timer = setInterval(refreshTick, state.refreshMs);
}
function refreshTick() {
  if (document.hidden) return; // 后台标签页不白耗流量/电量
  // 2026-09-13 检查批修:休市日失败重试——休市日 tradingNow 恒 false,init 刷新若碰上
  // 网络抖动失败,「· 失败」会挂一整天无人兜底(交易日有本 tick 连续重试,休市日是真空档)。
  // 放行条件:休市中 && 最近一次是失败 && 距失败 ≥30s(8s tick 天然节流,防打锤);
  // 一旦成功 lastSuccessAt 反超,tick 回归空转
  const holidayRetry = state.marketClosed && state.lastErrorAt > state.lastSuccessAt && Date.now() - state.lastErrorAt >= 30_000;
  if (!tradingNow() && !holidayRetry) return;
  // 回看历史交易日：数据已是该日就不再重拉不变的历史，手动 ↻ 才强制
  if (state.manualDate && state.pools && String(state.pools.date) === String(state.manualDate)) return;
  if (!tradingNow()) { refresh(); return; } // 休市重试不走竞价采集
  maybeAuctionTick(); // 竞价采集独立节流（live 60s / final 当日单次），不阻塞主刷新
  refresh();
}

/* ---------------- 历史补录 ---------------- */
function tradingDatesBack(n) {
  const out = [];
  const base = shanghaiNow();
  for (let i = 1; i <= n && out.length < 40; i += 1) {
    const dt = new Date(base.getTime()); dt.setDate(base.getDate() - i);
    const day = dt.getDay();
    if (day === 0 || day === 6) continue;
    const s = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
    out.push(s);
  }
  return out;
}
async function loadHistory() {
  if (state.historyLoading) return;
  state.historyLoading = true;
  try {
    const existing = await getAllHistory();
    const map = new Map(existing.map((h) => [h.date, h]));
    let emptyDates = [];
    try { emptyDates = (await getKV('emptyDates', [])) || []; } catch (e) { emptyDates = []; }
    const emptySet = new Set(emptyDates);
    const dates = tradingDatesBack(45);
    let count = map.size;
    let failRun = 0;
    // 历史日期彼此独立——按 3 并发分块补录（此前逐日串行 + sleep，30 交易日约一分钟，现约 1/3 时长）；
    // 失败语义保持：整块全失败连续累计 3 次即中止，部分失败退避后继续
    const CONC = 3;
    let aborted = false;
    for (let start = 0; start < dates.length && !aborted; start += CONC) {
      const batch = dates.slice(start, start + CONC).filter((dt) => !map.has(dt) && !emptySet.has(dt));
      if (!batch.length) continue;
      const results = await Promise.allSettled(batch.map((dt) => fetchPools(dt)));
      const failures = results.filter((r) => r.status === 'rejected').length;
      if (failures === batch.length) {
        failRun += failures;
        if (failRun >= 3) { toast('历史补录中止：接口连续失败'); break; }
        await sleep(800 * failures + Math.floor(Math.random() * 300));
        continue;
      }
      failRun = 0;
      if (failures) await sleep(800 * failures + Math.floor(Math.random() * 300));
      for (let i = 0; i < batch.length && !aborted; i++) {
        const r = results[i];
        if (r.status !== 'fulfilled') continue;
        const dt = batch[i];
        const p = r.value;
        if (p.upCount > 0) {
          // breaks/turnoverRate 供弱转强判定的「昨日烂板」维度（旧记录缺字段时评估器诚实标 na）
          const rec = { date: dt, stocks: p.up.map((s) => ({ code: s.code, boards: s.boards, industry: s.industry, name: s.name, breaks: s.breakCount ?? null, turnoverRate: s.turnoverRate ?? null })) };
          await putHistory(rec); map.set(dt, rec); count += 1;
        } else {
          // 空池（节假日/无数据）也记档，之后不再重复拉同一天
          emptySet.add(dt);
        }
        if (count >= 30) aborted = true;
      }
      if (!aborted) await sleep(150);
    }
    if (emptySet.size !== emptyDates.length || [...emptySet].some((d2) => !emptyDates.includes(d2))) {
      setKV('emptyDates', [...emptySet].slice(-200)).catch(() => {});
    }
    // 历史库只保留最近 60 个交易日，防止数月后无限增长拖慢启动
    const KEEP = 60;
    if (map.size > KEEP) {
      const keep = [...map.keys()].sort(String.localeCompare).slice(-KEEP);
      try { await pruneHistoryKeep(keep); } catch (e) { /* 修剪失败不影响主流程 */ }
      for (const k of [...map.keys()]) { if (!keep.includes(k)) map.delete(k); }
    }
    state.history = [...map.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    state.historyLoaded = true;
    if (state.pools) computeDerived(state.pools);
    renderCurrentView();
    toast('历史补录完成：' + state.history.length + ' 个交易日');
  } finally {
    state.historyLoading = false;
  }
}

/* ---------------- 工具 ---------------- */
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  // 全局事件委托：任何带 data-code 的卡片点按都打开详情（替代逐卡 addEventListener，刷新不再累积监听器）
  document.addEventListener('click', (e) => {
    if (e.target.closest('#retryBtn')) { refresh(true); return; } // 离线空态里的重试按钮
    const t = e.target.closest('[data-code]');
    if (t) openSheet(t.dataset.code);
  });
  // 回前台立即补一次刷新（数据过期才拉），后台期间定时器已由 refreshTick 跳过
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !tradingNow()) return;
    maybeAuctionTick(); // 回前台落在竞价窗口内时立即补采集
    const age = Date.now() - state.lastSuccessAt;
    if (!state.lastSuccessAt || age > (state.refreshMs || 15000)) refresh();
  });
  // 2026-09-11 一屏到底批:bottomnav 绑定已随导航整删
  // 2026-09-11 减法批:menu-item 委托已随侧滑菜单整删(零元素,绑定是死代码)
  $('#refreshBtn').addEventListener('click', () => refresh(true));
  // 2026-09-11 详情抽屉下拉关闭(用户点名只能点关闭太死板)——sheet 顶部 60px 拖拽热区,
  // 跟手位移(transition 摘掉防打架),下拉超 80px 松手关,不足回弹;滚到顶再往下拉也关(自然手势)
  setupSheetDrag();
  // 主题切换（TSP 式明暗双主题；默认暗色，localStorage 记忆；首屏初始化在 index.html 内联脚本防闪色）
  $('#themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'light' ? '#ffffff' : '#18181b');
    try { localStorage.setItem('mp-theme', next); } catch {}
  });
  // 折叠池首次展开才渲染
  // 折叠池首次展开才渲染(structFold 题材/龙头同口径——2026-09-11 拆解融合批)
  ['#dtFold', '#zbFold'].forEach((sel) => $(sel).addEventListener('toggle', () => renderDowns()));
  const structFold = $('#structFold');
  if (structFold) structFold.addEventListener('toggle', renderStructFold);
  // 2026-09-11 一屏到底批:设置页四绑定(refresh/date/token/notify)已随视图整删;
  // 历史日期回看改顶栏日期长按(极隐蔽入口,常驻零成本)
  let lpTimer = null;
  const dateEl = document.querySelector('.topbar .date'); // 2026-09-12 检查批:长按目标改整块「日期+时间」(原绑 #dateLabel 内层,时间部分长按无反应,与交付说明不符)
  if (dateEl) {
    dateEl.addEventListener('pointerdown', () => {
      lpTimer = setTimeout(() => {
        lpTimer = null;
        const v = prompt('查看历史行情日期 (YYYYMMDD),留空=今日', state.manualDate || '');
        if (v === null) return;
        state.manualDate = v.trim();
        refresh();
      }, 550);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => dateEl.addEventListener(ev, () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }));
  }
  $('#scrim').addEventListener('click', closeSheet);
  // 情绪 chip 点开分指标明细(2026-09-11 拆解融合批,横幅每轮重建故用委托)
  $('#statusStrip').addEventListener('click', (e) => { if (e.target.closest('#emoChip')) openEmoSheet(); });
  // 板位条点格 → 滚到涨停池对应板位首卡(委托,ladderFull 每轮重建)
  $('#ladderFull').addEventListener('click', (e) => {
    const cell = e.target.closest('.lad-cell');
    if (!cell) return;
    const target = document.querySelector('#ztList .card[data-boards="' + cell.dataset.board + '"]');
    if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1200); }
  });
  setupPTR();
  setupEdgeJump();
}

function setupPTR() {
  const main = document.querySelector('main');
  const ptr = $('#ptr'); // 2026-09-11 卡顿修:缓存元素——原实现每次 touchmove 都 querySelector
  let startY = null;
  main.addEventListener('touchstart', (e) => { if (main.scrollTop <= 0) startY = e.touches[0].clientY; }, { passive: true });
  main.addEventListener('touchmove', (e) => {
    if (startY == null || main.scrollTop > 0) return; // 双保险:手势中途已滚离顶部则不触发(守卫在 main 成为滚动容器后真实生效)
    if (e.touches[0].clientY - startY > 60) ptr.classList.add('show'); // 幂等,过渡只走一次
  }, { passive: true });
  main.addEventListener('touchend', () => {
    if (ptr.classList.contains('show')) {
      // 2026-09-11 修下拉卡顿:等 PTR 收起动画先走一帧再触发刷新——refresh 第一步是 SWR 全量渲染,
      // 同步跑会把松手的过渡卡成瞬跳;列表区已有签名守卫,真重建也只是变化的部分
      requestAnimationFrame(() => { ptr.classList.remove('show'); requestAnimationFrame(() => refresh(true)); });
      startY = null;
      return;
    }
    ptr.classList.remove('show'); startY = null;
  });
}

// 2026-09-11 详情抽屉下拉关闭:grip/头部拖拽热区 + 「滚到顶继续下拉」双入口。
// 卡顿修法(当天二轮):热区判定只在 touchstart 做一次并缓存——原实现每 touchmove 都
// getBoundingClientRect(强制布局读)+写 transform,读写交错每秒 60 次是卡顿主因;
// grip/头部 CSS touch-action:none 让原生滚动不与拖拽抢(治双位移)。
function setupSheetDrag() {
  const sheet = $('#sheet');
  if (!sheet) return;
  let startY = null, dy = 0, dragging = false, eligible = false;
  sheet.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    const inHotzone = t.clientY - sheet.getBoundingClientRect().top < 60; // 只读这一次
    eligible = inHotzone || sheet.scrollTop <= 0;
    if (!eligible) { startY = null; return; }
    startY = t.clientY; dy = 0; dragging = false;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (startY == null || !eligible) return;
    dy = e.touches[0].clientY - startY;
    if (dy <= 0) dy = 0;
    if (!dragging && dy > 8) {
      dragging = true;
      sheet.style.transition = 'none';
      sheet.style.willChange = 'transform'; // 提示合成器建层,后续 transform 不再触发布局/绘制
    }
    if (dragging) sheet.style.transform = 'translateY(' + dy + 'px)';
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (startY == null) return;
    if (dragging) {
      sheet.style.transition = '';
      sheet.style.willChange = '';
      sheet.style.transform = '';
      if (dy > 80) closeSheet(); // inline transform 清掉后 .show 摘除,从拖拽位滑出到 100%
    }
    startY = null; dragging = false; eligible = false;
  });
}

// 边跳按钮：滚动离顶/离底超 500px 才现身，直达顶部/底部（reduced-motion 时瞬时跳）。
// 内容重渲染（切换视图/补数）也会改变可滚距离，MutationObserver 与滚动共用同一 rAF 合并调度。
function setupEdgeJump() {
  const main = document.querySelector('main');
  const top = $('#jumpTop');
  const bottom = $('#jumpBottom');
  if (!main || !top || !bottom) return;
  let ticking = false;
  const update = () => {
    ticking = false;
    const distBottom = main.scrollHeight - main.clientHeight - main.scrollTop;
    top.classList.toggle('show', main.scrollTop > 500);
    bottom.classList.toggle('show', distBottom > 500);
  };
  const schedule = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
  main.addEventListener('scroll', schedule, { passive: true });
  // 视图切换只改 class/hidden（静态设置页无 childList 变更）——补 attributes 观察，否则切视图后按钮显隐滞留
  new MutationObserver(schedule).observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  // 2026-09-11 中途可停:原生 smooth scrollTo 一旦启动无法中止(浏览器无此 API),
  // 改 rAF 分步驱动——每帧滚一步,任何 touchstart/wheel 立即停;content-visibility 卡片
  // 随滚动渐进渲染,一步到位的原生 smooth 在长列表上本来就顿,分步+固定步长反而顺
  let glideRaf = null;
  const stopGlide = () => { if (glideRaf) { cancelAnimationFrame(glideRaf); glideRaf = null; } };
  const glideTo = (target) => {
    stopGlide();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { main.scrollTop = target; return; }
    const DURATION = 450; // 总时长 ms,长滚快滚;与原 0.2s PTR/0.28s sheet 过渡同量级
    const start = main.scrollTop, dist = target - start, t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / DURATION);
      // easeOutCubic:起步快后减速,松手前渐慢——中途停时不会甩
      main.scrollTop = start + dist * (1 - Math.pow(1 - k, 3));
      if (k < 1) glideRaf = requestAnimationFrame(step);
      else glideRaf = null;
    };
    glideRaf = requestAnimationFrame(step);
  };
  // 用户任何触碰/滚轮=接手:立即停,停在哪算哪
  main.addEventListener('touchstart', stopGlide, { passive: true, capture: true });
  main.addEventListener('wheel', stopGlide, { passive: true, capture: true });
  top.addEventListener('click', () => glideTo(0));
  bottom.addEventListener('click', () => glideTo(main.scrollHeight - main.clientHeight));
  update();
}

/* ---------------- 启动 ---------------- */
async function init() {
  // SW 注册放最前：弱网首访不至于等几十秒的网络超时后才装上
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('unhandledrejection', (e) => { console.warn('[mp] 未处理的 Promise 拒绝：', e.reason); });
  // 2026-09-11 一屏到底批:版本号进日期长按弹层 title;设置页已删
  try {
    // 快照/历史/预热缓存并行读，首个网络请求不必排队等 IDB 串行往返
    const [snap, hist, warm] = await Promise.all([
      getKV('lastGood', null).catch(() => null),
      getAllHistory().catch(() => []),
      getKV('warmCache', null).catch(() => null),
    ]);
    if (warm && warm.kline) hydrateKlineCache(warm.kline); // 当日 K线命中 → enrichPromo 免重抓
    if (warm && warm.openPct) { state.openPctByCode = warm.openPct; state.openPctDate = warm.openPctDate || ''; }
    // 竞价终态水合（date 校验当日有效）：重开 app 免重抓全池，promo/预期差/抽屉立即有撮合口径
    if (warm && warm.auction && warm.auction.available && String(warm.auction.date) === todayStr()) applyAuctionPayload(warm.auction);
    state.refreshMs = 8000; // 2026-09-11 一屏到底批:设置已删,固定 8 秒(同日由 5s 上调——渲染压力减 40%,用户实测新鲜度差别不大;失败退避逻辑仍在)
    bind();
    state.history = hist.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    state.historyLoaded = hist.length > 0;
    // 快照水合：离线/弱网冷启动先显示上次成功数据（状态条标「快照」），新数据到达后替换
    if (snap && snap.pools && Array.isArray(snap.pools.up)) {
      state.pools = snap.pools;
      state.fromSnapshot = true;
      state.lastGoodAt = snap.savedAt || 0;
      state.marketClosed = !state.manualDate && !isTradingDay(todayStr()); // 2026-09-13 检查批:水合渲染先于首次 refresh,此处不设会闪「非交易时段」错横幅
      computeDerived(snap.pools);
      renderStatus();
      renderCurrentView();
    }
    await refresh();
    applyRefreshTimer();
    maybeAuctionTick(); // 冷启动落在竞价窗口内时立即采集（不等首个 15s tick）
  } catch (e) {
    console.error('[mp] 启动失败：', e);
    try { toast('启动出现问题：' + (e.message || e)); } catch (e2) { /* ignore */ }
  }
}
// 新 SW 接管后自动重载一次，消除「新 HTML 配旧 JS/CSS」的混合版本窗口；
// 首次安装的 claim 不算升级；sessionStorage 防循环重载。
if ('serviceWorker' in navigator) {
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    if (sessionStorage.getItem('mp-sw-reloaded')) return;
    sessionStorage.setItem('mp-sw-reloaded', '1');
    location.reload();
  });
}
init();
