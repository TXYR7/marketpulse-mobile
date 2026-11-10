'use strict';

/* =========================================================================
   买卖参考 · 独立因子引擎（2026-11-05）
   独立工具，不接看板判决引擎、不读写 any 看板状态。
   输入一只股票的日K + 现价，输出：
     ① 7 个因子的自身历史分位与等权合成分
     ② 该股历史上处于同档位时，后 1/3/5 日的胜率/均值/样本数
     ③ 买点/止损/目标价 + 按风险预算的股数与金额
   纪律：数据不足如实返回 available:false，不猜；因子权重等权，不在样本内优化。
   ========================================================================= */

const MIN_BARS = 60;          // 至少 60 根日K才有 60 日位置与均线
const PCTL_WINDOW = 250;      // 因子分位窗口：约 1 年交易日；滚动窗口防未来函数
const MIN_HISTORY_SAMPLES = 20; // 同档位样本少于此数不硬给结论
const LOT_SIZE = 100;         // A 股一手

const FACTOR_DEFS = [
  { key: 'limitGene', label: '涨停基因', dir: 1, note: '近 120 日涨停次数（股性活跃度）' },
  { key: 'trend', label: '趋势', dir: 1, note: 'MA5>MA10、MA10>MA20、收盘>MA20、MA20 向上，各 1 分' },
  { key: 'mom20', label: '动量', dir: 1, note: '20 日涨幅' },
  { key: 'rel20', label: '相对强度', dir: 1, note: '20 日涨幅 − 上证指数 20 日涨幅' },
  { key: 'vpAlign', label: '量价', dir: 1, note: '5 日均量/20 日均量 × 20 日涨跌方向（放量上涨为正）' },
  { key: 'position', label: '位置', dir: 1, note: '收盘在近 60 日高低区间中的位置' },
  { key: 'overheat', label: '乖离风险', dir: -1, note: '收盘对 MA20 的乖离，越大越扣分（防追高）' },
];

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmtPct(value) {
  const n = finite(value);
  if (n === null) return '--';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function avgAt(values, n, i) {
  if (i < n - 1) return null;
  let sum = 0;
  for (let j = i - n + 1; j <= i; j += 1) sum += Number(values[j]) || 0;
  return sum / n;
}

function maxAt(values, n, i) {
  if (i < n - 1) return null;
  let max = -Infinity;
  for (let j = i - n + 1; j <= i; j += 1) if (Number(values[j]) > max) max = Number(values[j]);
  return Number.isFinite(max) ? max : null;
}

function minAt(values, n, i) {
  if (i < n - 1) return null;
  let min = Infinity;
  for (let j = i - n + 1; j <= i; j += 1) if (Number(values[j]) < min) min = Number(values[j]);
  return Number.isFinite(min) ? min : null;
}

function floorLot(shares) {
  if (!Number.isFinite(shares) || shares <= 0) return 0;
  // +1e-6 抵消浮点误差（如 12300/12.3 得 999.9999999 被 floor 成 900）
  return Math.floor((shares + 1e-6) / LOT_SIZE) * LOT_SIZE;
}

function normalizeBars(rawBars) {
  const bars = [];
  for (const raw of rawBars || []) {
    const close = finite(raw?.close);
    const open = finite(raw?.open);
    const high = finite(raw?.high);
    const low = finite(raw?.low);
    if (close === null || close <= 0 || open === null || high === null || low === null) continue;
    bars.push({
      date: String(raw.date || ''),
      open,
      close,
      high,
      low,
      volume: finite(raw.volume) ?? 0,
      amount: finite(raw.amount),
      preClose: finite(raw.preClose),
    });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  // preClose 缺失时用上一根收盘补链（腾讯兜底/老缓存可能没有该字段）
  for (let i = 0; i < bars.length; i += 1) {
    if (bars[i].preClose === null) bars[i].preClose = i > 0 ? bars[i - 1].close : bars[i].open;
  }
  return bars;
}

function isLimitUp(bar, limitPct) {
  if (!bar || !Number.isFinite(bar.preClose) || bar.preClose <= 0) return false;
  const exact = Math.round(bar.preClose * (1 + limitPct / 100) * 100) / 100;
  return bar.close >= exact - 0.005;
}

// 逐日计算因子原值（升序 bars，至少 MIN_BARS 根）
function computeSeries(bars, { limitPct = 10, indexCloses = null } = {}) {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const volumes = bars.map((b) => b.volume);
  const out = [];
  for (let i = MIN_BARS - 1; i < bars.length; i += 1) {
    const close = closes[i];
    const ma5 = avgAt(closes, 5, i);
    const ma10 = avgAt(closes, 10, i);
    const ma20 = avgAt(closes, 20, i);
    const ma20Prev = i >= 24 ? avgAt(closes, 20, i - 5) : null;
    const trend = (ma5 !== null && ma10 !== null && ma5 > ma10 ? 1 : 0)
      + (ma10 !== null && ma20 !== null && ma10 > ma20 ? 1 : 0)
      + (ma20 !== null && close > ma20 ? 1 : 0)
      + (ma20Prev !== null && ma20 !== null && ma20 > ma20Prev ? 1 : 0);

    const mom20 = i >= 20 ? (close / closes[i - 20] - 1) * 100 : null;
    let rel20 = null;
    if (mom20 !== null && indexCloses) {
      const c0 = finite(indexCloses[bars[i].date]);
      const c20 = finite(indexCloses[bars[i - 20].date]);
      if (c0 !== null && c20 !== null && c20 > 0) rel20 = mom20 - (c0 / c20 - 1) * 100;
    }

    const vol5 = avgAt(volumes, 5, i);
    const vol20 = avgAt(volumes, 20, i);
    const volRatio = vol5 !== null && vol20 !== null && vol20 > 0 ? vol5 / vol20 : null;
    const vpAlign = volRatio !== null && mom20 !== null ? Math.sign(mom20) * volRatio : null;

    const high60 = maxAt(highs, 60, i);
    const low60 = minAt(lows, 60, i);
    const position = high60 !== null && low60 !== null && high60 > low60
      ? ((close - low60) / (high60 - low60)) * 100
      : null;
    const bias20 = ma20 !== null && ma20 > 0 ? (close / ma20 - 1) * 100 : null;

    let limitGene = 0;
    for (let j = Math.max(0, i - 119); j <= i; j += 1) if (isLimitUp(bars[j], limitPct)) limitGene += 1;

    out.push({ i, date: bars[i].date, close, ma5, ma10, ma20, trend, mom20, rel20, volRatio, vpAlign, position, bias20, limitGene });
  }
  return out;
}

// 滚动分位（当前值在过去 window 个交易日中的位置，0-100；并列取平均秩）
function rollingPercentile(values, window = PCTL_WINDOW) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i += 1) {
    const current = values[i];
    if (current === null || current === undefined || !Number.isFinite(current)) continue;
    const start = Math.max(0, i - window + 1);
    let less = 0;
    let equal = 0;
    let n = 0;
    for (let j = start; j <= i; j += 1) {
      const v = values[j];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      n += 1;
      if (v < current) less += 1;
      else if (v === current) equal += 1;
    }
    out[i] = n > 1 ? ((less + 0.5 * equal) / n) * 100 : 50;
  }
  return out;
}

