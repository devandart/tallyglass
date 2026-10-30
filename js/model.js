// SPDX-License-Identifier: GPL-3.0-or-later
// Turns per-file parse results into a dataset, and the dataset into dashboard numbers.
import { modelInfo, recordCostParts, cacheSavings } from './pricing.js?v=5';

const H = 3600e3;
const DAY = 24 * H;
export const BLOCK_MS = 5 * H;
const IDLE_GAP = 10 * 60e3;

function projectOf(cwd, projectDir) {
  if (!cwd) return { key: projectDir || 'unknown', label: projectDir || 'Unknown' };
  const p = cwd.replace(/\\/g, '/').replace(/\/\.claude\/worktrees\/.*$/, '').replace(/\/+$/, '');
  if (/scratch-workspaces|\/claude\/scratch/i.test(p)) return { key: 'scratch', label: 'Scratch (no folder)' };
  const segs = p.split('/').filter(Boolean);
  return { key: p.toLowerCase(), label: segs.slice(-2).join('/') || p, path: p };
}

// fileResults: [{ cls: {sessionId, isSub, projectDir}, result: {info, records} }]
export function buildDataset(fileResults) {
  const sorted = [...fileResults].sort((a, b) => (a.result.info.firstTs ?? 0) - (b.result.info.firstTs ?? 0));
  const seen = new Set();
  const sessions = new Map();
  const records = [];
  const projects = new Map();

  for (const { cls, result } of sorted) {
    const { info } = result;
    let s = sessions.get(cls.sessionId);
    if (!s) {
      s = { id: cls.sessionId, projectDir: cls.projectDir, title: null, firstPrompt: null, prompts: 0, cwd: null,
        entrypoint: null, version: null, branch: null, subagents: 0, firstTs: null, lastTs: null, idx: sessions.size };
      sessions.set(cls.sessionId, s);
    }
    if (cls.isSub) s.subagents++;
    else {
      s.title = info.customTitle || info.agentName || info.aiTitle || info.summary || s.title;
      s.firstPrompt ??= info.firstPrompt;
      s.prompts += info.prompts;
      s.entrypoint ??= info.entrypoint;
      s.version = info.version || s.version;
      s.branch ??= info.gitBranch;
    }
    s.cwd ??= info.cwd;
    if (info.firstTs !== null && (s.firstTs === null || info.firstTs < s.firstTs)) s.firstTs = info.firstTs;
    if (info.lastTs !== null && (s.lastTs === null || info.lastTs > s.lastTs)) s.lastTs = info.lastTs;

    for (const r of result.records) {
      if (seen.has(r.k)) continue; // resumed/forked sessions copy earlier messages
      seen.add(r.k);
      const parts = recordCostParts(r);
      records.push({
        t: r.t, m: r.m, s: r.s, f: r.f, sid: s.idx, tl: r.tl,
        i: r.i, o: r.o, cw: r.c5 + r.c1, r: r.r,
        tok: r.i + r.o + r.c5 + r.c1 + r.r,
        ctx: r.i + r.c5 + r.c1 + r.r,
        cost: parts[0] + parts[1] + parts[2] + parts[3],
        pc: parts,
        save: cacheSavings(r),
      });
    }
  }

  const list = [...sessions.values()];
  for (const s of list) {
    const p = projectOf(s.cwd, s.projectDir);
    s.project = p.label;
    s.projectKey = p.key;
    if (!projects.has(p.key)) projects.set(p.key, p);
    s.label = s.title || s.firstPrompt || s.id.slice(0, 8);
    s.tok = 0; s.cost = 0; s.msgs = 0; s.active = 0; s.subTok = 0; s.subCost = 0; s.models = new Map(); s._last = 0;
  }
  records.sort((a, b) => a.t - b.t);
  for (const r of records) {
    const s = list[r.sid];
    s.tok += r.tok; s.cost += r.cost; s.msgs++;
    if (r.s) { s.subTok += r.tok; s.subCost += r.cost; }
    s.models.set(r.m, (s.models.get(r.m) || 0) + r.cost);
    if (s._last && r.t - s._last < IDLE_GAP) s.active += r.t - s._last;
    s._last = r.t;
  }
  for (const s of list) {
    s.mainModel = [...s.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    delete s._last;
  }

  // Colors follow the model, ranked over all data so filters never repaint a series.
  const modelTotals = new Map();
  for (const r of records) modelTotals.set(r.m, (modelTotals.get(r.m) || 0) + r.cost);
  const modelOrder = [...modelTotals.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);

  return { records, sessions: list.filter((s) => s.msgs > 0), allSessions: list, modelOrder, projects };
}

export function computeBlocks(records) {
  const blocks = [];
  let b = null;
  for (const r of records) {
    if (!b || r.t >= b.end) {
      const start = Math.floor(r.t / H) * H;
      b = { start, end: start + BLOCK_MS, tok: 0, cost: 0, n: 0, first: r.t, last: r.t };
      blocks.push(b);
    }
    b.tok += r.tok; b.cost += r.cost; b.n++; b.last = r.t;
  }
  return blocks;
}

export const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Start of the current weekly window. reset = {day: 0-6, hour: 0-23} or null for rolling 7 days.
export function weekStart(now, reset) {
  if (!reset) return now - 7 * DAY;
  const d = new Date(now);
  d.setHours(reset.hour, 0, 0, 0);
  let diff = (d.getDay() - reset.day + 7) % 7;
  d.setDate(d.getDate() - diff);
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return d.getTime();
}

// Everything the dashboard shows for one date range and metric ('tok' or 'cost').
export function analyze(ds, { since, metric, now = Date.now(), selectedId, weeklyReset }) {
  const recs = since ? ds.records.filter((r) => r.t >= since) : ds.records;
  const val = (x) => x[metric];

  const totals = { tok: 0, cost: 0, i: 0, o: 0, cw: 0, r: 0, msgs: recs.length, sub: { tok: 0, cost: 0 }, save: 0,
    pc: [0, 0, 0, 0] };
  const sess = new Map();
  const daily = new Map();
  const models = new Map();
  const projects = new Map();
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const tools = new Map();

  for (const r of recs) {
    totals.tok += r.tok; totals.cost += r.cost;
    totals.i += r.i; totals.o += r.o; totals.cw += r.cw; totals.r += r.r; totals.save += r.save;
    for (let j = 0; j < 4; j++) totals.pc[j] += r.pc[j];
    if (r.s) { totals.sub.tok += r.tok; totals.sub.cost += r.cost; }

    let s = sess.get(r.sid);
    if (!s) sess.set(r.sid, (s = { tok: 0, cost: 0, msgs: 0 }));
    s.tok += r.tok; s.cost += r.cost; s.msgs++;

    const dk = dayKey(r.t);
    let d = daily.get(dk);
    if (!d) daily.set(dk, (d = { tok: 0, cost: 0, byModel: new Map() }));
    d.tok += r.tok; d.cost += r.cost;
    d.byModel.set(r.m, (d.byModel.get(r.m) || 0) + val(r));

    let m = models.get(r.m);
    if (!m) models.set(r.m, (m = { tok: 0, cost: 0, msgs: 0 }));
    m.tok += r.tok; m.cost += r.cost; m.msgs++;

    const pk = ds.allSessions[r.sid].projectKey;
    let p = projects.get(pk);
    if (!p) projects.set(pk, (p = { key: pk, label: ds.allSessions[r.sid].project, tok: 0, cost: 0, sessions: new Set() }));
    p.tok += r.tok; p.cost += r.cost; p.sessions.add(r.sid);

    const dt = new Date(r.t);
    heat[(dt.getDay() + 6) % 7][dt.getHours()] += val(r);

    if (r.tl) for (const n of r.tl) tools.set(n, (tools.get(n) || 0) + 1);
  }

  // Sessions active in range. Session values are whole-session totals, so a session
  // that started before the range still compares by its full size.
  const sessions = [...sess.keys()].map((idx) => ds.allSessions[idx]);
  const sv = (s) => (metric === 'tok' ? s.tok : s.cost);
  sessions.sort((a, b) => sv(b) - sv(a));

  const prompts = sessions.reduce((a, s) => a + s.prompts, 0);
  const activeDays = daily.size;

  // Selected session: explicit pick, else the most recently active one.
  let selected = selectedId && ds.allSessions.find((s) => s.id === selectedId);
  if (!selected) selected = [...ds.sessions].sort((a, b) => b.lastTs - a.lastTs)[0] || null;
  let compare = null;
  if (selected) {
    const inRange = sessions.includes(selected);
    const v = sv(selected);
    const vals = sessions.map(sv);
    const med = median(vals);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const below = vals.filter((x) => x < v).length;
    const ctx = [];
    for (const r of ds.records) if (r.sid === selected.idx && !r.s) ctx.push({ t: r.t, ctx: r.ctx, v: val(r) });
    compare = {
      session: selected, value: v, inRange, rank: inRange ? sessions.indexOf(selected) + 1 : null, of: sessions.length,
      percentile: vals.length ? Math.round((below / vals.length) * 100) : 0,
      median: med, avg, max: vals[0] || 0, xMedian: med ? v / med : 0,
      share: inRange && totals[metric] ? (metric === 'tok' ? sess.get(selected.idx).tok : sess.get(selected.idx).cost) / totals[metric] : 0,
      ctx, peakCtx: ctx.reduce((a, c) => Math.max(a, c.ctx), 0),
    };
  }

  // Limit windows always use all data, independent of the range filter.
  const blocks = computeBlocks(ds.records);
  const last = blocks[blocks.length - 1];
  const current = last && now < last.end ? last : null;
  const done = current ? blocks.slice(0, -1) : blocks;
  const peakBlock = done.reduce((a, b) => (val(b) > (a ? val(a) : -1) ? b : a), null);

  const ws = weekStart(now, weeklyReset);
  let weekVal = 0;
  for (let j = ds.records.length - 1; j >= 0 && ds.records[j].t >= ws; j--) weekVal += val(ds.records[j]);
  // Peak of any 7-day span (by calendar day), excluding the current one.
  const allDaily = new Map();
  for (const r of ds.records) { const k = startOfDay(r.t); allDaily.set(k, (allDaily.get(k) || 0) + val(r)); }
  const dayKeys = [...allDaily.keys()].sort((a, b) => a - b);
  let peakWeek = 0;
  for (let a = 0, b = 0, sum = 0; b < dayKeys.length; b++) {
    sum += allDaily.get(dayKeys[b]);
    while (dayKeys[b] - dayKeys[a] >= 7 * DAY) sum -= allDaily.get(dayKeys[a++]);
    if (dayKeys[b] + DAY <= ws) peakWeek = Math.max(peakWeek, sum);
  }

  // Calendar for the daily chart.
  const first = since || (ds.records[0] ? startOfDay(ds.records[0].t) : startOfDay(now));
  const days = [];
  for (let t = startOfDay(first); t <= now; t += DAY) {
    const k = dayKey(t);
    days.push({ key: k, t, ...(daily.get(k) || { tok: 0, cost: 0, byModel: new Map() }) });
    t = startOfDay(t + DAY + 2 * H) - DAY; // DST-safe step to the next midnight
  }

  // Streaks over all data (today counts once it has activity).
  const activeSet = new Set(dayKeys.map(dayKey));
  let streak = 0;
  let st = startOfDay(now);
  if (!activeSet.has(dayKey(st))) st = startOfDay(st - H);
  for (; activeSet.has(dayKey(st)); st = startOfDay(st - H)) streak++;
  let longest = 0, run = 0, prev = null;
  for (const k of dayKeys) { run = prev !== null && k - prev <= DAY + H ? run + 1 : 1; longest = Math.max(longest, run); prev = k; }

  return {
    metric, recs, totals, sessions, prompts, activeDays, days,
    models: [...models.entries()].map(([id, v]) => ({ id, info: modelInfo(id), ...v })).sort((a, b) => val(b) - val(a)),
    projects: [...projects.values()].map((p) => ({ ...p, sessions: p.sessions.size })).sort((a, b) => val(b) - val(a)),
    heat, tools: [...tools.entries()].sort((a, b) => b[1] - a[1]),
    compare, selected,
    limits: { blocks, current, peakBlock, weekStart: ws, weekVal, peakWeek, weekEnd: weeklyReset ? ws + 7 * DAY : null },
    streak, longest,
    medianActive: median(sessions.map((s) => s.active)),
    medianPrompts: median(sessions.map((s) => s.prompts)),
  };
}
