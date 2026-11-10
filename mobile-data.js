import { fetchQuotes, fetchKlineLite, fetchKlineTencent } from './data.js';
import { marketNumber as num } from './explorer-core.js';

const token = () => { try { return localStorage.getItem('mp_ema_token') || '7eea3edcaed734bea9cbfc24409ed989'; } catch { return '7eea3edcaed734bea9cbfc24409ed989'; } };
// 官方建议接口的浏览器兼容入口；响应只通过独立回调交付，过期结果由搜索序号淘汰。
function suggestionJSONP(params) {
  if(typeof document==='undefined')throw new Error('跨域建议接口不可用');
  return new Promise((resolve,reject)=>{
    const callback='mpStockSearch_'+Date.now()+'_'+Math.random().toString(36).slice(2),script=document.createElement('script');
    const finish=(error,data)=>{clearTimeout(timer);script.remove();window[callback]=()=>{};setTimeout(()=>delete window[callback],30000);error?reject(error):resolve(data);};
    window[callback]=data=>finish(null,data);script.onerror=()=>finish(new Error('股票搜索暂不可用'));
    const timer=setTimeout(()=>finish(new Error('股票搜索超时')),6000);
    script.src='https://searchapi.eastmoney.com/api/suggest/get?'+new URLSearchParams({...params,cb:callback});document.head.appendChild(script);
  });
}
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(8000), cache: 'no-store' });
  if (!response.ok) throw new Error('行情接口 HTTP ' + response.status);
  return response.json();
}
async function clist(params) {
  let error;
  for (const host of ['push2.eastmoney.com', 'push2delay.eastmoney.com']) {
    try {
      const data = await json('https://' + host + '/api/qt/clist/get?' + new URLSearchParams({ ut: token(), fltt: '2', invt: '2', np: '1', ...params }));
      if (!data.data || !Array.isArray(data.data.diff)) throw new Error('行情数据未返回');
      return { ...data.data, delayed: host.includes('delay') };
    } catch (e) { error = e; }
  }
  throw error;
}
export async function loadIndices() {
  const data = await json('https://push2.eastmoney.com/api/qt/ulist.np/get?' + new URLSearchParams({ fltt: '2', secids: '1.000001,0.399001,0.399006', fields: 'f12,f14,f2,f3,f6,f104,f105,f106,f124', ut: token() }));
  if (!Array.isArray(data.data?.diff) || !data.data.diff.length) throw new Error('指数暂不可用');
  return { at: new Date().toISOString(), source: '东方财富指数', rows: data.data.diff.map(r => ({ code: r.f12, name: r.f14, price: num(r.f2), changePct: num(r.f3), amount: num(r.f6) })) };
}
let indexHistory = null, indexHistoryPending = null;
export function loadIndexCloses() {
  if(indexHistory && Date.now()-indexHistory.at<300000)return Promise.resolve(indexHistory.closes);
  if(indexHistoryPending)return indexHistoryPending;
  indexHistoryPending=(async()=>{
    const data=await json('https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=0&end=20500101&lmt=320');
    const closes=Object.fromEntries((data.data?.klines||[]).map(line=>{const p=String(line).split(',');return [p[0].replaceAll('-',''),num(p[2])];}).filter(([date,close])=>/^\d{8}$/.test(date)&&close>0));
    if(!Object.keys(closes).length)throw new Error('指数历史未返回');
    indexHistory={closes,at:Date.now()};return closes;
  })().finally(()=>indexHistoryPending=null);
  return indexHistoryPending;
}
export async function loadMarketPage({ page = 1, market = '', query = '', sort = 'gain' } = {}) {
  if (query.trim()) {
    const rows = await lookupMobileStocks(query.trim());
    return { rows: rows.filter(x => /^\d{6}$/.test(x.code)), total: rows.length, page: 1, pageSize: 30, at: new Date().toISOString(), source: '东方财富股票搜索' };
  }
  const markets = { '': 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048', main: 'm:0+t:6,m:1+t:2', growth: 'm:0+t:80', star: 'm:1+t:23', north: 'm:0+t:81+s:2048' };
  const data = await clist({ pn: String(page), pz: '30', po: sort === 'code' ? '0' : '1', fid: { gain: 'f3', amount: 'f6', code: 'f12' }[sort] || 'f3', fs: markets[market] || markets[''], fields: 'f12,f13,f14,f2,f3,f6,f18,f100,f124' });
  return { rows: data.diff.map(r => ({ code: String(r.f12), name: r.f14, price: num(r.f2), changePct: num(r.f3), amount: num(r.f6), industry: r.f100, prevClose: num(r.f18) })), total: num(data.total) ?? data.diff.length, page, pageSize: 30, at: new Date().toISOString(), source: data.delayed ? '东方财富延迟行情' : '东方财富行情' };
}
export function mapSector(r) {
  return { code: String(r.f12), name: String(r.f14 || r.f12), changePercent: num(r.f3), leaderName: r.f128 || '—', leaderCode: r.f140 ? String(r.f140) : '', upCount: num(r.f104), downCount: num(r.f105), amount: num(r.f6), limitUpCount: null };
}
export async function loadSectors(type = 'concept') {
  const data = await clist({ pn: '1', pz: '100', po: '1', fid: 'f3', fs: 'm:90+t:' + (type === 'industry' ? '2' : '3'), fields: 'f12,f14,f3,f6,f104,f105,f128,f140' });
  if (!data.diff.length) throw new Error('板块榜暂未返回');
  return { type, rows: data.diff.map(mapSector), at: new Date().toISOString(), source: data.delayed ? '东方财富延迟板块行情' : '东方财富板块行情' };
}
export async function loadSectorMembers(code) {
  if (!/^BK\d+$/.test(code)) throw new Error('板块代码无效');
  const rows = new Map(); let total = null;
  for (let page = 1; page <= 30; page++) {
    const data = await clist({ pn: String(page), pz: '100', po: '0', fid: 'f12', fs: 'b:' + code, fields: 'f12,f14,f2,f3,f6,f100' });
    if (total === null) total = num(data.total);
    const before = rows.size;
    data.diff.forEach(r => rows.set(String(r.f12), { code: String(r.f12), name: r.f14, price: num(r.f2), changePct: num(r.f3), amount: num(r.f6), industry: r.f100 }));
    if (total != null && rows.size >= total) return { rows: [...rows.values()], total, complete: true };
    if (!data.diff.length || rows.size === before) break;
  }
  return { rows: [...rows.values()], total, complete: total != null && rows.size === total };
}
export function mapHotRows(rows, ths = true) {
  return rows.map(r => ({ code: String(ths ? r.code : r.sc).replace(/^(SH|SZ|BJ)/i, ''), name: r.name || '', rank: num(ths ? r.order : r.rk), heat: ths ? num(r.rate) : null, rankChange: ths ? num(r.hot_rank_chg) : null, gainPct: ths ? num(r.rise_and_fall) : null, concepts: ths && Array.isArray(r.tag?.concept_tag) ? r.tag.concept_tag : [], price: null, isLimitUp: null })).filter(r => /^\d{6}$/.test(r.code) && r.rank > 0);
}
export async function loadHotRank() {
  let rows, source;
  try {
    const data = await json('https://dq.10jqka.com.cn/fuyao/hot_list_data/out/hot_list/v1/stock?stock_type=a&type=hour&list_type=normal');
    if (!Array.isArray(data.data?.stock_list) || !data.data.stock_list.length) throw new Error('热榜未返回');
    rows = mapHotRows(data.data.stock_list); source = '同花顺热榜';
  } catch {
    const data = await json('https://emappdata.eastmoney.com/stockrank/getAllCurrentList', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: 'appId01', globalId: '786e4c21-70dc-435a-93bb-38', marketType: '', pageNo: 1, pageSize: 100 }) });
    if (!Array.isArray(data.data) || !data.data.length) throw new Error('人气榜暂不可用，请稍后重试');
    rows = mapHotRows(data.data, false); source = '东财股吧人气榜';
  }
  const quotes = await fetchQuotes(rows.map(x => x.code), { tries: 1, timeoutMs: 4000 }).catch(() => ({}));
  rows.forEach(r => { const q = quotes[r.code]; if (q) { r.name = q.name || r.name; r.price = q.price; if (q.prevClose > 0 && q.price > 0) r.gainPct = (q.price / q.prevClose - 1) * 100; } r.name ||= r.code; });
  return { rows, at: new Date().toISOString(), source };
}