function buildPercentiles(series) {
  const values = (key) => series.map((row) => row[key]);
  return {
    limitGene: rollingPercentile(values('limitGene')),
    trend: rollingPercentile(values('trend')),
    mom20: rollingPercentile(values('mom20')),
    rel20: rollingPercentile(values('rel20')),
    vpAlign: rollingPercentile(values('vpAlign')),
    position: rollingPercentile(values('position')),
    overheat: rollingPercentile(values('bias20')),
  };
}

// 等权合成分：因子分位按方向折算后平均；至少 4 个因子可得才出分
function compositeSeries(series, percentiles) {
  return series.map((_, idx) => {
    let sum = 0;
    let n = 0;
    for (const def of FACTOR_DEFS) {
      const p = percentiles[def.key]?.[idx];
      if (p === null || p === undefined || !Number.isFinite(p)) continue;
      sum += def.dir === 1 ? p : 100 - p;
      n += 1;
    }
    return n >= 4 ? sum / n : null;
  });
}

function percentileOf(value, values) {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length < 10) return null;
  let less = 0;
  let equal = 0;
  for (const v of usable) {
    if (v < value) less += 1;
    else if (v === value) equal += 1;
  }
  return ((less + 0.5 * equal) / usable.length) * 100;
}

function wilsonLow(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return ((center - margin) / denom) * 100;
}

