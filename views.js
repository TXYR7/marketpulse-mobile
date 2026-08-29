// views.js — 各 workspace 的渲染与交互（纯前端，依赖 data.js / analytics.js / store.js）
import {
  buildModeMonitor, calculateRollingPromotion, calculatePromotionStats, buildSimilarDays,
} from './analytics.js';

// 共享渲染工具：内容与上次相同则跳过 DOM 重建（防卡顿、保滚动位置）。返回是否真正重建。
export function setHTML(el, html) {
  if (!el || el.__last === html) return false;
  el.innerHTML = html;
  el.__last = html;
  return true;
}

// 共享防抖（原 views-extra 内部实现提升为公共工具，涨停池搜索框也复用）
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// 行级 diff：列表成员与顺序不变时，只原地更新变化的字段（价格/涨跌/封单等），
// 不再每 tick 整表 innerHTML 重建（盘中 300 卡 × 每 8~15s 一次的主线程卡顿根源）。
// sigFn 返回卡片"结构签名"（连板数/评级/信号/自选星等），变了才整卡重建；
// fieldSigFn 返回"数值签名"，变了走 patchFn 原地改文本/类名。
export function patchCardList(list, rows, cardHtmlFn, sigFn, fieldSigFn, patchFn, emptyHtml) {
  if (!rows.length) { setHTML(list, emptyHtml || '<div class="empty">没有匹配的股票</div>'); list.__seq = ''; return; }
  const seq = rows.map((x) => x.code).join(',');
  const first = list.firstElementChild;
  if (list.__seq !== seq || !first || !first.classList.contains('card')) {
    // 成员或顺序变化：整体重建一次
    const html = rows.map(cardHtmlFn).join('');
    if (setHTML(list, html)) {
      list.__seq = seq;
      for (let i = 0; i < rows.length; i += 1) {
        const node = list.children[i];
        if (!node) break;
        node.dataset.sig = sigFn(rows[i]);
        node.dataset.fs = fieldSigFn(rows[i]);
      }
    }
    return;
  }
  for (let i = 0; i < rows.length; i += 1) {
    const node = list.children[i];
    const x = rows[i];
    if (!node) break;
    const sig = sigFn(x);
    if (node.dataset.sig !== sig) {
      // 结构变化：仅重建这一张卡
      const tpl = document.createElement('template');
      tpl.innerHTML = cardHtmlFn(x).trim();
      const fresh = tpl.content.firstElementChild;
      if (fresh) {
        fresh.dataset.sig = sig;
        fresh.dataset.fs = fieldSigFn(x);
        list.replaceChild(fresh, node);
      }
      continue;
    }
    const fs = fieldSigFn(x);
    if (node.dataset.fs !== fs) { patchFn(node, x); node.dataset.fs = fs; }
  }
}

