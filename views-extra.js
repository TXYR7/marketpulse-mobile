// views-extra.js — 每日复盘视图(2026-09-11:交易视图已随侧滑菜单整删,见下注)
import { getReviews, putReview, delReview } from './store.js';
import { esc, setHTML } from './views.js';

/* 2026-09-11 减法批:renderTrades(交易与持仓视图)整链删除——实盘在同花顺/东财,
   手机端纯研究参考;视图入口已随侧滑菜单砍除。连带埋葬既存 bug:98c7023 批误删
   RESULT_OPTS 等常量定义而 renderTrades 仍引用(一调用即 ReferenceError)。
   tradeSubmit/交易删除委托分支同步删除;store.js 的 getTrades/putTrade/delTrade
   数据层保留(旧记录不丢,桌面端交易链完整保留)。 */

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
      '<div class="toolbar"><button class="btn" id="rvGen">生成今日复盘</button><button class="btn primary" id="rvSave">保存</button></div>' +
      '<textarea id="rvText" rows="10" style="width:100%;background:var(--surface-2);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:10px;font-size:13px;font-family:inherit">' + esc(text) + '</textarea>' +
      '<div class="sec-title"><h2>历史复盘</h2></div>' + list;
    el.__ctx = ctx;
    el.__repaint = paint;
    if (!setHTML(el, html)) return; // 内容未变：不重建、保留用户正在编辑的文本
  }
}

/* 2026-09-09 减法批:决策助手(renderAI/answerCopilotWith/submitCopilotInput + 事件委托两分支 + import)
   已删——与桌面端同口径(答案与页面数字同源零增量,LLM 从未配置);analytics.js 的
   COPILOT_QUESTIONS/buildCopilotAnswer/routeCopilotQuery 函数保留(同步哨兵锁定同名一致性)。 */

/* ---------------- 模块级事件委托（一次性挂载；Node 导入安全守卫） ----------------
   覆盖：翻页 / chip 多选 / 交易保存删除 / 复盘生成保存删除。
   渲染函数只产出 HTML 并暴露 __ctx/__repaint/__nav，不再「每次渲染重新绑监听」。 */
if (typeof document !== 'undefined') {
  // 2026-09-11 减法批:selGroups/tradeSubmit/交易删除/保存委托分支已随交易视图整删
  document.addEventListener('click', async (e) => {
    const hit = (s2) => e.target.closest(s2);

    const rdel = hit('[data-rdel]');
    if (rdel) {
      const container = rdel.closest('#reviewView');
      const ctx = container?.__ctx; if (!ctx) return;
      await delReview(rdel.dataset.rdel);
      ctx.state.reviews = await getReviews();
      container.__repaint();
      return;
    }
    if (hit('#tfSubmit')) { return; } // 2026-09-11:交易表单已删,占位防误触(元素不存在不会命中)
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
    // 2026-09-11 减法批:chip 多选委托已随交易表单整删
  });
  // 2026-09-11 减法批:copilotInput Enter 委托已删(submitCopilotInput 09-09 已随决策助手删除,
  // 此 handler 引用不存在的函数——若用户曾按 Enter 在 id 恰为 copilotInput 的输入框会抛 ReferenceError)
}