// 同档位历史：当前分数 ±band 分内的历史样本，后 1/3/5 日表现
function historyStats(bars, series, composite, currentScore) {
  const samples = series.map((row, idx) => ({ i: row.i, score: composite[idx] })).filter((s) => s.score !== null);
  const horizons = [1, 3, 5];
  const collect = (band) => {
    const picked = samples.filter((s) => Math.abs(s.score - currentScore) <= band);
    const byHorizon = horizons.map((days) => {
      const rows = picked.map((s) => {
        if (s.i + days >= bars.length) return null;
        const from = bars[s.i].close;
        const to = bars[s.i + days].close;
        return from > 0 ? ((to / from - 1) * 100) : null;
      }).filter((v) => v !== null);
      const n = rows.length;
      const up = rows.filter((v) => v > 0).length;
      return {
        days,
        n,
        winRate: n ? round((up / n) * 100, 0) : null,
        winRateLow: n ? round(wilsonLow(up, n), 0) : null,
        mean: n ? round(rows.reduce((a, b) => a + b, 0) / n, 2) : null,
      };
    });
    return { band, samples: picked.length, horizons: byHorizon };
  };
  // 先 ±10 分；样本不足逐步放宽到 ±15 / ±20
  let chosen = collect(10);
  if ((chosen.horizons.find((h) => h.days === 5)?.n || 0) < MIN_HISTORY_SAMPLES) chosen = collect(15);
  if ((chosen.horizons.find((h) => h.days === 5)?.n || 0) < MIN_HISTORY_SAMPLES) chosen = collect(20);
  const fiveDay = chosen.horizons.find((h) => h.days === 5);
  chosen.insufficient = !fiveDay || fiveDay.n < MIN_HISTORY_SAMPLES;
  // 基准：全部历史样本（同口径）
  const base = horizons.map((days) => {
    const rows = samples.map((s) => {
      if (s.i + days >= bars.length) return null;
      const from = bars[s.i].close;
      const to = bars[s.i + days].close;
      return from > 0 ? ((to / from - 1) * 100) : null;
    }).filter((v) => v !== null);
    const n = rows.length;
    const up = rows.filter((v) => v > 0).length;
    return { days, n, winRate: n ? round((up / n) * 100, 0) : null, mean: n ? round(rows.reduce((a, b) => a + b, 0) / n, 2) : null };
  });
  return { ...chosen, base, scorePercentile: round(percentileOf(currentScore, composite), 0) };
}

// 价格结构位：均线 / 60-120 日高低 / ATR
function buildLevels(bars, price) {
  const n = bars.length;
  const last = n - 1;
  if (last < MIN_BARS - 1) return null;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  // ATR14：当日真实波幅的 14 日平均
  const trs = [];
  for (let i = Math.max(1, last - 13); i <= last; i += 1) {
    const prev = bars[i - 1].close;
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prev), Math.abs(bars[i].low - prev)));
  }
  const atr = trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : null;
  const ma20 = avgAt(closes, 20, last);
  const highestClose20 = maxAt(closes, 20, last);
  return {
    ma5: round(avgAt(closes, 5, last), 2),
    ma10: round(avgAt(closes, 10, last), 2),
    ma20: round(ma20, 2),
    ma60: round(avgAt(closes, 60, last), 2),
    high60: round(maxAt(highs, 60, last), 2),
    low60: round(minAt(lows, 60, last), 2),
    high120: round(maxAt(highs, 120, last), 2),
    low120: round(minAt(lows, 120, last), 2),
    atr: round(atr, 3),
    atrPct: atr && price > 0 ? round((atr / price) * 100, 2) : null,
    bias20: ma20 && price > 0 ? round((price / ma20 - 1) * 100, 2) : null,
    highestClose20: round(highestClose20, 2),
  };
}

