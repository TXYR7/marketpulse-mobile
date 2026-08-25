// analytics.js — 纯函数版行情分析（移植自 D:\codex\analytics.js + strategies.js + portfolio-risk.js）
// 无任何 DOM / 网络依赖，全部确定性、rule-based，可在手机端直接计算。

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function hasNumericField(stock, field, availabilityField) {
  if (availabilityField && stock?.[availabilityField] === false) return false;
  return finiteNumber(stock?.[field]) !== null;
}

function parseSealTime(value) {
  const digits = String(value || '').replace(/\D/g, '').padStart(6, '0').slice(-6);
  if (!digits || digits === '000000') return null;
  const hour = Number(digits.slice(0, 2));
  const minute = Number(digits.slice(2, 4));
  const second = Number(digits.slice(4, 6));
  if (hour > 23 || minute > 59 || second > 59) return null;
  return hour * 3600 + minute * 60 + second;
}

/* ---------- 炸板率 ---------- */
function calculateBreakRate({ limitUpCount, brokenCount, available, previousRate = null }) {
  const sealedCount = finiteNumber(limitUpCount);
  const failedCount = finiteNumber(brokenCount);
  if (!available || sealedCount === null || failedCount === null) {
    return { available: false, sealedCount, brokenCount: null, denominator: null, rate: null, change: null, trend: null, alert: false, message: '数据源未提供炸板池统计' };
  }
  const denominator = sealedCount + failedCount;
  const rate = denominator ? round(failedCount / denominator * 100) : 0;
  const oldRate = finiteNumber(previousRate);
  const change = oldRate === null ? null : round(rate - oldRate);
  const trend = change === null ? null : change >= 3 ? 'up' : change <= -3 ? 'down' : 'flat';
  const alert = rate >= 30 || (change !== null && change >= 10);
  return { available: true, sealedCount, brokenCount: failedCount, denominator, rate, change, trend, alert, message: alert ? '市场封板质量快速下降' : '封板质量处于可观察区间' };
}

/* ---------- 连板梯队 ---------- */
function buildLimitUpLadder(stocks = []) {
  const groups = new Map();
  for (const stock of stocks) {
    const board = Math.max(1, Math.trunc(finiteNumber(stock.boards) || 1));
    if (!groups.has(board)) groups.set(board, []);
    groups.get(board).push(stock);
  }
  const total = stocks.length;
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([board, group]) => ({
    board,
    label: board === 1 ? '首板' : `${board}板`,
    count: group.length,
    ratio: total ? round(group.length / total, 4) : 0,
    stocks: [...group].sort((a, b) => {
      const aTime = String(a.firstSealTime || '999999');
      const bTime = String(b.firstSealTime || '999999');
      return aTime.localeCompare(bTime) || (finiteNumber(b.sealAmount) || 0) - (finiteNumber(a.sealAmount) || 0) || String(a.code).localeCompare(String(b.code));
    })
  }));
}

/* ---------- 题材强度 ---------- */
function summarizeTheme(stocks) {
  const gains = stocks.map((stock) => finiteNumber(stock.changePercent ?? parseFloat(stock.gain))).filter((value) => value !== null);
  const sealValues = stocks.filter((stock) => hasNumericField(stock, 'sealAmount', 'sealAmountAvailable')).map((stock) => finiteNumber(stock.sealAmount));
  const totalSealAmount = sealValues.length ? sealValues.reduce((sum, value) => sum + value, 0) : null;
  const limitUpCount = stocks.length;
  const multiBoardCount = stocks.filter((stock) => (finiteNumber(stock.boards) || 1) > 1).length;
  const maxBoard = stocks.reduce((max, stock) => Math.max(max, finiteNumber(stock.boards) || 1), 0);
  const breadthScore = Math.min(40, limitUpCount * 4);
  const multiBoardScore = Math.min(25, multiBoardCount * 5);
  const heightScore = Math.min(20, maxBoard * 4);
  const sealScore = totalSealAmount === null ? 0 : Math.min(15, Math.sqrt(Math.max(0, totalSealAmount) / 100_000_000) * 4);
  return {
    limitUpCount, multiBoardCount, maxBoard,
    averageGain: gains.length ? round(gains.reduce((sum, value) => sum + value, 0) / gains.length, 2) : null,
    totalSealAmount,
    score: round(Math.min(100, breadthScore + multiBoardScore + heightScore + sealScore))
  };
}

function groupThemes(stocks = []) {
  const groups = new Map();
  for (const stock of stocks) {
    const name = String(stock.industry || '未分类').trim() || '未分类';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(stock);
  }
  return groups;
}

function buildThemeRanking(stocks = [], previousStocks = []) {
  const currentGroups = groupThemes(stocks);
  const previousGroups = groupThemes(previousStocks);
  const previousAvailable = previousStocks.length > 0;
  const themes = [];
  for (const [name, group] of currentGroups) {
    const summary = summarizeTheme(group);
    const previousSummary = previousGroups.has(name) ? summarizeTheme(previousGroups.get(name)) : null;
    const scoreChange = previousAvailable ? round(summary.score - (previousSummary?.score || 0)) : null;
    const direction = scoreChange === null ? null : scoreChange >= 5 ? 'up' : scoreChange <= -5 ? 'down' : 'flat';
    const leaders = [...group].sort((a, b) => (finiteNumber(b.boards) || 1) - (finiteNumber(a.boards) || 1) || (finiteNumber(b.sealAmount) || 0) - (finiteNumber(a.sealAmount) || 0)).slice(0, 3).map((stock) => stock.code);
    themes.push({ name, ...summary, direction, scoreChange, leaders });
  }
  return themes.sort((a, b) => b.score - a.score || b.limitUpCount - a.limitUpCount || a.name.localeCompare(b.name, 'zh-CN'));
}

/* ---------- 核心龙头 ---------- */
function leaderScore(stock, theme, themeRank) {
  let earned = 0;
  let possible = 75;
  const boards = Math.max(1, finiteNumber(stock.boards) || 1);
  const coordinationScore = Math.min(5, Math.max(1, finiteNumber(stock.coordination) || finiteNumber(stock.themeSize) || 1));
  earned += Math.min(35, boards * 7);
  earned += Math.min(20, (finiteNumber(theme?.score) || 0) * 0.2);
  earned += themeRank === 1 ? 15 : themeRank === 2 ? 10 : Math.max(2, 8 - themeRank);
  earned += coordinationScore;
  const breakdown = {
    height: round(Math.min(35, boards * 7)),
    theme: round(Math.min(20, (finiteNumber(theme?.score) || 0) * 0.2)),
    position: themeRank === 1 ? 15 : themeRank === 2 ? 10 : Math.max(2, 8 - themeRank),
    coordination: round(coordinationScore),
    turnover: null, seal: null, firstSeal: null, breaks: null
  };
  if (hasNumericField(stock, 'turnoverRate', 'turnoverRateAvailable')) {
    possible += 8;
    const turnover = finiteNumber(stock.turnoverRate);
    breakdown.turnover = turnover >= 1.5 && turnover <= 12 ? 8 : turnover <= 20 ? 5 : 2;
    earned += breakdown.turnover;
  }
  if (hasNumericField(stock, 'sealAmount', 'sealAmountAvailable') && hasNumericField(stock, 'circulatingValue', 'circulatingValueAvailable') && finiteNumber(stock.circulatingValue) > 0) {
    possible += 10;
    const ratio = finiteNumber(stock.sealAmount) / finiteNumber(stock.circulatingValue) * 100;
    breakdown.seal = round(Math.min(10, Math.max(0, ratio) * 2));
    earned += breakdown.seal;
  }
  const sealTime = stock.firstSealTimeAvailable === false ? null : parseSealTime(stock.firstSealTime);
  if (sealTime !== null) {
    possible += 7;
    breakdown.firstSeal = sealTime <= 9 * 3600 + 35 * 60 ? 7 : sealTime <= 10 * 3600 ? 5 : sealTime <= 11 * 3600 ? 3 : 1;
    earned += breakdown.firstSeal;
  }
  if (hasNumericField(stock, 'breakCount', 'breakCountAvailable')) {
    possible += 5;
    breakdown.breaks = round(Math.max(0, 5 - finiteNumber(stock.breakCount) * 1.5));
    earned += breakdown.breaks;
  }
  return { score: round(possible ? earned / possible * 100 : 0), confidence: Math.round(possible), breakdown, weights: { height: 35, theme: 20, position: 15, coordination: 5, turnover: 8, seal: 10, firstSeal: 7, breaks: 5 } };
}

