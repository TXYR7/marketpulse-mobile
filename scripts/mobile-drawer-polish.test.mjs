import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createMobileDrawerMotion} from '../mobile-drawer-motion.js';
import {createMobileDetail,quoteTone} from '../mobile-detail.js';
import {chartReadoutHTML} from '../mobile-chart.js';
import {workspaceFixture} from './mobile-performance-fixture.mjs';
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
function motionFixture(){
  const animations=[],classes=new Set(),listeners=new Map();let reads=0;
  const media={matches:false,addEventListener(n,fn){listeners.set('media:'+n,fn);}};
  const doc={hidden:false,addEventListener(n,fn){listeners.set(n,fn);}};
  const win={matchMedia:()=>media,getComputedStyle(){reads++;return {transform:'matrix(1,0,0,1,0,90)'};}};
  const sheet={style:{transform:''},classList:{add:n=>classes.add(n),remove:n=>classes.delete(n)},getBoundingClientRect(){throw Error('Drawer should not measure height');},animate(frames,options){
    let done,fail;const animation={frames,options,finished:new Promise((r,j)=>{done=r;fail=j;}),finish:()=>done(),cancel(){this.cancelled=true;fail(new Error('cancelled'));}};animations.push(animation);return animation;
  }};
  return {doc,win,media,sheet,animations,classes,listeners,get reads(){return reads;}};
}
test('抽屉使用两个位置关键帧，无高度读写；结束后释放合成层',async()=>{
  const f=motionFixture(),motion=createMobileDrawerMotion(f);const open=motion.animate(f.sheet,{opening:true});
  assert.equal(f.animations[0].frames.length,2);assert.deepEqual(Object.keys(f.animations[0].frames[0]),['transform']);assert.equal(f.reads,0);assert.equal(f.animations[0].options.duration,240);
  f.animations[0].finish();await open;assert.equal(motion.busy(f.sheet),false);assert.equal(f.classes.size,0);
  const close=motion.animate(f.sheet,{opening:false});assert.equal(f.animations[1].options.duration,200);f.animations[1].finish();await close;assert.equal(f.classes.size,0);
});
test('连续开关从当前位移衔接，旧动画完成不能清理新动画',async()=>{
  const f=motionFixture(),motion=createMobileDrawerMotion(f),a=motion.animate(f.sheet,{opening:true}),b=motion.animate(f.sheet,{opening:false});
  assert.equal(f.animations[0].cancelled,true);assert.equal(f.animations[1].frames[0].transform,'matrix(1,0,0,1,0,90)');
  await a;assert.equal(motion.busy(f.sheet),true);assert(f.classes.has('mobile-drawer-layer'));
  const c=motion.animate(f.sheet,{opening:true});await b;assert.equal(motion.busy(f.sheet),true);f.animations[2].finish();await c;assert.equal(f.classes.size,0);
});
test('拖动位置被保留到退出动画，减少动画和后台状态即时落位',async()=>{
  const f=motionFixture(),motion=createMobileDrawerMotion(f);const open=motion.animate(f.sheet,{opening:true});assert.equal(motion.pause(f.sheet),90);await open;
  assert.equal(f.sheet.style.transform,'matrix(1,0,0,1,0,90)');const close=motion.animate(f.sheet,{opening:false});assert.equal(f.animations[1].frames[0].transform,'matrix(1,0,0,1,0,90)');
  f.media.matches=true;f.listeners.get('media:change')();await close;assert.equal(f.classes.size,0);
  await motion.animate(f.sheet,{opening:true});assert.equal(f.animations.length,2);f.media.matches=false;f.doc.hidden=true;await motion.animate(f.sheet,{opening:false});assert.equal(f.animations.length,2);
});
test('涨跌、平盘、停牌与缺失现价均有正确价格颜色，指数和列表使用同一口径',async()=>{
  for(const [p,c,tone]of [[10,1,'up-c'],[10,-1,'down-c'],[10,0,'flat-c'],[null,1,'flat-c'],[0,1,'flat-c'],[10,null,'flat-c'],[10,'','flat-c'],[10,NaN,'flat-c']])assert.equal(quoteTone(p,c),tone);
  const f=await workspaceFixture();f.fixture.load=async()=>({rows:[{name:'上涨指数',price:3000,changePct:1},{name:'下跌指数',price:2000,changePct:-1},{name:'平盘指数',price:1000,changePct:0}]});
  f.state.leaders=[{code:'600001',name:'下跌股票',price:10,changePct:-2}];f.state.fromSnapshot=true;f.workspace.navigate('market');f.flush();await new Promise(r=>setImmediate(r));
  const html=f.elements.get('marketIndices').innerHTML;for(const [klass,n]of [['up-c','3000.00'],['down-c','2000.00'],['flat-c','1000.00']])assert.ok(html.includes('<b class="'+klass+'">'+n));
  assert.match(f.elements.get('marketLeaders').innerHTML,/<b class="down-c">10.00/);assert.match(f.elements.get('marketHero').innerHTML,/data-status="cached"/);
});
test('候选失效参考保留真实数字，现价涨跌不再被正文色覆盖',async()=>{
  const f=await workspaceFixture();f.state.pools.up=[{code:'600002',name:'测试',price:10,changePct:1,promo:{verdict:'可接力',score:85,actionPlan:{invalidation:['价格失效参考 9.50']}}}];f.workspace.navigate('intraday');f.flush();
  const html=f.elements.get('mobileCandidates').innerHTML;assert.match(html,/data-available="true">失效参考 <b>9.50/);assert.match(html,/现价 <b class="up-c">10.00/);
});
test('首封保持时间色，缺失值单独标注，零炸板不伪装成缺失或风险',()=>{
  const source=read('app.js'),start=source.indexOf('function kvEss('),end=source.indexOf('\n}\n',start)+2;
  const kv=vm.runInNewContext('('+source.slice(start,end)+')',{fmtMoney:String,fmtTime:()=> '09:25:00'});
  const html=kv({seal:100,turnover:2,firstSeal:92500,breaks:0});assert.match(html,/data-value-role="break" data-available="true" data-alert="false"/);assert.match(html,/data-value-role="time"/);
  assert.match(kv({}),/data-value-role="capital" data-available="false"/);
});
test('日K收盘数字随蜡烛方向着色，日期和开高低保持可读',()=>{
  for(const [close,tone]of [[11,'up-c'],[9,'down-c'],[10,'flat-c']])assert.ok(chartReadoutHTML({date:'20261111',open:10,high:12,low:8,close}).includes('<b class="'+tone+'">'+close.toFixed(2)));
});
test('历史参考首次进入依据才请求，切回速览或K线不重复计算',()=>{
  let calls=0;const panels=new Map(),buttons=new Map();for(const name of ['overview','chart','evidence']){panels.set('sheet-'+name,{});buttons.set(name,{classList:{toggle(){}},setAttribute(){}});}
  const sheet={scrollTop:0,querySelector:s=>buttons.get(/"(\w+)"/.exec(s)?.[1]),addEventListener(){}};
  const reader=createMobileDetail({sheet,doc:{getElementById:id=>panels.get(id)},onEvidence:()=>calls++});reader.reset();reader.select('chart');assert.equal(calls,0);reader.select('evidence');reader.select('overview');reader.select('evidence');assert.equal(calls,1);reader.reset();reader.select('evidence');assert.equal(calls,2);
});
test('抽屉遮住的页面暂缓重绘，关闭后只呈现一次最新数据',async()=>{
  const f=await workspaceFixture();f.workspace.navigate('intraday');f.flush();const query=f.doc.querySelector;let covered=true;
  f.doc.querySelector=s=>s==='.sheet.show'&&covered?{}:query(s);
  for(let i=0;i<20;i++)f.workspace.refresh();f.flush();assert.equal(f.counters.board,1);
  covered=false;f.workspace.resume();f.flush();assert.equal(f.counters.board,2);
});
test('移动端箭头样式撤销、模糊撤销、状态配色和离线资源均接入',()=>{
  const css=read('mobile-drawer-polish.css'),html=read('index.html'),sw=read('sw.js'),version=read('version.js').match(/mp-mobile-[\d-]+/)[0];
  assert.ok(css.includes('content:none !important'));assert.ok(css.includes("content:'展开'"));assert.ok(css.includes("content:'收起'"));assert.ok(css.includes('backdrop-filter:none'));
  assert.ok(html.includes('mobile-drawer-polish.css?v='+version));for(const file of ['mobile-drawer-motion.js','mobile-drawer-polish.css'])assert.ok(sw.includes('./'+file));
  assert.match(read('app.js'),/sheetOpenTask=drawerMotion.animate/);assert.match(read('app.js'),/sheetOpenTask.then/);assert.doesNotMatch(read('app.js'),/interactions.motion.inspector\(sheet/);
});
