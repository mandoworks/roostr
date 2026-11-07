'use strict';
// Codex (ChatGPT plan) usage limits. Codex has no statusline to report from,
// but every session file it writes logs the account's rate limits after each
// turn. The board reads at most 64 KiB of the newest session tail to find the
// last rate_limits entry. No other content is parsed, logged or stored.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CHUNK_BYTES = 16 * 1024;
const MAX_TAIL_BYTES = 64 * 1024;
const EVERY_MS = 60 * 1000;
const WINDOWS = { 300: 'five_hour', 10080: 'seven_day' };

let cache = { at: -Infinity, value: null };

function sessionsDir() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

// Newest names first, keeping only those that match `re`.
function listDesc(dir, re) {
  try {
    return fs.readdirSync(dir).filter((n) => re.test(n)).sort().reverse();
  } catch (e) {
    return [];
  }
}

// The newest rollout file: sessions/YYYY/MM/DD/rollout-*.jsonl.
function newestFile(root = sessionsDir()) {
  for (const y of listDesc(root, /^\d{4}$/)) {
    for (const m of listDesc(path.join(root, y), /^\d{2}$/)) {
      for (const d of listDesc(path.join(root, y, m), /^\d{2}$/)) {
        const dir = path.join(root, y, m, d);
        let best = null;
        for (const f of listDesc(dir, /^rollout-.*\.jsonl$/)) {
          try {
            const t = fs.statSync(path.join(dir, f)).mtimeMs;
            if (!best || t > best.t) best = { file: path.join(dir, f), t };
          } catch (e) {
            // removed in between
          }
        }
        if (best) return best.file;
      }
    }
  }
  return null;
}

function tail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return '';
    let readTotal = 0;
    let accumulated = '';
    while (readTotal < size && readTotal < MAX_TAIL_BYTES) {
      const toRead = Math.min(CHUNK_BYTES, size - readTotal, MAX_TAIL_BYTES - readTotal);
      const pos = size - readTotal - toRead;
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, pos);
      readTotal += toRead;
      accumulated = buf.toString('utf8') + accumulated;
      if (accumulated.includes('"rate_limits"')) {
        const idx = accumulated.indexOf('"rate_limits"');
        if (pos === 0 || readTotal >= MAX_TAIL_BYTES || accumulated.lastIndexOf('\n', idx) !== -1) {
          break;
        }
      }
    }
    return accumulated;
  } finally {
    fs.closeSync(fd);
  }
}

// The last rate_limits in a session file's text -> a report shaped like
// `crew-board report` writes ({ at, limits }), or null.
function parse(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let j;
    try {
      j = JSON.parse(lines[i]);
    } catch (e) {
      continue; // the first line of a tail is usually cut
    }
    const rl = (j && j.payload && j.payload.rate_limits) || (j && j.rate_limits);
    if (!rl) continue;
    const limit = { source: 'codex' };
    for (const w of [rl.primary, rl.secondary]) {
      const name = w && WINDOWS[w.window_minutes];
      const used = w && Number(w.used_percent);
      if (!name || !Number.isFinite(used) || used < 0 || used > 1000) continue;
      const resets = Number(w.resets_at);
      limit[name] = { used, resets: Number.isFinite(resets) && resets > 0 ? resets : null };
    }
    if (!limit.five_hour && !limit.seven_day) return null;
    const at = Date.parse(j.timestamp);
    return { at: Number.isFinite(at) ? at : null, limits: [limit] };
  }
  return null;
}

// Codex's usage limits as a report, or null. Read at most once a minute.
function limits(now = Date.now()) {
  if (now - cache.at < EVERY_MS) return cache.value;
  let value = null;
  try {
    const file = newestFile();
    if (file) {
      value = parse(tail(file));
      if (value && value.at === null) value.at = fs.statSync(file).mtimeMs;
    }
  } catch (e) {
    value = null;
  }
  cache = { at: now, value };
  return value;
}

module.exports = { parse, tail, newestFile, limits, MAX_TAIL_BYTES };
