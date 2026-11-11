const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../interaction-motion.js'), 'utf8');
const modulePromise = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function environment() {
  const classes = new Set(), transitions = [], animations = [];
  const media = { matches: false, addEventListener(_name, callback) { this.listener = callback; } };
  function animate(frames, options) {
    let finish, reject;
    const animation = { frames, options, cancelled: false, finished: new Promise((yes,no) => { finish = yes; reject = no; }),
      finish, cancel() { this.cancelled = true; reject(new Error('cancelled')); } };
    animation.finish = finish;
    animations.push(animation);
    return animation;
  }
  const root = { animate, clientWidth: 1000, clientHeight: 600, classList: {
    add(...names) { names.forEach(name => classes.add(name)); }, remove(...names) { names.forEach(name => classes.delete(name)); }
  } };
  const button = { animate, getBoundingClientRect: () => ({left:900,top:10,width:30,height:30}) };
  const doc = { hidden: false, documentElement: root, events: {}, addEventListener(name,callback) { this.events[name] = callback; },
    getElementById: id => id === 'themeButton' ? button : null, querySelector: () => null, querySelectorAll: () => [],
    startViewTransition(callback) {
      let ready, fail, finish;
      const transition = { ready: new Promise((yes,no) => {ready=yes;fail=no;}), finished: new Promise(yes => {finish=yes;}),
        skipped:false, update() {callback();ready();}, fail() {fail(new Error('snapshot failed'));},
        finish() {finish();}, skipTransition() {this.skipped=true;fail(new Error('skipped'));finish();} };
      transitions.push(transition); return transition;
    }
  };
  const win = {innerWidth:1000,innerHeight:600,matchMedia:() => media,getComputedStyle:() => ({})};
  return {doc,win,media,classes,transitions,animations};
}

test('揭幕从点击处开始，半径覆盖最远角落，完成后释放动画层', async () => {
  const {createInteractionMotion} = await modulePromise, env = environment(), motion = createInteractionMotion(env);
  let changes = 0;
  const done = motion.theme(() => changes++, {x:95,y:45});
  env.transitions[0].update(); await flush();
  assert.equal(changes,1);
  const reveal = env.animations.find(animation => animation.options.pseudoElement === '::view-transition-new(root)');
  assert.equal(reveal.frames[0].clipPath,'circle(0px at 95px 45px)');
  const radius = Number(reveal.frames[1].clipPath.match(/circle\(([\d.]+)/)[1]);
  assert.ok(radius >= Math.hypot(905,555));
  assert.ok(env.animations.some(animation => animation.options.pseudoElement === '::view-transition-new(theme-toggle)'));
  env.transitions[0].finish(); await done;
  assert.equal(env.classes.has('motion-theme-reveal'),false);
  assert.ok(env.animations.every(animation => animation.cancelled));
});

test('快连点提交每次点击，旧快照回调不覆盖新主题或清理新动画', async () => {
  const {createInteractionMotion} = await modulePromise, env = environment(), motion = createInteractionMotion(env);
  let light = false, changes = 0;
  const change = () => {light=!light;changes++;};
  const first = motion.theme(change), second = motion.theme(change);
  assert.equal(changes,1);
  assert.equal(env.transitions[0].skipped,true);
  env.transitions[1].update(); env.transitions[0].update(); await flush();
  assert.equal(changes,2); assert.equal(light,false);
  assert.equal(env.classes.has('motion-theme-reveal'),true);
  env.transitions[1].finish(); await Promise.all([first,second]);
  assert.equal(env.classes.has('motion-theme-reveal'),false);
});

test('键盘触发从按钮中心揭幕；减少动态效果和后台切换即时生效', async () => {
  const {createInteractionMotion} = await modulePromise, env = environment(), motion = createInteractionMotion(env);
  let changes = 0;
  const active = motion.theme(() => changes++);
  env.transitions[0].update(); await flush();
  assert.equal(env.animations[0].frames[0].clipPath,'circle(0px at 915px 25px)');
  env.media.matches = true; env.media.listener(); await active;
  assert.equal(env.classes.has('motion-theme-reveal'),false);
  const count = env.animations.length;
  await motion.theme(() => changes++);
  assert.equal(env.animations.length,count);
  env.media.matches = false; env.doc.hidden = true;
  await motion.theme(() => changes++);
  assert.equal(changes,3); assert.equal(env.transitions.length,1);
});

test('快照失败仍切换一次并清理，不支持新接口时使用原生动画兜底', async () => {
  const {createInteractionMotion} = await modulePromise, env = environment(), motion = createInteractionMotion(env);
  let changes = 0;
  const failed = motion.theme(() => changes++);
  env.transitions[0].fail(); await flush(); await failed;
  assert.equal(changes,1); assert.equal(env.classes.has('motion-theme-reveal'),false);
  delete env.doc.startViewTransition;
  const fallback = motion.theme(() => changes++);
  assert.equal(changes,2);
  env.animations.at(-1).finish(); await fallback;
});

test('整页刷新从刷新按钮铺开新画面，更新只提交一次并清理覆盖层',async()=>{
  const {createInteractionMotion}=await modulePromise,env=environment();
  env.doc.getElementById=id=>id==='refreshButton'?{getBoundingClientRect:()=>({left:800,top:10,width:30,height:30})}:null;
  const motion=createInteractionMotion(env);let updates=0;
  const done=motion.refreshPage(()=>updates++);
  assert(env.classes.has('motion-refresh-reveal'));
  env.transitions[0].update();await flush();
  assert.equal(updates,1);
  assert.equal(env.animations[0].frames[0].clipPath,'circle(0px at 815px 25px)');
  assert.equal(env.animations[0].options.duration,600);
  env.transitions[0].finish();await done;
  assert.equal(updates,1);assert(!env.classes.has('motion-refresh-reveal'));
});

test('刷新被主题切换打断时数据仍提交，旧回调不能清理新主题动画',async()=>{
  const {createInteractionMotion}=await modulePromise,env=environment(),motion=createInteractionMotion(env);
  let updates=0,changes=0;
  const refresh=motion.refreshPage(()=>updates++),theme=motion.theme(()=>changes++);
  assert.equal(updates,1);assert(env.transitions[0].skipped);
  env.transitions[0].update();env.transitions[1].update();await flush();
  assert.equal(updates,1);assert.equal(changes,1);assert(env.classes.has('motion-theme-reveal'));
  env.transitions[1].finish();await Promise.all([refresh,theme]);
  assert(!env.classes.has('motion-theme-reveal'));assert(!env.classes.has('motion-refresh-reveal'));
});

test('整页渲染失败会传回调用方，减少动态效果时更新立即生效',async()=>{
  const {createInteractionMotion}=await modulePromise,env=environment(),motion=createInteractionMotion(env);
  const failed=motion.refreshPage(()=>{throw new Error('渲染失败');});
  env.transitions[0].update();await flush();env.transitions[0].finish();
  await assert.rejects(failed,/渲染失败/);assert(!env.classes.has('motion-refresh-reveal'));
  env.media.matches=true;let updates=0;await motion.refreshPage(()=>updates++);
  assert.equal(updates,1);assert.equal(env.transitions.length,1);
});
