import { shanghaiNow } from './data.js';
import { esc, pctText, pctClass, fmtMoney, setHTML } from './views.js';
import { filterHeatStocks, filterSectorRows, filterHotRank, hotRankTier, snapshotMetaText, heatConceptsOf, marketNumber as num } from './explorer-core.js';
import { loadIndices, loadIndexCloses, loadMarketPage, loadSectors, loadSectorMembers, loadHotRank, lookupMobileStocks, loadChartBars } from './mobile-data.js';
import { analyze } from './advisor-core.js';
import { limitThresholdOf, COPILOT_QUESTIONS, buildCopilotAnswer, routeCopilotQuery, buildModeMonitor } from './analytics.js';
import { getKV, setKV, getTrades, getReviews, putReview } from './store.js';
import { APP_VERSION } from './version.js';

const empty = text => '<div class="mobile-empty">' + esc(text) + '</div>';
const money = value => value == null ? '—' : fmtMoney(value);
const price = value => num(value) > 0 ? Number(value).toFixed(2) : '—';
const choice = (value, label) => '<option value="' + value + '">' + label + '</option>';
const search = (id, text) => '<label class="mobile-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input id="' + id + '" type="search" autocomplete="off" placeholder="' + text + '" aria-label="' + text + '"></label>';
function stockRow(stock, prefix = '', meta = '') {
  return '<article class="mobile-stock-row"><span class="stock-prefix">' + prefix + '</span><div class="mobile-stock-name"><strong>' + esc(stock.name || stock.code) + '</strong><small>' + esc(stock.code) + (meta ? ' · ' + esc(meta) : '') + '</small></div><div class="mobile-stock-price"><b>' + price(stock.price) + '</b><small class="' + pctClass(stock.changePct ?? stock.gainPct ?? stock.changePercent) + '">' + pctText(stock.changePct ?? stock.gainPct ?? stock.changePercent) + '</small></div><button class="stock-detail" type="button" data-code="' + esc(stock.code) + '" aria-label="查看' + esc(stock.name || stock.code) + '详情和K线">详情<span>K线</span></button></article>';
}
export function quickRows(stocks, { scope = 'all', query = '' } = {}) {
  return stocks.filter(s => {
    const verdict = s.promo?.verdict;
    const category = ['可接力', '优先确认'].includes(verdict) ? 'priority' : ['回避', '不可接力', '规避'].includes(verdict) || s.promo?.hardFails?.length ? 'avoid' : 'wait';
    return (scope === 'all' || scope === category) && (!query.trim() || [s.name, s.code, s.industry].join(' ').includes(query.trim()));
  }).sort((a, b) => (num(b.promo?.score) ?? -1) - (num(a.promo?.score) ?? -1) || (b.boards || 1) - (a.boards || 1));
}
function decisionCard(s) {
  const p = s.promo || {}, plan = p.actionPlan || {}, avoid = !!p.hardFails?.length;
  const reason = p.hardFails?.[0] || p.downgrades?.[0] || p.checklist?.find(r => r.status !== 'pass')?.note || p.checklist?.[0]?.note || '判断数据待补齐';
  return '<article class="decision-card"><div class="decision-heading"><div><strong>' + esc(s.name) + '</strong><small>' + esc(s.code) + ' · ' + (s.boards || 1) + '板 · ' + esc(s.industry || '未分类') + '</small></div><span class="decision-verdict ' + (avoid ? 'avoid' : '') + '">' + esc(p.verdict || '待确认') + '</span></div><p class="decision-reason">' + esc(reason) + '</p><div class="decision-next"><span>下一步</span><p>' + esc(plan.entry || s.signal?.next || '等待市场、价格与承接证据') + '</p></div><div class="decision-footer"><span>失效参考 <b>' + price(Number(/价格失效参考 ([\d.]+)/.exec((plan.invalidation || []).join(' '))?.[1]) || null) + '</b></span><span>现价 <b class="' + pctClass(s.changePct) + '">' + price(s.price) + '</b></span><button type="button" class="stock-detail" data-code="' + s.code + '">详情 / K线</button></div></article>';
}
export function createMobileWorkspace({ state, onStock, onRefresh, onTheme, onNotify, onDate, onToken, onRefreshInterval, doc = document }) {
  const $ = id => doc.getElementById(id);
  const cache = new Map(), pending = new Map();
  let page = 'market', rank = 'heat', scope = 'priority', searchSeq = 0, searchTimer = null, composing = false;
  let marketQuery = '', marketPage = 1, marketMarket = '', marketSort = 'gain';
  let sectorType = 'concept', sectorSort = 'gain', sectorQuery = '', hotSort = 'rank', hotScope = 'all', hotQuery = '', hotLayout = 'list';
  let heat = { query: '', level: 'all', market: 'all', sort: 'seal', concept: '', time: null }, heatBoard = null;
  let memberSequence = 0, currentSector = null, memberData = null, advisorStock = null, advisorSeq = 0;
  const scroll = new Map();
  state.workspaceStocks = new Map();
  const register = rows => { for (const s of rows || []) state.workspaceStocks.set(s.code, s); };
  async function load(key, fetcher, force = false, paint = () => {}) {
    if (pending.has(key)) return pending.get(key);
    let old = cache.get(key);
    if (!force && old && Date.now() - old.loadedAt < 60000) { paint(old); return old; }
    const value = { ...old, loading: true, error: '' }; cache.set(key, value); paint(value);
    const task = (async () => {
      const persist = key === 'indices' || key === 'hot' || key.startsWith('sectors:');
      if(!old && persist){old=await getKV('mobileSnapshot:'+key,null).catch(()=>null);if(old?.rows){cache.set(key,{...old,loading:true});paint({...old,loading:true});}}
      try { const result = await fetcher(); const next = { ...result, loadedAt: Date.now(), loading: false, error: '' }; cache.set(key, next); if(persist)void setKV('mobileSnapshot:'+key,next).catch(()=>{}); paint(next); return next; }
      catch (error) { const next = { ...old, error: error.message || '更新失败', loading: false }; cache.set(key, next); paint(next); return next; }
      finally { pending.delete(key); }
    })(); pending.set(key, task); return task;
  }
  function meta(el, data) { if (!el) return; el.textContent = data?.loading ? '正在更新…' : data?.error ? '更新失败' + (data.rows ? '，保留上次快照' : '') + ' · 点击重试' : snapshotMetaText(data); }
  function navigate(next, { history = true } = {}) {
    if (!['market', 'intraday', 'rank', 'tools'].includes(next)) next = 'market';
    const main = doc.querySelector('main'); scroll.set(page, main.scrollTop); page = next; state.view = next;
    doc.querySelectorAll('.view').forEach(el => { const active = el.id === 'view-' + next; el.hidden = !active; el.classList.toggle('active', active); });
    doc.querySelectorAll('[data-mobile-nav]').forEach(button => { const active = button.dataset.mobileNav === next; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); });
    main.scrollTop = scroll.get(next) || 0;
    doc.title = ({ market: '全市场', intraday: '打板', rank: '排行', tools: '工具' })[next] + ' · 星脉';
    if (history) window.history.pushState({ mobilePage: next }, '', '#' + next);
    if (next === 'market') { renderMarket(); void load('indices', loadIndices, false, paintIndices); }
    if (next === 'intraday') renderBoard();
    if (next === 'rank') renderRank();
    if (next === 'tools') renderTools();
    const view = $('view-' + next); if (!matchMedia('(prefers-reduced-motion: reduce)').matches) view.animate?.([{ opacity: .4, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  function renderMarket() {
    const p = state.pools, e = state.emotion || {}, themes = state.themes || [], leaders = state.leaders || [];
    setHTML($('marketHero'), '<div class="market-phase"><span>市场情绪</span><span class="mobile-tag">' + esc(state.fromSnapshot ? '缓存快照' : state.marketClosed || state.manualDate || shanghaiNow().getHours() >= 15 ? '收盘快照' : '盘面观察') + '</span></div><div class="market-hero-value"><strong>' + esc(e.phase || '等待行情') + '</strong><div><b>' + (e.emotionIndex ?? '—') + '</b><small>情绪指数</small></div></div><p>' + esc(e.advice || state.plan?.summary || '先看情绪、主线与核心，再看个股确认') + '</p><div class="market-kpis">' + [['涨停', p?.upCount], ['跌停', p?.downCount], ['最高板', p?.sources?.up ? Math.max(0, ...(p.up || []).map(s => s.boards || 1)) : null], ['炸板率', state.breakRate?.rate != null ? state.breakRate.rate.toFixed(1) + '%' : null]].map(([label, v]) => '<div><b>' + (v ?? '—') + '</b><span>' + label + '</span></div>').join('') + '</div>');
    const max = Math.max(1, ...themes.slice(0, 6).map(t => t.limitUpCount || t.count || t.stocks?.length || 0));
    setHTML($('marketThemes'), themes.length ? themes.slice(0, 6).map((t, i) => '<button class="theme-rank-row" type="button" data-theme-choice="' + esc(t.name || t.industry) + '"><span class="theme-rank-num">' + String(i + 1).padStart(2, '0') + '</span><div><strong>' + esc(t.name || t.industry) + '</strong><small>涨停 ' + (t.limitUpCount ?? t.count ?? t.stocks?.length ?? '—') + '只 · 连板 ' + (t.multiBoardCount ?? '—') + '只</small><i class="theme-track"><i style="width:' + Math.max(3, (t.limitUpCount || t.count || t.stocks?.length || 0) / max * 100) + '%"></i></i></div><b>' + (num(t.score) != null ? Number(t.score).toFixed(0) : '—') + '<small>强度</small></b></button>').join('') : empty('等待主线数据'));
    register(leaders);
    setHTML($('marketLeaders'), leaders.length ? leaders.slice(0, 6).map(s => stockRow(s, '<b>' + (s.boards || 1) + '</b><small>板</small>', s.role || s.industry)).join('') : empty('等待核心数据'));
    const metrics = e.indicators || {};
    const metricsRows = Array.isArray(metrics) ? metrics.map(m => [m.label || m.name || m.key, m.raw ?? m.value]) : Object.entries(metrics).map(([k, v]) => [v?.label || k, v?.raw ?? v?.value ?? v]);
    setHTML($('marketFactors'), metricsRows.length ? '<div class="factor-grid">' + metricsRows.map(([k, v]) => '<div><span>' + esc(k) + '</span><b>' + esc(typeof v === 'object' ? v?.value ?? '—' : v ?? '—') + '</b></div>').join('') + '</div>' : '<div class="factor-grid">' + [['连板晋级率', e.promotionRate], ['市场断板率', e.marketBreakRate], ['昨首板溢价', state.prevPremium?.firstBoardPremium], ['昨高位溢价', state.prevPremium?.highBoardPremium]].map(([k, v]) => '<div><span>' + k + '</span><b>' + (num(v) == null ? '—' : Number(v).toFixed(1) + '%') + '</b></div>').join('') + '</div>');
    paintIndices(cache.get('indices'));
    if ($('marketListFold').open) void loadMarket();
  }
  function paintIndices(data) { if (!data?.rows) { setHTML($('marketIndices'), '<span class="mobile-meta">' + esc(data?.error || '指数加载中…') + '</span>'); return; } setHTML($('marketIndices'), data.rows.map(r => '<div><span>' + esc(r.name) + '</span><b>' + price(r.price) + '</b><small class="' + pctClass(r.changePct) + '">' + pctText(r.changePct) + '</small></div>').join('')); }
  function marketKey() { return ['market', marketPage, marketMarket, marketSort, marketQuery].join(':'); }
  function loadMarket(force = false) {
    const key = marketKey(), args = { page: marketPage, market: marketMarket, sort: marketSort, query: marketQuery };
    return load(key, () => loadMarketPage(args), force, data => { if (key !== marketKey()) return; register(data.rows); setHTML($('marketRows'), data.rows?.length ? data.rows.map(s => stockRow(s, '', s.industry || money(s.amount))).join('') : empty(data.loading ? '加载中…' : data.error || '没有匹配的股票')); meta($('marketListMeta'), data); $('marketPrev').disabled = marketPage <= 1 || data.loading; $('marketNext').disabled = !!marketQuery || data.loading || !data.rows?.length || marketPage * 30 >= data.total; $('marketPageLabel').textContent = '第' + marketPage + '页' + (data.total != null ? ' · 共' + data.total + '只' : ''); });
  }
  function renderBoard() {
    if (!state.pools) { setHTML($('mobileCandidates'), empty('等待行情，成功后显示候选判断')); return; }
    const stocks = state.pools.up || [], rows = quickRows(stocks, { scope, query: $('candidateSearch').value });
    setHTML($('mobileCandidates'), rows.length ? rows.map(decisionCard).join('') : empty('当前范围没有候选'));
    $('candidateCount').textContent = rows.length + ' / ' + stocks.length + '只';
    const p = state.opportunities; $('mobileGate').hidden = !p?.noTrade?.triggered; $('mobileGate').textContent = p?.noTrade?.reason || '';
    $('decisionModel').textContent = (state.unifiedDecision?.modelVersion || 'unified-2.0.0') + ' · 待前瞻验证 · 分数代表一致度';
    doc.querySelectorAll('[data-candidate-scope]').forEach(b => { b.classList.toggle('active', b.dataset.candidateScope === scope); b.setAttribute('aria-pressed', String(b.dataset.candidateScope === scope)); });
  }
  function renderRank() {
    doc.querySelectorAll('[data-rank-tab]').forEach(b => { b.classList.toggle('active', b.dataset.rankTab === rank); b.setAttribute('aria-selected', String(b.dataset.rankTab === rank)); });
    for (const name of ['heat', 'sectors', 'hot']) $('rank-' + name).hidden = name !== rank;
    if (rank === 'heat') paintHeat();
    if (rank === 'sectors') void load('sectors:' + sectorType, () => loadSectors(sectorType), false, paintSectors);
    if (rank === 'hot') void load('hot', loadHotRank, false, paintHot);
  }
  function paintHeat() {
    const stocks = (state.pools?.up || []).map(s => ({ ...s, ztFirstTime: s.firstSealTime, reason: s.industry }));
    let rows = filterHeatStocks(stocks, { ...heat, board: heatBoard });
    const groups = [...new Set(rows.map(s => s.boards || 1))].sort((a, b) => b - a);
    const originalGroups = [...new Set(stocks.map(s => s.boards || 1))].sort((a, b) => b - a);
    setHTML($('heatLevels'), '<button type="button" data-heat-board="" class="' + (heatBoard == null ? 'active' : '') + '">全部</button>' + originalGroups.map(n => '<button type="button" data-heat-board="' + n + '" class="' + (heatBoard === n ? 'active' : '') + '"><b>' + n + '</b>板 <small>' + stocks.filter(s => s.boards === n).length + '</small></button>').join(''));
    const concepts = [...new Set(stocks.flatMap(heatConceptsOf))].sort(); const sel = $('heatConcept');
    if (sel.dataset.items !== concepts.join('|')) { sel.innerHTML = choice('', '全部题材') + concepts.map(c => '<option>' + esc(c) + '</option>').join(''); sel.dataset.items = concepts.join('|'); sel.value = heat.concept; }
    setHTML($('heatRows'), rows.length ? groups.map(n => '<section class="heat-group"><div class="heat-group-head"><strong><b>' + n + '</b>板</strong><span>' + rows.filter(s => s.boards === n).length + '只</span></div>' + rows.filter(s => s.boards === n).map(s => stockRow(s, '', (s.firstSealTime || '首封未知') + ' · 封单 ' + money(s.sealAmount))).join('') + '</section>').join('') : empty(state.pools ? '没有匹配的涨停股' : '等待涨停池'));
    $('heatSummary').textContent = rows.length + '只 · ' + groups.length + '个梯队';
    $('heatMeta').textContent = state.pools ? '东方财富涨停池 · ' + state.pools.date + (state.fromSnapshot ? ' · 缓存快照' : ' · ' + new Date(state.lastSuccessAt || Date.now()).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })) + (state.pools.sources?.up === false ? ' · 涨停池缺失' : '') : '等待行情';
  }
  function paintSectors(data = cache.get('sectors:' + sectorType)) {
    if (rank !== 'sectors') return;
    if (data?.type && data.type !== sectorType) return;
    meta($('sectorMeta'), data); $('membersToHeat').disabled = !memberData?.complete; $('membersToHeat').disabled = !memberData?.complete;
    const rows = filterSectorRows(data?.rows || [], { query: sectorQuery, sort: sectorSort });
    setHTML($('sectorRows'), rows.length ? rows.map((s, i) => '<button class="sector-row" type="button" data-sector="' + s.code + '"><span class="sector-rank">' + (i + 1) + '</span><div><strong>' + esc(s.name) + '</strong><small>领涨 ' + esc(s.leaderName) + '</small><span class="sector-breadth">上涨 ' + (s.upCount ?? '—') + ' / 下跌 ' + (s.downCount ?? '—') + (s.limitUpCount != null ? ' · 涨停 ' + s.limitUpCount : '') + '</span></div><b class="' + pctClass(s.changePercent) + '">' + pctText(s.changePercent) + '<small>查看成员 ›</small></b></button>').join('') : empty(data?.loading ? '正在加载板块…' : data?.error || '没有匹配板块'));
  }
  function paintHot(data = cache.get('hot')) {
    if (rank !== 'hot') return; register(data?.rows); meta($('hotMeta'), data);
    const up = new Set((state.pools?.up || []).map(s => s.code));
    const rows = filterHotRank((data?.rows || []).map(s => ({ ...s, isLimitUp: state.pools?.sources?.up ? up.has(s.code) : null })), { query: hotQuery, sort: hotSort, scope: hotScope });
    const list = rows.map(s => stockRow(s, '<b class="hot-rank-number">' + s.rank + '</b>', (s.rankChange != null ? '名次' + (s.rankChange > 0 ? '升' : '降') + Math.abs(s.rankChange) + ' · ' : '') + (s.heat != null ? '热度 ' + money(s.heat) : '人气名次')));
    setHTML($('hotRows'), rows.length ? hotLayout === 'list' ? list.join('') : [0, 1, 2, 3, 4].map(t => { const group = rows.filter(s => hotRankTier(s.rank) === t); return group.length ? '<section class="hot-tier"><div class="mobile-section-head"><h3>' + ['榜首', '第2—5名', '第6—15名', '第16—35名', '第36—100名'][t] + '</h3><span>' + group.length + '只</span></div>' + group.map(s => stockRow(s, '<b class="hot-rank-number">' + s.rank + '</b>', s.heat == null ? '人气名次' : '热度 ' + money(s.heat))).join('') + '</section>' : ''; }).join('') : empty(data?.loading ? '正在加载热榜…' : data?.error || '没有匹配股票'));
  }
  async function openMembers(code) {
    const sequence = ++memberSequence;
    const s = cache.get('sectors:' + sectorType)?.rows?.find(s => s.code === code); if (!s) return;
    currentSector = s; memberData = null; $('membersTitle').textContent = s.name; $('membersMeta').textContent = '正在加载完整成员…'; $('membersRows').innerHTML = empty('正在加载…'); $('membersSearch').value = ''; $('membersToHeat').disabled = true; $('membersDialog').showModal();
    const data = await load('members:' + code, () => loadSectorMembers(code));
    if (sequence !== memberSequence || !$('membersDialog').open) return;
    memberData = data; register(data.rows);
    if (data.complete && state.pools?.sources?.up) { const up = new Set(state.pools.up.map(s => s.code)); s.limitUpCount = data.rows.filter(r => up.has(r.code)).length; }
    $('membersMeta').textContent = data.error ? data.error : data.complete ? '完整成员 ' + data.rows.length + '只' + (s.limitUpCount != null ? ' · 涨停 ' + s.limitUpCount + '只' : '') : '部分成员 ' + (data.rows?.length || 0) + '只，涨停数暂不计算';
    $('membersToHeat').disabled = !data.complete; $('membersToHeat').disabled = !data.complete; paintMembers(); paintSectors();
  }
  function paintMembers() { const q = $('membersSearch').value.trim(); const rows = (memberData?.rows || []).filter(s => !q || [s.name, s.code].join(' ').includes(q)).sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity)); setHTML($('membersRows'), rows.length ? rows.map(s => stockRow(s, '', s.industry)).join('') : empty(memberData?.error || '没有匹配成员')); }
  function renderTools() {
    $('toolVersion').textContent = APP_VERSION;
    $('toolModel').textContent = state.unifiedDecision?.modelVersion || 'unified-2.0.0';
    $('toolHealth').textContent = !state.pools ? '等待行情' : state.fromSnapshot ? '正在使用本地快照' : state.pools.partial ? '缺失来源：' + state.pools.partialMissing.join('、') : '行情来源正常';
    $('toolHistoryCount').textContent = (state.history?.length || 0) + '个交易日';
    try { $('toolToken').value = localStorage.getItem('mp_ema_token') || ''; } catch {}
    $('toolRefresh').value = String(state.refreshMs || 8000);
    const prev = state.history?.find(h => String(h.date) === state.previousTradingDate);
    const current = new Set((state.pools?.up || []).map(s => s.code));
    const stats = prev ? [1, 2, 3, 4].map(n => { const rows = prev.stocks.filter(s => n === 4 ? s.boards >= 4 : s.boards === n), promoted = rows.filter(s => current.has(s.code)).length; return '<div><span>' + (n === 4 ? '4板以上' : n + '板') + '</span><b>' + (rows.length && state.pools?.sources?.up ? (promoted / rows.length * 100).toFixed(1) + '%' : '—') + '</b><small>' + promoted + ' / ' + rows.length + '晋级</small></div>'; }).join('') : '';
    setHTML($('reviewPromotion'), stats ? '<div class="factor-grid">' + stats + '</div>' : empty('需要连续两个交易日的历史记录'));
    const snapshots=Object.fromEntries((state.history||[]).filter(h=>String(h.date)<=String(state.pools?.date||'')).map(h=>[h.date,h]));
    const monitor=buildModeMonitor(snapshots);
    setHTML($('reviewModes'), monitor.available ? monitor.modes.map(m=>'<div class="mode-stat"><strong>'+esc(m.mode)+'</strong><span>近20 '+(m.rateFull??'—')+'% / 近5 '+(m.rateRecent??'—')+'%</span><small>'+esc(m.message||'晋级样本 '+m.samplesRecent)+' · 近期'+m.samplesRecent+'只</small></div>').join('') : empty('模式统计等待历史积累'));
    if(!$('reviewDate').value){const date=String(state.pools?.date||'');if(date)$('reviewDate').value=date.replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');}
    if(!$('copilotQuestion').options.length)$('copilotQuestion').innerHTML=COPILOT_QUESTIONS.map(q=>'<option value="'+q.key+'">'+esc(q.label)+'</option>').join('');
    void getReviews().then(rows=>setHTML($('reviewEntries'),rows.slice(0,20).map(r=>'<article class="journal-entry"><strong>'+esc(r.date)+'</strong><p>'+esc(r.note||r.summary||r.content||'')+'</p></article>').join('')||empty('暂无复盘记录'))).catch(()=>{});
    void getTrades().then(rows=>setHTML($('toolTrades'),rows.length?rows.map(r=>'<article class="journal-entry"><strong>'+esc(r.name||r.code)+' · '+esc(r.date||'')+'</strong><p>'+esc(r.buyReason||r.reason||'')+(r.sellReason?' / '+esc(r.sellReason):'')+'</p><span>盈亏 '+pctText(r.pnlPct??r.profitPct)+'</span></article>').join(''):empty('暂无交易记录'))).catch(()=>{});
  }
  async function runAdvisor() {
    if (!advisorStock) { $('advisorResult').innerHTML = empty('请先搜索并选择股票'); return; }
    const seq = ++advisorSeq, stock = advisorStock, btn = $('advisorRun'); btn.disabled = true; $('advisorResult').innerHTML = empty('正在读取历史日K并计算…');
    try {
      const [data, quotes, indexCloses] = await Promise.all([loadChartBars(stock.code, { limit: 320 }), import('./data.js').then(m => m.fetchQuotes([stock.code], { tries: 1, timeoutMs: 4000 })).catch(() => ({})), loadIndexCloses().catch(()=>null)]);
      if (seq !== advisorSeq) return;
      const mode = $('advisorMode').value, inputs = {};
      for (const key of ['capital', 'riskPct', 'amount', 'cost', 'shares']) { const value = $('advisor-' + key).value; if(value.trim()){ const n=Number(value);if(!Number.isFinite(n)||n<=0)throw new Error('资金、成本、股数与风险预算需大于0');inputs[key]=n;} }
      if(inputs.riskPct>100)throw new Error('单笔风险预算不能超过100%');
      if (mode === 'hold' && (!(inputs.cost > 0) || !(inputs.shares > 0))) throw new Error('已持有模式需要有效成本和股数');
      const quote = quotes[stock.code] || {}, result = analyze({ bars: data.bars, price: quote.price || stock.price, quote: { preClose: quote.prevClose }, indexCloses, code: stock.code, name: stock.name, limitPct: limitThresholdOf(stock.code, stock.name), mode, inputs });
      if (!result.available) throw new Error(result.reason);
      const p = result.plan, levels = [ ...(p.entries || []), ...(p.targets || []).map(t => ({ ...t, label: t.label || '目标' })), ...(p.stop ? [{ ...p.stop, label: '止损参考' }] : []) ];
      $('advisorResult').innerHTML = '<div class="advisor-summary"><span>' + esc(result.name) + ' · ' + result.code + '</span><strong>' + esc(p.stance || p.action || result.scoreLabel) + '</strong><p>' + esc(p.summary || p.action || '') + '</p></div><div class="factor-grid">' + levels.map(l => '<div><span>' + esc(l.label) + '</span><b>' + price(l.price) + '</b></div>').join('') + '</div>' + (p.mode === 'buy' && p.sizing?.shares != null ? '<p class="mobile-note">按预算 ' + (p.sizing.shares ?? '—') + '股 · 金额 ' + money(p.sizing.amountUsed) + ' · 止损估算 ' + money(p.sizing.maxLoss) + '</p>' : '') + '<div class="advisor-factors">' + result.factors.map(f => '<div><strong>' + esc(f.label) + '</strong><span>' + esc(f.display) + '</span><b>' + (f.percentile ?? '—') + '</b></div>').join('') + '</div><p class="mobile-note">状态分 ' + result.score + ' · 历史数据截至' + result.asOfBar + ' · 分数不是胜率；同档历史样本不足时保留待确认。</p><button class="mobile-action" type="button" data-code="' + stock.code + '">查看日K与股票详情</button>';
      const position=p.position;
      if(position)$('advisorResult').insertAdjacentHTML('beforeend','<div class="factor-grid">'+[['浮动盈亏',money(position.pnl)],['盈亏比例',pctText(position.pnlPct)],[position.totalLossFromCost < 0 ? '止损时仍盈利' : '止损时总亏损',money(Math.abs(position.totalLossFromCost))],['当前持仓市值',money(position.value)]].map(([label,v])=>'<div><span>'+label+'</span><b>'+v+'</b></div>').join('')+'</div>'+(p.reduce?'<p class="mobile-note">减仓参考 '+price(p.reduce.price)+' · '+esc(p.reduce.note)+'</p>':''));
      $('advisorResult').insertAdjacentHTML('beforeend','<div class="mobile-section-head"><h3>同档历史表现</h3><span>'+(result.history.insufficient?'样本不足':'历史样本')+'</span></div><div class="advisor-factors">'+result.history.horizons.map(h=>'<div><strong>'+h.days+'日后</strong><span>胜率 '+(h.winRate??'—')+'% · 均值 '+pctText(h.mean)+'</span><b>n='+h.n+'</b></div>').join('')+'</div>');
    } catch (e) { if (seq === advisorSeq) $('advisorResult').innerHTML = empty(e.message); }
    finally { if (seq === advisorSeq) btn.disabled = false; }
  }
  async function exportData() {
    const [trades, reviews, watch, settings] = await Promise.all([getTrades(), getReviews(), import('./store.js').then(m => m.getWatch()), getKV('boardAlertsSettings', null)]);
    const blob = new Blob([JSON.stringify({ version: APP_VERSION, exportedAt: new Date().toISOString(), history: state.history, trades, reviews, watch, settings }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = doc.createElement('a'); a.href = url; a.download = 'marketpulse-mobile-' + new Date().toISOString().slice(0, 10) + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function clearResults() { searchSeq++; clearTimeout(searchTimer); $('mobileSearchResults').replaceChildren(); delete $('mobileSearchResults').__last; $('mobileSearchResults').hidden = true; $('globalStockSearch').setAttribute('aria-expanded', 'false'); }
  async function searchStocks(query) {
    const seq = ++searchSeq, q = query.trim(); if (!q) { clearResults(); return; }
    $('mobileSearchResults').hidden = false; setHTML($('mobileSearchResults'), empty('正在查询…')); $('globalStockSearch').setAttribute('aria-expanded', 'true');
    try {
      const local = [...(state.pools?.up || []), ...(state.pools?.down || []), ...(state.pools?.broken || [])].filter(s => [s.name, s.code].join(' ').includes(q));
      const remote = await lookupMobileStocks(q).catch(error => { if (!local.length) throw error; return []; }); if (seq !== searchSeq) return;
      const rows = [...new Map([...local, ...remote].map(s => [s.code, s])).values()].slice(0, 8); register(rows);
      setHTML($('mobileSearchResults'), rows.length ? rows.map(s => '<button type="button" class="mobile-search-result" data-search-code="' + s.code + '"><strong>' + esc(s.name) + '</strong><span>' + s.code + '</span></button>').join('') : empty('没有匹配的股票'));
    } catch (e) { if (seq === searchSeq) $('mobileSearchResults').innerHTML = empty('查询失败，请重试'); }
  }
  function bind() {
    doc.addEventListener('click', e => {
      const nav = e.target.closest('[data-mobile-nav]'); if (nav) { clearResults(); navigate(nav.dataset.mobileNav); }
      const tab = e.target.closest('[data-rank-tab]'); if (tab) { rank = tab.dataset.rankTab; renderRank(); }
      const candidate = e.target.closest('[data-candidate-scope]'); if (candidate) { scope = candidate.dataset.candidateScope; renderBoard(); }
      const level = e.target.closest('[data-heat-board]'); if (level) { heatBoard = level.dataset.heatBoard ? Number(level.dataset.heatBoard) : null; paintHeat(); }
      const theme = e.target.closest('[data-theme-choice]'); if (theme) { heat.codes=null; heat.concept = theme.dataset.themeChoice; rank = 'heat'; navigate('rank'); $('heatConcept').value = heat.concept; }
      const sector = e.target.closest('[data-sector]'); if (sector) void openMembers(sector.dataset.sector);
      const result = e.target.closest('[data-search-code]'); if (result && !composing) { const code = result.dataset.searchCode; if ($('searchPurpose').value === 'advisor') { advisorStock = state.workspaceStocks.get(code); advisorSeq++; $('advisorSelected').textContent = advisorStock.name + ' · ' + code; $('advisorResult').innerHTML = ''; $('searchDialog').close(); navigate('tools'); $('advisorFold').open = true; } else { $('searchDialog').close(); onStock(code); } clearResults(); }
    });
    $('openStockSearch').addEventListener('click', () => openSearch('stock'));
    $('searchClose').addEventListener('click', () => $('searchDialog').close()); $('searchDialog').addEventListener('close', clearResults);
    $('globalStockSearch').addEventListener('compositionstart', () => { composing = true; clearResults(); });
    $('globalStockSearch').addEventListener('compositionend', () => { composing = false; void searchStocks($('globalStockSearch').value); });
    $('globalStockSearch').addEventListener('input', () => { if (composing) return; searchSeq++; clearTimeout(searchTimer); $('mobileSearchResults').replaceChildren(); delete $('mobileSearchResults').__last; searchTimer = setTimeout(() => searchStocks($('globalStockSearch').value), 220); });
    $('globalStockSearch').addEventListener('keydown', e => { if (e.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') $('mobileSearchResults').querySelector('button')?.click(); if (e.key === 'ArrowDown') { e.preventDefault(); $('mobileSearchResults').querySelector('button')?.focus(); } });
    $('candidateSearch').addEventListener('input', renderBoard);
    $('marketListFold').addEventListener('toggle', () => { if ($('marketListFold').open) void loadMarket(); });
    $('marketSearch').addEventListener('change', () => { marketQuery = $('marketSearch').value; marketPage = 1; void loadMarket(); });
    $('marketMarket').addEventListener('change', () => { marketMarket = $('marketMarket').value; marketPage = 1; void loadMarket(); });
    $('marketSort').addEventListener('change', () => { marketSort = $('marketSort').value; marketPage = 1; void loadMarket(); });
    $('marketPrev').addEventListener('click', () => { marketPage--; void loadMarket(); }); $('marketNext').addEventListener('click', () => { marketPage++; void loadMarket(); });
    $('marketListRefresh').addEventListener('click', () => void loadMarket(true));
    $('heatSearch').addEventListener('input', () => { heat.query = $('heatSearch').value; paintHeat(); });
    for (const [id, key] of [['heatLevel', 'level'], ['heatMarket', 'market'], ['heatSort', 'sort'], ['heatConcept', 'concept']]) $(id).addEventListener('change', () => { heat[key] = $(id).value; heatBoard = null; paintHeat(); });
    $('heatTime').addEventListener('change', () => { heat.time = { early: [925, 1000], morning: [1000, 1131], afternoon: [1300, 1501] }[$('heatTime').value] || null; paintHeat(); });
    $('heatReset').addEventListener('click', () => { heat = { query: '', level: 'all', market: 'all', sort: 'seal', concept: '', time: null }; heatBoard = null; for (const [id, value] of [['heatSearch', ''], ['heatLevel', 'all'], ['heatMarket', 'all'], ['heatSort', 'seal'], ['heatConcept', ''], ['heatTime', '']]) $(id).value = value; paintHeat(); });
    $('sectorType').addEventListener('change', () => { sectorType = $('sectorType').value; renderRank(); }); $('sectorSort').addEventListener('change', () => { sectorSort = $('sectorSort').value; paintSectors(); }); $('sectorSearch').addEventListener('input', () => { sectorQuery = $('sectorSearch').value; paintSectors(); });
    $('sectorRefresh').addEventListener('click', () => void load('sectors:' + sectorType, () => loadSectors(sectorType), true, paintSectors));
    $('hotSearch').addEventListener('input', () => { hotQuery = $('hotSearch').value; paintHot(); });
    for (const [id, fn] of [['hotSort', () => { hotSort = $('hotSort').value; }], ['hotScope', () => { hotScope = $('hotScope').value; }], ['hotLayout', () => { hotLayout = $('hotLayout').value; }]]) $(id).addEventListener('change', () => { fn(); paintHot(); });
    $('hotRefresh').addEventListener('click', () => void load('hot', loadHotRank, true, paintHot));
    $('membersClose').addEventListener('click', () => $('membersDialog').close()); $('membersDialog').addEventListener('close', () => memberSequence++); $('membersSearch').addEventListener('input', paintMembers);
    $('membersToHeat').addEventListener('click', () => { if (!memberData?.complete) return; heat.codes = memberData.rows.map(s => s.code); heat.concept = ''; heatBoard = null; $('membersDialog').close(); rank = 'heat'; navigate('rank'); });
    $('advisorChoose').addEventListener('click', () => openSearch('advisor')); $('advisorRun').addEventListener('click', () => void runAdvisor()); $('advisorMode').addEventListener('change', () => { advisorSeq++; $('advisorResult').innerHTML = ''; $('advisorHoldInputs').hidden = $('advisorMode').value !== 'hold'; $('advisorRun').disabled = false; });
    $('toolTheme').addEventListener('click', onTheme); $('toolNotify').addEventListener('click', onNotify); $('toolDate').addEventListener('click', onDate); $('toolExport').addEventListener('click', () => exportData().catch(e => { $('toolExportStatus').textContent = e.message; }));
    $('toolSave').addEventListener('click', async () => { try { await onToken($('toolToken').value); await onRefreshInterval(Number($('toolRefresh').value)); $('toolSaveStatus').textContent = '已保存到当前设备'; } catch (e) { $('toolSaveStatus').textContent = '保存失败：' + e.message; } });
    $('reviewSave').addEventListener('click',async()=>{const date=$('reviewDate').value,note=$('reviewNote').value.trim();if(!date||!note){$('reviewStatus').textContent='请填写日期与复盘内容';return;}try{await putReview({date,note,phase:state.phase,updatedAt:new Date().toISOString()});$('reviewStatus').textContent='复盘已保存到当前设备';renderTools();}catch(e){$('reviewStatus').textContent='保存失败：'+e.message;}});
    $('copilotAsk').addEventListener('click',()=>{const text=$('copilotInput').value.trim(),key=text?routeCopilotQuery(text):$('copilotQuestion').value;if(!key){$('copilotAnswer').textContent='当前离线助手没有匹配到这个问题，请选择上方盘面问题。';return;}try{const html=buildCopilotAnswer(key,{...state.lastPayload,positionAdvice:state.positionAdvice,mentalNotes:state.mentalNotes});const template=doc.createElement('template');template.innerHTML=html.replace(/<\/(?:div|p|li|h[1-6])>/g,'\n');$('copilotAnswer').textContent=template.content.textContent;}catch{$('copilotAnswer').textContent='需要有效盘面数据，请稍后再试';}});
    window.addEventListener('popstate', () => navigate(location.hash.slice(1), { history: false }));
    navigate(location.hash.slice(1) || 'market', { history: false });
  }
  function openSearch(purpose) { clearResults(); $('searchPurpose').value = purpose; $('globalStockSearch').value = ''; $('searchDialog').showModal(); $('globalStockSearch').focus(); }
  function refresh() { register(state.pools?.up); if (page === 'market') renderMarket(); if (page === 'intraday') renderBoard(); if (page === 'rank') { if (rank === 'heat') paintHeat(); if (rank === 'hot') paintHot(); } if (page === 'tools') renderTools(); }
  return { bind, refresh, navigate, openSearch, stock: code => state.workspaceStocks.get(code), refreshActive: () => { if (page === 'rank' && rank === 'sectors') return load('sectors:' + sectorType, () => loadSectors(sectorType), true, paintSectors); if (page === 'rank' && rank === 'hot') return load('hot', loadHotRank, true, paintHot); if (page === 'market') void load('indices', loadIndices, true, paintIndices); return onRefresh(true); } };
}
