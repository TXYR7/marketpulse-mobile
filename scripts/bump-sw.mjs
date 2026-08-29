// scripts/bump-sw.mjs — 每次发布自动递增 CACHE 版本号，确保手机端拉到新外壳而非旧缓存。
// 同时重写 version.js（APP_VERSION 单一事实源，设置页展示用）——两文件同一事务写入，不会漂移。
// 配合 发布到手机.cmd 在 git add 前调用；手动发布也应先跑一次。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const p = fileURLToPath(new URL('../sw.js', import.meta.url));
const vp = fileURLToPath(new URL('../version.js', import.meta.url));
const t = readFileSync(p, 'utf8');
const m = t.match(/const CACHE = ['"]mp-mobile-v(\d+)['"]/);
if (!m) { console.error('sw.js 未找到 CACHE 版本号'); process.exit(1); }
const n = Number(m[1]) + 1;
const next = t.replace(/const CACHE = ['"]mp-mobile-v\d+['"]/, `const CACHE = 'mp-mobile-v${n}'`);
writeFileSync(p, next);
writeFileSync(vp, `// version.js — 应用版本单一事实源：由 scripts/bump-sw.mjs 与 sw.js CACHE 同一事务写入，勿手改。\nexport const APP_VERSION = 'mp-mobile-v${n}';\n`);
console.log(`sw.js CACHE -> mp-mobile-v${n}（version.js 已同步）`);
