import { applyUnifiedJudgements } from './unified-context.js';
import { cachedKlineBars, fmtTime } from './data.js';
import { loadChartBars } from './mobile-data.js';

const historyBars = new Map();
let previousObservation = null, currentObservation = null, lastAt = null;
const warmed = new Map();
export function rememberDecisionBars(code, bars) { historyBars.set(String(code), bars); }
export function applyMobileJudgements(state) {
  const pools = state.pools; if (!pools) return;
  const at = state.lastSuccessAt || state.lastGoodAt || 0;
  if (at && at !== lastAt) { previousObservation = currentObservation; lastAt = at; }
  const sourceAt = at ? new Date(at).toISOString() : null;
  const stocks = pools.up || [];
  const barsByCode = new Map(stocks.map(s => [s.code, historyBars.get(s.code) || cachedKlineBars(s.code, pools.date) || []]));
  const now = new Date(), minute = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).replace(':', ''));
  const stale = !state.marketClosed && !state.manualDate && ((minute >= 930 && minute < 1130) || (minute >= 1300 && minute < 1500)) && Date.now() - at > 45000;
  const trusted = pools.sources?.up === true && !pools.partial && !state.fromSnapshot && !stale && state.lastErrorAt <= at;
  const payload = {
    tradeDate: String(pools.date), previousTradeDate: state.previousTradingDate,
    asOf: sourceAt, marketClosed: state.marketClosed || !!state.manualDate,
    session: state.marketClosed || minute >= 1500 ? 'close' : 'intraday',
    stocks, limitDownStocks: pools.down || [], brokenStocks: pools.broken || [],
    status: { phase: state.phase, mainTheme: state.themes?.[0]?.name }, stats: { emotion: state.emotion },
    leaders: state.leaders, opportunities: state.opportunities, riskRadar: state.riskRadar,
    health: { ok: trusted, stale, sources: { 行情: { ok: trusted }, 涨停池: { ok: pools.sources?.up === true } } },
    auction: state.auction,
  };
  stocks.forEach(s => { s.lastSealTime = fmtTime(s.lastSeal); });
  applyUnifiedJudgements(payload, { history: state.history || [], barsByCode, previousObservation, observedAt: sourceAt, todayOpenByCode: { ...(state.openPctDate === pools.date ? state.openPctByCode : {}), ...(state.auctionPctByCode || {}) }, dataAbnormal: !trusted });
  state.opportunities = payload.opportunities; state.positionAdvice = payload.positionAdvice; state.mentalNotes = payload.mentalNotes; state.unifiedDecision = payload.unifiedDecision;
  if (state.lastPayload) Object.assign(state.lastPayload, { stocks, opportunities: payload.opportunities, positionAdvice: payload.positionAdvice, unifiedDecision: payload.unifiedDecision });
  // 保留上一轮有效观察，日K回填不将同一份静态数据变成连续确认。
  if (at) currentObservation = { tradeDate: pools.date, asOf: sourceAt, unifiedDecision: { ...payload.unifiedDecision }, stocks: stocks.map(s => ({ code: s.code, price: s.price, changePercent: s.changePercent, sealAmount: s.sealAmount, amount: s.amount, industry: s.industry })) };
}
export async function warmMobileJudgements(state, onReady) {
  if (!state.unifiedDecision?.trusted || !state.pools) return;
  const pools = state.pools, date = pools.date;
  const codes = [...(pools.up || [])].sort((a,b)=>(b.boards||1)-(a.boards||1)).slice(0,12).map(s=>s.code).filter(code => {
    const hit=warmed.get(date+':'+code); return !hit || hit !== 'loading' && Date.now()-hit>300000;
  });
  let next=0;
  await Promise.all(Array.from({length:Math.min(3,codes.length)},async()=>{
    while(next<codes.length){ const code=codes[next++],key=date+':'+code;warmed.set(key,'loading');
      try{const data=await loadChartBars(code);rememberDecisionBars(code,data.bars);}catch{} finally{warmed.set(key,Date.now());}
      if(state.pools===pools)onReady();
    }
  }));
}
