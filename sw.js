// sw.js — 缓存 app 外壳（离线可启动）；行情接口直连不缓存
// 发布新版本时必须递增 CACHE 版本号，否则手机端会一直用旧缓存（cache-first）。
const CACHE = 'mp-mobile-v3';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './data.js', './store.js',
  './analytics.js', './views.js', './views-extra.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
      fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put('./', cp)); return r; })
        .catch(() => caches.match('./'))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request).then((resp) => {
      const cp = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return resp;
    }).catch(() => caches.match('./')))
  );
});
