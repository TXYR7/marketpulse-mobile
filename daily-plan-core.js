export const DAILY_PLANS_KEY = 'daily-plans-v1';
export const PLAN_STATES = Object.freeze({ watching:'观察中', planned:'已有计划', skipped:'已放弃' });
export const finiteNumber = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export function planDate(value) {
  const date=String(value || '').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return null;
  const parsed=new Date(date+'T12:00:00Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===date?date:null;
}
export function planKey(date,code) {
  date=planDate(date);code=String(code || '');
  if(!date || !/^\d{6}$/.test(code))throw Error('计划日期或股票代码无效');
  return date+':'+code;
}
export function normalizePlans(value) {
  return Array.isArray(value)?value.filter(p=>p && planDate(p.date) && /^\d{6}$/.test(String(p.code)) && p.id===p.date+':'+p.code && Object.hasOwn(PLAN_STATES,p.status)):[];
}
export function updatePlan(current,draft,now=new Date().toISOString()) {
  const date=planDate(draft.date),id=planKey(date,draft.code);
  if(!Object.hasOwn(PLAN_STATES,draft.status))throw Error('计划状态无效');
  for(const key of ['entry','stop','budget'])if(draft[key]!=null&&draft[key]!==''&&(finiteNumber(draft[key])===null||Number(draft[key])<=0))throw Error('价格与预算需大于0');
  if(finiteNumber(draft.entry)!==null && finiteNumber(draft.stop)!==null && Number(draft.stop)>=Number(draft.entry))throw Error('失效参考价需低于计划买入价');
  if(draft.status==='planned'&&(!String(draft.condition || '').trim()||['entry','stop','budget'].some(k=>finiteNumber(draft[k])===null)))throw Error('已有计划需完整的参与条件、价格与预算');
  if(draft.status==='skipped'&&!String(draft.note || '').trim())throw Error('请记录放弃原因');
  const plans=normalizePlans(current),prior=plans.find(p=>p.id===id);
  const next={...prior,...draft,id,date,code:String(draft.code),name:String(draft.name || draft.code).slice(0,80),condition:String(draft.condition || '').slice(0,2000),note:String(draft.note || '').slice(0,2000),entry:finiteNumber(draft.entry),stop:finiteNumber(draft.stop),budget:finiteNumber(draft.budget),createdAt:prior?.createdAt || now,updatedAt:now};
  return [...plans.filter(p=>p.id!==id),next];
}
export function riskEstimate(draft,capital) {
  const entry=finiteNumber(draft.entry),stop=finiteNumber(draft.stop),budget=finiteNumber(draft.budget);
  if(!(entry>0&&stop>0&&stop<entry&&budget>0))return null;
  const amount=budget*(entry-stop)/entry;
  return {amount,capitalPct:Number(capital)>0?amount/Number(capital)*100:null};
}
export function mobileDecision(stock,state) {
  if(!stock || stock.outsidePool)return {label:'快照外',tone:'waiting',reason:'当前涨停快照未包含该股，原确认需要重验',next:'核对最新行情与原计划'};
  if(!state.pools || state.fromSnapshot || state.pools.partial || state.lastErrorAt>state.lastSuccessAt)return {label:'行情待核',tone:'waiting',reason:'行情延迟、来源缺失或更新失败',next:'核实行情后重新确认'};
  const p=stock.promo,signal=p?.signal || stock.signal || {};
  if(state.opportunities?.noTrade?.triggered)return {label:'暂停参与',tone:'waiting',reason:state.opportunities.noTrade.reason || '当前参与条件受限',next:'限制解除后重新确认'};
  if(p?.hardFails?.length || ['规避','回避','不可接力'].includes(p?.verdict))return {label:'规避',tone:'avoid',reason:p?.hardFails?.[0] || '当前条件不适合参与',next:'核对失效条件，暂不新增参与'};
  if(!p)return {label:'仅行情',tone:'waiting',reason:'该股没有打板判决',next:'查看日K并明确自己的观察条件'};
  const ready=signal.state==='可打' && ['可接力','优先确认'].includes(p.verdict);
  return {label:ready?'条件已触发':signal.state==='待触发'?'等触发':'待确认',tone:ready?'ready':'waiting',priority:['可接力','优先确认'].includes(p.verdict),reason:p.downgrades?.[0] || p.profile?.identity || p.checklist?.find(r=>r.status!=='pass')?.note || '核对价格与承接',next:p.actionPlan?.entry || signal.next || '等待价格与承接确认'};
}
export function tradeFromForm(form,plan,prior=null) {
  const date=planDate(form.date),code=String(form.code || '').trim();
  if(!date || !/^\d{6}$/.test(code))throw Error('请填写有效日期和六位股票代码');
  const buy=finiteNumber(form.buyPrice),sell=finiteNumber(form.sellPrice),quantity=finiteNumber(form.quantity),manualPnl=finiteNumber(form.pnlPct);
  if(!(buy>0))throw Error('请核对实际买入价');
  if(quantity!==null&&(!Number.isInteger(quantity)||quantity<=0))throw Error('股数需为正整数');
  if(form.status==='open'&&!(quantity>0))throw Error('持仓记录需要实际股数');
  if(form.status==='closed'&&!(sell>0)&&manualPnl===null)throw Error('平仓记录需卖出价或盈亏比例');
  if(!['open','closed'].includes(form.status))throw Error('交易状态无效');
  if(form.sellPrice!==''&&form.sellPrice!=null&&!(sell>0))throw Error('卖出价需大于0');
  if(form.pnlPct!==''&&form.pnlPct!=null&&manualPnl===null)throw Error('盈亏比例无效');
  const linked=plan&&plan.code===code&&plan.date===date?plan:prior?.dailyPlanSnapshot&&prior.code===code&&prior.date===date?prior.dailyPlanSnapshot:null;
  return { ...prior,id:prior?.id || 'manual-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8),date,code,name:String(form.name || code).slice(0,80),status:form.status,buyPrice:buy,entryPrice:buy,sellPrice:form.status==='closed'?sell:null,quantity,pnlPct:form.status==='closed'?(manualPnl ?? (sell/buy-1)*100):null,buyReason:String(form.reason || '').slice(0,2000),source:'manual',dailyPlanId:linked?.id || null,dailyPlanSnapshot:linked?{...linked}:null,updatedAt:new Date().toISOString() };
}
