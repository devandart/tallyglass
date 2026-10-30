// SPDX-License-Identifier: GPL-3.0-or-later
// API list prices in USD per million tokens: [input, output, cache write 5m, cache write 1h, cache read].
// Source: Anthropic first-party API pricing (Oct 2026). Subscription plans don't bill per token;
// this is the "API-equivalent" value of the usage.
const PRICES = {
  'fable-5-1':  [10, 50, 12.5, 20, 0.25],
  'mythos-5-1': [10, 50, 12.5, 20, 0.25],
  'fable-5':    [10, 50, 12.5, 20, 1],
  'mythos-5':   [10, 50, 12.5, 20, 1],
  'opus-5-5':   [4, 20, 5, 8, 0.2],
  'opus-5':     [5, 25, 6.25, 10, 0.5],
  'opus-4-8':   [5, 25, 6.25, 10, 0.5],
  'opus-4-7':   [5, 25, 6.25, 10, 0.5],
  'opus-4-6':   [5, 25, 6.25, 10, 0.5],
  'opus-4-5':   [5, 25, 6.25, 10, 0.5],
  'opus-4-1':   [15, 75, 18.75, 30, 1.5],
  'opus-4':     [15, 75, 18.75, 30, 1.5],
  'sonnet-5-5': [2, 10, 2.5, 4, 0.2],
  'sonnet-5':   [2, 10, 2.5, 4, 0.2],
  'sonnet-4-6': [3, 15, 3.75, 6, 0.3],
  'sonnet-4-5': [3, 15, 3.75, 6, 0.3],
  'sonnet-4':   [3, 15, 3.75, 6, 0.3],
  'haiku-5-5':  [0.1, 0.5, 0.125, 0.2, 0.01],
  'haiku-4-5':  [1, 5, 1.25, 2, 0.1],
  'haiku-3-5':  [0.8, 4, 1, 1.6, 0.08],
};
// Claude Haiku 5.5 charges more once the prompt exceeds 100K tokens.
const HAIKU_55_LONG = [0.5, 2.5, 0.625, 1, 0.05];
const FAMILY_FALLBACK = { fable: 'fable-5-1', mythos: 'mythos-5-1', opus: 'opus-5-5', sonnet: 'sonnet-5-5', haiku: 'haiku-5-5' };
const WEB_SEARCH_USD = 10 / 1000;

const cache = new Map();

// 'claude-opus-4-5-20251101' -> 'opus-4-5'; 'claude-3-5-haiku-2024..' -> 'haiku-3-5'
export function modelKey(id) {
  let s = String(id).toLowerCase().replace(/^claude-/, '').replace(/\[.*?\]$/, '').replace(/-\d{8}$/, '').replace(/@.*$/, '');
  const old = /^(\d)-(\d)-(opus|sonnet|haiku)/.exec(s) || /^(\d)-(opus|sonnet|haiku)/.exec(s);
  if (old) s = old.length === 4 ? `${old[3]}-${old[1]}-${old[2]}` : `${old[2]}-${old[1]}`;
  return s;
}

export function modelInfo(id) {
  let hit = cache.get(id);
  if (hit) return hit;
  const key = modelKey(id);
  const m = /^(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/.exec(key);
  const family = m ? m[1] : 'other';
  const label = m ? `${family[0].toUpperCase()}${family.slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : String(id);
  let priceKey = PRICES[key] ? key : null;
  if (!priceKey && m) priceKey = PRICES[`${family}-${m[2]}-${m[3]}`] ? `${family}-${m[2]}-${m[3]}` : PRICES[`${family}-${m[2]}`] ? `${family}-${m[2]}` : null;
  const estimated = !priceKey && !!m;
  if (!priceKey && m) priceKey = FAMILY_FALLBACK[family];
  // Non-Claude models (custom backends, local models) have no Anthropic price.
  const unpriced = !priceKey;
  hit = { id, key, family, label, priceKey, prices: unpriced ? [0, 0, 0, 0, 0] : PRICES[priceKey], estimated, unpriced };
  cache.set(id, hit);
  return hit;
}

function pricesFor(r) {
  const info = modelInfo(r.m);
  if (info.priceKey === 'haiku-5-5' && r.i + r.c5 + r.c1 + r.r > 100_000) return HAIKU_55_LONG;
  return info.prices;
}

// Cost in USD of one usage record (see parse.js for the field names), split into
// [input, output, cache write, cache read + web search]. Fast mode bills 2x.
export function recordCostParts(r) {
  const p = pricesFor(r);
  const x = (r.f ? 2 : 1) / 1e6;
  return [r.i * p[0] * x, r.o * p[1] * x, (r.c5 * p[2] + r.c1 * p[3]) * x, r.r * p[4] * x + r.w * WEB_SEARCH_USD];
}

// What the cache reads would have cost at the full input price.
export function cacheSavings(r) {
  const p = pricesFor(r);
  return (r.r * (p[0] - p[4]) * (r.f ? 2 : 1)) / 1e6;
}
