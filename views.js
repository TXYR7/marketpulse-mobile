// views.js — 各 workspace 的渲染与交互（纯前端，依赖 data.js / analytics.js / store.js）
import {
  buildModeMonitor, calculateRollingPromotion, calculatePromotionStats, buildSimilarDays,
} from './analytics.js';
import { boardTag } from './data.js';

// 共享渲染工具：内容与上次相同则跳过 DOM 重建（防卡顿、保滚动位置）。返回是否真正重建。
export function setHTML(el, html) {
  if (!el || el.__last === html) return false;
  el.innerHTML = html;
  el.__last = html;
  return true;
}

// 2026-09-10 减法批:debounce 已随涨停池搜索框(最后一个调用方)删除

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
export function pctText(p) { const n = Number(p); if (p == null || !Number.isFinite(n)) return '--'; return (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
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
          '<div class="row1"><div class="nm">' + esc(x.name) + boardTag(x.code) + ' <span class="pill">' + (x.boards || 1) + '板</span></div>' +
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
export function renderLadder(ctx) {
  const el = document.querySelector('#ladderFull');
  const p = ctx.state.pools;
  if (!p) { el.innerHTML = ''; return; }
  // 2026-09-11 拆解融合批:梯队并入涨停池头部——纵向 bar-row 改横向紧凑板位条,
  // 点格滚到涨停池对应板位首卡(涨停池排序=连板降序,首卡即最高板)
  const groups = {};
  p.up.forEach((x) => { groups[x.boards] = (groups[x.boards] || 0) + 1; });
  const keys = Object.keys(groups).map(Number).sort((a, b) => b - a);
  if (!keys.length) { el.innerHTML = ''; return; }
  const cells = keys.map((k) =>
    '<button class="lad-cell" data-board="' + k + '" type="button"><b>' + k + '板</b><span>' + groups[k] + '</span></button>'
  ).join('');
  setHTML(el, '<div class="lad-strip">' + cells + '</div>');
}

/* ---------------- 结构（龙头 + 题材;情绪驾驶舱已并入横幅/雷达 2026-09-11 拆解融合批） ---------------- */
export function renderStructure(ctx) {
  const el = document.querySelector('#structure');
  const s = ctx.state;
  if (!s.pools) { el.innerHTML = '<div class="empty">等待行情数据</div>'; return; }
  const leaders = (s.leaders || []).slice(0, 12).map((l) => {
    const bd = Object.entries(l.breakdown || {}).filter(([, v]) => v != null).map(([k, v]) => '<span>' + (BD_LABELS[k] || k) + ':' + v + '</span>').join('');
    return '<div class="leader-card" data-code="' + l.code + '"><div class="row1"><div class="nm">' + esc(l.name) + '</div>' +
      '<div class="right"><div class="sc">' + l.score + '</div></div></div>' +
      '<div class="sub"><span class="bd-tag">' + (l.boards || 1) + '板</span>' + esc(l.role) + ' · ' + esc(l.themeName || '') + '</div>' +
      (bd ? '<div class="bd">' + bd + '</div>' : '') + '</div>';
  }).join('');

  const themes = (s.themes || []).slice(0, 15).map((t, i) => {
    // 题材升降：昨日同题材强度对比（±5 阈值出方向），无昨日数据时不渲染箭头
    const chg = t.direction == null ? '' : '<span class="chg ' + (t.direction === 'up' ? 'up-c' : t.direction === 'down' ? 'down-c' : 'flat-c') + '">' +
      (t.direction === 'up' ? '↑' : t.direction === 'down' ? '↓' : '→') + (t.scoreChange != null ? Math.abs(t.scoreChange) : '') + '</span>';
    return '<div class="rank-row"><span class="idx">' + (i + 1) + '</span><span class="nm">' + esc(t.name) + '</span><span class="cnt">' + t.score + '分 · ' + t.limitUpCount + '家</span>' + chg + '</div>';
  }).join('');

  const html =
    '<div class="sec-title"><h2>核心龙头</h2><span class="hint">Top ' + Math.min(12, (s.leaders || []).length) + '</span></div>' + (leaders || '<div class="empty">暂无</div>') +
    '<div class="sec-title"><h2>题材强度</h2><span class="hint">按强度</span></div><div class="list">' + (themes || '<div class="empty">暂无</div>') + '</div>';
  setHTML(el, html);
}

// 卡片点击由 app.js 的 document 级事件委托统一处理，这里不再逐卡绑定。
// 全市场 / 交易 / 复盘 / 决策助手视图在 views-extra.js 中定义，由 app.js 直接导入。
