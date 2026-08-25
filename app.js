import { fetchPools, fetchQuotes, computeSentiment, todayStr, fmtTime } from './data.js';
import { getWatch, putWatch, delWatch, getKV, setKV } from './store.js';

const state = {
  pools: null,
  quotes: {},
  watch: [],
  view: 'intraday',
  ztSort: 'boards',
  ztFilter: '',
  theme: 'dark',
  refreshMs: 15000,
  manualDate: '',
  timer: null,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function fmtMoney(v) {
  if (v == null || isNaN(v)) return '--';
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(Math.round(v));
}
function pctClass(p) { return p > 0 ? 'up-c' : p < 0 ? 'down-c' : 'flat-c'; }
function pctText(p) { if (p == null) return '--'; return (p > 0 ? '+' : '') + Number(p).toFixed(2) + '%'; }
function tradingNow() {
  const d = new Date();
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const t = d.getHours() * 60 + d.getMinutes();
  return (t >= 555 && t <= 690) || (t >= 780 && t <= 900);
}

/* ---------- 渲染：状态条 ---------- */
function renderStatus() {
  const s = $('#statusStrip');
  if (!state.pools) { s.innerHTML = '<div class="chip"><span>状态</span><strong>连接中</strong></div>'; return; }
  const p = state.pools;
  const maxBoard = p.up.reduce((m, x) => Math.max(m, x.boards), 0);
  const sent = computeSentiment({ upCount: p.upCount, downCount: p.downCount, brokenCount: p.brokenCount, maxBoard });
  s.innerHTML = [
    chip('sent', '情绪', sent.score),
    chip('', '涨停', p.upCount),
    chip('down', '跌停', p.downCount),
    chip('broken', '炸板', p.brokenCount),
    chip('', '最高板', maxBoard),
    chip('', '炸板率', sent.breakRate + '%'),
    chip(sent.risk === '高' ? 'risk-high' : sent.risk === '中' ? 'risk-mid' : '', '风险', sent.risk),
  ].join('');
  const pb = $('#phaseBadge');
  pb.textContent = sent.phase;
  $('#ladderHint').textContent = '最高 ' + maxBoard + ' 板';
}
function chip(cls, label, val) {
  return '<div class="chip ' + cls + '"><span>' + label + '</span><strong>' + val + '</strong></div>';
}

/* ---------- 渲染：涨停池 ---------- */
function renderZt() {
  const p = state.pools;
  const list = $('#ztList');
  if (!p) { list.innerHTML = ''; return; }
  let rows = p.up.slice();
  const kw = state.ztFilter.trim();
  if (kw) rows = rows.filter((x) => x.name.includes(kw) || x.code.includes(kw));
  rows.sort((a, b) => {
    if (state.ztSort === 'seal') return (b.seal || 0) - (a.seal || 0);
    if (state.ztSort === 'pct') return (b.changePct || 0) - (a.changePct || 0);
    return b.boards - a.boards || (b.seal || 0) - (a.seal || 0);
  });
  $('#ztHint').textContent = '共 ' + p.upCount + ' 只';
  if (!rows.length) { list.innerHTML = '<div class="empty">没有匹配的股票</div>'; return; }
  list.innerHTML = rows.map(stockCard).join('');
  $$('#ztList .card').forEach((el) => el.addEventListener('click', () => openSheet(el.dataset.code)));
}

function stockCard(x) {
  const starred = state.watch.some((w) => w.code === x.code);
  const bcls = x.boards === 1 ? 'boards-tag b1' : 'boards-tag';
  return '<div class="card" data-code="' + x.code + '">' +
    '<div class="' + bcls + '">' + x.boards + '板</div>' +
    '<div><div class="name">' + x.name + (starred ? ' <span class="star">★</span>' : '') + '</div>' +
    '<div class="code">' + x.code + ' · ' + x.industry + '</div></div>' +
    '<div class="right"><div class="price ' + pctClass(x.changePct) + '">' + (x.price ? x.price.toFixed(2) : '--') + '</div>' +
    '<div class="pct ' + pctClass(x.changePct) + '">' + pctText(x.changePct) + '</div>' +
    '<div class="meta">封 ' + fmtMoney(x.seal) + ' · 换 ' + (x.turnover ? x.turnover.toFixed(1) + '%' : '--') + '</div></div>' +
    '</div>';
}

/* ---------- 渲染：跌停 / 炸板 ---------- */
function renderDowns() {
  const p = state.pools;
  if (!p) return;
  $('#dtCount').textContent = p.downCount;
  $('#zbCount').textContent = p.brokenCount;
  $('#dtList').innerHTML = p.down.length ? p.down.map(downCard).join('') : '<div class="empty">今日无跌停</div>';
  $('#zbList').innerHTML = p.broken.length ? p.broken.map(downCard).join('') : '<div class="empty">今日无炸板</div>';
  $$('#dtList .card, #zbList .card').forEach((el) => el.addEventListener('click', () => openSheet(el.dataset.code)));
}
function downCard(x) {
  return '<div class="card" data-code="' + x.code + '">' +
    '<div class="boards-tag b1">' + (x.boards || 1) + '板</div>' +
    '<div><div class="name">' + x.name + '</div><div class="code">' + x.code + ' · ' + x.industry + '</div></div>' +
    '<div class="right"><div class="price ' + pctClass(x.changePct) + '">' + (x.price ? x.price.toFixed(2) : '--') + '</div>' +
    '<div class="pct ' + pctClass(x.changePct) + '">' + pctText(x.changePct) + '</div>' +
    '<div class="meta">换 ' + (x.turnover ? x.turnover.toFixed(1) + '%' : '--') + '</div></div></div>';
}

/* ---------- 渲染：梯队 ---------- */
function renderLadder() {
  const p = state.pools;
  const wrap = $('#ladderWrap');
  if (!p || !p.up.length) { wrap.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const groups = {};
  p.up.forEach((x) => { groups[x.boards] = (groups[x.boards] || 0) + 1; });
  const keys = Object.keys(groups).map(Number).sort((a, b) => b - a);
  const max = Math.max(...Object.values(groups));
  wrap.innerHTML = keys.map((k) => {
    const cnt = groups[k];
    const pct = Math.round((cnt / max) * 100);
    return '<div class="ladder-group"><h3>' + k + ' 板 · ' + cnt + ' 只</h3>' +
      '<div class="bar-row"><span class="lab">' + k + '板</span>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '<span class="cnt">' + cnt + '</span></div></div>';
  }).join('');
}

/* ---------- 渲染：题材 ---------- */
function renderTheme() {
  const p = state.pools;
  const list = $('#themeList');
  if (!p || !p.up.length) { list.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const map = {};
  p.up.forEach((x) => { map[x.industry] = (map[x.industry] || 0) + 1; });
  const rows = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 40);
  list.innerHTML = rows.map((r, i) =>
    '<div class="rank-row"><span class="idx">' + (i + 1) + '</span><span class="nm">' + r[0] + '</span><span class="cnt">' + r[1] + ' 家</span></div>'
  ).join('');
}

/* ---------- 渲染：自选 ---------- */
function recordFor(code) {
  if (state.pools) {
    const s = state.pools.up.find((x) => x.code === code) ||
      state.pools.down.find((x) => x.code === code) ||
      state.pools.broken.find((x) => x.code === code);
    if (s) return { name: s.name, price: s.price, prevClose: null, changePct: s.changePct, main: null, super: null };
  }
  const d = state.quotes[code];
  if (d) {
    const pct = d.price != null && d.prevClose ? ((d.price - d.prevClose) / d.prevClose * 100) : null;
    return { name: d.name || code, price: d.price, prevClose: d.prevClose, changePct: pct, main: d.main, super: d.super };
  }
  return { name: code, price: null };
}
function renderWatch() {
  const list = $('#watchList');
  const empty = $('#watchEmpty');
  if (!state.watch.length) { list.innerHTML = ''; empty.classList.remove('hide'); return; }
  empty.classList.add('hide');
  list.innerHTML = state.watch.map((w) => {
    const r = recordFor(w.code);
    return '<div class="card" data-code="' + w.code + '">' +
      '<div><div class="name">' + r.name + '</div><div class="code">' + w.code + '</div></div>' +
      '<div class="right"><div class="price ' + pctClass(r.changePct) + '">' + (r.price != null ? r.price.toFixed(2) : '--') + '</div>' +
      '<div class="pct ' + pctClass(r.changePct) + '">' + pctText(r.changePct) + '</div>' +
      '<div class="meta">主 ' + (r.main != null ? fmtMoney(r.main) : '--') + '</div></div></div>';
  }).join('');
  $$('#watchList .card').forEach((el) => el.addEventListener('click', () => openSheet(el.dataset.code)));
}

/* ---------- 详情抽屉 ---------- */
async function openSheet(code) {
  const scrim = $('#scrim');
  const sheet = $('#sheet');
  let stock = null;
  if (state.pools) {
    stock = state.pools.up.find((x) => x.code === code) ||
            state.pools.down.find((x) => x.code === code) ||
            state.pools.broken.find((x) => x.code === code);
  }
  if (!stock) {
    const w = state.watch.find((x) => x.code === code);
    if (w) stock = { code, name: w.name || code, boards: 1, industry: '—', changePct: null, price: null };
  }
  if (!stock) return;
  const q = await fetchQuotes([code]).catch(() => ({}));
  const d = q[code] || {};
  const isWatch = state.watch.some((w) => w.code === code);
  const pct = d.price != null && d.prevClose ? ((d.price - d.prevClose) / d.prevClose * 100) : (stock.changePct != null ? stock.changePct : null);
  const body = $('#sheetBody');
  body.innerHTML =
    '<div class="s-head"><div><div class="s-name">' + (stock.name || code) + '</div>' +
    '<div class="s-code">' + code + ' · ' + (stock.industry || '—') + (stock.boards ? ' · ' + stock.boards + '板' : '') + '</div></div>' +
    '<div class="s-price"><b class="' + pctClass(pct) + '">' + (d.price != null ? d.price.toFixed(2) : (stock.price ? stock.price.toFixed(2) : '--')) + '</b>' +
    '<small class="' + pctClass(pct) + '">' + pctText(pct) + '</small></div></div>' +
    kvGrid(stock, d) +
    '<div class="s-actions"><button class="btn primary" id="sheetWatch">' + (isWatch ? '取消自选' : '★ 加自选') + '</button>' +
    '<button class="btn" id="sheetClose">关闭</button></div>';
  scrim.classList.add('show');
  sheet.classList.add('show');
  $('#sheetWatch').addEventListener('click', async () => {
    if (isWatch) { await delWatch(code); state.watch = state.watch.filter((w) => w.code !== code); }
    else { await putWatch({ code, addedAt: Date.now() }); state.watch.push({ code, addedAt: Date.now() }); }
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
  return '<div class="kv-grid">' + rows.map((r) =>
    '<div class="kv"><span>' + r[0] + '</span><strong>' + r[1] + '</strong></div>'
  ).join('') + '</div>';
}
function closeSheet() {
  $('#scrim').classList.remove('show');
  $('#sheet').classList.remove('show');
}

/* ---------- 导航 ---------- */
function switchView(v) {
  state.view = v;
  $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'view-' + v));
  $$('.bottomnav button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  if (v === 'watch') loadWatch();
  if (v === 'ladder') renderLadder();
  if (v === 'theme') renderTheme();
}

/* ---------- 刷新 ---------- */
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const btn = $('#refreshBtn');
  btn.classList.add('spin');
  try {
    const date = state.manualDate || todayStr();
    const pools = await fetchPools(date);
    state.pools = pools;
    renderStatus(); renderZt(); renderDowns(); renderLadder(); renderTheme();
    updateMeta(pools);
  } catch (e) {
    toast('刷新失败：' + e.message);
  } finally {
    btn.classList.remove('spin');
    refreshing = false;
  }
}
function updateMeta(p) {
  const date = state.manualDate || todayStr();
  $('#dateLabel').textContent = date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8);
  const banner = $('#intradayBanner');
  if (!p.upCount && !p.downCount) {
    banner.classList.remove('hide');
    banner.textContent = '未获取到行情数据（可能非交易时段，或该日期无数据）。可到「设置」手动输入交易日，或交易时段再试。';
  } else if (!tradingNow()) {
    banner.classList.remove('hide');
    banner.textContent = '非交易时段 · 显示最近交易日快照（手动点 ↻ 获取最新）';
  } else {
    banner.classList.add('hide');
  }
}

/* ---------- 自选加载 ---------- */
async function loadWatch() {
  state.watch = await getWatch();
  const codes = state.watch.map((w) => w.code);
  const inPools = new Set();
  if (state.pools) {
    [...state.pools.up, ...state.pools.down, ...state.pools.broken].forEach((x) => inPools.add(x.code));
  }
  const needQuote = codes.filter((c) => !inPools.has(c));
  state.quotes = needQuote.length ? await fetchQuotes(needQuote).catch(() => ({})) : {};
  renderWatch();
}

/* ---------- 设置 ---------- */
async function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
  await setKV('theme', state.theme);
}
function applyRefreshTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  if (state.refreshMs > 0) state.timer = setInterval(() => { if (tradingNow()) refresh(); }, state.refreshMs);
}

