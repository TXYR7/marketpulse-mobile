// app.js — 编排层：数据加载、刷新循环、导航、共享渲染、详情抽屉、历史补录
import { fetchPools, fetchQuotes, fetchKlineLite, cachedKlineBars, storeKlineBars, hydrateKlineCache, exportKlineCache, todayStr, fmtTime, shanghaiNow, shanghaiOf, setEmaToken, shouldRefetchGap } from './data.js';
import {
  calculateBreakRate, calculatePromotionStats, buildThemeRanking, rankCoreLeaders, rankOpportunities,
  calculateEmotionState, yesterdayPremium, buildRiskRadar, buildMarketStructure, buildPlan, buyTypeOf,
  buildExpectationGap, buildSignal, applyGate, diffSignalSnapshot,
  assessPromotion, klineFeatures, cycleOf, winratePosition, contextNotes, stockSimilarCases
} from './analytics.js';
import { getWatch, putWatch, delWatch, clearWatch, getKV, setKV, getAllHistory, putHistory, pruneHistoryKeep } from './store.js';
import { renderOpportunity, renderLadder, renderStructure, esc, fmtMoney, pctClass, pctText, tierBadge, signalTag, setHTML, debounce, patchCardList, BD_LABELS } from './views.js';
import { renderMarket, renderTrades, renderReview, renderAI } from './views-extra.js';
import { APP_VERSION } from './version.js';

const state = {
  pools: null, quotes: {}, watch: [], view: 'intraday',
  ztSort: 'boards', ztFilter: 'all', ztFilterText: '',
  refreshMs: 15000, manualDate: '', timer: null,
  emotion: null, themes: [], leaders: [], opportunities: null, riskRadar: null, structure: null, plan: null, breakRate: null, phase: null,
  lastPayload: null, history: [], historyLoading: false, historyLoaded: false,
  trades: [], tradesLoaded: false, reviews: [], reviewsLoaded: false,
  allMarket: null, marketPage: 1, gap: null, prevPremium: null,
  fromSnapshot: false, lastGoodAt: 0, lastSuccessAt: 0, lastErrorAt: 0, quotesAt: 0,
  openPctByCode: {}, openPctDate: '', promoInFlight: false, positionAdvice: null, mentalNotes: [],
  lastSignalSnapshot: null, notifySignals: false, // D3:信号变化通知
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
  return pools.date + '|' + up.length + '|' + codes + '|' + hk + '|' + prem;
}
function computeDerived(pools) {
  // M4 结构签名记忆化：结构字段(boards/成员/日期/历史)日内稳定，派生结果恒定，跳过重算省 CPU（不碰实时价）
  // 返回布尔：true=完成（或早退但派生已有），false=签名相同早退——loadGap 溢价就绪后据此决定是否重渲染
  const sig = deriveSig(pools);
  if (sig === state.derivedSig && state.derived) { state.lastPayload = state.derived.lastPayload; return false; }
  const up = pools.up || [];
  const upCount = pools.upCount ?? up.length;
  const downCount = pools.downCount ?? (pools.down || []).length;
  const brokenCount = pools.brokenCount ?? (pools.broken || []).length;
  const maxBoard = up.reduce((m, x) => Math.max(m, x.boards || 1), 0);
  const multiBoardCount = up.filter((x) => (x.boards || 1) > 1).length;
  const breakRate = calculateBreakRate({ limitUpCount: upCount, brokenCount, available: true });
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
  up.forEach((s) => { const m = byCode[s.code]; if (m) Object.assign(s, { tier: m.tier, score: m.score, signal: m.signal, role: m.role, themeName: m.themeName, themeScore: m.themeScore, breakdown: m.breakdown }); });

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
      sources: { '东方财富行情': { ok: !pools.partial, missing: pools.partialMissing || [] } },
      latencyMs: null,
    },
  };
  state.derivedSig = sig;
  state.derived = { lastPayload: state.lastPayload };
  return true;
}

