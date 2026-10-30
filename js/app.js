// SPDX-License-Identifier: GPL-3.0-or-later
import { buildDataset, analyze, BLOCK_MS } from './model.js?v=6';
import { modelInfo } from './pricing.js?v=6';
import { demoResults } from './demo.js?v=6';
import * as src from './sources.js?v=6';

const $ = (id) => document.getElementById(id);
const H = 3600e3, DAY = 24 * H;

// ---- Preferences ------------------------------------------------------------

const PREFS_KEY = 'tallyglass-prefs';
const prefs = Object.assign(
  { range: 30, metric: 'tok', theme: null, limits: { tok: { block: null, week: null }, cost: { block: null, week: null } }, weeklyReset: null },
  (() => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } })(),
);
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };

const state = { savedHandle: null, ds: null, demo: false, selectedId: null, sort: { key: 'lastTs', dir: -1 }, query: '', shown: 25, a: null, scanning: false };

// ---- Formatting -------------------------------------------------------------

function compact(n) {
  const a = Math.abs(n);
  for (const [v, u] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (a >= v) {
      const x = n / v;
      const s = x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2);
      return (s.includes('.') ? s.replace(/\.?0+$/, '') : s) + u;
    }
  }
  return String(Math.round(n));
}
function usd(n) {
  if (n > 0 && n < 0.01) return '<$0.01';
  if (n < 100) return '$' + n.toFixed(2);
  if (n < 10000) return '$' + Math.round(n).toLocaleString('en-US');
  return '$' + compact(n);
}
const fmt = (v, metric = prefs.metric) => (metric === 'tok' ? compact(v) : usd(v));
const pct = (x) => (x >= 0.995 || x === 0 ? Math.round(x * 100) : x < 0.01 ? (x * 100).toFixed(1) : Math.round(x * 100)) + '%';
function dur(ms) {
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
function when(t) {
  const d = Date.now() - t;
  if (d < 60e3) return 'just now';
  if (d < H) return `${Math.round(d / 60e3)}m ago`;
  if (d < DAY) return `${Math.round(d / H)}h ago`;
  if (d < 7 * DAY) return `${Math.round(d / DAY)}d ago`;
  return dateFmt.format(t);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const metricName = () => (prefs.metric === 'tok' ? 'tokens' : 'API cost');

// ---- Colors -----------------------------------------------------------------

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function modelColor(id) {
  const i = state.ds.modelOrder.indexOf(id);
  return i >= 0 && i < 7 ? css(`--series-${i + 1}`) : css('--other');
}

// ---- Views ------------------------------------------------------------------

function show(view) {
  for (const v of ['landing', 'progress', 'dash']) $(v).hidden = v !== view;
  $('controls').hidden = view !== 'dash';
}

function applyTheme() {
  if (prefs.theme) document.documentElement.dataset.theme = prefs.theme;
  else delete document.documentElement.dataset.theme;
}

function setPressed(groupId, value) {
  for (const b of $(groupId).querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.v === String(value)));
}

// ---- Loading data -----------------------------------------------------------

function useResults(results, { demo = false } = {}) {
  state.ds = buildDataset(results);
  state.demo = demo;
  $('demoBadge').hidden = !demo;
  $('rescan').hidden = demo;
  if (!state.ds.records.length) {
    show('landing');
    alert('No Claude Code usage found in that folder. Pick the "projects" folder inside ".claude".');
    return;
  }
  show('dash');
  render();
}

// Workers report progress many times per frame; only the latest state gets drawn.
// A timer rather than requestAnimationFrame, so it keeps updating in a background tab.
let pendingProgress = null;
function setProgress(title, frac, text) {
  if (!pendingProgress) setTimeout(() => { drawProgress(...pendingProgress); pendingProgress = null; }, 50);
  pendingProgress = [title, frac, text];
}
function drawProgress(title, frac, text) {
  $('progTitle').textContent = title;
  $('progBar').parentElement.classList.toggle('indeterminate', frac === null);
  $('progBar').style.width = frac === null ? '' : `${(frac * 100).toFixed(1)}%`;
  $('progText').textContent = text;
}

// getFiles(onFound) collects the transcripts; the progress view shows from the start,
// because walking a large .claude folder takes a while before parsing even begins.
async function runScan(getFiles) {
  if (state.scanning) return;
  state.scanning = true;
  const bigScan = !state.ds;
  const label = $('rescan').textContent;
  try {
    if (bigScan) {
      show('progress');
      setProgress('Looking for transcripts…', null, 'Searching the folder');
    } else $('rescan').textContent = 'Searching…';
    const files = await getFiles((n) => {
      if (bigScan) setProgress('Looking for transcripts…', null, `${n.toLocaleString()} transcript files found so far`);
    });
    if (!files.length) throw new Error('No Claude Code transcripts (.jsonl) found there. Pick the "projects" folder inside ".claude".');

    const t0 = performance.now();
    const results = await src.scan(files, (p) => {
      const frac = p.totalBytes ? p.doneBytes / p.totalBytes : 1;
      if (!bigScan) {
        $('rescan').textContent = p.totalFiles ? `Scanning ${Math.round(frac * 100)}%` : 'Scanning…';
        return;
      }
      if (!p.totalFiles) {
        setProgress('Loading…', 1, `All ${p.cached.toLocaleString()} files unchanged since the last scan`);
        return;
      }
      const secs = (performance.now() - t0) / 1000;
      const rate = p.doneBytes / Math.max(secs, 0.001);
      const left = rate > 0 ? (p.totalBytes - p.doneBytes) / rate : 0;
      const eta = secs < 3 ? 'estimating time left…' : left < 60 ? 'less than a minute left' : `about ${Math.ceil(left / 60)} min left`;
      setProgress(`Reading transcripts… ${Math.floor(frac * 100)}%`, frac,
        `${p.doneFiles.toLocaleString()} of ${p.totalFiles.toLocaleString()} files · ${compact(p.doneBytes)}B of ${compact(p.totalBytes)}B · ${compact(rate)}B/s · ${eta}` +
        (p.cached ? ` · ${p.cached.toLocaleString()} unchanged since last scan` : ''));
    });
    if (bigScan) setProgress('Building dashboard…', 1, `${results.length.toLocaleString()} transcripts read`);
    await new Promise((r) => setTimeout(r, 30)); // let the message paint
    useResults(results);
  } catch (e) {
    if (bigScan) show('landing');
    if (e.name !== 'AbortError') alert(e.message || String(e));
  } finally {
    state.scanning = false;
    $('rescan').textContent = label;
  }
}

async function pickAndScan() {
  if (src.canPickDirectory) {
    let handle;
    try { handle = await src.pickDirectory(); } catch (e) { if (e.name !== 'AbortError') alert(e.message); return; }
    state.savedHandle = handle;
    runScan((onFound) => src.filesFromHandle(handle, onFound));
  } else {
    $('dirInput').click();
  }
}

// ---- The landing page's play button ------------------------------------------
// Browsers can't open a folder by path, so the first time the button copies the default
// path and opens the folder dialog with paste instructions. Chrome and Edge then remember
// the folder, and the button scans it directly.

const OS = (() => {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '').toLowerCase();
  return p.includes('win') ? 'win' : p.includes('mac') ? 'mac' : /linux|x11|cros/.test(p) ? 'linux' : 'other';
})();
const DEFAULT_PATH = OS === 'win' ? '%USERPROFILE%\\.claude\\projects' : '~/.claude/projects';
const k = (...keys) => keys.map((x) => `<kbd>${x}</kbd>`).join('+');
const PASTE_KEYS = {
  win: `${k('Ctrl', 'L')}, then ${k('Ctrl', 'V')} and ${k('Enter')}`,
  linux: `${k('Ctrl', 'L')}, then ${k('Ctrl', 'V')} and ${k('Enter')}`,
  mac: `${k('⌘', '⇧', 'G')}, then ${k('⌘', 'V')} and ${k('Return')}`,
  other: 'paste it into the location field',
};
const OS_NAME = { win: 'Windows', mac: 'macOS', linux: 'Linux', other: '' }[OS];

