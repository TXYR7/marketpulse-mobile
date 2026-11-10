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
for(const [from,to]of [['ui/tokens.css','desktop-tokens.css'],['ui/color-identity.css','color-identity.css'],['ui/motion.js','interaction-motion.js'],['ui/refresh-feedback.js','refresh-feedback.js']])writeFileSync(path.join(root,to),readFileSync(path.join(desktop,from),'utf8'));
writeFileSync(path.join(root,'motion.css'),readFileSync(path.join(desktop,'ui/motion.css'),'utf8').replaceAll('#refreshButton','#refreshBtn').replaceAll('#themeButton','#themeBtn').replaceAll('#appTopbar','.topbar').replaceAll('.app-shell','#mobileMain'));
writeFileSync(path.join(root,'navigation-icons.css'),readFileSync(path.join(desktop,'ui/navigation-icons.css'),'utf8').replaceAll('.topbar-nav','.mobile-bottom-nav'));
const palette=[...readFileSync(path.join(root,'color-identity.css'),'utf8').matchAll(/--canvas:\s*(#[a-f\d]+)\s*;/gi)].map(m=>m[1]);
if(palette.length>=2){
  writeFileSync(path.join(root,'boot-theme.js'),`// 首屏主题与状态栏颜色由网页品牌皮肤生成。\ntry { const theme=localStorage.getItem('mp-theme')==='light'?'light':'dark';document.documentElement.dataset.theme=theme;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='light'?'${palette[1]}':'${palette[0]}'); } catch {document.documentElement.dataset.theme='dark';}\n`);
  const manifest=JSON.parse(readFileSync(path.join(root,'manifest.webmanifest'),'utf8'));manifest.background_color=palette[0];manifest.theme_color=palette[0];writeFileSync(path.join(root,'manifest.webmanifest'),JSON.stringify(manifest,null,2)+'\n');
}
const brand=readFileSync(path.join(desktop,'index.html'),'utf8').match(/<svg class="brand-mark-galaxy"[\s\S]*?<\/svg>/)?.[0];
if(brand){writeFileSync(path.join(root,'icons/brand.svg'),brand.replace(/class="[^"]+"/,'xmlns="http://www.w3.org/2000/svg"'));const html=readFileSync(path.join(root,'index.html'),'utf8').replace(/<svg class="brand-mark-galaxy"[\s\S]*?<\/svg>/,brand);writeFileSync(path.join(root,'index.html'),html);}
console.log('已同步统一判决、排行、主题、品牌、动效和刷新反馈；手机布局保持独立。');
