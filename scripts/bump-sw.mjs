// scripts/bump-sw.mjs — 每次发布自动递增 CACHE 版本号，确保手机端拉到新外壳而非旧缓存。
// 配合 发布到手机.cmd 在 git add 前调用；手动发布也应先跑一次。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const p = fileURLToPath(new URL('../sw.js', import.meta.url));
const t = readFileSync(p, 'utf8');
const m = t.match(/const CACHE = ['"]mp-mobile-v(\d+)['"]/);
if (!m) { console.error('sw.js 未找到 CACHE 版本号'); process.exit(1); }
const n = Number(m[1]) + 1;
const next = t.replace(/const CACHE = ['"]mp-mobile-v\d+['"]/, `const CACHE = 'mp-mobile-v${n}'`);
writeFileSync(p, next);
console.log(`sw.js CACHE -> mp-mobile-v${n}`);