function renderPick(copied) {
  const remembered = !!state.savedHandle;
  $('pickPath').textContent = remembered ? `${state.savedHandle.name} · remembered folder` : `${OS_NAME ? OS_NAME + ' · ' : ''}${DEFAULT_PATH}`;
  const confirmStep = src.canPickDirectory ? '“Select Folder” and allow access with “View files”' : '“Upload” (nothing is uploaded)';
  $('pickSteps').innerHTML = remembered
    ? `<li>Click ▶ and allow access. No folder dialog needed.</li>`
    : `<li>${copied ? '<span class="ok">✓ Folder path copied.</span> ' : ''}Click ▶: the folder path is copied and a folder dialog opens.</li>
       <li>In the dialog press ${PASTE_KEYS[OS]} to jump to the folder.</li>
       <li>Confirm with ${confirmStep}.</li>`;
  $('pickSteps').classList.toggle('active', !!copied);
}

// Synchronous copy, so the folder dialog can still open from the same click.
function copyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
  ta.remove();
  return ok;
}

async function startScan() {
  const h = state.savedHandle;
  if (h) {
    let perm = 'denied';
    try { perm = await h.requestPermission({ mode: 'read' }); } catch { /* handle no longer valid */ }
    if (perm === 'granted') return runScan((onFound) => src.filesFromHandle(h, onFound));
    state.savedHandle = null;
    renderPick(false);
    return;
  }
  renderPick(copyText(DEFAULT_PATH));
  pickAndScan();
}

async function rescan() {
  if (src.canPickDirectory) {
    const h = await src.savedDirectory({ prompt: true }).catch(() => null);
    if (h) return runScan((onFound) => src.filesFromHandle(h, onFound));
  }
  pickAndScan();
}

// ---- Charts -----------------------------------------------------------------

const charts = {};
function chart(id, config) {
  charts[id]?.destroy();
  const C = window.Chart;
  if (!C) return;
  C.defaults.font.family = css('--font') || 'system-ui';
  C.defaults.font.size = 12;
  C.defaults.color = css('--text-2');
  charts[id] = new C($(id), config);
}
function baseOptions(extra = {}) {
  const grid = css('--grid');
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    plugins: {
      legend: { display: false },
      tooltip: { backgroundColor: css('--text'), titleColor: css('--bg'), bodyColor: css('--bg'), footerColor: css('--bg'), padding: 9, cornerRadius: 7, boxPadding: 4, usePointStyle: true },
    },
    scales: {
      x: { grid: { display: false }, border: { color: grid }, ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 12 } },
      y: { grid: { color: grid }, border: { display: false }, ticks: { callback: (v) => fmt(v), maxTicksLimit: 6 }, beginAtZero: true },
    },
    ...extra,
  };
}

function legend(el, items) {
  $(el).innerHTML = items.map((i) => `<span><i class="sw${i.dash ? ' dash' : ''}" style="${i.dash ? '' : `background:${i.color}`}"></i>${esc(i.label)}</span>`).join('');
}

