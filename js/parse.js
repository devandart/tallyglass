// SPDX-License-Identifier: GPL-3.0-or-later
// Incremental parser for one Claude Code transcript (.jsonl).
// Pure JS (no DOM): runs in a Web Worker and in Node for testing.
//
// Transcripts can be huge (tool results, file contents), so lines are pre-filtered
// with indexOf before JSON.parse. Inside JSON strings quotes are escaped, so an
// unescaped `"type":"assistant"` only appears in real JSON structure.

const TITLE_TYPES = ['"type":"custom-title"', '"type":"agent-name"', '"type":"ai-title"', '"type":"summary"'];
const MAX_USER_LINE = 200_000;

export function createFileParser({ sessionId, isSub }) {
  const msgs = new Map();
  const info = {
    sessionId, isSub,
    customTitle: null, agentName: null, aiTitle: null, summary: null,
    firstPrompt: null, prompts: 0,
    cwd: null, entrypoint: null, version: null, gitBranch: null,
    firstTs: null, lastTs: null,
  };
  let rest = '';

  const touch = (t) => {
    if (!t) return;
    if (info.firstTs === null || t < info.firstTs) info.firstTs = t;
    if (info.lastTs === null || t > info.lastTs) info.lastTs = t;
  };

  function meta(d) {
    if (!info.cwd && d.cwd) info.cwd = d.cwd;
    if (!info.entrypoint && d.entrypoint) info.entrypoint = d.entrypoint;
    if (d.version) info.version = d.version;
    if (!info.gitBranch && d.gitBranch) info.gitBranch = d.gitBranch;
  }

  function assistant(d) {
    const m = d.message;
    if (!m || !m.usage || !m.model || m.model === '<synthetic>') return;
    const u = m.usage;
    const t = Date.parse(d.timestamp);
    if (!t) return;
    meta(d);
    touch(t);
    const k = (m.id || d.uuid) + ':' + (d.requestId || '');
    let tools;
    if (Array.isArray(m.content)) {
      for (const b of m.content) if (b && b.type === 'tool_use' && b.name) (tools ||= []).push(b.name);
    }
    const prev = msgs.get(k);
    if (prev) {
      // Claude Code writes one line per content block; usage repeats, output may grow.
      if ((u.output_tokens || 0) > prev.o) prev.o = u.output_tokens;
      if (tools) prev.tl = prev.tl ? prev.tl.concat(tools) : tools;
      return;
    }
    const cc = u.cache_creation;
    const cw = u.cache_creation_input_tokens || 0;
    const c1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
    msgs.set(k, {
      k, t,
      m: m.model,
      i: u.input_tokens || 0,
      o: u.output_tokens || 0,
      c5: Math.max(0, cw - c1),
      c1,
      r: u.cache_read_input_tokens || 0,
      w: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
      f: u.speed === 'fast' ? 1 : 0,
      s: d.isSidechain || isSub ? 1 : 0,
      tl: tools,
    });
  }

  function user(d) {
    if (d.isMeta || d.isSidechain || isSub) return;
    const c = d.message && d.message.content;
    let text = null;
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      if (c.some((b) => b && b.type === 'tool_result')) return;
      const tb = c.find((b) => b && b.type === 'text');
      text = tb ? tb.text : '';
    } else return;
    if (text.startsWith('<local-command') || text.startsWith('Caveat:') || text.startsWith('<system-reminder>')) return;
    meta(d);
    touch(Date.parse(d.timestamp));
    info.prompts++;
    if (info.firstPrompt === null) {
      const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
      info.firstPrompt = (cmd ? cmd[1] : text).replace(/\s+/g, ' ').trim().slice(0, 160);
    }
  }

  function title(d) {
    if (d.type === 'custom-title' && d.customTitle) info.customTitle = d.customTitle;
    else if (d.type === 'agent-name' && d.agentName) info.agentName = d.agentName;
    else if (d.type === 'ai-title' && d.aiTitle) info.aiTitle = d.aiTitle;
    else if (d.type === 'summary' && d.summary && !info.summary) info.summary = d.summary;
  }

  function line(l) {
    if (l.length < 20) return;
    try {
      if (l.indexOf('"type":"assistant"') !== -1) {
        if (l.indexOf('"usage"') !== -1) {
          const d = JSON.parse(l);
          if (d.type === 'assistant') assistant(d);
        }
        return;
      }
      if (l.indexOf('"type":"user"') !== -1) {
        if (l.length < MAX_USER_LINE && l.indexOf('"tool_result"') === -1) {
          const d = JSON.parse(l);
          if (d.type === 'user') user(d);
        }
        return;
      }
      if (l.length < 20_000 && TITLE_TYPES.some((p) => l.indexOf(p) !== -1)) title(JSON.parse(l));
    } catch {
      // Truncated or malformed line (e.g. a session still being written): skip it.
    }
  }

  return {
    push(text) {
      const s = rest ? rest + text : text;
      let start = 0, i;
      while ((i = s.indexOf('\n', start)) !== -1) {
        line(s.slice(start, i));
        start = i + 1;
      }
      rest = s.slice(start);
    },
    finish() {
      if (rest) line(rest);
      rest = '';
      return { info, records: [...msgs.values()] };
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Maps a transcript path (relative, '/'-separated) to its session.
//   <project>/<sessionId>.jsonl                      -> main transcript
//   <project>/<sessionId>/subagents/agent-x.jsonl    -> subagent of that session
// Returns null for files that aren't session transcripts.
export function classifyPath(path) {
  const parts = path.split('/').filter(Boolean);
  const pi = parts.lastIndexOf('projects');
  const rel = pi === -1 ? parts : parts.slice(pi + 1);
  const name = rel[rel.length - 1];
  if (!name || !name.endsWith('.jsonl')) return null;
  const stem = name.slice(0, -6);
  for (let i = rel.length - 2; i >= 0; i--) {
    if (UUID.test(rel[i])) return { sessionId: rel[i], isSub: true, projectDir: rel[i - 1] || '' };
  }
  if (UUID.test(stem)) return { sessionId: stem, isSub: false, projectDir: rel[rel.length - 2] || '' };
  return null;
}
