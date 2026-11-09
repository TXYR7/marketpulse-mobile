'use strict';

const PUSH_TYPES = ['ntfy'];

function normalizePushConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type || 'ntfy').trim();
  const url = String(raw.url || '').trim();
  if (!PUSH_TYPES.includes(type)) return null;
  try {
    const parsed = new URL(url);
    // JSON publish uses the server root; only a single topic segment is supported.
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)) return null;
    return { type, url: parsed.origin + parsed.pathname.replace(/\/$/, '') };
  } catch { return null; }
}

function buildNtfyBody(title, lines) {
  return { title, message: lines.join('\n'), priority: 5, tags: ['warning', 'bell'] };
}

function createCooldown(windowMs = 30 * 60_000) {
  const seen = new Map();
  return (key, now = Date.now()) => {
    if (seen.has(key) && now - seen.get(key) < windowMs) return false;
    seen.set(key, now);
    return true;
  };
}

function retryAfterMs(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(1000, Math.min(60_000, delay)) : null;
}

async function sendPush(config, title, lines, { fetchFn, timeoutMs = 4000 } = {}) {
  const normalized = normalizePushConfig(config);
  if (!normalized) return { ok: false, error: '推送渠道未配置或配置无效', retryable: false };
  const doFetch = fetchFn || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, error: '当前环境无 fetch', retryable: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  let abortListener;
  try {
    const req = {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: new URL(normalized.url).pathname.slice(1), ...buildNtfyBody(title, lines) }),
      signal: controller.signal
    };
    // A bounded race also protects injected/custom fetch implementations that ignore AbortSignal.
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(new Error('推送请求超时'));
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    const res = await Promise.race([doFetch(new URL(normalized.url).origin + '/', req), aborted]);
    if (!res.ok) return {
      ok: false, status: res.status, error: `HTTP ${res.status}`,
      retryable: res.status === 408 || res.status === 429 || res.status >= 500,
      retryAfterMs: retryAfterMs(res.headers?.get?.('retry-after'))
    };
    return { ok: true, status: res.status };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
    if (abortListener) controller.signal.removeEventListener('abort', abortListener);
  }
}

// One HTTP attempt at a time. Retries return to the queue so their backoff does not block new core events.
function createPushQueue({ sendFn = sendPush, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {}, onComplete = () => {}, minGapMs = 120, budgetMs = 15_000, requestTimeoutMs = 4000 } = {}) {
  const jobs = new Map();
  let timer = null;
  let running = false;
  let stopped = false;
  let nextSendAt = 0;
  let blockedUntil = 0;

  function publish(job) { onChange({ ...job, resolve: undefined, promise: undefined }); }
  function finish(job, result, state) {
    jobs.delete(job.id);
    const completed = { ...result, state, messageId: job.id, attempts: job.attempts, latencyMs: Math.max(0, now() - job.createdAt) };
    try { onComplete({ ...job, resolve: undefined, promise: undefined }, completed); }
    catch (error) { completed.persistenceError = error?.message || String(error); }
    job.resolve(completed);
  }
  function deadline(job) { return Math.min(job.expiresAt, job.startedAt == null ? Infinity : job.startedAt + budgetMs); }
  function schedule(delay = 0) {
    if (stopped || running || !jobs.size) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; void pump(); }, Math.max(0, delay));
  }
  async function pump() {
    if (stopped || running) return;
    const stamp = now();
    for (const job of jobs.values()) {
      if (stamp >= job.expiresAt) finish(job, { ok: false, error: '提醒已过期，停止发送' }, 'expired');
      else if (stamp >= deadline(job) || job.attempts >= 3) finish(job, { ok: false, error: job.lastError || '发送预算已耗尽' }, 'failed');
    }
    if (!jobs.size) return;
    const availableAt = Math.max(nextSendAt, blockedUntil);
    const ready = [...jobs.values()].filter(job => job.nextAt <= stamp && availableAt <= stamp)
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);
    if (!ready.length) {
      const next = Math.min(...[...jobs.values()].map(job => Math.min(deadline(job), Math.max(job.nextAt, availableAt))));
      schedule(next - stamp);
      return;
    }
    const job = ready[0];
    running = true;
    job.startedAt ??= stamp;
    job.attempts += 1;
    job.state = 'sending';
    let result;
    try {
      publish(job);
      result = await sendFn(job.config, job.title, job.lines, { timeoutMs: Math.max(1, Math.min(requestTimeoutMs, deadline(job) - now())), job });
    } catch (error) { result = { ok: false, error: error?.message || String(error), retryable: false }; }
    const completedAt = now();
    nextSendAt = completedAt + minGapMs;
    if (result.ok) finish(job, result, 'sent');
    else if (result.state === 'cancelled' || result.retryable === false || (result.status >= 400 && result.status < 500 && ![408, 429].includes(result.status))) {
      finish(job, result, result.state || 'failed');
    } else {
      const delay = result.status === 429 ? (result.retryAfterMs || 10_000) : [1000, 2000][Math.min(job.attempts - 1, 1)];
      if (result.status === 429) blockedUntil = Math.max(blockedUntil, completedAt + delay);
      job.lastError = result.error;
      job.nextAt = completedAt + delay;
      if (job.attempts >= 3 || job.nextAt >= deadline(job)) finish(job, result, completedAt >= job.expiresAt ? 'expired' : 'failed');
      else {
        job.state = 'retrying';
        try { publish(job); } catch (error) { finish(job, { ok: false, error: error.message }, 'failed'); }
      }
    }
    running = false;
    schedule();
  }
  return {
    enqueue(input) {
      if (jobs.has(input.id)) return jobs.get(input.id).promise;
      const createdAt = input.createdAt ?? now();
      const job = { attempts: 0, startedAt: null, nextAt: createdAt, priority: 1, state: 'pending', ...input, createdAt };
      job.promise = new Promise(resolve => { job.resolve = resolve; });
      jobs.set(job.id, job);
      try { publish(job); } catch (error) { finish(job, { ok: false, error: `提醒未入库：${error.message}` }, 'failed'); }
      schedule();
      return job.promise;
    },
    status() { return { pending: jobs.size, sending: running, retrying: [...jobs.values()].filter(job => job.state === 'retrying').length, blockedUntil }; },
    stop() { stopped = true; if (timer !== null) clearTimer(timer); timer = null; },
    start() { stopped = false; schedule(); }
  };
}

export { normalizePushConfig, buildNtfyBody, createCooldown, sendPush, createPushQueue, retryAfterMs, PUSH_TYPES };
