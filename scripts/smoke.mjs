// scripts/smoke.mjs — 轻量冒烟：node 直跑 analytics.js / data.js 纯函数，断言本次改动的核心形状。
// 不含浏览器/网络，仅校验「改了什么」的形状正确性；细节交给桌面 npm test 与浏览器人工核验。
// 运行：npm test（= node --experimental-vm-modules scripts/smoke.mjs；B9 语法护栏需要该 flag）。
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  stockSimilarCases, buildCopilotAnswer, COPILOT_QUESTIONS,
  calculateEmotionState, yesterdayPremium, buildThemeRanking, assessPromotion, routeCopilotQuery
} from '../analytics.js';
import { shanghaiNow, todayStr, mergePools, sealQuality } from '../data.js';

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

console.log('[B1] mergePools 三池部分失败降级');
{
  const row = (c) => ({ c, n: '股' + c, lbc: 2, p: 15000, zdp: 10.0, fund: null, ltsz: null, zbc: 0, hybk: 'AI' });
  const fulfilled = (pool, qdate, tc) => ({ status: 'fulfilled', value: { data: { pool, qdate, tc } } });
  const rejected = (msg) => ({ status: 'rejected', reason: new Error(msg) });
  const partial = mergePools('20260829', [fulfilled([row('600001'), row('600002')], '20260829', 25), rejected('跌停池失败'), rejected('炸板池失败')]);
  ok('仅涨停池成功 → partial 标记 + 缺源清单', partial.partial === true && partial.partialMissing.includes('跌停池') && partial.partialMissing.includes('炸板池'));
  ok('upCount 用接口 tc（25）而非映射数组长度（2）', partial.upCount === 25);
  ok('sources 三布尔正确', partial.sources.up === true && partial.sources.down === false && partial.sources.broken === false);
  assert.throws(() => mergePools('20260829', [rejected('x'), rejected('y'), rejected('z')]), '全败应抛错');
  pass += 1; console.log('  ok - 三池全败 → 抛错');
  const full = mergePools('20260829', [fulfilled([row('600001')], '20260829', 1), fulfilled([row('600003')], '20260829', 1), fulfilled([row('600004')], '20260829', 1)]);
  ok('三池全成功 → 非部分、三池各 1 条', full.partial === false && full.up.length === 1 && full.down.length === 1 && full.broken.length === 1);
}

console.log('[B2] sealQuality 封单星级');
{
  const strong = sealQuality({ sealAmount: 5e8, circulatingValue: 1e10 });
  ok('封成比 5% → 5 星 极强', strong.stars === 5 && strong.label === '极强');
  const weak = sealQuality({ sealAmount: 1e6, circulatingValue: 1e8, breakCount: 2 });
  ok('封成比 1% + 炸板 2 次 → 降至 1 星', weak.stars === 1);
  ok('缺封单额 → null 不抛', sealQuality({ sealAmount: null, circulatingValue: 1e8 }) === null);
}

console.log('[B3] calculateEmotionState 情绪三指标（G9 接线）');
{
  const base = { limitUpCount: 88, limitDownCount: 5, multiBoardCount: 20, maxBoard: 5, breakRate: { available: true, rate: 15 }, firstBoardPromotionRate: 40, multiBoardPromotionRate: 50 };
  const NEW3 = ['marketBreakRate', 'firstBoardPremium', 'highBoardPremium'];
  const r7 = calculateEmotionState(base);
  ok('基础 7 指标 → 置信度 70%、三新指标 unavailable', r7.confidence === 70 && r7.indicators.filter((i) => NEW3.includes(i.key)).every((i) => i.available === false && i.value === null));
  const r8 = calculateEmotionState({ ...base, marketBreakRate: 10 });
  ok('+市场断板率 → 置信度 80%', r8.confidence === 80 && r8.indicators.find((i) => i.key === 'marketBreakRate').available === true);
  const r10 = calculateEmotionState({ ...base, marketBreakRate: 10, firstBoardPremium: 3, highBoardPremium: 2 });
  ok('三指标齐 → 置信度 100%、10 指标全可用', r10.confidence === 100 && r10.indicators.every((i) => i.available));
  const thin = calculateEmotionState({ limitUpCount: 10 });
  ok('仅 1 指标 → 数据不足不强行周期', thin.available === false && thin.phase === '数据不足' && thin.confidence === 10);
}

