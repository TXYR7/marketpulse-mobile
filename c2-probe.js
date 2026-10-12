// C2 探测:periodicSync + SW 本地通知。决定 C2(锁屏准点)是否可做,不影响功能(检测在页面 C1)。
// 由页面在 PWA 内打开(同源)时运行;结果 console.log + 显示在页内,并 localStorage 存一份供诊断。
(async () => {
  const out = [];
  const rec = (n, v, cls, tip) => out.push({ n, v, cls, tip });
  // 1) periodicSync:唯一能让锁屏/杀进程后仍准点触发后台任务的 API
  try {
    if ('serviceWorker' in navigator && 'periodicSync' in ServiceWorkerRegistration.prototype) {
      const reg = await navigator.serviceWorker.ready;
      try {
        await reg.periodicSync.register('mp-probe', { minInterval: 60 * 60 * 1000 });
        await reg.periodicSync.unregister('mp-probe');
        rec('periodicSync', '支持 ✅', 'ok', '可做 C2 锁屏准点');
      } catch (e) { rec('periodicSync', `注册被拒 ${e.name}`, 'no', 'API 在但被策略拒——Chrome 默认不给 PWA,需 flag'); }
    } else rec('periodicSync', '不支持 ❌', 'no', 'API 缺失');
  } catch (e) { rec('periodicSync', '探测异常 ' + e.message, 'no'); }
  // 2) SW 本地通知(Android 13+「本地通知」开关;SW showNotification 后台能否出声/显示)
  try {
    if ('Notification' in window) rec('Notification 权限', Notification.permission, Notification.permission === 'granted' ? 'ok' : 'part');
    else rec('Notification', '不支持', 'no');
  } catch (e) { rec('Notification', '异常 ' + e.message, 'no'); }
  // 结果展示
  const hard = out.filter((r) => r.n === 'periodicSync');
  const verdict = hard[0] && hard[0].cls === 'ok' ? '✅ C2 可做(锁屏准点)' : '❌ C2 做不到锁屏准点,维持 C1(切后台短窗)';
  const html = '<h3>MarketPulse C2 探测</h3><ul>' + out.map((r) => `<li><b>${r.n}</b>: <span style="color:${r.cls === 'ok' ? '#3ddc84' : r.cls === 'no' ? '#ff5c5c' : '#ffd166'}">${r.v}</span>${r.tip ? `<br><small style="color:#9aa0aa">${r.tip}</small>` : ''}</li>`).join('') + `</ul><p><b>${verdict}</b></p>`;
  try {
    const d = document.createElement('div');
    d.innerHTML = html; d.style.cssText = 'position:fixed;inset:20px;background:#111;color:#e6e6e6;padding:20px;border-radius:12px;z-index:99999;overflow:auto;font-family:system-ui';
    const close = document.createElement('button'); close.textContent = '关闭'; close.style.cssText = 'margin-top:12px;padding:8px 16px';
    close.onclick = () => d.remove(); d.appendChild(close);
    document.body.appendChild(d);
  } catch {}
  console.log('[c2-probe]', JSON.stringify(out), verdict);
  try { localStorage.setItem('mp-c2-probe', JSON.stringify({ at: Date.now(), out, verdict })); } catch {}
})();
