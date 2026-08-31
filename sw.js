// sw.js — 缓存 app 外壳（离线可启动）；行情接口直连不缓存
// 版本号由 scripts/bump-sw.mjs 自动递增（发布到手机.cmd 会调用），无需手动改。
const CACHE = 'mp-mobile-v27';
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
