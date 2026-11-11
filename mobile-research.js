import {signalObservations,signalReport} from './signal-core.js';
import {SIGNAL_SOURCE_VERSION} from './research-version.js';
import {recordResearchSignals,getResearchSignals,settleResearchSignals,getKV,updateKV,setKV} from './store.js';
import {isTradingDay,storeKlineBars,fetchPools} from './data.js';
import {loadChartBars} from './mobile-data.js';

const dateOf=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(now)).replaceAll('-','');
const closeAt=date=>Date.parse(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T15:05:00+08:00');
const previousDate=date=>{const d=new Date(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-1);return d.toISOString().slice(0,10).replaceAll('-','');};
const nextDate=date=>{const d=new Date(date.slice(0,4)+'-'+date.slice(4,6)+'-'+date.slice(6,8)+'T12:00:00Z');for(let i=0;i<40;i++){d.setUTCDate(d.getUTCDate()+1);const key=d.toISOString().slice(0,10).replaceAll('-','');if(isTradingDay(key))return key;}return null;};
export function researchDates(count,now=Date.now()) {
  let date=dateOf(now);if(now<closeAt(date))date=previousDate(date);
  const dates=[];for(let i=0;i<240&&dates.length<count;i++,date=previousDate(date))if(isTradingDay(date))dates.push(date);
  return dates.reverse();
}
export async function captureResearchSignals(state) {
  await recordResearchSignals(signalObservations(state,SIGNAL_SOURCE_VERSION));
}
async function concurrent(items,work,{cancelled=()=>false,onProgress=()=>{}}={}) {
  let next=0,done=0,failed=false;const results=await Promise.allSettled(Array.from({length:Math.min(3,items.length)},async()=>{
    while(next<items.length){if(cancelled()||failed)return;const item=items[next++];try{await work(item);}catch(e){failed=true;throw e;}done++;onProgress(done,items.length);}
  }));if(cancelled())throw new Error('已停止，已完成的补录保留');
  const error=results.find(r=>r.status==='rejected');if(error)throw error.reason;
}
export async function updateSignalReport({onProgress=()=>{},cancelled=()=>false,maxCodes=24}={}) {
  let rows=await getResearchSignals();
  const now=Date.now(),pending=rows.filter(r=>r.sourceVersion===SIGNAL_SOURCE_VERSION&&!r.result&&nextDate(r.date)&&now>=closeAt(nextDate(r.date)));
  const codes=[...new Set(pending.map(r=>r.code))].slice(0,maxCodes),results=[];
  await concurrent(codes,async code=>{
    try{
      const loaded=await loadChartBars(code,{limit:320,refresh:true});
      const byDate=new Map(loaded.bars.map(b=>[b.date,b]));
      for(const row of pending.filter(r=>r.code===code)){
        const next=nextDate(row.date),base=byDate.get(row.date),exit=byDate.get(next);
        if(!base||!exit||!(row.first.preClose>0)||!(base.preClose>0)||Math.abs(base.preClose/row.first.preClose-1)>.005)continue;
        if(loaded.at<closeAt(next))continue;
        results.push({id:row.id,result:{close:base.close,nextClose:exit.close,nextDate:next,asOf:new Date(loaded.at).toISOString()}});
      }
    }catch{}
  },{cancelled,onProgress});
  await settleResearchSignals(results);rows=await getResearchSignals();
  return ['first','confirmed','latest'].map(event=>signalReport(rows,SIGNAL_SOURCE_VERSION,event));
}

export async function runMobileBacktest({count=20,initialCapital=100000,entry='close',maxCodes=24,onProgress=()=>{},cancelled=()=>false}={}) {
  if(![10,20,30].includes(count)||!Number.isFinite(initialCapital)||initialCapital<=0||!['close','nextOpen'].includes(entry))throw Error('无效的回测日期、本金或买入情景');
  const dates=researchDates(count),cached=await getKV('research-final-history-v1',{}),days=new Map();
  for(const date of dates)if(cached[date]?.final)days.set(date,cached[date]);
  const missing=dates.filter(d=>!days.has(d));
  await concurrent(missing,async date=>{
    const pools=await fetchPools(date,{tries:1,timeoutMs:5000});
    if(pools.sources?.up!==true)throw new Error(date+'的涨停池未完整获取，请重试');
    const day={date,final:true,stocks:(pools.up||[]).map(s=>({code:s.code,name:s.name,boards:s.boards,industry:s.industry,amount:s.amount,
      changePercent:s.changePercent,sealAmount:s.sealAmount,sealAmountAvailable:s.sealAmountAvailable,turnoverRate:s.turnoverRate,breakCount:s.breakCount}))};
    await updateKV('research-final-history-v1',value=>{
      const next={...value,[date]:day};for(const old of Object.keys(next).sort().slice(0,-90))delete next[old];return next;
    },{});days.set(date,day);
  },{cancelled,onProgress:(done,total)=>onProgress('历史池 '+done+'/'+total)});
  const history=dates.map(d=>days.get(d));
  if(history.some(d=>!d))throw new Error('历史交易日不完整，保留上一次回测');
  const codes=[...new Set(history.flatMap(d=>d.stocks.map(s=>s.code)))],prices={},cachedPrices=await getKV('research-kline-v1',{});
  for(const code of codes){const cached=cachedPrices[code],bars=cached?.bars||[];if(bars.length)prices[code]=Object.fromEntries(bars.filter(b=>b.date<=dates.at(-1)&&cached.at>=closeAt(b.date)).map(b=>[b.date,b]));}
  const missingCodes=codes.filter(code=>!prices[code]?.[dates.at(-1)]&&(!cachedPrices[code]?.attemptedAt||Date.now()-cachedPrices[code].attemptedAt>300000)).slice(0,maxCodes);
  await concurrent(missingCodes,async code=>{
    try{const loaded=await loadChartBars(code,{limit:320,refresh:true});
      prices[code]=Object.fromEntries(loaded.bars.filter(b=>b.date<=dates.at(-1)&&loaded.at>=closeAt(b.date)).map(b=>[b.date,b]));
      storeKlineBars(code,dates.at(-1),loaded.bars);
      await updateKV('research-kline-v1',value=>({...value,[code]:{bars:loaded.bars,at:loaded.at,attemptedAt:Date.now()}}),{});
    }catch{await updateKV('research-kline-v1',value=>({...value,[code]:{...(value[code]||{}),attemptedAt:Date.now()}}),{});}
  },{cancelled,onProgress:(done,total)=>onProgress('K线补录 '+done+'/'+total)});
  if(cancelled())throw new Error('已停止，已完成的补录保留');
  const [{aggregateBacktests,BACKTEST_SOURCE_VERSION},{STRATEGIES}]=await Promise.all([import('./backtest-core.js'),import('./strategies.js')]);
  if(cancelled())throw new Error('已停止，已完成的补录保留');
  const strategies=aggregateBacktests(history,STRATEGIES,prices,{validationFrac:.2,execution:{entry},portfolio:{initialCapital}});
  const result={sourceVersion:BACKTEST_SOURCE_VERSION,at:new Date().toISOString(),dates,coverage:{withKline:codes.filter(c=>Object.keys(prices[c]||{}).length>0).length,codes:codes.length},strategies};
  await setKV('research-backtest-v1',result);return result;
}
export async function readMobileResearch(){return {signals:await getResearchSignals(),backtest:await getKV('research-backtest-v1',null)};}
