// views-extra.js — 全市场 / 交易 / 复盘 / 决策助手 视图
import { fetchAllMarket, searchStock } from './data.js';
import { getTrades, putTrade, delTrade, getReviews, putReview, delReview } from './store.js';
import { evaluatePortfolioRisk, attributionOf, buildCopilotAnswer, COPILOT_QUESTIONS, routeCopilotQuery } from './analytics.js';
import { esc, fmtMoney, pctClass, pctText, tierBadge, signalTag, setHTML, debounce } from './views.js';

/* ---------------- 全市场 ---------------- */
export function renderMarket(ctx) {
  const el = document.querySelector('#marketList');
  const status = document.querySelector('#marketTotal');
  const pagerEl = document.querySelector('#marketPager');
  const search = document.querySelector('#marketSearch');
  const mkt = document.querySelector('#marketMarket');
  if (!el) return;

  function marketRow(r) {
    const pc = r.changePct > 0 ? 'up-c' : r.changePct < 0 ? 'down-c' : 'flat-c';
    return '<div class="market-row" data-code="' + r.code + '"><div><div class="nm">' + esc(r.name) + '</div><div class="code">' + r.code + ' · ' + (r.industry || '—') + '</div></div>' +
      '<div class="right"><div class="price ' + pc + '">' + (r.price != null ? r.price.toFixed(2) : '--') + '</div>' +
      '<div class="amt">' + (r.changePct != null ? pctText(r.changePct) : '') + '</div></div></div>';
  }
  function paintRows(rows, emptyText) {
    if (!rows.length) { setHTML(el, '<div class="empty">' + (emptyText || '暂无数据') + '</div>'); return; }
    setHTML(el, rows.map(marketRow).join(''));
  }
  function render() {
    const am = ctx.state.allMarket || { rows: [], total: 0, page: 1 };
    status.textContent = '共 ' + am.total + ' 只';
    paintRows(am.rows, '暂无数据');
    const totalPages = Math.max(1, Math.ceil(am.total / 60));
    const phtml = '<button data-pg="prev">上一页</button><span class="pg">' + am.page + ' / ' + totalPages + '</span><button data-pg="next">下一页</button>';
    setHTML(pagerEl, phtml);
    // 翻页走模块级委托（见文件底部），这里只暴露导航回调，渲染不再重复绑监听
    pagerEl.__nav = (dir) => {
      const cur = ctx.state.allMarket?.page || 1;
      const tp = Math.max(1, Math.ceil((ctx.state.allMarket?.total || 0) / 60));
      ctx.state.marketPage = dir === 'prev' ? Math.max(1, cur - 1) : Math.min(tp, cur + 1);
      load();
    };
  }
  async function load() {
    try {
      const q = search.value.trim();
      if (q) {
        const rows = await searchStock(q);
        ctx.state.allMarket = { rows: rows.map((r) => ({ ...r, price: null, changePct: null })), total: rows.length, page: 1, market: '' };
      } else {
        const market = mkt.value;
        const page = ctx.state.marketPage || 1;
        const data = await fetchAllMarket({ market, page, pageSize: 60 });
        ctx.state.allMarket = data;
      }
      render();
    } catch (e) { paintRows([], '加载失败：' + e.message); }
  }
  search.oninput = debounce(() => { ctx.state.marketPage = 1; load(); }, 400);
  mkt.onchange = () => { ctx.state.marketPage = 1; load(); };
  if (!ctx.state.allMarket) load(); else render();
}

/* ---------------- 交易与持仓 ---------------- */
const BUY_REASONS = ['龙头', '一进二', '二进三', '三进四', '分歧回封', '弱转强', '竞价强', '板块爆发', '纯情绪'];
const SELL_REASONS = ['止盈', '止损', '情绪退潮', '龙头断板', '判断错误'];
const ERROR_TAGS = ['买在后排', '情绪判断错误', '竞价误判', '追高', '没有执行纪律', '卖飞'];
const TRADE_EMOTIONS = ['主升期', '高潮', '分歧期', '修复', '退潮初期', '退潮', '冰点', '发酵', '启动'];
const TRADE_STRATEGIES = ['首板', '一进二', '二进三', '三进四', '分歧回封', '弱转强', '竞价强', '板块爆发', '空仓', '纯情绪'];
const RESULT_OPTS = ['盈利', '亏损', '平'];

