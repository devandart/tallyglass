// SPDX-License-Identifier: GPL-3.0-or-later
// Getting transcript files into the page (folder picker, <input>, drag & drop),
// parsing them with a worker pool, and caching results in IndexedDB so a rescan
// only re-reads files that changed. Nothing leaves the browser.
import { classifyPath } from './parse.js?v=6';

const DB = 'tallyglass';
let dbp = null;

function db() {
  dbp ||= new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('files');
      req.result.createObjectStore('kv');
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}

async function safe(fn, fallback) {
  try { return await fn(); } catch { return fallback; }
}

export const kvGet = (k) => safe(() => tx('kv', 'readonly', (s) => s.get(k)), undefined);
export const kvSet = (k, v) => safe(() => tx('kv', 'readwrite', (s) => s.put(v, k)));

async function cachedFiles() {
  return safe(async () => {
    const d = await db();
    return new Promise((res, rej) => {
      const out = new Map();
      const req = d.transaction('files').objectStore('files').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return res(out);
        out.set(c.key, c.value);
        c.continue();
      };
      req.onerror = () => rej(req.error);
    });
  }, new Map());
}

export async function loadCachedResults() {
  const m = await cachedFiles();
  return [...m.values()];
}

export const clearCache = () => safe(async () => {
  await tx('files', 'readwrite', (s) => s.clear());
  await tx('kv', 'readwrite', (s) => s.clear());
});

// ---- Collecting files -------------------------------------------------------

export const canPickDirectory = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export async function pickDirectory() {
  const handle = await window.showDirectoryPicker({ id: 'claude-projects', mode: 'read' });
  await kvSet('dir', handle);
  return handle;
}

// A handle saved by an earlier visit, if the browser still grants (or re-grants) read access.
export async function savedDirectory({ prompt }) {
  const h = await kvGet('dir');
  if (!h || !h.queryPermission) return null;
  if ((await h.queryPermission({ mode: 'read' })) === 'granted') return h;
  if (prompt && (await h.requestPermission({ mode: 'read' })) === 'granted') return h;
  return null;
}

export async function filesFromHandle(handle, onFound) {
  const out = [];
  async function walk(dir, path) {
    for await (const [name, h] of dir.entries()) {
      const p = `${path}/${name}`;
      if (h.kind === 'directory') {
        // Skip big folders that never hold transcripts.
        if (name === 'tool-results' || name === 'node_modules' || name.startsWith('.git')) continue;
        await walk(h, p);
      } else if (name.endsWith('.jsonl')) {
        out.push({ path: p, file: await h.getFile() });
        if (out.length % 25 === 0) onFound?.(out.length);
      }
    }
  }
  await walk(handle, handle.name);
  return out;
}

export function filesFromInput(fileList) {
  return [...fileList].filter((f) => f.name.endsWith('.jsonl')).map((f) => ({ path: f.webkitRelativePath || f.name, file: f }));
}

export function dropEntries(dataTransfer) {
  return [...dataTransfer.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
}

export async function filesFromDrop(entries, onFound) {
  const out = [];
  const readAll = (reader) => new Promise((res, rej) => {
    const acc = [];
    const next = () => reader.readEntries((batch) => (batch.length ? (acc.push(...batch), next()) : res(acc)), rej);
    next();
  });
  async function walk(entry) {
    if (entry.isDirectory) {
      if (entry.name === 'tool-results') return;
      for (const e of await readAll(entry.createReader())) await walk(e);
    } else if (entry.name.endsWith('.jsonl')) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ path: entry.fullPath.replace(/^\//, ''), file });
      if (out.length % 25 === 0) onFound?.(out.length);
    }
  }
  for (const e of entries) await walk(e);
  return out;
}

// ---- Scanning ---------------------------------------------------------------

// files: [{path, file}] -> [{path, cls, result}]; onProgress({doneBytes, totalBytes, doneFiles, totalFiles, cached})
export async function scan(files, onProgress) {
  const items = [];
  for (const f of files) {
    const cls = classifyPath(f.path);
    if (cls) items.push({ ...f, cls });
  }
  const cache = await cachedFiles();
  const results = [];
  const todo = [];
  for (const it of items) {
    const c = cache.get(it.path);
    if (c && c.size === it.file.size && c.mtime === it.file.lastModified) results.push(c);
    else todo.push(it);
  }
  todo.sort((a, b) => b.file.size - a.file.size);

  const totalBytes = todo.reduce((a, t) => a + t.file.size, 0);
  const state = { doneBytes: 0, totalBytes, doneFiles: 0, totalFiles: todo.length, cached: results.length, sessions: 0 };
  onProgress?.(state);

  const n = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  const workers = Array.from({ length: Math.min(n, todo.length) }, () => new Worker(new URL('./scan.worker.js?v=6', import.meta.url), { type: 'module' }));
  let next = 0;
  const partial = new Map();

  await Promise.all(workers.map((w) => new Promise((resolve) => {
    const run = () => {
      if (next >= todo.length) return resolve();
      const id = next++;
      const it = todo[id];
      partial.set(id, 0);
      w.onmessage = (e) => {
        const m = e.data;
        if (m.progress !== undefined) {
          state.doneBytes += m.progress - partial.get(id);
          partial.set(id, m.progress);
          onProgress?.(state);
          return;
        }
        state.doneFiles++;
        if (m.result) {
          const entry = { path: it.path, size: it.file.size, mtime: it.file.lastModified, cls: it.cls, result: m.result };
          results.push(entry);
          safe(() => tx('files', 'readwrite', (s) => s.put(entry, it.path)));
        }
        onProgress?.(state);
        run();
      };
      w.postMessage({ id, file: it.file, cls: it.cls });
    };
    run();
  })));
  workers.forEach((w) => w.terminate());

  // Forget cached files that no longer exist in the scanned folder.
  const live = new Set(items.map((i) => i.path));
  const stale = [...cache.keys()].filter((k) => !live.has(k));
  if (stale.length) safe(() => tx('files', 'readwrite', (s) => stale.forEach((k) => s.delete(k))));
  return results;
}