const klineCache = new Map(), klinePending = new Map();
export function normalizeChartBars(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const date = String(r.date || '').replaceAll('-', '');
    if (/^\d{8}$/.test(date) && [r.open, r.close, r.high, r.low].every(v => num(v) > 0)) map.set(date, { ...r, date });
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export function loadChartBars(code, { refresh = false, limit = 160 } = {}) {
  const key = code + ':' + limit, hit = klineCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < 30000) return Promise.resolve(hit);
  if (klinePending.has(key)) return klinePending.get(key);
  const promise = (async () => {
    let bars, source;
    try { bars = normalizeChartBars(await fetchKlineLite(code, limit)); if (!bars.length) throw new Error('日K为空'); source = '东方财富 · 前复权'; }
    catch { bars = normalizeChartBars(await fetchKlineTencent(code, limit)); source = '腾讯行情 · 前复权'; }
    if (!bars.length) throw new Error('日K暂不可用');
    const value = { bars, source, at: Date.now() }; klineCache.set(key, value); return value;
  })().finally(() => klinePending.delete(key));
  klinePending.set(key, promise); return promise;
}
export async function lookupMobileStocks(query) {
  const q=String(query||'').trim();if(!q)return [];
  try {
    const params={input:q,type:'14',token:'D43BF722C8E33BDC906FB84D85E326E8',count:'8'};
    const data=await json('https://searchapi.eastmoney.com/api/suggest/get?'+new URLSearchParams(params)).catch(()=>suggestionJSONP(params));
    const rows=data.QuotationCodeTable?.Data || data.data?.QuotationCodeTable?.Data;
    if(!Array.isArray(rows))throw new Error('股票搜索未返回');
    return rows.filter(r=>!r.Classify || r.Classify==='AStock').map(r=>({code:String(r.Code||''),name:String(r.Name||r.Code||''),price:null,changePct:null})).filter(r=>/^\d{6}$/.test(r.code)).slice(0,8);
  } catch(error) {
    if(/^\d{6}$/.test(q)){const quotes=await fetchQuotes([q],{tries:1,timeoutMs:3000});if(quotes[q]?.name)return [{code:q,...quotes[q]}];}
    throw error;
  }
}
