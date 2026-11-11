'use strict';

const num = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const closeOf = q => num(typeof q === 'object' && q !== null ? q.close : q);
const rounded = v => Math.round(v * 100) / 100;

function onePriceLimit(q, code, direction) {
  if (!q || typeof q !== 'object') return false;
  const close = closeOf(q), high = num(q.high), low = num(q.low), base = num(q.preClose);
  if ([close, high, low, base].includes(null) || base <= 0 || Math.abs(high - low) > 0.001) return false;
  const limit = /^(30|68)/.test(code) ? 0.2 : /^(8|4|92)/.test(code) ? 0.3 : 0.1;
  return direction === 'up' ? close / base - 1 >= limit - 0.005 : close / base - 1 <= -limit + 0.005;
}

function tradePath(code, signalDate, prices, dates, costs, execution) {
  const signalIndex = dates.indexOf(signalDate);
  const entryIndex = signalIndex + (execution.entry === 'nextOpen' ? 1 : 0);
  const entryDate = dates[entryIndex];
  const quote = prices?.[entryDate];
  const entryPrice = execution.entry === 'nextOpen' ? num(quote?.open) : closeOf(quote);
  const empty = reason => ({ state: 'not_bought', reason, entryDate, entryPrice: null, exitDate: null, ret: null, marks: [] });
  if (!entryDate || entryPrice === null || entryPrice <= 0) return empty('missing_entry_kline');
  if (execution.rejectSuspended && num(quote?.volume) === 0) return empty('entry_suspended');
  if (execution.rejectLimitUp && onePriceLimit(quote, code, 'up')) return empty('limit_up_unbuyable');
  if (Number(execution.minAmount) > 0 && (num(quote?.amount) === null || Number(quote.amount) < Number(execution.minAmount))) return empty('low_liquidity');
  const buyCost = entryPrice * (1 + Number(costs.slippageRate || 0) + Number(costs.commissionRate || 0));
  const marks = [];
  let exitPrice = null, exitDate = null, blockedExitDays = 0, reason = 't1_pending', staleDays = 0;
  let lastMark = entryPrice;
  for (let i = entryIndex; i < dates.length; i += 1) {
    const date = dates[i], q = prices?.[date], close = closeOf(q);
    if (close !== null && close > 0) lastMark = close;
    else staleDays += 1;
    marks.push({ date, price: lastMark, stale: close === null || close <= 0 });
    if (i <= entryIndex) continue; // A股 T+1，真实买入日不能卖。
    if (close === null || close <= 0) { reason = 'missing_exit_kline'; blockedExitDays += 1; continue; }
    if (execution.rejectSuspended && num(q?.volume) === 0) { reason = 'exit_suspended'; blockedExitDays += 1; continue; }
    if (execution.rejectLimitDown && onePriceLimit(q, code, 'down')) { reason = 'limit_down_unsellable'; blockedExitDays += 1; continue; }
    exitPrice = close; exitDate = date; reason = null; break;
  }
  const proceeds = exitPrice === null ? null : exitPrice * (1 - Number(costs.slippageRate || 0) - Number(costs.commissionRate || 0) - Number(costs.stampTaxRate || 0));
  return { state: exitDate ? 'closed' : 'open', reason, entryDate, entryPrice, exitDate, exitPrice, buyCost,
    ret: proceeds === null ? null : rounded((proceeds / buyCost - 1) * 100),
    unrealizedRet: exitDate ? null : rounded((lastMark / buyCost - 1) * 100), blockedExitDays, staleDays, marks };
}

