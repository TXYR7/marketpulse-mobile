export function riskPresentation(item) {
  const density=item.key==='first';
  const hasScore=item.score!=null && item.score!=='' && Number.isFinite(Number(item.score));
  const tone=!hasScore || item.level==='gray' ? 'unknown' : density
    ? (Number(item.score)<30?'low':Number(item.score)<=70?'medium':'high')
    : ({green:'low',yellow:'low',orange:'medium',red:'high'})[item.level] || 'unknown';
  return {density,tone,label:density?'首板密度':item.label,number:tone==='unknown'?'—':item.score,
    text:tone==='unknown'?'待核':(density?{low:'稀疏',medium:'适中',high:'拥挤'}:{low:'低风险',medium:'中风险',high:'高风险'})[tone]};
}

export function quoteTone(price,change) {
  if(price==null||Number(price)<=0||!Number.isFinite(Number(price))||change==null||change===''||!Number.isFinite(Number(change)))return 'flat-c';
  return Number(change)>0?'up-c':Number(change)<0?'down-c':'flat-c';
}

// Keep section DOM, scroll and Kline data intact while switching the reader.
export function createMobileDetail({sheet,doc=document,onChart=()=>{},onEvidence=()=>{}}) {
  const sections=['overview','chart','evidence'],scroll=new Map(); let current='overview',chartOpened=false,evidenceOpened=false;
  const scrollElement=()=>doc.getElementById('sheet-'+current)||sheet;
  function select(name,{focus=false,reset=false}={}) {
    if(!sections.includes(name))return;
    if(!reset)scroll.set(current,scrollElement().scrollTop||0);
    current=name;
    for(const section of sections){
      const panel=doc.getElementById('sheet-'+section),button=sheet.querySelector('[data-sheet-section="'+section+'"]');
      if(panel)panel.hidden=section!==name;
      if(button){button.classList.toggle('active',section===name);button.setAttribute('aria-selected',String(section===name));button.tabIndex=section===name?0:-1;}
    }
    if(name==='chart'&&!chartOpened){chartOpened=true;onChart();}
    if(name==='evidence'&&!evidenceOpened){evidenceOpened=true;onEvidence();}
    scrollElement().scrollTop=reset?0:scroll.get(name)||0;
    if(focus)sheet.querySelector('[data-sheet-section="'+name+'"]')?.focus({preventScroll:true});
  }
  sheet.addEventListener('click',event=>{
    const tab=event.target.closest?.('[data-sheet-section]');if(tab){select(tab.dataset.sheetSection);return;}
    const edge=event.target.closest?.('[data-sheet-edge]');if(edge){const host=scrollElement();host.scrollTop=edge.dataset.sheetEdge==='top'?0:host.scrollHeight-host.clientHeight;}
  });
  sheet.addEventListener('keydown',event=>{
    if(!event.target.closest?.('[data-sheet-section]')||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const index=sections.indexOf(current);
    select(event.key==='Home'?sections[0]:event.key==='End'?sections.at(-1):sections[(index+(event.key==='ArrowRight'?1:2))%3],{focus:true});
  });
  return {reset:()=>{scroll.clear();chartOpened=false;evidenceOpened=false;select('overview',{reset:true});},select,current:()=>current,scrollElement};
}
