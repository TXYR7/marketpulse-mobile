'use strict';

import { assessPromotion, fmtSealTime, exitSignalsOf, klineFeatures } from './analytics.js';
import { UNIFIED_RULES, assessUnifiedDecision } from './unified-judgement.js';
const CONTEXT_RULES = Object.freeze({ historyBars:60, breakoutBars:20, amountBaselineBars:20, minimumAmountSamples:5, previousObservationMaxAgeMs:300000, priceBasisTolerancePp:1, timezone:'Asia/Shanghai' });
const num=value=>value===null||value===undefined||value===''?null:Number.isFinite(Number(value))?Number(value):null;
const dateKey=value=>String(value||'').replaceAll('-','');
const industry=value=>{const key=String(value||'').trim();return key && !['未分类','其他','未知'].includes(key)?key:null;};
const median=values=>{const sorted=values.filter(v=>num(v)!==null).map(Number).sort((a,b)=>a-b);return sorted.length?sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2:null;};
const time=value=>{const s=fmtSealTime(value),match=/^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);return match?Number(match[1])*3600+Number(match[2])*60+Number(match[3]||0):null;};

function createUnifiedContexts(payload, { history=[], barsByCode=new Map(), previousObservation=null, observedAt=payload.asOf, pausedModes=[], todayOpenByCode={}, derived=false, dataAbnormal=false } = {}) {
  const date=dateKey(payload.tradeDate), at=Date.parse(observedAt), stocks=payload.stocks||[];
  const clock=Number.isFinite(at)?Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:CONTEXT_RULES.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(p=>[p.type,p.value])):null;
  const minute=clock?Number(clock.hour)*60+Number(clock.minute):null;
  const sameDay=clock && clock.year+clock.month+clock.day===date;
  const inTrading=Boolean(sameDay && !payload.marketClosed && ((minute>=570 && minute<690)||(minute>=780 && minute<900)));
  const closed=payload.session==='close' && (!sameDay||minute>=900);
  const primaryKnown=payload.health?.ok===true || (payload.health?.sources?.行情?.ok===true && payload.health?.sources?.涨停池?.ok===true);
  const trusted=Boolean(Number.isFinite(at) && primaryKnown && !dataAbnormal && payload.health?.sources?.行情?.ok!==false && payload.health?.sources?.涨停池?.ok!==false && !payload.health.stale && !payload.delayed && !payload.stale && (!payload.resilience?.mode||payload.resilience.mode==='live') && payload.validation?.status!=='conflict');
  const days=history.filter(day=>/^\d{8}$/.test(dateKey(day.date))&&dateKey(day.date)<date).sort((a,b)=>dateKey(a.date).localeCompare(dateKey(b.date)));
  const expectedPrevious=dateKey(payload.previousTradeDate);
  const previousDay=expectedPrevious?days.find(day=>dateKey(day.date)===expectedPrevious):days.at(-1);
  const previousStocks=previousDay?.stocks||[];
  const previousByCode=new Map(previousStocks.map(s=>[String(s.code),s]));
  const byCode=new Map(stocks.map(s=>[String(s.code),s]));
  const maxBoard=Math.max(0,...stocks.map(s=>num(s.boards)||0));
  const previousMax=Math.max(0,...previousStocks.map(s=>num(s.boards)||0));
  const previousAnchors=previousStocks.filter(s=>previousMax>=2 && Number(s.boards)===previousMax);
  const downCodes=new Set((payload.limitDownStocks||[]).map(s=>String(s.code)));
  const brokenCodes=new Set((payload.brokenStocks||[]).map(s=>String(s.code)));
  let coreState=previousAnchors.length?previousAnchors.some(s=>byCode.has(String(s.code)))?'healthy':previousAnchors.every(s=>downCodes.has(String(s.code)))?'collapsed':previousAnchors.some(s=>brokenCodes.has(String(s.code)))?'disagreement':'unknown':'unknown';
  const previousCount=num(payload.prevLimitUp)??(previousDay?previousStocks.length:null);
  const breadthImproving=previousCount===null?null:stocks.length>previousCount;
  const legacyRoles=new Map((payload.leaders||[]).map(s=>[String(s.code),s.role]));
  const knownCoreRoles=['市场总龙头','板块龙头','板块核心','核心龙头','龙头'];
  const sourceTime=Date.parse(previousObservation?.unifiedDecision?.asOf||previousObservation?.asOf||'');
  const previousTrusted=previousObservation?.unifiedDecision ? previousObservation.unifiedDecision.trusted===true : previousObservation?.health?.ok===true && previousObservation?.validation?.status!=='conflict';
  const comparablePrevious=previousObservation && previousTrusted && dateKey(previousObservation.tradeDate)===date && !previousObservation.delayed && !previousObservation.health?.stale && sourceTime<at && at-sourceTime<=CONTEXT_RULES.previousObservationMaxAgeMs;
  const previousTickByCode=new Map(comparablePrevious?(previousObservation.stocks||[]).map(s=>[String(s.code),s]):[]);
  const conceptAsOf=Date.parse(payload.concepts?.asOf||'');
  const conceptGroups=(payload.concepts?.available && Number.isFinite(conceptAsOf) && conceptAsOf<=at && dateKey(payload.concepts.date||payload.tradeDate)===date?payload.concepts.items:[])||[];
  const industryGroups=new Map();
  for(const s of stocks){const key=industry(s.industry);if(key){if(!industryGroups.has(key))industryGroups.set(key,[]);industryGroups.get(key).push(s);}}
  const rankedIndustries=[...industryGroups.entries()].sort((a,b)=>b[1].length-a[1].length);
  const topIndustry=payload.status?.mainTheme||rankedIndustries[0]?.[0]||null;
  const rawContexts=new Map();
  for(const stock of stocks){
    const code=String(stock.code), boards=Math.max(1,num(stock.boards)||1), role=stock.role||legacyRoles.get(code)||null;
    const concepts=conceptGroups.filter(group=>(group.stocks||[]).some(member=>String(typeof member==='string'?member:member.code)===code));
    const concept=concepts[0];
    const name=concept?(concept.concept||concept.name):industry(stock.industry);
    const members=concept?(concept.stocks||[]).map(s=>byCode.get(String(typeof s==='string'?s:s.code))).filter(Boolean):(industryGroups.get(name)||[]);
    const source=concept?'概念实录':name?'行业代理':'未知';
    const groupMax=members.length?Math.max(...members.map(s=>num(s.boards)||1)):null;
    const front=members.filter(s=>Number(s.boards)===groupMax);
    const first=time(stock.firstSealTimeAvailable===false?null:stock.firstSealTime), last=time(stock.lastSealTime);
    const earliest=members.length?Math.min(...members.map(s=>time(s.firstSealTimeAvailable===false?null:s.firstSealTime)).filter(s=>s!==null)):null;
    const frontEarliest=front.length?Math.min(...front.map(s=>time(s.firstSealTimeAvailable===false?null:s.firstSealTime)).filter(s=>s!==null)):null;
    const isCore=members.length>=2 && boards===groupMax && (knownCoreRoles.includes(role)||front.length===1||(first!==null&&first===frontEarliest));
    const relativeHeight=boards>=2 && boards===maxBoard;
    const ownHistory=days.slice(-3).map(day=>(day.stocks||[]).find(s=>String(s.code)===code)||null);
    const lastThree=ownHistory.slice(-3);
    const validAcceleration=lastThree.length===3 && lastThree.every((row,index)=>row && Number(row.boards)===boards-3+index && row.breakCountAvailable!==false && num(row.breakCount)===0 && num(row.amount)>0);
    const priorAcceleration=validAcceleration?lastThree[2].amount<lastThree[1].amount && lastThree[1].amount<lastThree[0].amount:null;
    const barsRaw=barsByCode instanceof Map?barsByCode.get(code):barsByCode[code];
    const uniqueBars=new Map((barsRaw||[]).filter(bar=>/^\d{8}$/.test(dateKey(bar.date))&&dateKey(bar.date)<date && num(bar.close)>0).map(bar=>[dateKey(bar.date),{...bar,date:dateKey(bar.date)}]));
    const bars=[...uniqueBars.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-CONTEXT_RULES.historyBars);
    const prior=bars.at(-1), window=bars.slice(-CONTEXT_RULES.breakoutBars);
    const expectedBarDate=expectedPrevious||dateKey(previousDay?.date);
    const historyFresh=Boolean(/^\d{8}$/.test(expectedBarDate)&&prior?.date===expectedBarDate);
    const historicalHigh=window.length>=CONTEXT_RULES.breakoutBars && window.every(b=>num(b.high)>0)?Math.max(...window.map(b=>Number(b.high))):null;
    const price=num(stock.price)>0?num(stock.price):null;
    const calculatedPct=price!==null&&num(prior?.close)>0?(price/prior.close-1)*100:null;
    const reportedPct=num(stock.changePercent);
    const priceBasisComparable=reportedPct===null||calculatedPct===null?null:Math.abs(reportedPct-calculatedPct)<=CONTEXT_RULES.priceBasisTolerancePp;
    const rangeHigh=!historyFresh||priceBasisComparable===false?null:historicalHigh;
    const pct=reportedPct??calculatedPct;
    // stocks 来自观察时点的涨停池；用价格与封单事实，不按名称/代码猜当天涨跌幅制度。
    const currentSeal=stock.sealAmountAvailable===false?null:num(stock.sealAmount);
    const actualLimitPrice=num(stock.limitPrice);
    const sealed=price===null||pct===null||currentSeal===null?null:typeof stock.sealed==='boolean'?stock.sealed:actualLimitPrice>0?price>=actualLimitPrice-.01&&currentSeal>0:pct>0&&currentSeal>0;
    const breakCount=stock.breakCountAvailable===false?null:num(stock.breakCount);
    const resealed=sealed===null||breakCount===null||first===null||last===null?null:sealed&&breakCount>0&&last>first;
    const breakout=price===null||rangeHigh===null?null:price>rangeHigh;
    const recentPeak=bars.length>=5?Math.max(...bars.slice(-5).map(b=>num(b.high)||num(b.close))):null;
    const priorPullback=bars.length>=3 && num(bars.at(-1).close)<num(bars.at(-2).close) && num(bars.at(-2).close)<num(bars.at(-3).close);
    const reclaim=historyFresh && priceBasisComparable!==false && price!==null && recentPeak!==null && priorPullback?price>recentPeak:null;
    const stop=!historyFresh||priceBasisComparable===false?null:breakout===true?rangeHigh:num(prior?.low)>0?num(prior.low):null;
    const validLows=bars.map(b=>num(b.low)).filter(v=>v>0), validHighs=bars.map(b=>num(b.high)).filter(v=>v>0);
    const span=validLows.length&&validHighs.length?Math.max(...validHighs)-Math.min(...validLows):null;
    const priorPosition=span>0?(Number(prior.close)-Math.min(...validLows))/span:null;
    const shapeWarnings=!historyFresh||priceBasisComparable===false?[]:exitSignalsOf(bars,{boards,mode:stock.buyType||null}).map(signal=>signal.note).filter(Boolean);
    const legacyPriceFeatures=!historyFresh||priceBasisComparable===false||bars.length<2?null:klineFeatures(bars);
    const amounts=bars.slice(-CONTEXT_RULES.amountBaselineBars).map(b=>num(b.amount)).filter(v=>v>0);
    const base=historyFresh&&amounts.length>=CONTEXT_RULES.minimumAmountSamples?median(amounts):null;
    const amount=num(stock.amount), amountRatio=amount!==null&&base>0?amount/base:null;
    const seal=stock.sealAmountAvailable===false?null:num(stock.sealAmount), circ=stock.circulatingValueAvailable===false?null:num(stock.circulatingValue);
    const sealRatio=seal!==null&&circ>0?seal/circ*100:null;
    const peerRatios=members.map(s=>s.sealAmountAvailable!==false&&s.circulatingValueAvailable!==false&&num(s.sealAmount)!==null&&num(s.circulatingValue)>0?num(s.sealAmount)/num(s.circulatingValue)*100:null).filter(v=>v!==null);
    const previousTick=previousTickByCode.get(code), previousSeal=previousTick?.sealAmountAvailable===false?null:num(previousTick?.sealAmount);
    const thinning=seal!==null&&previousSeal>0?seal<previousSeal:null;
    const newConfirmed=previousTick && sealed===true && num(previousTick.price)>0 && num(previousTick.changePercent)>0 && num(previousTick.sealAmount)>0 && amount!==null && num(previousTick.amount)!==null && amount>Number(previousTick.amount) && thinning===false;
    const auctionRow=(payload.auction?.items||[]).find(s=>String(s.code)===code&&s.matched);
    const openPct=num(todayOpenByCode[code])??num(auctionRow?.matchPct);
    const prev=previousByCode.get(code)||null;
    const limitOpen=openPct!==null&&pct!==null&&sealed===true?Math.abs(openPct-pct)<=.2:null;
    const stage=resealed?'分歧回封':priorAcceleration===true&&relativeHeight?'连续加速后':limitOpen===true?'一致封板':boards<=2?'启动/确认':'上行待辨识';
    rawContexts.set(code,{
      observedAt:observedAt||null,data:{trusted,derived},circuitPaused:pausedModes.includes(stock.buyType),
      identity:{known:Boolean(name&&members.length&&first!==null&&num(stock.boards)>=1),isCore,kind:isCore?'core':boards<groupMax?'rear':'candidate',label:isCore?(relativeHeight?'相对高度核心':'板块前排核心'):relativeHeight?'相对高标候选':'非核心/待辨识',stage,relativeHeight,priorAcceleration,heightOnly:relativeHeight&&members.length<2,sealedAfterPeers:first!==null&&earliest!==null&&first>earliest,source,legacyRole:role},
      theme:{name,size:members.length||null,source,mainline:concept?concept===conceptGroups[0]:name===topIndustry,weakening:source==='行业代理'&&comparablePrevious&&name?stocks.filter(s=>industry(s.industry)===name).length<(previousObservation.stocks||[]).filter(s=>industry(s.industry)===name).length:null},
      structure:{price,sealed,resealed,breakout,reclaim,invalidationPrice:stop,invalidated:price!==null&&stop!==null&&price<=stop,historyEnd:prior?.date||null,historyFresh,expectedBarDate:expectedBarDate||null,priorPosition,priceBasisComparable,shapeWarnings},
      commitment:{sealRatio,peerMedian:median(peerRatios),thinning,newConfirmed:Boolean(newConfirmed),previousSealAmount:previousSeal,previousObservedAt:comparablePrevious?new Date(sourceTime).toISOString():null},
      volume:{amountRatio,currentAmount:amount,baselineAmount:base,samples:amounts.length,comparable:closed,previousDayAmount:num(prior?.amount)},
      auction:{openPct,limitOpen,previousDisagreement:prev?num(prev.breakCount)>0:null,previousRepaired:prev&&time(prev.lastSealTime)!==null&&time(prev.firstSealTime)!==null?num(prev.breakCount)>0&&time(prev.lastSealTime)>time(prev.firstSealTime):null},
      previousDay:prev?{boards:prev.boards,breakCount:prev.breakCount,turnoverRate:prev.turnoverRate}:null,
      legacyPriceFeatures:legacyPriceFeatures?{gapUnfilled:legacyPriceFeatures.gapUnfilled,pullbackFirstBoard:legacyPriceFeatures.pullbackFirstBoard===true}:null,
      execution:{inTradingSession:inTrading,canEnterNow:false,riskConfirmed:false,suspended:stock.suspended===true}
    });
  }
  if(previousAnchors.length)coreState=previousAnchors.some(s=>rawContexts.get(String(s.code))?.structure.sealed===true)?'healthy':previousAnchors.every(s=>downCodes.has(String(s.code)))?'collapsed':previousAnchors.some(s=>brokenCodes.has(String(s.code)))?'disagreement':'unknown';
  const newAnchor=[...rawContexts.values()].some(ctx=>ctx.identity.isCore && ctx.identity.relativeHeight && ctx.structure.resealed===true && ctx.theme.size>=2);
  const repairConfirmed=Boolean(breadthImproving===true && (coreState==='healthy'||newAnchor));
  if(coreState==='collapsed'&&repairConfirmed&&newAnchor)coreState='replacing';
  const market={phase:payload.stats?.emotion?.phase||payload.status?.phase||null,previousPhase:previousDay?.phase||previousDay?.stats?.emotion?.phase||null,coreState,breadthImproving,repairConfirmed,maxBoard,previousMaxBoard:previousMax||null,previousCount,currentCount:stocks.length,sourceAsOf:observedAt||null};
  for(const context of rawContexts.values())context.market=market;
  return {market,contexts:rawContexts,inTrading,trusted};
}