function chipGroup(label, key, opts, selected) {
  return '<div style="margin:4px 0"><div class="muted">' + label + '</div><div class="chips" data-group="' + key + '">' +
    opts.map((o) => '<button type="button" class="chip-btn ' + (selected.includes(o) ? 'on' : '') + '" data-v="' + o + '">' + o + '</button>').join('') +
    '</div></div>';
}

export function renderTrades(ctx) {
  const el = document.querySelector('#tradesView');
  if (!el) return;
  if (!ctx.state.tradesLoaded) { ctx.state.tradesLoaded = true; getTrades().then((t) => { ctx.state.trades = t; paint(); }); }
  else paint();

  function paint() {
    const trades = ctx.state.trades || [];
    const wins = trades.filter((t) => Number(t.pnl) > 0).length;
    const losses = trades.filter((t) => Number(t.pnl) < 0).length;
    const totalPnl = trades.reduce((s, t) => s + Number(t.pnl || 0), 0);
    const winRate = trades.length ? Math.round(wins / trades.length * 100) : 0;

    // 风险：只把「当日且未记卖出价」的流水视为未平仓持仓；
    // 历史已完成交易（有 pnl/卖出价）不再被当成 open 持仓反复计入风险暴露。
    const todayIso = new Date().toISOString().slice(0, 10);
    const positions = trades
      .filter((t) => t.sellPrice == null && t.date === todayIso)
      .map((t) => ({ fraction: Number(t.fraction || 0.2), theme: t.theme || '未分类', industry: t.industry || '未分类', status: 'open' }));
    const risk = evaluatePortfolioRisk({ positions, trades, today: todayIso });
    const riskHtml = risk.violations.length
      ? '<div class="risk-card"><div class="plan-verdict" style="color:var(--red)">⚠ 风险预警</div><ul class="plan-rules">' +
        risk.violations.map((v) => '<li>' + esc(v.label) + (v.value != null ? '（' + (typeof v.value === 'number' ? Math.round(v.value * 100) + '%' : v.value) + '）' : '') + '</li>').join('') + '</ul></div>'
      : '<div class="risk-card"><div class="plan-verdict" style="color:var(--green)">仓位与风险在限制内</div><div class="muted">总仓位 ' + Math.round(risk.totalExposure * 100) + '% · 持仓 ' + risk.positions + ' 只 · 连续亏损 ' + risk.losingStreak + ' 笔</div></div>';

    // 画像
    const byEmotion = {};
    trades.forEach((t) => { if (t.emotion) byEmotion[t.emotion] = (byEmotion[t.emotion] || 0) + 1; });
    const topEmotion = Object.entries(byEmotion).sort((a, b) => b[1] - a[1])[0];
    const persona = '<div class="review-card"><div class="rv-head"><strong>个人画像</strong></div><div class="rv-body note">交易 ' + trades.length + ' 笔 · 胜率 ' + winRate + '% · 累计 ' + (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2) + ' · 常见情绪 ' + (topEmotion ? topEmotion[0] : '—') + '</div></div>';

    const form = '<div class="trade-form" id="tradeForm">' +
      '<input id="tfCode" placeholder="代码，如 600519" inputmode="numeric" />' +
      '<input id="tfName" placeholder="名称（可选）" />' +
      '<div style="display:flex;gap:8px"><input id="tfDate" type="date" value="' + new Date().toISOString().slice(0, 10) + '" style="flex:1" /><input id="tfPnl" type="number" step="0.01" placeholder="盈亏(+/-)" style="flex:1" /></div>' +
      '<div style="display:flex;gap:8px"><select id="tfResult" style="flex:1">' + RESULT_OPTS.map((o) => '<option value="' + o + '">' + o + '</option>').join('') + '</select>' +
      '<input id="tfBuy" type="number" step="0.01" placeholder="买入价" style="flex:1" /><input id="tfSell" type="number" step="0.01" placeholder="卖出价" style="flex:1" /></div>' +
      '<div style="display:flex;gap:8px"><select id="tfEmotion" style="flex:1">' + TRADE_EMOTIONS.map((o) => '<option value="' + o + '">' + o + '</option>').join('') + '</select>' +
      '<select id="tfStrategy" style="flex:1">' + TRADE_STRATEGIES.map((o) => '<option value="' + o + '">' + o + '</option>').join('') + '</select></div>' +
      chipGroup('买入理由', 'buyReasons', BUY_REASONS, []) +
      chipGroup('卖出原因', 'sellReason', SELL_REASONS, []) +
      chipGroup('错误标签', 'errorTags', ERROR_TAGS, []) +
      '<input id="tfFraction" type="number" step="0.05" min="0" max="1" placeholder="仓位占比(0-1)，默认0.2" />' +
      '<button class="btn primary" id="tfSubmit">保存交易</button></div>';

    const ledger = trades.length ? trades.map((t) => {
      const at = attributionOf(t);
      return '<div class="ledger-row"><div><div class="nm">' + esc(t.name || t.code) + ' <span class="pill">' + esc(t.strategy || '') + '</span></div>' +
        '<div class="meta">' + (t.date || '') + ' · ' + esc((t.buyReasons || []).join('/')) + '</div>' +
        '<div class="meta">盘面 ' + at.market + ' / 题材 ' + at.theme + ' / 个股 ' + at.stock + ' / 买卖 ' + (at.buy + at.sell).toFixed(2) + '</div></div>' +
        '<div style="text-align:right"><div class="pnl ' + (t.pnl >= 0 ? 'up-c' : 'down-c') + '">' + (t.pnl >= 0 ? '+' : '') + Number(t.pnl).toFixed(2) + '</div>' +
        '<button class="trade-del" data-del="' + t.id + '">删除</button></div></div>';
    }).join('') : '<div class="empty">还没有交易记录</div>';

    const html =
      '<div class="stat-grid">' +
      '<div class="stat"><div class="v">' + trades.length + '</div><div class="k">交易笔数</div></div>' +
      '<div class="stat"><div class="v ' + (winRate >= 50 ? 'up-c' : 'down-c') + '">' + winRate + '%</div><div class="k">胜率</div></div>' +
      '<div class="stat"><div class="v ' + (totalPnl >= 0 ? 'up-c' : 'down-c') + '">' + (totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(2) + '</div><div class="k">累计盈亏</div></div>' +
      '</div>' + riskHtml + persona + form +
      '<div class="sec-title"><h2>交易流水</h2></div>' + ledger;
    el.__ctx = ctx;       // 模块级委托回调据此取到上下文
    el.__repaint = paint;
    if (!setHTML(el, html)) return; // 内容未变：不重建（chip 选中态/输入框内容天然保留）
  }
}

/* ---------------- 每日复盘 ---------------- */
function buildReviewText(state) {
  const em = state.emotion || {};
  const themes = (state.themes || []).slice(0, 5).map((t) => t.name + '(' + t.score + ')').join('、') || '—';
  const s = state.opportunities?.tiers || {};
  const plan = state.plan || {};
  const lines = [
    '【' + (state.pools?.date || new Date().toISOString().slice(0, 10)) + ' 复盘】',
    '情绪阶段：' + (em.phase || '--') + '（指数 ' + (em.emotionIndex ?? '--') + '，' + (em.advice || '') + '）',
    '涨停 ' + (state.pools?.upCount ?? '--') + ' / 跌停 ' + (state.pools?.downCount ?? '--') + ' / 炸板 ' + (state.pools?.brokenCount ?? '--'),
    '主线题材：' + themes,
    '机会池：S ' + (s.S || []).length + ' / A ' + (s.A || []).length + ' / B ' + (s.B || []).length,
    '明日预案：' + (plan.verdict || '--'),
    (plan.rules || []).map((r) => '· ' + r).join('\n')
  ];
  return lines.join('\n');
}

export function renderReview(ctx) {
  const el = document.querySelector('#reviewView');
  if (!el) return;
  if (!ctx.state.reviewsLoaded) { ctx.state.reviewsLoaded = true; getReviews().then((r) => { ctx.state.reviews = r; paint(); }); }
  else paint();

  function paint() {
    const text = buildReviewText(ctx.state);
    const list = (ctx.state.reviews || []).map((rv) =>
      '<div class="review-card"><div class="rv-head"><strong>' + esc(rv.date) + '</strong>' +
      '<button class="trade-del" data-rdel="' + esc(rv.date) + '">删除</button></div>' +
      '<div class="rv-body">' + esc(rv.text) + '</div></div>'
    ).join('') || '<div class="empty">还没有复盘记录</div>';
    const html =
      '<div class="toolbar"><button class="btn" id="rvGen">⚡ 生成今日复盘</button><button class="btn primary" id="rvSave">保存</button></div>' +
      '<textarea id="rvText" rows="10" style="width:100%;background:var(--surface-2);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;font-size:13px;font-family:inherit">' + esc(text) + '</textarea>' +
      '<div class="sec-title"><h2>历史复盘</h2></div>' + list;
    el.__ctx = ctx;
    el.__repaint = paint;
    if (!setHTML(el, html)) return; // 内容未变：不重建、保留用户正在编辑的文本
  }
}

/* ---------------- 决策助手 ---------------- */
export function renderAI(ctx) {
  const el = document.querySelector('#aiView');
  if (!el) return;
  const payload = ctx.state.lastPayload;
  const qHtml = COPILOT_QUESTIONS.map((q) => '<button type="button" class="copilot-question" data-copilot="' + q.key + '">' + esc(q.label) + '</button>').join('');
  const html = '<div class="sec-title"><h2>决策助手</h2><span class="hint">规则驱动，非预测</span></div>' +
    '<div class="copilot-questions">' + qHtml + '</div>' +
    '<div class="copilot-input-row"><input id="copilotInput" type="search" placeholder="问点什么，例如：现在能上几成仓" aria-label="向决策助手提问" autocomplete="off" />' +
    '<button class="btn primary" type="button" id="copilotAsk">提问</button></div>' +
    '<div id="copilotAnswer">' + (payload ? '<div class="all-empty">点击上方问题或输入关键词，查看系统解释</div>' : '<div class="all-empty">等待实时行情后可用</div>') + '</div>';
  el.__ctx = ctx;
  if (!setHTML(el, html)) return;
}

/* ---------------- 模块级事件委托（一次性挂载；Node 导入安全守卫） ----------------
   覆盖：翻页 / chip 多选 / 交易保存删除 / 复盘生成保存删除 / 决策助手提问。
   渲染函数只产出 HTML 并暴露 __ctx/__repaint/__nav，不再「每次渲染重新绑监听」。 */
if (typeof document !== 'undefined') {
  const selGroups = (root) => {
    const groups = {};
    root.querySelectorAll('.chips').forEach((g) => { groups[g.dataset.group] = [...g.querySelectorAll('.chip-btn.on')].map((b) => b.dataset.v); });
    return groups;
  };
  async function tradeSubmit(container) {
    const ctx = container?.__ctx; if (!ctx) return;
    const q = (s2) => container.querySelector(s2);
    const code = q('#tfCode').value.trim().replace(/\D/g, '');
    if (!code) { ctx.toast('请输入代码'); return; }
    const pnl = parseFloat(q('#tfPnl').value);
    if (isNaN(pnl)) { ctx.toast('请输入盈亏'); return; }
    const groups = selGroups(container);
    const name = q('#tfName').value.trim() || code;
    const trade = {
      id: Date.now() + '-' + code, code, name,
      date: q('#tfDate').value || new Date().toISOString().slice(0, 10),
      pnl, result: q('#tfResult').value,
      buyPrice: parseFloat(q('#tfBuy').value) || null,
      sellPrice: parseFloat(q('#tfSell').value) || null,
      emotion: q('#tfEmotion').value,
      strategy: q('#tfStrategy').value,
      fraction: parseFloat(q('#tfFraction').value) || 0.2,
      buyReasons: groups.buyReasons, sellReason: (groups.sellReason || [])[0] || '', errorTags: groups.errorTags,
      createdAt: Date.now()
    };
    await putTrade(trade);
    ctx.state.trades = await getTrades();
    ctx.toast('已保存交易');
    container.__repaint();
  }
  // 决策助手共用应答路径：预设按钮与自由文本输入（G25 对齐桌面）走同一 enriched 组装
  function answerCopilotWith(key, ctx) {
    if (!ctx.state.lastPayload) { ctx.toast('等待实时行情后再询问'); return; }
    const enriched = {
      ...ctx.state.lastPayload,
      status: { ...(ctx.state.lastPayload.status || {}), phase: ctx.state.phase, emotionIndex: ctx.state.emotion?.emotionIndex ?? null },
      stocks: (ctx.state.pools && ctx.state.pools.up) || [],
      positionAdvice: ctx.state.positionAdvice,
      mentalNotes: ctx.state.mentalNotes,
    };
    const el = document.querySelector('#copilotAnswer');
    if (el) el.innerHTML = buildCopilotAnswer(key, enriched);
  }
  function submitCopilotInput(input) {
    const ctx = input.closest('#aiView')?.__ctx;
    if (!ctx) return;
    const text = input.value.trim();
    if (!text) { ctx.toast('输入问题后再提问'); return; }
    const key = routeCopilotQuery(text, COPILOT_QUESTIONS);
    if (!key) { ctx.toast('没匹配到——换个说法，或点上方预设问题'); return; }
    answerCopilotWith(key, ctx);
    input.value = '';
  }
  document.addEventListener('click', async (e) => {
    const hit = (s2) => e.target.closest(s2);
    const pg = hit('[data-pg]');
    if (pg) {
      const search = document.querySelector('#marketSearch');
      if (search && search.value.trim()) return; // 搜索态不翻页（与原行为一致）
      document.querySelector('#marketPager')?.__nav?.(pg.dataset.pg);
      return;
    }
    const delBtn = hit('[data-del]');
    if (delBtn) {
      const container = delBtn.closest('#tradesView');
      const ctx = container?.__ctx; if (!ctx) return;
      await delTrade(delBtn.dataset.del);
      ctx.state.trades = await getTrades();
      container.__repaint();
      return;
    }
    const rdel = hit('[data-rdel]');
    if (rdel) {
      const container = rdel.closest('#reviewView');
      const ctx = container?.__ctx; if (!ctx) return;
      await delReview(rdel.dataset.rdel);
      ctx.state.reviews = await getReviews();
      container.__repaint();
      return;
    }
    if (hit('#tfSubmit')) { await tradeSubmit(hit('#tradesView')); return; }
    if (hit('#rvGen')) {
      const tv = hit('#reviewView');
      const ta = tv?.querySelector('#rvText');
      if (ta && tv.__ctx) ta.value = buildReviewText(tv.__ctx.state);
      return;
    }
    if (hit('#rvSave')) {
      const container = hit('#reviewView');
      const ctx = container?.__ctx; if (!ctx) return;
      const t = container.querySelector('#rvText').value.trim();
      if (!t) { ctx.toast('内容为空'); return; }
      const date = ctx.state.pools?.date || new Date().toISOString().slice(0, 10);
      await putReview({ date, text: t, createdAt: Date.now() });
      ctx.state.reviews = await getReviews();
      ctx.toast('已保存复盘');
      container.__repaint();
      return;
    }
    const cq = hit('[data-copilot]');
    if (cq) {
      const ctx = cq.closest('#aiView')?.__ctx;
      if (!ctx) return;
      answerCopilotWith(cq.dataset.copilot, ctx);
      return;
    }
    if (hit('#copilotAsk')) {
      const input = document.querySelector('#copilotInput');
      if (input) submitCopilotInput(input);
      return;
    }
    // chip 多选：只切类名，提交时按 .on 收集（不再维护 _sel 状态）
    const chipBtn = hit('.chip-btn[data-v]');
    if (chipBtn && chipBtn.closest('.chips')) chipBtn.classList.toggle('on');
  });
  // 决策助手自由输入：Enter 直接提交（与提问按钮同路径）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.id === 'copilotInput') { e.preventDefault(); submitCopilotInput(e.target); }
  });
}
