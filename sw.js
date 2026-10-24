// sw.js — 缓存 app 外壳（离线可启动）；行情接口直连不缓存
// 版本号由 scripts/bump-sw.mjs 自动递增（发布到手机.cmd 会调用），无需手动改。
const CACHE = 'mp-mobile-20261024';
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
// (App 前台场景);后台推送由桌面 ntfy 承担,SW 只在 periodicSync 被唤醒时兜底。
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
// 锁屏/关屏时 periodicSync 唤醒 SW → 读页面写好的「上一交易日涨停池」名单 → 拉实时报价 →
// 跑 detectPreSealAlerts(analytics.js 纯函数) → 命中发 ntfy + SW 通知。
//
// ⚠ 2026-10-24 修:旧版把名单/配置读自 mp-preseal-bg,而页面 getKV/setKV 写的是 mp-mobile
//   (store.js)——两个库永不互通,后台任务第一行 pushNtfyUrl 就取到 null 直接 return,
//   periodicSync 从上线起就没真正发过一条推送。现在名单/账本/配置统一读写 mp-mobile。
// ⚠ Chrome 对 periodicSync 的调度是「尽力而为」:频率由浏览器按站点参与度决定,不保证 10 分钟,
//   且 App 被系统杀掉/省电限制时不触发。关闭 App 后的可靠推送仍以桌面 server.js 的独立监控为准。
const PAGE_DB = 'mp-mobile';

