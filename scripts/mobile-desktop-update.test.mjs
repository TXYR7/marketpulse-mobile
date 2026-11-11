import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createMobileDetail,riskPresentation} from '../mobile-detail.js';
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');

test('风险与首板密度按网页最新显示分档，保留引擎分数和level',()=>{
  for(const [score,tone,text]of [[0,'low','稀疏'],[29,'low','稀疏'],[30,'medium','适中'],[70,'medium','适中'],[71,'high','拥挤'],[100,'high','拥挤']]){
    const item={key:'first',score,level:'green'},before={...item},view=riskPresentation(item);
    assert.equal(view.tone,tone);assert.equal(view.text,text);assert.equal(view.label,'首板密度');assert.equal(view.number,score);assert.deepEqual(item,before);
  }
  for(const [level,tone,text]of [['yellow','low','低风险'],['green','low','低风险'],['orange','medium','中风险'],['red','high','高风险']]){const v=riskPresentation({key:'break',level,score:45});assert.equal(v.tone,tone);assert.equal(v.text,text);}
  for(const [score,level]of [[0,'gray'],[null,'yellow'],[NaN,'red'],['','orange'],[10,'unknown']]){const v=riskPresentation({key:'break',score,level});assert.equal(v.tone,'unknown');assert.equal(v.number,'—');}
});
function detailFixture(){
  const panels=new Map(),tabs=new Map(),events=new Map();let loads=0;
  for(const name of ['overview','chart','evidence']){const attrs={},classes=new Set();panels.set('sheet-'+name,{hidden:false,marker:{name}});tabs.set(name,{dataset:{sheetSection:name},classList:{toggle(n,on){on?classes.add(n):classes.delete(n);}},setAttribute:(n,v)=>attrs[n]=v,attrs,focus(){this.focused=true;}});}
  const sheet={scrollTop:0,scrollHeight:1200,clientHeight:600,querySelector:s=>tabs.get(/"(\w+)"/.exec(s)?.[1]),addEventListener:(n,fn)=>events.set(n,fn)};
  const reader=createMobileDetail({sheet,doc:{getElementById:id=>panels.get(id)},onChart:()=>loads++});return {reader,sheet,panels,tabs,events,get loads(){return loads;}};
}
test('详情默认速览，日K第一次打开才加载，返回复用DOM、数据和分区滚动',()=>{
  const f=detailFixture();f.reader.reset();assert.equal(f.loads,0);assert.equal(f.panels.get('sheet-chart').hidden,true);
  f.sheet.scrollTop=200;f.reader.select('chart');assert.equal(f.loads,1);assert.equal(f.sheet.scrollTop,0);
  const marker=f.panels.get('sheet-chart').marker;f.sheet.scrollTop=80;f.reader.select('evidence');f.reader.select('chart');
  assert.equal(f.loads,1);assert.equal(f.sheet.scrollTop,80);assert.equal(f.panels.get('sheet-chart').marker,marker);
  f.reader.select('overview');assert.equal(f.sheet.scrollTop,200);f.reader.reset();f.reader.select('chart');assert.equal(f.loads,2);
});
test('详情页签可用方向键导航，首末直达保持当前分区',()=>{
  const f=detailFixture();f.reader.reset();let prevented=0;
  f.events.get('keydown')({target:{closest:()=>f.tabs.get('overview')},key:'ArrowRight',preventDefault(){prevented++;}});
  assert.equal(f.reader.current(),'chart');assert.equal(f.tabs.get('chart').focused,true);assert.equal(prevented,1);assert.equal(f.tabs.get('overview').attrs['aria-selected'],'false');
  f.events.get('click')({target:{closest:s=>s==='[data-sheet-edge]'?{dataset:{sheetEdge:'bottom'}}:null}});assert.equal(f.sheet.scrollTop,600);assert.equal(f.reader.current(),'chart');
});
test('最新局部明暗配色与刷新渐变覆盖手机入口且不会恢复整页扫描层',()=>{
  const css=read('mobile-desktop-update.css'),motion=read('motion.css'),html=read('index.html'),sw=read('sw.js'),version=read('version.js').match(/mp-mobile-[\d-]+/)[0];
  for(const file of ['mobile-desktop-update.css','mobile-detail.js'])assert.ok(sw.includes('./'+file));assert.ok(html.includes('mobile-desktop-update.css?v='+version));
  assert.match(css,/#sheet \{[^}]*--data-tone: #60a5fa/);assert.match(css,/html\[data-theme="light"\] #sheet \{[^}]*--data-tone: #2563eb/);
  assert.ok(motion.includes('--refresh-aqua: #22d3ee'));assert.ok(motion.includes('--refresh-blue: #3b82f6'));assert.ok(css.includes('body:has(#refreshBtn.is-loading) #mobileMain::after { display:none; }'));
  for(const tone of ['ready','avoid'])assert.ok(css.includes('.s-verdict[data-tone="'+tone+'"]'));
  assert.ok(read('app.js').includes('sheetReader.reset()'));assert.doesNotMatch(read('app.js'),/detailChart\.mount\(code, \$\('#sheetKline'\)\)/);
});
