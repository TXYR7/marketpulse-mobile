// 共享纯计算模块直接从桌面生成 ES 模块；只转换模块边界，不调整规则。
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const desktop=process.env.MP_DESKTOP_ROOT || path.resolve(root,'../codex');
if(!existsSync(path.join(desktop,'unified-judgement.js')))throw new Error('请将MP_DESKTOP_ROOT指向当前桌面仓库');
if(!process.argv.includes('--appearance-only'))for(const file of ['unified-judgement.js','unified-context.js','advisor-core.js']){
  const source=readFileSync(path.join(desktop,file),'utf8').replace(/const (\{[^\n]+\}) = require\('([^']+)'\);/g,'import $1 from \'$2\';').replace(/module\.exports\s*=\s*\{([\s\S]*?)\};\s*$/,'export {$1};\n');
  writeFileSync(path.join(root,file),source);
}
if(!process.argv.includes('--appearance-only'))writeFileSync(path.join(root,'explorer-core.js'),readFileSync(path.join(desktop,'ui/market-explorer.js'),'utf8'));
const brand=readFileSync(path.join(desktop,'index.html'),'utf8').match(/<svg class="brand-mark-galaxy"[\s\S]*?<\/svg>/)?.[0];
if(brand){writeFileSync(path.join(root,'icons/brand.svg'),brand.replace(/class="[^"]+"/,'xmlns="http://www.w3.org/2000/svg"'));const html=readFileSync(path.join(root,'index.html'),'utf8').replace(/<svg class="brand-mark-galaxy"[\s\S]*?<\/svg>/,brand);writeFileSync(path.join(root,'index.html'),html);}
await import('./sync-appearance.mjs');
console.log('手机工作区同步完成。');