function rankCoreLeaders(stocks = [], themes = []) {
  const themeByName = new Map(themes.map((theme) => [theme.name, theme]));
  const themeGroups = groupThemes(stocks);
  const ranks = new Map();
  for (const [name, group] of themeGroups) {
    const ordered = [...group].sort((a, b) => (finiteNumber(b.boards) || 1) - (finiteNumber(a.boards) || 1) || (finiteNumber(b.sealAmount) || 0) - (finiteNumber(a.sealAmount) || 0) || String(a.code).localeCompare(String(b.code)));
    ordered.forEach((stock, index) => ranks.set(stock.code, { rank: index + 1, size: ordered.length, name }));
  }
  const scored = stocks.map((stock) => {
    const themePosition = ranks.get(stock.code) || { rank: 1, size: 1, name: stock.industry || '未分类' };
    const theme = themeByName.get(themePosition.name);
    return { ...stock, themeName: themePosition.name, themeRank: themePosition.rank, themeSize: themePosition.size, themeScore: theme?.score ?? null, ...leaderScore(stock, theme, themePosition.rank) };
  }).sort((a, b) => b.score - a.score || (finiteNumber(b.boards) || 1) - (finiteNumber(a.boards) || 1) || String(a.code).localeCompare(String(b.code)));
  return scored.slice(0, 30).map((stock, index) => {
    let role = '后排';
    if (index === 0) role = '市场总龙头';
    else if (stock.themeRank === 1 && stock.themeSize >= 2) role = '板块龙头';
    else if (stock.themeRank === 2 && stock.themeSize >= 3) role = '板块中军';
    else if ((finiteNumber(stock.boards) || 1) > 1 || stock.themeSize >= 4) role = '跟风';
    return { ...stock, role };
  });
}

/* ---------- 晋级率 ---------- */
function calculatePromotionStats(previousStocks, currentStocks) {
  if (!previousStocks?.length || !currentStocks?.length) return { available: false, reason: '缺少相邻交易日快照', byBoard: [], overall: null };
  const currentByCode = new Map(currentStocks.map((stock) => [stock.code, stock]));
  const groups = new Map();
  previousStocks.forEach((stock) => {
    const board = Number(stock.boards || 1);
    const current = currentByCode.get(stock.code);
    const promoted = Boolean(current && Number(current.boards || 1) === board + 1);
    if (!groups.has(board)) groups.set(board, { board, denominator: 0, promoted: 0 });
    const group = groups.get(board);
    group.denominator += 1;
    if (promoted) group.promoted += 1;
  });
  const byBoard = [...groups.values()].sort((a, b) => a.board - b.board).map((group) => ({ ...group, rate: group.denominator ? Number((group.promoted / group.denominator * 100).toFixed(1)) : 0 }));
  const denominator = byBoard.reduce((sum, group) => sum + group.denominator, 0);
  const promoted = byBoard.reduce((sum, group) => sum + group.promoted, 0);
  return { available: true, byBoard, overall: { promoted, denominator, rate: denominator ? Number((promoted / denominator * 100).toFixed(1)) : 0 } };
}

// snapshots: { 'YYYYMMDD': { stocks: [...] }, ... }
function calculateRollingPromotion(snapshots, windowSize = 20) {
  const dates = Object.keys(snapshots || {}).sort();
  if (dates.length < 2) return { available: false, sessions: 0, promoted: 0, denominator: 0, rate: null };
  const pairs = [];
  for (let index = 1; index < dates.length; index += 1) {
    const previous = snapshots[dates[index - 1]]?.stocks;
    const current = snapshots[dates[index]]?.stocks;
    const result = calculatePromotionStats(previous, current);
    if (result.available && result.overall) pairs.push(result.overall);
  }
  const selected = pairs.slice(-windowSize);
  const denominator = selected.reduce((sum, item) => sum + item.denominator, 0);
  const promoted = selected.reduce((sum, item) => sum + item.promoted, 0);
  return { available: Boolean(selected.length), sessions: selected.length, promoted, denominator, rate: denominator ? Number((promoted / denominator * 100).toFixed(1)) : null };
}

// 模式监控：按买点模式聚合近 windowFull 对交易日的晋级率，并对比近 windowRecent 对
function aggregateModeRates(pairResults = [], windowRecent = 5) {
  const acc = new Map();
  const MODE_BY_BOARD = { 1: '一进二', 2: '二进三', 3: '三进四' };
  const modeKey = (board) => MODE_BY_BOARD[Number(board)] || '高位加速';
  pairResults.forEach((byBoard, index) => {
    const inRecent = pairResults.length - index <= windowRecent;
    for (const group of byBoard || []) {
      const key = modeKey(group.board);
      if (!acc.has(key)) acc.set(key, { mode: key, full: { denominator: 0, promoted: 0 }, recent: { denominator: 0, promoted: 0 } });
      const entry = acc.get(key);
      const bucket = inRecent ? entry.recent : entry.full;
      bucket.denominator += Number(group.denominator || 0);
      bucket.promoted += Number(group.promoted || 0);
    }
  });
  const ratioOf = (bucket) => bucket.denominator ? Number((bucket.promoted / bucket.denominator * 100).toFixed(1)) : null;
  const modes = [...acc.values()].map((entry) => {
    const rateFull = ratioOf(entry.full);
    const rateRecent = ratioOf(entry.recent);
    let trend = 'stable', alert = false, message = '';
    if (entry.recent.denominator < 3) { trend = 'low_sample'; message = '近期样本不足'; }
    else if (rateRecent >= rateFull + 5) trend = 'improving';
    else if (rateRecent <= rateFull - 10 || rateRecent < 25) { trend = 'declining'; alert = true; message = `近期明显弱化（${rateRecent}% vs ${rateFull}%）`; }
    return { mode: entry.mode, samplesFull: entry.full.denominator, rateFull, samplesRecent: entry.recent.denominator, rateRecent, trend, alert, message };
  }).sort((a, b) => a.mode.localeCompare(b.mode, 'zh-CN'));
  return { available: Boolean(pairResults.length), windowLabel: `近 ${pairResults.length} 对交易日 vs 近 ${Math.min(windowRecent, pairResults.length)} 对`, modes };
}

function buildModeMonitor(snapshots, windowFull = 20, windowRecent = 5) {
  const dates = Object.keys(snapshots || {}).sort();
  const pairs = [];
  for (let i = 1; i < dates.length; i += 1) {
    const prev = snapshots[dates[i - 1]]?.stocks;
    const cur = snapshots[dates[i]]?.stocks;
    const r = calculatePromotionStats(prev, cur);
    if (r.available && r.byBoard.length) pairs.push(r.byBoard);
  }
  return aggregateModeRates(pairs.slice(-windowFull), windowRecent);
}

/* ---------- 情绪驾驶舱 ---------- */
function indicator(key, label, value, status, available = true) {
  return { key, label, value: available ? value : null, status: available ? status : 'unavailable', available };
}

