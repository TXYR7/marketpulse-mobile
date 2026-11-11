import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {aggregateBacktests,BACKTEST_SOURCE_VERSION} from '../backtest-core.js';
import {STRATEGIES} from '../strategies.js';
import {analyze} from '../advisor-core.js';
import {mergeSignalObservation,signalReport,signalObservations} from '../signal-core.js';
import {researchDates} from '../mobile-research.js';
import {renderSignalReports,renderBacktestReport} from '../mobile-research-ui.js';
const require=createRequire(import.meta.url),desktop=process.env.MP_DESKTOP_ROOT||'D:/codex';

test('手机回测与当前桌面同一输入得到完全相同的12个策略结果',()=>{
  const dates=['20261102','20261103','20261104','20261105','20261106','20261109'];
  const days=dates.map((date,i)=>({date,stocks:[{code:'600000',boards:i%3+1,industry:'测试',amount:1e8,sealAmount:1e7}]}));
  const bar=(close,preClose,flat=false)=>({open:close,close,high:close+(flat?0:.1),low:close-(flat?0:.1),preClose,volume:1e6,amount:1e8});
  const values=[10,9,8.1,8.5,9,9.1],prices={'600000':Object.fromEntries(dates.map((date,i)=>[date,bar(values[i],i?values[i-1]:10,i===1||i===2)]))};
  const original=require(path.join(desktop,'analytics.js'));
  for(const entry of ['close','nextOpen']){
    const options={execution:{entry},portfolio:{initialCapital:10000},validationFrac:.2};
    const actual=aggregateBacktests(days,STRATEGIES,prices,options),expected=original.aggregateBacktests(days,STRATEGIES,prices,options);
    assert.deepEqual(actual,expected);
    assert.equal(actual.length,12);
    assert.ok(actual.every(s=>JSON.stringify([s.train.dates,s.validation.dates,s.oos.dates])===JSON.stringify([actual[0].train.dates,actual[0].validation.dates,actual[0].oos.dates])));
  }
  assert.ok(BACKTEST_SOURCE_VERSION);
});
test('首次B与首次确认S使用各自价格；过期观察不能覆盖，重复行情不算新评级',()=>{
  const observation=(tier,price,asOf)=>({id:'x',code:'600000',date:'20261109',sourceVersion:'v1',modelVersion:'unified-test',snapshot:{tier,score:80,price,mode:'首板',phase:'修复',asOf}});
  const first=mergeSignalObservation(null,observation('B',10,'2026-11-09T01:35:00Z'));
  const newer=mergeSignalObservation(first,observation('S',12,'2026-11-09T02:00:00Z'));
  assert.equal(newer.first.tier,'B');assert.equal(newer.first.price,10);assert.equal(newer.confirmed.price,12);
  const steady=mergeSignalObservation(newer,observation('S',13,'2026-11-09T02:05:00Z'));
  assert.equal(steady.latest.price,12);
  assert.equal(mergeSignalObservation(steady,observation('B',11,'2026-11-09T02:03:00Z')),steady);
  const row={...steady,result:{close:12,nextClose:11}};
  assert.equal(signalReport([row],'v1').tiers[0].avgNext,10);
  assert.equal(signalReport([row],'v1','confirmed').tiers[0].avgNext,-8.33);
  assert.equal(signalReport([row],'other').samples,0);
});
test('历史回看和快照不造信号；完整结算日保留未结算样本',()=>{
  const now=Date.parse('2026-11-11T10:00:00+08:00'),state={pools:{date:'20261111'},lastSuccessAt:now,lastErrorAt:0,unifiedDecision:{trusted:true,modelVersion:'v1'},opportunities:{tiers:{B:[{code:'600000',price:10,score:60}]}}};
  assert.equal(signalObservations(state,'test',now).length,1);
  for(const extra of [{manualDate:'20261111'},{fromSnapshot:true},{unifiedDecision:{trusted:false}},{pools:{date:'20261110'}}])assert.equal(signalObservations({...state,...extra},'test',now).length,0);
  const row=mergeSignalObservation(null,signalObservations(state,'test',now)[0]);
  assert.equal(signalReport([row,{...row,id:'other',code:'600001',result:{close:10,nextClose:11}}],'test').completedDays,0);
});
test('买卖参考与桌面一致，1/3/5日窗口不重叠',()=>{
  const bars=Array.from({length:360},(_,i)=>{const close=10+i*.02;return {date:String(20250101+i),open:close-.01,close,high:close+.1,low:close-.1,volume:1e6,amount:1e8};});
  const args={bars,price:bars.at(-1).close,inputs:{capital:100000,riskPct:1},mode:'buy'};
  const mobile=analyze(args),original=require(path.join(desktop,'advisor-core.js')).analyze(args);
  assert.deepEqual(mobile,original);
  for(const h of mobile.history.horizons)for(let i=1;i<h.windows.length;i++)assert.ok(h.windows[i].fromIndex>h.windows[i-1].toIndex);
});
test('研究窗口只包括已收盘的交易日，资源与导出入口完整',()=>{
  const dates=researchDates(20,Date.parse('2026-11-11T14:00:00+08:00'));
  assert.equal(dates.length,20);assert.equal(dates.at(-1),'20261110');
  assert.equal(researchDates(20,Date.parse('2026-11-11T15:10:00+08:00')).at(-1),'20261111');
  const read=f=>readFileSync(new URL('../'+f,import.meta.url),'utf8'),sw=read('sw.js');
  for(const file of ['signal-core.js','research-version.js','mobile-research.js','mobile-research-ui.js','backtest-core.js','backtest-execution.js','strategies.js','mobile-research.css'])assert.ok(sw.includes(file));
  assert.match(read('index.html'),/id="researchFold"/);assert.match(read('mobile-workspace.js'),/JSON.stringify\(\{ research, version/);
});
test('报告展示保留缺失值与被困持仓，文本安全转义',()=>{
  const report={event:'first',samples:1,settled:0,pending:1,tradingDays:1,completedDays:0,tiers:[{tier:'B<script>',samples:1,settled:0,avgClose:null,avgNext:null,nextUpRate:null}]};
  const html=renderSignalReports([report]);assert.ok(html.includes('—'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('待结算 1'));
  assert.ok(renderBacktestReport(null).includes('最多补录24'));
});

test('升级只新增信号表，保留设置和旧交易，首次观察不会被写入覆盖',async()=>{
  const stores=new Map(['watch','kv','trades','reviews','history'].map(name=>[name,new Map()]));
  const preference={theme:'dark',refreshMs:8000},trade={id:'old',code:'600001'};
  stores.get('kv').set('preferences',preference);stores.get('trades').set('old',trade);
  let openedVersion;
  const request=value=>{const r={result:structuredClone(value)};queueMicrotask(()=>r.onsuccess?.());return r;};
  const db={objectStoreNames:{contains:name=>stores.has(name)},createObjectStore:name=>stores.set(name,new Map()),close(){},
    transaction(name){const tx={};const store=stores.get(name);tx.objectStore=()=>({get:key=>request(store.get(key)),getAll:()=>request([...store.values()]),
      put(value,key){store.set(key??value.id,structuredClone(value));return request(key??value.id);}});setTimeout(()=>tx.oncomplete?.(),0);return tx;}};
  const original=globalThis.indexedDB;
  globalThis.indexedDB={open(_name,version){openedVersion=version;const r={result:db};queueMicrotask(()=>{r.onupgradeneeded?.();r.onsuccess?.();});return r;}};
  try{
    const store=await import('../store.js');
    assert.deepEqual(await store.getKV('preferences'),preference);assert.equal(openedVersion,4);
    assert.equal(stores.size,6);assert.deepEqual(stores.get('trades').get('old'),trade);
    const row={id:'signal',date:'20261111',code:'600000',sourceVersion:'test',snapshot:{tier:'B',price:10,score:50,asOf:'2026-11-11T01:35:00Z'}};
    await store.recordResearchSignals([row]);
    await store.recordResearchSignals([{...row,snapshot:{tier:'S',price:12,score:80,asOf:'2026-11-11T02:00:00Z'}}]);
    const saved=(await store.getResearchSignals())[0];assert.equal(saved.first.price,10);assert.equal(saved.first.tier,'B');assert.equal(saved.confirmed.price,12);
    assert.deepEqual(await store.getKV('preferences'),preference);
  }finally{if(original===undefined)delete globalThis.indexedDB;else globalThis.indexedDB=original;}
});