console.log('[B4] yesterdayPremium 昨日涨停开盘溢价');
{
  const r = yesterdayPremium([{ code: 'A', boards: 1 }, { code: 'B', boards: 1 }, { code: 'C', boards: 3 }], { A: 5, B: 3, C: 10 });
  ok('首板组(5,3)/高位组(10) 各自均值', r.firstBoardPremium === 4 && r.highBoardPremium === 10);
  const empty = yesterdayPremium([], {});
  ok('空入参 → 双 null', empty.firstBoardPremium === null && empty.highBoardPremium === null);
}

console.log('[B5] buildThemeRanking 题材升降方向');
{
  const stock = (i) => ({ code: 'S' + i, industry: 'AI', boards: 1, changePercent: 5, sealAmount: null });
  const solo = buildThemeRanking([stock(1)]);
  ok('无昨日池 → direction/scoreChange 为 null', solo[0].direction === null && solo[0].scoreChange === null);
  const grown = buildThemeRanking([stock(1), stock(2), stock(3), stock(4), stock(5)], [stock(9)]);
  ok('昨日 1 只 → 今日 5 只 → up 且 scoreChange≥5', grown[0].direction === 'up' && grown[0].scoreChange >= 5);
}

console.log('[B6] assessPromotion 硬否决');
{
  const ctx = { phase: '主升期', themeSize: 5, role: '板块龙头', openPct: 2.1 };
  const late = assessPromotion({ code: '300001', boards: 2, firstSealTime: '143500', breakCount: 0 }, ctx);
  ok('14:35 后封板 → 尾盘偷袭 规避', late.verdict === '规避' && late.hardFails.includes('尾盘偷袭封板'));
  const lowOpen = assessPromotion({ code: '300002', boards: 2, firstSealTime: '093200', breakCount: 0 }, { ...ctx, openPct: -1 });
  ok('竞价低开 → 硬否决', lowOpen.hardFails.includes('竞价低开'));
  const broke = assessPromotion({ code: '300003', boards: 2, firstSealTime: '093200', breakCount: 3 }, ctx);
  ok('炸板 3 次 → 反复炸板 规避', broke.verdict === '规避' && broke.hardFails.includes('反复炸板 3 次'));
}

console.log('[B7] routeCopilotQuery 自由文本路由（G25 输入框）');
{
  ok('『现在该上几成仓位』→ position', routeCopilotQuery('现在该上几成仓位', COPILOT_QUESTIONS) === 'position');
  ok('『炸板率有点高』→ breakrate（移动端 key 为小写）', routeCopilotQuery('炸板率有点高', COPILOT_QUESTIONS) === 'breakrate');
  ok('无匹配 → null', routeCopilotQuery('xyz乱码', COPILOT_QUESTIONS) === null);
}

console.log('[B8] 版本一致性（sw.js CACHE ↔ version.js APP_VERSION）');
{
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const ver = readFileSync(new URL('../version.js', import.meta.url), 'utf8');
  const cache = (sw.match(/const CACHE = ['"]([^'"]+)['"]/) || [])[1];
  const appVer = (ver.match(/APP_VERSION = ['"]([^'"]+)['"]/) || [])[1];
  ok('双源版本号一致', Boolean(cache) && cache === appVer && cache.startsWith('mp-mobile-v'));
}

console.log('[B9] 整文件语法护栏（vm.SourceTextModule 只编译不执行）');
{
  ok('vm.SourceTextModule 可用（需 --experimental-vm-modules，用 npm test 跑）', typeof vm.SourceTextModule === 'function');
  const files = ['app.js', 'analytics.js', 'views.js', 'views-extra.js', 'data.js', 'store.js', 'version.js'];
  const broken = [];
  for (const f of files) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    try { new vm.SourceTextModule(src, { identifier: f }); } catch (e) { broken.push(f + ': ' + e.message); }
  }
  if (broken.length) console.error('  语法错误明细：\n    ' + broken.join('\n    '));
  ok('7 个运行时 JS 文件全部通过模块语法编译', broken.length === 0);
}

console.log(`\nAll ${pass} smoke checks passed.`);
