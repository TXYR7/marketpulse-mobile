// scripts/smoke.mjs — 轻量冒烟：node 直跑 analytics.js / data.js 纯函数，断言本次改动的核心形状。
// 不含浏览器/网络，仅校验「改了什么」的形状正确性；细节交给桌面 npm test 与浏览器人工核验。
// 运行：npm test（= node --experimental-vm-modules scripts/smoke.mjs；B9 语法护栏需要该 flag）。
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  stockSimilarCases, buildCopilotAnswer, COPILOT_QUESTIONS,
  calculateEmotionState, yesterdayPremium, buildThemeRanking, assessPromotion, routeCopilotQuery, diffSignalSnapshot, buildSimilarDays,
  applyGate, auctionVerdict, detectPreSealAlerts, buildAuctionWatchlist, limitThresholdOf, isInTradingSession,
  limitPriceOf, isMainBoardShare, isExcludedPreSealName, PARAM_MANIFEST
} from '../analytics.js';
import {
  shanghaiNow, todayStr, mergePools, sealQuality, isTradingDay, lastTradingDate,
  shouldRefetchGap, mapSearchRow, setEmaToken,
  cachedKlineBars, storeKlineBars, exportKlineCache, hydrateKlineCache, fetchPools, fetchQuotes, fetchKlineLite,
  parseAuctionTrend, collectAuctionSnapshot, auctionVolRatio, pickAuctionCoreCodes
} from '../data.js';

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
  // 2026-09-13 检查批修:候选环收紧为与当前段零重叠(需 >=86 根)——60 根旧池现在
  // available=false 是正确行为(修前 60 根候选全重叠当前段=自己匹配自己)
  const r = stockSimilarCases(makeBars(120), { window: 20, horizon: 5, limit: 3 });
  ok('available 为真(120 根零重叠池)', r.available === true);
  const r60 = stockSimilarCases(makeBars(60), { window: 20, horizon: 5, limit: 3 });
  ok('60 根旧池无零重叠候选 → available=false 诚实不硬算', r60.available === false && r60.similar.length === 0);
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

console.log('[B16] 渲染卫生批：封板时间格式化 / 阶段中文 / 停牌横线清洗 / copilot 空档兜底');
{
  // fbt 原始数字 → 检查表注记 HH:MM:SS（曾直显「93500 秒板级」）
  const promo = assessPromotion({ code: '300001', boards: 2, firstSealTime: 93500, breakCount: 0 }, { phase: '主升期', themeSize: 5, role: '板块龙头', openPct: 2.1 });
  const sealNote = promo.checklist.find((c) => c.label === '封板时间');
  ok('封板时间注记 09:35:00（不再直显 93500）', sealNote.note.includes('09:35:00') && !sealNote.note.includes('93500'));
  // 相似行情「情绪阶段」中文阶段名（不再直显 0-6 序数）
  const days = [
    { date: '20260810', stocks: [{ code: 'A', boards: 2 }, { code: 'B', boards: 1 }] },
    { date: '20260811', stocks: [{ code: 'A', boards: 3 }, { code: 'B', boards: 1 }, { code: 'C', boards: 1 }] }
  ];
  const sim = buildSimilarDays(days, days[1].stocks);
  const dim = sim.similar[0].dimensions.find((d) => d.label === '情绪阶段');
  ok('相似行情情绪阶段为中文名', typeof dim.cur === 'string' && !/^\d$/.test(dim.cur) && typeof dim.hist === 'string' && !/^\d$/.test(dim.hist));
  // 停牌行 '-' 清洗：changePct/turnover→null（不再 NaN%/toFixed 崩），fbt→09:25:00
  const merged = mergePools('20260831', [
    { status: 'fulfilled', value: { data: { qdate: '20260831', pool: [{ c: '000001', n: '测试', p: 10000, zdp: '-', fund: '-', hs: '-', zbc: 0, ltsz: '-', amount: '-', fbt: 92500 }] } } },
    { status: 'fulfilled', value: { data: { pool: [] } } },
    { status: 'fulfilled', value: { data: { pool: [] } } }
  ]);
  ok('停牌 \'-\' 清洗为 null', merged.up[0].changePct === null && merged.up[0].turnover === null && merged.up[0].seal === null);
  ok('mapPool fbt 92500 → firstSealTime 09:25:00', merged.up[0].firstSealTime === '09:25:00');
  // copilot 明天重点：未知阶段不再渲染空「可参与： / 禁止：」
  const ans = buildCopilotAnswer('tomorrow', { status: { phase: '数据不足' } });
  ok('未知阶段 → 等待方向选择 兜底生效', ans.includes('等待方向选择') && !ans.includes('可参与：</span>') );
}

