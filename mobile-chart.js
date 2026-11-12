import { loadChartBars } from './mobile-data.js';
import { createRefreshFeedback } from './refresh-feedback.js';
import {quoteTone} from './mobile-detail.js';


export function chartGeometry(bars, { range = 60, averages = [5, 10, 20], selected = null } = {}) {
  const data = bars.slice(-range), offset = bars.length - data.length;
  if (!data.length) return null;
  const width = 360, left = 8, right = 48, top = 18, bottom = 190, volumeTop = 210, volumeBottom = 250;
  let min = Math.min(...data.map(b => b.low)), max = Math.max(...data.map(b => b.high));
  const padding = (max - min || max * .02) * .12; min -= padding; max += padding;
  const step = (width - left - right) / data.length;
  const x = i => left + step * (i + .5), y = v => bottom - (v - min) / (max - min) * (bottom - top);
  const maxVolume = Math.max(1, ...data.map(b => b.volume || 0));
  const ma = n => data.map((b, i) => { const end = offset + i; if (end < n - 1) return null; return bars.slice(end - n + 1, end + 1).reduce((s, b) => s + b.close, 0) / n; });
  const lines = averages.map(n => ({ n, points: ma(n).map((v, i) => v == null ? '' : x(i).toFixed(2) + ',' + y(v).toFixed(2)).filter(Boolean).join(' ') }));
  return { data, width, min, max, step, x, y, left, right, top, bottom, volumeTop, volumeBottom, maxVolume, lines, selected: selected == null ? data.length - 1 : Math.min(Math.max(0, selected), data.length - 1) };
}
export function chartSVG(bars, prefs = {}) {
  const g = chartGeometry(bars, prefs); if (!g) return '';
  const { data, x, y, step } = g;
  const grid = Array.from({ length: 4 }, (_, i) => { const price = g.min + (g.max - g.min) * i / 3, yy = y(price); return '<path class="chart-grid" d="M8 ' + yy + 'H312"/><text x="316" y="' + (yy + 4) + '">' + price.toFixed(2) + '</text>'; }).join('');
  const candles = data.map((b, i) => { const xx = x(i), w = Math.max(1, Math.min(7, step * .6)), cls = b.close >= b.open ? 'chart-up' : 'chart-down'; return '<g class="' + cls + '"><path d="M' + xx + ' ' + y(b.high) + 'V' + y(b.low) + '"/><rect x="' + (xx - w / 2) + '" y="' + Math.min(y(b.open), y(b.close)) + '" width="' + w + '" height="' + Math.max(1, Math.abs(y(b.open) - y(b.close))) + '"/><rect x="' + (xx - w / 2) + '" y="' + (g.volumeBottom - (b.volume || 0) / g.maxVolume * 36) + '" width="' + w + '" height="' + Math.max(1, (b.volume || 0) / g.maxVolume * 36) + '"/></g>'; }).join('');
  const lines = g.lines.map(l => '<polyline class="chart-ma ma' + l.n + '" points="' + l.points + '"/>').join('');
  const b = data[g.selected];
  return '<svg class="mobile-kline" viewBox="0 0 360 276" role="img" aria-label="日K与成交量，拖动查看每日数据">' + grid + candles + lines + '<path class="chart-cross" d="M' + x(g.selected) + ' 18V250M8 ' + y(b.close) + 'H312"/><text x="8" y="272">' + dateLabel(data[0].date) + '</text><text x="312" y="272" text-anchor="end">' + dateLabel(data.at(-1).date) + '</text></svg>';
}
function dateLabel(date) { return date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8); }
export function chartReadoutHTML(b) {
  return '<span>'+dateLabel(b.date)+'</span>  开 '+b.open.toFixed(2)+'  高 '+b.high.toFixed(2)+'  低 '+b.low.toFixed(2)+'  收 <b class="'+quoteTone(b.close,b.close-b.open)+'">'+b.close.toFixed(2)+'</b>';
}
export function createMobileChart({ onBars = () => {}, doc = document, controlId = 'inspectorKlineControls' } = {}) {
  let currentCode = null, seq = 0, bars = [], source = '', selected = null, root = null, observer = null, rootClick = null;
  const currentButton=()=>root?.querySelector('[data-chart-refresh]');
  const proxyButton={classList:{add:(...names)=>currentButton()?.classList.add(...names),remove:(...names)=>currentButton()?.classList.remove(...names),toggle:(name,on)=>currentButton()?.classList.toggle(name,on)},setAttribute:(name,value)=>currentButton()?.setAttribute(name,value),removeAttribute:name=>currentButton()?.removeAttribute(name)};
  const feedback=createRefreshFeedback(proxyButton,{doc});
  let prefs = { range: 60, averages: [5, 10, 20] };
  try { const saved = JSON.parse(localStorage.getItem('mp-mobile-chart') || 'null'); if (saved) prefs = { range: [20, 60, 120].includes(saved.range) ? saved.range : 60, averages: (saved.averages || []).filter(n => [5, 10, 20].includes(n)) }; } catch {}
  const save = () => { try { localStorage.setItem('mp-mobile-chart', JSON.stringify(prefs)); } catch {} };
  function paint() {
    if (!root?.isConnected) return;
    const width=root.querySelector('.chart-surface')?.getBoundingClientRect().width||360;
    root.style.setProperty('--chart-label-size',(12*360/width)+'px');
    root.querySelectorAll('[data-chart-range]').forEach(b => { b.classList.toggle('active', Number(b.dataset.chartRange) === prefs.range); b.setAttribute('aria-pressed', String(Number(b.dataset.chartRange) === prefs.range)); });
    root.querySelectorAll('[data-chart-ma]').forEach(b => { b.classList.toggle('active', prefs.averages.includes(Number(b.dataset.chartMa))); b.setAttribute('aria-pressed', String(prefs.averages.includes(Number(b.dataset.chartMa)))); });
    if (!bars.length) return;
    const data = bars.slice(-prefs.range); selected = selected == null ? data.length - 1 : Math.min(selected, data.length - 1);
    root.querySelector('.chart-surface').innerHTML = chartSVG(bars, { ...prefs, selected });
    const b = data[selected]; root.querySelector('.chart-readout').innerHTML = chartReadoutHTML(b);
    root.querySelector('.chart-meta').textContent = source + ' · ' + data.length + '根 · ' + dateLabel(data[0].date) + ' 至 ' + dateLabel(data.at(-1).date);
  }
  async function load(refresh = false) {
    const run = ++seq, code = currentCode, el = root;
    if (!el) return;
    el.querySelector('.chart-state').textContent = refresh ? '正在更新日K…' : '正在加载日K…';
    el.querySelector('.chart-state').dataset.status='loading';
    el.querySelector('[data-chart-refresh]').disabled = true;
    feedback.set('loading');
    try {
      const data = await loadChartBars(code, { refresh });
      if (seq !== run || currentCode !== code || root !== el || !el.isConnected) return;
      bars = data.bars; source = data.source; selected = null; el.querySelector('.chart-state').textContent = ''; el.querySelector('.chart-state').dataset.status='success'; feedback.set('success'); paint(); onBars(code, bars);
    } catch (error) { if (seq === run && root === el) {feedback.set('error');el.querySelector('.chart-state').dataset.status='error';el.querySelector('.chart-state').textContent = bars.length ? '更新失败，保留上次日K；可重试' : '日K加载失败，请点击重试';} }
    finally { if (seq === run && root === el) el.querySelector('[data-chart-refresh]').disabled = false; }
  }
  function mount(code, container) {
    close(); currentCode = code; root = container; bars = []; selected = null;
    container.innerHTML = '<div class="mobile-section-head"><h3>日K</h3><button type="button" class="mobile-refresh-control" data-chart-refresh>刷新 / 重试</button></div><div class="chart-controls"><div class="segments inspector-chart-controls" id="' + controlId + '">' + [20, 60, 120].map(n => '<button type="button" data-kline-days="' + n + '" data-chart-range="' + n + '">' + n + '日</button>').join('') + '</div><div class="chart-averages">' + [5, 10, 20].map(n => '<button type="button" class="ma' + n + '" data-chart-ma="' + n + '">MA' + n + '</button>').join('') + '</div></div><div class="chart-state" role="status"></div><div class="chart-readout"></div><div class="chart-surface" tabindex="0" aria-label="日K，左右方向键查看每日数据"></div><p class="chart-meta"></p>';
    rootClick = e => { const range = e.target.closest('[data-chart-range]'), ma = e.target.closest('[data-chart-ma]'); if (range) { prefs.range = Number(range.dataset.chartRange); selected = null; save(); paint(); } if (ma) { const n = Number(ma.dataset.chartMa); prefs.averages = prefs.averages.includes(n) ? prefs.averages.filter(x => x !== n) : [...prefs.averages, n]; save(); paint(); } if (e.target.closest('[data-chart-refresh]')) void load(true); };
    container.addEventListener('click', rootClick);
    const surface = container.querySelector('.chart-surface'); let pointer = null;
    const inspect = e => { if (!bars.length) return; const rect = surface.getBoundingClientRect(), xx = (e.clientX - rect.left) / rect.width * 360, n = Math.min(bars.length, prefs.range); selected = Math.min(n - 1, Math.max(0, Math.floor((xx - 8) / 304 * n))); paint(); };
    surface.addEventListener('pointerdown', e => { pointer = e.pointerId; surface.setPointerCapture(e.pointerId); inspect(e); });
    surface.addEventListener('pointermove', e => { if (pointer === e.pointerId) inspect(e); });
    for (const event of ['pointerup', 'pointercancel']) surface.addEventListener(event, () => { pointer = null; });
    surface.addEventListener('keydown', e => { if (!bars.length || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return; e.preventDefault(); selected = Math.min(Math.min(prefs.range, bars.length) - 1, Math.max(0, (selected ?? 0) + (e.key === 'ArrowLeft' ? -1 : 1))); paint(); });
    if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(paint); observer.observe(surface); }
    paint(); void load();
  }
  function close() { seq++; feedback.set('idle');if(root && rootClick)root.removeEventListener('click',rootClick);rootClick=null; currentCode = null; observer?.disconnect(); observer = null; root = null; }
  return { mount, close, currentCode: () => currentCode };
}
