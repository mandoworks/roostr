'use strict';
// Shared helpers for the screen adapters. Adapters only ever look at the
// footer at the bottom of the visible screen, so a number printed in the
// transcript above is never mistaken for usage.

function rows(screen) {
  return String(screen || '').split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
}

// The last `n` non empty lines.
function lastLines(screen, n) {
  return rows(screen).slice(-n).join('\n');
}

// The first `n` and last `n` non empty lines, with no duplicate when the
// screen is shorter than both edges together.
function edgeLines(screen, n) {
  const r = rows(screen);
  const k = Math.max(0, Math.floor(n));
  if (k === 0) return '';
  if (r.length <= k * 2) return r.join('\n');
  return r.slice(0, k).concat(r.slice(-k)).join('\n');
}

// Everything below the last horizontal rule (a line of 20 or more "─"), which
// is where Claude Code draws its statusline under the input box. No rule, no
// footer.
function belowLastRule(screen) {
  const r = rows(screen);
  for (let i = r.length - 1; i >= 0; i--) {
    if (/─{20,}/.test(r[i])) return r.slice(i + 1).join('\n');
  }
  return '';
}

// "136.7K" -> 136700, "1.2M" -> 1200000, "5321" -> 5321. Anything else -> null.
function parseCount(s) {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(String(s || '').trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = { '': 1, k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[m[2]];
  return Math.round(n * mult);
}

function empty() {
  return { ctx: null, tokens: null, cost: null, model: null };
}

module.exports = { lastLines, edgeLines, belowLastRule, parseCount, empty };