function applyUnifiedJudgements(payload, options={}) {
  if(!payload||!Array.isArray(payload.stocks))return {auditRows:[]};
  const {market,contexts,inTrading,trusted}=createUnifiedContexts(payload,options);
  const previous=payload.opportunities||{};
  const byCode=new Map(), tiers={S:[],A:[],B:[]},eliminated=[],auditRows=[];
  for(const stock of payload.stocks){
    const context=contexts.get(String(stock.code));
    const legacyContext={phase:market.phase,themeSize:context.theme.size,role:context.identity.legacyRole,openPct:context.auction.openPct,prevDay:context.previousDay,
      volChg:context.volume.comparable&&context.volume.previousDayAmount>0&&context.volume.currentAmount!==null?Math.round((context.volume.currentAmount/context.volume.previousDayAmount-1)*100):null,gapUnfilled:context.legacyPriceFeatures?.gapUnfilled??null,pullbackFirstBoard:context.legacyPriceFeatures?.pullbackFirstBoard??null};
    const legacy=assessPromotion(stock,legacyContext);
    const assessment=assessUnifiedDecision(stock,context,legacy);
    const next={...stock,promo:assessment,strengthScore:stock.strengthScore??stock.score??null,score:assessment.score,scoreNorm:assessment.score,scoreNormExact:assessment.score,signal:assessment.signal,
      gate:{pass:assessment.verdict==='可接力',final:assessment.verdict==='可接力'?'允许研究确认':'等待/规避',gates:[{name:'统一判决',pass:assessment.verdict==='可接力',note:assessment.actionPlan.entry}]}};
    next.tier=assessment.verdict==='规避'?'D':assessment.verdict==='可接力'?(assessment.score>=UNIFIED_RULES.topPriorityScore?'S':'A'):'B';
    next.level=assessment.verdict==='可接力'?'确认待触发':assessment.verdict==='规避'?'规避':'条件待确认';
    Object.assign(stock,next);byCode.set(String(stock.code),stock);
    if(next.tier==='D')eliminated.push({...stock,elim:assessment.hardFails,eliminationReasons:assessment.hardFails});else tiers[next.tier].push(stock);
    auditRows.push({stock,context:{...context,legacyContext},assessment});
  }
  for(const tier of Object.values(tiers))tier.sort((a,b)=>(b.score??-1)-(a.score??-1)||String(a.code).localeCompare(String(b.code)));
  for(const leader of payload.leaders||[]){const stock=byCode.get(String(leader.code));if(stock)leader.promo=stock.promo;}
  const noTrade=[];
  if(!trusted||options.derived)noTrade.push('行情可信条件不足，暂停新增交易判断');
  if(!inTrading)noTrade.push('当前时段仅作研究，下个交易时段重新确认');
  payload.opportunities={...previous,available:payload.stocks.length>0,modelVersion:UNIFIED_RULES.version,legacyNoTrade:Object.hasOwn(previous,'legacyNoTrade')?previous.legacyNoTrade:previous.noTrade||null,tiers,eliminated,noTrade:noTrade.length?{triggered:true,reason:noTrade.join('；')}:null,paused:!trusted};
  if(payload.auctionWatchlist?.items)for(const item of payload.auctionWatchlist.items){const stock=byCode.get(String(item.code));if(stock){item.promo=stock.promo;item.signal=stock.signal;}}
  payload.unifiedDecision={modelVersion:UNIFIED_RULES.version,validationStatus:UNIFIED_RULES.status,trusted,asOf:options.observedAt||payload.asOf,market,counts:{confirmed:tiers.S.length+tiers.A.length,waiting:tiers.B.length,avoid:eliminated.length},sources:UNIFIED_RULES.sources};
  if(!Object.hasOwn(payload,'legacyPositionAdvice'))payload.legacyPositionAdvice=payload.positionAdvice||null;
  payload.positionAdvice={label:'风险定仓',ratio:null,note:'按资金、失效距离与风险预算定仓，情境分不换算胜率或仓位',winrateSource:'not_estimated',modelVersion:UNIFIED_RULES.version};
  payload.mentalNotes=[
    {id:'unified-confirm',topic:'确认',text:'先观察市场、核心与价格确认，不预测龙头断板或提前卡位。'},
    {id:'unified-hold',topic:'持有',text:'强势未失效时不主观猜顶；明确失效后按既定计划处理，亏损不摊低。'},
    {id:'unified-risk',topic:'风险',text:'已有持仓优势与新进场成本分开；空仓是有效决策，新增风险由预算和失效线决定。'}
  ];
  if(payload.status){payload.status.bestMode=market.repairConfirmed?'观察核心修复确认':'按核心阶段等待确认';}
  if(payload.riskRadar){
    payload.riskRadar.cannotDo=['主观卡位','龙头未弱就盲目切补涨','把封死涨停当作已成交'];payload.riskRadar.canStudy=['核心与板块联动','相对身位与阶段','价格确认及失效线'];
    const actions={high:'按核心阶段确认，避免缺承接追高',rear:'验证地位与带动，避免凭想象切后排',break:'结合回封与结构失效，不只看炸板次数',first:'验证位置、区间突破与板块支持'};
    for(const item of payload.riskRadar.items||[])if(actions[item.key])item.action=actions[item.key];
  }
  return {auditRows};
}

function unifiedWarmCodes(payload, limit=20) {
  if(payload?.unifiedDecision?.trusted!==true)return [];
  return (payload.stocks||[]).filter(stock=>stock.promo?.modelVersion&&stock.promo.needsHistory)
    .sort((a,b)=>(Number(b.boards)||0)-(Number(a.boards)||0)).slice(0,limit).map(stock=>String(stock.code));
}

export {CONTEXT_RULES,createUnifiedContexts,applyUnifiedJudgements,unifiedWarmCodes};
