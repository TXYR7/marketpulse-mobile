import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import {createMobileAlerts,processMobileBoardFrame,normalizeAlertSettings,mobileDay,mobileCandidates,formatMobileNotice} from '../mobile-alerts.js';
import {BOARD_NOTIFY_RULES,detectBoardCycle,boardQuote} from '../board-alerts.js';
import {fetchTencentQuotes} from '../data.js';
import {PARAM_MANIFEST} from '../analytics.js';
import {buildWorkerBundle} from './build-worker.mjs';
function memoryStore(initial={}){
 const data=new Map(Object.entries(structuredClone(initial)));let tail=Promise.resolve();
 const storage={async getKV(key,fallback){await tail;return structuredClone(data.has(key)?data.get(key):fallback);},atomicKV(keys,update){const task=tail.then(()=>{const values=Object.fromEntries(keys.map(key=>[key,structuredClone(data.get(key))]));const changed=update(values)||{};for(const [key,value]of Object.entries(changed.values || {}))data.set(key,structuredClone(value));return changed.result;});tail=task.catch(()=>{});return task;},updateKV(key,update,fallback){return storage.atomicKV([key],values=>{const result=update(values[key]??fallback);return {values:{[key]:result},result};});}};return storage;
}
const timestamp=Date.parse('2026-11-09T10:00:00+08:00');
function quote(price,now,code='600001'){return {code,name:'测试',price,preClose:10,limitPrice:11,limitPct:10,boardLimitPct:10,changePercent:(price/10-1)*100,quoteAt:now,ask1Price:price===11?0:11,ask1Vol:price===11?0:200,sealHands:10000,previousBoards:0,sources:[]};}
function frame(trace){let state;const events=[];for(const [index,price]of trace.entries()){const now=timestamp+index*5000,result=processMobileBoardFrame(state,[quote(price,now)],{date:'20261109',now});state=result.state;events.push(...result.events);}return {state,events};}
function rig(storage,extra={}){
 const offset=timestamp-Date.now(),now=()=>Date.now()+offset;let price=10.97;
 const instance=createMobileAlerts({storage,now,isTradingDay:()=>true,getHistory:async()=>[],fetchTopGainers:async()=>[],fetchQuotes:async()=>({}),fetchPools:async()=>({up:[]}),fetchTencentQuotes:async codes=>Object.fromEntries(codes.map(code=>[code,{name:'测试',price,prevClose:10,bid1Price:price,bid1Vol:10000,ask1Price:price===11?0:11,ask1Vol:price===11?0:200,stamp:new Date(now()+8*3600000).toISOString().replace(/\D/g,'').slice(0,14)}])),queueOptions:{minGapMs:0},...extra});return {instance,now,setPrice(value){price=value;},watch:[{code:'600001',name:'测试',previousBoards:0,sources:['全市场临近']}]};
}