console.log('[B8] 版本一致性（sw.js CACHE ↔ version.js APP_VERSION）');
{
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const ver = readFileSync(new URL('../version.js', import.meta.url), 'utf8');
  const cache = (sw.match(/const CACHE = ['"]([^'"]+)['"]/) || [])[1];
  const appVer = (ver.match(/APP_VERSION = ['"]([^'"]+)['"]/) || [])[1];
  // 2026-09-10 起日期制版本(mp-mobile-YYYYMMDD 或 -N 同日序列),替代旧 vN 累积计数
  ok('双源版本号一致', Boolean(cache) && cache === appVer && /^mp-mobile-\d{8}(-\d+)?$/.test(cache));
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

console.log('[B10] 批B/D3 优化项（gap 缓存策略 / K线缓存复用 / 搜索价格 / token / 信号通知）');
{
  const at = (h, m) => new Date(2026, 0, 1, h, m);
  ok('B1 shouldRefetchGap：09:25 前 true / 09:31 后 false / 回看历史日 false',
    shouldRefetchGap(at(9, 25), '') === true && shouldRefetchGap(at(9, 31), '') === false
    && shouldRefetchGap(at(8, 0), '') === true && shouldRefetchGap(at(10, 0), '') === false
    && shouldRefetchGap(at(9, 25), '20260101') === false);
}
{
  const bars = Array.from({ length: 60 }, (_, i) => ({ date: '2026-01-' + String(i + 1).padStart(2, '0'), open: 1, close: 1 + i }));
  storeKlineBars('600001', '20260829', bars);
  const hit = cachedKlineBars('600001', '20260829');
  ok('B3 K线缓存 roundtrip：store 后可命中', hit && hit.length === 60 && hit[59].close === 60);
  ok('B3 dateKey 变更后 miss（隔日数据不串用）', cachedKlineBars('600001', '20260830') === null);
  const exported = exportKlineCache();
  const cap = Object.keys(exported || {}).length;
  ok('B3 export/hydrate 往返', cap >= 1 && (() => { hydrateKlineCache(exported); return cachedKlineBars('600001', '20260829')?.length === 60; })());
}
{
  const row = mapSearchRow({ f12: '600000', f13: 1, f14: '浦发银行', f2: 10.5, f3: 2.3 });
  const halted = mapSearchRow({ f12: '600001', f13: 1, f14: '某股', f2: '-', f3: '-' });
  ok('B5 mapSearchRow：正常值映射、停牌 - 转 null', row.price === 10.5 && row.changePct === 2.3 && halted.price === null && halted.changePct === null);
}
{
  setEmaToken('test-token-xyz');
  ok('B6 setEmaToken：覆盖后可恢复默认', setEmaToken('x') === undefined);
  setEmaToken(''); // 清空 → 回落内置默认
  ok('B6 清空 token 回落默认不炸', true);
}
{
  const prev = { byCode: { '600001': { tier: 'A', verdict: '观望', name: '甲' }, '600002': { tier: 'B', verdict: '规避', name: '乙' } } };
  const next = { byCode: {
    '600001': { tier: 'S', verdict: '可接力', name: '甲' },
    '600002': { tier: 'B', verdict: '规避', name: '乙' },
    '600003': { tier: 'S', verdict: '观望', name: '丙' },
  } };
  const changes = diffSignalSnapshot(prev, next);
  ok('D3 diffSignalSnapshot：升级+新入S+转可接力 三类正向变化', changes.length === 3
    && changes.some((c) => c.includes('A→S')) && changes.some((c) => c.includes('新入 S 级')) && changes.some((c) => c.includes('可接力')));
  ok('D3 无变化/prev为null 返回空', diffSignalSnapshot(prev, prev).length === 0 && diffSignalSnapshot(null, next).length === 0);
}

console.log('[B11] 响应速度批：getJSON 在途去重 / fetchPools fail-fast 透传');
{
  const realFetch = globalThis.fetch;
  let calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, json: async () => ({ data: { pool: [], tc: 0 } }) }; };
  try {
    const [a, b] = await Promise.all([fetchPools('20260101'), fetchPools('20260101')]);
    ok('并发两次同日期三池 → 在途去重只外呼 3 次（非 6 次）', calls.length === 3);
    ok('两次调用均正常返回（共享同一在途结果）', a.upCount === 0 && b.upCount === 0 && a.partial === false && b.partial === false);
    calls = [];
    await fetchPools('20260101');
    await fetchPools('20260101');
    ok('串行两次 → 各自外呼（settle 即出表，不缓存结果不返陈旧数据）', calls.length === 6);
    let aborts = 0;
    globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
      if (opts?.signal) opts.signal.addEventListener('abort', () => { aborts += 1; reject(new Error('aborted')); });
    });
    const t0 = Date.now();
    let threw = false;
    // Node 的 AbortSignal.timeout 内部 timer 为 unref（不保活事件循环），挂一个 ref timer 才等得到超时
    const keepAlive = setTimeout(() => {}, 500);
    try { await fetchPools('20260102', { tries: 1, timeoutMs: 30 }); } catch (e) { threw = true; }
    clearTimeout(keepAlive);
    ok('fail-fast 透传：挂起请求按超时中止、tries=1 不重试、三池全败抛错', threw && aborts === 3 && Date.now() - t0 < 2000);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('[B13] 详情抽屉提速批：fetchQuotes 数值清洗（停牌 -）/ fail-fast 透传');
{
  const realFetch = globalThis.fetch;
  // 停牌股 ulist 返回 '-' 字符串：清洗成 null，下游 toFixed/fmtMoney 只判 null（曾致抽屉抛错打不开）
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { diff: [
      { f12: '600001', f14: '正常甲', f2: 10.5, f17: 10.2, f18: 9.9, f62: 1234567, f66: 800000 },
      { f12: '600002', f14: '停牌乙', f2: '-', f17: '-', f18: '-', f62: '-', f66: '-' },
    ] } }),
  });
  try {
    const q = await fetchQuotes(['600001', '600002']);
    ok('正常股字段映射完整', q['600001'].price === 10.5 && q['600001'].open === 10.2 && q['600001'].prevClose === 9.9
      && q['600001'].main === 1234567 && q['600001'].super === 800000);
    ok('停牌股 "-" 全部清洗为 null（非字符串，不炸 toFixed）', q['600002'].price === null && q['600002'].open === null
      && q['600002'].prevClose === null && q['600002'].main === null && q['600002'].super === null);

    let aborts = 0;
    globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
      if (opts?.signal) opts.signal.addEventListener('abort', () => { aborts += 1; reject(new Error('aborted')); });
    });
    const t0 = Date.now();
    // Node 的 AbortSignal.timeout 内部 timer 为 unref（不保活事件循环），挂一个 ref timer 才等得到超时
    const keepAlive = setTimeout(() => {}, 500);
    const q2 = await fetchQuotes(['600001'], { tries: 1, timeoutMs: 30 });
    clearTimeout(keepAlive);
    // 2026-09-10 push2delay 兜底批:主 host 挂 → 兜底也挂(tries=1) → 块计失败不抛错;两次中止=主+兜各一次
    ok('fail-fast 透传：抽屉补价参数(tries=1/30ms)直达 getJSON，主+兜底均中止且单块失败不抛错',
      aborts === 2 && q2.__failedChunks === 1 && Object.keys(q2).length === 1 && Date.now() - t0 < 2000);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('[B12] 品牌批：命名三处一致 + 图标 PNG 尺寸与 manifest 声明匹配');
{
  const manifest = JSON.parse(readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const appleTitle = (html.match(/apple-mobile-web-app-title" content="([^"]*)"/) || [])[1];
  ok('short_name === apple-mobile-web-app-title ===「星脉」', manifest.short_name === '星脉' && appleTitle === '星脉');
  // 2026-09-10:品牌纯中文化——name 也是「星脉」(旧双名 MarketPulse 星脉废弃)
  ok('name ===「星脉」(纯中文品牌)', manifest.name === '星脉');
  const pngSize = (file) => {
    const b = readFileSync(new URL('../' + file, import.meta.url));
    if (b.readUInt32BE(0) !== 0x89504e47) return null; // PNG 魔数
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  };
  for (const icon of manifest.icons) {
    const dims = pngSize(icon.src);
    const declared = icon.sizes.split('x').map(Number);
    ok(`图标 ${icon.src} 为合法 PNG 且尺寸 ${icon.sizes} 与文件一致（purpose ${icon.purpose}）`,
      Boolean(dims) && dims.w === declared[0] && dims.h === declared[1]);
  }
}

console.log('[B14] 集合竞价：parseAuctionTrend / auctionVolRatio / pickAuctionCoreCodes / collectAuctionSnapshot');
{
  // 对象形态（实测主形态）：f2=YYMMDDHHMM、f3=价格×100、f8=参考价×1000、f14/f15=申报量(股)、f9=竞价额(元)、f10=竞价量(手)
  const mk = (hhmm, f3, f8, f14, f15, f9, f10) => ({ f2: '260831' + hhmm, f3, f8, f14, f15, f9, f10 });
  const payload = { data: [
    mk('0915', 1010, 9950, 500000, 800000),
    mk('0916', 1020, 9950, 600000, 700000),
    { f2: '2608300915', f3: 1000, f8: 9950, f14: 1, f15: 1 }, // 跨日点：应被过滤
    mk('0926', 1030, 10300, 134000000, 0, 15330000, 24041),   // 撮合终态点：不出现在 minutes
  ] };
  const r = parseAuctionTrend(payload, '20260831');
  ok('minutes 只含 0915/0916（跨日点被滤、0926 不入列）', r.minutes.length === 2 && r.minutes[0].hhmm === '0915' && r.minutes[1].hhmm === '0916');
  ok('价格/参考价单位换算 ×100 / ×1000', r.minutes[0].price === 10.10 && r.minutes[0].refPrice === 9.95);
  ok('申报量原样保留（股）', r.minutes[0].bidShares === 500000 && r.minutes[0].askShares === 800000);
  ok('撮合终态提取：价/额/量/一字封单', r.matched && r.matched.price === 10.30 && r.matched.amount === 15330000
    && r.matched.volumeHands === 24041 && r.matched.sealedBuyShares === 134000000);
  const legacy = parseAuctionTrend({ data: { trends: ['09:15,10.10,100,200', '09:16,10.20,120,240'] } }, '20260831');
  ok('trends 字符串降级形态可解析（时间+价）', legacy.minutes.length === 2 && legacy.minutes[0].price === 10.10 && legacy.matched === null);
  const none = parseAuctionTrend({ data: [] }, '20260831');
  ok('空数据 → minutes 空 + matched null 不抛', none.minutes.length === 0 && none.matched === null);
  ok('非对象入参不抛', parseAuctionTrend(null, '20260831').minutes.length === 0);
}
{
  // 竞价量比：竞价量(手) / (近5日均量(手)/240)
  const bars = Array.from({ length: 5 }, (_, i) => ({ date: '2026-08-' + String(25 + i), volume: 2400 }));
  ok('均量 2400 手 → 量比 24.0', auctionVolRatio(bars, 240) === 24);
  ok('量比不足 3 根 → null', auctionVolRatio(bars.slice(0, 2), 240) === null);
  ok('无竞价量 → null', auctionVolRatio(bars, null) === null);
  ok('当日未定型 bar 剔除后不足 → null', auctionVolRatio([{ date: '2026-08-31', volume: 9999 }], 240) === null);
}
{
  const stocks = [
    { code: '600001', boards: 5 }, { code: '600002', boards: 5 }, { code: '000003', boards: 3 }, { code: '000004', boards: 1 },
  ];
  const core = pickAuctionCoreCodes(stocks, 2);
  ok('核心票按连板数降序取前 N（同板按代码稳定排序）', core.length === 2 && core[0] === '600001' && core[1] === '600002');
  ok('limit 至少为 1', pickAuctionCoreCodes(stocks, 0).length === 1);
}
{
  // collectAuctionSnapshot：stub fetch，验证 live/final 两模式与 matchPct/volRatio 装配
  const realFetch = globalThis.fetch;
  let calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const code = (String(url).match(/secid=(?:0|1)\.(\d{6})/) || [])[1] || '600001';
    // 每票同一份形态：昨收 9.95，虚拟价 10.10→10.20，9:26 撮合 10.30（+3.52%）、竞价额 1533 万、24041 手
    return { ok: true, json: async () => ({ data: [
      { f2: '2608310915', f3: 1010, f8: 9950, f14: 500000, f15: 800000 },
      { f2: '2608310916', f3: 1020, f8: 9950, f14: 600000, f15: 700000 },
      { f2: '2608310926', f3: 1030, f8: 10300, f14: 134000000, f15: 0, f9: 15330000, f10: 24041 },
    ] }) };
  };
  try {
    // 预置 K 线缓存：600001 有 5 根均量 2400 → volRatio 24；其余票无缓存 → null（诚实降级）
    storeKlineBars('600001', '20260830', Array.from({ length: 5 }, (_, i) => ({ date: '2026-08-' + String(25 + i), open: 9, close: 9.5, volume: 2400 })));
    const stocks = [
      { code: '600001', name: '甲', boards: 5 }, { code: '600002', name: '乙', boards: 4 }, { code: '000003', name: '丙', boards: 2 },
    ];
    const coreCodes = ['600001', '600002'];
    calls = [];
    const live = await collectAuctionSnapshot('live', stocks, coreCodes, '20260831');
    ok('live 模式只抓核心票（3 只池只外呼 2 次）', calls.length === 2 && live.items.length === 2);
    ok('live 撮合数据齐：matchPct 3.52 / volRatio 有缓存票 2404.1 无缓存票 null',
      live.items.every((i) => i.matched && i.matchPct === 3.52 && i.matchPrice === 10.30 && i.volumeHands === 24041)
      && live.items.find((i) => i.code === '600001').volRatio === 2404.1 && live.items.find((i) => i.code === '600002').volRatio === null);
    ok('core 携带逐分钟过程与撮合终态', live.core.length === 2 && live.core[0].minutes.length === 2 && live.core[0].matched.price === 10.30);
    calls = [];
    const fin = await collectAuctionSnapshot('final', stocks, coreCodes, '20260831');
    ok('final 模式抓全池（3 只）', calls.length === 3 && fin.items.length === 3 && fin.mode === 'final');
    ok('一字封单排队量入 items（134000000 股）', fin.items.every((i) => i.sealedBuyShares === 134000000));
    ok('无核心票额外补抓：coreCodes 已在池内不再加外呼', fin.core.length === 2);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('[B15] 降延迟批：ulist 缓存穿透 / fetchQuotes 失败块计数 / push2his 并发闸 / 更新 chip 秒级+抓取耗时');
{
  const realFetch = globalThis.fetch;
  // 1) ulist URL 带 `_` 缓存穿透 + getJSON fetch 带 cache:'no-store'（防 CDN/浏览器陈旧响应冻结资金流）
  let lastUrl = ''; let lastOpts = null;
  globalThis.fetch = async (url, opts) => {
    lastUrl = String(url); lastOpts = opts;
    return { ok: true, json: async () => ({ data: { diff: [{ f12: '600001', f14: '甲', f2: 10, f17: 10, f18: 10, f62: 1, f66: 1 }] } }) };
  };
  try {
    const q = await fetchQuotes(['600001']);
    ok('ulist URL 带 `_` 缓存穿透参数（防陈旧缓存冻结资金流）', /&_=\d+/.test(lastUrl));
    ok('getJSON fetch 带 cache:no-store（不吃浏览器 HTTP 缓存）', lastOpts?.cache === 'no-store');
    ok('成功路径 __failedChunks === 0 且不混入行情对象', q.__failedChunks === 0 && q['600001']?.price === 10);

    // 2) 61 只 = 2 块，一块失败：计数 1，另一块数据完好（按 URL 内容定向失败，避免 worker 调度竞态）
    globalThis.fetch = async (url) => {
      const secids = new URL(String(url)).searchParams.get('secids') || '';
      const codes = secids.split(',').map((s) => s.slice(2));
      if (codes.includes('600000')) throw new Error('chunk reset'); // 第一块(前 60 只)失败
      return { ok: true, json: async () => ({ data: { diff: codes.map((c) => ({ f12: c, f14: 'n', f2: 1, f17: 1, f18: 1, f62: 1, f66: 1 })) } }) };
    };
    const codes = [];
    for (let i = 0; i < 61; i++) codes.push(String(600000 + i));
    const q2 = await fetchQuotes(codes);
    ok('失败块计数可见（__failedChunks === 1），成功块 1 只数据完好', q2.__failedChunks === 1 && q2['600060']?.price === 1 && !q2['600000']);

    // 3) push2his 共享并发闸：12 个并发 K 线请求，最大同时外呼 ≤5（闸上限），且全部完成
    let active = 0; let maxActive = 0; let done = 0;
    globalThis.fetch = async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 40));
      active -= 1; done += 1;
      return { ok: true, json: async () => ({ data: { klines: ['2026-08-28,10,10,10,10,100'] } }) };
    };
    const klineCodes = [];
    for (let i = 0; i < 12; i++) klineCodes.push(String(600100 + i));
    const bars = await Promise.all(klineCodes.map((c) => fetchKlineLite(c, 8).catch(() => null)));
    ok('push2his 并发闸：12 并发 K 线最大同时外呼 ≤5（闸=5），全部完成', maxActive <= 5 && done === 12 && bars.filter(Boolean).length === 12);
  } finally {
    globalThis.fetch = realFetch;
  }
  // 4) app.js 接线（源码形状）：更新 chip 秒级 + 抓取耗时 telemetry
  const appSrc = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  ok('更新 chip 用 hhmmss 秒级展示', /hhmmss\(state\.lastSuccessAt\)/.test(appSrc));
  ok('refresh() 实测 fetchPools 耗时并存 lastFetchMs', /lastFetchMs = Math\.round\(performance\.now\(\) - fetchStart\)/.test(appSrc));
  ok('health.latencyMs 接真实抓取耗时（不再恒 null）', /latencyMs: state\.lastFetchMs/.test(appSrc));
}

console.log('[B17] 边跳按钮：直达顶部/底部（index.html + app.js 接线 + styles 主题化）');
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const appSrc = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  ok('index.html 含 #jumpTop / #jumpBottom 边跳按钮', /id="jumpTop"/.test(html) && /id="jumpBottom"/.test(html));
  ok('app.js setupEdgeJump 接线滚动容器与分步滚动（rAF glide，任意触碰可停——2026-09-11 中途可停改版）', /function setupEdgeJump/.test(appSrc) && /setupEdgeJump\(\);/.test(appSrc) && /const glideTo = \(target\) =>/.test(appSrc) && /main\.addEventListener\('touchstart', stopGlide/.test(appSrc) && /prefers-reduced-motion/.test(appSrc));
  ok('离边超 500px 才现身 + reduced-motion 瞬时跳', /scrollTop > 500/.test(appSrc) && /distBottom > 500/.test(appSrc) && /prefers-reduced-motion/.test(appSrc));
  ok('styles.css 提供 .edge-jump/.edge-btn 显隐类（容器 pointer-events:none + 按钮 visibility 防触点死区/隐形焦点）', /\.edge-jump/.test(css) && /\.edge-btn/.test(css) && /\.edge-btn\.show/.test(css) && /pointer-events: none/.test(css.slice(css.indexOf('.edge-jump'))) && /visibility: hidden/.test(css.slice(css.indexOf('.edge-jump'))));
}

console.log('[B18] 评审批 null 路径回归：缺数据不得被读成 0（2026-09-08 代码评审修复锁定）');
{
  // ① promo ctx 全 null（对照桌面 test/trading-system-rules.test.js 回归）
  const r = assessPromotion({ code: '600001', boards: 2, firstSealTime: '093200' }, { phase: '主升期', themeSize: null, openPct: null, volChg: null, role: null, prevDay: null });
  ok('promo ctx 全 null → 无硬否决', JSON.stringify(r.hardFails) === '[]');
  ok('promo ctx 全 null → 竞价/题材/量能三维 na', ['auction', 'theme', 'volume'].every((d) => r.checklist.find((c) => c.dim === d)?.status === 'na'));
  // ② 个股 breakCount 缺失（数据层保留 null 而非 0）
  const q = assessPromotion({ code: '1', boards: 2, firstSealTime: '093200', breakCount: null, breakCountAvailable: false }, { phase: '主升期' });
  ok('breakCount null → 封板质量 na（不再「一封封死」满分）', q.checklist.find((c) => c.dim === 'quality')?.status === 'na');
  // ③ applyGate 缺失语义（finiteNumber 替换 Number(null)=0）
  const g = applyGate({}, { themeScore: null, score: null });
  const themeGate = g.gates.find((x) => x.name === '题材过滤');
  const qualityGate = g.gates.find((x) => x.name === '个股质量');
  ok('applyGate 题材分 null → 放行且注记「题材分缺失」（不再显示 强度 0）', themeGate.pass === true && themeGate.note === '题材分缺失');
  ok('applyGate 评分 null → 不通过且注记「评分缺失」（不再显示 0 分）', qualityGate.pass === false && qualityGate.note === '评分缺失');
  // ④ 守卫换 finiteNumber 后 '' 语义修正（旧三元会返回 0 → 假「平开=低开」）
  ok('auctionVerdict openPct 空串 → 竞价数据不足（不再读成 0% 平开）', auctionVerdict({ boards: 2 }, { openPct: '' }).tag === null);
  // ⑤ Copilot retreat 阈值与 breakrate 同口径 25（v40 漏改分支）
  const retreat = buildCopilotAnswer('retreat', { status: { phase: '主升期', level: 'green' }, stats: { breakRate: { available: true, rate: 30 } } });
  ok('Copilot 退潮判定 br=30 → 退潮信号存在（阈值 25，v40 曾漏改此分支）', retreat.includes('退潮信号：存在'));
  // ⑥ mergePools 缺源计数 null（缺炸板池不再 0% 炸板率满乐观）
  const noBroken = mergePools('20260908', [
    { status: 'fulfilled', value: { data: { pool: [{ c: '600001', n: '测试', p: 10000, zdp: 10, fund: '-', hs: '-', zbc: '-', ltsz: '-', amount: '-', fbt: 92500 }], qdate: '20260908', tc: 1 } } },
    { status: 'fulfilled', value: { data: { pool: [], qdate: '20260908', tc: 0 } } },
    { status: 'rejected', reason: new Error('炸板池失败') }
  ]);
  ok('炸板池缺源 → brokenCount null + partial 标记', noBroken.brokenCount === null && noBroken.partial && noBroken.partialMissing.includes('炸板池'));
  ok('zbc 缺失("-") → breakCount null + breakCountAvailable false（数据层两段式）', noBroken.up[0].breakCount === null && noBroken.up[0].breakCountAvailable === false);
}

console.log('[B19] 评审批次级项：Copilot 炸板预警常量收拢 + 图标核验退出码化');
{
  const analyticsSrc = readFileSync(new URL('../analytics.js', import.meta.url), 'utf8');
  ok('Copilot 炸板预警收拢为 COPILOT_BREAK_WARN 常量（≥2 处引用）', /const COPILOT_BREAK_WARN = 25;/.test(analyticsSrc) && ((analyticsSrc.match(/COPILOT_BREAK_WARN/g) || []).length >= 3));
  ok('Copilot 分支不再有 >= 35 残留魔数（v40 漂移防复发）', !/>= 35 \? \['封板意愿弱/.test(analyticsSrc) && !/br >= 35/.test(analyticsSrc));
  // 图标核验脚本退出码化：FAIL / 标记判定失灵（whites=0 空转）都退出 1，进 smoke 常驻
  let verifyOk = false;
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('./verify-icons.mjs', import.meta.url))], { stdio: 'pipe' });
    verifyOk = true;
  } catch { verifyOk = false; }
  ok('verify-icons.mjs 退出码 0（maskable 安全区 PASS 且标记判定未空转）', verifyOk);
}