/* ---------------- 渲染：状态条 ---------------- */
function hhmm(ts) { const d = shanghaiOf(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function renderStatus() {
  const s = $('#statusStrip');
  if (!state.pools) { setHTML(s, '<div class="chip"><span>状态</span><strong>连接中</strong></div>'); return; }
  const p = state.pools;
  const maxBoard = p.up.reduce((m, x) => Math.max(m, x.boards || 1), 0);
  const em = state.emotion || {};
  // 数据新鲜度：正常显示更新时间；只有快照时标注「快照」；最近一次刷新失败且无更新则提示
  const failed = state.lastErrorAt > state.lastSuccessAt;
  const freshChip = failed
    ? '<div class="chip risk-high"><span>状态</span><strong>刷新失败</strong></div>'
    : (state.lastSuccessAt
      ? '<div class="chip sent"><span>更新</span><strong>' + hhmm(state.lastSuccessAt) + '</strong></div>'
      : (state.lastGoodAt ? '<div class="chip risk-mid"><span>快照</span><strong>' + hhmm(state.lastGoodAt) + '</strong></div>' : ''));
  const partialChip = p.partial && p.partialMissing && p.partialMissing.length
    ? '<div class="chip risk-mid"><span>缺源</span><strong>' + esc(p.partialMissing.join('/')) + '</strong></div>'
    : '';
  // 建议仓位档（养家赢面表，情绪指数作赢面代理）
  const pa = state.positionAdvice;
  const posChip = pa && pa.label !== '--'
    ? '<div class="chip ' + (pa.label === '观望' ? 'risk-mid' : 'sent') + '" title="' + esc((pa.cycle || '--') + '周期容错 ' + (pa.faultTolerance != null ? Math.round(pa.faultTolerance * 100) + '%' : '--') + ' · ' + pa.note) + '"><span>仓位</span><strong>' + esc(pa.label) + '</strong></div>'
    : '';
  const html = [
    chip('sent', '情绪', em.emotionIndex ?? '--'),
    chip('up', '涨停', p.upCount),
    chip('down', '跌停', p.downCount),
    chip('broken', '炸板', p.brokenCount),
    chip('', '最高板', maxBoard),
    chip('', '炸板率', (state.breakRate?.rate ?? '--') + '%'),
    chip(em.level === 'red' ? 'risk-high' : em.level === 'orange' ? 'risk-mid' : '', '风险', em.phase || '—'),
    posChip,
    freshChip,
    partialChip,
  ].join('');
  setHTML(s, html);
  $('#phaseBadge').textContent = em.phase || '连接中';
  $('#ladderHint').textContent = '最高 ' + maxBoard + ' 板';
}
function chip(cls, label, val) {
  return '<div class="chip ' + cls + '"><span>' + label + '</span><strong>' + val + '</strong></div>';
}

/* ---------------- 渲染：盘中涨停池 ---------------- */
function ztCard(x) {
  const starred = state.watch.some((w) => w.code === x.code);
  const bcls = x.boards >= 4 ? 'boards-tag hi' : x.boards === 1 ? 'boards-tag b1' : 'boards-tag';
  const pv = x.promo && x.promo.available !== false ? x.promo : null;
  const pvc = pv ? (pv.verdict === '可接力' ? 'pass' : pv.verdict === '观望' ? 'warn' : 'fail') : '';
  const pvTip = pv ? esc(pv.score + ' 分 · ' + ((pv.hardFails || []).length ? pv.hardFails.join('；') : '点开看八维检查表')) : '';
  return '<div class="card" data-code="' + x.code + '">' +
    '<div class="' + bcls + '">' + (x.boards || 1) + '板</div>' +
    '<div><div class="name">' + esc(x.name) + (starred ? ' <span class="star">★</span>' : '') + '</div>' +
    '<div class="code">' + x.code + ' · ' + esc(x.industry) + (x.role && x.role !== '后排' ? ' · ' + esc(x.role) : '') + '</div></div>' +
    '<div class="right">' +
    (pv ? '<span class="promo-badge ' + pvc + '" title="' + pvTip + '">' + esc(pv.verdict) + '</span> ' : '') +
    (x.tier ? tierBadge(x.tier) : '') + (x.signal ? '<div style="margin-top:4px">' + signalTag(x.signal.state) + '</div>' : '') +
    '<div class="price ' + pctClass(x.changePct) + '" style="margin-top:4px">' + (x.price ? x.price.toFixed(2) : '--') + '</div>' +
    '<div class="pct ' + pctClass(x.changePct) + '">' + pctText(x.changePct) + '</div>' +
    '<div class="meta">封 ' + fmtMoney(x.seal) + ' · 换 ' + (x.turnover != null ? x.turnover.toFixed(1) + '%' : '--') + '</div></div>' +
    '</div>';
}
function filterZt() {
  const p = state.pools;
  if (!p) return [];
  let rows = p.up.slice();
  const kw = state.ztFilterText.trim();
  if (kw) rows = rows.filter((x) => x.name.includes(kw) || x.code.includes(kw));
  if (state.ztFilter === 'playable') rows = rows.filter((x) => x.signal?.state === '可打');
  else if (['S', 'A', 'B'].includes(state.ztFilter)) rows = rows.filter((x) => x.tier === state.ztFilter);
  rows.sort((a, b) => {
    if (state.ztSort === 'seal') return (b.seal || 0) - (a.seal || 0);
    if (state.ztSort === 'pct') return (b.changePct || 0) - (a.changePct || 0);
    if (state.ztSort === 'tier') return (b.score || 0) - (a.score || 0);
    return (b.boards || 1) - (a.boards || 1) || (b.seal || 0) - (a.seal || 0);
  });
  return rows;
}
// 涨停池卡片签名：结构（连板数/评级/信号/角色/自选星/晋级结论）变了才整卡重建；数值（价/涨跌/封单/换手）变了只原地改字段
function ztStructSig(x) {
  const pv = x.promo && x.promo.available !== false ? x.promo.verdict : '';
  return [x.boards || 1, x.tier || '', x.signal ? x.signal.state : '', x.role || '', state.watch.some((w) => w.code === x.code) ? 1 : 0, pv].join('|');
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
  $('#ztHint').textContent = '共 ' + state.pools.upCount + ' 只';
  patchCardList(list, rows, ztCard, ztStructSig, pctFieldSig, patchZtCard);
}
function downCard(x) {
  return '<div class="card" data-code="' + x.code + '">' +
    '<div class="boards-tag b1">' + (x.boards || 1) + '板</div>' +
    '<div><div class="name">' + esc(x.name) + '</div><div class="code">' + x.code + ' · ' + esc(x.industry) + '</div></div>' +
    '<div class="right"><div class="price ' + pctClass(x.changePct) + '">' + (x.price ? x.price.toFixed(2) : '--') + '</div>' +
    '<div class="pct ' + pctClass(x.changePct) + '">' + pctText(x.changePct) + '</div>' +
    '<div class="meta">换 ' + (x.turnover != null ? x.turnover.toFixed(1) + '%' : '--') + '</div></div></div>';
}
function renderDowns() {
  const p = state.pools; if (!p) return;
  $('#dtCount').textContent = p.downCount;
  $('#zbCount').textContent = p.brokenCount;
  // 折叠时不构建内部 DOM（炸板池常 50~150 行），首次展开才渲染
  if ($('#dtFold').open) patchCardList($('#dtList'), p.down, downCard, (x) => (x.boards || 1), downFieldSig, patchDownCard, '<div class="empty">今日无跌停</div>');
  if ($('#zbFold').open) patchCardList($('#zbList'), p.broken, downCard, (x) => (x.boards || 1), downFieldSig, patchDownCard, '<div class="empty">今日无炸板</div>');
}

/* ---------------- 昨日涨停 · 今日开盘预期差 ---------------- */
function renderGap(gap) {
  const sum = $('#gapSummary');
  const c = gap.counts || { beat: 0, meet: 0, miss: 0 };
  sum.textContent = `超 ${c.beat} / 符 ${c.meet} / 不及 ${c.miss}`;
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
    const ctx = { ctxFor: (s) => { const ld = state.leaders.find((l) => l.code === s.code); return { buyType: buyTypeOf({ boards: s.boards, previousBoard: null }), phase: state.phase, role: ld?.role || '板块龙头', themeScore: ld?.themeScore ?? null }; } };
    const nextGap = buildExpectationGap(candidates, actualMap, ctx);
    if (mySeq !== gapSeq) return;
    state.gap = nextGap;
    state.gapDate = state.pools.date;
    // G9：同一份开盘报价顺手算昨日涨停溢价（首板/高位两组均值）→ 情绪驾驶舱两指标
    state.prevPremium = { ...yesterdayPremium(candidates, actualMap), date: state.pools.date };
    renderGap(state.gap);
    // 溢价就绪 → 重算派生并刷新（签名含溢价指纹，此前已算过的会触发本轮重算；无递归：loadGap 同日缓存早退）
    if (computeDerived(state.pools)) { renderStatus(); renderView(state.view); }
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
  setHTML(el, items + '<div style="margin-top:8px;font-size:13px">风险星级 <span class="stars">' + '★'.repeat(r.riskStars) + '☆'.repeat(5 - r.riskStars) + '</span></div>' +
    (cannot ? '<div class="cannot-do">禁止：' + cannot + '</div>' : ''));
}

function renderIntraday() {
  renderZt(); renderDowns(); renderRadar();
  $('#dateLabel').textContent = (state.manualDate || todayStr()).slice(0, 4) + '-' + (state.manualDate || todayStr()).slice(4, 6) + '-' + (state.manualDate || todayStr()).slice(6, 8);
  updateBanner();
  loadGap();
}

/* ---------------- 渲染：自选 ---------------- */
function recordFor(code) {
  if (state.pools) {
    const s = state.pools.up.find((x) => x.code === code) || state.pools.down.find((x) => x.code === code) || state.pools.broken.find((x) => x.code === code);
    if (s) return { name: s.name, price: s.price, changePct: s.changePct, main: null, super: null, tier: s.tier, signal: s.signal };
  }
  const d = state.quotes[code];
  if (d) {
    const pct = d.price != null && d.prevClose ? ((d.price - d.prevClose) / d.prevClose * 100) : null;
    return { name: d.name || code, price: d.price, changePct: pct, main: d.main, super: d.super };
  }
  return { name: code, price: null };
}
function renderWatch() {
  const list = $('#watchList');
  const empty = $('#watchEmpty');
  if (!state.watch.length) { setHTML(list, ''); empty.classList.remove('hide'); return; }
  empty.classList.add('hide');
  const html = state.watch.map((w) => {
    const r = recordFor(w.code);
    return '<div class="card" data-code="' + w.code + '">' +
      '<div><div class="name">' + esc(r.name) + (r.tier ? ' ' + tierBadge(r.tier) : '') + '</div>' +
      '<div class="code">' + w.code + (r.signal ? ' · ' + (r.signal.state) : '') + '</div></div>' +
      '<div class="right"><div class="price ' + pctClass(r.changePct) + '">' + (r.price != null ? r.price.toFixed(2) : '--') + '</div>' +
      '<div class="pct ' + pctClass(r.changePct) + '">' + pctText(r.changePct) + '</div>' +
      '<div class="meta">主 ' + (r.main != null ? fmtMoney(r.main) : '--') + '</div></div></div>';
  }).join('');
  setHTML(list, html);
}
async function loadWatch() {
  state.watch = await getWatch();
  const codes = state.watch.map((w) => w.code);
  const inPools = new Set();
  if (state.pools) [...state.pools.up, ...state.pools.down, ...state.pools.broken].forEach((x) => inPools.add(x.code));
  const needQuote = codes.filter((c) => !inPools.has(c));
  // 报价带 TTL：TTL 内切回自选不重复打接口；新报价合并进旧表而非整体替换
  const fresh = Date.now() - state.quotesAt < Math.min(state.refreshMs || 15000, 15000);
  if (needQuote.length && !fresh) {
    const q = await fetchQuotes(needQuote).catch(() => ({}));
    if (Object.keys(q).length) { state.quotes = Object.assign({}, state.quotes, q); state.quotesAt = Date.now(); }
  }
  renderWatch();
}

/* ---------------- 详情抽屉 ---------------- */
async function openSheet(code) {
  const scrim = $('#scrim'), sheet = $('#sheet');
  let stock = null;
  if (state.pools) stock = state.pools.up.find((x) => x.code === code) || state.pools.down.find((x) => x.code === code) || state.pools.broken.find((x) => x.code === code);
  if (!stock) { const w = state.watch.find((x) => x.code === code); if (w) stock = { code, name: w.name || code, boards: 1, industry: '—', changePct: null, price: null }; }
  if (!stock) return;
  // 已有新鲜报价直接用（点开/自选切换不再每次一个往返），过期才拉
  let d = (Date.now() - state.quotesAt < 10000 && state.quotes[code]) || null;
  if (!d) {
    const q = await fetchQuotes([code]).catch(() => ({}));
    d = q[code] || {};
    if (d.price != null) state.quotes[code] = d; // 缓存供下次秒开（不动 quotesAt，避免拉长全局 TTL）
  }
  const isWatch = state.watch.some((w) => w.code === code);
  const pct = d.price != null && d.prevClose ? ((d.price - d.prevClose) / d.prevClose * 100) : (stock.changePct != null ? stock.changePct : null);
  const body = $('#sheetBody');
  let head = '<div class="s-head"><div><div class="s-name">' + esc(stock.name || code) + '</div>' +
    '<div class="s-code">' + code + ' · ' + esc(stock.industry || '—') + (stock.boards ? ' · ' + stock.boards + '板' : '') + '</div></div>' +
    '<div class="s-price"><b class="' + pctClass(pct) + '">' + (d.price != null ? d.price.toFixed(2) : (stock.price ? stock.price.toFixed(2) : '--')) + '</b>' +
    '<small class="' + pctClass(pct) + '">' + pctText(pct) + '</small></div></div>';

  let tierHtml = '';
  if (stock.tier) {
    tierHtml = '<div class="s-tier">' + tierBadge(stock.tier) + ' <b>评分 ' + (stock.score ?? '--') + '</b></div>';
    const bd = stock.breakdown || {};
    const bars = Object.entries(bd).filter(([, v]) => v != null).map(([k, v]) => {
      const max = { height: 35, theme: 20, position: 15, coordination: 5, turnover: 8, seal: 10, firstSeal: 7, breaks: 5 }[k] || 10;
      const w = Math.min(100, Math.round(v / max * 100));
      return '<div class="bd-row"><span class="k">' + (BD_LABELS[k] || k) + '</span><div class="bd-bar"><i style="width:' + w + '%"></i></div><span>' + v + '</span></div>';
    }).join('');
    if (bars) tierHtml += '<div class="s-breakdown">' + bars + '</div>';
  }
  let signalHtml = '';
  if (stock.signal) {
    const sg = stock.signal;
    signalHtml = '<div class="s-signal"><div class="st">' + signalTag(sg.state) + '</div>' +
      (sg.triggers && sg.triggers.length ? '<div class="muted">触发条件：' + sg.triggers.join(' / ') + '</div>' : '') +
      (sg.risks && sg.risks.length ? '<div class="muted" style="color:var(--red)">风险：' + sg.risks.join(' / ') + '</div>' : '') + '</div>';
  }
  // 晋级评估八维检查表（交易体系规则引擎）
  let promoHtml = '';
  const promo = stock.promo;
  if (promo && promo.available !== false && Array.isArray(promo.checklist)) {
    const icons = { pass: '✓', warn: '!', fail: '✕', na: '–' };
    const vcls = promo.verdict === '可接力' ? 'pass' : promo.verdict === '观望' ? 'warn' : 'fail';
    promoHtml = '<div class="s-promo"><div class="sp-verdict verdict-' + vcls + '"><b>' + esc(promo.verdict) + '</b><span>评分 ' + promo.score +
      ' · 周期容错 ' + (promo.faultTolerance != null ? Math.round(promo.faultTolerance * 100) + '%' : '--') +
      ((promo.hardFails || []).length ? ' · 触发：' + esc(promo.hardFails.join('、')) : '') + '</span></div>' +
      promo.checklist.map((row) => '<div class="promo-row status-' + row.status + '"><i>' + (icons[row.status] || '·') + '</i><span class="k">' + esc(row.label) + '</span><em>' + esc(row.note) + '</em></div>').join('') +
      '<div class="muted" style="margin-top:6px">体系规则参考，非投资建议</div></div>';
  }
  body.innerHTML = head + tierHtml + signalHtml + promoHtml +
    kvGrid(stock, d) +
    '<div class="s-similar" id="detailSimilarCases"><div class="muted">相似案例加载中…</div></div>' +
    '<div class="s-actions"><button class="btn primary" id="sheetWatch">' + (isWatch ? '取消自选' : '★ 加自选') + '</button>' +
    '<button class="btn" id="sheetClose">关闭</button></div>';
  scrim.classList.add('show'); sheet.classList.add('show');
  loadSimilarCases(code);
  $('#sheetWatch').addEventListener('click', async () => {
    if (isWatch) { await delWatch(code); state.watch = state.watch.filter((w) => w.code !== code); }
    else { await putWatch({ code, name: stock.name || code, addedAt: Date.now() }); state.watch.push({ code, name: stock.name || code, addedAt: Date.now() }); }
    renderWatch(); renderZt();
    openSheet(code);
  });
  $('#sheetClose').addEventListener('click', closeSheet);
}
function kvGrid(s, d) {
  const rows = [
    ['封单资金', s.seal != null ? fmtMoney(s.seal) : '--'],
    ['成交额', s.amount != null ? fmtMoney(s.amount) : '--'],
    ['换手率', s.turnover != null ? s.turnover.toFixed(1) + '%' : '--'],
    ['流通市值', s.circ != null ? fmtMoney(s.circ) : '--'],
    ['首封', fmtTime(s.firstSeal)],
    ['末封', fmtTime(s.lastSeal)],
    ['炸板次数', s.breaks != null ? s.breaks : '--'],
    ['主力净流入', d.main != null ? fmtMoney(d.main) : '--'],
    ['超大单净流入', d.super != null ? fmtMoney(d.super) : '--'],
  ];
  return '<div class="kv-grid">' + rows.map((r) => '<div class="kv"><span>' + r[0] + '</span><strong>' + r[1] + '</strong></div>').join('') + '</div>';
}
function closeSheet() { $('#scrim').classList.remove('show'); $('#sheet').classList.remove('show'); }

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

/* ---------------- 导航 ---------------- */
function switchView(v) {
  state.view = v;
  $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
  $$('.bottomnav button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  $$('.menu-item').forEach((m) => m.classList.toggle('on', m.dataset.view === v));
  closeMenu();
  renderView(v);
}
function renderView(v) {
  const ctx = { state, toast, actions: { loadHistory } };
  if (v === 'intraday') renderIntraday();
  else if (v === 'opportunity') renderOpportunity(ctx);
  else if (v === 'ladder') renderLadder(ctx);
  else if (v === 'structure') renderStructure(ctx);
  else if (v === 'watch') loadWatch();
  else if (v === 'market') renderMarket(ctx);
  else if (v === 'trades') renderTrades(ctx);
  else if (v === 'review') renderReview(ctx);
  else if (v === 'ai') renderAI(ctx);
}
function renderCurrentView() { renderView(state.view); }

/* ---------------- 侧滑菜单 ---------------- */
function openMenu() { $('#menuScrim').classList.add('show'); $('#menuPanel').classList.add('show'); }
function closeMenu() { $('#menuScrim').classList.remove('show'); $('#menuPanel').classList.remove('show'); }

/* ---------------- 刷新 ---------------- */
let refreshing = false;
async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  // B1:手动刷新不再无条件作废预期差缓存(省 1-5 个报价请求)——09:30 后开盘价已定型
  if (force && shouldRefetchGap(shanghaiNow(), state.manualDate)) state.gapDate = null;
  $('#refreshBtn').classList.add('spin');
  try {
    const date = state.manualDate || todayStr();
    if (state.pools) renderCurrentView(); // SWR：先即时渲染上一份数据，后台拉取成功后再增量 patch，避免空白/loading 闪
    // 冷启动（无本地数据垫底）用 fail-fast 配置：挂起/离线时最坏 ~13s 落到离线态（此前 3×9s≈28s）；
    // 热刷新保持完整重试韧性（有 SWR 旧数据在屏，慢点无妨）
    const pools = await fetchPools(date, state.pools ? {} : { tries: 2, timeoutMs: 6000 });
    state.fromSnapshot = false;
    state.lastSuccessAt = Date.now();
    persistLastGood(pools); // 先落原始池（未挂派生字段，体积小），失败静默
    computeDerived(pools);
    state.pools = pools;
    renderStatus();
    renderView(state.view); // 只渲染活跃视图；其余视图数据已更新，切过去即最新
    // M2 竞价抓取与梯队晋级评估并发（K线尾巴与竞价抓取重叠，墙钟取 max 而非相加）；两者 settle 后把当日预热持久化到 IDB，SW 重载即命中免重抓
    const openPctP = fetchOpenPct(pools);
    openPctP.catch(() => {});
    Promise.allSettled([openPctP, enrichPromo(pools, openPctP)]).then(() => { persistWarmCache(); notifySignalChanges(); }).catch(() => {});
  } catch (e) {
    state.lastErrorAt = Date.now();
    renderStatus();
    if (!state.pools) showOfflineEmpty(e); // 无任何可用数据（含快照）：清骨架屏给显式离线态
    toast('刷新失败：' + e.message);
  }
  finally { $('#refreshBtn').classList.remove('spin'); refreshing = false; }
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

// D3:信号变化本地通知（前台运行时;零后端约束下 PeriodicSync/Web Push 均不可行,这是唯一务实方案）
function buildSignalSnapshot() {
  const byCode = {};
  for (const s of (state.pools?.up || [])) {
    if (!s.tier && !s.promo?.verdict) continue;
    byCode[s.code] = { tier: s.tier || null, verdict: s.promo?.verdict || null, name: s.name || s.code };
  }
  return { byCode };
}
async function notifySignalChanges() {
  try {
    const next = buildSignalSnapshot();
    const changes = diffSignalSnapshot(state.lastSignalSnapshot, next);
    state.lastSignalSnapshot = next; // 冷启动首刷 prev=null → changes 空，不打扰
    if (!changes.length) return;
    if (!state.notifySignals || !('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification('脉搏 · 信号变化', { body: changes.slice(0, 3).join('；') + (changes.length > 3 ? ` 等 ${changes.length} 项` : ''), tag: 'mp-signals' });
  } catch { /* 通知失败静默 */ }
}
// M1 预热持久化：把当日 K线 + 竞价缓存写入 IDB（防抖），SW 发版/重开 app 后首屏命中内存缓存，免去 ~29 请求完整预热
let warmPersistTimer = null;
function persistWarmCache() {
  clearTimeout(warmPersistTimer);
  warmPersistTimer = setTimeout(() => {
    setKV('warmCache', { kline: exportKlineCache(), openPct: state.openPctByCode, openPctDate: state.openPctDate }).catch(() => {});
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
  const map = {};
  for (const [code, q] of Object.entries(quotes)) {
    if (q && q.open != null && q.prevClose) map[code] = Number(((q.open - q.prevClose) / q.prevClose * 100).toFixed(2));
  }
  if (Object.keys(map).length) { state.openPctByCode = map; state.openPctDate = pools.date; }
}
// 组装评估 ctx：昨日同码（烂板/换手，历史记录含 breaks/turnoverRate 才有）
function promoContextOf(s, pools) {
  let prevDay = null;
  const hist = state.history || [];
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    if (String(hist[i].date) < String(pools.date)) { prevDay = (hist[i].stocks || []).find((x) => x.code === s.code) || null; break; }
  }
  return {
    phase: state.phase,
    themeSize: Number.isFinite(Number(s.themeSize)) ? Number(s.themeSize) : null,
    role: s.role,
    openPct: state.openPctByCode[s.code] ?? null,
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
    }
  } finally { state.promoInFlight = false; }
}
function updateBanner() {
  const p = state.pools;
  const banner = $('#intradayBanner');
  if (!p.upCount && !p.downCount) {
    banner.classList.remove('hide');
    banner.textContent = '未获取到行情数据（可能非交易时段，或该日期无数据）。可到「设置」手动输入交易日，或交易时段再试。';
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
  const d = shanghaiNow();
  if (d.getDay() === 0 || d.getDay() === 6) return false;
  const t = d.getHours() * 60 + d.getMinutes();
  return (t >= 555 && t <= 690) || (t >= 780 && t <= 900);
}
function applyRefreshTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  if (state.refreshMs > 0) state.timer = setInterval(refreshTick, state.refreshMs);
}
function refreshTick() {
  if (document.hidden) return; // 后台标签页不白耗流量/电量
  if (!tradingNow()) return;
  // 回看历史交易日：数据已是该日就不再重拉不变的历史，手动 ↻ 才强制
  if (state.manualDate && state.pools && String(state.pools.date) === String(state.manualDate)) return;
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
    const age = Date.now() - state.lastSuccessAt;
    if (!state.lastSuccessAt || age > (state.refreshMs || 15000)) refresh();
  });
  $$('.bottomnav button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $$('.menu-item').forEach((m) => m.addEventListener('click', () => switchView(m.dataset.view)));
  $('#menuBtn').addEventListener('click', openMenu);
  $('#menuScrim').addEventListener('click', closeMenu);
  $('#refreshBtn').addEventListener('click', () => refresh(true));
  // 涨停池搜索防抖（共享 views.js 的 debounce），避免逐键全列表重建
  $('#ztSearch').addEventListener('input', debounce((e) => { state.ztFilterText = e.target.value; renderZt(); }, 250));
  // 折叠池首次展开才渲染
  ['#dtFold', '#zbFold'].forEach((sel) => $(sel).addEventListener('toggle', () => renderDowns()));
  $$('#ztSort button').forEach((b) => b.addEventListener('click', () => {
    $$('#ztSort button').forEach((x) => x.classList.remove('on')); b.classList.add('on');
    state.ztSort = b.dataset.sort; renderZt();
  }));
  $$('#ztFilter button').forEach((b) => b.addEventListener('click', () => {
    $$('#ztFilter button').forEach((x) => x.classList.remove('on')); b.classList.add('on');
    state.ztFilter = b.dataset.f; renderZt();
  }));
  $('#watchInput').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const code = e.target.value.trim().replace(/\D/g, '');
    if (code.length < 4) { toast('请输入有效的股票代码'); return; }
    if (state.watch.some((w) => w.code === code)) { toast('已在自选'); return; }
    let name = code;
    if (state.pools) { const s = [...state.pools.up, ...state.pools.down, ...state.pools.broken].find((x) => x.code === code); if (s) name = s.name; }
    await putWatch({ code, name, addedAt: Date.now() });
    state.watch.push({ code, name, addedAt: Date.now() });
    e.target.value = ''; toast('已加入自选'); loadWatch();
  });
  $('#setRefresh').addEventListener('change', (e) => { state.refreshMs = Number(e.target.value); setKV('refreshMs', state.refreshMs); applyRefreshTimer(); });
  $('#setDate').addEventListener('change', (e) => { state.manualDate = e.target.value.trim(); refresh(); });
  // B6:接口 token 设置——手机 PWA 无控制台，这是 token 失效时的救命通道（改后即时生效，免重启）
  const tokenInput = $('#setToken');
  if (tokenInput) {
    tokenInput.value = (typeof localStorage !== 'undefined' && localStorage.getItem('mp_ema_token')) || '';
    tokenInput.addEventListener('change', (e) => {
      const v = e.target.value.trim();
      if (v) localStorage.setItem('mp_ema_token', v); else localStorage.removeItem('mp_ema_token');
      setEmaToken(v);
      toast(v ? 'Token 已保存并即时生效' : '已恢复默认 Token');
    });
  }
  // D3:信号变化通知开关（前台本地通知；权限请求绑在打开开关的手势上——浏览器策略要求用户手势）
  const notifyToggle = $('#setNotify');
  if (notifyToggle) {
    notifyToggle.checked = Boolean(state.notifySignals);
    notifyToggle.addEventListener('change', async (e) => {
      state.notifySignals = e.target.checked;
      setKV('notifySignals', e.target.checked);
      if (e.target.checked && 'Notification' in window && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch { /* 拒绝则静默不通知 */ }
      }
      toast(e.target.checked ? '信号通知已开启' : '信号通知已关闭');
    });
  }
  $('#clearBtn').addEventListener('click', async () => {
    await clearWatch(); // 单事务清空
    state.watch = []; renderWatch(); toast('已清空自选');
  });
  $('#scrim').addEventListener('click', closeSheet);
  setupPTR();
}

function setupPTR() {
  const main = document.querySelector('main');
  let startY = null;
  main.addEventListener('touchstart', (e) => { if (main.scrollTop <= 0) startY = e.touches[0].clientY; }, { passive: true });
  main.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    if (e.touches[0].clientY - startY > 60) $('#ptr').classList.add('show');
  }, { passive: true });
  main.addEventListener('touchend', () => {
    if ($('#ptr').classList.contains('show')) refresh(true);
    $('#ptr').classList.remove('show'); startY = null;
  });
}