// ---- Render -----------------------------------------------------------------

function sinceFor(range) {
  if (!range) return 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (range - 1));
  return d.getTime();
}

function render() {
  if (!state.ds) return;
  setPressed('range', prefs.range);
  setPressed('metric', prefs.metric);
  const a = analyze(state.ds, { since: sinceFor(prefs.range), metric: prefs.metric, selectedId: state.selectedId, weeklyReset: prefs.weeklyReset });
  state.a = a;
  renderKpis(a);
  renderLimits(a);
  renderCompare(a);
  renderDaily(a);
  renderRank(a);
  renderCtx(a);
  renderBlocks(a);
  renderHeat(a);
  renderProjects(a);
  renderModels(a);
  renderMix(a);
  renderInsights(a);
  renderTools(a);
  renderTable(a);
}

const val = (x) => x[prefs.metric];
const sval = (s) => (prefs.metric === 'tok' ? s.tok : s.cost);

function renderKpis(a) {
  const t = a.totals;
  const median = (arr) => { const s = [...arr].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  const projects = new Set(a.sessions.map((s) => s.projectKey)).size;
  const tiles = [
    ['Sessions', a.sessions.length.toLocaleString(), `${projects} project${projects === 1 ? '' : 's'}`],
    ['Tokens', compact(t.tok), `${pct(t.tok ? t.r / t.tok : 0)} cache reads`],
    ['API-equivalent cost', usd(t.cost), `${usd(a.activeDays ? t.cost / a.activeDays : 0)} per active day`],
    ['Prompts', a.prompts.toLocaleString(), `${t.msgs.toLocaleString()} API calls`],
    ['Active days', String(a.activeDays), a.streak ? `${a.streak}-day streak` : `longest streak ${a.longest}d`],
    ['Median session', fmt(median(a.sessions.map(sval))), `${dur(a.medianActive)} active`],
  ];
  $('kpis').innerHTML = tiles.map(([l, v, d]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="d">${esc(d)}</div></div>`).join('');
}

function meterClass(p) { return p >= 0.9 ? 'crit' : p >= 0.7 ? 'warn' : ''; }
// With an automatic budget (your previous peak), going past it is a new record, not an overrun.
function statusBadge(p, auto) {
  if (p >= 1 && auto) return `<span class="status" style="color:var(--serious)">▲ Above your previous peak</span>`;
  if (p >= 1) return `<span class="status" style="color:var(--critical)">▲ Over your budget</span>`;
  if (p >= 0.9) return `<span class="status" style="color:var(--critical)">▲ Almost at budget</span>`;
  if (p >= 0.7) return `<span class="status" style="color:var(--serious)">● Getting close</span>`;
  return `<span class="status" style="color:var(--good)">✓ Plenty left</span>`;
}

function renderLimits(a) {
  const L = a.limits, m = prefs.metric, now = Date.now();
  const lim = prefs.limits[m];
  const budget5 = lim.block ?? (L.peakBlock ? val(L.peakBlock) : 0);
  const budgetW = lim.week ?? L.peakWeek;
  const unit = m === 'tok' ? 'M tokens' : 'USD';
  const toInput = (v) => (v == null ? '' : m === 'tok' ? +(v / 1e6).toFixed(2) : +v.toFixed(2));

  let win;
  if (L.current) {
    const c = L.current, used = val(c);
    const p = budget5 ? used / budget5 : 0;
    const hrs = Math.max(0.25, (now - c.first) / H);
    const rate = used / hrs;
    const projected = used + (rate * (c.end - now)) / H;
    const left = Math.max(0, budget5 - used);
    const hitAt = rate > 0 && left > 0 ? now + (left / rate) * H : null;
    win = `
      <h4>5-hour window <span class="pill on">Active</span></h4>
      <div class="big-num">${fmt(used)} <small>of ~${fmt(budget5)}</small></div>
      <div class="meter ${meterClass(p)}"><div style="width:${Math.min(100, p * 100)}%"></div></div>
      ${statusBadge(p, lim.block == null)}
      <dl>
        <dt>Left (est.)</dt><dd><b>${fmt(left)}</b> · ${pct(budget5 ? left / budget5 : 0)}</dd>
        <dt>Resets</dt><dd><b>${timeFmt.format(c.end)}</b> · in ${dur(c.end - now)}</dd>
        <dt>Burn rate</dt><dd>${fmt(rate)} / hour</dd>
        <dt>At this pace</dt><dd>${hitAt && hitAt < c.end ? `budget reached ~${timeFmt.format(hitAt)}` : `${fmt(projected)} by reset`}</dd>
      </dl>`;
  } else {
    const lastEnd = L.blocks.length ? L.blocks[L.blocks.length - 1].end : null;
    win = `
      <h4>5-hour window <span class="pill">Idle</span></h4>
      <div class="big-num">${fmt(budget5)} <small>available</small></div>
      <div class="meter"><div style="width:0"></div></div>
      <span class="status" style="color:var(--good)">✓ Full window available</span>
      <dl>
        <dt>Starts</dt><dd>with your next message</dd>
        <dt>Then resets</dt><dd>5 hours later</dd>
        ${lastEnd ? `<dt>Last window ended</dt><dd>${when(lastEnd)}</dd>` : ''}
      </dl>`;
  }

  const pw = budgetW ? L.weekVal / budgetW : 0;
  const week = `
    <h4>This week <span class="pill">${L.weekEnd ? 'fixed reset' : 'rolling 7 days'}</span></h4>
    <div class="big-num">${fmt(L.weekVal)} <small>of ~${fmt(budgetW)}</small></div>
    <div class="meter ${meterClass(pw)}"><div style="width:${Math.min(100, pw * 100)}%"></div></div>
    ${statusBadge(pw, lim.week == null)}
    <dl>
      <dt>Left (est.)</dt><dd><b>${fmt(Math.max(0, budgetW - L.weekVal))}</b></dd>
      ${L.weekEnd ? `<dt>Resets</dt><dd><b>${dateTimeFmt.format(L.weekEnd)}</b> · in ${dur(L.weekEnd - now)}</dd>` : `<dt>Window</dt><dd>since ${dateTimeFmt.format(L.weekStart)}</dd>`}
      <dt>Your busiest week</dt><dd>${fmt(L.peakWeek)}</dd>
    </dl>`;

  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const r = prefs.weeklyReset;
  $('limitsCard').innerHTML = `
    <header class="card-h"><h3>Usage limits</h3><span class="sub">Estimated from your own history</span></header>
    <div class="lim-row"><div class="lim">${win}</div><div class="lim">${week}</div></div>
    <p class="lim-note">Anthropic doesn't publish plan limits as token counts, so budgets default to your busiest 5-hour window and week so far${lim.block != null || lim.week != null ? ' (or your custom values)' : ''}. Run <code>/usage</code> in Claude Code for the official numbers.</p>
    <details class="settings">
      <summary>Set your own budgets</summary>
      <div class="fields">
        <label>5-hour budget (${unit})<input type="number" min="0" step="any" id="b5" placeholder="${toInput(L.peakBlock ? val(L.peakBlock) : 0)} (auto)" value="${toInput(lim.block)}"></label>
        <label>Weekly budget (${unit})<input type="number" min="0" step="any" id="bw" placeholder="${toInput(L.peakWeek)} (auto)" value="${toInput(lim.week)}"></label>
        <label>Weekly reset day<select id="rd"><option value="">Rolling 7 days</option>${days.map((d, i) => `<option value="${(i + 1) % 7}" ${r && r.day === (i + 1) % 7 ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label>Reset hour<select id="rh" ${r ? '' : 'disabled'}>${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${r && r.hour === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
      </div>
    </details>`;

  const fromInput = (v) => (v === '' ? null : m === 'tok' ? +v * 1e6 : +v);
  $('b5').onchange = (e) => { lim.block = fromInput(e.target.value); savePrefs(); renderLimits(state.a); renderBlocks(state.a); };
  $('bw').onchange = (e) => { lim.week = fromInput(e.target.value); savePrefs(); renderLimits(state.a); };
  const onReset = () => {
    const d = $('rd').value;
    prefs.weeklyReset = d === '' ? null : { day: +d, hour: +$('rh').value };
    savePrefs();
    render();
    $('limitsCard').querySelector('details').open = true;
  };
  $('rd').onchange = onReset;
  $('rh').onchange = onReset;
}

function sessionOption(s) {
  return `${s.label.slice(0, 70)} — ${s.project} · ${dateFmt.format(s.lastTs)}`;
}

function renderCompare(a) {
  const c = a.compare;
  if (!c) { $('compareCard').innerHTML = '<p class="empty">No sessions.</p>'; return; }
  const s = c.session;
  const sorted = [...state.ds.sessions].sort((x, y) => y.lastTs - x.lastTs);
  const latest = sorted[0];
  const rows = [
    ['This session', c.value, true], ['Median session', c.median], ['Average session', c.avg], ['Largest session', c.max],
  ];
  const maxv = Math.max(...rows.map((r) => r[1]), 1);
  const top = c.rank ? Math.max(1, 100 - c.percentile) : null;
  $('compareCard').innerHTML = `
    <header class="card-h"><h3>${s === latest ? 'Latest session' : 'Selected session'} vs. others</h3><span class="sub">${prefs.range ? `Compared with sessions in the last ${prefs.range} days` : 'Compared with all sessions'}</span></header>
    <div class="compare"><select id="sessPick" aria-label="Choose a session">${sorted.map((x) => `<option value="${x.id}" ${x === s ? 'selected' : ''}>${esc(sessionOption(x))}</option>`).join('')}</select></div>
    <div class="cmp-head">
      <div><span class="l">${prefs.metric === 'tok' ? 'Tokens' : 'API cost'}</span><span class="v">${fmt(c.value)}</span></div>
      <div><span class="l">Rank</span><span class="v">${c.rank ? `#${c.rank}<small class="muted" style="font-size:14px;font-weight:500"> of ${c.of}</small>` : '—'}</span></div>
      <div><span class="l">Bigger than</span><span class="v">${c.rank ? `${c.percentile}%` : '—'}</span></div>
      <div><span class="l">vs. median</span><span class="v">${c.median ? `${c.xMedian >= 10 ? Math.round(c.xMedian) : c.xMedian.toFixed(1)}×` : '—'}</span></div>
    </div>
    <div class="cmp-bars">
      ${rows.map(([l, v, me]) => `<span>${l}</span><div class="track"><div class="fill${me ? ' me' : ''}" style="width:${(v / maxv) * 100}%"></div></div><span class="val">${fmt(v)}</span>`).join('')}
    </div>
    <div class="cmp-meta">
      <span>${esc(s.project)}</span>
      <span>${s.firstTs ? dateTimeFmt.format(s.firstTs) : ''} → ${when(s.lastTs)}</span>
      <span>${dur(s.active)} active</span>
      <span>${s.prompts} prompts · ${s.msgs} API calls</span>
      ${s.subagents ? `<span>${s.subagents} subagent${s.subagents === 1 ? '' : 's'} (${pct(s.tok ? s.subTok / s.tok : 0)} of tokens)</span>` : ''}
      <span>${compact(s.tok)} tokens · ${usd(s.cost)}</span>
      ${s.mainModel ? `<span>${modelInfo(s.mainModel).label}</span>` : ''}
      ${c.rank ? `<span>${top <= 50 ? `Top ${top}%` : `Bottom ${100 - top + 1}%`} · ${pct(c.share)} of ${metricName()} in range</span>` : '<span>Not active in the selected range</span>'}
    </div>`;
  $('sessPick').onchange = (e) => { state.selectedId = e.target.value; render(); };
}

function renderDaily(a) {
  const present = new Map();
  for (const d of a.days) for (const [m, v] of d.byModel) present.set(m, (present.get(m) || 0) + v);
  const order = state.ds.modelOrder.filter((m) => present.has(m));
  const shown = order.filter((m) => state.ds.modelOrder.indexOf(m) < 7);
  const other = order.filter((m) => !shown.includes(m));
  const series = shown.map((m) => ({ label: modelInfo(m).label, color: modelColor(m), get: (d) => d.byModel.get(m) || 0 }));
  if (other.length) series.push({ label: 'Other', color: css('--other'), get: (d) => other.reduce((s, m) => s + (d.byModel.get(m) || 0), 0) });
  legend('dailyLegend', series.length > 1 ? series : []);
  const total = a.days.reduce((s, d) => s + val(d), 0);
  const active = a.days.filter((d) => val(d) > 0).length;
  $('dailySub').textContent = `${fmt(total)} total · ${fmt(active ? total / active : 0)} per active day`;
  const surface = css('--surface');
  chart('dailyChart', {
    type: 'bar',
    data: {
      labels: a.days.map((d) => dateFmt.format(d.t)),
      datasets: series.map((s) => ({ label: s.label, data: a.days.map(s.get), backgroundColor: s.color, borderColor: surface, borderWidth: { top: 1.5 }, borderRadius: 3, borderSkipped: 'bottom', stack: 's', maxBarThickness: 28 })),
    },
    options: baseOptions({
      interaction: { mode: 'index', intersect: false },
      plugins: {
        ...baseOptions().plugins,
        tooltip: { ...baseOptions().plugins.tooltip, filter: (i) => i.raw > 0,
          callbacks: { label: (i) => ` ${i.dataset.label}: ${fmt(i.raw)}`, footer: (items) => (items.length > 1 ? `Total: ${fmt(items.reduce((s, i) => s + i.raw, 0))}` : '') } },
      },
      scales: { ...baseOptions().scales, x: { ...baseOptions().scales.x, stacked: true }, y: { ...baseOptions().scales.y, stacked: true } },
    }),
  });
}

function renderRank(a) {
  const sel = a.compare?.session;
  const list = a.sessions;
  const me = css('--series-2'), others = css('--series-1');
  chart('rankChart', {
    type: 'bar',
    data: {
      labels: list.map((s) => s.label),
      datasets: [{ data: list.map((s) => Math.max(sval(s), prefs.metric === 'tok' ? 1 : 0.001)), backgroundColor: list.map((s) => (s === sel ? me : others)),
        categoryPercentage: 1, barPercentage: list.length > 80 ? 1 : 0.85, maxBarThickness: 36, borderRadius: list.length > 80 ? 0 : 2, minBarLength: 2 }],
    },
    options: baseOptions({
      onClick: (_, els) => { if (els[0]) { state.selectedId = list[els[0].index].id; render(); } },
      onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
      plugins: {
        ...baseOptions().plugins,
        tooltip: { ...baseOptions().plugins.tooltip, callbacks: {
          title: (i) => list[i[0].dataIndex].label.slice(0, 60),
          label: (i) => ` #${i.dataIndex + 1} · ${fmt(sval(list[i.dataIndex]))} · ${list[i.dataIndex].project}`,
        } },
      },
      scales: { x: { display: false }, y: { ...baseOptions().scales.y, type: 'logarithmic', beginAtZero: false, ticks: { callback: (v) => (/^(1|3)/.test(String(v)) ? fmt(v) : ''), maxTicksLimit: 8 } } },
    }),
  });
}