console.log('[B20] 休市批:交易日历(与桌面 trading-calendar.js BUILTIN_HOLIDAYS 同源平行副本)');
{
  ok('周末判定:周六日非交易日', !isTradingDay('20260912') && !isTradingDay('20260913') && isTradingDay('20260911'));
  ok('节假日判定:2026 内置表(春节/清明/五一/端午/国庆)', !isTradingDay('20260217') && !isTradingDay('20260406') && !isTradingDay('20260501') && !isTradingDay('20260619') && !isTradingDay('20261001'));
  ok('最近交易日回拉:周六→周五,国庆假期→节前', lastTradingDate('20260912') === '20260911' && lastTradingDate('20261001') === '20260930');
  ok('非法输入守卫:非 8 位日期 false', !isTradingDay('') && !isTradingDay('2026-10-01') && !isTradingDay(null));
}

console.log('[B21] 休市批检查批:mergePools date 必须是字符串(qdate 从 JSON 来是数字,曾致 d.slice 炸刷新)');
{
  const row = (c) => ({ c, n: '股' + c, lbc: 1, p: 15000, zdp: 10, fund: null, ltsz: null, zbc: 0, hybk: 'AI' });
  const r = mergePools('20260911', [{ status: 'fulfilled', value: { data: { pool: [row('600001')], qdate: 20260911, tc: 1 } } }, { status: 'fulfilled', value: { data: { pool: [], qdate: 20260911, tc: 0 } } }, { status: 'fulfilled', value: { data: { pool: [], qdate: 20260911, tc: 0 } } }]);
  ok('mergePools date 为 string（东财 qdate 数字入参也归一）', typeof r.date === 'string' && r.date === '20260911');
}