/* ---------------- 启动 ---------------- */
async function init() {
  // SW 注册放最前：弱网首访不至于等几十秒的网络超时后才装上
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('unhandledrejection', (e) => { console.warn('[mp] 未处理的 Promise 拒绝：', e.reason); });
  const verEl = $('#aboutVersion');
  if (verEl) verEl.textContent = APP_VERSION; // 设置页展示当前版本（与 SW CACHE 同源，发布自动递增）
  try {
    // 设置/快照/历史/预热缓存并行读，首个网络请求不必排队等 IDB 串行往返
    const [refreshMs, snap, hist, warm, notifySignals] = await Promise.all([
      getKV('refreshMs', 15000),
      getKV('lastGood', null).catch(() => null),
      getAllHistory().catch(() => []),
      getKV('warmCache', null).catch(() => null),
      getKV('notifySignals', false).catch(() => false),
    ]);
    if (warm && warm.kline) hydrateKlineCache(warm.kline); // 当日 K线命中 → enrichPromo 免重抓
    if (warm && warm.openPct) { state.openPctByCode = warm.openPct; state.openPctDate = warm.openPctDate || ''; }
    state.refreshMs = Number(refreshMs) > 0 ? Number(refreshMs) : 15000;
    state.notifySignals = Boolean(notifySignals); // D3:信号变化通知开关（默认关）
    $('#setRefresh').value = String(state.refreshMs);
    bind();
    state.history = hist.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    state.historyLoaded = hist.length > 0;
    // 快照水合：离线/弱网冷启动先显示上次成功数据（状态条标「快照」），新数据到达后替换
    if (snap && snap.pools && Array.isArray(snap.pools.up)) {
      state.pools = snap.pools;
      state.fromSnapshot = true;
      state.lastGoodAt = snap.savedAt || 0;
      computeDerived(snap.pools);
      renderStatus();
      renderView(state.view);
    }
    await refresh();
    applyRefreshTimer();
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
