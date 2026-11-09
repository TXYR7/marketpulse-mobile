import { BOARD_NOTIFY_RULES, boardQuote, boardStage, boardEvent, detectBoardCycle, quoteTimeMs } from './board-alerts.js';
import { normalizePushConfig, createPushQueue, sendPush } from './notify.js';
import { PARAM_MANIFEST, limitPriceOf, isMainBoardShare, isExcludedPreSealName, detectPreSealAlerts } from './analytics.js';
import { getKV, updateKV, atomicKV, getAllHistory } from './store.js';
import { fetchTencentQuotes, fetchQuotes, fetchTopGainers, fetchPools, isTradingDay } from './data.js';

export const MOBILE_ALERT_DEFAULTS = Object.freeze({ enabled:true,source:'phone',discover:true,auction:false,allSealRisk:false,localNotify:true,sound:true,vibrate:true,url:'',riskCodes:[] });
const RUNTIME='boardAlertsRuntime',FAST='boardAlertsFastWatch',OUTBOX='boardAlertsOutbox',SETTINGS='boardAlertsSettings';
const SCAN_LEASE='boardAlertsScanLease',SEND_LEASE='boardAlertsSendLease',RATE='boardAlertsRate';
const terminal=new Set(['sent','failed','expired','cancelled']);
export function mobileDay(time=Date.now()){return new Date(time+8*3600000).toISOString().slice(0,10).replace(/-/g,'');}
export function mobileSession(time=Date.now()){
 const local=new Date(time+8*3600000),minutes=local.getUTCHours()*60+local.getUTCMinutes();
 return {auction:minutes>=566&&minutes<570,tradable:(minutes>=566&&minutes<690)||(minutes>=780&&minutes<900)};
}
export function normalizeAlertSettings(raw={},legacyUrl=''){
 const result={...MOBILE_ALERT_DEFAULTS,...raw};result.source=result.source==='desktop'?'desktop':'phone';
 const config=normalizePushConfig({url:result.url || legacyUrl});result.url=config?.url || '';
 result.riskCodes=[...new Set((Array.isArray(result.riskCodes)?result.riskCodes:[]).map(String).filter(isMainBoardShare))];return result;
}
function freshRank(row,now){const stamp=Number(row.update || row.updatedAt)*1000;return !stamp || (now-stamp>=-60000&&now-stamp<=300000);}
export function mobileCandidates(rows,{auction=false,now=Date.now(),params=PARAM_MANIFEST.preSealAlert}={}){
 const result=[];for(const row of rows || []){
  if(!isMainBoardShare(row.code)||isExcludedPreSealName(row.name)||!freshRank(row,now))continue;
  const limit=limitPriceOf(row.prevClose ?? row.preClose,row.code,row.name),price=Number(row.price),pct=Number(row.changePercent);
  if(!limit || !(price>0) || !Number.isFinite(pct) || pct<=0 || Math.round(price*100)>=Math.round(limit.price*100))continue;
  if(pct<limit.effectiveLimitPct-params.approachOffsetPct || Number(row.amount)<Number(auction?params.auctionMinAmount:params.marketMinAmount))continue;
  result.push({code:String(row.code),name:row.name || row.code,price,limitPrice:limit.price,quoteAt:Number(row.update || row.updatedAt)?Number(row.update || row.updatedAt)*1000:null,amount:Number(row.amount),previousBoards:0,sources:['全市场临近'],limitPct:limit.effectiveLimitPct,boardLimitPct:limit.boardLimitPct,gapPct:Math.round((limit.effectiveLimitPct-pct)*100)/100,pct});
 }
 return result.sort((a,b)=>b.amount-a.amount);
}
function currentRuntime(raw,date){return raw?.date===date?(typeof structuredClone==='function'?structuredClone(raw):JSON.parse(JSON.stringify(raw))):{schema:2,date,repeat:{},cycles:{},frames:{},digest:{byCode:{},lastAt:0,auctionSent:false},auctionSeen:[],history:[]};}
export function processMobileBoardFrame(raw,stocks,{date,now,params=PARAM_MANIFEST.preSealAlert,heldCodes=[],allSealRisk=false,auction=false}={}){
 const state=currentRuntime(raw,date),repeat=new Map(Object.entries(state.repeat || {})),cycles=state.cycles || {},cycleEvents=[];
 for(const [key,record]of repeat){const stock=stocks.find(s=>s.code===key.split(':')[0]);if(stock && stock.changePercent <= (record.lastPct ?? stock.limitPct)-params.repeatResetOffsetPct+1e-6)record.resetReady=true;}
 const canAlert=key=>{const previous=repeat.get(key);return !previous || (previous.resetReady && now-previous.lastAt>=params.repeatMinIntervalMs);};
 for(const stock of stocks){const cycle=cycles[stock.code] || {};cycleEvents.push(...detectBoardCycle(stock,cycle,now,params,{held:heldCodes.includes(stock.code),allSealRisk,auction}));cycles[stock.code]=cycle;}
 const previous=new Map();for(const [code,frame]of Object.entries(state.frames || {})){
  const history=(frame.history || [frame]).filter(x=>now-x.t>=0&&now-x.t<=params.surgeWindowMs&&Number.isFinite(x.pct));if(history.length)previous.set(code,history.reduce((a,b)=>a.pct<b.pct?a:b));
 }
 const early=detectPreSealAlerts({stocks:stocks.filter(stock=>!boardQuote(stock)?.sealed),watchCodes:stocks.map(s=>s.code),prevSnap:previous,now,params:{...params,sealedTolerancePct:0},inCooldown:key=>!canAlert(key)});
 for(const event of early){const stock=stocks.find(s=>s.code===event.code),quote=boardQuote(stock);if(quote)Object.assign(event,boardEvent(stock,event.kind,now,quote,{rise:event.rise,auction}));}
 const readyCodes=new Set(cycleEvents.filter(e=>e.kind==='boardReady').map(e=>e.code)),openCodes=new Set(cycleEvents.filter(e=>e.kind==='sealOpen').map(e=>e.code)),resealCodes=new Set(cycleEvents.filter(e=>e.kind==='reseal').map(e=>e.code));
 const events=[...early.filter(e=>!readyCodes.has(e.code)&&!openCodes.has(e.code)&&!resealCodes.has(e.code)&&!cycles[e.code]?.readySent&&(e.kind!=='sealApproach'||!cycles[e.code]?.cycleWasBroken)),...cycleEvents.filter(e=>e.kind!=='reseal'||!readyCodes.has(e.code))];
 for(const event of events){const key=`${event.code}:${event.kind}`,old=repeat.get(key);repeat.set(key,{count:(old?.count || 0)+1,lastAt:now,lastPct:event.pct,resetReady:false});}
 const frames={};for(const stock of stocks){const old=state.frames?.[stock.code],history=(old?.history || (old?[old]:[])).filter(row=>now-row.t>=0&&now-row.t<=params.surgeWindowMs);history.push({pct:stock.changePercent,t:now});frames[stock.code]={pct:stock.changePercent,t:now,history};}
 state.repeat=Object.fromEntries(repeat);state.cycles=cycles;state.frames=frames;state.history=[...events,...(state.history || [])].slice(0,50);return {state,events};
}
function eventText(event){
 const gap=event.gapTicks??'--',pct=event.pct??'--';
 switch(event.kind){case 'boardReady':return event.hasSell&&gap===0?'触及涨停，仍有卖单 · 尚未封板':`临板 · 距涨停 ${gap} 档`;case 'sealApproach':return `冲板观察 · 距涨停 ${event.gapPct??'--'}pp（现 ${pct}%）`;case 'reseal':return `回封观察 · 距涨停 ${event.gapPct??'--'}pp`;case 'surge':return `30秒急拉 +${event.rise??'--'}pp（现 ${pct}%）`;case 'sealOpen':return `涨停开板（现 ${pct}%）`;case 'sealShrink':return `封单骤减 ${Math.round(event.shrinkPct)}%（剩 ${Math.round(event.sealHands).toLocaleString('zh-CN')} 手）`;default:return event.text || `异动（现 ${pct}%）`;}
}
export function formatMobileNotice(events){
 const labels={boardReady:'临板观察',sealApproach:'冲板观察',reseal:'回封观察',surge:'急拉观察',sealOpen:'涨停开板',sealShrink:'封单骤减',marketNear:'临近涨停观察',auctionNear:'竞价临板观察',auctionObserve:'竞价观察'};
 const lines=events.map(event=>{
  const name=event.name&&event.name!==event.code?`${event.name} ${event.code}`:event.code;
  const time=Number.isFinite(event.quoteAt)?new Date(event.quoteAt).toLocaleTimeString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'}):'--';
  const price=Number(event.price)>0?Number(event.price).toFixed(2):'--',limit=Number(event.limitPrice)>0?Number(event.limitPrice).toFixed(2):'--';
  return `${name} ${eventText(event)} · ${event.boardStage || boardStage(event)} · 现价${price}/涨停${limit} · 行情${time}`;
 });
 const types=[...new Set(events.map(event=>labels[event.kind] || '股票预警'))];
 const name=events[0]?.name&&events[0]?.name!==events[0]?.code?`${events[0].name} ${events[0].code}`:events[0]?.code;
 return {title:events.length===1?`${name} ${types[0]}`:`${types.length>=3?'多种预警':types.join('·')} ${events.length}只`,lines,events};
}
function chunksOfNotice(notice){const chunks=[];let lines=[],events=[],size=0;const encoder=new TextEncoder();for(const [index,line]of notice.lines.entries()){const bytes=encoder.encode(line).length;if(lines.length&&size+bytes+1>3500){chunks.push({lines,events});lines=[];events=[];size=0;}lines.push(line);events.push(notice.events[index]);size+=bytes+(lines.length>1?1:0);}if(lines.length)chunks.push({lines,events});return chunks;}