/* ---------- 工具 ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- 事件绑定 ---------- */
function bind() {
  $$('.bottomnav button').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('#refreshBtn').addEventListener('click', refresh);
  $('#ztSearch').addEventListener('input', (e) => { state.ztFilter = e.target.value; renderZt(); });
  $$('#ztSort button').forEach((b) => b.addEventListener('click', () => {
    $$('#ztSort button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on'); state.ztSort = b.dataset.sort; renderZt();
  }));
  $('#watchInput').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const code = e.target.value.trim().replace(/\D/g, '');
    if (code.length < 4) { toast('请输入有效的股票代码'); return; }
    if (state.watch.some((w) => w.code === code)) { toast('已在自选'); return; }
    let name = code;
    if (state.pools) {
      const s = [...state.pools.up, ...state.pools.down, ...state.pools.broken].find((x) => x.code === code);
      if (s) name = s.name;
    }
    await putWatch({ code, name, addedAt: Date.now() });
    state.watch.push({ code, name, addedAt: Date.now() });
    e.target.value = '';
    toast('已加入自选');
    loadWatch();
  });
  $('#setTheme').addEventListener('change', (e) => { state.theme = e.target.value; applyTheme(); });
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
    const dy = e.touches[0].clientY - startY;
    if (dy > 60) $('#ptr').classList.add('show');
  }, { passive: true });
  main.addEventListener('touchend', () => {
    if ($('#ptr').classList.contains('show')) refresh();
    $('#ptr').classList.remove('show');
    startY = null;
  });
}

/* ---------- 启动 ---------- */
async function init() {
  state.theme = (await getKV('theme', 'dark'));
  state.refreshMs = (await getKV('refreshMs', 15000));
  document.documentElement.setAttribute('data-theme', state.theme);
  $('#setTheme').value = state.theme;
  $('#setRefresh').value = String(state.refreshMs);
  bind();
  await refresh();
  applyRefreshTimer();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
