// store.js — 自选与设置的本地持久化（IndexedDB，仅存本机）

const DB = 'mp-mobile';
const VER = 1;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('watch')) db.createObjectStore('watch', { keyPath: 'code' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => { _db = req.result; res(_db); };
    req.onerror = () => rej(req.error);
  });
}

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