// 止损：MA20 与 2×ATR 里取离现价更近、但至少留 1×ATR 空间的一档
function stopFor(entry, levels) {
  const atr = finite(levels?.atr);
  if (!atr || atr <= 0 || !Number.isFinite(entry) || entry <= 0) return null;
  const candidates = [];
  if (finite(levels.ma20) !== null && levels.ma20 < entry) candidates.push({ price: levels.ma20, basis: 'MA20' });
  candidates.push({ price: entry - 2 * atr, basis: '2×ATR' });
  const valid = candidates.filter((c) => c.price <= entry - atr);
  valid.sort((a, b) => b.price - a.price);
  const chosen = valid[0] || { price: entry - 2 * atr, basis: '2×ATR' };
  return { price: round(chosen.price, 2), basis: chosen.basis, pct: round(((chosen.price / entry) - 1) * 100, 2) };
}

function targetFor(entry, levels, multiple = 2) {
  const atr = finite(levels?.atr);
  if (!atr || atr <= 0) return null;
  const high60 = finite(levels.high60);
  const high120 = finite(levels.high120);
  const first = high60 !== null && high60 > entry ? high60 : (high120 !== null && high120 > entry ? high120 : entry + multiple * atr);
  let second = Math.max(entry + 3 * atr, first + atr, high120 !== null && high120 > first ? high120 : -Infinity);
  if (!Number.isFinite(second) || second <= first) second = first + atr;
  return {
    first: { label: '第一目标', price: round(first, 2), pct: round(((first / entry) - 1) * 100, 2) },
    second: { label: '第二目标', price: round(second, 2), pct: round(((second / entry) - 1) * 100, 2) },
  };
}

function scoreLabelOf(score) {
  if (score === null) return '数据不足';
  if (score >= 75) return '强';
  if (score >= 60) return '偏强';
  if (score >= 45) return '中性';
  if (score >= 30) return '偏弱';
  return '弱';
}

function historyBiasOf(history) {
  if (!history || history.insufficient) return null;
  const h5 = (history.horizons || []).find((h) => h.days === 5);
  if (!h5 || h5.n < MIN_HISTORY_SAMPLES || h5.winRate === null) return null;
  const base = (history.base || []).find((b) => b.days === 5);
  return {
    winRate: h5.winRate,
    mean: h5.mean,
    n: h5.n,
    band: history.band,
    baseWinRate: base?.winRate ?? null,
    winEdge: h5.winRate - (base?.winRate ?? 50),
    meanEdge: h5.mean - (base?.mean ?? 0),
  };
}

