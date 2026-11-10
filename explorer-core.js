// 展示层筛选与快照加载。名次、题材和封板状态沿用各自数据源。
export function marketNumber(value) {
  if (value == null || (typeof value === 'string' && !value.trim()) || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function heatConceptsOf(stock) {
  return [...new Set(String(stock.reason || stock.industry || '').split('+').map(x => x.trim()).filter(Boolean))];
}

export function heatMarketOf(code) {
  if (/^(300|301)/.test(code)) return 'growth';
  if (/^688/.test(code)) return 'star';
  if (/^(43|8[3-9]|92)/.test(code)) return 'north';
  return 'main';
}

export function filterHeatStocks(stocks, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const rows = stocks.filter(s => {
    const boards = marketNumber(s.boards);
    if (filters.board != null && boards !== filters.board) return false;
    if (filters.level === 'multi' && !(boards > 1)) return false;
    if (filters.level === 'first' && boards !== 1) return false;
    if (filters.market && filters.market !== 'all' && heatMarketOf(String(s.code)) !== filters.market) return false;
    if (filters.concept && !heatConceptsOf(s).includes(filters.concept)) return false;
    if (filters.codes && !filters.codes.includes(String(s.code))) return false;
    if (filters.time) {
      const time = String(s.ztFirstTime || '').slice(0, 5).replace(':', '');
      if (!/^\d{4}$/.test(time) || Number(time) < filters.time[0] || Number(time) >= filters.time[1]) return false;
    }
    return !query || [s.name, s.code, s.reason, s.industry].join(' ').toLowerCase().includes(query);
  });
  const desc = (s, key) => marketNumber(s[key]) ?? -Infinity;
  const order = filters.sort || 'seal';
  return rows.sort((a, b) => order === 'time'
    ? (a.ztFirstTime || '99').localeCompare(b.ztFirstTime || '99')
    : desc(b, order === 'break' ? 'breakCount' : 'sealAmount') - desc(a, order === 'break' ? 'breakCount' : 'sealAmount'));
}

export function filterSectorRows(rows, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const values = rows.filter(s => (!query || [s.name, s.code, s.leaderName].join(' ').toLowerCase().includes(query))
    && (!filters.onlyLimit || (marketNumber(s.limitUpCount) ?? 0) > 0));
  const val = s => {
    if (filters.sort === 'lu') return marketNumber(s.limitUpCount) ?? -Infinity;
    if (filters.sort === 'breadth') {
      const up = marketNumber(s.upCount), down = marketNumber(s.downCount);
      return up != null && down != null && up + down > 0 ? up / (up + down) : -Infinity;
    }
    return marketNumber(s.changePercent) ?? -Infinity;
  };
  return values.sort((a, b) => val(b) - val(a) || (marketNumber(b.changePercent) ?? -Infinity) - (marketNumber(a.changePercent) ?? -Infinity));
}

export function filterHotRank(items, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  const rows = items.filter(x => {
    if (filters.scope === 'top20' && !(marketNumber(x.rank) > 0 && marketNumber(x.rank) <= 20)) return false;
    if (filters.scope === 'limit' && x.isLimitUp !== true) return false;
    if (filters.scope === 'rising' && !(marketNumber(x.rankChange) > 0)) return false;
    return !query || [x.name, x.code, ...(x.concepts || [])].join(' ').toLowerCase().includes(query);
  });
  const key = { gain: 'gainPct', change: 'rankChange', heat: 'heat' }[filters.sort];
  return rows.sort((a, b) => key
    ? (marketNumber(b[key]) ?? -Infinity) - (marketNumber(a[key]) ?? -Infinity) || (marketNumber(a.rank) ?? Infinity) - (marketNumber(b.rank) ?? Infinity)
    : (marketNumber(a.rank) ?? Infinity) - (marketNumber(b.rank) ?? Infinity));
}

export function hotRankTier(rank) {
  const n = marketNumber(rank);
  if (!(n > 0)) return 5;
  return n === 1 ? 0 : n <= 5 ? 1 : n <= 15 ? 2 : n <= 35 ? 3 : 4;
}

export function snapshotMetaText(data, fallbackSource = '') {
  const date = new Date(data?.at || data?.asOf || '');
  const time = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date) : '时间未提供';
  const source = data?.source || fallbackSource || '来源未提供';
  const state = data?.refreshError ? '更新失败，保留上次快照' : data?.pendingRefresh ? '正在更新，显示上次快照' : '快照';
  return `${source} · ${state} ${time}`;
}

// 同页单飞、限时等待；失败保留最后成功数据，后台重建最多追查三次。
export function createExplorerLoader({ url, fetcher = (...args) => fetch(...args), onData, onStatus = () => {}, schedule = setTimeout }) {
  let pending = null, timer = null, lastData = null;
  function load(refresh = false, attempt = 0) {
    if (pending) return pending;
    if (timer) { clearTimeout(timer); timer = null; }
    onStatus('loading', lastData);
    pending = (async () => {
      try {
        const response = await fetcher(url + (refresh ? '?refresh=1' : ''), { cache: 'no-store', signal: AbortSignal.timeout(55_000) });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        lastData = data;
        onData(data);
        onStatus(data.refreshError ? 'error' : data.pendingRefresh ? 'pending' : 'ready', data);
        if (data.pendingRefresh && !data.refreshError && attempt < 3) timer = schedule(() => { timer = null; load(false, attempt + 1); }, 6000);
        else if (data.pendingRefresh && !data.refreshError) onStatus('waiting', data);
        return data;
      } catch (error) {
        if (lastData) { lastData = { ...lastData, refreshError: error.message, pendingRefresh: false }; onData(lastData); }
        onStatus('error', lastData, error);
        return lastData;
      } finally { pending = null; }
    })();
    return pending;
  }
  return { load };
}
