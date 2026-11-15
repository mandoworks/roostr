'use strict';
// Per-host worker snapshot publisher for the /agents drill-down.
// Reads Herdr's live snapshot and per-pane reports (never the pane screen)
// and writes <out>/workers.<host>.json atomically, or prints JSON to stdout.

const fs = require('fs');
const os = require('os');
const path = require('path');
const herdr = require('./herdr');
const { readReport } = require('./report');
const sessions = require('./sessions');
const ui = require('./ui');

const SCHEMA = 1;
const TASK_MAX = 160;
const HOST_RE = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const DEFAULT_AGENT_LABELS = new Set(['claude', 'opencode', 'agy', 'kilo', 'gemini']);
const DEFAULT_TITLES = /^(claude code|claude|opencode|oc|kilo|kilo code|agy|antigravity|gemini|codex|zsh|bash|fish|sh)$/i;
const TAG_RE = /^(?:[\u{1F7E5}-\u{1F7EB}\u{2B1B}\u{2B1C}\u{1F532}-\u{1F537}]|\[\d+\])\s*/u;

function sanitizeHost(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 63);
  return HOST_RE.test(s) ? s : null;
}

function validateHost(raw) {
  if (typeof raw !== 'string' || !HOST_RE.test(raw)) {
    throw new Error(`invalid host: ${String(raw)}`);
  }
  return raw;
}

function cleanText(v) {
  if (typeof v !== 'string') return null;
  const s = ui.clean(v);
  return s || null;
}