function calculateEmotionState(input) {
  const limitUp = finiteNumber(input.limitUpCount);
  const limitDown = finiteNumber(input.limitDownCount);
  const multiBoard = finiteNumber(input.multiBoardCount);
  const maxBoard = finiteNumber(input.maxBoard);
  const breakRate = input.breakRate?.available ? finiteNumber(input.breakRate.rate) : null;
  const firstPromotion = finiteNumber(input.firstBoardPromotionRate);
  const multiPromotion = finiteNumber(input.multiBoardPromotionRate);
  const availableCount = [limitUp, limitDown, multiBoard, maxBoard, breakRate, firstPromotion, multiPromotion].filter((value) => value !== null).length;
  const confidence = Math.round(availableCount / 7 * 100);
  const indicators = [
    indicator('limitUp', '涨停家数', limitUp, limitUp >= 80 ? 'green' : limitUp >= 40 ? 'yellow' : 'red', limitUp !== null),
    indicator('limitDown', '跌停家数', limitDown, limitDown <= 10 ? 'green' : limitDown <= 20 ? 'yellow' : 'red', limitDown !== null),
    indicator('multiBoard', '连板家数', multiBoard, multiBoard >= 20 ? 'green' : multiBoard >= 10 ? 'yellow' : 'red', multiBoard !== null),
    indicator('maxBoard', '最高板', maxBoard, maxBoard >= 5 ? 'green' : maxBoard >= 3 ? 'yellow' : 'red', maxBoard !== null),
    indicator('breakRate', '炸板率', breakRate, breakRate <= 20 ? 'green' : breakRate <= 35 ? 'yellow' : 'red', breakRate !== null),
    indicator('firstPromotion', '首板晋级率', firstPromotion, firstPromotion >= 35 ? 'green' : firstPromotion >= 20 ? 'yellow' : 'red', firstPromotion !== null),
    indicator('multiPromotion', '连板晋级率', multiPromotion, multiPromotion >= 45 ? 'green' : multiPromotion >= 25 ? 'yellow' : 'red', multiPromotion !== null)
  ];
  const availableIndicators = indicators.filter((item) => item.available);
  const emotionIndex = availableIndicators.length ? Math.round(availableIndicators.reduce((sum, item) => sum + ({ green: 100, yellow: 60, red: 20, unavailable: 0 }[item.status] || 0), 0) / availableIndicators.length) : null;

  if (availableCount < 4 || limitUp === null || multiBoard === null || maxBoard === null) {
    return { available: false, phase: '数据不足', level: 'yellow', advice: '等待关键行情字段恢复后再判断市场阶段', reasons: ['可用指标不足，系统未强行情绪周期'], confidence, emotionIndex, indicators };
  }

  const previousMax = finiteNumber(input.previousMaxBoard);
  const previousMulti = finiteNumber(input.previousMultiBoardCount);
  const heightCollapse = previousMax !== null && previousMulti !== null && previousMax - maxBoard >= 2 && multiBoard <= previousMulti * 0.7;
  const breakSurge = input.breakRate?.available && ((breakRate >= 30) || finiteNumber(input.breakRate.change) >= 10);
  const promotionWeak = multiPromotion !== null && multiPromotion < 30;
  let phase, level, advice;
  const reasons = [];

  if ((limitUp <= 20 && maxBoard <= 2 && multiBoard <= 5) || (limitDown !== null && limitUp <= 30 && limitDown >= 15)) {
    phase = '冰点'; level = 'red'; advice = '等待修复，减少主动交易';
    reasons.push(`涨停仅 ${limitUp} 家`, `连板 ${multiBoard} 家、最高 ${maxBoard} 板`);
    if (limitDown !== null) reasons.push(`跌停 ${limitDown} 家`);
  } else if ((limitDown !== null && limitDown >= 15 && limitUp < 60) || breakRate >= 40 || heightCollapse) {
    phase = '退潮初期'; level = 'red'; advice = '控制仓位，回避高位后排';
    if (limitDown !== null && limitDown >= 15) reasons.push(`跌停增至 ${limitDown} 家`);
    if (breakRate >= 40) reasons.push(`炸板率达到 ${breakRate}%`);
    if (heightCollapse) reasons.push('连板高度与连板家数同步下降');
  } else if (limitUp >= 80 && (breakSurge || promotionWeak)) {
    phase = '高潮转分歧'; level = 'yellow'; advice = '去弱留强，聚焦辨识度核心';
    reasons.push(`涨停仍有 ${limitUp} 家`);
    if (breakSurge) reasons.push(input.breakRate.change >= 10 ? `炸板率上升 ${input.breakRate.change} 个百分点` : `炸板率升至 ${breakRate}%`);
    if (promotionWeak) reasons.push(`连板晋级率降至 ${multiPromotion}%`);
  } else if (limitUp >= 120 && maxBoard >= 5 && multiBoard >= 25 && (breakRate === null || breakRate < 30)) {
    phase = '高潮'; level = 'yellow'; advice = '去弱留强，防范一致性后的分歧';
    reasons.push(`涨停 ${limitUp} 家`, `连板 ${multiBoard} 家`, `最高 ${maxBoard} 板`);
  } else if (limitUp >= 80 && maxBoard >= 4 && multiBoard >= 15 && (limitDown === null || limitDown <= 10) && (breakRate === null || breakRate <= 22) && (multiPromotion === null || multiPromotion >= 40)) {
    phase = '主升期'; level = 'green'; advice = '可提高关注度，优先核心与强题材';
    reasons.push(`涨停 ${limitUp} 家、跌停 ${limitDown ?? '暂无'} 家`, `连板 ${multiBoard} 家、最高 ${maxBoard} 板`);
    if (breakRate !== null) reasons.push(`炸板率 ${breakRate}%`);
  } else {
    phase = '分歧期'; level = 'yellow'; advice = '聚焦核心，减少后排和一致性追涨';
    reasons.push(`涨停 ${limitUp} 家`, `连板 ${multiBoard} 家、最高 ${maxBoard} 板`);
    if (breakRate !== null) reasons.push(`炸板率 ${breakRate}%`);
    if (multiPromotion !== null) reasons.push(`连板晋级率 ${multiPromotion}%`);
  }
  return { available: true, phase, level, advice, reasons, confidence, emotionIndex, indicators };
}

/* ---------- 机会评分 ---------- */
const RULES = {
  rolePoints: { '市场总龙头': 20, '板块龙头': 16, '板块中军': 12, '跟风': 7, '后排': 3 },
  themeFactor: 0.2, themeCap: 20, heightPointsPerBoard: 3, heightCap: 15,
  sealPointsPerStar: 3, sealCap: 15,
  turnoverGood: 10, turnoverMid: 6, turnoverOther: 2,
  breakMaxPoints: 10, breakPointsPerCount: 3,
  modeAllowed: 10, modeForbidden: 2, modeOther: 5,
  elim: { breakCountTooMany: 4, weakRearThemeBelow: 25, weakRearBoard: 1, turnoverOverheat: 25, themeBelow: 15, highBoardBreak: 6 },
  tier: { sScore: 85, aScore: 75, aCoreScore: 70, bScore: 60 }
};

const PHASE_STRATEGY = {
  '冰点': { allowed: ['首板', '龙头反包'], forbidden: ['高位加速', '二进三'], advice: '等待修复，减少主动交易' },
  '修复': { allowed: ['首板', '一进二', '二进三', '板块核心'], forbidden: ['高位加速'], advice: '轻仓试错，聚焦修复方向低位' },
  '主升期': { allowed: ['一进二', '二进三', '三进四', '高位加速', '板块核心'], forbidden: [], advice: '可积极打板，优先核心与强题材' },
  '高潮': { allowed: ['板块核心', '三进四'], forbidden: ['高位加速', '后排', '随机首板'], advice: '去弱留强，防范一致性后的分歧' },
  '高潮转分歧': { allowed: ['分歧回封', '板块核心', '弱转强'], forbidden: ['后排接力', '高位跟风', '随机首板'], advice: '去弱留强，聚焦辨识度核心' },
  '分歧期': { allowed: ['分歧回封', '板块核心', '弱转强'], forbidden: ['后排接力', '高位跟风', '随机首板'], advice: '聚焦核心，减少后排和一致性追涨' },
  '退潮初期': { allowed: ['分歧回封', '板块核心'], forbidden: ['高位加速', '后排', '一进二'], advice: '控制仓位，回避高位后排' },
  '退潮': { allowed: ['分歧回封', '板块核心'], forbidden: ['高位加速', '后排', '一进二'], advice: '防守为主，等待冰点后的修复' }
};

