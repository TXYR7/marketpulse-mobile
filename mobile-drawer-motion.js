// One compositor transform per drawer. No height measurements or per-frame JS spring work.
export function createMobileDrawerMotion({doc=document,win=window}={}) {
  const active=new Map(),reduced=win.matchMedia?.('(prefers-reduced-motion: reduce)');
  function cancel(sheet) {
    const record=active.get(sheet);if(!record)return;
    active.delete(sheet);record.animation.cancel();sheet.classList.remove('mobile-drawer-layer');
  }
  function pause(sheet) {
    const transform=win.getComputedStyle(sheet).transform;
    cancel(sheet);sheet.style.transform=transform==='none'?'':transform;
    const values=transform.match(/matrix(?:3d)?\(([^)]+)\)/)?.[1].split(',').map(Number);
    return values ? values[values.length===16?13:5]||0 : 0;
  }
  function animate(sheet,{opening=true}={}) {
    if(!sheet)return Promise.resolve();
    const interrupted=active.has(sheet)||Boolean(sheet.style.transform);
    const from=interrupted?win.getComputedStyle(sheet).transform:opening?'translate3d(0,100%,0)':'translate3d(0,0,0)';
    cancel(sheet);sheet.style.transform='';
    if(doc.hidden||reduced?.matches||typeof sheet.animate!=='function')return Promise.resolve();
    sheet.classList.add('mobile-drawer-layer');
    const animation=sheet.animate([{transform:from==='none'?'translate3d(0,0,0)':from},{transform:opening?'translate3d(0,0,0)':'translate3d(0,100%,0)'}],
      {duration:opening?240:200,easing:opening?'cubic-bezier(.22,.72,.12,1)':'cubic-bezier(.4,0,.7,.2)',fill:'both'});
    const record={animation};active.set(sheet,record);
    return animation.finished.catch(()=>{}).then(()=>{if(active.get(sheet)===record)cancel(sheet);});
  }
  function quiet(){if(doc.hidden||reduced?.matches)for(const sheet of [...active.keys()])cancel(sheet);}
  reduced?.addEventListener?.('change',quiet);doc.addEventListener?.('visibilitychange',quiet);
  return {animate,pause,cancel,busy:sheet=>active.has(sheet)};
}