function renderCtx(a) {
  const c = a.compare;
  const pts = c ? c.ctx : [];
  $('ctxSub').textContent = pts.length ? `Peak ${compact(c.peakCtx)} tokens · ${pts.length} turns` : '';
  chart('ctxChart', {
    type: 'line',
    data: {
      labels: pts.map((_, i) => i + 1),
      datasets: [{ data: pts.map((p) => p.ctx), borderColor: css('--series-2'), backgroundColor: css('--series-2') + '22', fill: 'origin', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.15 }],
    },
    options: baseOptions({
      interaction: { mode: 'index', intersect: false },
      plugins: {
        ...baseOptions().plugins,
        tooltip: { ...baseOptions().plugins.tooltip, callbacks: { title: (i) => `Turn ${i[0].label} · ${dateTimeFmt.format(pts[i[0].dataIndex].t)}`, label: (i) => ` Context: ${compact(i.raw)} tokens` } },
      },
      scales: { x: { ...baseOptions().scales.x, ticks: { ...baseOptions().scales.x.ticks, maxTicksLimit: 8 } }, y: { ...baseOptions().scales.y, ticks: { callback: (v) => compact(v), maxTicksLimit: 6 } } },
    }),
  });
}

function renderBlocks(a) {
  const L = a.limits;
  const blocks = L.blocks.slice(-30);
  const lim = prefs.limits[prefs.metric];
  const budget = lim.block ?? (L.peakBlock ? val(L.peakBlock) : 0);
  const cur = css('--series-2'), past = css('--series-1');
  legend('blocksLegend', [{ label: 'Past windows', color: past }, { label: 'Current', color: cur }, { label: 'Budget', dash: true }]);
  $('blocksSub').textContent = `Last ${blocks.length} windows`;
  chart('blocksChart', {
    data: {
      labels: blocks.map((b) => dateTimeFmt.format(b.start)),
      datasets: [
        { type: 'bar', data: blocks.map(val), backgroundColor: blocks.map((b) => (b === L.current ? cur : past)), borderRadius: 3, maxBarThickness: 26, order: 2 },
        { type: 'line', data: blocks.map(() => budget), borderColor: css('--text-2'), borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 0, order: 1 },
      ],
    },
    options: baseOptions({
      plugins: {
        ...baseOptions().plugins,
        tooltip: { ...baseOptions().plugins.tooltip, filter: (i) => i.datasetIndex === 0, callbacks: {
          title: (i) => { const b = blocks[i[0].dataIndex]; return `${dateTimeFmt.format(b.start)} – ${timeFmt.format(b.end)}`; },
          label: (i) => { const b = blocks[i.dataIndex]; return ` ${fmt(i.raw)} · ${budget ? pct(i.raw / budget) : ''} of budget · ${b.n} calls`; },
        } },
      },
      scales: { ...baseOptions().scales, x: { ...baseOptions().scales.x, ticks: { ...baseOptions().scales.x.ticks, maxTicksLimit: 6 } } },
    }),
  });
}