const PHASE_NAMES = ['冰点', '退潮初期', '修复', '修复', '分歧期', '主升期', '高潮'];

function phaseStrategy(phase) {
  return PHASE_STRATEGY[phase] || { allowed: [], forbidden: [], advice: '阶段未知，按分歧对待' };
}

function computeOpportunityScore(stock, ctx = {}) {
  const role = ctx.role || '后排';
  const buyType = ctx.buyType || stock.buyType || '首板';
  const boards = Math.max(1, finiteNumber(stock.boards) || 1);
  const themeScore = finiteNumber(ctx.themeScore);
  const sealStars = finiteNumber(stock.sealStars);
  const turnoverRate = finiteNumber(stock.turnoverRate);
  const breakCount = finiteNumber(stock.breakCount) ?? 0;
  const strategy = phaseStrategy(ctx.phase);

  const breakdown = {};
  const plus = [];
  const minus = [];

  const rolePoints = RULES.rolePoints[role] ?? 3;
  breakdown.role = rolePoints;
  if (role === '市场总龙头') plus.push('市场总龙头');
  else if (role === '板块龙头') plus.push('板块龙头');

  const themePoints = Math.min(RULES.themeCap, (themeScore ?? 0) * RULES.themeFactor);
  breakdown.theme = round(themePoints);
  if (themeScore !== null && themeScore >= 80) plus.push('板块强度强');
  else if (themeScore !== null && themeScore < 30) minus.push('板块强度弱');

  const heightPoints = Math.min(RULES.heightCap, boards * RULES.heightPointsPerBoard);
  breakdown.height = heightPoints;
  if (boards >= 4) plus.push(`高度 ${boards} 板`);

  const sealPoints = sealStars === null ? 0 : Math.min(RULES.sealCap, sealStars * RULES.sealPointsPerStar);
  breakdown.seal = sealPoints;
  if (sealStars !== null && sealStars >= 5) plus.push('封单极强');
  else if (sealStars !== null && sealStars <= 2) minus.push('封单偏弱');

  const turnoverPoints = turnoverRate === null ? 0 : turnoverRate >= 1.5 && turnoverRate <= 12 ? RULES.turnoverGood : turnoverRate <= 20 ? RULES.turnoverMid : RULES.turnoverOther;
  breakdown.turnover = turnoverPoints;
  if (turnoverPoints === RULES.turnoverGood) plus.push('换手良性');
  else if (turnoverPoints === RULES.turnoverOther) minus.push('换手异常');

  const breakPoints = Math.max(0, RULES.breakMaxPoints - breakCount * RULES.breakPointsPerCount);
  breakdown.breaks = breakPoints;
  if (breakCount > 0) minus.push(`炸板 ${breakCount} 次`);
  else plus.push('未炸板');

  const modePoints = strategy.allowed.includes(buyType) ? RULES.modeAllowed : strategy.forbidden.includes(buyType) ? RULES.modeForbidden : RULES.modeOther;
  breakdown.mode = modePoints;
  if (strategy.allowed.includes(buyType)) plus.push(`买点「${buyType}」契合当前阶段`);
  else if (strategy.forbidden.includes(buyType)) minus.push(`买点「${buyType}」当前阶段不适用`);

  const score = Math.max(0, Math.min(100, Math.round(rolePoints + themePoints + heightPoints + sealPoints + turnoverPoints + breakPoints + modePoints)));

  const elim = [];
  if (breakCount >= RULES.elim.breakCountTooMany) elim.push(`炸板次数过多（${breakCount} 次）`);
  if (role === '后排' && themeScore !== null && themeScore < RULES.elim.weakRearThemeBelow && boards === RULES.elim.weakRearBoard) elim.push('后排 & 板块弱');
  if (turnoverRate !== null && turnoverRate > RULES.elim.turnoverOverheat && (role === '跟风' || role === '后排')) elim.push('换手过度');
  if (themeScore !== null && themeScore < RULES.elim.themeBelow) elim.push('板块强度弱');
  if (boards >= RULES.elim.highBoardBreak && (finiteNumber(stock.breakCount) ?? 0) >= 1) elim.push('高位分歧');

  let tier;
  if (elim.length) tier = '淘汰';
  else if (score >= RULES.tier.sScore && (role === '市场总龙头' || role === '板块龙头')) tier = 'S';
  else if (score >= RULES.tier.aScore || (score >= RULES.tier.aCoreScore && (role === '市场总龙头' || role === '板块龙头'))) tier = 'A';
  else if (score >= RULES.tier.bScore) tier = 'B';
  else { tier = '淘汰'; elim.push('综合得分偏低'); }
  const weights = { role: rolePoints, theme: RULES.themeCap, height: RULES.heightCap, seal: RULES.sealCap, turnover: RULES.turnoverGood, breaks: RULES.breakMaxPoints, mode: RULES.modeAllowed };
  return { score, tier, reasons: { plus, minus, elim }, breakdown, weights };
}

function rankOpportunities(stocks = [], ctx = {}) {
  const roleByCode = new Map((ctx.leaders || []).map((leader) => [leader.code, leader.role]));
  const themeByName = new Map((ctx.themes || []).map((theme) => [theme.name, theme]));
  const groups = groupThemes(stocks);
  const ranked = stocks.map((stock) => {
    const themeName = stock.industry || '未分类';
    const theme = themeByName.get(themeName);
    const role = roleByCode.get(stock.code) || (groups.get(themeName)?.length === 1 ? '板块龙头' : '跟风');
    const result = computeOpportunityScore(stock, { role, themeScore: theme?.score ?? null, themeName, buyType: stock.buyType, phase: ctx.phase });
    const themeSize = groups.get(themeName)?.length || 0;
    return { ...stock, role, themeName, themeScore: theme?.score ?? null, themeSize, ...result };
  });
  const tiers = { S: [], A: [], B: [] };
  const eliminated = [];
  const ordered = ranked.sort((a, b) => b.score - a.score || (finiteNumber(b.boards) || 1) - (finiteNumber(a.boards) || 1) || String(a.code).localeCompare(String(b.code)));
  for (const item of ordered) {
    if (item.tier === 'S') tiers.S.push(item);
    else if (item.tier === 'A') tiers.A.push(item);
    else if (item.tier === 'B') tiers.B.push(item);
    else eliminated.push(item);
  }
  return { tiers, eliminated, available: Boolean(stocks.length) };
}

/* ---------- 买点分类 ---------- */
function buyTypeOf({ boards, previousBoard = null, breakCount = 0, previousDay2Board = null } = {}) {
  const current = Math.max(1, Number(boards) || 1);
  const prev = previousBoard === null || previousBoard === undefined ? null : Math.max(1, Number(previousBoard) || 1);
  const older = previousDay2Board === null || previousDay2Board === undefined ? null : Math.max(1, Number(previousDay2Board) || 1);
  const breaks = Number(breakCount) || 0;
  if (prev !== null) {
    if (current === prev + 1) {
      if (prev === 1) return '一进二';
      if (prev === 2) return '二进三';
      if (prev === 3) return '三进四';
      return '高位加速';
    }
    if (current === prev) {
      if (older !== null && older >= 2 && breaks > 0) return '弱转强';
      return breaks > 0 ? '分歧回封' : '续板';
    }
    return '退潮修复';
  }
  if (older !== null && older >= 2) return '龙头反包';
  if (older !== null) return '断板重来';
  return current === 1 ? '首板' : '新进梯队';
}

