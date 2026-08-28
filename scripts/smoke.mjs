// scripts/smoke.mjs — 轻量冒烟：node 直跑 analytics.js / data.js 纯函数，断言本次改动的核心形状。
// 不含浏览器/网络，仅校验「改了什么」的形状正确性；细节交给桌面 npm test 与浏览器人工核验。
import assert from 'node:assert';
import { stockSimilarCases, buildCopilotAnswer, COPILOT_QUESTIONS } from '../analytics.js';
import { shanghaiNow, todayStr } from '../data.js';

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, 'FAIL: ' + name);
  pass += 1;
  console.log('  ok -', name);
}

// 合成日K：升序、close>0、volume>0，足够 2*window 滑窗候选（window=20 → 需 ≥46 根）。
function makeBars(n) {
  const bars = [];
  for (let i = 1; i <= n; i += 1) {
    const close = 10 + i * 0.1 + (i % 3) * 0.5;
    bars.push({
      date: '2026-01-' + String(i).padStart(2, '0'),
      open: Number((close - 0.2).toFixed(2)),
      close: Number(close.toFixed(2)),
      high: Number((close + 0.3).toFixed(2)),
      low: Number((close - 0.3).toFixed(2)),
      volume: 1000 + i * 10,
    });
  }
  return bars;
}

console.log('[A1] stockSimilarCases 形状');
{
  const r = stockSimilarCases(makeBars(60), { window: 20, horizon: 5, limit: 3 });
  ok('available 为真', r.available === true);
  ok('similar 非空', Array.isArray(r.similar) && r.similar.length > 0);
  ok('score 降序整数 [0,100]', r.similar.every((c, i, a) => Number.isInteger(c.score) && c.score >= 0 && c.score <= 100 && (i === 0 || a[i - 1].score >= c.score)));
  ok('每条含 date+score+features', r.similar.every((c) => c.date && Number.isFinite(c.score) && Array.isArray(c.features)));
  ok('outcome 含 up/flat/down', r.outcome && 'up' in r.outcome && 'flat' in r.outcome && 'down' in r.outcome);
}
{
  const short = stockSimilarCases(makeBars(5), { window: 20, horizon: 5, limit: 3 });
  ok('短 bars → available:false 不抛', short.available === false && Array.isArray(short.similar) && short.similar.length === 0);
}
{
  const bad = stockSimilarCases(null, {});
  ok('非数组入参 → available:false 不抛', bad.available === false);
}

console.log('[A2] buildCopilotAnswer 三层输出');
{
  const html = buildCopilotAnswer('relay', {});
  ok('返回字符串', typeof html === 'string' && html.length > 0);
  ok('含 事实/推断/建议 三层', html.includes('事实') && html.includes('推断') && html.includes('建议'));
  const rich = buildCopilotAnswer('phase', { status: { phase: '主升期', emotionIndex: 72, maxBoard: 5 }, stats: { breakRate: { available: true, rate: 18 } }, limitUpCount: 60, limitDownCount: 2 });
  ok('phase 分支也含三层', rich.includes('事实') && rich.includes('推断') && rich.includes('建议'));
}
{
  // 移动端本版扩到 16 问（桌面 ~24；移动端 UI 更紧凑，沿用 16 已覆盖主要场景，每项均含 key+label）。
  ok('COPILOT_QUESTIONS 已扩展且每项有 key+label', Array.isArray(COPILOT_QUESTIONS) && COPILOT_QUESTIONS.length >= 16 && COPILOT_QUESTIONS.every((q) => q && q.key && q.label));
}

console.log('[C1] shanghaiNow / todayStr');
{
  const now = shanghaiNow();
  ok('shanghaiNow 返 Date', now instanceof Date && !Number.isNaN(now.getTime()));
  const d = todayStr();
  ok('todayStr 返 YYYYMMDD', typeof d === 'string' && /^\d{8}$/.test(d));
}

console.log(`\nAll ${pass} smoke checks passed.`);