function renderHeat(a) {
  const max = Math.max(...a.heat.flat(), 0);
  const steps = [1, 2, 3, 4, 5, 6, 7].map((i) => `var(--seq-${i})`);
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let html = '<span></span>' + Array.from({ length: 24 }, (_, h) => `<span class="hl">${h % 3 === 0 ? h : ''}</span>`).join('');
  a.heat.forEach((row, d) => {
    html += `<span class="dl">${days[d]}</span>`;
    row.forEach((v, h) => {
      const bg = v > 0 ? steps[Math.min(6, Math.floor(Math.sqrt(v / max) * 7))] : '';
      html += `<span class="c" style="${bg ? `background:${bg}` : ''}" data-tip="${days[d]} ${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00<br><b>${fmt(v)}</b>"></span>`;
    });
  });
  $('heat').innerHTML = html;
  $('heatScale').innerHTML = `<span>Less</span>${steps.map((s) => `<i style="background:${s}"></i>`).join('')}<span>More</span>`;
}

function barList(el, items, { color } = {}) {
  if (!items.length) { $(el).innerHTML = '<p class="empty">Nothing in this range.</p>'; return; }
  const max = Math.max(...items.map((i) => i.v), 1e-9);
  $(el).innerHTML = items.map((i) => `
    <div class="bar-row" data-tip="${esc(i.tip || i.label)}">
      <div class="name">${i.color ? `<i class="sw" style="background:${i.color}"></i>` : ''}<span>${esc(i.label)}</span></div>
      <div class="val">${i.text}</div>
      <div class="track"><div style="width:${(i.v / max) * 100}%;background:${i.color || color || 'var(--series-1)'}"></div></div>
    </div>`).join('');
}