/* ---------- 竞价预期差 ---------- */
const EXPECTATION_RULES = {
  baseByBuyType: { '首板': 2.0, '一进二': 3.5, '二进三': 4.5, '三进四': 5.5, '高位加速': 6.5, '分歧回封': 3.0 },
  themeFactor: 0.2, themeCap: 2,
  roleAdjust: { '市场总龙头': 2, '板块龙头': 2, '板块中军': 1, '跟风': 0, '后排': -1.5 },
  phaseAdjust: { '主升期': 1, '修复': 0.5, '高潮': 0, '高潮转分歧': 0, '分歧期': 0, '退潮初期': -2, '退潮': -2, '冰点': -2.5 },
  band: 1.5, clamp: [0, 10]
};
function continuationMode(board) {
  const value = Number(board) || 1;
  if (value === 1) return '一进二';
  if (value === 2) return '二进三';
  if (value === 3) return '三进四';
  return '高位加速';
}
function expectedGapOf(stock, ctx = {}) {
  const buyType = ctx.buyType || continuationMode(stock.boards);
  const base = EXPECTATION_RULES.baseByBuyType[buyType] ?? 2;
  const themeScore = finiteNumber(ctx.themeScore) ?? 0;
  const themeDelta = Math.max(-EXPECTATION_RULES.themeCap, Math.min(EXPECTATION_RULES.themeCap, themeScore * EXPECTATION_RULES.themeFactor));
  const roleDelta = EXPECTATION_RULES.roleAdjust[ctx.role] ?? 0;
  const phaseDelta = EXPECTATION_RULES.phaseAdjust[ctx.phase] ?? 0;
  const mid = Math.max(EXPECTATION_RULES.clamp[0], Math.min(EXPECTATION_RULES.clamp[1], base + themeDelta + roleDelta + phaseDelta));
  const band = EXPECTATION_RULES.band;
  return { expectedMid: round(mid, 2), expectedLo: round(Math.max(0, mid - band), 2), expectedHi: round(mid + band, 2) };
}
function buildExpectationGap(candidates = [], actualOpenMap = {}, ctx = {}) {
  const rows = candidates.map((stock) => {
    const perCtx = ctx.ctxFor ? ctx.ctxFor(stock) : ctx;
    const expected = expectedGapOf(stock, perCtx);
    const buyType = perCtx.buyType || continuationMode(stock.boards);
    const actualOpen = finiteNumber(actualOpenMap[stock.code]);
    let status = '暂无数据';
    if (actualOpen !== null) {
      status = actualOpen >= expected.expectedHi ? '超预期' : actualOpen <= expected.expectedLo ? '不及预期' : '符合预期';
    }
    return {
      code: stock.code, name: stock.name, boards: Number(stock.boards) || 1, buyType,
      themeName: stock.industry || '未分类', ...expected, actualOpen,
      diff: actualOpen === null ? null : round(actualOpen - expected.expectedMid, 2), status
    };
  });
  const counts = rows.filter((item) => item.status !== '暂无数据')
    .reduce((sum, item) => {
      if (item.status === '超预期') sum.beat += 1;
      else if (item.status === '不及预期') sum.miss += 1;
      else sum.meet += 1;
      return sum;
    }, { beat: 0, meet: 0, miss: 0 });
  return { available: Boolean(rows.length), counts, candidates: rows.sort((a, b) => (finiteNumber(b.diff) ?? -999) - (finiteNumber(a.diff) ?? -999)) };
}

/* ---------- 风险雷达 ---------- */
const RISK_ACTION_MAP = { '高位加速': '高位追涨', '后排': '后排接力', '随机首板': '盲目打首板', '弱板回封': '弱板回封', '板块核心': '聚焦核心分歧', '分歧回封': '强势回封', '弱转强': '弱转强修复', '一进二': '低吸一进二' };
function buildRiskRadar({ stocks = [], leaders = [], emotion = {}, breakRate = {}, phase } = {}) {
  const boards = stocks.map((stock) => Number(stock.boards) || 1);
  const highCount = boards.filter((board) => board >= 4).length;
  const firstCount = boards.filter((board) => board === 1).length;
  const maxBoard = boards.length ? Math.max(...boards) : 0;
  const rearCount = leaders.filter((leader) => leader.role === '跟风' || leader.role === '后排').length;
  const brk = breakRate.available ? finiteNumber(breakRate.rate) : null;
  const highScore = Math.min(100, highCount * 10 + (emotion.level === 'red' ? 25 : 0));
  const rearScore = Math.min(100, rearCount * 8 + (maxBoard >= 4 ? 15 : 0));
  const breakScore = brk === null ? 0 : Math.round(brk);
  const firstScore = Math.min(100, firstCount * 3);
  const levelOf = (score, key) => {
    if (key === 'first') return 'green';
    if (score >= 70) return 'red';
    if (score >= 40) return 'orange';
    return 'yellow';
  };
  const frontCount = leaders.filter((leader) => ['市场总龙头', '板块龙头', '板块中军'].includes(leader.role)).length;
  const avgGain = (list) => { const values = list.map((leader) => finiteNumber(leader.changePercent)).filter((value) => value !== null); return values.length ? round(values.reduce((sum, v) => sum + v, 0) / values.length, 2) : null; };
  const frontAvg = avgGain(leaders.filter((leader) => ['市场总龙头', '板块龙头', '板块中军'].includes(leader.role)));
  const rearAvg = avgGain(leaders.filter((leader) => leader.role === '跟风' || leader.role === '后排'));
  const spread = frontAvg !== null && rearAvg !== null ? `前后排涨幅差 ${round(frontAvg - rearAvg, 2)}` : null;
  const actionFor = {
    high: highScore >= 70 ? '禁止高位追涨' : highScore >= 40 ? '回避高位接力' : '高位可观察',
    rear: rearScore >= 70 ? '禁止后排接力' : rearScore >= 40 ? '回避后排' : '聚焦核心',
    first: firstScore >= 70 ? '首板偏拥挤，选择性参与' : '可留意低位首板',
    break: brk === null ? '--' : brk >= 40 ? '降低仓位，聚焦强势回封' : brk >= 25 ? '聚焦强势回封' : '正常打板'
  };
  const items = [
    { key: 'high', label: '高位接力', score: highScore, level: levelOf(highScore), reasons: [`高位股 ${highCount} 只（≥4板）`], action: actionFor.high, impact: ['高位接力机会', '高位加速策略'] },
    { key: 'rear', label: '后排跟风', score: rearScore, level: levelOf(rearScore), reasons: [`前排 ${frontCount} 只`, `后排 ${rearCount} 只`, `强弱差 ${frontCount - rearCount}`, ...(spread !== null ? [spread] : [])], action: actionFor.rear, impact: ['后排机会', '打板接力策略'] },
    { key: 'break', label: '炸板风险', score: breakScore, level: brk === null ? 'gray' : levelOf(breakScore), reasons: [brk === null ? '炸板池数据缺失' : `炸板率 ${brk}%`], action: actionFor.break, impact: ['打板成功率', '机会池'] },
    { key: 'first', label: '首板拥挤', score: firstScore, level: 'green', reasons: [`首板 ${firstCount} 只`], action: actionFor.first, impact: ['首板策略'] }
  ];
  const strategy = phaseStrategy(phase);
  const cannotDo = (strategy.forbidden || []).map((item) => RISK_ACTION_MAP[item] || item);
  const canStudy = (strategy.allowed || []).map((item) => RISK_ACTION_MAP[item] || item);
  let riskStars = 3;
  if (emotion.level === 'red') riskStars += 1;
  if (brk !== null && brk >= 30) riskStars += 1;
  if (emotion.phase === '冰点') riskStars = 5;
  else if (emotion.level === 'green' && brk !== null && brk < 20) riskStars = 2;
  if (highScore >= 70) riskStars = Math.max(riskStars, 4);
  return { available: Boolean(stocks.length), items, cannotDo, canStudy, riskStars: Math.min(5, Math.max(1, riskStars)) };
}