function truncateTask(v, max = TASK_MAX) {
  const s = cleanText(v);
  if (!s) return null;
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function parseLabel(label) {
  if (typeof label !== 'string' || label.trim() === '') return { name: null, task: null };
  const clean = ui.clean(label).replace(TAG_RE, '').trim();
  const i = clean.indexOf(' · ');
  if (i < 0) return { name: clean || null, task: null };
  return {
    name: clean.slice(0, i).trim() || null,
    task: clean.slice(i + 3).trim() || null,
  };
}

function titleTask(a) {
  const t = ui.clean(a && a.terminal_title_stripped).replace(/^[A-Za-z]{2,12} \| /, '').trim();
  return t && !DEFAULT_TITLES.test(t) ? t : null;
}

function finiteNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function cmp(a, b) {
  const sa = a == null ? '' : String(a);
  const sb = b == null ? '' : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function pickSession(agentKind, rep, a) {
  if (rep && sessions.validSession(agentKind, rep.session)) return rep.session;
  if (a && sessions.validSession(agentKind, a.session_id)) return a.session_id;
  if (a && a.agent_session && sessions.validSession(agentKind, a.agent_session.value)) {
    return a.agent_session.value;
  }
  return null;
}

function buildSnapshot(model, opts = {}) {
  const host = opts.host !== undefined && opts.host !== null
    ? validateHost(opts.host)
    : (sanitizeHost(os.hostname()) || 'unknown');

  const nowMs = opts.now instanceof Date
    ? opts.now.getTime()
    : (typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now());

  const snap = (model && (model.snapshot || model.snap))
    || (model && Array.isArray(model.agents) ? model : null)
    || {};
  const reports = (model && model.reports && typeof model.reports === 'object') ? model.reports : {};

  const agents = Array.isArray(snap.agents) ? snap.agents : [];
  const panes = Array.isArray(snap.panes) ? snap.panes : [];
  const workspaces = Array.isArray(snap.workspaces) ? snap.workspaces : [];

  const paneById = new Map();
  for (const p of panes) {
    if (p && typeof p.pane_id === 'string') paneById.set(p.pane_id, p);
  }

  const wsLabel = new Map();
  for (const w of workspaces) {
    if (w && typeof w.workspace_id === 'string') {
      wsLabel.set(w.workspace_id, cleanText(w.label) || w.workspace_id);
    }
  }

  const seenPanes = new Set();
  const workers = [];

  for (const a of agents) {
    if (!a || typeof a.pane_id !== 'string' || !a.pane_id) continue;
    if (seenPanes.has(a.pane_id)) continue;
    seenPanes.add(a.pane_id);

    const pane = paneById.get(a.pane_id) || {};
    const rep = (reports[a.pane_id] && typeof reports[a.pane_id] === 'object') ? reports[a.pane_id] : {};

    const wsId = cleanText(a.workspace_id) || cleanText(pane.workspace_id);
    const workspace = (wsId && wsLabel.get(wsId)) || wsId || null;

    const agentKind = cleanText(a.agent);
    const label = typeof pane.label === 'string' ? pane.label : null;
    const parsed = parseLabel(label);
    const cleanLabelName = parsed.name ? parsed.name.toLowerCase() : null;
    const isDefaultAgentLabel = Boolean(
      cleanLabelName
      && (cleanLabelName === (agentKind || '').toLowerCase() || DEFAULT_AGENT_LABELS.has(cleanLabelName))
      && !parsed.task
    );
    const agentName = cleanText(a.name);
    const humanName = !isDefaultAgentLabel && parsed.name ? parsed.name : null;
    const name = humanName || agentName || parsed.name || null;

    const state = typeof a.agent_status === 'string' && a.agent_status !== '' ? a.agent_status : null;
    const task = truncateTask(rep.task) || truncateTask(parsed.task) || truncateTask(titleTask(a)) || null;
    const modelName = cleanText(rep.model) || cleanText(a.model) || null;
    const tokens = finiteNum(rep.tokens) ?? finiteNum(a.tokens);
    const cost = finiteNum(rep.cost) ?? finiteNum(a.cost);
    const session = pickSession(agentKind, rep, a);

    workers.push({
      pane_id: a.pane_id,
      workspace,
      name,
      agent: agentKind,
      state,
      task,
      model: modelName,
      tokens,
      cost,
      session,
    });
  }

  workers.sort((x, y) => cmp(x.workspace, y.workspace) || cmp(x.pane_id, y.pane_id));

  return {
    schema: SCHEMA,
    host,
    generated_epoch: Math.floor(nowMs / 1000),
    generated_at: new Date(nowMs).toISOString(),
    workers,
  };
}

function writeSnapshot(snapshot, dir) {
  if (!dir || typeof dir !== 'string') {
    throw new Error('output directory is required');
  }
  const host = validateHost(snapshot && snapshot.host);
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `workers.${host}.json`);
  const tmpPath = path.join(dir, `.workers.${host}.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(snapshot, null, 2) + '\n';
  try {
    fs.writeFileSync(tmpPath, payload, { mode: 0o644 });
    fs.chmodSync(tmpPath, 0o644);
    fs.renameSync(tmpPath, outPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
  return outPath;
}

const USAGE = 'usage: roostr workers [--json] [--out <dir>] [--host <name>]';

function parseArgs(argv) {
  let json = false;
  let out = null;
  let host = null;

  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    if (a === '--json') {
      json = true;
      continue;
    }
    let v;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      v = a.slice(eq + 1);
      a = a.slice(0, eq);
    } else if (a === '--out' || a === '--host') {
      v = argv[i + 1];
      if (v === undefined) return { error: `${a} needs a value` };
      i++;
    } else {
      return { error: `unknown option ${a}` };
    }

    if (a === '--out') out = v;
    else if (a === '--host') host = v;
    else return { error: `unknown option ${a}` };
  }

  return { json, out, host };
}

async function main(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const getSnapshot = deps.snapshot || herdr.snapshot;
  const getReport = deps.readReport || readReport;
  const nowFn = deps.now || Date.now;
  const env = deps.env || process.env;

  const parsed = parseArgs(argv || []);
  if (parsed.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (parsed.error) {
    stderr.write(`roostr workers: ${parsed.error}\n`);
    return 2;
  }

  let host;
  if (parsed.host !== null) {
    try {
      host = validateHost(parsed.host);
    } catch (err) {
      stderr.write(`roostr workers: ${err.message}\n`);
      return 2;
    }
  } else {
    host = sanitizeHost(os.hostname()) || 'unknown';
  }

  const outDir = parsed.out || env.ROOSTR_WORKERS_DIR || '';
  if (!parsed.json && !outDir) {
    stderr.write('roostr workers: missing output dir (pass --out <dir> or set ROOSTR_WORKERS_DIR)\n');
    return 2;
  }

  let snap;
  try {
    snap = await getSnapshot();
  } catch (err) {
    stderr.write(`roostr workers: ${err.message}\n`);
    return 1;
  }

  const nowMs = nowFn();
  const reports = {};
  const agents = (snap && Array.isArray(snap.agents)) ? snap.agents : [];
  for (const a of agents) {
    if (a && typeof a.pane_id === 'string' && a.pane_id) {
      const r = getReport(a.pane_id, nowMs);
      if (r) reports[a.pane_id] = r;
    }
  }

  const doc = buildSnapshot({ snapshot: snap, reports }, { host, now: nowMs });
  if (parsed.json) {
    stdout.write(JSON.stringify(doc, null, 2) + '\n');
    return 0;
  }

  try {
    writeSnapshot(doc, outDir);
  } catch (err) {
    stderr.write(`roostr workers: ${err.message}\n`);
    return 1;
  }
  return 0;
}

module.exports = {
  buildSnapshot,
  writeSnapshot,
  main,
  sanitizeHost,
  validateHost,
  truncateTask,
  parseArgs,
  USAGE,
};