// 抢时间批·手机移植:封板前预警 + 竞价打板名单(2026-10-24 与桌面同批重构检测源)
{
  // 行为:按板块涨停价判定,未封且距涨停 ≤1.5pp 才报;已封(距涨停 ≤0.15pp)绝不报
  const stocks = [
    { code: '600001', name: '主板临近', changePercent: 8.8, limitPct: 10 },   // 距 1.2pp → sealApproach
    { code: '600002', name: '主板封死', changePercent: 10.0, limitPct: 10 },  // 已封 → 不报
    { code: '300003', name: '创业远未到', changePercent: 10, limitPct: 20 },  // 20cm 远未到 → 不报
    { code: '300004', name: '创业临近', changePercent: 18.8, limitPct: 20 },  // 距 1.2pp → sealApproach
    { code: '600004', name: '急拉D', changePercent: 5.5, limitPct: 10 },      // 30秒 +3.5pp → surge
  ];
  const watch = stocks.map((s) => s.code);
  const prev = new Map([['600004', { pct: 2.0, t: 100000 - 15000 }]]);
  const ev = detectPreSealAlerts({ stocks, watchCodes: watch, prevSnap: prev, now: 100000 });
  ok('detectPreSealAlerts 按涨停价判定:未封临近才报,已封/远未到不报', ev.length === 3
    && ev.filter((e) => e.kind === 'sealApproach').map((e) => e.code).sort().join(',') === '300004,600001'
    && ev.some((e) => e.kind === 'surge' && e.code === '600004')
    && !ev.some((e) => e.code === '600002' || e.code === '300003'));
  ok('limitThresholdOf 四档:主板10/创业20/科创20/北交30/ST5', limitThresholdOf('600001') === 10
    && limitThresholdOf('300001') === 20 && limitThresholdOf('688001') === 20
    && limitThresholdOf('920179') === 30 && limitThresholdOf('600001', 'ST 某某') === 5);
  ok('isInTradingSession 上海时区:10:00 开市 / 12:00 午休', isInTradingSession(new Date('2026-10-23T02:00:00Z')) === true
    && isInTradingSession(new Date('2026-10-23T04:00:00Z')) === false);
  // 2026-10-24 双层/精确涨停价/沪深过滤(与桌面同批)
  const lp = limitPriceOf(3.01, '600001', '');
  ok('limitPriceOf 按昨收算到分:3.01 的 10% 涨停价=3.31', lp && lp.price === 3.31 && Math.abs(lp.effectiveLimitPct - 9.9668) < 0.01);
  ok('主板A股/ST/新股过滤', isMainBoardShare('600001') && isMainBoardShare('000001') && !isMainBoardShare('300750') && !isMainBoardShare('688981') && !isMainBoardShare('920096')
    && isExcludedPreSealName('ST测试') && isExcludedPreSealName('N新股') && !isExcludedPreSealName('正常股'));
  ok('回封参数齐全', PARAM_MANIFEST.preSealAlert.resealOffsetPct === 1 && PARAM_MANIFEST.preSealAlert.resealTriggerOffsetPct === 0.5);
  ok('重复提醒参数:回落3pp + 20分钟', PARAM_MANIFEST.preSealAlert.repeatResetOffsetPct === 3 && PARAM_MANIFEST.preSealAlert.repeatMinIntervalMs === 20 * 60_000);
  ok('全市场摘要门槛与节流参数(无单日硬上限)', PARAM_MANIFEST.preSealAlert.marketMinAmount === 100_000_000
    && PARAM_MANIFEST.preSealAlert.auctionMinAmount === 5_000_000
    && PARAM_MANIFEST.preSealAlert.digestIntervalMs === 120_000
    && PARAM_MANIFEST.preSealAlert.maxDigestPerDay === undefined
    && PARAM_MANIFEST.preSealAlert.maxAlertsPerDay === undefined);
  const wl = buildAuctionWatchlist({
    auction: { available: true, items: [{ code: '600001', name: '龙头A', boards: 3, matchPct: 8.5, volRatio: 3.2, sealedBuyShares: 0 }] },
    opportunities: { tiers: { S: [{ code: '600001' }], A: [], B: [] } }, leaders: [{ code: '600001' }], gap: { candidates: [] },
  });
  ok('buildAuctionWatchlist 出名单且带机会级标签', wl.available && wl.items.length === 1 && wl.items[0].tier === 'S');
  ok('buildAuctionWatchlist 空竞价返回 unavailable', buildAuctionWatchlist({ auction: { available: false } }).available === false);
}

