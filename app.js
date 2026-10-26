// app.js — 编排层：数据加载、刷新循环、导航、共享渲染、详情抽屉、历史补录
import { fetchPools, fetchQuotes, fetchTopGainers, fetchKlineLite, cachedKlineBars, storeKlineBars, hydrateKlineCache, exportKlineCache, todayStr, fmtTime, shanghaiNow, shanghaiOf, setEmaToken, shouldRefetchGap, collectAuctionSnapshot, pickAuctionCoreCodes, boardTag, isTradingDay, lastTradingDate, fetchKlineTencent, fetchMonitorPool, fetchHotConcepts } from './data.js'; // 2026-09-15 情报批:+监控池/概念命中
import {
  calculateBreakRate, calculatePromotionStats, buildThemeRanking, rankCoreLeaders, rankOpportunities,
  calculateEmotionState, yesterdayPremium, buildRiskRadar, buildMarketStructure, buildPlan, buyTypeOf,
  buildExpectationGap, buildSignal, applyGate, assessmentRules,
  assessPromotion, klineFeatures, cycleOf, winratePosition, contextNotes, stockSimilarCases, exitSignalsOf,
  detectPreSealAlerts, buildAuctionWatchlist, limitThresholdOf, isInTradingSession, limitPriceOf, isMainBoardShare, isExcludedPreSealName, PARAM_MANIFEST
} from './analytics.js';
import { getWatch, putWatch, delWatch, clearWatch, getKV, setKV, getAllHistory, putHistory, pruneHistoryKeep } from './store.js';
import { renderOpportunity, renderLadder, renderStructure, esc, fmtMoney, pctClass, pctText, tierBadge, signalTag, setHTML, patchCardList, revealList } from './views.js'; // 2026-09-12 折叠版批:BD_LABELS 已随评分构成条删除(唯一调用方)
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
  preSealOff: false, // 抢时间批:封板前预警总开关(false=开;设置里可关,关了只 toast 不弹通知/震动/声音)
  bgUntil: 0, // C1 后台宽限:切后台后不立即停刷,在窗口内继续 tick 让封板前预警还能命中(见 refreshTick/visibilitychange)
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
  // 封板前预警已从派生链剥离(2026-10-24):由 preSealTick 独立 15s 扫描,不再受 deriveSig 早退影响
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
    // 2026-09-16 界面优化批⑤:收盘定格标识(与桌面会话条同口径)——数字不会再变须明说,防把收盘数据当盘中读
    const now = shanghaiNow();
    const afterClose = isTradingDay(todayStr()) && (now.getHours() > 15 || (now.getHours() === 15 && now.getMinutes() >= 5));
    if (afterClose && !failed) { freshAt.textContent = ' · 已收盘'; freshAt.className = 'fresh-at stale'; freshAt.title = '收盘定格数据,明日开盘恢复刷新'; }
    else if (failed) { freshAt.textContent = ' · 失败'; freshAt.className = 'fresh-at bad'; freshAt.title = '最近刷新失败,展示上次数据'; }
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
let monitorPoolAt = 0;
async function refreshMonitorPool() { // 2026-09-15 避雷批:监控池 30 分钟节流(静态名单,低频)
  if (Date.now() - monitorPoolAt < 30 * 60 * 1000) return;
  monitorPoolAt = Date.now();
  try {
    state.monitorPool = await fetchMonitorPool();
    document.querySelectorAll('.card[data-code]').forEach((card) => {
      const nameEl = card.querySelector('.name');
      if (!nameEl || nameEl.querySelector('.mon-flag')) return;
      const mon = (state.monitorPool || []).find((m) => m.code === card.dataset.code);
      if (mon) nameEl.insertAdjacentHTML('beforeend', '<i class="mon-flag" title="重点监控至' + esc(mon.end) + '">监</i>');
    });
  } catch { /* 静默:无标记即无警示,下轮池刷新重试 */ }
}

function monFlag(code) { // 2026-09-15 避雷批:重点监控池标记(交易所风险警示,卡片名旁琥珀「监」)
  const mon = (state.monitorPool || []).find((m) => m.code === code);
  return mon ? '<i class="mon-flag" title="重点监控至' + esc(mon.end) + '">监</i>' : '';
}