export function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
export function fmtMoney(v) {
  if (v == null || isNaN(v)) return '--';
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (a >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(Math.round(v));
}
export function pctClass(p) { return p > 0 ? 'up-c' : p < 0 ? 'down-c' : 'flat-c'; }
export function pctText(p) { if (p == null) return '--'; return (p > 0 ? '+' : '') + Number(p).toFixed(2) + '%'; }
// 评分维度 breakdown 的英文字键 → 中文标签（展示层用；未知键回退原值，新增维度不消失）。
export const BD_LABELS = {
  height: '高度', theme: '题材', position: '地位', coordination: '协同', turnover: '换手',
  seal: '封单', firstSeal: '首封', breaks: '烂板', role: '角色', mode: '模式',
};
export function tierBadge(t) { return '<span class="tier-badge ' + (t || '淘汰') + '">' + (t || '淘汰') + '</span>'; }
export function signalTag(s) { return s ? '<span class="signal-tag ' + s + '">' + s + '</span>' : ''; }

/* ---------------- 机会 ---------------- */
export function renderOpportunity(ctx) {
  const el = document.querySelector('#opp');
  const opp = ctx.state.opportunities || { tiers: { S: [], A: [], B: [] }, eliminated: [] };
  const tiers = opp.tiers || {};
  const sCount = (tiers.S || []).length, aCount = (tiers.A || []).length, bCount = (tiers.B || []).length, eCount = (opp.eliminated || []).length;
  document.querySelector('#oppHint').textContent = `S ${sCount} / A ${aCount} / B ${bCount} / 淘汰 ${eCount}`;
  if (!ctx.state.pools) { el.innerHTML = '<div class="empty">等待行情数据</div>'; return; }
  const block = (label, list, cls) => {
    if (!list.length) return '';
    return '<div class="tier-block"><div class="tier-head"><span class="tier-badge ' + cls + '">' + cls + '</span><span class="tier-head"><span class="t">' + label + '</span><span class="c">' + list.length + ' 只</span></span></div>' +
      list.map((x) => {
        const plus = (x.reasons?.plus || []).map((r) => '<span class="plus">+' + esc(r) + '</span>').join('');
        const minus = (x.reasons?.minus || []).map((r) => '<span class="minus">-' + esc(r) + '</span>').join('');
        const elim = (x.reasons?.elim || []).map((r) => '<span class="minus">' + esc(r) + '</span>').join('');
        return '<div class="opp-card" data-code="' + x.code + '">' +
          '<div class="row1"><div class="nm">' + esc(x.name) + ' <span class="pill">' + (x.boards || 1) + '板</span></div>' +
          '<div class="right">' + tierBadge(x.tier) + '<div class="score">' + x.score + '</div>' + (x.signal ? signalTag(x.signal.state) : '') + '</div></div>' +
          '<div class="sub">' + esc(x.industry || '—') + (x.role ? ' · ' + x.role : '') + '</div>' +
          (plus || minus || elim ? '<div class="reasons">' + plus + minus + elim + '</div>' : '') +
          '</div>';
      }).join('') + '</div>';
  };
  const html =
    block('S 级', tiers.S || [], 'S') +
    block('A 级', tiers.A || [], 'A') +
    block('B 级', tiers.B || [], 'B') +
    (eCount ? '<div class="muted" style="padding:6px 2px">淘汰 ' + eCount + ' 只（综合得分偏低或触发淘汰规则）</div>' : '');
  setHTML(el, html);
}

/* ---------------- 梯队（含历史晋级率） ---------------- */
function aggregatePromotion(historyArr) {
  const map = {};
  historyArr.forEach((h) => { map[h.date] = { date: h.date, stocks: h.stocks }; });
  const dates = Object.keys(map).sort();
  const byBoard = new Map();
  let sessions = 0;
  for (let i = 1; i < dates.length; i += 1) {
    const r = calculatePromotionStats(map[dates[i - 1]].stocks, map[dates[i]].stocks);
    if (!r.available) continue;
    sessions += 1;
    for (const g of r.byBoard) {
      if (!byBoard.has(g.board)) byBoard.set(g.board, { board: g.board, denominator: 0, promoted: 0 });
      const e = byBoard.get(g.board);
      e.denominator += g.denominator; e.promoted += g.promoted;
    }
  }
  const rows = [...byBoard.values()].sort((a, b) => a.board - b.board).map((g) => ({ ...g, rate: g.denominator ? Number((g.promoted / g.denominator * 100).toFixed(1)) : 0 }));
  const monitor = buildModeMonitor(map, 20, 5);
  return { available: sessions > 0, sessions, rows, monitor, rolling: calculateRollingPromotion(map, 20) };
}

export function renderLadder(ctx) {
  const el = document.querySelector('#ladderFull');
  const p = ctx.state.pools;
  if (!p) { el.innerHTML = '<div class="empty">等待行情数据</div>'; return; }
  const groups = {};
  p.up.forEach((x) => { groups[x.boards] = (groups[x.boards] || 0) + 1; });
  const keys = Object.keys(groups).map(Number).sort((a, b) => b - a);
  const max = Math.max(...Object.values(groups));
  const ladderBars = keys.map((k) => {
    const cnt = groups[k];
    const pct = Math.round((cnt / max) * 100);
    return '<div class="bar-row"><span class="lab">' + k + '板</span>' +
      '<div class="bar-track"><div class="bar-fill" style="transform:scaleX(' + (pct / 100).toFixed(3) + ')"></div></div>' +
      '<span class="cnt">' + cnt + '</span></div>';
  }).join('');

  const hist = ctx.state.history || [];
  let histHtml = '';
  if (hist.length >= 2) {
    const prom = aggregatePromotion(hist);
    if (prom.available) {
      const byBoardRows = prom.rows.map((g) => '<div class="ledger-row"><span class="nm">' + g.board + '板 → ' + (g.board + 1) + '板</span>' +
        '<span class="meta">样本 ' + g.denominator + '</span><span class="pnl">' + g.rate + '%</span></div>').join('');
      const monitorRows = (prom.monitor.modes || []).map((m) => {
        const trend = m.trend === 'improving' ? '↑改善' : m.trend === 'declining' ? '↓弱化' : m.trend === 'low_sample' ? '样本少' : '—';
        return '<div class="ledger-row"><span class="nm">' + m.mode + '</span><span class="meta">近5对 ' + (m.rateRecent ?? '--') + '%</span><span class="pnl">' + trend + '</span></div>';
      }).join('');
      histHtml = '<div class="sec-title"><h2>历史晋级率</h2><span class="hint">近 ' + prom.sessions + ' 对交易日</span></div>' +
        (byBoardRows || '<div class="muted">暂无晋级样本</div>') +
        '<div class="sec-title"><h2>模式监控</h2><span class="hint">整体晋级率 ' + (prom.rolling.rate ?? '--') + '%</span></div>' +
        (monitorRows || '<div class="muted">样本不足</div>');
    } else {
      histHtml = '<div class="muted">历史样本不足（需 ≥2 个交易日）。点「补录历史」拉取近 30 交易日涨停池。</div>';
    }
  } else {
    histHtml = '<div class="muted">尚未缓存历史涨停池。点下方按钮拉取近 30 个交易日（手机直连东方财富，按交易日去重，约需一分钟）。</div>';
  }

  const html =
    '<div class="ladder-group">' + ladderBars + '</div>' +
    '<button class="btn" id="histLoadBtn" style="margin:10px 0">' + (ctx.state.historyLoading ? '补录中…' : '补录历史（晋级率/模式监控）') + '</button>' +
    '<div class="muted" id="histStatus"></div>' + histHtml;
  if (setHTML(el, html)) {
    const btn = document.querySelector('#histLoadBtn');
    if (btn && !ctx.state.historyLoading) btn.addEventListener('click', () => ctx.actions.loadHistory && ctx.actions.loadHistory());
  }
}

/* ---------------- 结构（情绪驾驶舱 + 结构树 + 龙头 + 题材 + 相似） ---------------- */
export function renderStructure(ctx) {
  const el = document.querySelector('#structure');
  const s = ctx.state;
  if (!s.pools) { el.innerHTML = '<div class="empty">等待行情数据</div>'; return; }
  const em = s.emotion || {};
  const level = em.level || 'yellow';
  const indicators = (em.indicators || []).map((i) =>
    '<div class="ind ' + (i.available ? i.status : 'unavailable') + '"><span class="dot"></span><span class="k">' + i.label + '</span><span class="v">' + (i.value == null ? '—' : i.value) + '</span></div>'
  ).join('');
  const reasons = (em.reasons || []).map((r) => '<span>' + esc(r) + '</span>').join('');
  const cockpit =
    '<div class="emo"><div class="emo-top">' +
    '<div class="emo-index ' + level + '">' + (em.emotionIndex ?? '--') + '</div>' +
    '<div class="emo-meta"><div class="emo-phase">' + (em.phase || '--') + '</div><div class="emo-advice">' + esc(em.advice || '') + '</div>' +
    '<div class="muted">置信度 ' + (em.confidence ?? '--') + '%</div></div></div>' +
    '<div class="emo-indicators">' + indicators + '</div>' +
    (reasons ? '<div class="emo-reasons">' + reasons + '</div>' : '') + '</div>';

  const st = s.structure || { main: null, branches: [] };
  const treeBranch = (b, cls) => {
    const members = (b.members || []).map((m) =>
      '<div class="m"><span class="b">' + (m.boards || 1) + '板</span><span>' + esc(m.name) + '</span><span>' + (m.changePct != null ? pctText(m.changePct) : '') + '</span></div>'
    ).join('');
    const lds = (b.leaders || []).map((l) => '<span class="pill">' + esc(l.name) + ' · ' + l.role + '</span>').join('');
    return '<div class="' + cls + '"><div class="tree-head"><span class="tn">' + esc(b.name) + '</span><span class="ts">强度 ' + (b.score ?? '--') + ' · ' + (b.limitUpCount ?? '--') + ' 家 · 最高 ' + (b.maxBoard ?? '--') + '板</span></div>' +
      (lds ? '<div style="margin:4px 0">' + lds + '</div>' : '') +
      '<div class="tree-members">' + members + '</div></div>';
  };
  const tree = (st.main ? treeBranch(st.main, 'tree-main') : '<div class="muted">暂无主线</div>') + (st.branches || []).map((b) => treeBranch(b, 'tree-branch')).join('');

  const leaders = (s.leaders || []).slice(0, 12).map((l) => {
    const bd = Object.entries(l.breakdown || {}).filter(([, v]) => v != null).map(([k, v]) => '<span>' + (BD_LABELS[k] || k) + ':' + v + '</span>').join('');
    return '<div class="leader-card" data-code="' + l.code + '"><div class="row1"><div class="nm">' + esc(l.name) + '</div>' +
      '<div class="right"><div class="sc">' + l.score + '</div></div></div>' +
      '<div class="sub">' + (l.boards || 1) + '板 · ' + esc(l.role) + ' · ' + esc(l.themeName || '') + '</div>' +
      (bd ? '<div class="bd">' + bd + '</div>' : '') + '</div>';
  }).join('');

  const themes = (s.themes || []).slice(0, 15).map((t, i) => {
    // 题材升降：昨日同题材强度对比（±5 阈值出方向），无昨日数据时不渲染箭头
    const chg = t.direction == null ? '' : '<span class="chg ' + (t.direction === 'up' ? 'up-c' : t.direction === 'down' ? 'down-c' : 'flat-c') + '">' +
      (t.direction === 'up' ? '↑' : t.direction === 'down' ? '↓' : '→') + (t.scoreChange != null ? Math.abs(t.scoreChange) : '') + '</span>';
    return '<div class="rank-row"><span class="idx">' + (i + 1) + '</span><span class="nm">' + esc(t.name) + '</span><span class="cnt">' + t.score + '分 · ' + t.limitUpCount + '家</span>' + chg + '</div>';
  }).join('');

  let similar = '';
  if (s.history && s.history.length >= 2) {
    const sim = buildSimilarDays(s.history, s.pools.up, 3);
    if (sim.available) {
      const rows = sim.similar.map((d) =>
        '<div class="ledger-row"><span class="nm">' + d.date + '</span><span class="meta">相似度 ' + d.score + '%</span>' +
        '<span class="pnl">次日 ' + (d.outcome && d.outcome.up != null ? ('涨' + d.outcome.up + '% / 跌' + d.outcome.down + '%') : '—') + '</span></div>'
      ).join('');
      similar = '<div class="sec-title"><h2>相似行情</h2><span class="hint">近 ' + sim.samples + ' 样本</span></div>' + (rows || '<div class="muted">样本不足</div>');
    }
  }

  const html =
    '<div class="sec-title"><h2>情绪驾驶舱</h2></div>' + cockpit +
    '<div class="sec-title"><h2>市场结构</h2></div>' + tree +
    '<div class="sec-title"><h2>核心龙头</h2><span class="hint">Top ' + Math.min(12, (s.leaders || []).length) + '</span></div>' + (leaders || '<div class="empty">暂无</div>') +
    '<div class="sec-title"><h2>题材强度</h2><span class="hint">按强度</span></div><div class="list">' + (themes || '<div class="empty">暂无</div>') + '</div>' +
    similar;
  setHTML(el, html);
}

// 卡片点击由 app.js 的 document 级事件委托统一处理，这里不再逐卡绑定。
// 全市场 / 交易 / 复盘 / 决策助手视图在 views-extra.js 中定义，由 app.js 直接导入。
