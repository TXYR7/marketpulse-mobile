// 共享纯计算模块直接从桌面生成 ES 模块；只转换模块边界，不调整规则。
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const desktop=process.env.MP_DESKTOP_ROOT || path.resolve(root,'../codex');
if(!existsSync(path.join(desktop,'unified-judgement.js')))throw new Error('请将MP_DESKTOP_ROOT指向当前桌面仓库');
for(const file of ['unified-judgement.js','unified-context.js','advisor-core.js']){
  const source=readFileSync(path.join(desktop,file),'utf8').replace(/const (\{[^\n]+\}) = require\('([^']+)'\);/g,'import $1 from \'$2\';').replace(/module\.exports\s*=\s*\{([\s\S]*?)\};\s*$/,'export {$1};\n');
  writeFileSync(path.join(root,file),source);
}
writeFileSync(path.join(root,'explorer-core.js'),readFileSync(path.join(desktop,'ui/market-explorer.js'),'utf8'));
console.log('已同步统一判决、上下文、买卖参考和排行纯计算模块。');
