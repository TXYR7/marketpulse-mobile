import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const desktop=process.env.MP_DESKTOP_ROOT || path.resolve(root,'../codex');
for(const [from,to] of [['ui/tokens.css','desktop-tokens.css'],['ui/color-identity.css','color-identity.css'],['ui/motion.js','interaction-motion.js'],['ui/refresh-feedback.js','refresh-feedback.js']]) {
  writeFileSync(path.join(root,to),readFileSync(path.join(desktop,from),'utf8'));
}
writeFileSync(path.join(root,'motion.css'),readFileSync(path.join(desktop,'ui/motion.css'),'utf8').replaceAll('#refreshButton','#refreshBtn').replaceAll('#themeButton','#themeBtn').replaceAll('#appTopbar','.topbar').replaceAll('.app-shell','#mobileMain'));
writeFileSync(path.join(root,'navigation-icons.css'),readFileSync(path.join(desktop,'ui/navigation-icons.css'),'utf8').replaceAll('.topbar-nav','.mobile-bottom-nav'));

// 新主题的画布使用 HSL 变量，首屏和 PWA 状态栏需要实际颜色。
const css=readFileSync(path.join(root,'color-identity.css'),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
const blocks=[...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
function canvas(selector) {
  const body=blocks.find(match=>match[1].trim()===selector)?.[2];
  if(!body)throw new Error('缺少明暗主题定义: '+selector);
  const literal=body.match(/--canvas:\s*(#[a-f\d]{6})\s*;/i)?.[1];
  if(literal)return literal;
  const hsl=body.match(/--tsp-base:\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  if(!hsl)throw new Error('无法解析主题画布');
  const h=Number(hsl[1]),s=Number(hsl[2])/100,l=Number(hsl[3])/100,a=s*Math.min(l,1-l);
  const channel=n=>{const k=(n+h/30)%12;return Math.round((l-a*Math.max(-1,Math.min(k-3,9-k,1)))*255).toString(16).padStart(2,'0');};
  return '#'+[0,8,4].map(channel).join('');
}
const dark=canvas(':root:not([data-theme="light"])'),light=canvas('html[data-theme="light"]');
writeFileSync(path.join(root,'boot-theme.js'),`// 首屏主题与状态栏颜色由共享主题生成。\nlet initialTheme='dark';try{if(localStorage.getItem('mp-theme')==='light')initialTheme='light';}catch{}\ndocument.documentElement.dataset.theme=initialTheme;\ndocument.querySelector('meta[name="theme-color"]')?.setAttribute('content',initialTheme==='light'?'${light}':'${dark}');\ndocument.querySelector('meta[name="color-scheme"]')?.setAttribute('content',initialTheme);\n`);
const manifest=JSON.parse(readFileSync(path.join(root,'manifest.webmanifest'),'utf8'));manifest.background_color=dark;manifest.theme_color=dark;writeFileSync(path.join(root,'manifest.webmanifest'),JSON.stringify(manifest,null,2)+'\n');
const html=readFileSync(path.join(root,'index.html'),'utf8').replace(/(<meta name="theme-color" content=")[^"]+("\s*\/?>)/,'$1'+dark+'$2');
writeFileSync(path.join(root,'index.html'),html);
console.log('已同步主题、品牌、动效、刷新反馈及 PWA 状态栏颜色。');
