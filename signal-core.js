// Local signal observations preserve classification and price from the same moment.
const number=v=>v==null||v===''||!Number.isFinite(Number(v))?null:Number(v);
const round=v=>Math.round(v*100)/100;
export function mergeSignalObservation(previous, observation) {
  if(!previous)return {...observation,lastSeenAsOf:observation.snapshot.asOf,first:{...observation.snapshot},latest:{...observation.snapshot},
    confirmed:['S','A'].includes(observation.snapshot.tier)?{...observation.snapshot}:null,result:null};
  if(Date.parse(observation.snapshot.asOf)<=Date.parse(previous.lastSeenAsOf||previous.latest.asOf))return previous;
  const a=previous.latest,b=observation.snapshot;
  if(['tier','score','mode','phase'].every(key=>a[key]===b[key]))return {...previous,lastSeenAsOf:b.asOf};
  return {...previous,lastSeenAsOf:b.asOf,latest:{...b},confirmed:previous.confirmed || (['S','A'].includes(b.tier)?{...b}:null)};
}
export function signalObservations(state,sourceVersion,now=Date.now()) {
  const date=String(state.pools?.date||'').replaceAll('-','');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(now)).replaceAll('-','');
  const at=state.lastSuccessAt;
  if(date!==today || state.manualDate || state.fromSnapshot || !state.unifiedDecision?.trusted || !at || state.lastErrorAt>at)return [];
  const modelVersion=state.unifiedDecision.modelVersion;
  if(!modelVersion)return [];
  return ['S','A','B'].flatMap(tier=>(state.opportunities?.tiers?.[tier]||[]).filter(s=>number(s.price)>0).map(s=>{
    const price=number(s.price),change=number(s.changePercent);
    return {id:date+':'+sourceVersion+':'+s.code,date,code:s.code,name:s.name||s.code,modelVersion,sourceVersion,
      snapshot:{tier,score:number(s.score),mode:s.buyType||null,phase:state.phase||null,price,
        preClose:change!==null&&change>-100?price/(1+change/100):null,asOf:new Date(at).toISOString(),capturedAt:new Date(now).toISOString()}};
  }));
}
export function signalReport(rows,sourceVersion,event='first') {
  const selected=rows.filter(r=>r.sourceVersion===sourceVersion&&r[event]);
  const groups=new Map(),days=new Map();
  for(const row of selected){
    const observation=row[event],key=observation.tier;
    const group=groups.get(key)||{tier:key,samples:0,settled:0,close:[],next:[]};
    const day=days.get(row.date)||{samples:0,settled:0};group.samples++;day.samples++;
    if(row.result&&number(observation.price)>0){
      const close=(row.result.close/observation.price-1)*100,next=(row.result.nextClose/observation.price-1)*100;
      if(Number.isFinite(close)&&Number.isFinite(next)){group.settled++;day.settled++;group.close.push(close);group.next.push(next);}
    }
    groups.set(key,group);days.set(row.date,day);
  }
  const avg=values=>values.length?round(values.reduce((s,v)=>s+v,0)/values.length):null;
  const settled=[...groups.values()].reduce((s,g)=>s+g.settled,0);
  return {event,sourceVersion,modelVersion:selected[0]?.modelVersion,samples:selected.length,settled,pending:selected.length-settled,
    tradingDays:days.size,completedDays:[...days.values()].filter(d=>d.samples===d.settled).length,
    otherVersions:rows.length-rows.filter(r=>r.sourceVersion===sourceVersion).length,
    tiers:[...groups.values()].map(g=>({tier:g.tier,samples:g.samples,settled:g.settled,avgClose:avg(g.close),avgNext:avg(g.next),
      nextUpRate:g.next.length?round(g.next.filter(v=>v>0).length/g.next.length*100):null}))};
}