export function createMobileAlerts(options={}){
 const storage=options.storage || {getKV,updateKV,atomicKV},clock=options.now || (()=>Date.now()),uuid=options.uuid || (()=>crypto.randomUUID?crypto.randomUUID():Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join(''));
 const parameters=options.params || PARAM_MANIFEST.preSealAlert,tradeDay=options.isTradingDay || isTradingDay;
 const quotesFn=options.fetchTencentQuotes || fetchTencentQuotes,fallbackFn=options.fetchQuotes || fetchQuotes,ranksFn=options.fetchTopGainers || (()=>fetchTopGainers(300));
 const sendFn=options.sendPush || sendPush;let rankCache={at:0,rows:[]},rankInflight=null,rankAttemptAt=0,pushPromise=null,activeQueue=null,persistence=Promise.resolve();
 async function settings(){const [raw,url,off]=await Promise.all([storage.getKV(SETTINGS),storage.getKV('pushNtfyUrl',''),storage.getKV('preSealOff',false)]);return normalizeAlertSettings(raw || {enabled:!off},url);}
 async function saveSettings(raw){const previous=await settings(),next=normalizeAlertSettings({...previous,...raw});if(raw.riskCodes?.some(code=>!isMainBoardShare(String(code))))throw new Error('关注代码须为6位沪深主板股票代码，多个代码用逗号分开');if(raw.url && !normalizePushConfig({url:raw.url}))throw new Error('请填写完整的ntfy主题地址，不含参数或多层路径');await storage.atomicKV([SETTINGS,'pushNtfyUrl','preSealOff'],()=>({values:{[SETTINGS]:next,pushNtfyUrl:next.url,preSealOff:!next.enabled},result:next}));return next;}
 async function lease(key,task){
  const owner=uuid(),now=clock(),claimed=await storage.updateKV(key,old=>!old || old.until<=now?{owner,until:now+30000}:old,null);if(claimed.owner!==owner)return null;
  const heartbeat=setInterval(()=>{storage.updateKV(key,old=>old?.owner===owner?{owner,until:clock()+30000}:old,null).catch(()=>{});},5000);heartbeat.unref?.();
  try{return await task(owner);}finally{clearInterval(heartbeat);await storage.updateKV(key,old=>old?.owner===owner?null:old,null).catch(()=>{});}
 }
 function appendWrite(task){persistence=persistence.catch(()=>{}).then(task);return persistence;}
 async function recordJob(job,result,owner){await storage.atomicKV([OUTBOX,SEND_LEASE],values=>{
  if(values[SEND_LEASE]?.owner!==owner)return {values:{},result:null};
  const existing=values[OUTBOX] || [],now=clock(),old=existing.find(item=>item.id===job.id);
  if(terminal.has(old?.state)&&!result)return {values:{},result:null};
  const row={...job,...(result?{state:result.state,result,completedAt:now}:{}),updatedAt:now};
  const records=[...existing.filter(item=>item.id!==job.id&&item.createdAt>=now-14*86400000),row];return {values:{[OUTBOX]:records},result:row};
 });}
 async function dispatch(){
  if(pushPromise){if(activeQueue){for(const job of (await storage.getKV(OUTBOX,[])).filter(row=>!terminal.has(row.state)))activeQueue.enqueue(job);}return pushPromise;}
  const waiting=(await storage.getKV(OUTBOX,[])).filter(row=>!terminal.has(row.state));if(!waiting.length)return null;
  if(pushPromise){if(activeQueue)for(const job of waiting)activeQueue.enqueue(job);return pushPromise;}
  let owned=false,drainedOk=false;
  pushPromise=lease(SEND_LEASE,async owner=>{
   owned=true;const enqueuedIds=new Set();
   let drained;const complete=new Promise(resolve=>{drained=resolve;});
   const queue=createPushQueue({...(options.queueOptions || {}),now:clock,
    onChange:job=>{appendWrite(()=>recordJob(job,null,owner));},
    onComplete:(job,result)=>{appendWrite(()=>recordJob(job,result,owner)).catch(()=>{}).finally(()=>{if(!queue.status().pending)drained();});},
    sendFn:async(config,title,lines,extra)=>{
     await persistence;const current=await settings(),ownership=await storage.updateKV(SEND_LEASE,old=>old?.owner===owner?{owner,until:clock()+30000}:old,null),rate=await storage.getKV(RATE);
     if(ownership?.owner!==owner)return {ok:false,state:'cancelled',retryable:false,error:'发送任务已由其他页面接管'};
     if(extra.job.category!=='test'&&(!current.enabled||current.source!=='phone'||current.url!==config.url||(extra.job.category==='digest'&&!current.discover)||(extra.job.category==='auction'&&!current.auction)))return {ok:false,state:'cancelled',retryable:false,error:'手机推送已关闭或来源/主题已修改'};
     const remaining=Math.min(extra.job.expiresAt-clock(),15000-(clock()-extra.job.startedAt));if(remaining<=0)return {ok:false,state:'expired',retryable:false,error:'提醒已过期'};
     if(rate?.until>clock())return {ok:false,status:429,retryAfterMs:rate.until-clock(),error:'通道限流等待中'};
     const result=await sendFn(config,title,lines,{...extra,timeoutMs:Math.min(extra.timeoutMs,remaining)});
     if(result.status===429)await storage.updateKV(RATE,old=>({until:Math.max(old?.until || 0,clock()+(result.retryAfterMs || 10000))}),null);
     return result;
    }});
   const enqueueOnce=job=>{if(!enqueuedIds.has(job.id)){enqueuedIds.add(job.id);queue.enqueue(job);}};activeQueue={enqueue:enqueueOnce};
   const jobs=(await storage.getKV(OUTBOX,[])).filter(row=>!terminal.has(row.state));for(const job of jobs)enqueueOnce(job);
   if(!jobs.length)drained();await complete;await persistence;drainedOk=true;queue.stop();activeQueue=null;
  }).finally(()=>{activeQueue=null;pushPromise=null;if(owned&&drainedOk)storage.getKV(OUTBOX,[]).then(rows=>{if(rows.some(row=>!terminal.has(row.state)))setTimeout(()=>{dispatch().catch(()=>{});},120);}).catch(()=>{});});return pushPromise;
 }
 function noticeJobs(notices,prefs){
  if(!prefs.enabled||prefs.source!=='phone'||!prefs.url)return [];
  const now=clock(),config=normalizePushConfig({url:prefs.url}),jobs=[];
  for(const notice of notices){const chunks=chunksOfNotice(notice);for(const [index,chunk]of chunks.entries()){
   const category=chunk.events.every(e=>e.kind==='boardReady')?'entry':chunk.events[0]?.kind==='auctionObserve'?'auction':['marketNear','auctionNear'].includes(chunk.events[0]?.kind)?'digest':'core';
   const base=Math.min(...chunk.events.map(e=>e.t));jobs.push({id:uuid(),createdAt:now,nextAt:now,attempts:0,startedAt:null,state:'pending',config,category,events:chunk.events,lines:chunk.lines,title:notice.title+(chunks.length>1?`（${index+1}/${chunks.length}）`:''),priority:category==='entry'?4:category==='digest'?1:category==='core'?3:2,expiresAt:Math.min(base+(category==='entry'?20000:category==='digest'?60000:120000),...chunk.events.map(e=>e.expiresAt??Infinity))});
  }}
  return jobs;
 }
 async function ranking({background=false,auction=false}={}){
  const now=clock();if(now-rankCache.at<10000)return rankCache.rows;
  if(!rankInflight&&now-rankAttemptAt>=10000){rankAttemptAt=now;rankInflight=(async()=>{
   try{const rows=await ranksFn();rankCache={at:clock(),rows};const prefs=await settings();if(prefs.discover){const candidates=mobileCandidates(rows,{now:clock(),auction,params:parameters});await storage.updateKV(FAST,old=>{const next=old?.date===mobileDay(clock())?old:{date:mobileDay(clock()),byCode:{}};for(const stock of candidates)next.byCode[stock.code]=stock;return next;});}return rows;}
   catch{return rankCache.rows;}finally{rankInflight=null;}
  })();}return background?rankCache.rows:rankInflight || rankCache.rows;
 }
 async function loadWatch(date,extra=[]){
  let base=extra;if(!base.length){const saved=await storage.getKV('preSealWatch');if(saved?.forDate===date)base=saved.stocks || [];else{
   const history=options.getHistory?await options.getHistory():await getAllHistory();const previous=(history || []).filter(row=>String(row.date)<date).sort((a,b)=>String(b.date).localeCompare(String(a.date)))[0];
   if(previous)base=(previous.stocks || []).map(stock=>({...stock,previousBoards:Number(stock.boards)||0,sources:['昨日涨停']}));else{let day=new Date(Date.parse(`${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}T00:00:00+08:00`));for(let i=0;i<15;i++){day=new Date(day.getTime()-86400000);const key=mobileDay(day.getTime());if(tradeDay(key)){const pools=await (options.fetchPools || fetchPools)(key,{tries:1,timeoutMs:2500});base=(pools.up || []).map(stock=>({...stock,previousBoards:Number(stock.boards)||0,sources:['昨日涨停']}));break;}}}
  }}
  const prefs=await settings(),fast=await storage.getKV(FAST),byCode=new Map();
  function add(stock){const code=String(stock.code);if(!isMainBoardShare(code)||isExcludedPreSealName(stock.name))return;const sources=stock.sources || ['昨日涨停'];const previous=stock.previousBoards??(sources.includes('今日炸板')?Math.max(0,(Number(stock.boards)||1)-1):Number(stock.boards)||0);const old=byCode.get(code);byCode.set(code,old?{...old,previousBoards:Math.max(old.previousBoards,previous),sources:[...new Set([...old.sources,...sources])]}:{...stock,code,previousBoards:previous,sources});}
  for(const stock of base)add(stock);if(fast?.date===date)for(const stock of Object.values(fast.byCode || {}))add(stock);for(const code of prefs.riskCodes)add({code,name:code,previousBoards:0,sources:['关注持仓']});return [...byCode.values()];
 }
 async function scan({watch=[],onNotices=()=>{},background=false}={}){
  const prefs=await settings();if(!prefs.enabled)return [];const before=clock(),session=mobileSession(before),date=mobileDay(before);if(!tradeDay(date)||!session.tradable)return [];
  if(session.auction||background)await ranking({auction:session.auction});else void ranking({background:true});
  const accepted=await lease(SCAN_LEASE,async owner=>{
   const list=await loadWatch(date,watch);let quoteRows=await quotesFn(list.map(s=>s.code),{timeoutMs:2500,concurrency:2});const missing=list.filter(s=>!quoteRows[s.code]);if(missing.length){const fallback=await fallbackFn(missing.map(s=>s.code),{tries:1,timeoutMs:2500});quoteRows={...fallback,...quoteRows};}
   const now=clock(),stocks=[];for(const item of list){const row=quoteRows[item.code],time=row?.stamp?quoteTimeMs(row.stamp):Number(row?.update)*1000;if(!row||!Number.isFinite(time)||now-time<0||now-time>BOARD_NOTIFY_RULES.quoteMaxAgeMs)continue;const name=item.name===item.code?(row.name || item.name):item.name;if(isExcludedPreSealName(name))continue;const limit=limitPriceOf(row.prevClose,item.code,name),price=Number(row.price);if(!limit||!(price>0))continue;stocks.push({...item,name,price,preClose:Number(row.prevClose),limitPrice:limit.price,limitPct:limit.effectiveLimitPct,boardLimitPct:limit.boardLimitPct,quoteAt:time,ask1Price:row.ask1Price,ask1Vol:row.ask1Vol,bid1Price:row.bid1Price,sealHands:row.bid1Vol,changePercent:(price/Number(row.prevClose)-1)*100});}
   let raw=await storage.getKV(RUNTIME);if(!raw){const [old,digest,frames]=await Promise.all([storage.getKV('preSealRepeat'),storage.getKV('preSealDigest'),storage.getKV('preSealPrevSnap')]);raw={...currentRuntime(null,date),repeat:old?.date===date?old.byKey || {}:{},frames:frames?.date===date?frames.snap || {}:{},digest:digest?.date===date?{byCode:digest.byCode || {},lastAt:digest.lastAt || 0,auctionSent:!!digest.auctionSent}:{byCode:{},lastAt:0,auctionSent:false}};}
   const result=processMobileBoardFrame(raw,stocks,{date,now,params:parameters,heldCodes:prefs.riskCodes,allSealRisk:prefs.allSealRisk,auction:session.auction});
   const digest=result.state.digest,candidates=mobileCandidates(rankCache.rows,{now,auction:session.auction,params:parameters}).filter(row=>!list.some(stock=>stock.code===row.code));
   const resetRows=[...rankCache.rows,...stocks.map(stock=>({code:stock.code,changePercent:stock.changePercent}))];
   for(const row of resetRows){const previous=digest.byCode[row.code];if(previous&&Number(row.changePercent)<=previous.lastPct-parameters.repeatResetOffsetPct+1e-6)previous.resetReady=true;}
   const eligible=prefs.discover?candidates.filter(row=>!digest.byCode[row.code]||(digest.byCode[row.code].resetReady&&now-digest.byCode[row.code].lastAt>=parameters.repeatMinIntervalMs)):[];
   const digestEvents=[];if(eligible.length&&(!session.auction?now-digest.lastAt>=parameters.digestIntervalMs:!digest.auctionSent)){
    for(const row of eligible.slice(0,parameters.digestMaxItems)){digest.byCode[row.code]={lastAt:now,lastPct:row.pct,resetReady:false};digestEvents.push({...row,kind:session.auction?'auctionNear':'marketNear',t:now,quoteAt:row.quoteAt,boardStage:'首板',text:`临近涨停 +${row.pct}% · 距涨停 ${row.gapPct}pp`});}digest.lastAt=now;if(session.auction)digest.auctionSent=true;
   }
   result.state.health={lastScanAt:now,watchCount:list.length,freshCount:stocks.length};
   const events=result.events.filter(event=>event.expiresAt==null||now<event.expiresAt),groups=[events.filter(e=>e.kind==='boardReady'),events.filter(e=>e.kind!=='boardReady'),digestEvents].filter(group=>group.length).map(formatMobileNotice);
   const jobs=noticeJobs(groups,prefs);
   const saved=await storage.atomicKV([RUNTIME,OUTBOX,SCAN_LEASE],values=>values[SCAN_LEASE]?.owner===owner?{values:{[RUNTIME]:result.state,[OUTBOX]:[...(values[OUTBOX] || []).filter(row=>row.createdAt>=now-14*86400000),...jobs]},result:true}:{values:{},result:false});if(!saved)return [];
   for(const notice of groups)await onNotices(notice,prefs);return events;
  });
  if(prefs.source==='phone'&&prefs.url){if(background)await dispatch();else void dispatch().catch(()=>{});}return accepted || [];
 }
 async function testPush(url){const config=normalizePushConfig({url});if(!config)throw new Error('请填写有效的ntfy主题地址');const now=clock(),job={id:uuid(),title:'星脉手机推送测试',lines:['ntfy渠道测试',new Date(now).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})],events:[],config,category:'test',createdAt:now,nextAt:now,attempts:0,startedAt:null,state:'pending',priority:2,expiresAt:now+20000};await storage.updateKV(OUTBOX,old=>[...(old || []),job],[]);await dispatch();const records=await storage.getKV(OUTBOX,[]);return records.find(row=>row.id===job.id)?.result || {ok:false,queued:true,state:'queued',error:'发送队列正由其他页面处理，请稍后查看状态'};}
 async function observeAuction(result,onNotices=()=>{}){const prefs=await settings();if(!prefs.enabled||!prefs.auction||result?.mode!=='live')return;await lease(SCAN_LEASE,async owner=>{const now=clock(),date=mobileDay(now),runtime=currentRuntime(await storage.getKV(RUNTIME),date),events=[];for(const stock of result.core || []){if(runtime.auctionSeen.includes(stock.code))continue;const minute=stock.minutes?.[stock.minutes.length-1],price=Number(minute?.price),base=Number(minute?.refPrice);if(!(price>0)||!(base>0))continue;const pct=(price/base-1)*100;if(pct<parameters.auctionSurgePct)continue;runtime.auctionSeen.push(stock.code);events.push({code:stock.code,name:stock.name,kind:'auctionObserve',previousBoards:stock.boards,pct,price,limitPrice:limitPriceOf(base,stock.code,stock.name)?.price,t:now,quoteAt:now,text:`竞价虚拟撮合 +${pct.toFixed(2)}%`});}const notices=events.length?[formatMobileNotice(events)]:[],jobs=noticeJobs(notices,prefs);const saved=await storage.atomicKV([RUNTIME,OUTBOX,SCAN_LEASE],values=>values[SCAN_LEASE]?.owner===owner?{values:{[RUNTIME]:runtime,[OUTBOX]:[...(values[OUTBOX] || []),...jobs]},result:true}:{values:{},result:false});if(saved&&notices.length)await onNotices(notices[0],prefs);});void dispatch().catch(()=>{});}
 async function status(){const prefs=await settings(),records=await storage.getKV(OUTBOX,[]),runtime=await storage.getKV(RUNTIME),today=mobileDay(clock());const daily=records.filter(row=>mobileDay(row.createdAt)===today),count=state=>daily.filter(row=>row.state===state).length;return {settings:prefs,health:runtime?.date===today?runtime.health:null,tradable:tradeDay(today)&&mobileSession(clock()).tradable,sent:count('sent'),failed:count('failed'),expired:count('expired'),pending:records.filter(row=>!terminal.has(row.state)).length,lastFailure:[...records].reverse().find(row=>row.state==='failed')?.result?.error || null};}
 return {settings,saveSettings,scan,dispatch,testPush,status,observeAuction,loadWatch};
}
