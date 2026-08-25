// data.js — 东方财富公开接口客户端封装（零后端，CORS * 已验证）
// 复用 D:\codex\server.js 的接口参数与字段口径；改为手机浏览器直连。

const EMA = {
  token: '7eea3edcaed734bea9cbfc24409ed989',
  pool(kind, date) {
    const ep = kind === 'up' ? 'getTopicZTPool' : kind === 'down' ? 'getTopicDTPool' : 'getTopicZBPool';
    const sort = kind === 'down' ? 'fund:asc' : 'fbt:asc';
    return `https://push2ex.eastmoney.com/${ep}?ut=${EMA.token}&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=${sort}&date=${date}`;
  },
  ulist(codes) {
    const secids = codes.map((c) => marketPrefix(c) + c).join(',');
    return `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f12,f14,f2,f17,f18,f62,f66`;
  },
};

function marketPrefix(code) {
  return String(code)[0] === '6' ? '1.' : '0.';
}

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtTime(n) {
  if (n == null) return '--';
  const s = String(n).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

async function getJSON(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json,text/plain,*/*' },
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

function mapPool(row) {
  return {
    code: String(row.c),
    market: row.m,
    name: row.n,
    price: (row.p || 0) / 1000, // 池价格单位为厘，÷1000 得元
    changePct: row.zdp,
    boards: row.lbc ?? 1,
    firstSeal: row.fbt,
    lastSeal: row.lbt,
    breaks: row.zbc ?? 0,
    turnover: row.hs,
    seal: row.fund ?? null, // 封单资金(元)
    amount: row.amount ?? null, // 成交额(元)
    circ: row.ltsz ?? null, // 流通市值
    total: row.tshare ?? null,
    industry: row.hybk || '—',
    zttj: row.zttj || null,
  };
}

export async function fetchPools(date) {
  const [up, down, broken] = await Promise.all([
    getJSON(EMA.pool('up', date)),
    getJSON(EMA.pool('down', date)),
    getJSON(EMA.pool('broken', date)),
  ]);
  const ups = (up?.data?.pool || []).map(mapPool);
  const downs = (down?.data?.pool || []).map(mapPool);
  const brokens = (broken?.data?.pool || []).map(mapPool);
  return {
    date: up?.data?.qdate || date,
    up: ups,
    down: downs,
    broken: brokens,
    upCount: up?.data?.tc ?? ups.length,
    downCount: down?.data?.tc ?? downs.length,
    brokenCount: broken?.data?.tc ?? brokens.length,
  };
}

export async function fetchQuotes(codes) {
  if (!codes.length) return {};
  const data = await getJSON(EMA.ulist(codes));
  const out = {};
  for (const row of data?.data?.diff || []) {
    out[String(row.f12)] = {
      code: String(row.f12),
      name: row.f14,
      price: row.f2,
      open: row.f17,
      prevClose: row.f18,
      main: row.f62, // 主力净流入
      super: row.f66, // 超大单净流入
    };
  }
  return out;
}

// 轻量情绪/风险（简化启发式，仅用于排序与状态展示，非预测）
export function computeSentiment({ upCount, downCount, brokenCount, maxBoard }) {
  const total = upCount + downCount;
  const breakRate = total ? (brokenCount / Math.max(total, 1)) * 100 : 0;
  let score = 50;
  score += Math.min(upCount, 120) * 0.4;
  score -= Math.min(downCount, 60) * 0.8;
  score += Math.min(maxBoard, 12) * 2;
  score -= Math.min(breakRate, 50) * 0.6;
  score = Math.max(0, Math.min(100, Math.round(score)));
  let phase = '平衡';
  if (score >= 75 && downCount <= 5) phase = '高潮';
  else if (score >= 60) phase = '主升';
  else if (score >= 45) phase = '分歧';
  else if (score >= 30) phase = '退潮';
  else phase = '冰点';
  let risk = '低';
  if (downCount >= 20 || breakRate >= 35) risk = '高';
  else if (downCount >= 10 || breakRate >= 20) risk = '中';
  return { score, phase, risk, breakRate: +breakRate.toFixed(1) };
}
