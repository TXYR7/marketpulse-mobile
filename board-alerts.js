'use strict';
// 通知专用规则：不修改评分、判决及 analytics 冻结参数。
const BOARD_NOTIFY_RULES = Object.freeze({ readyTicks: 3, quoteMaxAgeMs: 15_000, entryTtlMs: 20_000 });
function numeric(value) { return value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null; }
function quoteTimeMs(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(stamp || ''));
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`) : null;
}
function boardQuote(stock) {
  const price = numeric(stock.price), limitPrice = numeric(stock.limitPrice);
  if (!(price > 0) || !(limitPrice > 0)) return null;
  const priceCents = Math.round(price * 100), limitCents = Math.round(limitPrice * 100);
  if (priceCents > limitCents) return null;
  const askPrice = numeric(stock.ask1Price), askVol = numeric(stock.ask1Vol);
  const hasSell = askVol > 0 && askPrice > 0 && Math.round(askPrice * 100) <= limitCents;
  const atLimit = priceCents === limitCents;
  const bidVol=numeric(stock.sealHands),bidPrice=numeric(stock.bid1Price);
  const hasLimitBid=bidVol>0 && (bidPrice==null || Math.round(bidPrice*100)===limitCents);
  const bookMissing = atLimit && (askPrice == null || askVol == null || (!hasSell && !hasLimitBid));
  return { price, limitPrice, gapTicks: limitCents - priceCents, atLimit, sealed: atLimit && !hasSell && !bookMissing, bookMissing, hasSell, priceCents };
}
function boardEntryDeadline(time) {
  const local=new Date(time+8*3600_000);const date=local.toISOString().slice(0,10);const minutes=local.getUTCHours()*60+local.getUTCMinutes();
  const close=minutes<570?'09:30:00':minutes<=690?'11:30:00':'15:00:00';
  return Math.min(time+BOARD_NOTIFY_RULES.entryTtlMs,Date.parse(`${date}T${close}+08:00`));
}
function boardStage(stock, reseal = false) {
  const previous = Math.max(0, Number(stock.previousBoards) || 0);
  return `${previous ? `${previous}进${previous+1}` : '首板'}${reseal ? '回封' : ''}`;
}
function boardEvent(stock, kind, now, quote, extra = {}) {
  return { code:stock.code,name:stock.name || stock.code,kind,t:now,pct:Math.round(stock.changePercent*100)/100,
    limitPct:stock.limitPct,boardLimitPct:stock.boardLimitPct,limitPrice:quote.limitPrice,price:quote.price,
    gapTicks:quote.gapTicks,gapPct:Math.round(Math.max(0,stock.limitPct-stock.changePercent)*100)/100,
    expiresAt:kind==='boardReady'?boardEntryDeadline(now):undefined,previousBoards:stock.previousBoards || 0,boardStage:boardStage(stock),sources:stock.sources || [],quoteAt:stock.quoteAt, ...extra };
}
function detectBoardCycle(stock, state, now, params, { held = false, allSealRisk = false, auction = false } = {}) {
  const quote = boardQuote(stock);
  if (!quote || quote.bookMissing || !Number.isFinite(stock.quoteAt) || now-stock.quoteAt < 0 || now-stock.quoteAt > BOARD_NOTIFY_RULES.quoteMaxAgeMs) return [];
  const events = [];
  const first = !state.init;
  const wasSealed = state.sealed === true;
  if (first) { state.init=true; state.broken=(stock.sources || []).includes('今日炸板'); state.cycleWasBroken=Boolean(state.broken); }
  const oldLow = numeric(state.brokenLowPrice);
  if (quote.sealed) {
    state.sealed=true;state.broken=false;state.readySent=false;state.resealNotified=false;state.openPushed=false;state.brokenLowPrice=null;state.cycleWasBroken=false;
  } else {
    state.sealed=false;
    if (wasSealed) { state.broken=true;state.cycleWasBroken=true;state.brokenLowPrice=quote.price;state.readySent=false;state.resealNotified=false; }
    if (state.cycleWasBroken) state.brokenLowPrice = oldLow == null || wasSealed ? quote.price : Math.min(oldLow,quote.price);
    if (wasSealed && !state.openPushed && !auction) {
      state.openPushed=true;
      events.push(boardEvent(stock,'sealOpen',now,quote));
    }
    const recovering = !state.cycleWasBroken || (oldLow != null && quote.price > oldLow + 0.005) || first;
    if (state.broken && !wasSealed && recovering && !state.resealNotified && stock.limitPct-stock.changePercent <= Number(params.resealTriggerOffsetPct || 0.5)+1e-6) {
      state.broken=false;state.resealNotified=true;
      events.push(boardEvent(stock,'reseal',now,quote,{boardStage:boardStage(stock,true),auction}));
    }
    if (!wasSealed && recovering && !state.readySent && quote.gapTicks <= BOARD_NOTIFY_RULES.readyTicks && stock.limitPct-stock.changePercent <= Number(params.approachOffsetPct || 1.5)+1e-6 && stock.changePercent > 0) {
      state.readySent=true;state.entryObserved=true;
      events.push(boardEvent(stock,'boardReady',now,quote,{boardStage:boardStage(stock,Boolean(state.cycleWasBroken)),hasSell:quote.hasSell,auction}));
    }
    if (stock.limitPct-stock.changePercent > Number(params.approachOffsetPct || 1.5)) state.readySent=false;
  }
  // Risk scope affects alerts, never the underlying seal/break/reseal tracking.
  const hands = numeric(stock.sealHands);
  if (quote.sealed && hands > 0) {
    const stale = state.sealShrinkAnchorAt > 0 && now-state.sealShrinkAnchorAt > Number(params.sealShrinkAnchorMaxAgeMs || 90000);
    let anchor = numeric(state.sealShrinkAnchor);
    if (anchor == null || stale || hands > anchor) anchor=hands;
    state.sealShrinkAnchor=anchor;state.sealShrinkAnchorAt=now;
    const shrinkPct=(1-hands/anchor)*100;
    if (anchor >= Number(params.sealShrinkMinHands || 3000) && shrinkPct >= Number(params.sealShrinkPct || 30)) {
      state.sealShrinkAnchor=hands;
      if (held || state.entryObserved || allSealRisk) events.push(boardEvent(stock,'sealShrink',now,quote,{shrinkPct,sealHands:hands}));
    }
  } else if (!quote.sealed) { state.sealShrinkAnchor=null;state.sealShrinkAnchorAt=0; }
  return events;
}
export { BOARD_NOTIFY_RULES, quoteTimeMs, boardQuote, boardEntryDeadline, boardStage, boardEvent, detectBoardCycle };
