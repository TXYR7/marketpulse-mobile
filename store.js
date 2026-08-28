// store.js — 本地持久化（IndexedDB，仅存本机）：自选 / 设置 / 交易流水 / 复盘日记 / 历史涨停池缓存

const DB = 'mp-mobile';
const VER = 3;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('watch')) db.createObjectStore('watch', { keyPath: 'code' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('trades')) db.createObjectStore('trades', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('reviews')) db.createObjectStore('reviews', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history'); // key = YYYYMMDD -> {date, stocks:[{code,boards,industry,name}]}
    };
    req.onsuccess = () => { _db = req.result; res(_db); };
    req.onerror = () => rej(req.error);
  });
}

/* ---------- 自选 ---------- */
export async function getWatch() {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('watch', 'readonly');
    const r = tx.objectStore('watch').getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}
export async function putWatch(item) {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('watch', 'readwrite');
    tx.objectStore('watch').put(item);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
export async function delWatch(code) {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('watch', 'readwrite');
    tx.objectStore('watch').delete(code);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
export async function clearWatch() {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('watch', 'readwrite');
    tx.objectStore('watch').clear(); // 单事务清空，替代逐条 delete 的 N 次事务
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/* ---------- 设置 KV ---------- */
export async function getKV(k, def) {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const r = tx.objectStore('kv').get(k);
    r.onsuccess = () => res(r.result ?? def);
    r.onerror = () => rej(r.error);
  });
}
export async function setKV(k, v) {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/* ---------- 交易流水 ---------- */
export async function getTrades() {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('trades', 'readonly');
    const r = tx.objectStore('trades').getAll();
    r.onsuccess = () => res((r.result || []).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))));
    r.onerror = () => rej(r.error);
  });
}
export async function putTrade(item) {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('trades', 'readwrite');
    tx.objectStore('trades').put(item);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
export async function delTrade(id) {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('trades', 'readwrite');
    tx.objectStore('trades').delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/* ---------- 复盘日记 ---------- */
export async function getReviews() {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('reviews', 'readonly');
    const r = tx.objectStore('reviews').getAll();
    r.onsuccess = () => res((r.result || []).sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))));
    r.onerror = () => rej(r.error);
  });
}
export async function putReview(item) {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('reviews', 'readwrite');
    tx.objectStore('reviews').put(item);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
export async function delReview(date) {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('reviews', 'readwrite');
    tx.objectStore('reviews').delete(date);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/* ---------- 历史涨停池缓存（晋级率 / 模式监控 / 相似行情） ---------- */
export async function getHistory(date) {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('history', 'readonly');
    const r = tx.objectStore('history').get(date);
    r.onsuccess = () => res(r.result ?? null);
    r.onerror = () => rej(r.error);
  });
}
export async function putHistory(item) {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('history', 'readwrite');
    tx.objectStore('history').put(item, item.date);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
export async function getAllHistory() {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction('history', 'readonly');
    const r = tx.objectStore('history').getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}
// 只保留 keepDates 里的历史记录，删除更旧的（防止 history 无限增长拖慢启动）
export async function pruneHistoryKeep(keepDates) {
  const db = await open();
  const keep = new Set(keepDates.map(String));
  return new Promise((res, rej) => {
    const tx = db.transaction('history', 'readwrite');
    const store = tx.objectStore('history');
    const req = store.getAllKeys();
    req.onsuccess = () => {
      (req.result || []).forEach((k) => { if (!keep.has(String(k))) store.delete(k); });
    };
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

