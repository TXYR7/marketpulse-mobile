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
  });
  // G10 容量核心：同主题封板资金（sealAmount）第一
  const themeTopSeal = new Map();
  for (const [name, group] of themeGroups) {
    let best = null;
    for (const s of group) {
      const amt = finiteNumber(s.sealAmount);
      if (amt === null) continue;
      if (!best || amt > best.amt) best = { code: s.code, amt };
    }
    if (best) themeTopSeal.set(name, best.code);
  }
  const scoredSorted = [...scored].sort((a, b) => b.score - a.score || (finiteNumber(b.boards) || 1) - (finiteNumber(a.boards) || 1) || String(a.code).localeCompare(String(b.code)));
  const topScoreCode = scoredSorted[0]?.code;

  return scoredSorted.slice(0, 30).map((stock) => {
    const boards = Math.max(1, finiteNumber(stock.boards) || 1);
    const turnover = finiteNumber(stock.turnoverRate);
    // 趋势核心：仅当个股带 kline 时由 klineFeatures 判定 ma5≥ma10（池快照默认无 kline，不臆造趋势）
    let trendUp = false;
    if (Array.isArray(stock.kline) && stock.kline.length) {
      const kf = klineFeatures(stock.kline);
      trendUp = kf.available && kf.ma5 !== null && kf.ma10 !== null && kf.ma5 >= kf.ma10;
    }
    let role;
    if (stock.code === topScoreCode && boards >= 3) role = '市场总龙头';
    else if (boards >= 5) role = '高度龙头';
    else if (stock.themeRank === 1 && stock.themeSize >= 2) role = '板块龙头';
    else if (stock.themeRank === 2 && stock.themeSize >= 3) role = '板块中军';
    else if (themeTopSeal.get(stock.themeName) === stock.code) role = '容量核心';
    else if (trendUp) role = '趋势核心';
    else if (turnover !== null && turnover >= 8 && boards <= 2) role = '情绪核心';
    else if (stock.themeSize >= 3 && boards <= 2) role = '补涨龙';
    else if (boards > 1 || stock.themeSize >= 4) role = '跟风';
    else role = '后排';
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
  const marketBreakRate = finiteNumber(input.marketBreakRate);
  const firstBoardPremium = finiteNumber(input.firstBoardPremium);
  const highBoardPremium = finiteNumber(input.highBoardPremium);
  const availableCount = [limitUp, limitDown, multiBoard, maxBoard, breakRate, firstPromotion, multiPromotion, marketBreakRate, firstBoardPremium, highBoardPremium].filter((value) => value !== null).length;
  const confidence = Math.round(availableCount / PARAM_MANIFEST.emotion.confidenceDenominator * 100);
  const indicators = [
    indicator('limitUp', '涨停家数', limitUp, limitUp >= 80 ? 'green' : limitUp >= 40 ? 'yellow' : 'red', limitUp !== null),
    indicator('limitDown', '跌停家数', limitDown, limitDown <= 10 ? 'green' : limitDown <= 20 ? 'yellow' : 'red', limitDown !== null),
    indicator('multiBoard', '连板家数', multiBoard, multiBoard >= 20 ? 'green' : multiBoard >= 10 ? 'yellow' : 'red', multiBoard !== null),
    indicator('maxBoard', '最高板', maxBoard, maxBoard >= 5 ? 'green' : maxBoard >= 3 ? 'yellow' : 'red', maxBoard !== null),
    indicator('breakRate', '炸板率', breakRate, breakRate <= 20 ? 'green' : breakRate <= 35 ? 'yellow' : 'red', breakRate !== null),
    indicator('firstPromotion', '首板晋级率', firstPromotion, firstPromotion >= 35 ? 'green' : firstPromotion >= 20 ? 'yellow' : 'red', firstPromotion !== null),
    indicator('multiPromotion', '连板晋级率', multiPromotion, multiPromotion >= 45 ? 'green' : multiPromotion >= 25 ? 'yellow' : 'red', multiPromotion !== null),
    indicator('marketBreakRate', '市场断板率', marketBreakRate, marketBreakRate <= 20 ? 'green' : marketBreakRate <= 35 ? 'yellow' : 'red', marketBreakRate !== null),
    indicator('firstBoardPremium', '昨首板溢价', firstBoardPremium, firstBoardPremium >= 3 ? 'green' : firstBoardPremium >= 1 ? 'yellow' : 'red', firstBoardPremium !== null),
    indicator('highBoardPremium', '昨高位溢价', highBoardPremium, highBoardPremium >= 2 ? 'green' : highBoardPremium >= 0 ? 'yellow' : 'red', highBoardPremium !== null)
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
const CORE_LEADER_ROLES = ['市场总龙头', '高度龙头', '板块龙头', '板块中军', '容量核心', '趋势核心', '补涨龙', '情绪核心'];
const RULES = {
  rolePoints: { '市场总龙头': 20, '高度龙头': 18, '板块龙头': 16, '容量核心': 14, '板块中军': 12, '趋势核心': 12, '补涨龙': 11, '情绪核心': 10, '跟风': 7, '后排': 3 },
  roleCap: 20,
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
  const phaseKnown = Boolean(ctx.phase);

  const breakdown = {};
  const plus = [];
  const minus = [];

  // 归一化：只把「可得」维度的权重计入满分（assessPromotion 同款思想）。
  // 数据缺失股不再被绝对刻度误杀——比较的是「拿到可得分的比例」而非裸分。
  let possibleMax = 0;
  const avail = (weight, ok2) => { if (ok2) possibleMax += weight; };

  const rolePoints = RULES.rolePoints[role] ?? 3;
  breakdown.role = rolePoints;
  avail(RULES.roleCap, true); // 角色恒可得（rankOpportunities 必给兜底角色）
  if (CORE_LEADER_ROLES.includes(role)) plus.push(role);

  const themePoints = Math.min(RULES.themeCap, (themeScore ?? 0) * RULES.themeFactor);
  breakdown.theme = round(themePoints);
  avail(RULES.themeCap, themeScore !== null);
  if (themeScore !== null && themeScore >= 80) plus.push('板块强度强');
  else if (themeScore !== null && themeScore < 30) minus.push('板块强度弱');

  const heightPoints = Math.min(RULES.heightCap, boards * RULES.heightPointsPerBoard);
  breakdown.height = heightPoints;
  avail(RULES.heightCap, true);
  if (boards >= 4) plus.push(`高度 ${boards} 板`);

  const sealPoints = sealStars === null ? 0 : Math.min(RULES.sealCap, sealStars * RULES.sealPointsPerStar);
  breakdown.seal = sealPoints;
  avail(RULES.sealCap, sealStars !== null);
  if (sealStars !== null && sealStars >= 5) plus.push('封单极强');
  else if (sealStars !== null && sealStars <= 2) minus.push('封单偏弱');

  const turnoverPoints = turnoverRate === null ? 0 : turnoverRate >= 1.5 && turnoverRate <= 12 ? RULES.turnoverGood : turnoverRate <= 20 ? RULES.turnoverMid : RULES.turnoverOther;
  breakdown.turnover = turnoverPoints;
  avail(RULES.turnoverGood, turnoverRate !== null);
  if (turnoverPoints === RULES.turnoverGood) plus.push('换手良性');
  else if (turnoverPoints === RULES.turnoverOther) minus.push('换手异常');

  const breakPoints = Math.max(0, RULES.breakMaxPoints - breakCount * RULES.breakPointsPerCount);
  breakdown.breaks = breakPoints;
  avail(RULES.breakMaxPoints, true);
  if (breakCount > 0) minus.push(`炸板 ${breakCount} 次`);
  else plus.push('未炸板');

  const modePoints = strategy.allowed.includes(buyType) ? RULES.modeAllowed : strategy.forbidden.includes(buyType) ? RULES.modeForbidden : RULES.modeOther;
  breakdown.mode = modePoints;
  avail(RULES.modeAllowed, phaseKnown);
  if (strategy.allowed.includes(buyType)) plus.push(`买点「${buyType}」契合当前阶段`);
  else if (strategy.forbidden.includes(buyType)) minus.push(`买点「${buyType}」当前阶段不适用`);

  const score = Math.max(0, Math.min(100, Math.round(rolePoints + themePoints + heightPoints + sealPoints + turnoverPoints + breakPoints + modePoints)));
  // 注意：role 的实际得分上限随角色而变（后排3分），但「可得性」按满配 20 计——
  // 角色低不是数据缺失而是事实判定，不应放宽刻度。
  const scoreNorm = possibleMax > 0 ? Math.max(0, Math.min(100, Math.round(score / possibleMax * 100))) : score;

  const elim = [];
  if (breakCount >= RULES.elim.breakCountTooMany) elim.push(`炸板次数过多（${breakCount} 次）`);
  if (role === '后排' && themeScore !== null && themeScore < RULES.elim.weakRearThemeBelow && boards === RULES.elim.weakRearBoard) elim.push('后排 & 板块弱');
  if (turnoverRate !== null && turnoverRate > RULES.elim.turnoverOverheat && (role === '跟风' || role === '后排')) elim.push('换手过度');
  if (themeScore !== null && themeScore < RULES.elim.themeBelow) elim.push('板块强度弱');
  if (boards >= RULES.elim.highBoardBreak && (finiteNumber(stock.breakCount) ?? 0) >= 1) elim.push('高位分歧');

  const isCoreLeader = CORE_LEADER_ROLES.includes(role);
  let tier;
  if (elim.length) tier = '淘汰';
  else if (scoreNorm >= RULES.tier.sScore && isCoreLeader) tier = 'S';
  else if (scoreNorm >= RULES.tier.aScore || (scoreNorm >= RULES.tier.aCoreScore && isCoreLeader)) tier = 'A';
  else if (scoreNorm >= RULES.tier.bScore) tier = 'B';
  else { tier = '淘汰'; elim.push('综合得分偏低'); }
  const weights = { role: rolePoints, theme: RULES.themeCap, height: RULES.heightCap, seal: RULES.sealCap, turnover: RULES.turnoverGood, breaks: RULES.breakMaxPoints, mode: RULES.modeAllowed };
  return { score, scoreNorm, possibleMax, tier, reasons: { plus, minus, elim }, breakdown, weights };
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
  const ordered = ranked.sort((a, b) => (b.scoreNorm ?? b.score) - (a.scoreNorm ?? a.score) || (finiteNumber(b.boards) || 1) - (finiteNumber(a.boards) || 1) || String(a.code).localeCompare(String(b.code)));
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
  const frontCount = leaders.filter((leader) => CORE_LEADER_ROLES.includes(leader.role)).length;
  const avgGain = (list) => { const values = list.map((leader) => finiteNumber(leader.changePercent)).filter((value) => value !== null); return values.length ? round(values.reduce((sum, v) => sum + v, 0) / values.length, 2) : null; };
  const frontAvg = avgGain(leaders.filter((leader) => CORE_LEADER_ROLES.includes(leader.role)));
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
  const isLeader = CORE_LEADER_ROLES.includes(stock.role);
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

// G24 个股相似案例（mobile 移植自桌面 analytics.js）：复用 klineFeatures 构造个股窗口特征向量，
// 与自身历史各窗口做欧氏距离，取 top-N 相似片段 + 后续 horizon 日收益作为「案例结果」。
// marketSimilarity 是盘面级（比两个市场快照向量），无法直接比单只股票，故此处新增平行实现。
const STOCK_SIMILAR_NOTE = '相似度用 量能变化 / 缺口未补 / MA5·MA20 乖离 / 5日收益 / 波动率 / 回踩首板 六维（欧氏距离·按实际维度数归一），由该股自身日K滑动窗口构造，匹配历史上形态最相近的片段并复盘其后续表现。';

function stockShapeVector(slice = []) {
  const f = klineFeatures(slice);
  if (!f.available) return null;
  const closes = slice.map((b) => Number(b.close)).filter((v) => Number.isFinite(v));
  const ret5 = closes.length >= 6 ? closes[closes.length - 1] / closes[closes.length - 6] - 1 : null;
  let vol5 = null;
  if (closes.length >= 6) {
    const rets = [];
    for (let i = 1; i < closes.length; i += 1) rets.push(closes[i] / closes[i - 1] - 1);
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
    vol5 = Math.sqrt(variance);
  }
  const maSpread = (f.ma5 != null && f.ma20) ? f.ma5 / f.ma20 - 1 : null;
  return {
    volChg1d: f.volChg1d != null ? f.volChg1d / 100 : null,
    gap: f.gapUnfilled === true ? 1 : f.gapUnfilled === false ? 0 : null,
    maSpread: maSpread != null ? maSpread / 0.3 : null,
    ret5: ret5 != null ? ret5 / 0.3 : null,
    vol5: vol5 != null ? vol5 / 0.1 : null,
    pullback: f.pullbackFirstBoard ? 1 : 0
  };
}

function shapeScore(a, b) {
  const dims = [];
  for (const key of Object.keys(a)) {
    const x = a[key];
    const y = b[key];
    if (x != null && y != null && Number.isFinite(x) && Number.isFinite(y)) dims.push([x, y]);
  }
  if (!dims.length) return 0;
  const distance = Math.sqrt(dims.reduce((sum, [x, y]) => sum + (x - y) ** 2, 0));
  return round(Math.max(0, Math.min(1, 1 - distance / Math.sqrt(dims.length))), 3);
}

function describeShapeFeatures(cur, hist) {
  const map = [
    ['量能变化', cur.volChg1d, hist.volChg1d],
    ['缺口未补', cur.gap, hist.gap],
    ['MA5·MA20 乖离', cur.maSpread, hist.maSpread],
    ['5日收益', cur.ret5, hist.ret5],
    ['波动率', cur.vol5, hist.vol5],
    ['回踩首板', cur.pullback, hist.pullback]
  ];
  const round3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  return map.map(([label, c, h]) => ({ label, cur: round3(c), hist: round3(h) }));
}

function stockSimilarCases(bars = [], { window = 20, horizon = 5, limit = 3 } = {}) {
  const rows = (Array.isArray(bars) ? bars : []).filter((b) => b && Number.isFinite(Number(b.close)) && Number(b.close) > 0);
  if (rows.length < window + horizon + 1) {
    return { available: false, similar: [], outcome: { up: null, flat: null, down: null }, samples: 0, vectorNote: STOCK_SIMILAR_NOTE };
  }
  const curVec = stockShapeVector(rows.slice(-window));
  if (!curVec) return { available: false, similar: [], outcome: { up: null, flat: null, down: null }, samples: 0, vectorNote: STOCK_SIMILAR_NOTE };
  const candidates = [];
  for (let i = 2 * window; i <= rows.length - horizon - 1; i += 1) {
    const vec = stockShapeVector(rows.slice(i - window + 1, i + 1));
    if (!vec) continue;
    candidates.push({ end: i, date: rows[i].date, score: shapeScore(curVec, vec), features: describeShapeFeatures(curVec, vec) });
  }
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, limit);
  const outcomes = [];
  for (const c of top) {
    const next = rows[c.end + horizon];
    if (!next) continue;
    const ret = Number(next.close) / Number(rows[c.end].close) - 1;
    outcomes.push({ outcome: ret > 0.005 ? 'up' : ret < -0.005 ? 'down' : 'flat', score: c.score });
  }
  const weights = { up: 0, flat: 0, down: 0 };
  let total = 0;
  for (const o of outcomes) { weights[o.outcome] += o.score; total += o.score; }
  const pct = (key) => (total ? Math.round((weights[key] / total) * 100) : null);
  return {
    available: Boolean(top.length),
    similar: top.map((c) => ({ date: c.date, score: Math.round(c.score * 100), features: c.features })),
    outcome: { up: pct('up'), flat: pct('flat'), down: pct('down') },
    samples: outcomes.length,
    vectorNote: STOCK_SIMILAR_NOTE
  };
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
  { key: 'relay', label: '为什么今天不建议接力？', keywords: ['接力', '后排', '追高', '跟风', '还能打板', '能不能接', '接力的风险'] },
  { key: 'phase', label: '今天市场处于什么阶段？', keywords: ['阶段', '情绪周期', '什么行情', '冰点', '退潮', '主升', '分歧', '修复'] },
  { key: 'mainline', label: '今天主线是什么？', keywords: ['主线', '题材', '热点', '板块', '领涨'] },
  { key: 'limitup', label: '今天涨停多说明什么？', keywords: ['涨停', '涨多', '百股涨停', '涨停家数'] },
  { key: 'emotion', label: '情绪指数高低意味着什么？', keywords: ['情绪', '情绪指数', '冰点', '高潮', '亢奋', '恐慌'] },
  { key: 'height', label: '连板高度说明什么？', keywords: ['高度', '连板', '几板', '空间', '最高板'] },
  { key: 'breakrate', label: '炸板率高说明什么？', keywords: ['炸板', '开板', '炸板率', '烂板'] },
  { key: 'leader', label: '当前龙头是谁？', keywords: ['龙头', '领头', '核心股', '总龙', '高标'] },
  { key: 'playable', label: '现在有什么机会和风险？', keywords: ['机会', '风险', '能买', '可打', '出手', '看点'] },
  { key: 'should', label: '现在该不该出手？', keywords: ['该不该', '出手', '买不买', '能买吗', '要不要买', '干不干'] },
  { key: 'retreat', label: '有没有退潮信号？', keywords: ['退潮', '见顶', '结束', '风险信号', '退潮迹象'] },
  { key: 'promotion', label: '今天的票能晋级吗？（体系检查表）', keywords: ['晋级', '能不能板', '连板', '上板', '封板', '明天还板', '能不能继续'] },
  { key: 'position', label: '现在该上多少仓位？', keywords: ['仓位', '几成', '上多少', '满仓', '半仓', '怎么分配', '拿多少'] },
  { key: 'recede', label: '当前阶段的心法口诀', keywords: ['心法', '口诀', '纪律', '怎么说', '修心'] },
  { key: 'tomorrow', label: '明天重点是什么？', keywords: ['明天', '次日', '重点', '关注', '预判', '展望'] },
  { key: 'health', label: '当前数据可信吗？', keywords: ['数据', '可信', '真实', '延迟', '靠谱', '来源', '准吗'] }
];
// 关键词路由：自由文本 → 最匹配的问题 key（子串 label +2 / 每关键词 +1），无匹配返回 null
function routeCopilotQuery(text, questions) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  let best = null, bestScore = 0;
  for (const q of (questions || [])) {
    let score = 0;
    const label = String(q.label || '').toLowerCase();
    if (label && t.includes(label)) score += 2;
    for (const kw of (q.keywords || [])) {
      const k = String(kw).toLowerCase();
      if (k && t.includes(k)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = q.key; }
  }
  return bestScore > 0 ? best : null;
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function spans(arr) {
  const a = Array.isArray(arr) ? arr : [arr];
  return a.length ? a.map((i) => `<span>${esc(i)}</span>`).join(' / ') : '—';
}
function copilotLayer(cls, label, html) {
  return `<div class="copilot-layer ${cls}"><b class="cl-label">${esc(label)}</b><div class="cl-body">${html || '—'}</div></div>`;
}
// 三层输出（事实 / 推断 / 建议），对齐桌面 P9 决策助手；纯数据描述、不预测，结尾统一标注规则参考。
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
  const tradeDate = payload.tradeDate || '--';
  let fact = '', infer = '', advise = '';
  if (key === 'relay') {
    const rear = (radar.items || []).find((item) => item.key === 'rear');
    const reasons = (rear?.reasons || []).concat(radar.cannotDo || []);
    fact = rear?.action || '当前无明确禁止接力信号';
    infer = spans(reasons.length ? reasons : ['当前无明确的接力风险信号']);
    advise = spans(['后排跟风与高位缩量板谨慎追', '只在体系检查表通过且换手充分时介入']);
  } else if (key === 'phase') {
    const reasons = [];
    if (br !== null) reasons.push(`炸板率 ${br}%${stats.breakRate?.change != null && stats.breakRate?.change !== undefined ? `（较昨日${stats.breakRate.change >= 0 ? '升' : '降'} ${Math.abs(stats.breakRate.change)}）` : ''}`);
    reasons.push(`涨停 ${payload.limitUpCount ?? '--'} 家 · 跌停 ${payload.limitDownCount ?? '--'} · 最高 ${status.maxBoard ?? '--'}板`);
    if (status.level === 'red') reasons.push('情绪极差，注意防守');
    if (['退潮', '退潮初期', '冰点'].includes(status.phase)) reasons.push('退潮/冰点环境，建议减少主动进攻');
    fact = `市场处于 <b>${esc(status.phase || '--')}</b> 阶段，情绪指数 ${esc(status.emotionIndex ?? '--')}`;
    infer = spans(reasons);
    const ps = phaseStrategy(status.phase) || {};
    advise = spans(ps.advice ? [ps.advice] : ['按阶段策略控制仓位与出手频率']);
  } else if (key === 'mainline') {
    const main = themes[0];
    if (!main) { fact = '当前主线不明确（题材数据缺失）'; infer = '题材强度分散，缺乏合力方向'; advise = '控制仓位，等待主线清晰'; }
    else {
      const lds = leaders.filter((l) => l.themeName === main.name).slice(0, 3);
      fact = `主线是 <b>${esc(main.name)}</b>（强度 ${esc(main.score ?? '--')} · 涨停 ${esc(main.limitUpCount ?? '--')} 家 · 最高 ${esc(main.maxBoard ?? '--')}板）`;
      infer = spans(lds.length ? lds.map((l) => `${l.name} · ${l.boards}板 · ${l.role}`) : ['暂无核心个股']);
      advise = spans(['沿主线前排核心参与，回避支线杂毛']);
    }
  } else if (key === 'limitup') {
    const n = Number(payload.limitUpCount ?? 0);
    fact = `今日涨停 <b>${esc(payload.limitUpCount ?? '--')}</b> 家，最高板 <b>${esc(status.maxBoard ?? '--')}</b>`;
    infer = spans(n >= 80 ? ['涨停密集，情绪亢奋、主线清晰', '注意后排与高位分化'] : n >= 30 ? ['情绪温和恢复，聚焦核心'] : ['涨停清淡，情绪偏弱、等待确认']);
    advise = spans(n >= 80 ? ['高潮期去弱留强，警惕一致后的分歧'] : ['控制仓位，只做前排确定性']);
  } else if (key === 'emotion') {
    const ei = status.emotionIndex ?? null, lvl = status.level;
    fact = `情绪指数 <b>${esc(ei ?? '--')}</b>（${esc(lvl || '--')}）`;
    infer = spans(lvl === 'red' ? ['情绪极差，风险偏好低'] : lvl === 'orange' ? ['情绪转弱，需谨慎'] : ['情绪尚可，可积极']);
    advise = spans(ei != null && ei >= 80 ? ['高情绪对应高仓位档'] : ei != null && ei < 40 ? ['低情绪对应观望/小仓'] : ['按赢面仓位档执行']);
  } else if (key === 'height') {
    const mb = Number(status.maxBoard ?? 0);
    fact = `当前最高连板 <b>${esc(status.maxBoard ?? '--')}</b> 板`;
    infer = spans(mb >= 7 ? ['进入高位博弈，存在高切低/补涨龙玩法'] : mb >= 4 ? ['梯队完整，主升结构健康'] : ['高度压缩，处于启动/试探期']);
    advise = spans(mb >= 7 ? ['高位只做最核心，回避缩量加速'] : ['聚焦低位晋级与一进二']);
  } else if (key === 'breakrate') {
    const r = br;
    fact = `炸板率 <b>${esc(r ?? '--')}%</b>`;
    infer = spans(r != null && r >= 35 ? ['封板意愿弱、分歧大，资金畏高'] : r != null && r <= 20 ? ['封板坚决，情绪一致'] : ['分歧中等，注意盘中回封']);
    advise = spans(r != null && r >= 35 ? ['减少打板，等回封确认'] : ['可正常参与前排']);
  } else if (key === 'leader') {
    const top = leaders.slice(0, 5);
    fact = top.length ? `核心龙头：${top.slice(0, 3).map((l) => `${l.name}(${l.boards}板)`).join('、')}` : '暂未识别核心龙头';
    infer = spans(top.length ? top.map((l) => `${l.name} · ${l.role || '前排'}`) : ['题材分散，无明确龙头']);
    advise = spans(top.length ? ['聚焦龙头与其带动的题材梯队'] : ['等龙头分歧转一致再参与']);
  } else if (key === 'playable') {
    const tiers = opportunities.tiers || {};
    const sCount = (tiers.S || []).length, aCount = (tiers.A || []).length, bCount = (tiers.B || []).length;
    const playable = [...(tiers.S || []), ...(tiers.A || []), ...(tiers.B || [])].filter((s) => s.signal?.state === '可打').length;
    const risks = (radar.items || []).map((item) => `${item.label}（${item.score}）`).slice(0, 4);
    const cant = radar.cannotDo || [];
    fact = `机会池 S ${sCount} / A ${aCount} / B ${bCount}，其中<b>可打信号 ${playable}</b> 只`;
    infer = spans(risks.length ? risks : ['暂无显著风险']);
    advise = spans(cant.length ? cant.concat(['避开体系禁止的接力情形']) : ['优先 S/A 梯队、信号可打且换手充分的标的']);
  } else if (key === 'should') {
    const tiers = opportunities.tiers || {};
    const playable = [...(tiers.S || []), ...(tiers.A || []), ...(tiers.B || [])].filter((s) => s.signal?.state === '可打').length;
    const cant = radar.cannotDo || [];
    fact = `可打信号 <b>${playable}</b> 只${cant.length ? ` · 禁止 ${cant.length} 项` : ''}`;
    infer = spans(cant.length ? cant : ['无明确体系禁止，看前排确定性']);
    advise = spans(playable > 0 && !cant.length ? ['只在换手充分、检查表通过时出手'] : ['不出手也是一种操作']);
  } else if (key === 'retreat') {
    const weak = (status.level === 'red') || ['退潮', '退潮初期', '冰点'].includes(status.phase) || (br != null && br >= 35);
    fact = `退潮信号：${weak ? '存在' : '暂不明显'}`;
    infer = spans(weak ? ['高位断板/炸板率抬升/情绪转弱', '亏钱效应扩散'] : ['高位仍韧，赚钱效应尚可']);
    advise = spans(weak ? ['收缩仓位、停止高位接力、管住手'] : ['按阶段策略正常参与']);
  } else if (key === 'promotion') {
    const stocks = (payload.stocks || []).filter((s) => s.promo && s.promo.available !== false);
    const groups = { 可接力: [], 观望: [], 规避: [] };
    for (const s of stocks) (groups[s.promo.verdict] || groups.规避).push(s);
    const lineOf = (list) => list.length ? `${list.slice(0, 4).map((s) => `${s.name}(${s.boards || 1}板·${s.promo.score}分)`).join('、')}${list.length > 4 ? ' 等' : ''}` : '暂无——宁缺毋滥';
    const pa = payload.positionAdvice;
    fact = `体系检查表结论：可接力 ${groups['可接力'].length} / 观望 ${groups['观望'].length} / 规避 ${groups['规避'].length}`;
    infer = spans([lineOf(groups['可接力']), lineOf(groups['规避'])]);
    advise = spans([pa && pa.faultTolerance != null ? `${pa.cycle || '--'}周期约 ${Math.round(pa.faultTolerance * 100)}%（退潮期放弃高位接力）` : '阶段未知，按检查表逐项核对']);
  } else if (key === 'position') {
    const pa = payload.positionAdvice;
    if (!pa || pa.label === '--') { fact = '情绪指数不足，无法估算赢面'; infer = '数据样本不足'; advise = '空仓或极小仓观望'; }
    else {
      fact = `情绪指数 ${esc(payload.status?.emotionIndex ?? '--')} → 赢面映射建议：<b>${esc(pa.label)}</b>${pa.ratio != null ? `（约 ${Math.round(pa.ratio * 100)}% 仓）` : ''}`;
      infer = spans([pa.note, '永远把最高市值当作你的成本；把控制回撤当成重中之重']);
      advise = spans([(pa.label === '观望' ? '不开新仓' : `按 ${pa.label} 档控制总仓位`)]);
    }
  } else if (key === 'recede') {
    const notes = payload.mentalNotes || [];
    fact = `当前阶段：<b>${esc(payload.status?.phase || '--')}</b>`;
    infer = spans(notes.length ? notes.map((n) => `【${n.topic}】${n.text}`) : ['暂无心法']);
    advise = spans(['把心法作为纪律提醒，不替代交易系统']);
  } else if (key === 'tomorrow') {
    const strategy = phaseStrategy(status.phase) || {};
    fact = `当前阶段：<b>${esc(status.phase || '--')}</b>`;
    infer = spans(['明日方向取决于竞价与开盘确认']);
    advise = spans([('可参与：' + (strategy.allowed || []).join(' / ') || '等待方向选择'), ('禁止：' + (strategy.forbidden || []).join(' / ') || '无')]);
  } else if (key === 'health') {
    const h = payload.health;
    if (!h) { fact = '健康数据缺失'; infer = '无法评估数据源可信度'; advise = '以快照/缓存为准，谨慎决策'; }
    else {
      fact = `整体 ${h.ok ? '🟢 正常' : `🔴 ${h.message || '异常'}`}${h.latencyMs != null ? ` · 延迟 ${h.latencyMs}ms` : ''}`;
      infer = spans(Object.entries(h.sources || {}).map(([name, s]) => `${name} ${s.ok ? '🟢' : '🔴'}`));
      advise = spans(h.ok ? ['数据源正常，可信任当前行情'] : ['存在源缺失，优先参考仍可用的源']);
    }
  } else {
    fact = `市场处于 <b>${esc(status.phase || '--')}</b> 阶段，情绪指数 ${esc(status.emotionIndex ?? '--')}，涨停 ${esc(payload.limitUpCount ?? '--')} 家`;
    infer = spans(['该问题暂无专门分析模块，以上为当前盘面快照']);
    advise = spans(['结合阶段策略与风险雷达综合判断']);
  }
  return `<div class="report-card copilot-card"><div class="report-head"><strong>🤖 ${esc(title)}</strong><span>系统基于 ${esc(tradeDate)} 实时数据</span></div>` +
    copilotLayer('fact', '事实', fact) +
    copilotLayer('infer', '推断', infer) +
    copilotLayer('advise', '建议', advise) +
    `<div class="muted" style="font-size:11px;margin-top:6px">体系规则辅助参考，非投资建议</div></div>`;
}

/* ==================== 交易体系规则引擎（个人交易心得融入 · 2026-08） ====================
   纯函数无副作用；数据不足的维度诚实标 'na'，不猜。
   ⚠ 平行副本同步义务：本段与 D:\codex\analytics.js 的同名段落函数体保持一致，
   任何改动必须双向同步（桌面 CommonJS / 手机 ESM 仅外壳不同）。 */

const PROMO_RULES = {
  // 周期容错率（连板晋级体系）：主升>80% / 震荡修复≈50% / 退潮冰点<20%
  cycleFaultTolerance: { '主升': 0.8, '修复': 0.5, '退潮': 0.15 },
  // 封板时间分级（秒）：9:35 前秒板=顶级 / 10:30 前=优质 / 14:30 后=尾盘偷袭
  sealTopBefore: parseSealTime('093500'),
  sealGoodBefore: parseSealTime('103000'),
  sealWeakAfter: parseSealTime('143000'),
  // 竞价高开合格区间（%）：二板 +1~+3.5 / 三板及以上 +2~+5；避雷线：低开 / <+0.5 / >+7
  openBandBoard2: [1, 3.5],
  openBandBoard3Plus: [2, 5],
  openMicroHigh: 0.5,
  openSuperHigh: 7,
  // 封板质量：炸板 0=完美 / ≤2 合格 / ≥3 反复炸板淘汰
  breakPerfect: 0,
  breakOkMax: 2,
  breakFailMin: 3,
  // 各阶量能（% vs 昨量）：首→二放量 30~80 / 二→三缩量 20~40
  volUpStage12: [30, 80],
  volDownStage23: [-40, -20],
  // 高位门槛：七板以上才算高位/市场龙头，<7 板不存在高切低/补涨龙玩法
  highBoardThreshold: 7,
};

const PARAM_MANIFEST = {
  rules: { ...RULES },
  phaseStrategy: { ...PHASE_STRATEGY },
  promoRules: { ...PROMO_RULES },
  emotion: {
    confidenceDenominator: 10,
    indicators: {
      limitUp: { green: 80, yellow: 40 },
      limitDown: { green: 10, yellow: 20 },
      multiBoard: { green: 20, yellow: 10 },
      maxBoard: { green: 5, yellow: 3 },
      breakRate: { green: 20, yellow: 35 },
      firstPromotion: { green: 35, yellow: 20 },
      multiPromotion: { green: 45, yellow: 25 },
      marketBreakRate: { green: 20, yellow: 35 },
      firstBoardPremium: { green: 3, yellow: 1 },
      highBoardPremium: { green: 2, yellow: 0 }
    }
  }
};

// 情绪阶段 → 三大周期（连板晋级体系的周期天花板）
function cycleOf(phase) {
  const p = String(phase || '');
  if (p === '主升期' || p === '高潮') return '主升';
  if (p === '分歧期' || p === '高潮转分歧' || p === '修复') return '修复';
  if (p === '退潮初期' || p === '退潮' || p === '冰点') return '退潮';
  return null;
}

// 竞价判定（高开区间 + 弱转强）：openPct=今开/昨收%
function auctionVerdict(stock, ctx = {}) {
  const boards = Math.max(1, finiteNumber(stock.boards) || 1);
  const openPct = Number.isFinite(Number(ctx.openPct)) ? Number(ctx.openPct) : null;
  if (openPct === null) return { tag: null, note: '竞价数据不足' };
  const [lo, hi] = boards >= 3 ? PROMO_RULES.openBandBoard3Plus : PROMO_RULES.openBandBoard2;
  const prev = ctx.prevDay || null;
  const prevRotten = !!(prev && ((Number(prev.breakCount) || 0) >= 2 || (Number(prev.turnoverRate) || 0) >= 50));
  const volChg = Number.isFinite(Number(ctx.volChg)) ? Number(ctx.volChg) : null;
  if (openPct <= 0 || openPct > PROMO_RULES.openSuperHigh) {
    return { tag: '竞价避雷', note: openPct <= 0 ? '低开=隔夜分歧严重，无人接力' : '超级高开=情绪透支，防高开低走炸板兑现' };
  }
  if (prevRotten && openPct > 0 && (volChg === null || volChg > 0)) {
    return { tag: '弱转强', note: `昨日烂板${volChg !== null ? '且今日放量' : ''}高开——筹码换手确认，弱转强成立` };
  }
  if (openPct >= lo && openPct <= hi) return { tag: '竞价合格', note: `温和高开 ${openPct}%（${boards}板合格区间 ${lo}~${hi}%）` };
  if (openPct < PROMO_RULES.openMicroHigh) return { tag: '竞价避雷', note: '微高开≈平开，隔夜承接弱' };
  return { tag: null, note: `高开 ${openPct}%，偏离 ${boards}板合格区间 ${lo}~${hi}%` };
}

// K线特征（近端日线升序 bars：{date,open,close,high,low,volume}）
function klineFeatures(bars = []) {
  const rows = (bars || []).filter((b) => b && Number.isFinite(Number(b.close)) && Number(b.close) > 0);
  if (!rows.length) return { available: false };
  const last = rows[rows.length - 1];
  const prev = rows.length >= 2 ? rows[rows.length - 2] : null;
  const closes = rows.map((b) => Number(b.close));
  const ma = (n) => (closes.length >= n ? Number((closes.slice(-n).reduce((s, c) => s + c, 0) / n).toFixed(2)) : null);
  let volChg1d = null;
  if (prev && Number(prev.volume) > 0 && Number(last.volume) > 0) volChg1d = Math.round((Number(last.volume) / Number(prev.volume) - 1) * 100);
  // 跳空缺口：今日最低价仍高于昨日最高价 → 缺口未回补（成本保护价成立）
  const gapUnfilled = prev ? Number(last.low) > Number(prev.high) : null;
  // 回踩后首板确认（N 字简化）：近 10 根内先有涨停级大阳 → 连续 ≥2 根回落 → 今日再涨停级大阳
  let pullbackFirstBoard = false;
  const isBigUp = (b, refClose) => refClose > 0 && Number(b.close) >= refClose * 1.095;
  const todayBigUp = rows.length >= 2 && isBigUp(last, Number(rows[rows.length - 2].close));
  if (todayBigUp) {
    // 从昨日往回找最近的涨停级大阳（今日确认板本身不参与候选）
    for (let i = rows.length - 2; i >= 1 && i >= rows.length - 11; i -= 1) {
      if (!isBigUp(rows[i], Number(rows[i - 1].close))) continue;
      let downRun = 0;
      for (let j = i + 1; j <= rows.length - 2; j += 1) {
        if (Number(rows[j].close) < Number(rows[j - 1].close)) downRun += 1; else break;
      }
      if (downRun >= 2) pullbackFirstBoard = true;
      break; // 只看最近一次大阳信号
    }
  }
  return { available: true, volChg1d, gapUnfilled, ma5: ma(5), ma10: ma(10), ma20: ma(20), pullbackFirstBoard };
}

// 晋级评估器：八维检查表 + 结论。ctx 可缺维度（对应项标 na 并按可得权重归一化）
function assessPromotion(stock, ctx = {}) {
  const boards = Math.max(1, finiteNumber(stock.boards) || 1);
  const cycle = cycleOf(ctx.phase);
  const fault = cycle ? PROMO_RULES.cycleFaultTolerance[cycle] : null;
  const checklist = [];
  const push = (dim, label, status, note) => checklist.push({ dim, label, status, note });
  let earned = 0;
  let possible = 0;
  const scoreDim = (weight, status, ratio) => { possible += weight; earned += weight * ratio; };

  // ① 周期容错（25）
  if (fault === null) push('cycle', '周期容错', 'na', `情绪阶段「${ctx.phase || '未知'}」无法定周期`);
  else {
    scoreDim(25, undefined, fault);
    push('cycle', '周期容错', cycle === '主升' ? 'pass' : cycle === '修复' ? 'warn' : 'fail',
      `${cycle}周期 · 晋级容错≈${Math.round(fault * 100)}%${cycle === '退潮' ? '（放弃高位接力，试错只做首板）' : cycle === '修复' ? '（择优晋级，只做核心）' : '（容错极高，可拿晋级）'}`);
  }

  // ② 封板时间（20）
  const sealSec = parseSealTime(stock.firstSealTime);
  if (sealSec === null) push('seal', '封板时间', 'na', '首封时间缺失');
  else if (sealSec <= PROMO_RULES.sealTopBefore) { scoreDim(20, undefined, 1); push('seal', '封板时间', 'pass', `${stock.firstSealTime} 秒板级——做多意愿极致坚决`); }
  else if (sealSec <= PROMO_RULES.sealGoodBefore) { scoreDim(20, undefined, 0.75); push('seal', '封板时间', 'pass', `${stock.firstSealTime} 早盘硬板（10:30 前），主力意图明确`); }
  else if (sealSec >= PROMO_RULES.sealWeakAfter) { scoreDim(20, undefined, 0); push('seal', '封板时间', 'fail', `${stock.firstSealTime} 尾盘偷袭板——资金信心不足，次日炸板断板概率极高`); }
  else { scoreDim(20, undefined, 0.3); push('seal', '封板时间', 'warn', `${stock.firstSealTime} 午后封板，合力偏弱`); }

  // ③ 竞价承接（15）
  const av = auctionVerdict(stock, ctx);
  const openPct = Number.isFinite(Number(ctx.openPct)) ? Number(ctx.openPct) : null;
  if (openPct === null) push('auction', '竞价承接', 'na', '今开/昨收未取到');
  else if (av.tag === '竞价避雷') push('auction', '竞价承接', 'fail', av.note);
  else if (av.tag === '弱转强') { scoreDim(15, undefined, 1); push('auction', '竞价承接', 'pass', av.note); }
  else if (av.tag === '竞价合格') { scoreDim(15, undefined, 0.85); push('auction', '竞价承接', 'pass', av.note); }
  else { scoreDim(15, undefined, 0.35); push('auction', '竞价承接', 'warn', av.note); }

  // ④ 封板质量（15）
  const brk = stock.breakCountAvailable === false ? null : (finiteNumber(stock.breakCount) || 0);
  if (brk === null) push('quality', '封板质量', 'na', '炸板次数未知');
  else if (brk >= PROMO_RULES.breakFailMin) { scoreDim(15, undefined, 0); push('quality', '封板质量', 'fail', `反复炸板 ${brk} 次——获利盘疯狂兑现，勉强封板次日大概率低开`); }
  else if (brk === PROMO_RULES.breakPerfect) { scoreDim(15, undefined, 1); push('quality', '封板质量', 'pass', '一封封死不开板，筹码高度锁定'); }
  else { scoreDim(15, undefined, 0.6); push('quality', '封板质量', 'warn', `开过 ${brk} 次板但快速回封，属充分换手的健康晋级`); }

  // ⑤ 题材梯队（15）
  const themeSize = Number.isFinite(Number(ctx.themeSize)) ? Number(ctx.themeSize) : null;
  const role = String(ctx.role || stock.role || '');
  if (themeSize === null) push('theme', '题材梯队', 'na', '板块家数未知');
  else if (themeSize <= 1) push('theme', '题材梯队', 'fail', '孤立独板——无跟风无梯队，100% 无法晋级');
  else if (CORE_LEADER_ROLES.includes(role)) { scoreDim(15, undefined, 1); push('theme', '题材梯队', 'pass', `${role} · 板块 ${themeSize} 只涨停，抱团效应明显`); }
  else if (boards >= PROMO_RULES.highBoardThreshold) { scoreDim(15, undefined, 0.9); push('theme', '题材梯队', 'pass', `${boards} 板市场高度（≥7 板才算高位龙头），梯队 ${themeSize} 只`); }
  else if (themeSize >= 3) { scoreDim(15, undefined, 0.7); push('theme', '题材梯队', 'pass', `板块 ${themeSize} 只涨停，有梯队助攻`); }
  else { scoreDim(15, undefined, 0.3); push('theme', '题材梯队', 'warn', `板块仅 ${themeSize} 只涨停，梯队薄`); }

  // ⑥ 量能结构（10）：各阶缩放标准
  const volChg = Number.isFinite(Number(ctx.volChg)) ? Number(ctx.volChg) : null;
  if (volChg === null) push('volume', '量能结构', 'na', '无昨日成交量可比');
  else if (boards === 2) {
    const [lo, hi] = PROMO_RULES.volUpStage12;
    if (volChg >= lo && volChg <= hi) { scoreDim(10, undefined, 1); push('volume', '量能结构', 'pass', `较首板放量 ${volChg}%（合格 ${lo}~${hi}%），充分换手洗筹`); }
    else if (volChg < 0) { scoreDim(10, undefined, 0.2); push('volume', '量能结构', 'warn', `二板缩量 ${Math.abs(volChg)}%——筹码断层无接力空间，易炸板`); }
    else { scoreDim(10, undefined, 0.55); push('volume', '量能结构', 'warn', `较首板放量 ${volChg}%（超 ${hi}%），分歧偏大`); }
  } else if (boards === 3) {
    const [lo, hi] = PROMO_RULES.volDownStage23; // [-40, -20]，负值代表缩量
    if (volChg >= lo && volChg <= hi) { scoreDim(10, undefined, 1); push('volume', '量能结构', 'pass', `较二板缩量 ${Math.abs(volChg)}%（合格 ${Math.abs(lo)}~${Math.abs(hi)}%）——缩量加速是龙头最强信号`); }
    else if (volChg > 0) { scoreDim(10, undefined, 0.45); push('volume', '量能结构', 'warn', `三板仍放量 ${volChg}%——分歧未消化，锁仓资金不足`); }
    else { scoreDim(10, undefined, 0.6); push('volume', '量能结构', 'warn', `较二板缩量 ${Math.abs(volChg)}%，幅度超出常规区间`); }
  } else if (boards >= 4) {
    push('volume', '量能结构', volChg > 60 ? 'warn' : 'pass', volChg > 60 ? `高位爆量 ${volChg}%——持续爆量是见顶信号` : `高位交替缩放中（今较昨 ${volChg > 0 ? '+' : ''}${volChg}%），有序切换`);
    scoreDim(10, undefined, volChg > 60 ? 0.3 : 0.8);
  } else {
    push('volume', '量能结构', volChg >= 0 ? 'pass' : 'warn', `首板较昨量 ${volChg > 0 ? '+' : ''}${volChg}%`);
    scoreDim(10, undefined, volChg >= 0 ? 0.8 : 0.4);
  }

  // ⑦ 信息项：缺口保护 / 回踩首板确认 / 高位门槛提示（不计分，供抽屉展示）
  if (ctx.gapUnfilled === true) push('info', '缺口保护', 'pass', '跳空缺口未回补——主力成本保护价成立，上攻状态强烈');
  else if (ctx.gapUnfilled === false) push('info', '缺口保护', 'fail', '缺口已回补——做庄失败信号');
  if (ctx.pullbackFirstBoard === true) push('info', '二次回踩', 'pass', '回踩后的首个首板——板上确认买点（N 字启动）');
  if (boards >= 3 && boards < PROMO_RULES.highBoardThreshold) push('info', '身位提示', 'warn', `${boards} 板尚不足以判定市场龙头（≥${PROMO_RULES.highBoardThreshold} 板才有高切低/补涨龙玩法）`);

  // 硬否决 → 规避
  const hardFails = [];
  if (themeSize !== null && themeSize <= 1) hardFails.push('孤立独板');
  if (brk !== null && brk >= PROMO_RULES.breakFailMin) hardFails.push(`反复炸板 ${brk} 次`);
  if (sealSec !== null && sealSec >= PROMO_RULES.sealWeakAfter) hardFails.push('尾盘偷袭封板');
  if (openPct !== null && (openPct <= 0 || openPct > PROMO_RULES.openSuperHigh)) hardFails.push(openPct <= 0 ? '竞价低开' : '竞价超级高开');
  if (cycle === '退潮' && boards >= 3) hardFails.push('退潮周期高位板');

  const score = possible > 0 ? Math.round((earned / possible) * 100) : 0;
  let verdict;
  if (hardFails.length) verdict = '规避';
  else if (score >= 70) verdict = '可接力';
  else if (score >= 45) verdict = '观望';
  else verdict = '规避';
  return {
    available: true,
    score,
    verdict,
    faultTolerance: fault,
    hardFails,
    checklist,
    asOf: Date.now(),
    disclaimer: '体系规则辅助参考，非投资建议',
  };
}

// 养家赢面仓位表：<60% 观望 / 60-70 小仓 / 70-80 中仓 / 80-90 大仓 / ≥90 满仓
function winratePosition(winrate) {
  const w = Number(winrate);
  if (!Number.isFinite(w)) return { label: '--', ratio: null, note: '赢面未知' };
  if (w >= 90) return { label: '满仓', ratio: 1, note: '胜率与盈亏比俱佳的机会极少，重仓出击' };
  if (w >= 80) return { label: '大仓', ratio: 0.7, note: '上涨空间显著大于下跌空间' };
  if (w >= 70) return { label: '中仓', ratio: 0.45, note: '顺势参与，控制单笔回撤' };
  if (w >= 60) return { label: '小仓', ratio: 0.2, note: '试错仓，错了体面离开' };
  return { label: '观望', ratio: 0, note: '赢面不足，空仓也是交易' };
}

// 心法库：按当前情绪阶段自动浮现（phases 里 '*' 表示任何阶段都适用）
const MENTAL_NOTES = [
  { id: 'discipline-lock-profit', phases: ['*'], topic: '纪律', text: '大赚的时候要离场：只要还在桌上都属于浮盈，落袋为安才是最真实的。' },
  { id: 'discipline-self-control', phases: ['*'], topic: '纪律', text: '管住手，自控力执行力到位；如果卖飞了也不要急着追进去——我们已经赚到了。' },
  { id: 'koujuu-core', phases: ['分歧期', '高潮转分歧'], topic: '口诀', text: '分歧切核心，弱势切抱团：分歧时买核心股，弱势时买抱团股。' },
  { id: 'koujuu-chase', phases: ['*'], topic: '口诀', text: '追涨买的是确定性，追高是因为你看不懂。' },
  { id: 'koujuu-stoploss', phases: ['*'], topic: '口诀', text: '止损不是失败，死扛才是深渊；不要意淫自己手上的杂毛会反转。' },
  { id: 'koujuu-mainline', phases: ['*'], topic: '口诀', text: '有主线的时候做主线，没有主线的时候找主线；有了主线做龙头，没有龙头找龙回头。' },
  { id: 'koujuu-expectation', phases: ['*'], topic: '预期管理', text: '符合预期格局，不符合预期止损，超预期加仓。' },
  { id: 'koujuu-sell-high', phases: ['主升', '修复'], topic: '心态', text: '卖飞是常态，卖飞代表你的选股没有问题——选好下一个符合你审美的票。' },
  { id: 'retreat-no-high', phases: ['退潮初期', '退潮', '冰点'], topic: '周期', text: '退潮期容错率不足 20%：放弃二板以上接力，试错只做首板，管住手不强行交易。' },
  { id: 'retreat-goodnews', phases: ['退潮初期', '退潮', '冰点'], topic: '周期', text: '下跌趋势一旦形成，任何利好都是给你跑路的机会。' },
  { id: 'retreat-three-stage-late', phases: ['冰点'], topic: '周期', text: '弱势末期场外资金憋疯了：一旦出现高强度热点容易引发哄抢，可试错新题材，绝不恋战。' },
  { id: 'repair-pick-core', phases: ['分歧期', '高潮转分歧'], topic: '周期', text: '震荡修复周期晋级率约 50%：精挑细选只做核心龙头，杂毛直接淘汰。' },
  { id: 'main-up-trend', phases: ['主升期', '高潮'], topic: '周期', text: '主升周期低位连板晋级率超 80%：大胆接力、分歧低吸，以拿晋级为主，不轻易恐高。' },
  { id: 'yangjia-greedy', phases: ['主升期', '高潮'], topic: '心法', text: '别人贪婪我更贪婪：赢面大的主升里敢于重仓加仓；有走弱迹象时提前收紧风偏。' },
  { id: 'yangjia-position', phases: ['*'], topic: '仓位', text: '赢面定仓位：<60% 观望，60-70% 小仓，70-80% 中仓，80-90% 大仓，90% 以上才满仓。' },
  { id: 'yangjia-crowd', phases: ['*'], topic: '心法', text: '得散户心者得天下，人气所向牛股所在：市场聚焦的地方才是赚钱效应所在。' },
  { id: 'clean-trade', phases: ['*'], topic: '纪律', text: '干净的交易只有入场和出局：永不止盈永不止损指的是只有买入逻辑和卖出逻辑，做T只能当解套工具。' },
  { id: 'forget-cost', phases: ['*'], topic: '心态', text: '忘记成本：问自己若现在是空仓会怎么办——会买就拿着，会买别的就换股，会选择空仓就卖出。' },
  { id: 'predict-follow', phases: ['*'], topic: '方法论', text: '预测为末应变为本：预判建立预期，跟随决定买卖；一切以盘面为准。' },
  { id: 'new-theme-timing', phases: ['修复', '主升'], topic: '节奏', text: '新题材当天一般没机会：等批量首板分出龙一龙二，分歧转一致的那天才是上车点，分歧中不上。' },
  { id: 'high-switch-low', phases: ['分歧期', '退潮初期'], topic: '节奏', text: '高切低一定发生在龙头断板那天才有性价比；七板以下谈不上高切低和补涨龙。' },
  { id: 'supplement-dragon', phases: ['主升', '高潮'], topic: '节奏', text: '补涨龙出现在龙头高位断板当天，一字启动散户买不进；它的高度永远比龙头少一板以上。' },
  { id: 'space-board', phases: ['主升', '高潮'], topic: '打法', text: '空间板只做换手充分+承接强+题材正的晋级，缩量一字慎接。' },
  { id: 'weak-to-strong', phases: ['*'], topic: '打法', text: '烂板次日爆量高开=换庄确认弱转强成立可直接上车套利；但目的就是套利——不高开或平开都要走。' },
  { id: 'second-entry', phases: ['*'], topic: '打法', text: '二次回踩试错买点只上一层二层仓：第二天有负反馈可以体面离开，上攻放量上板的瞬间才能推仓位。' },
  { id: 'divergence-alive', phases: ['主升', '修复'], topic: '节奏', text: '天天有分歧才走得远，太过一致的死得快。' },
  { id: 'institution-bigcap', phases: ['*'], topic: '打法', text: '机构主导的大票做跟随不要轻易下车，每一次回调都是买点；出局是因为逻辑破了，不是因为有利润。' },
  { id: 'youzi-exit', phases: ['高潮'], topic: '离场', text: '游资票五个板之后顶部出现墓碑线或带爆量的大阴线，就是离场的时候。' },
  { id: 'small-dragon-exit', phases: ['高潮'], topic: '离场', text: '小龙头以小阴小阳上涨，突然有一天一个涨停板——这个时候就是离场的时候。' },
  { id: 'trial-order', phases: ['*'], topic: '方法论', text: '刺拳试探论：试错单小赚小亏不重要，重要的是借此感受市场情绪，决定何时出重拳。' },
  { id: 'long-run', phases: ['*'], topic: '心态', text: '交易是一个长期的过程，一朝一夕的得失不要看得太重；积小胜为大胜。' },
];

// 按当前阶段挑心法（优先贴合当前周期的，其次通用），最多 limit 条
function contextNotes(ctx = {}) {
  const phase = String(ctx.phase || '');
  const cycle = cycleOf(phase);
  const scored = MENTAL_NOTES.map((note) => {
    let rank = -1;
    if (note.phases.includes('*')) rank = 1;
    if (phase && note.phases.includes(phase)) rank = 3;
    else if (cycle && note.phases.includes(cycle)) rank = 2;
    return { note, rank };
  }).filter((x) => x.rank > 0).sort((a, b) => b.rank - a.rank);
  return scored.slice(0, Math.max(1, Number(ctx.limit) || 3)).map((x) => x.note);
}

export {
  finiteNumber, round, calculateBreakRate, summarizeTheme, groupThemes, buildThemeRanking,
  rankCoreLeaders, leaderScore, calculatePromotionStats, calculateRollingPromotion, buildModeMonitor, aggregateModeRates,
  calculateEmotionState, indicator, computeOpportunityScore, rankOpportunities, phaseStrategy, RULES, PHASE_STRATEGY,
  buyTypeOf, expectedGapOf, buildExpectationGap, buildRiskRadar, buildSignal, applyGate,
  buildSimilarDays, vectorOfStocks, marketSimilarity, approximatePhaseOf, trajectoryLabel, buildMarketStructure, stockSimilarCases,
  buildPlan, attributionOf, DEFAULT_RISK_LIMITS, evaluatePortfolioRisk, COPILOT_QUESTIONS, buildCopilotAnswer,
  PROMO_RULES as assessmentRules, assessPromotion, auctionVerdict, klineFeatures, cycleOf, winratePosition, MENTAL_NOTES, contextNotes
};
