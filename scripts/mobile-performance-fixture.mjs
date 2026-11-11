import vm from 'node:vm';
import {readFileSync} from 'node:fs';

// Deliberately small DOM/data fixture: exercises the production workspace and its scheduler.
export async function workspaceFixture(source=readFileSync(new URL('../mobile-workspace.js',import.meta.url),'utf8')) {
  const frames=new Map(),listeners=new Map(),elements=new Map(),counters={board:0,market:0,tools:0,heat:0,html:0,monitor:0,reviews:0,trades:0,refresh:0,history:0,view:0};let next=0;
  function element(id='') {
    let html='';const classes=new Set();
    return {id,tagName:'DIV',dataset:{},value:'',hidden:false,open:false,disabled:false,textContent:'',options:[],scrollTop:0,
      classList:{contains:n=>classes.has(n),add:(...ns)=>ns.forEach(n=>classes.add(n)),remove:(...ns)=>ns.forEach(n=>classes.delete(n)),toggle(n,on){if(on??!classes.has(n))classes.add(n);else classes.delete(n);}},
      setAttribute(){},removeAttribute(){},addEventListener(n,fn){listeners.set(id+':'+n,fn);},querySelectorAll:()=>[],querySelector:()=>null,
      get innerHTML(){return html;},set innerHTML(v){html=v;counters.html++;},replaceChildren(){html='';},scrollIntoView(){},focus(){},showModal(){this.open=true;},close(){this.open=false;}};
  }
  const ids=[...readFileSync(new URL('../index.html',import.meta.url),'utf8').matchAll(/id="([^"]+)"/g)].map(m=>m[1]);ids.forEach(id=>elements.set(id,element(id)));
  const main=element('main'),nav=['market','intraday','rank','tools'].map(page=>{const e=element();e.dataset.mobileNav=page;return e;});
  const doc={documentElement:element('html'),getElementById:id=>elements.get(id),querySelector:s=>s==='main'?main:null,
    querySelectorAll:s=>s==='.view'?['market','intraday','rank','tools'].map(p=>elements.get('view-'+p)):s==='[data-mobile-nav]'?nav:[],
    addEventListener(n,fn){listeners.set('document:'+n,fn);},createElement:()=>element()};
  const win={requestAnimationFrame(fn){frames.set(++next,fn);return next;},cancelAnimationFrame:id=>frames.delete(id),history:{pushState(){counters.history++;}},location:{hash:'#intraday'},addEventListener(){}};
  const state={pools:{date:'20261111',up:[],upCount:0,downCount:0,sources:{up:true}},emotion:{},history:[],themes:[],leaders:[],lastSuccessAt:1,lastErrorAt:0,refreshMs:15000};
  const fixture={counters,readReviews:async()=>{counters.reviews++;return [];},readTrades:async()=>{counters.trades++;return [];},load:async()=>({rows:[],loadedAt:Date.now()}),monitor(){counters.monitor++;return {available:false};}};
  const context=vm.createContext({fixture,window:win,document:doc,location:win.location,localStorage:{getItem:()=>''},console,setTimeout,clearTimeout});
  const mocks={
    './refresh-feedback.js':`export const createRefreshFeedback=()=>({set(){}});`,
    './data.js':`export const shanghaiNow=()=>new Date(2026,10,11,16);`,
    './views.js':`export const esc=v=>String(v??'');export const pctText=v=>v==null?'—':v+'%';export const pctClass=v=>v>0?'up-c':'down-c';export const fmtMoney=v=>String(v);export function setHTML(el,html){if(!el||el.__last===html)return false;el.innerHTML=html;el.__last=html;return true;}`,
    './explorer-core.js':`export const marketNumber=v=>v==null?null:Number(v);export const snapshotMetaText=()=>'';export const filterHeatStocks=r=>r;export const filterHotRank=r=>r;export const filterSectorRows=r=>r;export const hotRankTier=()=>0;export const heatConceptsOf=()=>[];`,
    './mobile-data.js':`export const loadIndices=()=>fixture.load('indices'),loadIndexCloses=async()=>({}),loadMarketPage=()=>fixture.load('market'),loadSectors=()=>fixture.load('sectors'),loadSectorMembers=()=>fixture.load('members'),loadHotRank=()=>fixture.load('hot'),lookupMobileStocks=async()=>[],loadChartBars=async()=>({bars:[]});`,
    './advisor-core.js':`export const analyze=()=>({});`,
    './analytics.js':`export const limitThresholdOf=()=>10,COPILOT_QUESTIONS=[],buildCopilotAnswer=()=>'',routeCopilotQuery=()=>'',buildModeMonitor=()=>fixture.monitor();`,
    './store.js':`export const getKV=async(_k,v)=>v,setKV=async()=>{},getReviews=()=>fixture.readReviews(),getTrades=()=>fixture.readTrades(),putReview=async()=>{};`,
    './version.js':`export const APP_VERSION='test';`,
    './mobile-detail.js':readFileSync(new URL('../mobile-detail.js',import.meta.url),'utf8'),
    './mobile-render.js':readFileSync(new URL('../mobile-render.js',import.meta.url),'utf8')
  };
  const modules=new Map();const link=async spec=>{if(!modules.has(spec)){const m=new vm.SourceTextModule(mocks[spec],{context});modules.set(spec,m);await m.link(link);}return modules.get(spec);};
  for(const [fn,key]of [['renderBoard','board'],['renderMarket','market'],['renderTools','tools'],['paintHeat','heat']])source=source.replace('function '+fn+'() {','function '+fn+'() { fixture.counters.'+key+'++;');
  const module=new vm.SourceTextModule(source,{context});await module.link(link);await module.evaluate();
  const workspace=module.namespace.createMobileWorkspace({state,doc,win,onViewRender:()=>counters.view++,interactions:{refresh(){counters.refresh++;},motion:{page(){}}}});
  function frame(){const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn());}
  function flush(){for(let i=0;i<5&&frames.size;i++)frame();}
  return {workspace,state,doc,win,main,nav,elements,fixture,counters,listeners,frame,flush,frames};
}
