import {esc,pctText} from './views.js';
import {updateSignalReport,runMobileBacktest,readMobileResearch} from './mobile-research.js';
import {signalReport} from './signal-core.js';
import {SIGNAL_SOURCE_VERSION} from './research-version.js';

const value=v=>v==null?'—':Number(v).toFixed(2)+'%';
const events={first:'首次发现',confirmed:'首次进入 S/A',latest:'最后一次评级变化'};
export function renderSignalReports(reports) {
  return reports.map(r=>'<details class="research-group"'+(r.event==='first'?' open':'')+'><summary>'+events[r.event]+' · '+r.samples+' 个样本</summary><p class="mobile-meta">已结算 '+r.settled+' · 待结算 '+r.pending+' · '+r.completedDays+'/'+r.tradingDays+' 个完整结算日'+(r.modelVersion?' · '+esc(r.modelVersion):'')+'</p>'+r.tiers.map(t=>'<article class="research-stat"><strong>'+esc(t.tier)+'级 · '+t.samples+' 个样本</strong><div><span>当日均益 <b>'+value(t.avgClose)+'</b></span><span>次日均益 <b>'+value(t.avgNext)+'</b></span><span>次日价格上涨率 <b>'+value(t.nextUpRate)+'</b></span></div><small>'+t.settled+' 个价格结果，属于历史观察</small></article>').join('')+(r.samples?'':'<p class="mobile-note">等待本机新的可信行情观察；历史回看不补造实时信号。</p>')+(r.otherVersions?'<p class="mobile-note">'+r.otherVersions+' 条其他规则版本的观察单独保留。</p>':'')+'</details>').join('');
}
export function renderBacktestReport(report) {
  if(!report)return '<p class="mobile-note">选择交易日范围后回测；每次最多补录24只股票的日K，可继续补齐。</p>';
  return '<p class="mobile-meta">'+esc(report.dates[0])+'—'+esc(report.dates.at(-1))+' · K线 '+report.coverage.withKline+'/'+report.coverage.codes+' 只 · '+esc(new Date(report.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))+'</p><p class="mobile-note">全部策略共用市场日期。缺失K线不当作成交；日K成交情景包含T+1、整手和共享现金。'+(report.coverage.withKline<report.coverage.codes?'价格资料尚未补齐，当前结果不代表完整策略表现。':'')+'</p>'+report.strategies.map(s=>{
    const p=s.portfolio;
    return '<details class="research-group"><summary>'+esc(s.name)+' · '+(p.bought?'组合 '+value(p.returnPct):'暂无成交样本')+'</summary><div class="research-metrics"><div><span>最大回撤</span><b>'+value(p.maxDrawdown)+'</b></div><div><span>已买入 / 已退出</span><b>'+p.bought+' / '+p.closed+'</b></div><div><span>仍持有</span><b>'+p.openPositions.length+'</b></div><div><span>买入 / 退出受阻</span><b>'+p.entryBlocked+' / '+p.exitBlocked+'</b></div></div><p class="mobile-meta">训练 '+s.train.tradingDays+'日 · 验证 '+s.validation.tradingDays+'日 · 样本外 '+s.oos.tradingDays+'日 · 隔离 '+s.split.purged+' 个跨段样本</p><p class="mobile-note">价格表现均益 '+value(s.avgReturn)+' · 已退出单笔均益 '+value(s.executable.avgReturn)+' · 样本外胜率 '+value(s.oos.winRate)+'</p>'+p.openPositions.slice(0,12).map(h=>'<p>'+esc(h.code)+' · '+h.shares+'股 · 浮动 '+value(h.unrealizedRet)+' · 退出受阻 '+h.blockedExitDays+'日'+(h.staleDays?' · 估值存在缺价':'')+'</p>').join('')+'<p class="mobile-note">'+esc(p.assumption)+'</p></details>';
  }).join('');
}
export function createMobileResearchUI({state,doc=document}) {
  const $=id=>doc.getElementById(id);
  let sequence=0,busy=false;
  const status=text=>{$('researchStatus').textContent=text;};
  const setBusy=on=>{busy=on;for(const id of ['signalRead','backtestRun','researchDays','researchCapital','researchEntry'])$(id).disabled=on;$('researchCancel').hidden=!on;};
  async function read(){if(busy)return;try{const research=await readMobileResearch();$('signalResults').innerHTML=renderSignalReports(['first','confirmed','latest'].map(event=>signalReport(research.signals,SIGNAL_SOURCE_VERSION,event)));$('backtestResults').innerHTML=renderBacktestReport(research.backtest);status(state.researchSaveError?'信号保存失败：'+state.researchSaveError:'信号与回测仅保存在当前设备');}catch(e){status('本地资料读取失败：'+e.message);}}
  async function run(kind){
    if(busy)return;const id=++sequence;setBusy(true);status('正在准备…');
    const cancelled=()=>sequence!==id;
    try{
      if(kind==='signals'){$('signalResults').innerHTML=renderSignalReports(await updateSignalReport({cancelled,onProgress:(done,total)=>status('信号价格补录 '+done+'/'+total)}));}
      else{const capital=Number($('researchCapital').value);if(!Number.isFinite(capital)||capital<=0)throw Error('请填写大于0的本金');
        const report=await runMobileBacktest({count:Number($('researchDays').value),initialCapital:capital,entry:$('researchEntry').value,cancelled,onProgress:status});
        if(!cancelled())$('backtestResults').innerHTML=renderBacktestReport(report);
      }
      if(!cancelled())status('已更新，未完成的价格资料保留待补齐');
    }catch(e){if(!cancelled())status('未生成新结果：'+e.message+'；上次结果保留');}
    finally{if(!cancelled())setBusy(false);}
  }
  $('signalRead').addEventListener('click',()=>void run('signals'));
  $('backtestRun').addEventListener('click',()=>void run('backtest'));
  $('researchCancel').addEventListener('click',()=>{sequence++;setBusy(false);status('已停止，已完成的补录保留');});
  return {read};
}
