// app.js — 编排层：数据加载、刷新循环、导航、共享渲染、详情抽屉、历史补录
import { fetchPools, fetchQuotes, todayStr, fmtTime } from './data.js';
import {
  calculateBreakRate, calculatePromotionStats, buildThemeRanking, rankCoreLeaders, rankOpportunities,
  calculateEmotionState, buildRiskRadar, buildMarketStructure, buildPlan, buyTypeOf,
  buildExpectationGap, buildSignal, applyGate
} from './analytics.js';
import { getWatch, putWatch, delWatch, getKV, setKV, getAllHistory, putHistory } from './store.js';
import { renderOpportunity, renderLadder, renderStructure, esc, fmtMoney, pctClass, pctText, tierBadge, signalTag, setHTML } from './views.js';
import { renderMarket, renderTrades, renderReview, renderAI } from './views-extra.js';

const state = {
  pools: null, quotes: {}, watch: [], view: 'intraday',
  ztSort: 'boards', ztFilter: 'all', ztFilterText: '',
  theme: 'dark', refreshMs: 15000, manualDate: '', timer: null,
  emotion: null, themes: [], leaders: [], opportunities: null, riskRadar: null, structure: null, plan: null, breakRate: null, phase: null,
  lastPayload: null, history: [], historyLoading: false, historyLoaded: false,
  trades: [], tradesLoaded: false, reviews: [], reviewsLoaded: false,
  allMarket: null, marketPage: 1, gap: null,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 派生计算 ---------------- */
function computePromotionFromHistory(hist) {
  const arr = [...hist].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (arr.length < 2) return { available: false, firstBoardRate: null, multiBoardRate: null, prevMaxBoard: null, prevMultiBoardCount: null };
  const today = state.pools?.date;
  const prev = arr.filter((h) => today && String(h.date) < String(today)).pop() || arr[arr.length - 2];
  const prevStocks = prev.stocks || [];
  const prevMaxBoard = prevStocks.reduce((m, x) => Math.max(m, x.boards || 1), 0);
  const prevMulti = prevStocks.filter((x) => (x.boards || 1) > 1).length;
  const byBoard = new Map();
  for (let i = 1; i < arr.length; i += 1) {
    const r = calculatePromotionStats(arr[i - 1].stocks, arr[i].stocks);
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

function prevDayBoards(hist) {
  const arr = [...hist].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const today = state.pools?.date;
  const prev = arr.filter((h) => today && String(h.date) < String(today)).pop() || arr[arr.length - 1];
  const map = {};
  (prev?.stocks || []).forEach((s) => { map[s.code] = s.boards; });
  return map;
}

function computeDerived(pools) {
  const up = pools.up || [];
  const upCount = pools.upCount ?? up.length;
  const downCount = pools.downCount ?? (pools.down || []).length;
  const brokenCount = pools.brokenCount ?? (pools.broken || []).length;
  const maxBoard = up.reduce((m, x) => Math.max(m, x.boards || 1), 0);
  const multiBoardCount = up.filter((x) => (x.boards || 1) > 1).length;
  const breakRate = calculateBreakRate({ limitUpCount: upCount, brokenCount, available: true });
  const promo = computePromotionFromHistory(state.history || []);
  const emotion = calculateEmotionState({
    limitUpCount: upCount, limitDownCount: downCount, multiBoardCount, maxBoard, breakRate,
    firstBoardPromotionRate: promo.firstBoardRate, multiBoardPromotionRate: promo.multiBoardRate,
    previousMaxBoard: promo.prevMaxBoard, previousMultiBoardCount: promo.prevMultiBoardCount,
  });
  const phase = emotion.phase;
  const themes = buildThemeRanking(up);
  const leaders = rankCoreLeaders(up, themes);
  const prevBoards = prevDayBoards(state.history || []);
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
  up.forEach((s) => { const m = byCode[s.code]; if (m) Object.assign(s, { tier: m.tier, score: m.score, signal: m.signal, role: m.role, themeName: m.themeName, themeScore: m.themeScore }); });

  const structure = buildMarketStructure({ stocks: up, themes, leaders });
  const plan = buildPlan({ phase, riskRadar, emotion, opportunities });

  Object.assign(state, { themes, leaders, opportunities, emotion, riskRadar, structure, plan, breakRate, phase });
  state.lastPayload = {
    tradeDate: pools.date, limitUpCount: upCount, limitDownCount: downCount,
    status: { phase: emotion.phase, level: emotion.level, emotionIndex: emotion.emotionIndex, maxBoard },
    stats: { breakRate }, themes, leaders, riskRadar, opportunities,
    health: { ok: true, sources: { '东方财富行情': { ok: true } }, latencyMs: null },
  };
}

/* ---------------- 渲染：状态条 ---------------- */
function renderStatus() {
  const s = $('#statusStrip');
  if (!state.pools) { setHTML(s, '<div class="chip"><span>状态</span><strong>连接中</strong></div>'); return; }
  const p = state.pools;
  const maxBoard = p.up.reduce((m, x) => Math.max(m, x.boards || 1), 0);
  const em = state.emotion || {};
  const html = [
    chip('sent', '情绪', em.emotionIndex ?? '--'),
    chip('up', '涨停', p.upCount),
    chip('down', '跌停', p.downCount),
    chip('broken', '炸板', p.brokenCount),
    chip('', '最高板', maxBoard),
    chip('', '炸板率', (state.breakRate?.rate ?? '--') + '%'),
    chip(em.level === 'red' ? 'risk-high' : em.level === 'orange' ? 'risk-mid' : '', '风险', em.phase || '—'),
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
  return '<div class="card" data-code="' + x.code + '">' +
    '<div class="' + bcls + '">' + (x.boards || 1) + '板</div>' +
    '<div><div class="name">' + esc(x.name) + (starred ? ' <span class="star">★</span>' : '') + '</div>' +
    '<div class="code">' + x.code + ' · ' + esc(x.industry) + (x.role && x.role !== '后排' ? ' · ' + esc(x.role) : '') + '</div></div>' +
    '<div class="right">' +
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
function renderZt() {
  const list = $('#ztList');
  if (!state.pools) return; // 首屏骨架由 index.html 提供，数据到达前不覆盖
  const rows = filterZt();
  $('#ztHint').textContent = '共 ' + state.pools.upCount + ' 只';
  setHTML(list, rows.length ? rows.map(ztCard).join('') : '<div class="empty">没有匹配的股票</div>');
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
  setHTML($('#dtList'), p.down.length ? p.down.map(downCard).join('') : '<div class="empty">今日无跌停</div>');
  setHTML($('#zbList'), p.broken.length ? p.broken.map(downCard).join('') : '<div class="empty">今日无炸板</div>');
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
async function loadGap(force = false) {
  const gapEl = $('#gapRows');
  const sum = $('#gapSummary');
  const hist = state.history || [];
  const yest = [...hist].sort((a, b) => String(a.date).localeCompare(String(b.date))).filter((h) => state.pools && String(h.date) < String(state.pools.date)).pop();
  if (!yest) { sum.textContent = '需历史'; setHTML(gapEl, '<div class="muted">需先「补录历史」或次日数据后才能计算昨日涨停今日开盘预期差。</div>'); return; }
  const candidates = (yest.stocks || []).map((c) => ({ code: c.code, name: c.name, boards: c.boards, industry: c.industry }));
  if (!candidates.length) { sum.textContent = '--'; setHTML(gapEl, '<div class="muted">昨日无涨停缓存</div>'); return; }
  // 同一交易日且已有结果：直接用缓存，不重复打行情接口
  if (!force && state.gapDate === state.pools.date && state.gap) { renderGap(state.gap); return; }
  try {
    let quotes = {};
    try { quotes = await fetchQuotes(candidates.map((c) => c.code)); } catch (e) { quotes = {}; }
    const actualMap = {};
    candidates.forEach((c) => { const q = quotes[c.code]; if (q && q.open != null && q.prevClose) actualMap[c.code] = (q.open - q.prevClose) / q.prevClose * 100; });
    const ctx = { ctxFor: (s) => ({ buyType: buyTypeOf({ boards: s.boards, previousBoard: null }), phase: state.phase, role: '板块龙头' }) };
    state.gap = buildExpectationGap(candidates, actualMap, ctx);
    state.gapDate = state.pools.date;
    renderGap(state.gap);
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
  state.quotes = needQuote.length ? await fetchQuotes(needQuote).catch(() => ({})) : {};
  renderWatch();
}

/* ---------------- 详情抽屉 ---------------- */
async function openSheet(code) {
  const scrim = $('#scrim'), sheet = $('#sheet');
  let stock = null;
  if (state.pools) stock = state.pools.up.find((x) => x.code === code) || state.pools.down.find((x) => x.code === code) || state.pools.broken.find((x) => x.code === code);
  if (!stock) { const w = state.watch.find((x) => x.code === code); if (w) stock = { code, name: w.name || code, boards: 1, industry: '—', changePct: null, price: null }; }
  if (!stock) return;
  const q = await fetchQuotes([code]).catch(() => ({}));
  const d = q[code] || {};
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
      return '<div class="bd-row"><span class="k">' + k + '</span><div class="bd-bar"><i style="width:' + w + '%"></i></div><span>' + v + '</span></div>';
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
  body.innerHTML = head + tierHtml + signalHtml +
    kvGrid(stock, d) +
    '<div class="s-actions"><button class="btn primary" id="sheetWatch">' + (isWatch ? '取消自选' : '★ 加自选') + '</button>' +
    '<button class="btn" id="sheetClose">关闭</button></div>';
  scrim.classList.add('show'); sheet.classList.add('show');
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
  if (force) state.gapDate = null; // 手动刷新才重新拉预期差
  $('#refreshBtn').classList.add('spin');
  try {
    const date = state.manualDate || todayStr();
    const pools = await fetchPools(date);
    state.pools = pools;
    computeDerived(pools);
    renderStatus(); renderIntraday();
  } catch (e) { toast('刷新失败：' + e.message); }
  finally { $('#refreshBtn').classList.remove('spin'); refreshing = false; }
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
  } else banner.classList.add('hide');
}
function tradingNow() {
  const d = new Date();
  if (d.getDay() === 0 || d.getDay() === 6) return false;
  const t = d.getHours() * 60 + d.getMinutes();
  return (t >= 555 && t <= 690) || (t >= 780 && t <= 900);
}
function applyRefreshTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  if (state.refreshMs > 0) state.timer = setInterval(() => { if (tradingNow()) refresh(); }, state.refreshMs);
}

/* ---------------- 历史补录 ---------------- */
function tradingDatesBack(n) {
  const out = [];
  const d = new Date();
  for (let i = 1; i <= n && out.length < 40; i += 1) {
    const dt = new Date(d); dt.setDate(d.getDate() - i);
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
  const existing = await getAllHistory();
  const map = new Map(existing.map((h) => [h.date, h]));
  const dates = tradingDatesBack(45);
  let count = map.size;
  for (const dt of dates) {
    if (map.has(dt)) continue;
    try {
      const p = await fetchPools(dt);
      if (p.upCount > 0) {
        const rec = { date: dt, stocks: p.up.map((s) => ({ code: s.code, boards: s.boards, industry: s.industry, name: s.name })) };
        await putHistory(rec); map.set(dt, rec); count += 1;
      }
    } catch (e) { /* 跳过无数据日 */ }
    if (count >= 30) break;
    await sleep(150);
  }
  state.history = [...map.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  state.historyLoaded = true;
  state.historyLoading = false;
  if (state.pools) computeDerived(state.pools);
  renderCurrentView();
  toast('历史补录完成：' + state.history.length + ' 个交易日');
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
    const t = e.target.closest('[data-code]');
    if (t) openSheet(t.dataset.code);
  });
  $$('.bottomnav button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $$('.menu-item').forEach((m) => m.addEventListener('click', () => switchView(m.dataset.view)));
  $('#menuBtn').addEventListener('click', openMenu);
  $('#menuScrim').addEventListener('click', closeMenu);
  $('#refreshBtn').addEventListener('click', () => refresh(true));
  $('#ztSearch').addEventListener('input', (e) => { state.ztFilterText = e.target.value; renderZt(); });
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
  $('#setTheme').addEventListener('change', (e) => { state.theme = e.target.value; document.documentElement.setAttribute('data-theme', state.theme); setKV('theme', state.theme); });
  $('#setRefresh').addEventListener('change', (e) => { state.refreshMs = Number(e.target.value); setKV('refreshMs', state.refreshMs); applyRefreshTimer(); });
  $('#setDate').addEventListener('change', (e) => { state.manualDate = e.target.value.trim(); refresh(); });
  $('#clearBtn').addEventListener('click', async () => {
    for (const w of state.watch) await delWatch(w.code);
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
  state.theme = await getKV('theme', 'dark');
  state.refreshMs = await getKV('refreshMs', 15000);
  document.documentElement.setAttribute('data-theme', state.theme);
  $('#setTheme').value = state.theme;
  $('#setRefresh').value = String(state.refreshMs);
  bind();
  const hist = await getAllHistory();
  state.history = hist.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  state.historyLoaded = hist.length > 0;
  await refresh();
  applyRefreshTimer();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
