// sw.js — Classic worker for compatibility with installed PWA registrations.
const CACHE = 'mp-mobile-20261109-3';
importScripts('./mobile-worker.js?v='+CACHE);
const SHELL=['./','./index.html','./styles.css','./app.js','./data.js','./store.js','./analytics.js','./views.js','./views-extra.js','./version.js','./board-alerts.js','./notify.js','./mobile-alerts.js','./mobile-worker.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png','./icons/maskable-512.png'];
self.addEventListener('install',event=>{event.waitUntil((async()=>{const cache=await caches.open(CACHE),failed=[];await Promise.allSettled(SHELL.map(async url=>{try{const response=await fetch(url,{cache:'no-store'});if(!response.ok)throw new Error('资源未就绪');await cache.put(url,response);}catch{if(url==='./'||/\.(html|js|css)$/.test(url))failed.push(url);}}));if(failed.length)throw new Error('核心资源未完整缓存，保留旧版');await self.skipWaiting();})());});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('mp-mobile-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil((async()=>{const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true}),existing=windows.find(client=>'focus' in client);return existing?existing.focus():self.clients.openWindow('./');})());});
const alerts=self.mobileBoardRuntime.createMobileAlerts();
async function bgPresealTick(){
 const preferences=await alerts.settings();if(!preferences.enabled||preferences.source!=='phone')return;
 const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});if(windows.some(client=>client.visibilityState==='visible'))return;
 await alerts.scan({background:true,onNotices:async(notice,prefs)=>{
  if(prefs.url || !prefs.localNotify)return;
  const live=notice.events.filter(event=>event.expiresAt==null||Date.now()<event.expiresAt);if(!live.length)return;const text=self.mobileBoardRuntime.formatMobileNotice(live);
  try{await self.registration.showNotification(text.title,{body:text.lines.join('\n'),tag:'mobile-board-'+live.map(event=>event.code+':'+event.kind+':'+event.t).join('|'),icon:'./icons/icon-192.png',badge:'./icons/icon-192.png',silent:!prefs.sound,...(prefs.sound?{vibrate:prefs.vibrate?[200,100,200]:[]}:{} )});}catch{}
 }});
}
// Browser scheduling is best effort; registering does not guarantee timely wakeups.
self.addEventListener('periodicsync',event=>{if(event.tag==='mp-preseal')event.waitUntil(bgPresealTick().catch(()=>{}));});
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);if(url.origin!==self.location.origin || event.request.method!=='GET')return;
 if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put('./',copy));}return response;}).catch(()=>caches.match('./')));return;}
 const cacheKey=url.searchParams.get('v')===CACHE?new Request(url.origin+url.pathname):event.request;
 event.respondWith(caches.match(cacheKey).then(cached=>cached || fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}return response;}).catch(()=>Response.error())));
});