// One shared cash account. Entries share available cash; held positions cannot reuse it.
// Daily bars imply a close/open fill scenario, not a guarantee of queue execution.
function simulatePortfolio(outcomes, dates, costs, { initialCapital = 100000, lotSize = 100 } = {}) {
  const capital = num(initialCapital);
  const lot = num(lotSize);
  if (capital === null || capital <= 0 || lot === null || lot < 1 || !Number.isInteger(lot)) throw new Error('Invalid backtest capital or lot size');
  let cash = capital, peak = capital, maxDrawdown = 0;
  const holdings = new Map(), trades = [], orders = [], equityCurve = [];
  let bought = 0, entryBlocked = 0, duplicateSkipped = 0, cashBlocked = 0;
  const fee = value => Math.max(Number(costs.minCommission || 0), value * Number(costs.commissionRate || 0));
  const sell = (date, position) => {
    const path = position.path;
    if (path.exitDate !== date) return;
    const gross = path.exitPrice * position.shares;
    const net = gross * (1 - Number(costs.slippageRate || 0) - Number(costs.stampTaxRate || 0)) - fee(gross);
    cash += net;
    trades.push({ code: position.code, entryDate: path.entryDate, exitDate: date, shares: position.shares,
      pnl: rounded(net - position.cost), returnPct: rounded((net / position.cost - 1) * 100), blockedExitDays: path.blockedExitDays });
    holdings.delete(position.code);
  };
  for (const date of dates) {
    // All exits are at close. nextOpen orders cannot spend same-day close proceeds.
    const entries = outcomes.filter(o => o.path.entryDate === date);
    const usable = entries.filter(o => o.path.state !== 'not_bought' && !holdings.has(o.code));
    const budget = usable.length ? cash / usable.length : 0;
    for (const o of entries) {
      const path = o.path;
      let reason = path.state === 'not_bought' ? path.reason : holdings.has(o.code) ? 'already_held' : null;
      if (reason) {
        if (reason === 'already_held') duplicateSkipped += 1; else entryBlocked += 1;
        orders.push({ code: o.code, signalDate: o.date, date, state: 'rejected', reason });
        continue;
      }
      let shares = Math.floor(budget / (path.entryPrice * (1 + Number(costs.slippageRate || 0) + Number(costs.commissionRate || 0))) / lot) * lot;
      const costOf = count => path.entryPrice * count * (1 + Number(costs.slippageRate || 0)) + fee(path.entryPrice * count);
      while (shares > 0 && (costOf(shares) > budget || costOf(shares) > cash)) shares -= lot;
      if (!shares) { cashBlocked += 1; orders.push({ code: o.code, signalDate: o.date, date, state: 'rejected', reason: 'cash_or_lot' }); continue; }
      const cost = costOf(shares);
      cash -= cost; bought += 1;
      holdings.set(o.code, { code: o.code, shares, cost, path });
      orders.push({ code: o.code, signalDate: o.date, date, state: 'filled', shares, cost: rounded(cost) });
    }
    for (const position of [...holdings.values()]) sell(date, position);
    let marketValue = 0, stalePositions = 0;
    for (const position of holdings.values()) {
      const mark = position.path.marks.find(m => m.date === date);
      marketValue += position.shares * (mark?.price ?? position.path.entryPrice);
      if (mark?.stale) stalePositions += 1;
    }
    const equity = cash + marketValue;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak * 100);
    equityCurve.push({ date, cash: rounded(cash), marketValue: rounded(marketValue), equity: rounded(equity),
      returnPct: rounded((equity / capital - 1) * 100), openPositions: holdings.size, stalePositions });
  }
  return { version: 'daily-ledger-1', initialCapital: capital, finalEquity: equityCurve.at(-1)?.equity ?? capital,
    returnPct: equityCurve.at(-1)?.returnPct ?? 0, maxDrawdown: rounded(maxDrawdown), bought, closed: trades.length,
    entryBlocked, duplicateSkipped, cashBlocked,
    exitBlocked: trades.filter(t => t.blockedExitDays > 0).length + [...holdings.values()].filter(p => p.path.blockedExitDays > 0).length,
    openPositions: [...holdings.values()].map(p => ({ code: p.code, shares: p.shares,
      entryDate: p.path.entryDate, reason: p.path.reason, blockedExitDays: p.path.blockedExitDays,
      unrealizedRet: rounded((p.shares * (p.path.marks.at(-1)?.price ?? p.path.entryPrice) / p.cost - 1) * 100), staleDays: p.path.staleDays })),
    equityCurve, trades, orders, assumption: '日K开盘/收盘成交情景；100股整手、共享现金、T+1；缺价格持仓保留并标记估值过期；不证明涨停排队成交。' };
}

export { tradePath, simulatePortfolio };