function ztCard(x) {
  const bcls = x.boards >= 4 ? 'boards-tag hi' : x.boards === 1 ? 'boards-tag b1' : 'boards-tag';
  const pv = x.promo && x.promo.available !== false ? x.promo : null;
  const pvc = pv ? (pv.verdict === '可接力' ? 'pass' : pv.verdict === '观望' ? 'warn' : 'fail') : '';
  const pvTip = pv ? esc(pv.score + ' 分 · ' + ((pv.hardFails || []).length ? pv.hardFails.join('；') : '点开看八维检查表')) : '';
  const auc = aucInfoOf(x.code);
  return '<div class="card" data-code="' + x.code + '" data-boards="' + (x.boards || 1) + '">' + // data-boards 供板位条点格定位(2026-09-11 拆解融合批)
    '<div class="' + bcls + '">' + (x.boards || 1) + '板</div>' +
    '<div><div class="name">' + esc(x.name) + boardTag(x.code) + monFlag(x.code) + '</div>' +
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
  // 2026-10-22 小字清理:删「Token 失效→去设置更换」——设置页 2026-09-11 已砍,该引导指向不存在的入口(误导空态)
  const msg = err && err.message ? String(err.message) : '网络不可用或接口暂不可达';
  setHTML($('#ztList'), '<div class="empty">暂无行情数据<br /><span class="muted">' + esc(msg) + '</span>' +
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
  // 2026-10-22 小字清理:原文案让用户「补录历史」,但设置页砍后手机端已无该入口(loadHistory 零调用方)——改中性空态
  if (!yest) { sum.textContent = '需历史'; setHTML(gapEl, '<div class="muted">暂无前一交易日数据</div>'); return; }
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


// 2026-09-15 明日参考批(用户拍板,桌面做涨跌率/手机做算得了的晋级率):同板位历史晋级率——
// 跨全历史所有相邻交易日累计(非只昨日),n=分母只数;三纪律同桌面:样本量必显示/Wilson 下界/「参考」措辞
function boardPromoRef(hist, today) {
  const buckets = {};
  for (let i = 1; i < hist.length; i += 1) {
    const r = calculatePromotionStats(hist[i - 1].stocks, hist[i].stocks);
    if (!r.available) continue;
    for (const g of r.byBoard) {
      const key = g.board >= 4 ? '4+' : String(g.board);
      if (!buckets[key]) buckets[key] = { n: 0, up: 0 };
      buckets[key].n += g.denominator;
      buckets[key].up += g.promoted;
    }
  }
  return buckets;
}
function wilsonLower(up, n) {
  if (!n) return null;
  const z = 1.96, p = up / n;
  const denom = 1 + z * z / n;
  const center = p + z * z / (2 * n);
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return Number((Math.max(0, (center - margin) / denom) * 100).toFixed(1));
}

/* ---------------- 抢时间批·封板前预警(2026-10-10；2026-10-24 双层重构,与桌面同批) ----------------
   旧版两个死结：
   ① 检测源 = 今日涨停池(pools.up)——池里全是已封板票，mapPool 又不产 isLimitUp，
      「已封不报」永远不成立 → 退化成「封死后每 30 分钟重推一次」。
   ② detectPreSeal() 埋在 computeDerived() 里，而 deriveSig 不含实时涨幅——池成员一稳定就整轮早退，
      只有整页重载才会再跑一次(用户现象：开着时间长了必须手动刷新才推)。
   新版对齐桌面 server.js:runPreSealScan：
   ① 核心层 = 上一交易日涨停池 ∪ 今日炸板池 ∪ 竞价候选，逐票推；只做主板A股，排除 ST/新股
   ② 数据 = 实时报价(price/prevClose)，按「精确涨停价」(昨收算到分)判定未封且距涨停 ≤1.5pp
   ③ 炸板回封：封→跌破 1pp 记炸板，重新逼近到距涨停 0.5pp 内再推(受重复提醒规则约束)
   ④ 全市场层 = 涨幅榜前 300 里临近涨停、成交额≥1亿的票，合并摘要推，最快 2 分钟一条
   ⑤ 9:26-9:29 用涨幅榜竞价撮合价预扫，覆盖开盘秒板
   ⑥ 重复提醒(2026-10-24 用户拍板):不设次数上限；同一票同一类必须先从上次提醒涨幅
      回落 ≥3pp，且距上次 ≥20 分钟，才允许再次提醒；不满足绝不重复。
   ⑦ 核心推送全局节流:最多每 15s 一条，一轮多事件合并成一条，节流窗口内进 backlog 不丢票。 */
let preSealPrevSnap = new Map();
let preSealPrevPoolCache = { forDate: '', stocks: [] };
let preSealPrevPoolRetryAt = 0;
let preSealRepeat = { date: '', byKey: new Map() }; // code:kind -> {count,lastAt,lastPct,resetReady}
let preSealCorePushAt = 0;
let preSealCoreBacklog = [];
let preSealScanAt = 0;
let preSealScanInflight = null;
let preSealWatchSig = '';
let preSealState = { date: '', byCode: new Map() }; // 回封状态:sealed/broken/init
let preSealRankingCache = { at: 0, rows: [] };
let preSealDigest = { date: '', byCode: new Map(), lastAt: 0, auctionSent: false }; // 摘要重复账本(与核心层同口径)
const PRESEAL_SCAN_MS = 15_000;
const PRESEAL_RANKING_MS = 30_000;
const round2 = (x) => Math.round(Number(x) * 100) / 100;

// 上一交易日(YYYYMMDD)：从 today 往前找第一个交易日；找不到返回空串
function preSealPrevTradingDate(today) {
  const y = Number(String(today).slice(0, 4)); const m = Number(String(today).slice(4, 6)); const d = Number(String(today).slice(6, 8));
  const base = new Date(y, m - 1, d);
  for (let i = 1; i <= 15; i += 1) {
    const x = new Date(base.getTime() - i * 86_400_000);
    const k = `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
    if (isTradingDay(k)) return k;
  }
  return '';
}
// 上一交易日收盘涨停池(今日接力候选)。优先本机历史库；没有则拉一次并落库。
async function preSealPrevPool(today) {
  if (preSealPrevPoolCache.forDate === today) return preSealPrevPoolCache.stocks;
  if (Date.now() < preSealPrevPoolRetryAt) return [];
  const prevDate = preSealPrevTradingDate(today);
  if (!prevDate) return [];
  let pool = null;
  const histPrev = (state.history || []).filter((h) => String(h.date) < String(today)).pop();
  if (histPrev && String(histPrev.date) === prevDate && (histPrev.stocks || []).length) pool = histPrev.stocks;
  if (!pool || !pool.length) {
    try {
      const p = await fetchPools(prevDate, { tries: 2, timeoutMs: 6000 });
      pool = p.up || [];
      if (pool.length) {
        const rec = { date: prevDate, stocks: pool.map((s) => ({ code: s.code, boards: s.boards, industry: s.industry, name: s.name, breaks: s.breakCount ?? null, turnoverRate: s.turnoverRate ?? null })) };
        putHistory(rec).catch(() => {});
      }
    } catch { pool = null; }
  }
  const stocks = (pool || []).map((s) => {
    const code = String(s.code || '');
    const name = String(s.name || code);
    return { code, name, boards: Number(s.boards || 1) };
  }).filter((s) => isMainBoardShare(s.code) && !isExcludedPreSealName(s.name));
  if (!stocks.length) { preSealPrevPoolRetryAt = Date.now() + 5 * 60_000; return []; } // 空名单不缓存,5 分钟后重试
  preSealPrevPoolCache = { forDate: today, stocks };
  return stocks;
}
// 核心名单 = 昨日涨停 ∪ 今日炸板 ∪ 竞价候选。炸板/竞价来自实时 state，每轮重建。
async function preSealCoreWatch(today) {
  const prev = await preSealPrevPool(today);
  const map = new Map();
  const add = (s, source) => {
    const code = String(s?.code || '');
    const name = String(s?.name || code);
    if (!isMainBoardShare(code) || isExcludedPreSealName(name)) return;
    const exist = map.get(code);
    if (exist) { if (source && !exist.sources.includes(source)) exist.sources.push(source); return; }
    map.set(code, { code, name, boards: Number(s.boards || 1), boardLimitPct: limitThresholdOf(code, name), sources: source ? [source] : [] });
  };
  for (const s of prev) add(s, '昨日涨停');
  const payloadToday = String(state.pools?.date || '') === today;
  if (payloadToday) {
    for (const s of state.pools?.broken || []) add(s, '今日炸板');
    // 竞价候选只在竞价数据是今日时才算数,避免第二天开盘前读到昨日竞价缓存
    if (String(state.auction?.date || '') === today) {
      const aw = buildAuctionWatchlist({ auction: state.auction || {}, opportunities: state.opportunities || {}, leaders: state.leaders || [], gap: state.gap || {}, stocks: state.pools?.up || [], limit: 8 });
      if (aw.available) for (const it of aw.items) add(it, '竞价候选');
    }
  }
  const list = [...map.values()];
  // 供 sw.js 后台 periodicSync 共用同一份核心名单；只在变化时写，避免每 15s 一次 IDB 写
  const sig = list.map((s) => s.code + ':' + s.boardLimitPct + ':' + (s.sources || []).join('+')).join(',');
  if (sig !== preSealWatchSig) { preSealWatchSig = sig; setKV('preSealWatch', { forDate: today, stocks: list }).catch(() => {}); }
  return list;
}
// 当日重复提醒账本:code:kind -> {count,lastAt,lastPct,resetReady}。跨刷新/前后台/SW 共用。
// 每次扫描重读:SW 后台可能刚写过,内存缓存会漏掉它推过的票导致重复。
async function loadPreSealRepeat(today) {
  const saved = await getKV('preSealRepeat', null).catch(() => null);
  const byKey = new Map();
  if (saved && saved.date === today && saved.byKey) for (const [k, v] of Object.entries(saved.byKey)) byKey.set(k, v);
  preSealRepeat = { date: today, byKey };
  return byKey;
}
function savePreSealRepeat() {
  if (!preSealRepeat) return;
  // 写入前与库里的账本并集(同一 key 取 lastAt 更新的):SW 后台可能刚写过,直接覆盖会丢它的记录
  getKV('preSealRepeat', null).catch(() => null).then((saved) => {
    if (saved && saved.date === preSealRepeat.date && saved.byKey) {
      for (const [k, v] of Object.entries(saved.byKey)) {
        const cur = preSealRepeat.byKey.get(k);
        if (!cur || (Number(v?.lastAt) || 0) > (Number(cur?.lastAt) || 0)) preSealRepeat.byKey.set(k, v);
      }
    }
    const byKey = {};
    for (const [k, v] of preSealRepeat.byKey) byKey[k] = v;
    return setKV('preSealRepeat', { date: preSealRepeat.date, byKey });
  }).catch(() => {});
}
// 允许再次提醒:从未提醒过 → 允许；提醒过 → 必须已回落重置(resetReady)且距上次 ≥20 分钟。
function preSealCanAlert(repeat, key, now) {
  const st = repeat.get(key);
  if (!st) return true;
  const minInterval = Number(PARAM_MANIFEST.preSealAlert.repeatMinIntervalMs) || 20 * 60_000;
  return Boolean(st.resetReady) && now - st.lastAt >= minInterval;
}
function preSealMarkAlerted(repeat, key, ev, now) {
  const st = repeat.get(key) || { count: 0, lastAt: 0, lastPct: null, resetReady: false };
  st.count += 1;
  st.lastAt = now;
  st.lastPct = Number.isFinite(Number(ev.pct)) ? Number(ev.pct) : null;
  st.resetReady = false;
  repeat.set(key, st);
}
// 回落重置:同一票同一类上次提醒后,涨幅必须回落 ≥3pp 才解锁下一次
function preSealResetRepeat(repeat, stocks, p) {
  for (const [key, st] of repeat) {
    const code = key.slice(0, key.indexOf(':'));
    const s = (stocks || []).find((x) => x.code === code);
    if (!s) continue;
    const base = st.lastPct != null ? st.lastPct : s.limitPct;
    if (s.changePercent <= base - (Number(p.repeatResetOffsetPct) || 3)) st.resetReady = true;
  }
}
// 单条消息的短文案(与桌面 preSealLine 同口径；批量摘要用)
function preSealLine(ev) {
  const gap = Number.isFinite(Number(ev.gapPct)) ? Number(ev.gapPct).toFixed(1) : '--';
  if (ev.kind === 'sealApproach') return `${ev.auction ? '[竞价] ' : ''}距涨停 ${gap}pp（现 ${ev.pct}%）`;
  if (ev.kind === 'reseal') return `回封 · 距涨停 ${gap}pp（现 ${ev.pct}%）`;
  return `急拉 +${ev.rise ?? '--'}%（现 ${ev.pct}%）`;
}
// 涨幅榜(前 300,按涨幅倒序)。30s 缓存;分页/新浪兜底都在 data.js:fetchTopGainers(与桌面同源)。
async function preSealRanking() {
  if (Date.now() - preSealRankingCache.at < PRESEAL_RANKING_MS) return preSealRankingCache.rows;
  try {
    const rows = await fetchTopGainers(300);
    if (rows.length) preSealRankingCache = { at: Date.now(), rows: rows.slice(0, 300) };
  } catch { /* 保留上一轮缓存 */ }
  return preSealRankingCache.rows;
}
// 涨幅榜时间戳新鲜度：竞价段必须来自 09:15-09:30 的竞价快照，否则宁可一条都不推——
// 否则 9:25 拿到昨日收盘涨幅榜，会把昨日「差一点涨停」的票误报成今日竞价临近涨停。
// 东财 f124 是 epoch 秒；新浪没有 f124，用 ticktime(HH:MM:SS) 与当前上海墙钟比对。
function preSealRankFresh(row, now, { auction = false } = {}) {
  const ts = Number(row?.update);
  if (Number.isFinite(ts) && ts > 0) {
    const age = now - ts * 1000;
    if (age < -60_000 || age > 5 * 60_000) return false;
    if (auction) {
      const c = shanghaiOf(ts * 1000);
      const m = c.getHours() * 60 + c.getMinutes();
      return m >= 555 && m <= 590;
    }
    return true;
  }
  const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(row?.ticktime || ''));
  if (m) {
    const rowMin = Number(m[1]) * 60 + Number(m[2]);
    if (auction) return rowMin >= 555 && rowMin <= 590;
    const c = shanghaiNow();
    const nowMin = c.getHours() * 60 + c.getMinutes();
    return Math.abs(rowMin - nowMin) <= 5;
  }
  return !auction; // 无时间戳：竞价段宁可不信
}
// 全市场候选：涨幅榜里「距涨停 ≤1.5pp、未封、成交额达标、主板A股、非ST/新股」的票。
function preSealMarketCandidates(rows = [], { auction = false } = {}) {
  const p = PARAM_MANIFEST.preSealAlert;
  const minAmount = Number(auction ? p.auctionMinAmount : p.marketMinAmount) || 0;
  const out = [];
  for (const row of rows) {
    if (!isMainBoardShare(row.code) || isExcludedPreSealName(row.name)) continue;
    if (!(Number(row.amount) >= minAmount)) continue;
    const limit = limitPriceOf(row.prevClose, row.code, row.name);
    if (!limit) continue;
    const pct = Number(row.changePct);
    if (!Number.isFinite(pct) || pct <= 0) continue;
    if (pct >= limit.effectiveLimitPct - p.sealedTolerancePct) continue; // 已封
    if (pct < limit.effectiveLimitPct - p.approachOffsetPct) continue;  // 还没到线
    out.push({
      code: row.code, name: row.name,
      pct: round2(pct), limitPct: limit.effectiveLimitPct, boardLimitPct: limit.boardLimitPct,
      gapPct: round2(Math.max(0, limit.effectiveLimitPct - pct)), amount: Number(row.amount) || 0,
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}
// 全市场摘要：最快 2 分钟一条(竞价段只发一条)，每条最多 8 只，未列出的下一轮继续，不丢票。
// 2026-10-24 用户拍板:不设单日条数硬上限，只靠时间节流。
// 摘要重复账本(2026-10-26 与网页同口径):code -> {lastAt,lastPct,resetReady}。
// 同一只票须先从上次摘要时的涨幅回落 ≥3pp,且距上次 ≥20 分钟,才允许再次进摘要——
// 不再「一票一天只出现一次」。全局仍保持最多 2 分钟一条、每条最多 8 只。
async function loadPreSealDigest(today) {
  if (preSealDigest.date === today) return preSealDigest;
  const saved = await getKV('preSealDigest', null).catch(() => null);
  const byCode = new Map();
  if (saved && saved.date === today) {
    if (saved.byCode && typeof saved.byCode === 'object') {
      for (const [code, v] of Object.entries(saved.byCode)) byCode.set(code, {
        lastAt: Number(v?.lastAt) || 0,
        lastPct: Number.isFinite(Number(v?.lastPct)) ? Number(v.lastPct) : null,
        resetReady: v?.resetReady === true,
      });
    } else if (Array.isArray(saved.keys)) {
      // 旧账本(keys:Set)迁移:没有当时的涨幅记录,按「已发过」处理,20 分钟内不重复;
      // 之后与网页同口径(缺涨幅记录时保守放行)。
      for (const code of saved.keys) byCode.set(String(code), { lastAt: Number(saved.lastAt) || Date.now(), lastPct: null, resetReady: false });
    }
  }
  preSealDigest = {
    date: today,
    byCode,
    lastAt: Number(saved?.lastAt) || 0,
    auctionSent: saved && saved.date === today ? saved.auctionSent === true : false,
  };
  return preSealDigest;
}
function savePreSealDigest() {
  const byCode = {};
  for (const [code, v] of preSealDigest.byCode) byCode[code] = v;
  setKV('preSealDigest', { date: preSealDigest.date, byCode, lastAt: preSealDigest.lastAt, auctionSent: preSealDigest.auctionSent }).catch(() => {});
}
async function pushPreSealDigest(candidates, { auction = false } = {}) {
  if (!candidates.length || state.preSealOff) return;
  const p = PARAM_MANIFEST.preSealAlert;
  const today = todayStr();
  const st = await loadPreSealDigest(today);
  const now = Date.now();
  const minInterval = Number(p.repeatMinIntervalMs) || 20 * 60_000;
  const resetOffset = Number(p.repeatResetOffsetPct) || 3;
  // 先按本轮涨幅解锁「可再次提醒」:回落 ≥3pp;账本里没有涨幅记录时保守放行。
  for (const c of candidates) {
    const s = st.byCode.get(c.code);
    if (!s) continue;
    if (s.lastPct == null) s.resetReady = true;
    else if (c.pct <= s.lastPct - resetOffset) s.resetReady = true;
  }
  const eligible = [];
  for (const c of candidates) {
    const s = st.byCode.get(c.code);
    if (!s) { eligible.push(c); continue; }
    if (s.resetReady && now - s.lastAt >= minInterval) eligible.push(c);
  }
  if (!eligible.length) return;
  if (auction) {
    if (st.auctionSent) return; // 竞价段只发一条(9:26 撮合价定稿后)
    st.auctionSent = true;
  } else if (now - st.lastAt < (Number(p.digestIntervalMs) || 120_000)) return;
  const maxItems = Number(p.digestMaxItems) || 8;
  const items = eligible.slice(0, maxItems);
  for (const c of items) st.byCode.set(c.code, { lastAt: now, lastPct: c.pct, resetReady: false });
  st.lastAt = now;
  savePreSealDigest();
  const lines = items.map((c) => `${c.name} +${c.pct}%（距涨停 ${c.gapPct}pp · 成交 ${fmtDigestMoney(c.amount)}）`);
  if (eligible.length > items.length) lines.push(`另有 ${eligible.length - items.length} 只，下一条摘要继续`);
  pushNtfy(`MarketPulse · ${auction ? '竞价' : '主板'}临近涨停 ${eligible.length} 只`, lines);
}
// 摘要金额口径与桌面 formatMoney 一致：≥1亿两位小数，否则取整到万
function fmtDigestMoney(v) {
  const a = Number(v || 0);
  return Math.abs(a) >= 100_000_000 ? `${(a / 100_000_000).toFixed(2)}亿` : `${Math.round(a / 10_000)}万`;
}
// 回封状态：今日涨停池=封，炸板池=炸，再用实时涨幅校准；回封是否可推由重复提醒账本判定。
function updatePreSealResealState(today, stocks) {
  if (preSealState.date !== today) preSealState = { date: today, byCode: new Map() };
  const map = preSealState.byCode;
  const p = PARAM_MANIFEST.preSealAlert;
  const brokenToday = new Set((state.pools?.broken || []).map((s) => String(s.code)));
  const sourcesByCode = new Map((stocks || []).map((s) => [s.code, s.sources || []]));
  for (const s of state.pools?.broken || []) { const code = String(s.code); const st = map.get(code) || {}; st.sealed = false; st.broken = true; map.set(code, st); }
  for (const s of state.pools?.up || []) { const code = String(s.code); const st = map.get(code) || {}; st.sealed = true; st.broken = false; map.set(code, st); }
  for (const s of stocks) {
    const st = map.get(s.code) || {};
    // 今日炸板池里的票,首次进入监控时就知道「已经炸过板」,直接进入 broken 状态,
    // 否则要等它先封一次再炸才认,会漏掉当天炸板后的回封。
    if (!st.init) {
      st.init = true;
      if (brokenToday.has(s.code) || (sourcesByCode.get(s.code) || []).includes('今日炸板')) st.broken = true;
    }
    if (s.changePercent >= s.limitPct - p.sealedTolerancePct) { st.sealed = true; st.broken = false; }
    else if (st.sealed && s.changePercent <= s.limitPct - p.resealOffsetPct) { st.sealed = false; st.broken = true; }
    map.set(s.code, st);
  }
  return map;
}

// 独立扫描：不挂在 computeDerived 上，也不依赖页面 8s 刷新是否产生新派生
async function preSealTick() {
  if (state.preSealOff || state.manualDate) return [];
  if (document.hidden && Date.now() >= state.bgUntil) return []; // C1 后台宽限窗口外不白耗流量
  const today = todayStr();
  if (!isTradingDay(today)) return [];
  const clock = shanghaiNow();
  const minutes = clock.getHours() * 60 + clock.getMinutes();
  const inAuction = minutes >= 566 && minutes < 570; // 9:26-9:29 竞价撮合价已定稿,避免 9:25 整拿到未定稿数据
  if (!inAuction && !isInTradingSession(new Date())) return [];
  if (preSealScanInflight) return preSealScanInflight;
  if (Date.now() - preSealScanAt < PRESEAL_SCAN_MS - 1000) return [];
  preSealScanAt = Date.now();
  preSealScanInflight = (async () => {
    const p = PARAM_MANIFEST.preSealAlert;
    const now = Date.now();
    const coreWatch = await preSealCoreWatch(today);
    // 竞价段必须先拿涨幅榜(核心行情也取竞价撮合价);盘中先取核心行情,再取榜单做摘要,
    // 避免涨幅榜接口慢时拖慢核心逐票预警。
    let rankingRows = [];
    let rankingByCode = new Map();
    if (inAuction) {
      rankingRows = (await preSealRanking().catch(() => [])).filter((row) => preSealRankFresh(row, now, { auction: true }));
      rankingByCode = new Map(rankingRows.map((row) => [row.code, row]));
    }

    // —— 核心层行情：竞价段用涨幅榜的竞价撮合价(ulist 此时可能还是昨收)；盘中用实时报价 ——
    let stocks = [];
    if (inAuction) {
      stocks = coreWatch.map((s) => {
        const row = rankingByCode.get(s.code);
        if (!row) return null;
        const limit = limitPriceOf(row.prevClose, s.code, s.name);
        if (!limit) return null;
        return { ...s, limitPct: limit.effectiveLimitPct, boardLimitPct: limit.boardLimitPct, changePercent: Number(row.changePct), price: row.price, preClose: row.prevClose };
      }).filter((s) => s && Number.isFinite(s.changePercent));
    } else {
      // 已封板的票不进报价请求：今日涨停池里的直接跳过，省一半以上请求
      const sealed = new Set((state.pools?.up || []).map((s) => String(s.code)));
      const codes = coreWatch.filter((s) => !sealed.has(s.code)).map((s) => s.code);
      if (codes.length) {
        let quotes = null;
        try { quotes = await fetchQuotes(codes, { tries: 2, timeoutMs: 6000 }); } catch { quotes = null; }
        if (quotes) {
          stocks = coreWatch.map((s) => {
            const q = quotes[s.code];
            if (!q || q.price == null || !q.prevClose) return null;
            // 半日市/停牌/数据源卡死时旧价会一直停在涨停附近,不拦会在午后重复触发
            if (q.update && Math.abs(now - q.update * 1000) > 5 * 60_000) return null;
            const changePercent = (q.price / q.prevClose - 1) * 100;
            if (!Number.isFinite(changePercent)) return null;
            const limit = limitPriceOf(q.prevClose, s.code, s.name);
            return {
              ...s,
              limitPct: limit ? limit.effectiveLimitPct : s.boardLimitPct,
              boardLimitPct: limit ? limit.boardLimitPct : s.boardLimitPct,
              changePercent, price: q.price, preClose: q.prevClose,
            };
          }).filter(Boolean);
        }
      }
    }

    // —— 回封：先记已封/炸板，再从炸板低位重新逼近涨停时推(受重复提醒规则约束) ——
    const stateMap = updatePreSealResealState(today, stocks);
    const repeat = await loadPreSealRepeat(today);
    preSealResetRepeat(repeat, stocks, p);
    const resealEvents = [];
    for (const s of stocks) {
      const st = stateMap.get(s.code) || {};
      if (st.broken && preSealCanAlert(repeat, `${s.code}:reseal`, now)
        && s.changePercent >= s.limitPct - p.resealTriggerOffsetPct
        && s.changePercent < s.limitPct - p.sealedTolerancePct) {
        st.broken = false;
        resealEvents.push({
          code: s.code, name: s.name, kind: 'reseal',
          pct: round2(s.changePercent), limitPct: s.limitPct, boardLimitPct: s.boardLimitPct,
          gapPct: round2(Math.max(0, s.limitPct - s.changePercent)), auction: inAuction, t: now,
        });
      }
    }

    const events = stocks.length ? detectPreSealAlerts({
      stocks, watchCodes: stocks.map((s) => s.code), prevSnap: preSealPrevSnap, now,
      inCooldown: (key) => !preSealCanAlert(repeat, key, now),
    }) : [];
    for (const ev of events) ev.auction = inAuction;
    // 每轮都更新快照（急拉判定要连续两拍），重复提醒由 repeat 账本闸住
    preSealPrevSnap = new Map(stocks.map((s) => [s.code, { pct: s.changePercent, t: now }]));
    const resealCodes = new Set(resealEvents.map((ev) => ev.code));
    const accepted = [];
    for (const ev of [...events.filter((e) => !resealCodes.has(e.code)), ...resealEvents]) {
      const key = `${ev.code}:${ev.kind}`;
      if (!preSealCanAlert(repeat, key, now)) continue; // 未回落重置/不满20分钟不重复
      preSealMarkAlerted(repeat, key, ev, now);
      accepted.push(ev);
    }
    if (accepted.length) savePreSealRepeat();
    pushCoreEvents(accepted, now);

    // —— 全市场层：排除核心名单后，按摘要推送(盘中到这一步才拉榜单,不拖慢核心预警) ——
    if (!inAuction) rankingRows = (await preSealRanking().catch(() => [])).filter((row) => preSealRankFresh(row, now, { auction: false }));
    const coreCodes = new Set(coreWatch.map((w) => w.code));
    const marketCandidates = preSealMarketCandidates(rankingRows, { auction: inAuction }).filter((c) => !coreCodes.has(c.code));
    pushPreSealDigest(marketCandidates, { auction: inAuction }).catch(() => {});
    return accepted;
  })().finally(() => { preSealScanInflight = null; });
  return preSealScanInflight;
}
let preSealTimer = null;
function startPreSealMonitor() {
  if (preSealTimer) return;
  preSealTimer = setInterval(() => { preSealTick().catch(() => {}); }, PRESEAL_SCAN_MS);
  preSealTick().catch(() => {});
}
// C3 本地封板前预警→ntfy:App/SW 命中后直接 POST 到用户配置的 ntfy 主题(通道与桌面 server 一致,锁屏送达率比 PWA SW 通知高)。
// 配置存 IDB kv 的 pushNtfyUrl(形如 https://ntfy.sh/<主题>);未配置则静默跳过。
// JSON publish 三条实测规则(同桌面 notify.js,2026-10-12):打根路径 /、priority 数字、tags 数组——缺一条即 400 或退化成裸 JSON。
async function pushNtfy(title, lines) {
  try {
    const url = await getKV('pushNtfyUrl', '');
    if (!url || !/^https?:\/\//i.test(url)) return; // 未配置即跳过(用户没填就不发)
    const root = new URL(url).origin + '/';
    const body = JSON.stringify({ topic: url.split('/').filter(Boolean).pop(), title, message: lines.join('\n'), priority: 4, tags: ['warning', 'bell'] });
    // 2026-10-26 与网页同口径:偶发 5xx/网络抖动立即重试 2 次(2s/5s),不再一次失败就丢掉提醒。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await new Promise((r) => setTimeout(r, attempt === 1 ? 2000 : 5000));
      try {
        const res = await fetch(root, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        if (res && res.ok) return;
      } catch { /* 下一轮重试 */ }
    }
    console.warn('[C3] ntfy 推送重试 2 次后仍失败', title);
  } catch { /* ntfy 发送失败静默,不打断三提醒 */ }
}
/* ---------------- C2 锁屏准点:注册 periodicSync 后台预警 ---------------- */
// 配了 ntfy 且本机 Chrome 给了 periodicSync 权限(已探测「能锁屏准时」)才生效;否则静默跳过(退回 C1 切后台短窗)。
// 注意:Chrome 对 periodicSync 的调度是「尽力而为」,实际间隔由浏览器决定,不保证 10 分钟——
//   关闭 App 后真正可靠的推送仍依赖桌面 server.js 的独立监控(见 pushPreSeal)。
async function setupPeriodicSync() {
  try {
    const url = await getKV('pushNtfyUrl', '');
    if (!url || !('serviceWorker' in navigator) || !('periodicSync' in ServiceWorkerRegistration.prototype)) return;
    const reg = await navigator.serviceWorker.ready;
    await reg.periodicSync.register('mp-preseal', { minInterval: 10 * 60_000 }); // 交易时段约每 10 分钟唤醒
    console.log('[C2] periodicSync mp-preseal 已注册');
  } catch (e) { /* 不支持/被拒静默,退回 C1 */ }
}

/* ---------------- C2 探测:periodicSync + SW 本地通知 ---------------- */
// 长按星脉填主题末尾加 ?probe 触发。探测本机 Chrome 对 PWA 的 periodicSync(C2 锁屏准点的唯一可控前提)。
// 结果分条大字慢速连播 toast(防闪太快看不清),并存 KV mpC2Probe 供诊断。
async function runC2Probe() {
  const steps = [];
  try {
    if ('serviceWorker' in navigator && 'periodicSync' in ServiceWorkerRegistration.prototype) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.periodicSync.register('mp-probe', { minInterval: 60 * 60 * 1000 });
        await reg.periodicSync.unregister('mp-probe');
        steps.push('1/3 支持 periodicSync');
        steps.push('2/3 结论: 能锁屏准时');
        steps.push('3/3 我去加后台代码');
      } catch (e) {
        steps.push('1/3 有 periodicSync');
        steps.push('2/3 结论: 被拒绝 ' + e.name);
        steps.push('3/3 要开 Chrome flag');
      }
    } else {
      steps.push('1/3 没有 periodicSync');
      steps.push('2/3 结论: 不能锁屏准时');
      steps.push('3/3 只能切后台短窗');
    }
  } catch (e) { steps.push('探测异常 ' + e.message); }
  console.log('[C2 探测]', steps.join(' | '));
  try { setKV('mpC2Probe', { at: Date.now(), steps }); } catch {}
  steps.forEach((s, i) => setTimeout(() => toast(s), i * 2200)); // 每条停 2.2 秒,慢慢看
}

// 三提醒统一入口:开关 store 读取;SW 通知(有权限才发)+震动+声音+行高亮
function firePreSealAlert(ev) {
  const label = ev.name && ev.name !== ev.code ? ev.name : ev.code;
  const auctionPrefix = ev.auction ? '集合竞价 · ' : '';
  const boardText = Number.isFinite(Number(ev.boardLimitPct)) ? `涨停 ${ev.boardLimitPct}%` : '';
  const boardsText = Number(ev.boards) > 1 ? ` · 昨日${ev.boards}板` : '';
  const text = ev.kind === 'sealApproach'
    ? `${auctionPrefix}距涨停 ${ev.gapPct ?? '--'}pp（现 ${ev.pct}%${boardText ? '，' + boardText : ''}）${boardsText}`
    : ev.kind === 'reseal'
      ? `${auctionPrefix}炸板回封 · 距涨停 ${ev.gapPct ?? '--'}pp（现 ${ev.pct}%）${boardsText}`
      : `30秒急拉 +${ev.rise ?? '--'}%（现 ${ev.pct}%）`;
  const title = ev.kind === 'sealApproach' ? '封板前预警' : ev.kind === 'reseal' ? '回封预警' : '急拉预警';
  toast(`${label} ${text}`);
  if (state.preSealOff) return; // 设置里关了就只 toast 不打扰
  // 系统通知:走已注册的 SW(showNotification),App 前台也能弹统一系统通知
  try {
    if ('serviceWorker' in navigator && Notification.permission === 'granted') {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, { body: `${label} ${text}`, tag: `preseal-${ev.code}`, icon: './icons/icon-192.png', badge: './icons/icon-192.png' })).catch(() => {});
    } else if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body: `${label} ${text}`, tag: `preseal-${ev.code}` });
    }
  } catch { /* 通知失败静默 */ }
  pushNtfy(`MarketPulse · ${label} ${title}`, [`${label} ${text}`, `时间 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`]); // C3:再发一路 ntfy(锁屏送达率比 PWA SW 通知高,通道与桌面推送一致)
  try { if (navigator.vibrate) navigator.vibrate(ev.kind === 'surge' ? 150 : [200, 100, 200]); } catch { /* 震动失败静默 */ }
  playAlertSound(ev.kind);
  markPreSealRow(ev.code);
}
// 核心推送全局节流:最多每 15s 一条;一轮多个事件合并成一条,节流窗口内进 backlog 不丢票。
function pushCoreEvents(events, now) {
  // 积压事件超过 2 分钟直接丢弃:收盘/隔夜后才 flush 的旧预警没有交易价值。
  const batch = preSealCoreBacklog.concat(events || []).filter((ev) => now - ev.t <= 2 * 60_000);
  preSealCoreBacklog = [];
  if (!batch.length) return;
  if (now - preSealCorePushAt < PRESEAL_SCAN_MS) { preSealCoreBacklog = batch; return; }
  preSealCorePushAt = now;
  if (batch.length === 1) firePreSealAlert(batch[0]);
  else firePreSealBatch(batch);
}
// 批量提醒:一条系统通知 + 一条 ntfy,最多列 8 只(与桌面 pushPreSealBatch 同口径)
function firePreSealBatch(events) {
  const lines = events.slice(0, 8).map((ev) => `${ev.name} ${preSealLine(ev)}`);
  if (events.length > 8) lines.push(`另有 ${events.length - 8} 只`);
  toast(`封板前预警 ${events.length} 只`);
  if (state.preSealOff) return;
  const body = lines.join('\n');
  try {
    if ('serviceWorker' in navigator && Notification.permission === 'granted') {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification('封板前预警', { body, tag: 'preseal-batch', icon: './icons/icon-192.png', badge: './icons/icon-192.png' })).catch(() => {});
    } else if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('封板前预警', { body, tag: 'preseal-batch' });
    }
  } catch { /* 通知失败静默 */ }
  pushNtfy(`MarketPulse · 封板前预警 ${events.length} 只`, [...lines, `时间 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`]);
  try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch { /* 震动失败静默 */ }
  playAlertSound(events.some((ev) => ev.kind !== 'surge') ? 'sealApproach' : 'surge');
  for (const ev of events) markPreSealRow(ev.code);
}
let _alertCtx = null;
function playAlertSound(kind) {
  try {
    _alertCtx = _alertCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_alertCtx.state === 'suspended') _alertCtx.resume().catch(() => {});
    const now = _alertCtx.currentTime;
    const seq = (kind === 'sealApproach' || kind === 'reseal') ? [[880, 0], [1174, 0.14]] : [[660, 0], [880, 0.12]];
    for (const [freq, off] of seq) {
      const osc = _alertCtx.createOscillator(); const gain = _alertCtx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + off);
      gain.gain.exponentialRampToValueAtTime(0.3, now + off + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + off + 0.16);
      osc.connect(gain); gain.connect(_alertCtx.destination);
      osc.start(now + off); osc.stop(now + off + 0.18);
    }
  } catch { /* 声音失败静默 */ }
}
function markPreSealRow(code) {
  document.querySelectorAll(`[data-code="${code}"]`).forEach((el) => { el.classList.add('preseal-flash'); setTimeout(() => el.classList.remove('preseal-flash'), 6000); });
}
if (typeof window !== 'undefined') { window.firePreSealAlert = firePreSealAlert; window.renderAuctionWatchlist = renderAuctionWatchlist; window.preSealTick = preSealTick; } // 测试注入点(PWA 验证用,无生产副作用)

// 2026-10-12 减法:通知授权引导横条(setupNotifBanner)整删——见 init 内注释。主推送走 ntfy,不需浏览器通知权限。

// 抢时间批·盘前竞价打板候选名单(2026-10-10):与桌面 renderAuctionWatchlist 同逻辑。
// 数据源=本地 state.auction(撮合)+opportunities(机会级)+leaders(龙头)+gap(超预期),无竞价数据隐藏折叠。
function renderAuctionWatchlist() {
  const fold = $('#awFold');
  if (!fold) return;
  const wl = buildAuctionWatchlist({ auction: state.auction || {}, opportunities: state.opportunities || {}, leaders: state.leaders || [], gap: state.gap || {}, limit: 8 });
  if (!wl.available || !wl.items.length) { fold.hidden = true; return; }
  const sig = wl.items.map((i) => i.code + i.matchPct).join(',');
  if (state._awSig === sig) { fold.hidden = false; return; } // 内容未变不重绘(15s 轮询防抖)
  state._awSig = sig;
  fold.hidden = false;
  const phase = wl.phase === 'live' ? '竞价进行中' : '9:25 撮合';
  $('#awSummary').textContent = `${phase} · ${wl.items.length} 只`;
  setHTML($('#awRows'), wl.items.map((it, idx) => `
    <div class="aw-row" data-code="${esc(it.code)}" role="button" tabindex="0">
      <span class="aw-rank">${idx + 1}</span>
      <span class="aw-main"><strong>${esc(it.name)}</strong><small>${esc(it.code)}${it.boards ? ` · ${it.boards}板` : ''}</small></span>
      <strong class="aw-pct ${it.matchPct > 0 ? 'up' : it.matchPct < 0 ? 'down' : ''}">${it.matchPct > 0 ? '+' : ''}${it.matchPct}%</strong>
      <span class="aw-meta">${it.volRatio != null ? `<small>量比 ${it.volRatio}</small>` : ''}${it.tier ? `<b class="aw-tier aw-tier-${esc(it.tier)}">${esc(it.tier)}级</b>` : ''}</span>
      ${it.tag ? `<span class="aw-tag">${esc(it.tag)}</span>` : ''}
    </div>`).join(''));
  $$('#awRows .aw-row').forEach((row) => {
    const open = () => openSheet(row.dataset.code);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
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
  const d = state.manualDate || String(state.pools?.date || '') || todayStr(); // String():旧 IDB 快照的 date 是数字(qdate 原样),拔类型雷
  const wd = ['日', '一', '二', '三', '四', '五', '六'][new Date(d.slice(0, 4), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8))).getDay()];
  $('#dateLabel').textContent = d.slice(4, 6) + '-' + d.slice(6, 8) + ' 周' + wd;
  $('#dateLabel').title = d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
  updateBanner();
  loadGap();
  renderAuctionWatchlist(); // 抢时间批:9:25 竞价打板候选名单(本地算,竞价有数据才显示)
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

  // 2026-09-13 精简批(用户拍板):抽屉最终形态——10秒层 + 晋级检查表(唯一深挖区,默认展开)
  // + 相似日后续表现单行(后台静默加载)。集合竞价/行情明细/相似形态卡三组砍
  // (竞价信息仍活在卡片竞价行与八维「竞价承接」维度,只是抽屉无深挖区)。
  const pv = stock.promo && stock.promo.available !== false;
  let verdictHtml = '<div class="s-verdict">';
  if (stock.tier) verdictHtml += '<span class="sv-line">' + tierBadge(stock.tier) + ' <b>评分 ' + (stock.score ?? '--') + '</b></span>';
  if (pv) {
    const vcls = stock.promo.verdict === '可接力' ? 'pass' : stock.promo.verdict === '观望' ? 'warn' : 'fail';
    verdictHtml += '<span class="sp-verdict verdict-' + vcls + '"><b>' + esc(stock.promo.verdict) + '</b><span>' + stock.promo.score +
      ' · 容错 ' + (stock.promo.faultTolerance != null ? Math.round(stock.promo.faultTolerance * 100) + '%' : '--') + '</span></span>';
    if ((stock.promo.hardFails || []).length) verdictHtml += '<span class="sv-fail">硬否决：' + esc(stock.promo.hardFails.join('、')) + '</span>';
    if ((stock.promo.downgrades || []).length) verdictHtml += '<span class="sv-warn">降级：' + esc(stock.promo.downgrades.join('、')) + '</span>';
  } else if (!stock.tier) verdictHtml += '<span class="muted">暂无评级</span>';
  verdictHtml += '</div>';

  let signalHtml = '';
  if (stock.signal) {
    const sg = stock.signal;
    signalHtml = '<div class="s-signal"><div class="st">' + signalTag(sg.state) + '</div>' +
      (sg.triggers && sg.triggers.length ? '<div class="muted">触发条件：' + sg.triggers.join(' / ') + '</div>' : '') +
      (sg.risks && sg.risks.length ? '<div class="muted" style="color:var(--red)">风险：' + sg.risks.join(' / ') + '</div>' : '') + '</div>';
  }
  // 晋级八维检查表:唯一深挖区,默认展开(其余深挖组已砍,不再需要折叠挡路)
  let promoHtml = '';
  if (pv && Array.isArray(stock.promo.checklist)) {
    const icons = { pass: '✓', warn: '!', fail: '✕', na: '–' };
    promoHtml = '<div class="s-promo">' +
      stock.promo.checklist.map((row) => '<div class="promo-row status-' + row.status + '"><i>' + (icons[row.status] || '·') + '</i><span class="k">' + esc(row.label) + '</span><em>' + esc(row.note) + '</em></div>').join('') +
      '<div class="muted" style="margin-top:6px">体系规则参考，非投资建议</div></div>';
  }
  const mon = (state.monitorPool || []).find((m) => m.code === code);
  body.innerHTML = head + verdictHtml + signalHtml +
    (mon ? '<div class="s-risk">⚠ 交易所重点监控中 · 至' + esc(mon.end) + '</div>' : '') +
    '<div class="s-concepts" id="sheetConcepts" hidden><span class="muted">概念命中</span><div class="con-tags" id="sheetConceptTags"></div></div>' +
    '<div id="sheetKvEss">' + kvEss(stock) + '</div>' +
    '<div class="muted" id="sheetQuoteErr" style="margin-top:6px"></div>' +
    promoHtml +
    '<div id="sheetPlan"></div>' +
    '<div class="s-similar" id="detailSimilarCases"><div class="muted">相似日表现计算中…</div></div>' +
    '<div class="s-similar" id="boardPromoRef"></div>' +
    '<div class="s-actions"><button class="btn primary" id="sheetClose">关闭</button></div>';
  scrim.classList.add('show'); sheet.classList.add('show');
  loadSimilarCases(code); // 后台静默算,只渲染「后续表现」一行(见 loadSimilarCases 精简版)
  fetchHotConcepts(code).then((list) => { // 2026-09-15 概念命中(东财 CORS 开,失败静默)
    const box = $('#sheetConcepts');
    if (!box) return;
    box.hidden = !list.length;
    if (list.length) $('#sheetConceptTags').innerHTML = list.slice(0, 8).map((c) => '<span class="con-tag">' + esc(c.concept) + '</span>').join('');
  }).catch(() => {});
  // 2026-09-15 明日参考:同板位历史晋级率(本地可算,纯展示)——同步渲染无网络
  {
    const el2 = $('#boardPromoRef');
    const h = state.history || [];
    const ref = h.length >= 2 ? boardPromoRef(h, state.pools?.date) : {};
    const b = Math.max(1, Number(stock.boards) || 1);
    const cell = ref[b >= 4 ? '4+' : String(b)] || null;
    if (el2) {
      if (cell && cell.n >= 20) {
        const w = wilsonLower(cell.up, cell.n);
        el2.innerHTML = '<div class="sim-outcome"><span>明日参考 · 同板位晋级</span><b class="up-c">晋 ' + w + '%<small>(下界)</small></b><b>n=' + cell.n + '</b></div>';
        el2.title = '历史全部 ' + cell.n + ' 只 ' + (b >= 4 ? '4板及以上' : b + '板') + '的次日晋级率(Wilson 95% 下界) · 参考,非预测';
      } else if (cell) {
        el2.innerHTML = '<div class="muted">明日参考:样本积累中(n=' + cell.n + ',达 20 后显示)</div>';
      } else {
        el2.innerHTML = '<div class="muted">明日参考:需历史数据积累</div>';
      }
    }
  }
  // 2026-09-13 操作参考卡:先渲染(红档缺席),出场形态后台算完原地补——抽屉零等待弹出
  $('#sheetPlan').innerHTML = buildPlanHtml(stock);
  loadExitSignals(code, stock).then(() => { if (state.sheetCode === code) { const el = $('#sheetPlan'); if (el) el.innerHTML = buildPlanHtml(stock); } });
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
  // 2026-09-13 精简批:行情明细组已砍,报价回填只剩价格区(主力/超大单随明细组退出手机端)
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
// 2026-09-13 精简批:kvDet 已随「行情明细」折叠组砍(用户拍板)
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
// 2026-09-12 相似案例源统一批:60 根 K 线固定走腾讯源(与桌面兜底同源同参)——
// 东财 push2his 端点对部分宽带出口连接层掐断,桌面长期走腾讯兜底,两端各用各的源
// 会让相似日数字漂移;统一腾讯源后两端逐位一致。独立会话级缓存,不混入
// enrichPromo 的东财源 klineCacheByDate(避免同功能跨源数据混杂)。
const simBarsCache = new Map();

// 2026-09-13 操作参考卡(用户拍板):买点/回避/失效/仓位——纯拼装既有输出,零新阈值,判决冻结兼容。
// 卖出侧无持仓语义:「失效条件」两档——红档=出场引擎在真实K线上判出的当下已触发形态,
// 灰档=站岗条件(发生了就走)。卖出理由=买入逻辑失效(断板=晋级失效/爆量大阴=高位分歧/竞价不及预期=承接证伪)。
const planBarsCache = new Map();
function buildPlanHtml(stock) {
  const boards = Math.max(1, Number(stock.boards) || 1);
  const [lo, hi] = boards >= 3 ? assessmentRules.openBandBoard3Plus : assessmentRules.openBandBoard2;
  const rows = [];
  // 买点:竞价合格区间 + 信号触发条件(引擎原话)——跌停池股票不显示(引擎从未给跌停股
  // 买点,无差别套模板是误导;炸板股保留,弱转强次日模式成立)
  const inDownPool = (state.pools?.down || []).some((x) => x.code === stock.code);
  if (!inDownPool) {
    const triggers = (stock.signal?.triggers || []).slice(0, 2).join(' · ');
    rows.push(['buy', '买点', `竞价高开 ${lo}~${hi}%(${boards}板合格区间)` + (triggers ? ' · ' + esc(triggers) : '')]);
  }
  // 回避:硬否决清单(引擎原话,不新编)
  const avoids = (stock.promo?.hardFails || []).slice(0, 2);
  if (avoids.length) rows.push(['avoid', '回避', esc(avoids.join(' / '))]);
  // 失效-红档:出场形态引擎(Tencent 真实K线;exitSignalsOf 同步哨兵锁两端一致)
  const exits = stock.__exits || [];
  for (const x of exits) rows.push(['hit', '失效 ▲', esc(x.note)]);
  // 失效-灰档:站岗条件(按板位/模式给适用条款)
  const watch = [];
  if (boards >= 2) watch.push('断板当日走 · 盘中炸板不回封当日走');
  else watch.push('盘中炸板不回封当日走');
  const gapRow = (state.gap?.candidates || []).find((c) => c.code === stock.code);
  if (gapRow && gapRow.expectedMid != null) watch.push(`次日开盘不及 +${gapRow.expectedMid}%(预期中值)`);
  if (stock.buyType === '弱转强') watch.push('次日开盘 ≤0%(套利不成即走)');
  rows.push(['watch', '失效', esc(watch.join(' · '))]);
  // 仓位:市场级赢面档(养家表)
  const pa = state.positionAdvice;
  if (pa && pa.label && pa.label !== '--') rows.push(['pos', '仓位', esc(pa.label) + '(' + (pa.winrateSource === 'measured' ? '实测校准' : '情绪代理') + ')']);
  return '<div class="s-plan">' + rows.map(([cls, k, v]) =>
    '<div class="plan-row ' + cls + '"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>').join('') +
    '<div class="muted" style="margin-top:6px">体系规则拼装,非投资建议 · 判决前阈值冻结</div></div>';
}
async function loadExitSignals(code, stock) {
  // 出场形态判定:腾讯 60 根(复用相似案例通道),补 preClose 后喂 exitSignalsOf
  let bars = planBarsCache.get(code) || null;
  if (!bars || bars.length < 8) {
    try { bars = await fetchKlineTencent(code, 60); } catch (e) { bars = null; }
    if (bars && bars.length) {
      bars = bars.map((b, i) => ({ ...b, preClose: i > 0 ? bars[i - 1].close : null }));
      planBarsCache.set(code, bars);
    }
  }
  if (!bars || bars.length < 6) { stock.__exits = []; return; }
  stock.__exits = exitSignalsOf(bars, { boards: stock.boards != null ? Number(stock.boards) : undefined, mode: stock.buyType, openPct: state.auctionPctByCode[code] ?? null });
}

async function loadSimilarCases(code) {
  const el = $('#detailSimilarCases');
  if (!el) return;
  let bars = simBarsCache.get(code) || null;
  if (bars && bars.length < 86) bars = null; // 2026-09-13 检查批修:零重叠候选环需 >=86 根
  if (!bars) {
    try { bars = await fetchKlineTencent(code, 120); } catch (e) { bars = null; }
    // 2026-09-13 检查批修:盘中未收盘的当日半根 bar 丢弃(形态未定型,拿盘中价当收盘
    // 会让相似日数字盘中漂移);收盘定型(沪时 >=15:05)后保留。出场引擎红档口径相反
    // (判「正在爆量大阴」必须吃当日 bar),两者分开是对的
    const n = shanghaiNow();
    const mins = n.getHours() * 60 + n.getMinutes();
    if (bars && bars.length && bars[bars.length - 1].date === todayStr() && mins >= 9 * 60 && mins < 15 * 60 + 5) bars = bars.slice(0, -1);
    if (bars && bars.length) simBarsCache.set(code, bars);
  }
  if (!bars || bars.length < 86) { el.innerHTML = '<div class="muted">相似日表现：暂无足够历史日K</div>'; return; }
  const r = stockSimilarCases(bars, { window: 20, horizon: 5, limit: 3 });
  if (!r.available || !r.similar.length || !r.outcome || (r.outcome.up == null && r.outcome.flat == null && r.outcome.down == null)) { el.innerHTML = '<div class="muted">相似日表现：暂未匹配到可比形态</div>'; return; }
  // 2026-09-13 精简批(用户拍板):只留后续表现一行——三张形态卡+方法论长文砍,
  // 样本数进 title;涨/平/跌仍是按相似度加权的口径(stockSimilarCases 原样)
  const o = r.outcome;
  el.innerHTML = '<div class="sim-outcome"><span>历史相似日次日</span><b class="up-c">涨 ' + (o.up ?? '--') + '%</b><b>平 ' + (o.flat ?? '--') + '%</b><b class="down-c">跌 ' + (o.down ?? '--') + '%</b></div>';
  el.title = '近 ' + r.samples + ' 个最相似形态片段的次日表现(按相似度加权) · 六维:量能/缺口/均线乖离/5日收益/波动率/回踩首板';
}

// 申报量（股）人类可读：亿股/万股
// 竞价价格走势内联 SVG（零依赖 sparkline）：虚拟撮合价折线 + 昨收虚线基线
// 竞价区主体：minutes（核心票过程）或 item（全池快照行）二选一，至少给其一
// 本地可得（核心票过程 / 快照行）→ 渲染；否则 null（调用方走 adhoc 单票拉取）
// 2026-09-13 精简批:抽屉竞价渲染链(fmtShares~refreshAuctionDetail)已整删(用户拍板)——竞价数据层(采集/卡片行/八维竞价承接)不动
// 竞价采集落位后：若抽屉正开着该股且有本地数据，原地刷新竞价区（不覆盖 adhoc 进行中的加载态）

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
    if (!state.monitorPool) refreshMonitorPool(); // 2026-09-15 避雷批:首次池成功后拉一次(30 分钟 TTL 内不重拉;失败静默)
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
  return result;
} // 2026-09-13 精简批:refreshAuctionDetail 调用已随抽屉竞价区砍
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
      // 2026-09-13 精简批:抽屉已无折叠组(检查表常开/相似单行),promo 回填直接重渲染
      if (state.sheetCode && byCode[state.sheetCode]) openSheet(state.sheetCode);
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
    const d = String(p.date || '');
    banner.classList.remove('hide');
    banner.textContent = '休市中 · 显示 ' + d.slice(4, 6) + '-' + d.slice(6, 8) + ' 快照（数据定格）';
  } else if (!tradingNow()) {
    banner.classList.remove('hide');
    banner.textContent = '非交易时段 · 显示最近交易日快照';
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
  // C1 后台宽限:切后台不立即停——在 bgUntil 窗口内继续刷,让封板前预警后台也能命中并推 ntfy(人切走接电话/刷别的 App 仍能提醒)。
  // 窗口过后才停(省流量/电量)。纯后台(锁屏久置)到窗后即停,不受此宽限(锁屏准点见 plan C2,未做)。
  if (document.hidden && Date.now() >= state.bgUntil) return; // 窗口外的后台标签页不白耗流量/电量
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
    if (document.hidden) { state.bgUntil = Date.now() + 5 * 60_000; return; } // C1 切后台开 5 分钟宽限窗(见 refreshTick)
    state.bgUntil = 0; // 回前台即关窗,恢复正常前台节流
    if (!tradingNow()) return;
    maybeAuctionTick(); // 回前台落在竞价窗口内时立即补采集
    preSealScanAt = 0; preSealTick().catch(() => {}); // 回前台立即补一次封板前扫描(不等 15s 节拍)
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
  // 2026-10-07 卡片打开动画批:dtFold/zbFold 走 patchCardList(成员变化时已自带 .list-reveal 入场),
  // 这里不再对 .body 挂(否则两层叠加);structFold 走 setHTML 无列表入场,由这里给 .body 挂一次。
  ['#dtFold', '#zbFold'].forEach((sel) => $(sel).addEventListener('toggle', () => renderDowns()));
  const structFold = $('#structFold');
  if (structFold) structFold.addEventListener('toggle', () => { renderStructFold(); if (structFold.open) revealList(structFold.querySelector('.body') || structFold); });
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
  // C2 配置入口:长按左上「星脉」标题(独立于日期长按,设置页已砍不重建,用一次性 prompt 隐蔽入口)。
  // 输入以 ?probe 结尾 → 触发 C2 探测并存净地址;否则存净地址。探测结果 toast 慢速连播,无需记住后缀。
  const brandEl = document.querySelector('.topbar .brand');
  if (brandEl) {
    brandEl.addEventListener('pointerdown', () => {
      lpTimer = setTimeout(() => {
        lpTimer = null;
        getKV('pushNtfyUrl', '').then((cur) => {
          const v = prompt('推送地址 ntfy 主题\n(留空=关闭,形如 https://ntfy.sh/xxx;末尾加 ?probe 跑锁屏能力探测)', cur || '');
          if (v === null) return;
          const s = v.trim();
          const probe = /\?probe$/.test(s);
          setKV('pushNtfyUrl', probe ? s.replace(/\?probe$/, '') : s).then(() => { toast(s ? 'ntfy 推送已配置' : 'ntfy 推送已关闭'); if (s) setupPeriodicSync().catch(() => {}); });
          if (probe) runC2Probe();
        }).catch(() => {});
      }, 550);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => brandEl.addEventListener(ev, () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }));
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
    startPreSealMonitor(); // 封板前预警独立 15s 扫描(不依赖派生签名;刷新页面不再需要)
    maybeAuctionTick(); // 冷启动落在竞价窗口内时立即采集（不等首个 15s tick）
    setupPeriodicSync(); // C2:配了 ntfy 就注册 periodicSync 后台预警(锁屏准点;本机不支持则静默跳过)
    // 2026-10-12 减法:通知授权横条(setupNotifBanner)已整删——主推送走 ntfy(CORS 全开、锁屏送达率高),
    // 不依赖浏览器通知权限,SW 通知仅兜底,无需引导授权;用户反馈横条碍事。
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