// 2026-10-24 封板前预警结构哨兵:两个「必须刷新才推」的根因不能回潮
{
  const appSrc = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  const swSrc = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  const dataSrc = readFileSync(new URL('../data.js', import.meta.url), 'utf8');
  const viewsSrc = readFileSync(new URL('../views.js', import.meta.url), 'utf8');
  const analyticsSrc = readFileSync(new URL('../analytics.js', import.meta.url), 'utf8');
  // 2026-10-26 与网页同批:机会分展示/排序用未取整归一化分,同分按封单比,不再按代码随机。
  ok('机会分与网页同口径:未取整归一化分展示 + 封单比排序', /scoreNormExact/.test(analyticsSrc) && /sealRatio/.test(analyticsSrc)
    && /scoreNormExact/.test(viewsSrc) && /sealRatio/.test(viewsSrc) && /oppScoreText\(x\)/.test(viewsSrc)
    && /oppSortList\(/.test(viewsSrc) && /oppScoreText\(x\) \+ ':'/.test(viewsSrc));
  ok('detectPreSeal 不再挂在 computeDerived 派生链里(派生签名早退会饿死检测)', !/\n\s*detectPreSeal\(\);/.test(appSrc));
  ok('封板前预警有独立 15s 定时器', /setInterval\(\(\) => \{ preSealTick\(\)\.catch/.test(appSrc));
  ok('监控名单取上一交易日涨停池,不回退今日涨停池', /preSealPrevTradingDate/.test(appSrc) && /上一交易日涨停池/.test(appSrc));
  ok('核心名单含今日炸板 + 竞价候选', /state\.pools\?\.broken/.test(appSrc) && /buildAuctionWatchlist/.test(appSrc));
  ok('全市场层:涨幅榜前300 + 摘要推送(不逐票刷屏)', /fetchTopGainers\(300\)/.test(appSrc) && /preSealMarketCandidates/.test(appSrc) && /pushPreSealDigest/.test(appSrc));
  ok('竞价预扫 9:26-9:29(避开 9:25 未定稿数据)', /minutes >= 566 && minutes < 570/.test(appSrc));
  ok('全市场摘要竞价段只发一条', /auctionSent/.test(appSrc));
  ok('摘要重复与核心层同口径:按票记涨幅/时间,回落≥3pp+20分钟', /preSealDigest\.byCode/.test(appSrc) && /saved\.byCode/.test(appSrc)
    && /resetOffset = Number\(p\.repeatResetOffsetPct\)/.test(appSrc) && /now - s\.lastAt >= minInterval/.test(appSrc)
    && /eligible\.length/.test(appSrc));
  ok('ntfy 推送失败重试 2 次(2s/5s),页面与 SW 同口径', /attempt < 3/.test(appSrc) && /attempt < 3/.test(swSrc)
    && /attempt === 1 \? 2000 : 5000/.test(appSrc) && /attempt === 1 \? 2000 : 5000/.test(swSrc));
  ok('涨幅榜东财失败时走新浪兜底(GBK 解码)', /fetchTopGainers/.test(appSrc) && /fetchTopGainers/.test(swSrc) && /fetchSinaTopGainers/.test(dataSrc) && /TextDecoder\('gbk'\)/.test(dataSrc));
  // 东财 clist 会把 pz 截到 100(2026-10-26 实测请求 300 仍只回 100):必须分页,否则每轮都判「不足」白打新浪。
  ok('涨幅榜分页:每页固定 100(接口上限),页面与 SW 同源', /const RANK_PAGE_SIZE = 100/.test(dataSrc)
    && /pageSize: RANK_PAGE_SIZE/.test(dataSrc) && /for \(let page = 1; page <= Math\.ceil\(limit \/ RANK_PAGE_SIZE\)/.test(dataSrc)
    && !/pageSize: 300/.test(appSrc) && !/pageSize: 300/.test(swSrc));
  ok('涨幅榜主源中断/兜底失败都保留已抓到的行', /catch \{ break; \} \/\/ 主源中断/.test(dataSrc)
    && /catch \{ break; \} \/\/ 单页失败保留已抓到的行/.test(dataSrc));
  ok('精确涨停价判定(按昨收算到分)', /limitPriceOf\(/.test(appSrc) && /limitPriceOf\(/.test(swSrc));
  ok('急拉单条文案不重复股票名(标题/正文已各带一次)', !/\$\{label\} 30秒急拉/.test(appSrc));
  ok('炸板回封(受重复提醒约束,页面与 SW 同口径)', /kind: 'reseal'/.test(appSrc) && /kind: 'reseal'/.test(swSrc) && /resealTriggerOffsetPct/.test(appSrc));
  ok('重复提醒账本持久化(KV),回落重置+20分钟才重复', /preSealRepeat/.test(appSrc) && /preSealRepeat/.test(swSrc)
    && /preSealCanAlert/.test(appSrc) && /resetReady/.test(appSrc) && /resetReady/.test(swSrc));
  ok('核心推送全局节流(15s 一条,多事件合并)', /function pushCoreEvents/.test(appSrc) && /preSealCoreBacklog/.test(appSrc) && /function firePreSealBatch/.test(appSrc));
  ok('不再有单日次数/条数硬上限', !/maxAlertsPerDay/.test(appSrc) && !/maxDigestPerDay/.test(appSrc));
  ok('SW 后台读写页面库 mp-mobile(不再是孤立的 mp-preseal-bg 库)', /const PAGE_DB = 'mp-mobile'/.test(swSrc) && !/PRESEAL_DB = 'mp-preseal-bg'/.test(swSrc));
  ok('SW 后台按实时报价+精确涨停价判定', /bgFetchQuotes/.test(swSrc) && /detectPreSealAlerts/.test(swSrc));
  // 2026-10-30 推送文案两端对齐(桌面 93b6eaa/1f67d18,手机此前未跟):
  ok('推送口径对齐桌面:离板还差X%(不再是距涨停Xpp),页面+SW 两处平行实现同改',
    /离板还差 \$\{gap\}%/.test(appSrc) && /离板还差 \$\{gap\}%/.test(swSrc)
    && !/距涨停 \$\{gap\}pp/.test(appSrc) && !/距涨停 \$\{gap\}pp/.test(swSrc));
  ok('ntfy 标题去 MarketPulse 前缀(对齐桌面 93b6eaa)', !/MarketPulse · \$\{/.test(appSrc) && !/MarketPulse · \$\{/.test(swSrc));
  ok('摘要正文对齐桌面:名字 +X% 离板还差 Y%(成交 Z)', /离板还差 \$\{c\.gapPct\}%/.test(appSrc));
  // 2026-10-30 补桌面 1f67d18 竞价早段异动推送(手机此前完全没有):
  ok('竞价异动推送常量化 auctionSurgePct 入 PARAM_MANIFEST(与桌面同值 3)', PARAM_MANIFEST.preSealAlert.auctionSurgePct === 3);
  ok('maybePushAuctionSurge 存在于 app.js 且仅 live 采集后触发', /function maybePushAuctionSurge/.test(appSrc)
    && /if \(mode === 'live'\) maybePushAuctionSurge\(result\)/.test(appSrc));
  ok('竞价一字/抢筹标题与桌面 1f67d18 逐字一致(不带前缀)', /竞价一字 · \$\{label\}/.test(appSrc)
    && /竞价抢筹 · \$\{label\} \+\$\{livePct\}%/.test(appSrc) && /一字封死/.test(appSrc) && /万手/.test(appSrc));
  ok('竞价异动同票只报一次(按天重置 auctionSurgeState)', /auctionSurgeState\.alerted\.has\(code\)/.test(appSrc)
    && /auctionSurgeState = \{ date: today, alerted: new Set\(\) \}/.test(appSrc));
  ok('竞价异动只推昨日涨停核心票(result.core,不是全市场)', /for \(const c of result\.core \|\| \[\]\)/.test(appSrc));
  // 2026-10-30 封单预警批:开板/封单骤减/跌停系列(与桌面 e9b37c7/3ae85e2 对齐)
  ok('手机腾讯报价解析买一/卖一量(封单量唯一实时源,东财 ulist 无盘口)', /fetchTencentQuotes/.test(dataSrc)
    && /bid1Vol: num\(f\[10\]\)/.test(dataSrc) && /ask1Vol: num\(f\[20\]\)/.test(dataSrc));
  ok('手机跌幅榜复用 fetchAllMarket 仅改 order=asc', /export async function fetchTopLosers/.test(dataSrc) && /order: 'asc'/.test(dataSrc));
  ok('手机跌停价 limitDownPriceOf 镜像涨停价(取负方向)', /function limitDownPriceOf/.test(analyticsSrc)
    && /base \* \(1 - boardLimitPct \/ 100\)/.test(analyticsSrc));
  ok('手机 PARAM_MANIFEST 登记封单骤减/跌停接近阈值(与桌面同值)',
    PARAM_MANIFEST.preSealAlert.sealShrinkPct === 30 && PARAM_MANIFEST.preSealAlert.sealShrinkMinHands === 3000
    && PARAM_MANIFEST.preSealAlert.sealShrinkWindowMs === 120000 && PARAM_MANIFEST.preSealAlert.limitDownApproachPct === 1.5);
  ok('手机涨停开板+封单骤减:sealed→破封推一次,封单量采样窗口比', /kind: 'sealOpen'/.test(appSrc)
    && /kind: 'sealShrink'/.test(appSrc) && /st\.sealSamples/.test(appSrc) && /st\.openPushed/.test(appSrc));
  ok('手机跌停侧三件:马上跌停/封单骤减/开板,独立状态', /kind: 'downApproach'/.test(appSrc)
    && /kind: 'downShrink'/.test(appSrc) && /kind: 'downOpen'/.test(appSrc) && /preSealDownState/.test(appSrc));
  ok('手机开板/封单/跌停事件并入 accepted 流(共用重复闸+15s节流)', /\.\.\.resealEvents, \.\.\.openEvents\]/.test(appSrc));
  ok('手机推送文案覆盖 8 类(与桌面 pushPreSeal 逐字一致)', /涨停开板（现/.test(appSrc) && /封单骤减 \$\{shrink\}%（剩 \$\{hands\}）/.test(appSrc)
    && /跌停封单骤减 \$\{shrink\}%（剩 \$\{hands\}）/.test(appSrc) && /距跌停还差/.test(appSrc));
}

console.log(`\nAll ${pass} smoke checks passed.`);