test('手机与桌面共用同形打板规则，低价股不越过观察线反复报',()=>{
 const require=createRequire(import.meta.url),desktop=fs.existsSync('D:/codex/board-alerts.js')?require('D:/codex/board-alerts.js'):null;if(desktop)assert.deepEqual(BOARD_NOTIFY_RULES,desktop.BOARD_NOTIFY_RULES);
 const a={},b={};for(const [i,price]of [10.96,10.97,11,10.99,10.95,10.97,11].entries()){const stock=quote(price,timestamp+i*5000);if(desktop)assert.deepEqual(detectBoardCycle(stock,a,stock.quoteAt,PARAM_MANIFEST.preSealAlert),desktop.detectBoardCycle(stock,b,stock.quoteAt,PARAM_MANIFEST.preSealAlert));}
 const low={},stock={...quote(1.07,timestamp),preClose:1,limitPrice:1.1,changePercent:7};assert.equal(detectBoardCycle(stock,low,timestamp,PARAM_MANIFEST.preSealAlert).length,0);
});
test('首板/连板/回封都覆盖，一次临板不重播，第一档开板即报',()=>{
 const result=frame([10.97,10.98,11,10.99,10.95,10.97]);assert.equal(result.events.filter(e=>e.kind==='boardReady').length,2);assert.equal(result.events.filter(e=>e.kind==='sealOpen').length,1);assert.equal(result.events.filter(e=>e.kind==='reseal').length,0);
 assert.equal(result.events.at(-1).boardStage,'首板回封');
 for(const previousBoards of [1,2,4]){const stock={...quote(10.97,timestamp),previousBoards};const result=processMobileBoardFrame(null,[stock],{date:'20261109',now:timestamp});assert.equal(result.events[0].boardStage,`${previousBoards}进${previousBoards+1}`);}
});
test('累计30秒急拉真实触发，不只比较上一轮；未知和过期盘口不冒充临板',()=>{
 const result=frame([10.4,10.5,10.6,10.7,10.8]);assert.equal(result.events.filter(e=>e.kind==='surge').length,1);
 assert.equal(boardQuote({...quote(11,timestamp),ask1Price:null,ask1Vol:null}).bookMissing,true);
 const stale=processMobileBoardFrame(null,[{...quote(10.99,timestamp),quoteAt:timestamp-15001}],{date:'20261109',now:timestamp});assert.equal(stale.events.filter(e=>e.kind==='boardReady').length,0);
});
test('封单风险默认只报今日临板观察或指定持仓代码',()=>{
 const stock=quote(11,timestamp),state={};detectBoardCycle(stock,state,timestamp,PARAM_MANIFEST.preSealAlert);assert.equal(detectBoardCycle({...stock,sealHands:6000,quoteAt:timestamp+5000},state,timestamp+5000,PARAM_MANIFEST.preSealAlert).length,0);
 const held={};detectBoardCycle(stock,held,timestamp,PARAM_MANIFEST.preSealAlert,{held:true});assert.equal(detectBoardCycle({...stock,sealHands:6000,quoteAt:timestamp+5000},held,timestamp+5000,PARAM_MANIFEST.preSealAlert,{held:true})[0].kind,'sealShrink');
});
test('主题迁移保留旧地址，坏地址不覆盖，未保存主题可明确测试',{timeout:5000},async()=>{
 const storage=memoryStore({pushNtfyUrl:'https://ntfy.sh/old'}),calls=[];const {instance}=rig(storage,{sendPush:async config=>{calls.push(config.url);return {ok:true,status:200};}});
 assert.equal((await instance.settings()).url,'https://ntfy.sh/old');assert.equal((await instance.settings()).source,'phone');
 await assert.rejects(instance.saveSettings({url:'https://ntfy.sh/'}));assert.equal((await instance.settings()).url,'https://ntfy.sh/old');
 const result=await instance.testPush('https://ntfy.sh/unsaved');assert.equal(result.ok,true);assert.deepEqual(calls,['https://ntfy.sh/unsaved']);assert.equal((await instance.settings()).url,'https://ntfy.sh/old');
});
test('前台和后台同时扫描只生成一份事件和一条推送',{timeout:5000},async()=>{
 const storage=memoryStore({pushNtfyUrl:'https://ntfy.sh/unit'}),calls=[];const a=rig(storage,{sendPush:async()=>{calls.push(1);return {ok:true,status:200};}}),b=rig(storage,{sendPush:async()=>{calls.push(2);return {ok:true,status:200};}});
 await Promise.all([a.instance.scan({watch:a.watch}),b.instance.scan({watch:b.watch})]);await Promise.all([a.instance.dispatch(),b.instance.dispatch()]);assert.equal(calls.length,1);
 const records=await storage.getKV('boardAlertsOutbox');assert.equal(records.length,1);assert.equal(records[0].state,'sent');
});
test('刷新恢复既有周期不会重发临板，待发与检测状态一起落库',{timeout:5000},async()=>{
 const storage=memoryStore({pushNtfyUrl:'https://ntfy.sh/unit'});let sends=0;const a=rig(storage,{sendPush:async()=>{sends++;return {ok:true};}});
 await a.instance.scan({watch:a.watch});await a.instance.dispatch();const b=rig(storage,{sendPush:async()=>{sends++;return {ok:true};}});await b.instance.scan({watch:b.watch});await b.instance.dispatch();assert.equal(sends,1);
 const runtime=await storage.getKV('boardAlertsRuntime');assert.equal(runtime.cycles['600001'].readySent,true);assert.ok((await storage.getKV('boardAlertsOutbox')).length);
});
test('发送失败补发同一消息成功，只记录一份最终结果',{timeout:7000},async()=>{
 const storage=memoryStore({pushNtfyUrl:'https://ntfy.sh/unit'});let calls=0;const {instance}=rig(storage,{sendPush:async()=>++calls===1?{ok:false,status:503}:{ok:true,status:200}});
 const result=await instance.testPush('https://ntfy.sh/unit');assert.equal(result.ok,true);assert.equal(result.attempts,2);assert.equal((await storage.getKV('boardAlertsOutbox')).length,1);
});
test('电脑来源只保留页面提醒，不独立发ntfy，竞价观察默认关闭',{timeout:5000},async()=>{
 const storage=memoryStore({boardAlertsSettings:{source:'desktop',url:'https://ntfy.sh/unit'}});let sent=0,notices=0;const {instance,watch}=rig(storage,{sendPush:async()=>{sent++;return {ok:true};}});
 await instance.scan({watch,onNotices:()=>{notices++;}});assert.equal(sent,0);assert.equal(notices,1);assert.equal((await instance.settings()).auction,false);
 assert.equal(normalizeAlertSettings().allSealRisk,false);
});
test('新首板加入快速监控并持久化，不按S/A等级筛选',{timeout:5000},async()=>{
 const storage=memoryStore();const {instance,now}=rig(storage,{fetchTopGainers:async()=>[{code:'600001',name:'测试',price:10.97,prevClose:10,changePercent:9.7,amount:200000000,update:Math.floor(now()/1000)}]});
 await instance.scan({background:true});const fast=await storage.getKV('boardAlertsFastWatch');assert.equal(fast.date,'20261109');assert.ok(fast.byCode['600001']);assert.equal((await instance.loadWatch('20261109')).length,1);
});
test('过期临板消息恢复时不外呼，源修改后取消原任务',{timeout:5000},async()=>{
 const now=Date.now(),job={id:'old',createdAt:now-30000,nextAt:now-30000,startedAt:null,attempts:0,state:'pending',config:{type:'ntfy',url:'https://ntfy.sh/unit'},events:[],category:'entry',title:'old',lines:[],expiresAt:now-1000,priority:4};
 const storage=memoryStore({pushNtfyUrl:'https://ntfy.sh/unit',boardAlertsOutbox:[job]});let sent=0;const instance=createMobileAlerts({storage,sendPush:async()=>{sent++;return {ok:true};}});await instance.dispatch();assert.equal(sent,0);assert.equal((await storage.getKV('boardAlertsOutbox'))[0].state,'expired');
});
test('临板消息完整显示代码、梯队、档位、价格和行情时间',()=>{
 const notice=formatMobileNotice([{...quote(10.98,timestamp),kind:'boardReady',boardStage:'2进3',gapTicks:2,pct:9.8,t:timestamp}]);for(const text of ['600001','2进3','2 档','10.98/涨停11.00','10:00:00'])assert.ok(notice.lines[0].includes(text),text);
});
test('腾讯解析买卖一价格和数量，坏块保留好块，并发不超过2',{timeout:5000},async()=>{
 const original=globalThis.fetch;let active=0,max=0;globalThis.fetch=async(url,options)=>{active++;max=Math.max(max,active);await Promise.resolve();active--;if(url.includes('sh600001'))throw new Error('坏块');const code=url.match(/(?:sh|sz)(\d{6})/)[1],fields=Array(31).fill('0');fields[1]='Name';fields[3]='10.97';fields[4]='10';fields[9]='10.96';fields[10]='1000';fields[19]='10.98';fields[20]='200';fields[30]='20261109100000';return {ok:true,arrayBuffer:async()=>new TextEncoder().encode(`v_sh${code}="${fields.join('~')}";`).buffer};};
 try{const codes=Array.from({length:61},(_,i)=>String(600001+i));const result=await fetchTencentQuotes(codes);assert.ok(max<=2);assert.equal(result['600061'].ask1Price,10.98);assert.equal(result['600061'].bid1Price,10.96);assert.equal(result['600001'],undefined);}finally{globalThis.fetch=original;}
});
test('经典SW构建与共享模块保持一致，页面和后台得到同一打板判定',()=>{
 const bundle=fs.readFileSync(new URL('../mobile-worker.js',import.meta.url),'utf8');assert.equal(bundle,buildWorkerBundle());const context=vm.createContext({console,Date,setTimeout,clearTimeout,setInterval,clearInterval,URL,AbortController,AbortSignal,TextEncoder,TextDecoder,structuredClone,crypto:globalThis.crypto});context.self=context;vm.runInContext(bundle,context);
 const stock=quote(10.97,timestamp),opts={date:'20261109',now:timestamp};assert.deepEqual(JSON.parse(JSON.stringify(context.mobileBoardRuntime.processMobileBoardFrame(null,[stock],opts))),processMobileBoardFrame(null,[stock],opts));
});
test('SW不缓存跨域行情请求，安装外壳容忍单个资源失败',{timeout:5000},async()=>{
 const handlers={},puts=[];const context=vm.createContext({console,Date,setTimeout,clearTimeout,setInterval,clearInterval,URL,AbortController,AbortSignal,TextEncoder,TextDecoder,structuredClone,crypto:globalThis.crypto,Response,fetch:async request=>{if(String(request).includes('icon-192.png'))throw new Error('暂不可用');return new Response('ok');},caches:{open:async()=>({put:async url=>{puts.push(url);}}),keys:async()=>[],delete:async()=>true,match:async()=>new Response('cached')}});context.self=context;context.location={origin:'https://example.test'};context.addEventListener=(name,fn)=>{handlers[name]=fn;};context.skipWaiting=async()=>{};context.clients={claim:async()=>{},matchAll:async()=>[],openWindow:async()=>{}};context.registration={showNotification:async()=>{}};
 context.importScripts=()=>vm.runInContext(fs.readFileSync(new URL('../mobile-worker.js',import.meta.url),'utf8'),context);vm.runInContext(fs.readFileSync(new URL('../sw.js',import.meta.url),'utf8'),context);
 let responded=false;handlers.fetch({request:{url:'https://qt.gtimg.cn/q=sh600001',method:'GET'},respondWith(){responded=true;}});assert.equal(responded,false);
 let install;handlers.install({waitUntil(promise){install=promise;}});await install;assert.ok(puts.includes('./mobile-alerts.js'));assert.ok(puts.includes('./board-alerts.js'));
});

