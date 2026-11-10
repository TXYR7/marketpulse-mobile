export function refreshResultOf(payload) {
  if (!payload) return 'error';
  if ((!payload.stocks?.length && payload.health?.ok !== true) || payload.delayed || payload.stale || payload.estimated || payload.health?.ok === false || payload.health?.stale || (payload.resilience?.mode && payload.resilience.mode !== 'live')) return 'degraded';
  return 'success';
}

export function createRefreshFeedback(button, { doc = document, win = window, schedule = setTimeout, cancel = clearTimeout, holdMs = 1800 } = {}) {
  const classes = { loading:'is-loading', success:'is-done', degraded:'is-degraded', error:'is-fail' };
  const descriptions = { loading:'正在请求行情数据', success:'刷新请求已完成', degraded:'数据为快照、估算或仍有待核实项', error:'刷新失败，可以重试' };
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)');
  let status = 'idle', generation = 0, timer = null;
  const mute = () => button?.classList.toggle('refresh-motion-muted', Boolean(doc.hidden || reduced?.matches));
  function set(next) {
    if (next !== 'idle' && !Object.hasOwn(classes, next)) next = 'idle';
    mute();
    if (!button || status === next) return;
    const id = ++generation;
    if (timer !== null) cancel(timer);
    timer = null; status = next;
    button.classList.remove(...Object.values(classes));
    if (classes[next]) button.classList.add(classes[next]);
    button.setAttribute('aria-busy', String(next === 'loading'));
    if (descriptions[next]) button.setAttribute('aria-description', descriptions[next]);
    else button.removeAttribute?.('aria-description');
    if (next !== 'loading' && next !== 'idle') timer = schedule(() => {
      if (id === generation) set('idle');
    }, holdMs);
  }
  reduced?.addEventListener?.('change', mute);
  doc.addEventListener?.('visibilitychange', mute);
  mute();
  return { set, get status() { return status; } };
}
