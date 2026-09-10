// scripts/bump-sw.mjs — 每次发布刷新版本号，确保手机端拉到新外壳而非旧缓存。
// 版本制=日期制(2026-09-10 起):mp-mobile-YYYYMMDD——天然语义(哪天发布)、不会无限累积成无意义的
// 大数(v47 时代用户吐槽「太夸张」)、git 历史/版本号/日期三方对齐。同日多次发布加 -2/-3 后缀。
// 同时重写 version.js（APP_VERSION 单一事实源，设置页展示用）——两文件同一事务写入，不会漂移。
// 配合 发布到手机.cmd 在 git add 前调用；手动发布也应先跑一次。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const p = fileURLToPath(new URL('../sw.js', import.meta.url));
const vp = fileURLToPath(new URL('../version.js', import.meta.url));
const t = readFileSync(p, 'utf8');
const m = t.match(/const CACHE = ['"](mp-mobile-[\w.-]+)['"]/);
if (!m) { console.error('sw.js 未找到 CACHE 版本号'); process.exit(1); }

// 日期版本:今天 YYYYMMDD;若当前版本已是今天,序列号 +1(20260910 → 20260910-2)
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()).replace(/-/g, '');
const current = m[1].replace('mp-mobile-', '');
let next;
if (current === today) {
  const seq = 1;
  next = `${today}-${seq + 1}`;
} else if (/^(\d{8})-(\d+)$/.test(current) && RegExp.$1 === today) {
  next = `${today}-${Number(RegExp.$2) + 1}`;
} else {
  next = today;
}
writeFileSync(p, t.replace(/const CACHE = ['"]mp-mobile-[\w.-]+['"]/, `const CACHE = 'mp-mobile-${next}'`));
writeFileSync(vp, `// version.js — 应用版本单一事实源：由 scripts/bump-sw.mjs 与 sw.js CACHE 同一事务写入，勿手改。\nexport const APP_VERSION = 'mp-mobile-${next}';\n`);
console.log(`sw.js CACHE -> mp-mobile-${next}（version.js 已同步）`);
