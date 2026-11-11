import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {createMobileRefresh,mobileRefreshResult} from '../mobile-interactions.js';
import {createRefreshFeedback} from '../refresh-feedback.js';
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
function environment(){
 const classes=new Set(),attrs={};const button={disabled:false,classList:{add:(...names)=>names.forEach(n=>classes.add(n)),remove:(...names)=>names.forEach(n=>classes.delete(n)),toggle(n,on){on?classes.add(n):classes.delete(n);}},setAttribute:(n,v)=>attrs[n]=v,removeAttribute:n=>delete attrs[n]};
 const media={matches:false,addEventListener(_n,fn){this.change=fn;}};const doc={hidden:false,addEventListener(){},querySelectorAll:()=>[]};const win={matchMedia:()=>media};const status={dataset:{},textContent:'',hidden:true};return {button,classes,attrs,media,doc,win,status};
}
test('手机基础主题、品牌和动效直接使用当前网页源码',()=>{
 const reference=process.env.MP_DESKTOP_APPEARANCE_ROOT || 'D:/codex';
 for(const [local,desktop]of [['desktop-tokens.css','ui/tokens.css'],['color-identity.css','ui/color-identity.css'],['interaction-motion.js','ui/motion.js'],['refresh-feedback.js','ui/refresh-feedback.js']])if(existsSync(path.join(reference,desktop)))assert.equal(read(local).replaceAll('\r\n','\n'),readFileSync(path.join(reference,desktop),'utf8').replaceAll('\r\n','\n'));
 const css=read('mobile-workspace.css');assert.doesNotMatch(css,/--(?:canvas|surface|chart-ma5|chart-ma10|chart-ma20):\s*#/);
 const identity=read('mobile-identity.css');for(const role of ['ui-accent','selection-ink','data-tone-ink','attention-ink','ranking-ink','risk-orange-ink','risk-yellow-ink'])assert.ok(identity.includes('var(--'+role+')'));
 assert.doesNotMatch(identity,/--view-accent\s*:|--data-ink\s*:\s*var\(--accent-ink\)/);
});
test('所有新皮肤资源版本一致，并且离线外壳覆盖主题与动画',()=>{
 const html=read('index.html'),sw=read('sw.js'),version=read('version.js').match(/mp-mobile-[\d-]+/)[0];
 for(const file of ['desktop-tokens.css','color-identity.css','motion.css','mobile-identity.css','boot-theme.js']){assert.ok(html.includes(file+'?v='+version),file+'未跟随版本');assert.ok(sw.includes('./'+file));}
 for(const file of ['interaction-motion.js','refresh-feedback.js','mobile-interactions.js','navigation-icons.css','icons/brand.svg'])assert.ok(sw.includes('./'+file));
 assert.match(html,/id="refreshStatus"/);assert.match(html,/class="theme-sun"/);assert.match(html,/class="theme-moon"/);
});
test('刷新合并并发，成功完成后释放按钮并保留正确反馈',async()=>{
 const env=environment();let calls=0,complete;const perform=()=>{calls++;return new Promise(r=>complete=r);};
 const refresh=createMobileRefresh({...env,perform,minimumMs:0});const a=refresh.run(),b=refresh.run();assert.equal(a,b);assert.equal(calls,1);assert.equal(env.button.disabled,true);assert(env.classes.has('is-loading'));
 complete({ok:true,targetLabel:'热度榜'});await a;assert(env.classes.has('is-done'));assert.equal(env.button.disabled,false);assert.equal(env.status.textContent,'热度榜已更新');
});
test('请求失败保留失败状态，部分数据或延迟数据不显示成功',async()=>{
 assert.equal(mobileRefreshResult({ok:true,partial:true}),'degraded');assert.equal(mobileRefreshResult({rows:[],source:'东方财富延迟行情'}),'degraded');assert.equal(mobileRefreshResult({rows:[]}),'success');
 const env=environment(),refresh=createMobileRefresh({...env,perform:async()=>{throw new Error('断网');},minimumMs:0});await refresh.run();assert(env.classes.has('is-fail'));assert.equal(env.button.disabled,false);assert.match(env.status.textContent,/保留上次/);
});
test('装饰动画失败不阻塞成功请求，连续刷新节流独立于结果',async()=>{
 const env=environment();let now=0,calls=0;const refresh=createMobileRefresh({...env,now:()=>now,minimumMs:0,perform:async()=>{calls++;return {ok:true};},motion:{refreshPage:async()=>{throw new Error('动画不支持');}}});
 await refresh.run();assert.equal(env.button.disabled,false);assert(env.classes.has('is-done'));await refresh.run();assert.equal(calls,1);now=2000;await refresh.run();assert.equal(calls,2);
});
test('旧反馈计时器不能清理新刷新，后台及减少动态效果仍保留状态',()=>{
 const env=environment(),timers=[];const feedback=createRefreshFeedback(env.button,{doc:env.doc,win:env.win,schedule:fn=>{timers.push(fn);return timers.length;},cancel(){}});
 feedback.set('success');feedback.set('loading');timers[0]();assert(env.classes.has('is-loading'));env.media.matches=true;env.media.change();assert(env.classes.has('refresh-motion-muted'));feedback.set('error');assert(env.classes.has('is-fail'));
});