function renderProjects(a) {
  const total = val(a.totals) || 1;
  barList('projects', a.projects.slice(0, 8).map((p) => ({
    label: p.label, v: val(p), text: `${fmt(val(p))} · ${pct(val(p) / total)}`,
    tip: `${p.path || p.label} · ${p.sessions} session${p.sessions === 1 ? '' : 's'} · ${compact(p.tok)} tokens · ${usd(p.cost)}`,
  })));
}

function renderModels(a) {
  const total = val(a.totals) || 1;
  barList('models', a.models.slice(0, 8).map((m) => ({
    label: m.info.label + (m.info.estimated || m.info.unpriced ? ' *' : ''), v: val(m), color: modelColor(m.id), text: `${fmt(val(m))} · ${pct(val(m) / total)}`,
    tip: `${m.id} · ${m.msgs.toLocaleString()} calls · ${compact(m.tok)} tokens · ${usd(m.cost)}${m.info.estimated ? ' · price estimated from model family' : m.info.unpriced ? ' · not an Anthropic model, no price' : ''}`,
  })));
}

function renderMix(a) {
  const t = a.totals;
  const cats = [
    ['Input', t.i, t.pc[0]], ['Output', t.o, t.pc[1]], ['Cache write', t.cw, t.pc[2]], ['Cache read', t.r, t.pc[3]],
  ];
  const colors = [1, 2, 3, 4].map((i) => `var(--series-${i})`);
  const stack = (idx, total) => `<div class="stack">${cats.map((c, i) => (c[idx] > 0 ? `<div style="flex:${c[idx] / total};background:${colors[i]}" data-tip="${c[0]}: ${idx === 1 ? compact(c[1]) + ' tokens' : usd(c[2])} · ${pct(c[idx] / total)}"></div>` : '')).join('')}</div>`;
  const costTotal = t.pc.reduce((s, x) => s + x, 0) || 1;
  $('mix').innerHTML = `
    <div class="mix-block"><div class="l">Share of tokens</div>${stack(1, t.tok || 1)}</div>
    <div class="mix-block"><div class="l">Share of API cost</div>${stack(2, costTotal)}</div>
    <div class="mix-legend">
      <span></span><span></span><span class="n muted small">Tokens</span><span class="n muted small">Cost</span>
      ${cats.map((c, i) => `<i class="sw" style="background:${colors[i]}"></i><span>${c[0]}</span><span class="n">${compact(c[1])}</span><span class="n">${usd(c[2])}</span>`).join('')}
    </div>`;
}

