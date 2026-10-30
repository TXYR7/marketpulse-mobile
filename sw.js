// sw.js — 缓存 app 外壳（离线可启动）；行情接口直连不缓存
// 版本号由 scripts/bump-sw.mjs 自动递增（发布到手机.cmd 会调用），无需手动改。
const CACHE = 'mp-mobile-20261026-3';
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
// 锁屏/关屏时 periodicSync 唤醒 SW → 读页面写好的核心名单(昨日涨停∪今日炸板∪竞价候选) →
// 竞价段取涨幅榜撮合价、盘中拉实时报价 → 跑 detectPreSealAlerts/回封判定 → 命中发 ntfy + SW 通知。
// 全市场摘要层只在页面前台跑(SW 唤醒频率不可控,拉全市场榜单不划算)。
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

// 上海时区交易时段：9:26-9:29 竞价预扫(撮合价已定稿) + 9:30-11:30 / 13:00-15:00 盘中；不依赖设备时区
function bgSessionInfo(d = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    const wd = parts.find((p) => p.type === 'weekday')?.value || '';
    if (wd === 'Sat' || wd === 'Sun') return { tradable: false, auction: false };
    const m = Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
    const auction = m >= 566 && m < 570;
    const tradable = auction || (m >= 570 && m <= 690) || (m >= 780 && m <= 900);
    return { tradable, auction };
  } catch { return { tradable: false, auction: false }; }
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
// 监控名单:优先页面今天写好的 preSealWatch(核心名单:昨日涨停/今日炸板/竞价候选);
// 页面整天没开过则 SW 自拉上一交易日涨停池,并按同样规则过滤主板A股/ST/新股。
async function bgWatchStocks(today) {
  const cached = await pageKvGet('preSealWatch').catch(() => null);
  if (cached && cached.forDate === today && Array.isArray(cached.stocks) && cached.stocks.length) return cached.stocks;
  const { isTradingDay } = await import('./data.js');
  const { limitThresholdOf, isMainBoardShare, isExcludedPreSealName } = await import('./analytics.js');
  const prev = prevTradingDateKey(today, isTradingDay);
  if (!prev) return [];
  const url = `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=fbt:asc&date=${prev}`;
  const j = await fetch(url).then((r) => r.json()).catch(() => null);
  const stocks = (j?.data?.pool || []).map((row) => {
    const code = String(row.c || ''); const name = String(row.n || code);
    return { code, name, boards: Number(row.lbc || 1), boardLimitPct: limitThresholdOf(code, name) };
  }).filter((s) => isMainBoardShare(s.code) && !isExcludedPreSealName(s.name));
  if (stocks.length) pageKvSet('preSealWatch', { forDate: today, stocks }).catch(() => {});
  return stocks;
}

