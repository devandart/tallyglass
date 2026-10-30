// SPDX-License-Identifier: GPL-3.0-or-later
// Synthetic transcripts in the same shape parse.js produces, so the site can be tried without data.

function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECTS = [
  ['/Users/demo/code/web-shop', 6], ['/Users/demo/code/api-gateway', 4], ['/Users/demo/code/mobile-app', 3],
  ['/Users/demo/code/data-pipeline', 2], ['/Users/demo/code/infra', 2], ['/Users/demo/notes', 1], ['/Users/demo/code/game-jam', 1],
];
const TITLES = [
  'Fix checkout rounding bug', 'Add OAuth login flow', 'Refactor order service', 'Write migration for invoices', 'Speed up CI pipeline',
  'Investigate memory leak', 'Implement search filters', 'Add dark mode', 'Upgrade to React 19', 'Review PR feedback',
  'Set up Terraform modules', 'Debug flaky e2e test', 'Add CSV export', 'Design rate limiter', 'Write onboarding docs',
  'Port parser to Rust', 'Add push notifications', 'Clean up logging', 'Fix timezone handling', 'Build admin dashboard',
];
const TOOLS = [['Read', 30], ['Bash', 24], ['Edit', 18], ['Grep', 12], ['Glob', 6], ['Write', 5], ['TodoWrite', 3], ['WebSearch', 1], ['Agent', 1]];
const uuid = (r) => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const v = (r() * 16) | 0;
  return (c === 'x' ? v : (v & 3) | 8).toString(16);
});
const pick = (r, weighted) => {
  const total = weighted.reduce((a, w) => a + w[1], 0);
  let x = r() * total;
  for (const w of weighted) if ((x -= w[1]) < 0) return w[0];
  return weighted[0][0];
};

export function demoResults(now = Date.now()) {
  const r = rng(42);
  const out = [];
  const DAY = 864e5;
  for (let day = 75; day >= 0; day--) {
    const date = new Date(now - day * DAY);
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    if (r() < (weekend ? 0.6 : 0.12) && day > 0) continue;
    const count = day === 0 ? 2 : 1 + Math.floor(r() * (weekend ? 2 : 4));
    for (let k = 0; k < count; k++) {
      const sid = uuid(r);
      const cwd = pick(r, PROJECTS);
      const start = new Date(date);
      const isToday = day === 0;
      start.setHours(isToday ? Math.max(0, new Date(now).getHours() - 2 + k) : 9 + Math.floor(r() * 11), Math.floor(r() * 60), 0, 0);
      let t = Math.min(start.getTime(), now - 50 * 60e3 * (count - k));
      const size = Math.exp(2.5 + r() * 3.2) | 0; // ~12 to ~300 API calls
      const model = r() < 0.08 ? 'claude-fable-5-1' : r() < 0.15 ? 'claude-sonnet-5-5' : 'claude-opus-5-5';
      let ctx = 18000 + r() * 8000;
      const recs = [];
      let prompts = 1;
      for (let j = 0; j < size; j++) {
        t += (r() < 0.12 ? 60 + r() * 400 : 4 + r() * 25) * 1000;
        if (t > now) break;
        if (r() < 0.1) prompts++;
        const out = 80 + Math.floor(r() * r() * 3000);
        const write = Math.floor(400 + r() * 6000);
        if (ctx > 160000 + r() * 200000) ctx = 30000 + r() * 10000; // compaction
        const tools = r() < 0.75 ? [pick(r, TOOLS)] : undefined;
        recs.push({ k: `${sid}:${j}`, t: Math.floor(t), m: model, i: 2 + Math.floor(r() * 8), o: out, c5: 0, c1: write, r: Math.floor(ctx), w: 0, f: 0, s: 0, tl: tools });
        ctx += write + out * 0.6;
      }
      if (!recs.length) continue;
      out.push({ cls: { sessionId: sid, isSub: false, projectDir: cwd.replace(/\//g, '-') }, result: {
        info: { customTitle: TITLES[Math.floor(r() * TITLES.length)], agentName: null, aiTitle: null, summary: null,
          firstPrompt: null, prompts, cwd, entrypoint: r() < 0.6 ? 'cli' : 'claude-desktop', version: '2.1.309', gitBranch: 'main',
          firstTs: recs[0].t, lastTs: recs[recs.length - 1].t },
        records: recs,
      } });
      // Some sessions spawn subagents on Haiku.
      if (r() < 0.35) {
        const n = 10 + Math.floor(r() * 50);
        const sub = [];
        let st = recs[Math.floor(recs.length / 2)].t;
        for (let j = 0; j < n && st < now; j++) {
          st += 3000 + r() * 8000;
          sub.push({ k: `${sid}:sub${j}`, t: Math.floor(st), m: 'claude-haiku-4-5', i: 3, o: 200 + Math.floor(r() * 900), c5: 0, c1: 1500, r: 12000 + j * 2500, w: 0, f: 0, s: 1, tl: [pick(r, TOOLS.slice(0, 5))] });
        }
        if (sub.length) out.push({ cls: { sessionId: sid, isSub: true, projectDir: '' }, result: {
          info: { customTitle: null, agentName: null, aiTitle: null, summary: null, firstPrompt: null, prompts: 0, cwd, entrypoint: null,
            version: null, gitBranch: null, firstTs: sub[0].t, lastTs: sub[sub.length - 1].t },
          records: sub,
        } });
      }
    }
  }
  return out;
}