function renderTools(a) {
  barList('tools', a.tools.slice(0, 10).map(([name, n]) => ({ label: name.replace(/^mcp__([^_]+)__/, '$1: '), v: n, text: n.toLocaleString(), tip: name })));
}

function renderInsights(a) {
  const t = a.totals, out = [];
  const inputAll = t.i + t.cw + t.r;
  if (t.r > 0) out.push(['⚡', `Prompt caching served <b>${pct(t.r / inputAll)}</b> of input tokens and saved about <b>${usd(t.save)}</b> at API prices.`]);
  if (t.tok && t.o / t.tok < 0.05) out.push(['🔁', `Only <b>${pct(t.o / t.tok)}</b> of tokens are Claude's replies; the rest is context re-read on every turn. Use <code>/clear</code> when you switch tasks and <code>/compact</code> in long sessions.`]);
  if (t.sub[prefs.metric] > 0) out.push(['🤖', `Subagents account for <b>${pct(t.sub[prefs.metric] / val(t))}</b> of ${metricName()}.`]);
  const peak = [...a.days].sort((x, y) => val(y) - val(x))[0];
  if (peak && val(peak) > 0) out.push(['📅', `Busiest day: <b>${dateFmt.format(peak.t)}</b> with <b>${fmt(val(peak))}</b>.`]);
  let bd = 0, bh = 0;
  a.heat.forEach((r, d) => r.forEach((v, h) => { if (v > a.heat[bd][bh]) { bd = d; bh = h; } }));
  if (a.heat[bd][bh] > 0) {
    const wd = weekdayFmt.format(new Date(2024, 0, 1 + bd)); // 2024-01-01 is a Monday
    out.push(['🕑', `You use Claude Code most on <b>${wd}s around ${String(bh).padStart(2, '0')}:00</b>.`]);
  }
  if (a.projects.length > 1) out.push(['📁', `<b>${esc(a.projects[0].label)}</b> is your top project with <b>${pct(val(a.projects[0]) / val(t))}</b> of ${metricName()}.`]);
  const big = a.sessions[0];
  if (big && a.compare?.median) out.push(['🏔️', `Largest session: <b>${esc(big.label.slice(0, 60))}</b> at <b>${fmt(sval(big))}</b>, ${Math.round(sval(big) / a.compare.median)}× the median.`]);
  if (a.sessions.length) out.push(['🧭', `A typical session has <b>${a.medianPrompts}</b> prompt${a.medianPrompts === 1 ? '' : 's'} and <b>${dur(a.medianActive)}</b> of active time.`]);
  if (a.prompts) out.push(['💬', `On average one prompt costs <b>${usd(t.cost / a.prompts)}</b> and <b>${compact(t.tok / a.prompts)}</b> tokens.`]);
  if (a.longest > 1) out.push(['🔥', `Current streak: <b>${a.streak} day${a.streak === 1 ? '' : 's'}</b> (longest: ${a.longest}).`]);
  $('insights').innerHTML = out.map(([ic, s]) => `<li><span class="ic" aria-hidden="true">${ic}</span><span>${s}</span></li>`).join('');
}

const COLS = [
  ['label', 'Session'], ['project', 'Project'], ['lastTs', 'Last active'], ['active', 'Active', 1], ['prompts', 'Prompts', 1],
  ['msgs', 'API calls', 1], ['tok', 'Tokens', 1], ['cost', 'Cost', 1], ['mainModel', 'Model'],
];

function tableRows(a) {
  const q = state.query.toLowerCase();
  const list = q ? a.sessions.filter((s) => `${s.label} ${s.project} ${s.id} ${s.branch || ''}`.toLowerCase().includes(q)) : [...a.sessions];
  const { key, dir } = state.sort;
  list.sort((x, y) => {
    const u = x[key] ?? '', v = y[key] ?? '';
    return (typeof u === 'string' ? u.localeCompare(v) : u - v) * dir;
  });
  return list;
}

function renderTable(a) {
  const list = tableRows(a);
  const sel = a.compare?.session;
  const head = `<thead><tr>${COLS.map(([k, l, num]) => `<th class="${num ? 'num' : ''}" data-k="${k}" ${state.sort.key === k ? `aria-sort="${state.sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${l}</th>`).join('')}</tr></thead>`;
  const body = list.slice(0, state.shown).map((s) => `
    <tr data-id="${s.id}" class="${s === sel ? 'sel' : ''}">
      <td class="title" title="${esc(s.label)}">${esc(s.label.slice(0, 80))}<small>${s.id.slice(0, 8)}</small></td>
      <td>${esc(s.project)}</td>
      <td>${when(s.lastTs)}</td>
      <td class="num">${dur(s.active)}</td>
      <td class="num">${s.prompts}</td>
      <td class="num">${s.msgs.toLocaleString()}</td>
      <td class="num">${compact(s.tok)}</td>
      <td class="num">${usd(s.cost)}</td>
      <td>${s.mainModel ? modelInfo(s.mainModel).label : ''}</td>
    </tr>`).join('');
  $('table').innerHTML = head + `<tbody>${body || `<tr><td colspan="${COLS.length}" class="empty">No sessions match.</td></tr>`}</tbody>`;
  $('more').hidden = list.length <= state.shown;
  $('more').textContent = `Show more (${list.length - state.shown} left)`;
}

function exportCsv() {
  const list = tableRows(state.a);
  const head = ['session_id', 'title', 'project', 'cwd', 'first_active', 'last_active', 'active_minutes', 'prompts', 'api_calls', 'subagents', 'tokens', 'api_cost_usd', 'main_model'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = list.map((s) => [s.id, s.label, s.project, s.cwd, new Date(s.firstTs).toISOString(), new Date(s.lastTs).toISOString(),
    Math.round(s.active / 60e3), s.prompts, s.msgs, s.subagents, s.tok, s.cost.toFixed(4), s.mainModel].map(q).join(','));
  const blob = new Blob([[head.join(','), ...rows].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `claude-code-sessions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- Tooltip for HTML charts -----------------------------------------------

