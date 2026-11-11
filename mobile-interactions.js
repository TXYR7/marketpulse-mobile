import { createInteractionMotion } from './interaction-motion.js';
import { createRefreshFeedback } from './refresh-feedback.js';

export function mobileRefreshResult(data) {
  if(!data || data.error || data.ok===false)return 'error';
  if(data.partial || data.fromSnapshot || data.delayed || data.stale || /延迟/.test(data.source||''))return 'degraded';
  return 'success';
}
export function createMobileRefresh({ button, status, perform, motion, doc=document, win=window, now=Date.now, schedule=setTimeout, minimumMs=700, cooldownMs=1200 }) {
  const feedback=createRefreshFeedback(button,{doc,win,schedule});
  let pending=null,lastStarted=-Infinity,generation=0;
  function run() {
    if(pending)return pending;
    if(now()-lastStarted<cooldownMs)return Promise.resolve({throttled:true});
    const id=++generation;lastStarted=now();feedback.set('loading');button.disabled=true;
    const followers=Array.from(doc.querySelectorAll?.('[data-refresh-trigger]')||[]).filter(el=>!el.closest?.('[hidden]')).map(el=>({el,label:el.textContent,disabled:el.disabled}));
    followers.forEach(({el})=>{el.disabled=true;el.classList.remove('is-done','is-degraded','is-fail');el.classList.add('mobile-refresh-control','is-loading');el.setAttribute('aria-busy','true');el.textContent='正在更新…';});
    if(status){status.hidden=false;status.dataset.status='loading';status.textContent='正在更新当前页面…';}
    pending=(async()=>{
      let result,tone;
      try{result=await perform();tone=mobileRefreshResult(result);}catch(error){result={error:error.message};tone='error';}
      const remaining=minimumMs-(now()-lastStarted);if(remaining>0)await new Promise(resolve=>schedule(resolve,remaining));
      if(id!==generation)return result;
      if(tone!=='error' && motion)try{await motion.refreshPage(()=>{});}catch{}
      feedback.set(tone);button.disabled=false;
      followers.forEach(({el,label,disabled})=>{const cls={success:'is-done',degraded:'is-degraded',error:'is-fail'}[tone];el.disabled=disabled;el.removeAttribute('aria-busy');el.classList.remove('is-loading');el.classList.add(cls);el.textContent=label;schedule(()=>{if(id===generation)el.classList.remove(cls);},1800);});
      const label=result?.targetLabel||'当前页面';
      if(status){status.dataset.status=tone;status.textContent=tone==='success'?label+'已更新':tone==='degraded'?label+'更新完成，部分数据为快照或仍有缺失':label+'更新失败，保留上次数据；可重试';}
      return result;
    })().finally(()=>{if(id===generation)pending=null;});
    return pending;
  }
  return {run,feedback,get pending(){return pending;}};
}

export function createMobileInteractions({doc=document,win=window}={}) {
  const aliases={themeButton:'themeBtn',refreshButton:'refreshBtn'};
  const adaptedDoc=new Proxy(doc,{get(target,key){
    if(key==='getElementById')return id=>target.getElementById(aliases[id]||id);
    if(key==='querySelector')return selector=>{const node=target.querySelector(selector==='.app-shell'?'#mobileMain':selector);return node?.closest('[hidden]')?null:node;};
    if(key==='querySelectorAll')return selector=>Array.from(target.querySelectorAll('.topbar,.view.active,dialog[open],.sheet.show')).flatMap(root=>Array.from(root.querySelectorAll(selector)));
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  const motion=createInteractionMotion({doc:adaptedDoc,win});
  let theme='dark';
  try{theme=doc.documentElement.dataset.theme==='light'?'light':'dark';}catch{}
  function commitTheme(next) {
    theme=next;doc.documentElement.dataset.theme=next;
    try{localStorage.setItem('mp-theme',next);}catch{}
    const style=win.getComputedStyle(doc.documentElement);
    const canvas=style.backgroundColor || style.getPropertyValue('--canvas').trim();
    doc.querySelector('meta[name="theme-color"]')?.setAttribute('content',canvas);
    doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content',next);
    const button=doc.getElementById('themeBtn');button?.setAttribute('aria-label',next==='light'?'切换到深色主题':'切换到浅色主题');button?.setAttribute('aria-pressed',String(next==='light'));
    button?.setAttribute('title',next==='light'?'切换到深色主题':'切换到浅色主题');
  }
  function toggleTheme(event) {
    const next=theme==='light'?'dark':'light';theme=next;
    return motion.theme(()=>commitTheme(next),event && event.detail!==0?{x:event.clientX,y:event.clientY}:undefined);
  }
  const prepared=new WeakSet();
  function prepareControls() {
    const roots=doc.querySelectorAll('.topbar,.mobile-bottom-nav,.view.active,dialog[open],.sheet.show');
    for(const root of roots)for(const element of root.querySelectorAll('button,details,.mobile-search-result')) {
      if(prepared.has(element))continue; prepared.add(element);
      if(element.tagName==='BUTTON'&&element.id!=='themeBtn'&&!element.classList.contains('nav-link'))element.classList.add('outline-button');
      if(element.tagName==='DETAILS')element.classList.add('board-full-data');
      if(element.classList.contains('mobile-search-result'))element.classList.add('stock-search-option');
    }
    motion.refresh();
  }
  let queued=false;
  const refresh=()=>{if(queued)return;queued=true;win.requestAnimationFrame(()=>{queued=false;prepareControls();});};
  commitTheme(theme);prepareControls();
  doc.addEventListener('click',event=>{
    if(event.target.closest?.('[data-mobile-nav],[data-rank-tab],[data-candidate-scope],[data-heat-board],[data-chart-range],[data-chart-ma],summary,[data-code],[data-search-code],[data-sector],#openStockSearch'))refresh();
  });
  // 原生揭幕快照有时把点击目标报告为 HTML。只对位置固定的操作补交付，避免按新数据行猜旧画面的标的。
  doc.addEventListener('click',event=>{
    if(!event.detail || (event.target!==doc.documentElement&&event.target!==doc.body) || !doc.documentElement.classList.contains('motion-theme-reveal')&&!doc.documentElement.classList.contains('motion-refresh-reveal'))return;
    const modal=doc.querySelector('dialog[open]');
    for(const button of doc.querySelectorAll('.topbar button,.mobile-bottom-nav button,[data-rank-tab],[data-candidate-scope],[data-chart-range],[data-chart-ma]')){
      if(button.disabled||button.closest('[hidden],[inert]')||modal&&!modal.contains(button))continue;
      const rect=button.getBoundingClientRect();
      if(rect.width&&rect.height&&event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom){event.preventDefault();button.focus({preventScroll:true});button.click();break;}
    }
  },true);
  doc.addEventListener('change',refresh);
  doc.addEventListener('input',event=>{if(event.target.closest?.('#candidateSearch,#heatSearch,#hotSearch,#sectorSearch,#membersSearch'))refresh();});
  win.addEventListener('resize',refresh);
  return {motion,toggleTheme,refresh,theme:()=>theme};
}
