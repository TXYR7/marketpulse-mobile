import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { filterHeatStocks, filterHotRank, filterSectorRows, hotRankTier } from '../explorer-core.js';
import { chartGeometry, chartSVG } from '../mobile-chart.js';
import { normalizeChartBars, mapHotRows, mapSector, loadChartBars, loadSectorMembers, loadMarketPage, loadIndexCloses, lookupMobileStocks } from '../mobile-data.js';
import { applyMobileJudgements } from '../mobile-model.js';
import { quickRows } from '../mobile-workspace.js';
import { assessUnifiedDecision, UNIFIED_RULES } from '../unified-judgement.js';
import { fetchPools } from '../data.js';

const root=new URL('../',import.meta.url);
test('所有手机模块可编译，三个新增入口与离线外壳均完整',()=>{
  const files=readdirSync(root).filter(f=>f.endsWith('.js'));
  for(const file of files)new vm.SourceTextModule(readFileSync(new URL(file,root),'utf8'));
  const html=readFileSync(new URL('index.html',root),'utf8'),sw=readFileSync(new URL('sw.js',root),'utf8');
  for(const id of ['view-market','view-intraday','view-rank','view-tools','sheetKline']) if(id!=='sheetKline')assert.ok(html.includes('id="'+id+'"'));
  for(const file of ['mobile-workspace.js','mobile-workspace.css','mobile-data.js','mobile-model.js','mobile-chart.js','unified-context.js','unified-judgement.js','advisor-core.js','explorer-core.js'])assert.ok(sw.includes(file),file+'离线资源缺失');
  assert.doesNotMatch(html,/user-scalable=no/);
});
test('同版本手机模型与桌面参考源码保持同一判决结果',t=>{
  const require=createRequire(import.meta.url);let desktop;
  try{desktop=require(path.join(process.env.MP_DESKTOP_MODEL_ROOT || 'D:/codex','unified-judgement.js'));}catch{t.skip('没有可用的桌面模型参考');return;}
  if(UNIFIED_RULES.version!==desktop.UNIFIED_RULES.version){t.skip('跨模型版本不直接比较；手机 '+UNIFIED_RULES.version+'，桌面 '+desktop.UNIFIED_RULES.version);return;}
  assert.equal(UNIFIED_RULES.version,desktop.UNIFIED_RULES.version);
  for(const trusted of [true,false])for(const phase of ['主升期','分歧期','退潮','冰点']){
    const ctx={market:{phase},data:{trusted},identity:{known:true,isCore:true,label:'核心',source:'行业代理'},structure:{price:10,sealed:true,invalidationPrice:9,historyEnd:'20261109'},commitment:{sealRatio:2,peerMedian:1},volume:{currentAmount:1000},execution:{inTradingSession:true}};
    assert.deepEqual(assessUnifiedDecision({code:'600001'},ctx),desktop.assessUnifiedDecision({code:'600001'},ctx));
  }
});
test('候选范围和名称筛选保留真实判断',()=>{
  const rows=[{code:'600001',name:'核心',promo:{verdict:'可接力',score:85}},{code:'600002',name:'待看',promo:{verdict:'观望',score:60}},{code:'600003',name:'风险',promo:{verdict:'规避',score:90,hardFails:['失效']}}];
  assert.deepEqual(quickRows(rows,{scope:'priority'}).map(s=>s.code),['600001']);
  assert.deepEqual(quickRows(rows,{scope:'wait'}).map(s=>s.code),['600002']);
  assert.deepEqual(quickRows(rows,{scope:'avoid',query:'风险'}).map(s=>s.code),['600003']);
});
test('涨停组合筛选同时约束题材、市场、板数与时段',()=>{
  const rows=[{code:'600001',name:'甲',boards:2,reason:'机器人+汽车',ztFirstTime:'09:40:00',sealAmount:20},{code:'300002',name:'乙',boards:2,reason:'机器人',ztFirstTime:'14:30:00',sealAmount:50}];
  assert.deepEqual(filterHeatStocks(rows,{concept:'机器人',market:'main',level:'multi',time:[925,1000]}).map(s=>s.code),['600001']);
  assert.equal(filterHeatStocks(rows,{codes:['300002']})[0].code,'300002');
});
test('热度排序改变顺序，天梯仍按原始名次分层',()=>{
  const rows=[{code:'600001',rank:1,gainPct:1},{code:'600002',rank:28,gainPct:9}];
  const sorted=filterHotRank(rows,{sort:'gain'});assert.equal(sorted[0].rank,28);assert.equal(hotRankTier(sorted[0].rank),3);
  assert.equal(filterHotRank(rows,{scope:'top20'}).length,1);
  assert.equal(mapHotRows([{sc:'SH600001',rk:1,rc:999}],false)[0].heat,null);
});
test('板块广度排序不把缺失涨停数当作零',()=>{
  const rows=[{name:'甲',upCount:90,downCount:10,limitUpCount:null},{name:'乙',upCount:3,downCount:7,limitUpCount:0}];
  assert.equal(filterSectorRows(rows,{sort:'breadth'})[0].name,'甲');
  assert.equal(rows[0].limitUpCount,null);
  const sector=mapSector({f12:'BK9999',f128:'领涨股',f140:'600001'});assert.equal(sector.leaderName,'领涨股');assert.equal(sector.leaderCode,'600001');
});
const bars=Array.from({length:140},(_,i)=>({date:String(20250000+i+1),open:10+i/100,close:10.04+i/100,high:10.2+i/100,low:9.8+i/100,volume:100+i}));
test('日K区间和均线从完整历史计算，窄屏坐标有限',()=>{
  const g=chartGeometry(bars,{range:20,averages:[20],selected:500});
  assert.equal(g.data.length,20);assert.equal(g.selected,19);assert.equal(g.lines.length,1);assert.equal(g.lines[0].points.split(' ').length,20);
  assert.ok(Number.isFinite(g.y(11)));assert.ok(!chartSVG(bars,{range:120}).includes('NaN'));
});
test('日K过滤无效价格、日期去重并按日期排序',()=>{
  const b={open:10,close:11,high:12,low:9};
  const rows=normalizeChartBars([{...b,date:'2026-11-09'},{...b,date:'20261108'},{...b,date:'20261109',close:12},{...b,date:'bad'},{...b,date:'20261107',close:0}]);
  assert.deepEqual(rows.map(s=>s.date),['20261108','20261109']);assert.equal(rows[1].close,12);
});
test('离线或失败数据强制降为规避，保留一致度的真实意义',()=>{
  const state={pools:{date:'20261110',sources:{up:true},up:[{code:'600001',name:'甲',boards:2,price:10,changePercent:10,sealAmount:100,firstSealTime:'09:40:00',industry:'汽车'}]},phase:'主升期',fromSnapshot:true,lastGoodAt:Date.now(),history:[]};
  applyMobileJudgements(state);assert.equal(state.pools.up[0].promo.verdict,'规避');assert.equal(state.positionAdvice.ratio,null);assert.equal(state.unifiedDecision.trusted,false);
});
test('同一行情重复渲染不吞掉上一观察，不伪造连续承接',()=>{
  const stock={code:'600010',name:'甲',boards:2,price:10,changePercent:10,sealAmount:100,circulatingValue:10000,amount:100,firstSealTime:'09:40:00',industry:'汽车'};
  const state={pools:{date:'20261110',sources:{up:true},up:[stock]},phase:'主升期',marketClosed:true,lastSuccessAt:Date.now(),lastErrorAt:0,history:[]};
  applyMobileJudgements(state);
  state.lastSuccessAt+=1000;state.pools={...state.pools,up:[{...stock,amount:200}]};applyMobileJudgements(state);
  const note=state.pools.up[0].promo.checklist.find(r=>r.dim==='commitment').note;
  applyMobileJudgements(state);assert.equal(state.pools.up[0].promo.checklist.find(r=>r.dim==='commitment').note,note);assert.match(note,/未变薄/);
});
test('正常零池有效，缺数据的HTTP成功响应不算正常空池',async()=>{
  const fetch=globalThis.fetch;
  try{globalThis.fetch=async()=>new Response(JSON.stringify({data:{pool:[],tc:0,qdate:20261110}}));assert.equal((await fetchPools('20261110',{tries:1})).upCount,0);
    globalThis.fetch=async()=>new Response(JSON.stringify({data:null}));await assert.rejects(fetchPools('20261110',{tries:1}),/有效数据/);
  }finally{globalThis.fetch=fetch;}
});
test('日K同代码合并请求，切换显示区间复用同一数据',async()=>{
  const fetch=globalThis.fetch;let calls=0;
  try{globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({data:{klines:['2026-11-09,10,11,12,9,100,200000']}}));};
    const [a,b]=await Promise.all([loadChartBars('600099'),loadChartBars('600099')]);assert.equal(calls,1);assert.equal(a,b);assert.equal(a.bars[0].amount,200000);
    await loadChartBars('600099');assert.equal(calls,1);
  }finally{globalThis.fetch=fetch;}
});
test('板块成员按代码稳定分页，漏页不公布完整覆盖',async()=>{
  const fetch=globalThis.fetch;let pages=[];
  try{globalThis.fetch=async raw=>{const url=new URL(raw);pages.push(url.searchParams.get('fid'));return new Response(JSON.stringify({data:{total:200,diff:[{f12:'600001',f14:'甲'}]}}));};
    const result=await loadSectorMembers('BK9999');assert.equal(result.complete,false);assert.equal(result.rows.length,1);assert.ok(pages.every(v=>v==='f12'));
  }finally{globalThis.fetch=fetch;}
});
test('全市场分页参数与停牌空值保持正确',async()=>{
  const fetch=globalThis.fetch;let url;
  try{globalThis.fetch=async raw=>{url=new URL(raw);return new Response(JSON.stringify({data:{total:42,diff:[{f12:'600001',f14:'停牌',f2:'-',f3:'-'}]}}));};
    const result=await loadMarketPage({page:2,sort:'code'});assert.equal(url.searchParams.get('pn'),'2');assert.equal(url.searchParams.get('fid'),'f12');assert.equal(url.searchParams.get('po'),'0');assert.equal(result.rows[0].price,null);
  }finally{globalThis.fetch=fetch;}
});
test('买卖参考指数使用沪市上证代码，按日期提供相对强度基准',async()=>{
  const fetch=globalThis.fetch;let url;
  try{globalThis.fetch=async raw=>{url=new URL(raw);return new Response(JSON.stringify({data:{klines:['2026-11-09,3600,3660,3700,3550,100']}}));};
    const closes=await loadIndexCloses();assert.equal(url.searchParams.get('secid'),'1.000001');assert.equal(closes['20261109'],3660);
  }finally{globalThis.fetch=fetch;}
});
test('池外股票搜索使用有效建议接口，仅保留六位股票代码',async()=>{
  const fetch=globalThis.fetch;let url;
  try{globalThis.fetch=async raw=>{url=new URL(raw);return new Response(JSON.stringify({QuotationCodeTable:{Data:[{Code:'600519',Name:'贵州茅台'},{Code:'00700',Name:'港股'}]}}));};
    const rows=await lookupMobileStocks('贵州茅台');assert.equal(url.pathname,'/api/suggest/get');assert.deepEqual(rows.map(s=>s.code),['600519']);
  }finally{globalThis.fetch=fetch;}
});