function initTip() {
  const tip = $('tip');
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) { tip.hidden = true; return; }
    tip.innerHTML = el.dataset.tip;
    tip.hidden = false;
  });
  document.addEventListener('mousemove', (e) => {
    if (tip.hidden) return;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.min(window.innerWidth - w - 8, e.clientX + 12)}px`;
    tip.style.top = `${e.clientY - h - 12 < 0 ? e.clientY + 16 : e.clientY - h - 12}px`;
  });
}

// ---- Wiring -----------------------------------------------------------------

function init() {
  applyTheme();
  initTip();

  $('pick').onclick = startScan;
  $('pickOther').onclick = pickAndScan;
  $('change').onclick = pickAndScan;
  renderPick(false);
  for (const row of document.querySelectorAll('.path')) {
    if (row.dataset.os.split(' ').includes(OS)) { row.classList.add('current'); row.parentElement.prepend(row); }
  }
  for (const b of document.querySelectorAll('.copy')) {
    b.onclick = () => {
      b.textContent = copyText($(b.dataset.copy).textContent) ? 'Copied' : 'Select & copy';
      setTimeout(() => (b.textContent = 'Copy'), 1500);
    };
  }
  if (OS === 'mac') {
    $('hiddenTip').hidden = false;
    $('hiddenTip').innerHTML = `On macOS <code>.claude</code> is a hidden folder: ${k('⌘', '⇧', '.')} in the dialog shows hidden folders.`;
  } else if (OS === 'linux') {
    $('hiddenTip').hidden = false;
    $('hiddenTip').innerHTML = `On Linux ${k('Ctrl', 'H')} in the dialog shows hidden folders like <code>.claude</code>.`;
  }
  if (src.canPickDirectory) src.kvGet('dir').then((h) => { if (h && h.requestPermission) { state.savedHandle = h; renderPick(false); } });
  $('dirInput').onchange = (e) => { const f = src.filesFromInput(e.target.files); e.target.value = ''; runScan(async () => f); };
  $('demo').onclick = () => useResults(demoResults(), { demo: true });
  $('rescan').onclick = rescan;
  $('forget').onclick = async () => {
    if (!confirm('Remove the cached scan results from this browser? Your transcript files are not touched.')) return;
    await src.clearCache();
    state.ds = null;
    state.savedHandle = null;
    renderPick(false);
    $('cachedNote').hidden = true;
    show('landing');
  };
  $('theme').onclick = () => {
    const dark = prefs.theme ? prefs.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    prefs.theme = dark ? 'light' : 'dark';
    savePrefs(); applyTheme(); render();
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!prefs.theme) render(); });

  for (const b of $('range').querySelectorAll('button')) b.onclick = () => { prefs.range = +b.dataset.v; savePrefs(); state.shown = 25; render(); };
  for (const b of $('metric').querySelectorAll('button')) b.onclick = () => { prefs.metric = b.dataset.v; savePrefs(); render(); };

  $('table').onclick = (e) => {
    const th = e.target.closest('th');
    if (th) {
      const k = th.dataset.k;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : ['label', 'project', 'mainModel'].includes(k) ? 1 : -1 };
      renderTable(state.a);
      return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) { state.selectedId = tr.dataset.id; render(); $('compareCard').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  };
  $('search').oninput = (e) => { state.query = e.target.value; state.shown = 25; renderTable(state.a); };
  $('more').onclick = () => { state.shown += 50; renderTable(state.a); };
  $('csv').onclick = exportCsv;

  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const items = src.dropEntries(e.dataTransfer); // must be read before the event ends
    runScan((onFound) => src.filesFromDrop(items, onFound));
  });

  // Keep the 5-hour countdown fresh.
  setInterval(() => { if (state.ds && !document.hidden) { state.a = analyze(state.ds, { since: sinceFor(prefs.range), metric: prefs.metric, selectedId: state.selectedId, weeklyReset: prefs.weeklyReset }); renderLimits(state.a); } }, 60e3);

  if (new URLSearchParams(location.search).has('demo')) return useResults(demoResults(), { demo: true });

  // Reopen the last scan instantly, then refresh it if the browser still has folder access.
  src.loadCachedResults().then(async (cached) => {
    if (!cached.length) return;
    useResults(cached);
    const h = src.canPickDirectory ? await src.savedDirectory({ prompt: false }).catch(() => null) : null;
    if (h) runScan((onFound) => src.filesFromHandle(h, onFound));
  });
}

// Chart.js loads with `defer`; module scripts run after it, but guard anyway.
if (window.Chart) init();
else window.addEventListener('load', init);