const ULIST_CHUNK = 60;
function secidOf(code) { const c = String(code); return ((c[0] === '6' || c[0] === '5') ? '1.' : '0.') + c; }
async function bgFetchQuotes(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i += ULIST_CHUNK) {
    const secids = codes.slice(i, i + ULIST_CHUNK).map(secidOf).join(',');
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f12,f14,f2,f18,f124&_=${Date.now()}`;
    let j = await fetch(url).then((r) => r.json()).catch(() => null);
    if (!j?.data?.diff) j = await fetch(url.replace('push2.eastmoney.com', 'push2delay.eastmoney.com')).then((r) => r.json()).catch(() => null);
    for (const row of j?.data?.diff || []) {
      const price = Number(row.f2); const prevClose = Number(row.f18);
      if (Number.isFinite(price) && price > 0 && Number.isFinite(prevClose) && prevClose > 0) out[String(row.f12)] = { price, prevClose, update: Number(row.f124) || 0 };
    }
  }
  return out;
}

async function bgPresealTick() {
  const session = bgSessionInfo();
  if (!session.tradable) return;
  const { todayStr, isTradingDay } = await import('./data.js');
  const today = todayStr();
  if (!isTradingDay(today)) return;
  const ntfyUrl = await pageKvGet('pushNtfyUrl').catch(() => null);
  if (!ntfyUrl || !/^https?:\/\//i.test(ntfyUrl)) return; // 未配置 ntfy 不后台跑(SW 通知也一并不发,避免两套口径)
  const watch = await bgWatchStocks(today).catch(() => []);
  if (!watch.length) return;
  const now = Date.now();
  const { detectPreSealAlerts, limitPriceOf, PARAM_MANIFEST } = await import('./analytics.js');
  const p = PARAM_MANIFEST.preSealAlert;
  // 竞价段用涨幅榜的竞价撮合价(ulist 此时可能还是昨收)；盘中用 ulist 实时报价
  let quoteRows = [];
  if (session.auction) {
    const { fetchTopGainers } = await import('./data.js');
    // 东财 clist 每页最多 100 只,由 data.js:fetchTopGainers 翻 3 页凑前 300,
    // 不足一页才走新浪兜底(与页面/桌面同源),不再每轮白打一遍兜底。
    const rows = await fetchTopGainers(300).catch(() => []);
    quoteRows = rows.filter((row) => {
      const ts = Number(row.update);
      if (Number.isFinite(ts) && ts > 0) {
        const age = now - ts * 1000;
        if (age < -60_000 || age > 5 * 60_000) return false;
        const c = new Date(ts * 1000 + 8 * 3600_000);
        const m = c.getUTCHours() * 60 + c.getUTCMinutes();
        return m >= 555 && m <= 590;
      }
      const t = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(row.ticktime || ''));
      if (!t) return false;
      const rowMin = Number(t[1]) * 60 + Number(t[2]);
      return rowMin >= 555 && rowMin <= 590;
    }).map((row) => ({ code: row.code, price: row.price, prevClose: row.prevClose, changePercent: row.changePct, update: Number(row.update) || 0 }));
  } else {
    const quotes = await bgFetchQuotes(watch.map((s) => s.code)).catch(() => ({}));
    quoteRows = Object.entries(quotes).map(([code, q]) => ({ code, price: q.price, prevClose: q.prevClose, changePercent: (q.price / q.prevClose - 1) * 100, update: q.update || 0 }));
  }
  const byCode = new Map(quoteRows.map((row) => [row.code, row]));
  const stocks = [];
  for (const s of watch) {
    const q = byCode.get(s.code);
    if (!q || !Number.isFinite(q.changePercent)) continue;
    // 半日市/停牌/数据源卡死时旧价会一直停在涨停附近,不拦会在午后重复触发
    if (q.update && Math.abs(now - q.update * 1000) > 5 * 60_000) continue;
    const limit = limitPriceOf(q.prevClose, s.code, s.name);
    stocks.push({
      code: s.code, name: s.name, boards: s.boards,
      limitPct: limit ? limit.effectiveLimitPct : s.boardLimitPct,
      boardLimitPct: limit ? limit.boardLimitPct : s.boardLimitPct,
      changePercent: q.changePercent, price: q.price, preClose: q.prevClose,
      sources: Array.isArray(s.sources) ? s.sources : [], // 页面写的核心名单来源:首次进监控就知道「今日炸板」
    });
  }
  if (!stocks.length) return;
  // 重复提醒账本(与页面同一份):code:kind -> {count,lastAt,lastPct,resetReady}
  // 规则:不设次数上限;必须先从上次提醒涨幅回落 ≥3pp,且距上次 ≥20 分钟,才允许再次提醒。
  const repeatRec = await pageKvGet('preSealRepeat').catch(() => null);
  const repeat = new Map(repeatRec && repeatRec.date === today && repeatRec.byKey ? Object.entries(repeatRec.byKey) : []);
  for (const [key, st] of repeat) {
    const code = key.slice(0, key.indexOf(':'));
    const s = stocks.find((x) => x.code === code);
    if (!s) continue;
    const base = st.lastPct != null ? st.lastPct : s.limitPct;
    if (s.changePercent <= base - (Number(p.repeatResetOffsetPct) || 3)) st.resetReady = true;
  }
  const canAlert = (key) => {
    const st = repeat.get(key);
    if (!st) return true;
    const minInterval = Number(p.repeatMinIntervalMs) || 20 * 60_000;
    return Boolean(st.resetReady) && now - st.lastAt >= minInterval;
  };
  const markAlerted = (key, ev) => {
    const st = repeat.get(key) || { count: 0, lastAt: 0, lastPct: null, resetReady: false };
    st.count += 1; st.lastAt = now;
    st.lastPct = Number.isFinite(Number(ev.pct)) ? Number(ev.pct) : null;
    st.resetReady = false;
    repeat.set(key, st);
  };
  // 回封状态(与页面同口径):封→跌破 1pp 记炸板,重新逼近到距涨停 0.5pp 内推(受重复提醒约束)
  const resealRec = await pageKvGet('preSealReseal').catch(() => null);
  const resealMap = new Map(resealRec && resealRec.date === today && resealRec.byCode ? Object.entries(resealRec.byCode) : []);
  const resealEvents = [];
  for (const s of stocks) {
    const st = resealMap.get(s.code) || {};
    // 今日炸板池里的票,首次进入监控时就知道「已经炸过板」,直接进入 broken 状态
    if (!st.init) {
      st.init = true;
      if ((s.sources || []).includes('今日炸板')) st.broken = true;
    }
    if (s.changePercent >= s.limitPct - p.sealedTolerancePct) { st.sealed = true; st.broken = false; }
    else if (st.sealed && s.changePercent <= s.limitPct - p.resealOffsetPct) { st.sealed = false; st.broken = true; }
    if (st.broken && canAlert(`${s.code}:reseal`) && s.changePercent >= s.limitPct - p.resealTriggerOffsetPct && s.changePercent < s.limitPct - p.sealedTolerancePct) {
      st.broken = false;
      resealEvents.push({
        code: s.code, name: s.name, kind: 'reseal',
        pct: Math.round(s.changePercent * 100) / 100, limitPct: s.limitPct, boardLimitPct: s.boardLimitPct,
        gapPct: Math.round(Math.max(0, s.limitPct - s.changePercent) * 100) / 100, auction: session.auction, t: now,
      });
    }
    resealMap.set(s.code, st);
  }
  await pageKvSet('preSealReseal', { date: today, byCode: Object.fromEntries(resealMap) }).catch(() => {});
  // 上轮涨幅快照:落页面同一个库,跨 tick 保持;隔日作废(防止隔夜旧涨幅被当急拉基准)
  const prevRec = await pageKvGet('preSealPrevSnap').catch(() => null);
  const prevSnap = new Map(prevRec && prevRec.date === today && prevRec.snap ? Object.entries(prevRec.snap) : []);
  const events = detectPreSealAlerts({ stocks, watchCodes: stocks.map((s) => s.code), prevSnap, now, inCooldown: (key) => !canAlert(key) });
  for (const ev of events) ev.auction = session.auction;
  const resealCodes = new Set(resealEvents.map((ev) => ev.code));
  const accepted = [];
  for (const ev of [...events.filter((e) => !resealCodes.has(e.code)), ...resealEvents]) {
    const key = `${ev.code}:${ev.kind}`;
    if (!canAlert(key)) continue;
    markAlerted(key, ev);
    accepted.push(ev);
  }
  await pageKvSet('preSealPrevSnap', { date: today, snap: Object.fromEntries(stocks.map((s) => [s.code, { pct: s.changePercent, t: now }])) }).catch(() => {});
  if (accepted.length) {
    // 写入前与页面账本并集(同一 key 取 lastAt 更新的):页面 15s 扫描可能刚写过
    const latest = await pageKvGet('preSealRepeat').catch(() => null);
    if (latest && latest.date === today && latest.byKey) {
      for (const [k, v] of Object.entries(latest.byKey)) {
        const cur = repeat.get(k);
        if (!cur || (Number(v?.lastAt) || 0) > (Number(cur?.lastAt) || 0)) repeat.set(k, v);
      }
    }
    const byKey = {};
    for (const [k, v] of repeat) byKey[k] = v;
    await pageKvSet('preSealRepeat', { date: today, byKey }).catch(() => {});
  }
  const root = new URL(ntfyUrl).origin + '/';
  const topic = ntfyUrl.split('/').filter(Boolean).pop();
  const lineOf = (ev) => {
    const gap = Number.isFinite(Number(ev.gapPct)) ? Number(ev.gapPct).toFixed(1) : '--';
    // 2026-10-30 对齐桌面 preSealLine:口径「离板还差 X%」(原「距涨停 Xpp」与桌面不一致)
    if (ev.kind === 'sealApproach') return `${ev.auction ? '[竞价] ' : ''}离板还差 ${gap}%（现 ${ev.pct}%）`;
    if (ev.kind === 'reseal') return `回封 · 离板还差 ${gap}%（现 ${ev.pct}%）`;
    return `急拉 +${ev.rise ?? '--'}%（现 ${ev.pct}%）`;
  };
  const lines = accepted.slice(0, 8).map((ev) => `${ev.name} ${lineOf(ev)}`);
  if (accepted.length > 8) lines.push(`另有 ${accepted.length - 8} 只`);
  if (lines.length) {
    // 2026-10-30 对齐桌面 93b6eaa:ntfy 标题去「MarketPulse ·」前缀(SW 通知标题本就没有)
    const title = accepted.length === 1 ? `${accepted[0].name} ${accepted[0].kind === 'sealApproach' ? '封板前预警' : accepted[0].kind === 'reseal' ? '回封预警' : '急拉预警'}` : `封板前预警 ${accepted.length} 只`;
    const notifyTitle = accepted.length === 1 ? (accepted[0].kind === 'sealApproach' ? '封板前预警' : accepted[0].kind === 'reseal' ? '回封预警' : '急拉预警') : '封板前预警';
    const message = lines.join('\n');
    // 2026-10-26 与页面/网页同口径:偶发 5xx/网络抖动立即重试 2 次(2s/5s),后台推送更怕一次抖动就丢。
    const body = JSON.stringify({ topic, title, message, priority: 4, tags: ['warning', 'bell'] });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await new Promise((r) => setTimeout(r, attempt === 1 ? 2000 : 5000));
      try {
        const res = await fetch(root, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        if (res && res.ok) break;
      } catch { /* 下一轮重试 */ }
    }
    try { await self.registration.showNotification(notifyTitle, { body: message, tag: 'bg-preseal', icon: './icons/icon-192.png', badge: './icons/icon-512.png' }); } catch { /* 无通知权限时静默 */ }
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
