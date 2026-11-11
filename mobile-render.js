// Merge presentation work while keeping each quote observation synchronous in app.js.
export function createMobilePaintQueue(paint, { win = window } = {}) {
  let frame = null;
  function request({ afterPaint = false } = {}) {
    if (frame !== null) return;
    frame = win.requestAnimationFrame(() => {
      if (afterPaint) frame = win.requestAnimationFrame(run);
      else run();
    });
  }
  function run() { frame = null; paint(); }
  function cancel() { if (frame !== null) win.cancelAnimationFrame(frame); frame = null; }
  return { request, cancel };
}

// Kline backfill updates the same snapshot. Batch it without inventing new observations.
export function createSnapshotBackfill(readSnapshot, apply, { schedule = setTimeout, delay = 100 } = {}) {
  let pending = null, timer = null;
  return () => {
    pending = readSnapshot();
    if (timer !== null) return;
    timer = schedule(() => {
      timer = null;
      const snapshot = pending, current = readSnapshot(); pending = null;
      if (snapshot.pools === current.pools && snapshot.at === current.at) apply();
    }, delay);
  };
}
