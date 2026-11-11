import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {decisionBadgeTone,quickRows} from '../mobile-workspace.js';
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');

test('研究优先级与信号已触发的颜色分开，旧可打信号不能覆盖观望与规避',()=>{
 const pending={promo:{verdict:'可接力'},signal:{state:'待触发'}};
 assert.equal(decisionBadgeTone(pending),'waiting');
 assert.equal(quickRows([pending],{scope:'priority'}).length,1);
 assert.equal(decisionBadgeTone({promo:{verdict:'可接力'},signal:{state:'可打'}}),'ready');
 assert.equal(decisionBadgeTone({promo:{verdict:'观望'},signal:{state:'可打'}}),'waiting');
 assert.equal(decisionBadgeTone({promo:{verdict:'规避'},signal:{state:'可打'}}),'avoid');
 assert.equal(decisionBadgeTone({promo:{verdict:'可接力',hardFails:['限制']},signal:{state:'可打'}}),'avoid');
});

test('首屏恢复明暗主题时，状态栏与原生控件同步到实际灰阶画布',()=>{
 for(const theme of ['dark','light']){
  const attrs={};
  const doc={documentElement:{dataset:{}},querySelector:selector=>({setAttribute:(key,value)=>{attrs[selector+key]=value;}})};
  vm.runInNewContext(read('boot-theme.js'),{document:doc,localStorage:{getItem:()=>theme}});
  assert.equal(doc.documentElement.dataset.theme,theme);
  assert.equal(attrs['meta[name="theme-color"]content'],theme==='dark'?'#0c0c0d':'#fafafa');
  assert.equal(attrs['meta[name="color-scheme"]content'],theme);
 }
});

test('手机评分、风险密度和热度使用各自颜色，橙黄风险不再共用一色',()=>{
 const css=read('mobile-identity.css');
 assert.match(css,/\.theme-rank-row > b\s*\{[^}]*color:var\(--ranking-ink\)/);
 for(const tier of ['S','A','B','C','D'])assert.ok(css.includes('.tier-badge.'+tier+' { color:var(--tier-'+tier.toLowerCase()+')'));
 assert.ok(css.includes('--risk-ink:var(--risk-orange-ink)'));
 assert.ok(css.includes('--risk-ink:var(--risk-yellow-ink)'));
 assert.match(css,/\[data-risk-kind="density"\]\s*\{[^}]*--risk-ink:var\(--data-ink\)/);
 assert.match(read('app.js'),/data-risk-kind=/);
 assert.match(read('views.js'),/data-grade=/);
});