test('4xx不重试；通道429退避后补发，不立即连续打接口',{timeout:7000},async()=>{
 const store=memoryStore();let calls=0;const blocked=rig(store,{sendPush:async()=>{calls++;return {ok:false,status:403,error:'HTTP 403'};}});const failed=await blocked.instance.testPush('https://ntfy.sh/unit');assert.equal(calls,1);assert.equal(failed.state,'failed');
 const secondStore=memoryStore();calls=0;const timed=[];const limited=rig(secondStore,{sendPush:async()=>{timed.push(Date.now());return ++calls===1?{ok:false,status:429,retryAfterMs:1000,error:'HTTP 429'}:{ok:true};}});const sent=await limited.instance.testPush('https://ntfy.sh/unit');assert.equal(sent.ok,true);assert.equal(calls,2);assert.ok(timed[1]-timed[0]>=900);
});
test('无新鲜报价时暂停临板，并在状态中指出缺失',{timeout:5000},async()=>{
 const storage=memoryStore();const {instance,watch}=rig(storage,{fetchTencentQuotes:async()=>({}),fetchQuotes:async()=>({})});const events=await instance.scan({watch});assert.equal(events.length,0);const status=await instance.status();assert.equal(status.health.watchCount,1);assert.equal(status.health.freshCount,0);
});
test('来源改为电脑后取消既有待发任务，不再独立发一次',{timeout:5000},async()=>{
 const now=Date.now(),job={id:'pending',createdAt:now,nextAt:now,startedAt:null,attempts:0,state:'pending',config:{type:'ntfy',url:'https://ntfy.sh/unit'},events:[],category:'core',title:'old',lines:[],expiresAt:now+120000,priority:3};
 const storage=memoryStore({boardAlertsSettings:{source:'desktop',url:'https://ntfy.sh/unit'},boardAlertsOutbox:[job]});let sends=0;const instance=createMobileAlerts({storage,sendPush:async()=>{sends++;return {ok:true};}});await instance.dispatch();assert.equal(sends,0);assert.equal((await storage.getKV('boardAlertsOutbox'))[0].state,'cancelled');
});
