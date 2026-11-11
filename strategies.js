'use strict';

// 策略版本注册表：集中管理可回测的策略。筛选条件：
//   mode: 入场板位（见 MODE_BOARDS）
//   themeMin:      该股当日所属题材强度下限（0-100，单日池内快算）
//   themeRankMax:  该股在其题材内部的排名上限（1 为题材内龙头）
//   requirePhase:  仅在指定情绪阶段参与（历史回测无情绪数据时视为放行）
const STRATEGIES = [
  { id: 'v1.0', version: 'V1.0', name: '一进二', mode: '一进二', desc: '买入当日二板（昨首板晋级）' },
  { id: 'v1.1', version: 'V1.1', name: '一进二+强题材', mode: '一进二', themeMin: 60, desc: '题材强度≥60' },
  { id: 'v1.2', version: 'V1.2', name: '一进二+强题材+板块前三', mode: '一进二', themeMin: 60, themeRankMax: 3, desc: '题材≥60 且板块内排名≤3' },
  { id: 'v2.0', version: 'V2.0', name: '一进二+情绪过滤', mode: '一进二', requirePhase: ['主升期', '修复'], desc: '仅在主升/修复期参与（历史无情绪数据时视为放行）' },
  { id: 'v3.0', version: 'V3.0', name: '分歧切核心·回封', buyType: '分歧回封', desc: '炸板后回封（分歧转一致）' },
  { id: 'v3.1', version: 'V3.1', name: '弱转强·分歧转一致', buyType: '弱转强', desc: '高位炸板后弱转强' },
  { id: 'v3.2', version: 'V3.2', name: '龙头反包', buyType: '龙头反包', desc: '断板后龙头反包' },
  { id: 'v3.3', version: 'V3.3', name: '断板重来', buyType: '断板重来', desc: '断板后再起' },
  { id: 'v4.0', version: 'V4.0', name: '首板', mode: '首板', desc: '买入当日首板（昨未涨停、今日首次封板）' },
  { id: 'v4.1', version: 'V4.1', name: '强修复·首板', mode: '首板', requirePhase: ['修复'], themeMin: 60, desc: '仅修复期参与 + 题材强度≥60' },
  { id: 'v4.2', version: 'V4.2', name: '弱修复·首板', mode: '首板', requirePhase: ['修复'], desc: '仅修复期参与（门槛更宽）' },
  { id: 'v4.3', version: 'V4.3', name: '抱团核心·一进二', mode: '一进二', themeRankMax: 1, desc: '题材内龙头/核心晋级（板块排名≤1）' }
];

const MODE_BOARDS = { '首板': 1, '一进二': 2, '二进三': 3, '三进四': 4, '高位加速': 5 };

function strategyMatches(strategy, stock, dayCtx = {}) {
  if (!strategy || !stock) return false;
  if (strategy.mode) {
    const boards = Number(stock.boards) || 1;
    const target = MODE_BOARDS[strategy.mode];
    if (target === undefined) return false;
    if (strategy.mode === '高位加速') { if (boards < target) return false; }
    else if (boards !== target) return false;
  }
  if (strategy.themeMin !== undefined) {
    const score = dayCtx.themeScoreByCode?.get(stock.code);
    if (score === undefined || score < strategy.themeMin) return false;
  }
  if (strategy.themeRankMax !== undefined) {
    const rank = dayCtx.rankByCode?.get(stock.code);
    if (rank === undefined || rank > strategy.themeRankMax) return false;
  }
  if (strategy.requirePhase?.length && dayCtx.phase && !strategy.requirePhase.includes(dayCtx.phase)) return false;
  if (strategy.minTurnover !== undefined) {
    const rate = Number(stock.turnoverRate);
    if (Number.isFinite(rate) && rate < strategy.minTurnover) return false; // 有换手数据才按阈值过滤；历史无换手数据视为放行
  }
  if (strategy.maxBoards !== undefined) {
    const boards = Number(stock.boards) || 1;
    if (boards > strategy.maxBoards) return false;
  }
  if (strategy.buyType) {
    const bt = dayCtx.buyTypeByCode?.get(stock.code);
    if (bt !== strategy.buyType) return false;
  }
  return true;
}

export { STRATEGIES, MODE_BOARDS, strategyMatches };