function buildBuyPlan({ price, score, scoreLabel, levels, series, percentiles, inputs, history }) {
  const atr = finite(levels?.atr);
  const atrPct = finite(levels?.atrPct);
  const biasNow = finite(levels?.bias20);
  const ma10 = finite(levels?.ma10);
  const ma20 = finite(levels?.ma20);
  const high60 = finite(levels?.high60);
  const overextended = biasNow !== null && atrPct !== null && biasNow > atrPct * 2;
  const pullbackEntry = ma10 !== null && ma10 < price ? ma10 : (ma20 !== null && ma20 < price ? ma20 : null);
  const breakoutEntry = high60 !== null && high60 > price ? high60 : null;
  const latest = series[series.length - 1];
  const vpAlign = finite(latest?.vpAlign);
  const bias = historyBiasOf(history);

  // 建议以「该股自身同档位历史」为准：同因子状态在这只股票历史上是涨是跌，由它自己的样本说话。
  // 分数只描述状态，不直接当看多分（模型体检显示趋势/动量在涨停池样本上呈反转）。
  let stance = '观望';
  let stanceTone = 'wait';
  if (bias) {
    if (bias.winEdge >= 5 && bias.meanEdge > 0 && !overextended) { stance = '同档偏强 · 可买'; stanceTone = 'buy'; }
    else if (bias.winEdge >= 5 && bias.meanEdge > 0 && overextended) { stance = '同档偏强 · 等回踩'; stanceTone = 'wait'; }
    else if (bias.winEdge <= -5 || bias.meanEdge < -0.3) { stance = '同档偏弱 · 不建议'; stanceTone = 'avoid'; }
    else { stance = '同档中性 · 观望'; stanceTone = 'wait'; }
  } else if (score === null) {
    stance = '数据不足'; stanceTone = 'wait';
  } else if (score < 45) {
    stance = '样本不足 · 不建议'; stanceTone = 'avoid';
  } else if (overextended) {
    stance = '样本不足 · 等回踩'; stanceTone = 'wait';
  } else if (score >= 60) {
    stance = '样本不足 · 可关注'; stanceTone = 'wait';
  } else {
    stance = '样本不足 · 观望'; stanceTone = 'wait';
  }

  const action = stance.includes(' · ') ? stance.split(' · ').pop() : stance;
  let summary;
  if (stanceTone === 'buy') summary = '同档位历史偏强且未过热，可按回踩位分批；跌破止损即离场。';
  else if (stanceTone === 'avoid') summary = '同档位历史偏弱，按本模型不参与买入；若已持有看卖出参考。';
  else if (!bias) summary = '同档位样本不足（<20），按价格结构给参考，不构成买入信号。';
  else if (overextended) summary = `现价对 MA20 乖离 ${fmtPct(biasNow)}，超过 2×ATR，不追；等回踩 ${pullbackEntry !== null ? round(pullbackEntry, 2) : 'MA10/MA20'} 缩量企稳。`;
  else summary = `同档位历史中性，等回踩 ${pullbackEntry !== null ? round(pullbackEntry, 2) : 'MA10/MA20'}${breakoutEntry !== null ? ` 或放量突破 ${round(breakoutEntry, 2)}` : ''} 再看。`;

  // 执行价：可买=现价；等回踩=回踩位；不建议=现价仅供参考
  const entryPrice = (stanceTone === 'buy' ? price : (pullbackEntry ?? price));
  const entryLabel = stanceTone === 'buy' ? '现价' : (pullbackEntry !== null ? '回踩位' : '现价');
  const stop = stopFor(entryPrice, levels);
  const targets = targetFor(entryPrice, levels);
  const rr = stop && targets && entryPrice > stop.price
    ? round((targets.first.price - entryPrice) / (entryPrice - stop.price), 2)
    : null;

  const reasons = [];
  reasons.push(`评分 ${score === null ? '--' : score}（${scoreLabel}）· 自身历史分位`);
  if (bias) reasons.push(`同档位历史：后 5 日胜率 ${bias.winRate}%（基准 ${bias.baseWinRate ?? '--'}%），均值 ${fmtPct(bias.mean)}，n=${bias.n}（±${bias.band} 分）`);
  else reasons.push('同档位历史样本不足（<20），以下按分数档位与价格结构给参考');
  if (latest) {
    reasons.push(`趋势 ${latest.trend}/4，20 日动量 ${fmtPct(latest.mom20)}${latest.rel20 !== null ? `，超额 ${fmtPct(latest.rel20)}` : ''}`);
    reasons.push(`涨停基因：近 120 日 ${latest.limitGene} 次`);
  }
  if (biasNow !== null) reasons.push(`现价对 MA20 乖离 ${fmtPct(biasNow)}${overextended ? '，超过 2×ATR，不追' : ''}`);
  if (vpAlign !== null) reasons.push(`量价 ${vpAlign.toFixed(2)}（${vpAlign > 1 ? '放量' : vpAlign < -1 ? '放量下跌' : '量能一般'}）`);
  if (stanceTone === 'buy') reasons.push('同档位历史偏强且未过热，可按回踩位分批；跌破止损即离场');
  if (stanceTone === 'avoid') reasons.push('同档位历史偏弱，按本模型不参与买入；若已持有见卖出参考');
  if (stanceTone === 'wait') reasons.push('等回踩 MA10/MA20 缩量企稳，或放量突破再看，现价不追');

  const entries = [];
  if (pullbackEntry !== null) entries.push({ label: '回踩买点', price: round(pullbackEntry, 2), note: 'MA10/MA20，缩量企稳' });
  if (breakoutEntry !== null) entries.push({ label: '突破买点', price: round(breakoutEntry, 2), note: '60 日高，放量确认' });
  entries.push({ label: '现价', price: round(price, 2), note: stance === '可买入' || stance === '突破可跟' ? '当前可执行' : '当前不建议追' });

  // 仓位：金额上限 × 风险预算，取更小者；股数按整手
  const sizing = { capital: null, riskPct: null, riskBudget: null, amount: null, shares: null, amountUsed: null, maxLoss: null, maxLossPct: null, entryPrice: round(entryPrice, 2), entryLabel, note: '' };
  if (entryPrice && stop) {
    const riskPerShare = entryPrice - stop.price;
    const amount = finite(inputs?.amount);
    const capital = finite(inputs?.capital);
    const riskPct = finite(inputs?.riskPct) ?? 1;
    const sharesByAmount = amount !== null ? floorLot(amount / entryPrice) : null;
    const riskBudget = capital !== null ? (capital * riskPct) / 100 : null;
    const sharesByRisk = riskBudget !== null && riskPerShare > 0 ? floorLot(riskBudget / riskPerShare) : null;
    let shares = null;
    if (sharesByAmount !== null && sharesByRisk !== null) shares = Math.min(sharesByAmount, sharesByRisk);
    else shares = sharesByAmount ?? sharesByRisk;
    if (shares !== null) {
      const amountUsed = round(shares * entryPrice, 2);
      const maxLoss = round(shares * riskPerShare, 2);
      sizing.capital = capital;
      sizing.riskPct = riskPct;
      sizing.riskBudget = round(riskBudget, 2);
      sizing.amount = amount;
      sizing.shares = shares;
      sizing.amountUsed = amountUsed;
      sizing.maxLoss = maxLoss;
      sizing.maxLossPct = capital ? round((maxLoss / capital) * 100, 2) : null;
      if (shares === 0) sizing.note = '按当前执行价，预算不足一手（100 股）';
      else if (sharesByRisk !== null && sharesByAmount !== null && sharesByRisk < sharesByAmount) sizing.note = `按 ${riskPct}% 风险预算最多 ${sharesByRisk / 100} 手；已从你的金额上限下调`;
      else if (sharesByRisk !== null && sharesByAmount !== null && sharesByAmount < sharesByRisk) sizing.note = `按投入金额最多 ${sharesByAmount / 100} 手（风险预算允许 ${sharesByRisk / 100} 手）`;
      else if (sharesByRisk === null) sizing.note = `按投入金额 ${shares / 100} 手`;
      else sizing.note = `按 ${riskPct}% 风险预算 ${shares / 100} 手`;
    }
  } else {
    sizing.note = '缺少 ATR/止损位，暂不计算仓位';
  }

  return {
    mode: 'buy',
    stance,
    stanceTone,
    action,
    summary,
    entryPrice: entryPrice ? round(entryPrice, 2) : null,
    reasons,
    entries,
    stop,
    targets: targets ? [targets.first, targets.second] : [],
    rr,
    sizing,
  };
}