function openPageDB() {
  // 不指定版本:跟随页面当前版本,避免 SW 把页面库升/降级。库不存在时创建空 v1,页面下次 open(v3) 会正常升级建表。
  return new Promise((res, rej) => {
    const rq = indexedDB.open(PAGE_DB);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function pageKvGet(k) {
  let db = null;
  try {
    db = await openPageDB();
    if (!db.objectStoreNames.contains('kv')) return null;
    return await new Promise((res, rej) => {
      const rq = db.transaction('kv', 'readonly').objectStore('kv').get(k);
      rq.onsuccess = () => res(rq.result ?? null);
      rq.onerror = () => rej(rq.error);
    });
  } finally { try { db?.close(); } catch { /* ignore */ } }
}
async function pageKvSet(k, v) {
  let db = null;
  try {
    db = await openPageDB();
    if (!db.objectStoreNames.contains('kv')) return;
    await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } finally { try { db?.close(); } catch { /* ignore */ } }
}

// 上海时区交易时段(9:30-11:30 / 13:00-15:00)：不依赖设备时区
function bgSessionNow(d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    const wd = parts.find((p) => p.type === 'weekday')?.value || '';
    if (wd === 'Sat' || wd === 'Sun') return false;
    const m = Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
    return (m >= 570 && m <= 690) || (m >= 780 && m <= 900);
  } catch { return false; }
}

function prevTradingDateKey(today, isTradingDay) {
  const y = Number(String(today).slice(0, 4)); const mo = Number(String(today).slice(4, 6)); const d = Number(String(today).slice(6, 8));
  const base = new Date(y, mo - 1, d);
  for (let i = 1; i <= 15; i += 1) {
    const x = new Date(base.getTime() - i * 86_400_000);
    const k = `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, '0')}${String(x.getDate()).padStart(2, '0')}`;
    if (isTradingDay(k)) return k;
  }
  return '';
}
// 监控名单:优先页面今天写好的 preSealWatch;页面整天没开过则 SW 自拉上一交易日涨停池
async function bgWatchStocks(today) {
  const cached = await pageKvGet('preSealWatch').catch(() => null);
  if (cached && cached.forDate === today && Array.isArray(cached.stocks) && cached.stocks.length) return cached.stocks;
  const { isTradingDay } = await import('./data.js');
  const { limitThresholdOf } = await import('./analytics.js');
  const prev = prevTradingDateKey(today, isTradingDay);
  if (!prev) return [];
  const url = `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=fbt:asc&date=${prev}`;
  const j = await fetch(url).then((r) => r.json()).catch(() => null);
  const stocks = (j?.data?.pool || []).map((row) => {
    const code = String(row.c || ''); const name = String(row.n || code);
    return { code, name, boards: Number(row.lbc || 1), limitPct: limitThresholdOf(code, name) };
  }).filter((s) => /^\d{6}$/.test(s.code));
  if (stocks.length) pageKvSet('preSealWatch', { forDate: today, stocks }).catch(() => {});
  return stocks;
}

const ULIST_CHUNK = 60;
function secidOf(code) { const c = String(code); return ((c[0] === '6' || c[0] === '5') ? '1.' : '0.') + c; }
async function bgFetchQuotes(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i += ULIST_CHUNK) {
    const secids = codes.slice(i, i + ULIST_CHUNK).map(secidOf).join(',');
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f12,f14,f2,f18&_=${Date.now()}`;
    let j = await fetch(url).then((r) => r.json()).catch(() => null);
    if (!j?.data?.diff) j = await fetch(url.replace('push2.eastmoney.com', 'push2delay.eastmoney.com')).then((r) => r.json()).catch(() => null);
    for (const row of j?.data?.diff || []) {
      const price = Number(row.f2); const prevClose = Number(row.f18);
      if (Number.isFinite(price) && price > 0 && Number.isFinite(prevClose) && prevClose > 0) out[String(row.f12)] = { price, prevClose };
    }
  }
  return out;
}

async function bgPresealTick() {
  if (!bgSessionNow()) return;
  const { todayStr, isTradingDay } = await import('./data.js');
  const today = todayStr();
  if (!isTradingDay(today)) return;
  const ntfyUrl = await pageKvGet('pushNtfyUrl').catch(() => null);
  if (!ntfyUrl || !/^https?:\/\//i.test(ntfyUrl)) return; // 未配置 ntfy 不后台跑(SW 通知也一并不发,避免两套口径)
  const watch = await bgWatchStocks(today).catch(() => []);
  if (!watch.length) return;
  const quotes = await bgFetchQuotes(watch.map((s) => s.code)).catch(() => ({}));
  const now = Date.now();
  const stocks = [];
  for (const s of watch) {
    const q = quotes[s.code];
    if (!q) continue;
    const changePercent = (q.price / q.prevClose - 1) * 100;
    if (!Number.isFinite(changePercent)) continue;
    stocks.push({ code: s.code, name: s.name, boards: s.boards, limitPct: s.limitPct, changePercent });
  }
  if (!stocks.length) return;
  const { detectPreSealAlerts } = await import('./analytics.js');
  // 上轮涨幅快照:落页面同一个库,跨 tick 保持;隔日作废(防止隔夜旧涨幅被当急拉基准)
  const prevRec = await pageKvGet('preSealPrevSnap').catch(() => null);
  const prevSnap = new Map(prevRec && prevRec.date === today && prevRec.snap ? Object.entries(prevRec.snap) : []);
  // 当日已推账本:与页面共用,先查账再更新,保证刷新/前后台/页面与 SW 之间不重复
  const seenRec = await pageKvGet('preSealSeen').catch(() => null);
  const seen = new Set(seenRec && seenRec.date === today && Array.isArray(seenRec.keys) ? seenRec.keys : []);
  const events = detectPreSealAlerts({ stocks, watchCodes: stocks.map((s) => s.code), prevSnap, now, inCooldown: (key) => seen.has(key) });
  const accepted = [];
  for (const ev of events) {
    if (seen.size >= 30) break; // 单日上限,防异常数据刷屏
    const key = `${ev.code}:${ev.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(ev);
  }
  await pageKvSet('preSealPrevSnap', { date: today, snap: Object.fromEntries(stocks.map((s) => [s.code, { pct: s.changePercent, t: now }])) }).catch(() => {});
  if (accepted.length) {
    // 写入前与页面账本做并集:页面 15s 扫描可能刚写过,直接覆盖会抹掉它的记录→重复推送
    const latest = await pageKvGet('preSealSeen').catch(() => null);
    const merged = new Set(seen);
    if (latest && latest.date === today && Array.isArray(latest.keys)) for (const k of latest.keys) merged.add(k);
    await pageKvSet('preSealSeen', { date: today, keys: [...merged] }).catch(() => {});
  }
  const root = new URL(ntfyUrl).origin + '/';
  const topic = ntfyUrl.split('/').filter(Boolean).pop();
  for (const ev of accepted) {
    const label = ev.name && ev.name !== ev.code ? ev.name : ev.code;
    const text = ev.kind === 'sealApproach'
      ? `${label} 逼近涨停 ${ev.pct}%（距涨停 ${(Number(ev.limitPct) - Number(ev.pct)).toFixed(2)}pp，未封）`
      : `${label} 30秒急拉 +${ev.rise ?? '--'}%（现 ${ev.pct}%）`;
    const title = ev.kind === 'sealApproach' ? '封板前预警' : '急拉预警';
    await fetch(root, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic, title: `MarketPulse · ${label} ${title}`, message: text, priority: 4, tags: ['warning', 'bell'] }) }).catch(() => {});
    try { await self.registration.showNotification(title, { body: text, tag: `bg-preseal-${ev.code}`, icon: './icons/icon-192.png', badge: './icons/icon-512.png' }); } catch { /* 无通知权限时静默 */ }
  }
}

// periodicSync 周期任务:交易时段约每 10 分钟唤醒一次(实际由 Chrome 调度)
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
