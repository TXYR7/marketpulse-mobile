// sw.js — 缓存 app 外壳（离线可启动）；行情接口直连不缓存
// 版本号由 scripts/bump-sw.mjs 自动递增（发布到手机.cmd 会调用），无需手动改。
const CACHE = 'mp-mobile-20261012-4';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './data.js', './store.js',
  './analytics.js', './views.js', './views-extra.js', './version.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
];

// B7:逐文件 put+单文件 catch——弱网下 addAll 任一文件失败会让整个 install 失败、新版本装不上；
// 部分失败的资产由 fetch 事件的运行时缓存兜底补齐(sw.js fetch handler 有网络回填)。
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map(async (url) => {
      try { const r = await fetch(url, { cache: 'no-store' }); if (r && r.ok) await c.put(url, r); } catch { /* 单文件失败不拖垮安装 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// 抢时间批·封板前预警(2026-10-10):点通知聚焦/打开 App。通知由页面 reg.showNotification 发出
// (App 前台场景);后台推送由桌面 ntfy 承担,SW 不做周期轮询(范围界定,避免 SW 复杂化)。
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const exist = all.find((c) => 'focus' in c);
    if (exist) return exist.focus();
    return self.clients.openWindow('./');
  })());
});

/* ---------------- C2 锁屏准点:periodicSync 后台封板前预警 ---------------- */
// 锁屏/关屏时 periodicSync 唤醒 SW → 后台自拉全市场快照 → 跑 detectPreSealAlerts(analytics.js 纯函数)→ 命中发 ntfy + SW 通知。
// 状态(preSnap/冷却)存 IndexedDB 跨 tick 保持;配置 pushNtfyUrl(与页面 C3 同一 KV)。
// 前提:本机 Chrome 已给 periodicSync 权限(已探测「能锁屏准时」),否则 periodicSync.register 无效、不会触发。
const PRESEAL_DB = 'mp-preseal-bg';
function presealIDB() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open(PRESEAL_DB, 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function kvGet(store, k) {
  const db = await presealIDB();
  return new Promise((res, rej) => {
    const rq = db.transaction(store, 'readonly').objectStore(store).get(k);
    rq.onsuccess = () => res(rq.result ?? null);
    rq.onerror = () => rej(rq.error);
  });
}
async function kvSet(store, k, v) {
  const db = await presealIDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(v, k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
// 交易时段(周末/节假日后台不跑,省电):周一~五 + 9:15-11:35 / 12:55-15:00(本地时区近似)
function bgTradingNow(d = new Date()) {
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  return (m >= 555 && m <= 695) || (m >= 775 && m <= 900);
}
// 后台主流程:CORS 全开的东财接口 → 全市场快照 → 检测
async function bgPresealTick() {
  if (!bgTradingNow()) return;
  const url = await kvGet('kv', 'pushNtfyUrl').catch(() => null);
  if (!url) return; // 未配置 ntfy 不后台跑
  const { detectPreSealAlerts } = await import('./analytics.js'); // 纯函数,SW 内可跑
  // 全市场快照(东财 clist,分页拉前两页≈涨停池足够)
  const all = [];
  for (let page = 1; page <= 2; page += 1) {
    const u = `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f2,f3,f12,f14`;
    const j = await fetch(u).then((r) => r.json()).catch(() => null);
    const rows = j?.data?.diff || [];
    for (const r of rows) all.push({ code: String(r.f12 ?? ''), name: r.f14 ?? '', changePercent: Number.isFinite(Number(r.f3)) ? Number(r.f3) : NaN });
  }
  if (!all.length) return;
  const now = Date.now();
  let prevSnap = (await kvGet('kv', 'prevSnap').catch(() => null)) || {};
  prevSnap = new Map(Object.entries(prevSnap).map(([k, v]) => [k, v]));
  const cooldown = (await kvGet('kv', 'cool').catch(() => null)) || {};
  const inCooldown = (key) => { const t = cooldown[key]; return Boolean(t && now - t < 30 * 60_000); };
  // 监控名单:优先机会股∪龙头(页面算好的);没有则全市场高涨幅(涨幅≥7%未封)
  let watchCodes = (await kvGet('kv', 'watch').catch(() => null)) || [];
  if (!watchCodes.length) watchCodes = all.filter((s) => s.changePercent >= 7).map((s) => s.code);
  const events = detectPreSealAlerts({ stocks: all, watchCodes, prevSnap, now, inCooldown });
  // 存状态(prevSnap=本轮快照,冷却标记命中项)
  await kvSet('kv', 'prevSnap', Object.fromEntries(all.filter((s) => Number.isFinite(s.changePercent)).map((s) => [s.code, { pct: s.changePercent, t: now }])));
  for (const ev of events) cooldown[`${ev.code}:${ev.kind}`] = now;
  await kvSet('kv', 'cool', cooldown);
  // 命中:发 ntfy(通道与 C3 一致)+ SW 通知
  for (const ev of events) {
    const label = ev.name && ev.name !== ev.code ? ev.name : ev.code;
    const text = ev.kind === 'sealApproach' ? `${label} 逼近涨停 ${ev.pct}%（未封）` : `${label} 30秒急拉 +${ev.rise ?? '--'}%（现 ${ev.pct}%）`;
    const title = ev.kind === 'sealApproach' ? '封板前预警' : '急拉预警';
    const root = new URL(url).origin + '/';
    await fetch(root, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: url.split('/').filter(Boolean).pop(), title: `MarketPulse · ${label} ${title}`, message: text, priority: 4, tags: ['warning', 'bell'] }) }).catch(() => {});
    try { await self.registration.showNotification(title, { body: text, tag: `bg-preseal-${ev.code}`, icon: './icons/icon-192.png', badge: './icons/icon-512.png' }); } catch {}
  }
}
// periodicSync 周期任务:交易时段约每 10 分钟唤醒一次
self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'mp-preseal') e.waitUntil(bgPresealTick().catch(() => {}));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.hostname.includes('eastmoney.com')) return; // 数据接口直连，不缓存
  if (e.request.method !== 'GET') return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).then((r) => {
        if (r && r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put('./', cp)); } // 错误页不污染缓存
        return r;
      })
        .catch(() => caches.match('./'))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request).then((resp) => {
      if (resp && resp.ok) { const cp = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); }
      return resp;
    }).catch(() => {
      // 离线子资源缺失：只有页面导航才回退到外壳 HTML，其余返回真错误（避免拿 HTML 当 JS/CSS 用）
      if (e.request.destination === 'document') return caches.match('./');
      return Response.error();
    }))
  );
});