function buildHoldPlan({ price, score, scoreLabel, levels, inputs, history }) {
  const cost = finite(inputs?.cost);
  const amount = finite(inputs?.amount);
  let shares = finite(inputs?.shares);
  if ((shares === null || shares <= 0) && cost !== null && cost > 0 && amount !== null) shares = floorLot(amount / cost);
  if (shares === null || shares <= 0) {
    return {
      mode: 'hold', stance: '待补全', stanceTone: 'wait', action: '待补全',
      summary: '请填「数量」或「投入金额」，才能算浮动盈亏与止损金额。',
      reasons: ['请填「数量」或「投入金额」，才能算浮动盈亏与止损金额'],
      entries: [], stop: null, targets: [], rr: null, sizing: { note: '' }, position: null,
    };
  }
  const costValue = round(cost * shares, 2);
  const value = round(price * shares, 2);
  const pnl = round(value - costValue, 2);
  const pnlPct = cost > 0 ? round(((price / cost) - 1) * 100, 2) : null;

  const stop = stopFor(price, levels);
  const trailingPrice = levels?.highestClose20 !== null && levels?.atr
    ? levels.highestClose20 - 2 * levels.atr
    : null;
  const trailing = trailingPrice !== null && Number.isFinite(trailingPrice)
    ? { price: round(trailingPrice, 2), note: '最高收盘 − 2×ATR（移动止盈）' }
    : null;
  const activeStop = stop && trailing && trailing.price > stop.price ? { ...stop, price: trailing.price, basis: '移动止盈' } : stop;
  const reducePrice = levels?.ma10 !== null && levels.ma10 < price && (!activeStop || levels.ma10 > activeStop.price) ? levels.ma10 : null;
  const bias = historyBiasOf(history);

  let stance = '持有';
  let stanceTone = 'buy';
  if (activeStop && price <= activeStop.price) { stance = '止损/离场'; stanceTone = 'exit'; }
  else if (trailing && trailing.price >= price) { stance = '移动止盈触发'; stanceTone = 'exit'; }
  else if (bias && (bias.winEdge <= -5 || bias.meanEdge < -0.3)) { stance = '同档偏弱 · 减仓'; stanceTone = 'wait'; }
  else if (bias && bias.winEdge >= 5 && bias.meanEdge > 0) { stance = '同档偏强 · 持有'; stanceTone = 'buy'; }
  else if (score !== null && score < 35) { stance = '离场'; stanceTone = 'exit'; }
  else if (score !== null && score < 50) { stance = '减仓'; stanceTone = 'wait'; }
  else if (score !== null && score < 65) { stance = '持有观察'; stanceTone = 'wait'; }

  const action = stance.includes(' · ') ? stance.split(' · ').pop() : stance;
  let summary;
  if (stanceTone === 'exit') {
    summary = activeStop && price <= activeStop.price
      ? `已跌破 ${activeStop.price}（${activeStop.basis}），按纪律离场。`
      : '评分或移动止盈触发，按纪律离场。';
  } else if (stance === '同档偏弱 · 减仓') {
    summary = `同档位历史偏弱，建议减仓；跌破 ${activeStop?.price ?? '关键位'} 离场。`;
  } else {
    summary = `趋势未破，持有并跟踪止损；跌破 ${activeStop?.price ?? '关键位'} 离场。`;
  }

  const stopLossFromNow = activeStop ? round(Math.max(0, price - activeStop.price) * shares, 2) : null;
  const totalLossFromCost = activeStop && cost !== null ? round((cost - activeStop.price) * shares, 2) : null;
  const targets = targetFor(price, levels);

  const reasons = [];
  reasons.push(`评分 ${score === null ? '--' : score}（${scoreLabel}）· 自身历史分位`);
  reasons.push(`成本 ${cost === null ? '--' : cost} × ${shares} 股 = ${costValue === null ? '--' : costValue} 元，现价 ${round(price, 2)}，浮动 ${pnl >= 0 ? '+' : ''}${pnl} 元（${fmtPct(pnlPct)}）`);
  if (bias) reasons.push(`同档位历史：后 5 日胜率 ${bias.winRate}%（基准 ${bias.baseWinRate ?? '--'}%），均值 ${fmtPct(bias.mean)}，n=${bias.n}（±${bias.band} 分）`);
  else reasons.push('同档位历史样本不足（<20），按价格结构与评分档位给参考');
  if (activeStop) reasons.push(`关键位 ${activeStop.price}（${activeStop.basis}）${price <= activeStop.price ? '，已跌破' : '，跌破离场'}`);
  if (reducePrice !== null) reasons.push(`跌破 ${round(reducePrice, 2)}（MA10）先减半`);
  if (activeStop && price <= activeStop.price) reasons.push('已跌破关键位，按纪律离场（不等待反弹）');
  else if (stopLossFromNow !== null) reasons.push(`若现在触发止损，按现价再亏 ${stopLossFromNow} 元`);
  if (totalLossFromCost !== null) {
    reasons.push(totalLossFromCost >= 0
      ? `相对成本总亏损 ${totalLossFromCost} 元`
      : `止损位高于成本，触发时仍盈利 ${Math.abs(totalLossFromCost)} 元`);
  }
  if (trailing && (!activeStop || trailing.price !== activeStop.price)) reasons.push(`移动止盈线 ${trailing.price}（最高收盘 − 2×ATR）`);

  return {
    mode: 'hold',
    stance,
    stanceTone,
    action,
    summary,
    entryPrice: null,
    reasons,
    entries: [],
    stop: activeStop,
    reduce: reducePrice !== null ? { price: round(reducePrice, 2), note: '跌破先减半' } : null,
    trailing,
    targets: targets ? [targets.first, targets.second] : [],
    rr: null,
    sizing: { note: '' },
    position: {
      cost: round(cost, 2),
      shares,
      costValue,
      value,
      pnl,
      pnlPct,
      stopLossFromNow,
      totalLossFromCost,
      breakeven: round(cost, 2),
    },
  };
}

