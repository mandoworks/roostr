'use strict';
// Optional: today's spend across every agent, from tokscale
// (https://github.com/junhoyeo/tokscale) when it is installed. tokscale reads
// every agent's local session files, which takes a while (17 s seen), so it
// runs in the background at low priority, at most every 5 minutes, and the
// board shows the last result. Without tokscale on PATH nothing changes.
//
// The today view also wants tokens per hour. tokscale's hourly report gives
// one total per hour, so it runs once per agent (client) to stack the hours by
// agent: a few slow runs one after the other, every 30 minutes, only once the
// view has been opened.

const { execFile } = require('child_process');

const EVERY_MS = 5 * 60 * 1000;
const HOURLY_EVERY_MS = 30 * 60 * 1000;
const MAX_CLIENTS = 5;
const ARGV = ['-n', '10', 'tokscale', '--json', '--today', '--group-by', 'client,session,model', '--no-spinner'];
const COUNTS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'cost'];
const RUN_OPTS = { timeout: 60 * 1000, maxBuffer: 64 * 1024 * 1024 };

let last = null; // { at, total, sessions, clients }
let running = false;
let started = -Infinity;

let lastHourly = null; // { at, hours: { 'HH': { client: { tokens, cost } } } }
let hourlyRunning = false;
let hourlyStarted = -Infinity;

function zero() {
  return Object.fromEntries(COUNTS.map((k) => [k, 0]));
}

function add(into, e) {
  for (const k of COUNTS) if (typeof e[k] === 'number' && Number.isFinite(e[k])) into[k] += e[k];
}

function jsonOf(text) {
  // A warning printed before the JSON must not hide it.
  const start = String(text).indexOf('{');
  try {
    return JSON.parse(String(text).slice(Math.max(0, start)));
  } catch (e) {
    return null;
  }
}

// tokscale's JSON -> { at, total, sessions: { id: { client, input, output, ..., cost } },
// clients: { name: { input, ..., cost, sessions } },
// models: { name: { input, ..., cost, sessions, clients } } }, or null when it
// is not what we expect.
function parse(text, now) {
  const d = jsonOf(text);
  if (!d || typeof d.totalCost !== 'number' || !Number.isFinite(d.totalCost)) return null;
  const sessions = {};
  const clients = {};
  const models = {};
  const modelSessions = new Map();
  const modelClients = new Map();
  for (const e of Array.isArray(d.entries) ? d.entries : []) {
    if (!e || typeof e.sessionId !== 'string') continue;
    const client = typeof e.client === 'string' && e.client ? e.client : '?';
    const s = sessions[e.sessionId] || (sessions[e.sessionId] = { client, ...zero() });
    add(s, e);
    const c = clients[client] || (clients[client] = { ...zero(), sessions: 0 });
    add(c, e);
    if (typeof e.model === 'string' && e.model) {
      const m = models[e.model] || (models[e.model] = zero());
      add(m, e);
      if (!modelSessions.has(e.model)) {
        modelSessions.set(e.model, new Set());
        modelClients.set(e.model, new Set());
      }
      modelSessions.get(e.model).add(e.sessionId);
      modelClients.get(e.model).add(client);
    }
  }
  for (const s of Object.values(sessions)) clients[s.client].sessions++;
  for (const [name, m] of Object.entries(models)) {
    m.sessions = modelSessions.get(name).size;
    m.clients = [...modelClients.get(name)].sort();
  }
  return { at: now, total: d.totalCost, sessions, clients, models };
}

// One client's hourly JSON -> { 'HH': { tokens, cost } }, or null.
function parseHourly(text) {
  const d = jsonOf(text);
  if (!d || !Array.isArray(d.entries)) return null;
  const hours = {};
  for (const e of d.entries) {
    const m = e && /\b(\d{2}):00$/.exec(String(e.hour));
    if (!m) continue;
    const n = (k) => (typeof e[k] === 'number' && Number.isFinite(e[k]) ? e[k] : 0);
    hours[m[1]] = { tokens: n('input') + n('output') + n('cacheRead') + n('cacheWrite'), cost: n('cost') };
  }
  return hours;
}

function sameDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

// The newest result for today, or null. Starts a background refresh when one
// is due; its result shows on a later call. `run` is execFile (tests swap it).
function today(now = Date.now(), run = execFile) {
  if (!running && now - started >= EVERY_MS) {
    running = true;
    started = now;
    const child = run('nice', ARGV, RUN_OPTS, (err, stdout) => {
      running = false;
      // Stamped with the start of the run: the data is as of then.
      if (!err) last = parse(stdout, now) || last;
    });
    if (child && child.unref) child.unref();
  }
  if (last && !sameDay(last.at, now)) return null;
  return last;
}

// Tokens and cost per hour per client for today, or null until the first
// round is in. `clients` are the names from today(); the busiest few run, one
// after the other, every 30 minutes.
function hourly(now = Date.now(), clients = [], run = execFile) {
  const names = clients.filter((c) => /^[a-z0-9-]{1,40}$/.test(c)).slice(0, MAX_CLIENTS);
  if (!hourlyRunning && names.length && now - hourlyStarted >= HOURLY_EVERY_MS) {
    hourlyRunning = true;
    hourlyStarted = now;
    const hours = {};
    const next = (i) => {
      if (i >= names.length) {
        hourlyRunning = false;
        lastHourly = { at: now, hours };
        return;
      }
      const argv = ['-n', '10', 'tokscale', 'hourly', '--today', '--json', '--no-spinner', '-c', names[i]];
      const child = run('nice', argv, RUN_OPTS, (err, stdout) => {
        const h = err ? null : parseHourly(stdout);
        for (const [hh, v] of Object.entries(h || {})) (hours[hh] = hours[hh] || {})[names[i]] = v;
        next(i + 1);
      });
      if (child && child.unref) child.unref();
    };
    next(0);
  }
  if (lastHourly && !sameDay(lastHourly.at, now)) return null;
  return lastHourly;
}

module.exports = { parse, parseHourly, today, hourly };
