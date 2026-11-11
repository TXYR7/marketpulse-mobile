import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {workspaceFixture} from './mobile-performance-fixture.mjs';
import {createSnapshotBackfill} from '../mobile-render.js';
import {applyMobileJudgements} from '../mobile-model.js';
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');

test('安卓安装/全屏预留系统按键区，浏览器和iOS保留原生模式，并响应模式变化',()=>{
  for(const android of [true,false])for(const mode of ['browser','standalone','fullscreen','minimal-ui']){
    const root={dataset:{}},media=[];
    vm.runInNewContext(read('mobile-viewport.js'),{document:{documentElement:root},navigator:{userAgent:android?'Android':'iPhone'},window:{matchMedia(query){const m={matches:query.includes(mode)&&mode!=='browser',addEventListener(_n,fn){this.change=fn;}};media.push(m);return m;}}});
    assert.equal(root.dataset.mobilePlatform,android?'android':'other');assert.equal(root.dataset.mobileDisplay,mode==='browser'?'browser':'installed');
    media.forEach(m=>m.matches=false);media[0].change();assert.equal(root.dataset.mobileDisplay,'browser');
  }
  const css=read('styles.css');assert.match(css,/\[data-mobile-platform="android"\]\[data-mobile-display="installed"\][\s\S]*?--safe-b: max\(env\(safe-area-inset-bottom, 0px\), 56px\)/);
  const version=read('version.js').match(/mp-mobile-[\d-]+/)[0];assert.ok(read('index.html').includes('mobile-viewport.js?v='+version));
  for(const file of ['mobile-viewport.js','mobile-render.js'])assert.ok(read('sw.js').includes('./'+file));
});

test('选中导航立即更新，内容在下一次绘制后生成，连续切页只生成最终页面',async()=>{
  const f=await workspaceFixture();f.workspace.navigate('intraday');
  assert.equal(f.state.view,'intraday');assert.equal(f.nav[1].classList.contains('active'),true);assert.equal(f.counters.board,0);
  f.frame();assert.equal(f.counters.board,0);f.workspace.navigate('rank');f.flush();
  assert.equal(f.counters.board,0);assert.equal(f.counters.heat,1);assert.equal(f.elements.get('view-intraday').hidden,true);
});

test('重复点击和未变数据切回复用页面，保留每页滚动与筛选输入',async()=>{
  const f=await workspaceFixture();f.workspace.navigate('intraday');f.flush();const html=f.elements.get('mobileCandidates').innerHTML;
  f.main.scrollTop=480;f.elements.get('candidateSearch').value='机器人';
  for(let i=0;i<50;i++)f.workspace.navigate('intraday');f.flush();assert.equal(f.counters.board,1);
  f.workspace.navigate('rank');f.flush();f.main.scrollTop=70;f.workspace.navigate('intraday');f.flush();
  assert.equal(f.counters.board,1);assert.equal(f.main.scrollTop,480);assert.equal(f.elements.get('candidateSearch').value,'机器人');assert.equal(f.elements.get('mobileCandidates').innerHTML,html);
});

test('行情更新合并成一次可见渲染，隐藏页在返回后读取最新状态',async()=>{
  const f=await workspaceFixture();f.workspace.navigate('intraday');f.flush();
  for(let i=0;i<20;i++)f.workspace.refresh();assert.equal(f.counters.board,1);f.flush();assert.equal(f.counters.board,2);
  f.workspace.navigate('rank');f.flush();for(let i=0;i<20;i++)f.workspace.refresh();f.flush();assert.equal(f.counters.board,2);
  f.workspace.navigate('intraday');f.flush();assert.equal(f.counters.board,3);
});

test('工具输入不被轮询覆盖，历史统计和本地记录读取有缓存',async()=>{
  const f=await workspaceFixture();f.workspace.navigate('tools');f.flush();await new Promise(r=>setImmediate(r));
  f.elements.get('toolToken').value='unsaved-token';f.elements.get('toolRefresh').value='30000';
  for(let i=0;i<20;i++)f.workspace.refresh();f.flush();
  assert.equal(f.elements.get('toolToken').value,'unsaved-token');assert.equal(f.elements.get('toolRefresh').value,'30000');
  assert.equal(f.counters.monitor,1);assert.equal(f.counters.reviews,1);assert.equal(f.counters.trades,1);
  f.state.history=[{date:'20261110',stocks:[]}];f.workspace.refresh();f.flush();assert.equal(f.counters.monitor,2);
});

test('隐藏热榜的异步响应只更新缓存，返回热榜再呈现',async()=>{
  const f=await workspaceFixture();let complete;f.fixture.load=()=>new Promise(r=>complete=r);f.workspace.bind();f.flush();
  f.workspace.navigate('rank');f.flush();const tab={dataset:{rankTab:'hot'}};
  f.listeners.get('document:click')({target:{closest:s=>s==='[data-rank-tab]'?tab:null}});f.flush();await new Promise(r=>setImmediate(r));
  f.workspace.navigate('intraday');f.flush();const before=f.elements.get('hotRows').innerHTML;
  complete({rows:[{code:'600001',name:'测试股票',rank:1}]});await new Promise(r=>setImmediate(r));assert.equal(f.elements.get('hotRows').innerHTML,before);
  f.workspace.navigate('rank');f.flush();assert.match(f.elements.get('hotRows').innerHTML,/测试股票/);
});

test('工具在后台读完本地记录，返回时呈现缓存；保存复盘不被旧读取覆盖',async()=>{
  const f=await workspaceFixture();let complete,reads=0;
  f.fixture.readReviews=()=>{reads++;return reads===1?new Promise(r=>complete=r):Promise.resolve([{date:'2026-11-11',note:'刚保存的复盘'}]);};
  f.workspace.bind();f.flush();f.workspace.navigate('tools');f.flush();
  f.elements.get('reviewDate').value='2026-11-11';f.elements.get('reviewNote').value='刚保存的复盘';
  await f.listeners.get('reviewSave:click')();complete([]);await new Promise(r=>setImmediate(r));
  assert.equal(reads,2);assert.match(f.elements.get('reviewEntries').innerHTML,/刚保存的复盘/);
  f.workspace.navigate('intraday');f.flush();f.workspace.navigate('tools');f.flush();assert.equal(reads,2);
});

test('同一行情日K回填合并，过期回填不改写新行情，两次真实观察仍被保留',()=>{
  const timers=[];let applies=0;
  const stock={code:'600012',name:'测试',boards:2,price:10,changePercent:10,sealAmount:100,circulatingValue:10000,amount:100,firstSealTime:'09:40:00',industry:'汽车'};
  const state={pools:{date:'20261110',sources:{up:true},up:[stock]},phase:'主升期',marketClosed:true,lastSuccessAt:Date.now(),lastErrorAt:0,history:[]};
  const apply=()=>{applies++;applyMobileJudgements(state);};
  const queue=createSnapshotBackfill(()=>({pools:state.pools,at:state.lastSuccessAt}),apply,{schedule:fn=>{timers.push(fn);return timers.length;}});
  apply();for(let i=0;i<12;i++)queue();assert.equal(timers.length,1);timers.shift()();assert.equal(applies,2);
  queue();state.lastSuccessAt+=1000;state.pools={...state.pools,up:[{...stock,amount:200}]};apply();
  const note=()=>state.pools.up[0].promo.checklist.find(r=>r.dim==='commitment').note;
  const observed=note();assert.match(observed,/未变薄/);timers.shift()();assert.equal(applies,3);
  for(let i=0;i<12;i++)queue();timers.shift()();assert.equal(applies,4);assert.equal(note(),observed);
});