/* ---------- 信号 / 闸门 ---------- */
const SIGNAL_STATE = { 禁打: '禁打', 可打: '可打', 待触发: '待触发', 观察: '观察' };
function applyGate(stock, ctx = {}) {
  const gates = [];
  const marketOk = ctx.emotionLevel !== 'red' && !(ctx.breakRate !== null && ctx.breakRate !== undefined && ctx.breakRate >= 40);
  gates.push({ name: '市场环境', pass: marketOk, note: ctx.emotionPhase ? `${ctx.emotionPhase}${ctx.breakRate !== null && ctx.breakRate !== undefined ? ` · 炸板率 ${ctx.breakRate}%` : ''}` : '' });
  const themeScore = Number(ctx.themeScore);
  gates.push({ name: '题材过滤', pass: Number.isNaN(themeScore) ? true : themeScore >= 25, note: Number.isNaN(themeScore) ? '题材分缺失' : `强度 ${themeScore}` });
  const score = Number(ctx.score);
  gates.push({ name: '个股质量', pass: Number.isNaN(score) ? false : score >= 60, note: `${Number(score).toFixed(0)} 分` });
  const riskBlocked = (ctx.riskItems || []).some((item) => ['high', 'rear', 'break'].includes(item.key) && Number(item.score) >= 80);
  gates.push({ name: '风险闸', pass: !riskBlocked, note: riskBlocked ? '存在高危风险项' : '风险可承受' });
  const modeOk = !ctx.phase || (ctx.allowedModes || []).includes(ctx.mode) || ctx.mode === '首板' || ctx.mode === '板块核心';
  gates.push({ name: '模式匹配', pass: modeOk, note: ctx.mode || '' });
  if (ctx.phaseRisk) gates.push({ name: 'NoTrade·退潮', pass: false, note: '市场退潮/冰点，禁止' });
  if (ctx.circuitPaused) gates.push({ name: 'NoTrade·熔断', pass: false, note: '策略熔断' });
  if (ctx.dataAbnormal) gates.push({ name: 'NoTrade·数据异常', pass: false, note: '数据源异常' });
  if (ctx.themeMissing) gates.push({ name: 'NoTrade·主线不明', pass: false, note: '主线为空' });
  const pass = gates.every((gate) => gate.pass);
  return { pass, final: pass ? '允许' : '禁止', gates };
}
function buildSignal(stock, ctx = {}) {
  const gates = (stock.gate && stock.gate.gates) || [];
  const blocked = gates.filter((g) => !g.pass).map((g) => `${g.name}：${g.note || ''}`);
  const boards = Number(stock.boards) || 1;
  const phaseRisk = ['退潮初期', '退潮', '冰点'].includes(ctx.phase);
  const breakOver = Number(ctx.breakRate) >= 40;
  const isLeader = stock.role === '市场总龙头' || stock.role === '板块龙头';
  const triggers = [];
  const risks = [];
  if (phaseRisk) risks.push('市场退潮/冰点');
  if (breakOver) risks.push(`炸板率 ${ctx.breakRate}% 过高`);
  if (boards >= 4 && Number(stock.breakCount) > 0) risks.push('高位分歧（炸板未回封）');
  if (stock.themeScore !== null && stock.themeScore !== undefined && Number(stock.themeScore) < 50) risks.push('板块强度走弱');
  risks.push(...blocked);
  if (boards >= 2) triggers.push('回封（若盘中炸板）', '板块前排未炸', '情绪不恶化（炸板率≤40%）');
  else triggers.push('竞价强度维持（开盘≥预期中值）', '板块涨停数 ≥ 3');
  if (isLeader && ctx.phase === '分歧期') triggers.push('分歧回封 / 弱转强确认');
  let state;
  if (ctx.noTrade || ctx.dataAbnormal || blocked.length) state = '禁打';
  else if (phaseRisk || breakOver) state = '禁打';
  else if (stock.tier === 'S' || (stock.tier === 'A' && isLeader)) state = '可打';
  else if (stock.tier === 'A') state = '待触发';
  else if (stock.tier === 'B') state = '观察';
  else state = '禁打';
  return { state, triggers, risks, next: state === '可打' ? (isLeader ? 'S级打板机会' : 'A级打板机会') : state === '待触发' ? '触发后→可打' : '保持观察' };
}