function analyze({ bars: rawBars, price: rawPrice, quote, limitPct = 10, indexCloses = null, mode = 'buy', inputs = {}, code = '', name = '' }) {
  const bars = normalizeBars(rawBars);
  if (bars.length < MIN_BARS) {
    return { available: false, code, name, reason: `日K仅 ${bars.length} 根，至少需要 ${MIN_BARS} 根（新股/停牌数据不足）` };
  }
  const lastBar = bars[bars.length - 1];
  const price = finite(rawPrice) > 0 ? Number(rawPrice) : lastBar.close;
  const series = computeSeries(bars, { limitPct, indexCloses });
  if (!series.length) return { available: false, code, name, reason: '因子序列为空' };
  const percentiles = buildPercentiles(series);
  const composite = compositeSeries(series, percentiles);
  const currentScoreRaw = composite[composite.length - 1];
  if (currentScoreRaw === null || !Number.isFinite(currentScoreRaw)) {
    return { available: false, code, name, reason: '可用因子不足 4 个，无法合成分' };
  }
  const score = Math.round(currentScoreRaw);
  const scoreLabel = scoreLabelOf(score);
  const latest = series[series.length - 1];
  const latestPct = {};
  for (const def of FACTOR_DEFS) latestPct[def.key] = percentiles[def.key]?.[percentiles[def.key].length - 1] ?? null;

  const factors = FACTOR_DEFS.map((def) => {
    // 乖离风险因子的原值存在 bias20 字段（方向为反向）
    const raw = def.key === 'overheat' ? latest.bias20 : latest[def.key];
    const p = latestPct[def.key];
    const scoreValue = p === null ? null : (def.dir === 1 ? p : 100 - p);
    let display = '--';
    if (def.key === 'limitGene') display = `近120日涨停 ${raw ?? 0} 次`;
    else if (def.key === 'trend') display = `均线 ${raw ?? 0}/4`;
    else if (def.key === 'mom20') display = `20日 ${fmtPct(raw)}`;
    else if (def.key === 'rel20') display = raw === null ? '指数数据缺失' : `20日超额 ${fmtPct(raw)}`;
    else if (def.key === 'vpAlign') display = raw === null ? '--' : `量价 ${raw.toFixed(2)}`;
    else if (def.key === 'position') display = raw === null ? '--' : `60日位置 ${Math.round(raw)}%`;
    else if (def.key === 'overheat') display = raw === null ? '--' : `MA20乖离 ${fmtPct(raw)}`;
    return { key: def.key, label: def.label, note: def.note, display, raw: round(raw, 2), percentile: scoreValue === null ? null : Math.round(scoreValue) };
  });

  const levels = buildLevels(bars, price);
  const history = historyStats(bars, series, composite, score);
  const plan = mode === 'hold'
    ? buildHoldPlan({ price, score, scoreLabel, levels, inputs, history })
    : buildBuyPlan({ price, score, scoreLabel, levels, series, percentiles, inputs, history });

  const preClose = finite(quote?.preClose) > 0 ? Number(quote.preClose) : lastBar.preClose;
  const changePct = preClose > 0 ? round(((price / preClose) - 1) * 100, 2) : null;
  // 近 120 日收盘 + MA20（多取 20 根，保证前段 MA 有值）
  const chartTail = bars.slice(-140);
  const chartMa = chartTail.map((_, i) => {
    if (i < 19) return null;
    let sum = 0;
    for (let j = i - 19; j <= i; j += 1) sum += chartTail[j].close;
    return round(sum / 20, 2);
  });
  const chart = {
    bars: chartTail.slice(-120).map((b) => ({ date: b.date, close: round(b.close, 2) })),
    ma20: chartMa.slice(-120),
  };
  return {
    available: true,
    model: 'advisor-v1',
    code,
    name: name || code,
    price: round(price, 2),
    changePct,
    asOfBar: lastBar.date,
    bars: bars.length,
    chart,
    score,
    scoreLabel,
    scorePercentile: history.scorePercentile,
    factors,
    history,
    levels,
    plan,
    inputs: {
      mode,
      capital: finite(inputs.capital),
      riskPct: finite(inputs.riskPct) ?? 1,
      amount: finite(inputs.amount),
      cost: finite(inputs.cost),
      shares: finite(inputs.shares),
    },
  };
}

export {
  analyze,
  normalizeBars,
  computeSeries,
  rollingPercentile,
  buildPercentiles,
  compositeSeries,
  historyStats,
  buildLevels,
  stopFor,
  scoreLabelOf,
  FACTOR_DEFS,
  MIN_BARS,
};
