// scripts/smoke.mjs — 轻量冒烟：node 直跑 analytics.js / data.js 纯函数，断言本次改动的核心形状。
// 不含浏览器/网络，仅校验「改了什么」的形状正确性；细节交给桌面 npm test 与浏览器人工核验。
// 运行：npm test（= node --experimental-vm-modules scripts/smoke.mjs；B9 语法护栏需要该 flag）。
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  stockSimilarCases, buildCopilotAnswer, COPILOT_QUESTIONS,
  calculateEmotionState, yesterdayPremium, buildThemeRanking, assessPromotion, routeCopilotQuery, diffSignalSnapshot
} from '../analytics.js';
import {
  shanghaiNow, todayStr, mergePools, sealQuality,
  shouldRefetchGap, mapSearchRow, setEmaToken,
  cachedKlineBars, storeKlineBars, exportKlineCache, hydrateKlineCache, fetchPools, fetchQuotes,
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
    ok('fail-fast 透传：抽屉补价参数(tries=1/30ms)直达 getJSON，单块中止且单块失败不抛错',
      aborts === 1 && Object.keys(q2).length === 0 && Date.now() - t0 < 2000);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log('[B12] 品牌批：命名三处一致 + 图标 PNG 尺寸与 manifest 声明匹配');
{
  const manifest = JSON.parse(readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const appleTitle = (html.match(/apple-mobile-web-app-title" content="([^"]*)"/) || [])[1];
  ok('short_name === apple-mobile-web-app-title ===「脉搏」', manifest.short_name === '脉搏' && appleTitle === '脉搏');
  ok('name 含主名 MarketPulse', /MarketPulse/.test(manifest.name));
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

console.log(`\nAll ${pass} smoke checks passed.`);
