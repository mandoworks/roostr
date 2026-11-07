'use strict';
// Check commands from the crew file, shown as badges.
//
// A check passes when its command exits 0. Commands are split into an argv
// array here and run with execFile, never through a shell, so nothing from a
// pane (label, cwd, screen) can ever be spliced into a command line. Each run
// has a timeout and each check is re-run no faster than MIN_INTERVAL_MS.
// The crew file is code: anyone who can edit it can run commands as you.

const { execFile } = require('child_process');

const TIMEOUT_MS = 2000;
const MIN_INTERVAL_MS = 5000;
const MAX_CONCURRENT = 3;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Split "pgrep -x 'Unreal Editor'" into ["pgrep", "-x", "Unreal Editor"].
// Supports single quotes, double quotes, and backslash escapes. No variables,
// globs, pipes, or redirection: they stay literal text.
function splitArgs(s) {
  const out = [];
  let cur = '';
  let has = false;
  let q = null;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
    } else if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < str.length && '"\\'.includes(str[i + 1])) cur += str[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === '\\' && i + 1 < str.length) {
      cur += str[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (q) return null;
  if (has || cur) out.push(cur);
  return out;
}

// key -> { state: true | false | null, at, running }
const results = new Map();

function keyOf(run, cwd) {
  return `${cwd}\u0000${run}`;
}

function runOne(run, cwd, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const argv = splitArgs(run);
    if (!argv || argv.length === 0) return resolve(null);
    execFile(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, windowsHide: true }, (err) => {
      if (!err) return resolve(true);
      // A timeout or a missing program is unknown, not a failed check.
      if (err.killed || err.signal || typeof err.code !== 'number') return resolve(null);
      resolve(false);
    });
  });
}

// Start any check that is due. Returns a promise for the runs it started, so
// callers can await a first result; the board itself does not wait.
function refresh(list, now = Date.now(), intervalMs = MIN_INTERVAL_MS, options = {}) {
  const started = [];
  const every = Math.max(intervalMs, MIN_INTERVAL_MS);
  const maxConcurrent = clampInt(options.maxConcurrent, 1, 8, MAX_CONCURRENT);
  const timeoutMs = clampInt(options.timeoutMs, 1000, 10000, TIMEOUT_MS);
  const current = new Set(list.map(({ run, cwd }) => keyOf(run, cwd)));
  for (const k of results.keys()) if (!current.has(k)) results.delete(k);
  let running = 0;
  for (const r of results.values()) if (r.running) running++;
  for (const { run, cwd } of list) {
    if (started.length + running >= maxConcurrent) break;
    const k = keyOf(run, cwd);
    const r = results.get(k) || { state: null, at: 0, running: false };
    if (r.running || now - r.at < every) continue;
    r.running = true;
    results.set(k, r);
    started.push(
      runOne(run, cwd, timeoutMs).then((state) => {
        r.state = state;
        r.at = Date.now();
        r.running = false;
      }),
    );
  }
  return Promise.all(started);
}

// true (passed), false (failed), or null (not run yet, timed out, or missing).
function state(run, cwd) {
  const r = results.get(keyOf(run, cwd));
  return r ? r.state : null;
}

module.exports = { splitArgs, runOne, refresh, state, TIMEOUT_MS, MIN_INTERVAL_MS, MAX_CONCURRENT };
