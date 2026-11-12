import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {workspaceFixture} from './mobile-performance-fixture.mjs';
import {planDate,planKey,updatePlan,normalizePlans,riskEstimate,mobileDecision,tradeFromForm} from '../daily-plan-core.js';
const draft={date:'2026-11-12',code:'600001',name:'测试标的',status:'planned',condition:'确认价格与承接',entry:10,stop:9,budget:10000};
test('同日同股计划幂等更新，跨日独立，观察可暂缺字段',()=>{
  let plans=updatePlan([],draft,'2026-11-12T01:00:00Z');plans=updatePlan(plans,{...draft,note:'补充'},'2026-11-12T02:00:00Z');assert.equal(plans.length,1);assert.equal(plans[0].createdAt,'2026-11-12T01:00:00Z');
  plans=updatePlan(plans,{...draft,date:'2026-11-13'});assert.equal(plans.length,2);
  assert.equal(updatePlan([],{...draft,status:'watching',entry:'',stop:'',budget:'',condition:''})[0].entry,null);
  assert.equal(planDate('20260229'),null);assert.equal(planKey('20261112','600001'),'2026-11-12:600001');
  assert.equal(normalizePlans([{...plans[0],status:'constructor'}]).length,0);
});
test('缺失条件和无效风险参数不能保存为完整计划',()=>{
  for(const changed of [{condition:''},{entry:''},{stop:11},{budget:-1},{status:'skipped',note:''}])assert.throws(()=>updatePlan([],{...draft,...changed}));
  assert.deepEqual(riskEstimate(draft,100000),{amount:1000,capitalPct:1});assert.equal(riskEstimate({...draft,stop:null},100000),null);
});
test('计划关联只在股票与日期一致时保留；更新既有交易不创建重复记录',()=>{
  const plan=updatePlan([],draft)[0];const form={code:'600001',date:'2026-11-12',name:'甲',status:'closed',buyPrice:'10',sellPrice:'11',quantity:'100',pnlPct:'',reason:'核对记录'};
  const trade=tradeFromForm(form,plan);assert.ok(Math.abs(trade.pnlPct-10)<1e-8);assert.equal(trade.dailyPlanId,plan.id);
  plan.note='后改';assert.notEqual(trade.dailyPlanSnapshot.note,plan.note);
  assert.equal(tradeFromForm({...form,date:'2026-11-13'},plan).dailyPlanId,null);
  const edited=tradeFromForm({...form,sellPrice:'9'},null,trade);assert.equal(edited.id,trade.id);assert.equal(edited.dailyPlanId,trade.dailyPlanId);
  assert.throws(()=>tradeFromForm({...form,status:'open',quantity:''},plan));
});
test('行情异常、全局限制与单股硬限制优先，评分不能替代信号',()=>{
  const stock={code:'600001',score:99,promo:{verdict:'可接力'},signal:{state:'待触发'}};
  assert.equal(mobileDecision(stock,{pools:{}}).label,'等触发');
  assert.equal(mobileDecision(stock,{pools:{},fromSnapshot:true}).label,'行情待核');
  assert.equal(mobileDecision(stock,{pools:{},opportunities:{noTrade:{triggered:true,reason:'休市'}}}).label,'暂停参与');
  assert.equal(mobileDecision({...stock,outsidePool:true},{pools:{}}).label,'快照外');
  assert.equal(mobileDecision({...stock,promo:null,signal:null},{pools:{}}).label,'仅行情');
});
test('四个新入口、旧视图与新离线资源全部存在，交易和研究资料仍使用原库',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8'),sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');
  for(const page of ['today','market','trading','validation'])assert.ok(html.includes('data-mobile-nav="'+page+'"'));
  for(const page of ['today','market','trading','validation','intraday','rank','tools'])assert.ok(html.includes('id="view-'+page+'"'));
  for(const file of ['mobile-daily.js','mobile-daily.css','daily-plan-core.js'])assert.ok(sw.includes('./'+file));
  assert.equal((html.match(/id="researchFold"/g)||[]).length,1);
});

test('行情未变时返回今日仍恢复日K，返回交易和验证仍读取本机记录',async()=>{
  const f=await workspaceFixture();f.workspace.navigate('today');f.flush();assert.equal(f.counters.daily,1);
  f.workspace.navigate('trading');f.flush();assert.equal(f.counters.dailyLeave,1);assert.equal(f.counters.tradeView,1);
  f.workspace.navigate('today');f.flush();assert.equal(f.counters.daily,2);assert.equal(f.elements.get('view-today').hidden,false);assert.equal(f.elements.get('view-trading').hidden,true);
  f.workspace.navigate('trading');f.flush();assert.equal(f.counters.tradeView,2);
  f.workspace.navigate('validation');f.flush();assert.equal(f.counters.validation,1);
  f.workspace.navigate('trading');f.flush();f.workspace.navigate('validation');f.flush();assert.equal(f.counters.validation,2);
  assert.equal(f.nav.find(e=>e.dataset.mobileNav==='validation').classList.contains('active'),true);
});

test('反复切股后日K只保留一个点击监听，均线一次点击只切换一次',async()=>{
  const saved=new Map(),clicks=new Set();
  const element=()=>({dataset:{},classList:{add(){},remove(){},toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(){},getBoundingClientRect:()=>({width:360})});
  const nodes=new Map(['.chart-state','[data-chart-refresh]','.chart-surface'].map(s=>[s,element()]));
  const root={isConnected:true,style:{setProperty(){}},querySelector:s=>nodes.get(s),querySelectorAll:()=>[],addEventListener:(_n,fn)=>clicks.add(fn),removeEventListener:(_n,fn)=>clicks.delete(fn)};
  const context=vm.createContext({console,localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)}});
  const mocks={ './mobile-data.js':`export const loadChartBars=async()=>({bars:[],source:'测试'});`, './refresh-feedback.js':`export const createRefreshFeedback=()=>({set(){}});`, './mobile-detail.js':`export const quoteTone=()=>'';` };
  const module=new vm.SourceTextModule(readFileSync(new URL('../mobile-chart.js',import.meta.url),'utf8'),{context});
  await module.link(async spec=>{const dependency=new vm.SourceTextModule(mocks[spec],{context});await dependency.link(()=>{});return dependency;});await module.evaluate();
  const chart=module.namespace.createMobileChart({doc:{}});chart.mount('600001',root);chart.mount('600002',root);chart.mount('600001',root);assert.equal(clicks.size,1);
  for(const click of clicks)click({target:{closest:s=>s==='[data-chart-ma]'?{dataset:{chartMa:'5'}}:null}});
  assert.deepEqual(JSON.parse(saved.get('mp-mobile-chart')).averages,[10,20]);chart.close();assert.equal(clicks.size,0);
});