/* ---------- 复盘 / 相似行情 / 结构 ---------- */
function approximatePhaseOf(limitUp, multiBoard, maxBoard) {
  if (limitUp <= 20 && maxBoard <= 2 && multiBoard <= 5) return 0;
  if (limitUp <= 30) return 1;
  if (limitUp >= 120 && maxBoard >= 5 && multiBoard >= 25) return 6;
  if (limitUp >= 80 && maxBoard >= 4 && multiBoard >= 15) return 5;
  if (limitUp >= 80) return 4;
  return 2;
}
function vectorOfStocks(stocks = []) {
  const boards = stocks.map((stock) => Number(stock.boards) || 1);
  const limitUp = stocks.length;
  const multiBoard = boards.filter((board) => board > 1).length;
  const maxBoard = boards.length ? Math.max(...boards) : 0;
  const firstBoard = boards.filter((board) => board === 1).length;
  const firstRatio = limitUp ? firstBoard / limitUp : 0;
  const industries = new Set(stocks.map((stock) => stock.industry || '其他').filter(Boolean));
  const themeBreadth = industries.size;
  const ladderTop = boards.filter((board) => board >= 2).sort((a, b) => b - a).slice(0, 3);
  const ladderSpread = ladderTop.length ? ladderTop.reduce((sum, board) => sum + board, 0) : 0;
  const phase = approximatePhaseOf(limitUp, multiBoard, maxBoard);
  const breakVals = stocks.map((stock) => finiteNumber(stock.breakCount));
  const breakRate = breakVals.some((value) => value !== null) ? round(breakVals.reduce((sum, value) => sum + (value ?? 0), 0) / (limitUp || 1), 2) : null;
  const amountAvail = stocks.filter((stock) => stock.amount !== undefined && stock.amount !== null);
  const amount = amountAvail.length ? round(amountAvail.reduce((sum, stock) => sum + (Number(stock.amount) || 0), 0)) : null;
  return { limitUp, multiBoard, maxBoard, firstRatio, themeBreadth, ladderSpread, phase, breakRate, amount };
}
function marketSimilarity(a, b) {
  const candidates = [
    [Number(a?.limitUp) / 150, Number(b?.limitUp) / 150],
    [Number(a?.multiBoard) / 60, Number(b?.multiBoard) / 60],
    [Number(a?.maxBoard) / 8, Number(b?.maxBoard) / 8],
    [Number(a?.firstRatio), Number(b?.firstRatio)],
    [Number(a?.themeBreadth) / 20, Number(b?.themeBreadth) / 20],
    [Number(a?.ladderSpread) / 12, Number(b?.ladderSpread) / 12],
    [Number(a?.phase) / 6, Number(b?.phase) / 6],
    [a?.breakRate != null ? Number(a.breakRate) / 2 : null, b?.breakRate != null ? Number(b.breakRate) / 2 : null],
    [a?.amount != null ? Number(a.amount) / 1e11 : null, b?.amount != null ? Number(b.amount) / 1e11 : null]
  ];
  const dims = candidates.filter(([x, y]) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y));
  if (!dims.length) return 0;
  const distance = Math.sqrt(dims.reduce((sum, [x, y]) => sum + (x - y) ** 2, 0));
  return round(Math.max(0, Math.min(1, 1 - distance / Math.sqrt(dims.length))), 3);
}
function buildSimilarDays(days = [], todayStocks = [], limit = 3) {
  const today = vectorOfStocks(todayStocks);
  const byDate = new Map(days.map((day) => [day.date, day]));
  const dates = days.map((day) => day.date).sort();
  const similar = days
    .map((day) => {
      const hist = vectorOfStocks(day.stocks);
      const idx = dates.indexOf(day.date);
      const trajectory = [];
      for (let k = 1; k <= 4 && dates[idx + k]; k += 1) {
        const fday = byDate.get(dates[idx + k]);
        if (!fday) break;
        const fvec = vectorOfStocks(fday.stocks);
        trajectory.push({ date: dates[idx + k], limitUp: fvec.limitUp, maxBoard: fvec.maxBoard, label: trajectoryLabel(fvec, hist) });
      }
      return {
        date: day.date,
        score: marketSimilarity(today, hist),
        trajectory,
        dimensions: [
          { label: '涨停数', cur: today.limitUp, hist: hist.limitUp },
          { label: '最高板', cur: today.maxBoard, hist: hist.maxBoard },
          { label: '连板数', cur: today.multiBoard, hist: hist.multiBoard },
          { label: '题材宽度', cur: today.themeBreadth, hist: hist.themeBreadth },
          { label: '情绪阶段', cur: today.phase, hist: hist.phase }
        ]
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const outcomes = [];
  for (const item of similar) {
    const nextDate = dates.find((date) => date > item.date);
    const next = nextDate ? byDate.get(nextDate) : null;
    if (!next) continue;
    const cur = vectorOfStocks(byDate.get(item.date).stocks);
    const nxt = vectorOfStocks(next.stocks);
    const outcome = nxt.limitUp > cur.limitUp ? 'up' : nxt.limitUp < cur.limitUp ? 'down' : nxt.maxBoard > cur.maxBoard ? 'up' : nxt.maxBoard < cur.maxBoard ? 'down' : 'flat';
    outcomes.push({ by: item.date, next: nextDate, outcome, score: item.score });
  }
  const weights = { up: 0, flat: 0, down: 0 };
  let totalWeight = 0;
  for (const item of outcomes) { weights[item.outcome] += item.score; totalWeight += item.score; }
  const pct = (key) => totalWeight ? Math.round(weights[key] / totalWeight * 100) : null;
  return { available: Boolean(similar.length), similar: similar.map((item) => ({ date: item.date, score: Math.round(item.score * 100), dimensions: item.dimensions, trajectory: item.trajectory })), outcome: { up: pct('up'), flat: pct('flat'), down: pct('down') }, samples: outcomes.length };
}
function trajectoryLabel(dayVec, prevVec) {
  const up = Number(dayVec?.limitUp) - Number(prevVec?.limitUp);
  if (up >= 20) return '强扩散';
  if (up >= 5) return '修复';
  if (up <= -20) return '退潮';
  if (up <= -5) return '走弱';
  if (Number(dayVec?.maxBoard) > Number(prevVec?.maxBoard)) return '高度提升';
  return '震荡';
}

// 市场结构图：主线 = 强度最高的题材；其下挂核心龙头（前排）；其余题材为支线。
function buildMarketStructure({ stocks = [], themes = [], leaders = [] } = {}) {
  const ranked = (themes.length ? themes : buildThemeRanking(stocks)).slice();
  const main = ranked[0] || null;
  const branches = ranked.slice(1, 6);
  const leadersByTheme = new Map();
  for (const l of leaders) {
    if (!leadersByTheme.has(l.themeName)) leadersByTheme.set(l.themeName, []);
    leadersByTheme.get(l.themeName).push(l);
  }
  const themeMembers = (name) => stocks.filter((s) => (s.industry || '未分类') === name).sort((a, b) => (b.boards || 1) - (a.boards || 1)).slice(0, 5);
  return {
    main: main ? { ...main, members: themeMembers(main.name), leaders: (leadersByTheme.get(main.name) || []).slice(0, 3) } : null,
    branches: branches.map((b) => ({ ...b, members: themeMembers(b.name), leaders: (leadersByTheme.get(b.name) || []).slice(0, 3) }))
  };
}

/* ---------- 预案（自动 verdict） ---------- */
function buildPlan({ phase, riskRadar = {}, emotion = {}, opportunities = {} } = {}) {
  const strategy = phaseStrategy(phase);
  const tiers = opportunities.tiers || {};
  const sCount = (tiers.S || []).length, aCount = (tiers.A || []).length, bCount = (tiers.B || []).length;
  let verdict = '观望';
  if (['高潮', '高潮转分歧', '分歧期', '退潮初期', '退潮', '冰点'].includes(phase)) verdict = phase === '冰点' ? '空仓/极轻仓' : '去弱留强，控制仓位';
  else if (phase === '主升期') verdict = '可积极，优先核心与强题材';
  else if (phase === '修复') verdict = '轻仓试错';
  const rules = [];
  if (strategy.allowed?.length) rules.push('可参与买点：' + strategy.allowed.join(' / '));
  if (strategy.forbidden?.length) rules.push('回避买点：' + strategy.forbidden.join(' / '));
  if (emotion?.advice) rules.push('情绪建议：' + emotion.advice);
  if (riskRadar?.cannotDo?.length) rules.push('禁止动作：' + riskRadar.cannotDo.join(' / '));
  if (sCount || aCount) rules.push(`机会池 S ${sCount} / A ${aCount} / B ${bCount}`);
  return { verdict, rules, mode: strategy.allowed || [], forbidden: strategy.forbidden || [] };
}

/* ---------- 交易归因 ---------- */
function attributionOf(trade = {}) {
  const pnl = Number(trade.pnl) || 0;
  if (!pnl) return { market: 0, theme: 0, stock: 0, buy: 0, sell: 0 };
  const reasons = trade.buyReasons || [];
  let m = 0.2, th = 0.15, st = 0.25, b = 0.2;
  if (!reasons.length || reasons.includes('纯情绪')) { th = 0.06; st = 0.3; }
  if (reasons.includes('板块爆发')) th += 0.15;
  if (reasons.includes('龙头') || reasons.includes('二进三') || reasons.includes('三进四') || reasons.includes('高位加速')) st += 0.15;
  if (reasons.includes('分歧回封') || reasons.includes('弱转强') || reasons.includes('竞价强')) b += 0.15;
  const total = m + th + st + b;
  m /= total; th /= total; st /= total; b /= total;
  const alloc = (w) => w * pnl * 0.72;
  const sell = pnl - (alloc(m) + alloc(th) + alloc(st) + alloc(b));
  const adj = (v) => Math.round(v * 100) / 100;
  return { market: adj(alloc(m)), theme: adj(alloc(th)), stock: adj(alloc(st)), buy: adj(alloc(b)), sell: adj(sell) };
}

/* ---------- 组合风险 ---------- */
const DEFAULT_RISK_LIMITS = Object.freeze({ maxTotalExposure: 0.8, maxSinglePosition: 0.3, maxThemeExposure: 0.5, maxIndustryExposure: 0.5, maxPositions: 5, maxLosingStreak: 4, maxDailyLossPct: 3 });
function groupExposure(positions, field) {
  const values = {};
  for (const position of positions) {
    const key = position[field] || '未分类';
    values[key] = (values[key] || 0) + Math.max(0, Number(position.fraction) || 0);
  }
  return values;
}
function losingStreak(trades) {
  let streak = 0;
  for (const trade of [...trades].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))) {
    if (Number(trade.pnl) < 0) streak += 1; else break;
  }
  return streak;
}
function evaluatePortfolioRisk({ positions = [], trades = [], limits = DEFAULT_RISK_LIMITS, candidate = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const active = positions.filter((position) => position.status === 'open');
  const totalExposure = active.reduce((sum, position) => sum + Math.max(0, Number(position.fraction) || 0), 0);
  const themeExposure = groupExposure(active, 'theme');
  const industryExposure = groupExposure(active, 'industry');
  const streak = losingStreak(trades);
  const dailyPnl = trades.filter((trade) => trade.date === today).reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const violations = [];
  if (totalExposure > limits.maxTotalExposure) violations.push({ key: 'total', label: '总仓位超限', value: totalExposure, limit: limits.maxTotalExposure });
  if (active.some((position) => Number(position.fraction || 0) > limits.maxSinglePosition)) violations.push({ key: 'single', label: '单股仓位超限', limit: limits.maxSinglePosition });
  if (Object.values(themeExposure).some((value) => value > limits.maxThemeExposure)) violations.push({ key: 'theme', label: '单题材暴露超限', limit: limits.maxThemeExposure });
  if (Object.values(industryExposure).some((value) => value > limits.maxIndustryExposure)) violations.push({ key: 'industry', label: '行业集中度超限', limit: limits.maxIndustryExposure });
  if (active.length > limits.maxPositions) violations.push({ key: 'positions', label: '持仓数量超限', value: active.length, limit: limits.maxPositions });
  if (streak >= limits.maxLosingStreak) violations.push({ key: 'streak', label: '连续亏损熔断', value: streak, limit: limits.maxLosingStreak });
  if (dailyPnl <= -Math.abs(limits.maxDailyLossPct)) violations.push({ key: 'daily_loss', label: '单日最大亏损熔断', value: dailyPnl, limit: -Math.abs(limits.maxDailyLossPct) });
  const candidateFraction = Math.max(0, Number(candidate?.fraction) || 0);
  const candidateTheme = candidate?.theme || '未分类';
  const candidateIndustry = candidate?.industry || '未分类';
  const candidateViolations = [];
  if (candidate) {
    if (candidateFraction > limits.maxSinglePosition) candidateViolations.push('单股仓位');
    if (totalExposure + candidateFraction > limits.maxTotalExposure) candidateViolations.push('总仓位');
    if ((themeExposure[candidateTheme] || 0) + candidateFraction > limits.maxThemeExposure) candidateViolations.push('题材暴露');
    if ((industryExposure[candidateIndustry] || 0) + candidateFraction > limits.maxIndustryExposure) candidateViolations.push('行业集中度');
    if (active.length + 1 > limits.maxPositions) candidateViolations.push('持仓数量');
    if (streak >= limits.maxLosingStreak) candidateViolations.push('连续亏损熔断');
    if (dailyPnl <= -Math.abs(limits.maxDailyLossPct)) candidateViolations.push('单日亏损熔断');
  }
  return { ok: violations.length === 0, canOpen: candidateViolations.length === 0, violations, candidateViolations, totalExposure, themeExposure, industryExposure, positions: active.length, losingStreak: streak, dailyPnl, limits, asOf: new Date().toISOString() };
}

/* ---------- 决策助手（返回 HTML 字符串，由视图注入） ---------- */
const COPILOT_QUESTIONS = [
  { key: 'relay', label: '为什么今天不建议接力？' },
  { key: 'phase', label: '今天市场处于什么阶段？' },
  { key: 'mainline', label: '今天主线是什么？' },
  { key: 'playable', label: '现在有什么机会和风险？' },
  { key: 'tomorrow', label: '明天重点是什么？' },
  { key: 'health', label: '当前数据可信吗？' }
];
function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function copilotSection(label, items) {
  const arr = Array.isArray(items) ? items : [items];
  return `<div class="report-section"><b>${esc(label)}</b><div>${arr.length ? arr.map((i) => `<span>${esc(i)}</span>`).join(' / ') : '—'}</div></div>`;
}
function buildCopilotAnswer(key, payload) {
  if (!payload) return '<div class="all-empty">等待实时行情后再询问</div>';
  const status = payload.status || {};
  const stats = payload.stats || {};
  const themes = payload.themes || [];
  const leaders = payload.leaders || [];
  const radar = payload.riskRadar || {};
  const opportunities = payload.opportunities || {};
  const br = stats.breakRate?.available ? stats.breakRate.rate : null;
  const q = COPILOT_QUESTIONS.find((item) => item.key === key);
  const title = q ? q.label : key;
  let answer;
  if (key === 'relay') {
    const rear = (radar.items || []).find((item) => item.key === 'rear');
    const reasons = (rear?.reasons || []).concat(radar.cannotDo || []);
    answer = `<p class="copilot-verdict">${esc(rear?.action || (reasons.length ? '需要谨慎接力' : '当前无明确禁止接力'))}</p>${copilotSection('原因', reasons.length ? reasons : ['当前无明确的接力风险信号'])}`;
  } else if (key === 'phase') {
    const reasons = [];
    if (br !== null) reasons.push(`炸板率 ${br}%${stats.breakRate?.change != null && stats.breakRate?.change !== undefined ? `（较昨日${stats.breakRate.change >= 0 ? '升' : '降'} ${Math.abs(stats.breakRate.change)}）` : ''}`);
    reasons.push(`涨停 ${payload.limitUpCount ?? '--'} 家 · 跌停 ${payload.limitDownCount ?? '--'} · 最高 ${status.maxBoard ?? '--'}板`);
    if (status.level === 'red') reasons.push('情绪极差，注意防守');
    if (['退潮', '退潮初期', '冰点'].includes(status.phase)) reasons.push('退潮/冰点环境，建议减少主动进攻');
    answer = `<p class="copilot-verdict">当前市场处于<b>${esc(status.phase || '--')}</b>阶段，情绪指数 ${status.emotionIndex ?? '--'}。</p>${copilotSection('依据', reasons)}`;
  } else if (key === 'mainline') {
    const main = themes[0];
    if (!main) answer = '<p class="copilot-verdict">当前主线不明确（题材数据缺失）。</p>';
    else {
      const lds = leaders.filter((l) => l.themeName === main.name).slice(0, 3);
      answer = `<p class="copilot-verdict">今日主线是<b>${esc(main.name)}</b>（强度 ${main.score ?? '--'} · 涨停 ${main.limitUpCount ?? '--'} 家 · 最高 ${main.maxBoard ?? '--'}板）。</p>${copilotSection('核心', lds.length ? lds.map((l) => `${l.name} · ${l.boards}板 · ${l.role}`) : ['暂无核心个股'])}`;
    }
  } else if (key === 'playable') {
    const tiers = opportunities.tiers || {};
    const sCount = (tiers.S || []).length, aCount = (tiers.A || []).length, bCount = (tiers.B || []).length;
    const playable = [...(tiers.S || []), ...(tiers.A || []), ...(tiers.B || [])].filter((s) => s.signal?.state === '可打').length;
    const risks = (radar.items || []).map((item) => `${item.label}（${item.score}）`).slice(0, 4);
    const cant = radar.cannotDo || [];
    let extra = `<p class="copilot-verdict">机会池 S ${sCount} / A ${aCount} / B ${bCount}，其中<b>可打信号 ${playable}</b> 只。</p>${copilotSection('风险', risks.length ? risks : ['暂无显著风险'])}`;
    if (cant.length) extra += copilotSection('禁止', cant);
    answer = extra;
  } else if (key === 'tomorrow') {
    const strategy = phaseStrategy(status.phase);
    answer = `<p class="copilot-verdict">明日重点：${esc((strategy.allowed || []).join(' / ') || '等待方向选择')}。</p>${copilotSection('可参与', strategy.allowed || [])}${copilotSection('禁止', strategy.forbidden || [])}`;
  } else if (key === 'health') {
    const h = payload.health;
    if (!h) answer = '<p class="copilot-verdict">健康数据缺失。</p>';
    else answer = `<p class="copilot-verdict">整体 ${h.ok ? '🟢 正常' : `🔴 ${h.message || '异常'}`}${h.latencyMs != null ? ` · 延迟 ${h.latencyMs}ms` : ''}。</p>${copilotSection('数据源', Object.entries(h.sources || {}).map(([name, s]) => `${name} ${s.ok ? '🟢' : '🔴'}`))}`;
  } else answer = '<p class="copilot-verdict">暂不支持该问题。</p>';
  return `<div class="report-card copilot-card"><div class="report-head"><strong>🤖 ${esc(title)}</strong><span>系统基于 ${esc(payload.tradeDate || '--')} 实时数据</span></div>${answer}</div>`;
}

export {
  finiteNumber, round, calculateBreakRate, buildLimitUpLadder, summarizeTheme, groupThemes, buildThemeRanking,
  rankCoreLeaders, leaderScore, calculatePromotionStats, calculateRollingPromotion, buildModeMonitor, aggregateModeRates,
  calculateEmotionState, indicator, computeOpportunityScore, rankOpportunities, phaseStrategy, RULES, PHASE_STRATEGY,
  buyTypeOf, expectedGapOf, buildExpectationGap, buildRiskRadar, buildSignal, applyGate,
  buildSimilarDays, vectorOfStocks, marketSimilarity, approximatePhaseOf, trajectoryLabel, buildMarketStructure,
  buildPlan, attributionOf, DEFAULT_RISK_LIMITS, evaluatePortfolioRisk, COPILOT_QUESTIONS, buildCopilotAnswer, PHASE_NAMES, SIGNAL_STATE
};
