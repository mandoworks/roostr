'use strict';
// `roostr log [--all] [--dir <path>] [--kind opencode|kilo|all] [--json]`
// `roostr log --resume <session-id> [--workspace <id|label>] [--pane <id>]`
//
// Recent conversations from the agent's own session store. This is the history
// a closed tab leaves behind: the board shows it in the `L log` drawer and can
// reopen one in the current workspace with its session id, no backup needed.

const os = require('os');
const herdr = require('./herdr');
const sessions = require('./sessions');
const ui = require('./ui');

const KINDS = ['opencode', 'kilo'];
const USAGE = 'usage: roostr log [--all] [--dir <path>] [--kind opencode|kilo|all] [--json] | log --resume <id> [--workspace <id|label>] [--pane <id>]';

function parseArgs(argv) {
  const o = { all: false, dir: null, kind: 'all', json: false, resume: null, workspace: null, pane: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--dir') {
      o.dir = argv[++i];
      if (!o.dir) return { error: '--dir needs a path' };
    } else if (a === '--kind') {
      o.kind = argv[++i];
      if (!o.kind) return { error: '--kind needs a value' };
    } else if (a === '--resume') {
      o.resume = argv[++i];
      if (!o.resume) return { error: '--resume needs a session id' };
    } else if (a === '--workspace' || a === '-w') {
      o.workspace = argv[++i];
      if (!o.workspace) return { error: '--workspace needs a value' };
    } else if (a === '--pane') {
      o.pane = argv[++i];
      if (!o.pane) return { error: '--pane needs a value' };
    } else return { error: `unknown option ${a}` };
  }
  if (!KINDS.includes(o.kind) && o.kind !== 'all') return { error: `--kind must be one of: ${KINDS.join(', ')}, all` };
  return o;
}

// Every store that answers, merged and newest first. A missing CLI is not an
// error: a machine with only opencode still gets its log.
async function list(options = {}, deps = {}) {
  const kinds = options.kind && options.kind !== 'all' ? [options.kind] : KINDS;
  const out = [];
  await Promise.all(kinds.map(async (kind) => {
    try {
      const items = await sessions.sessionList(kind, {
        bin: options.bins && options.bins[kind],
        noCache: options.noCache,
        timeout: options.timeout,
        limit: options.limit,
        now: options.now,
      });
      for (const s of items) out.push({ ...s, kind });
    } catch (e) { /* that agent is not installed here */ }
  }));
  const dirs = Array.isArray(options.dirs) && options.dirs.length ? new Set(options.dirs) : null;
  const kept = out.filter((s) => {
    if (options.dir && s.directory !== options.dir) return false;
    if (!options.all && dirs && !dirs.has(s.directory)) return false;
    return true;
  });
  kept.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return kept.slice(0, options.limit || 200);
}

function resolveWorkspace(snap, value) {
  let id = value && value !== 'here' ? value : process.env.HERDR_WORKSPACE_ID;
  if (!id) {
    const focused = snap.panes.find((p) => p.focused);
    id = focused && focused.workspace_id;
  }
  if (id) {
    const byId = snap.workspaces.find((w) => w.workspace_id === id);
    if (byId) return byId;
  }
  if (value && value !== 'here') {
    return snap.workspaces.find((w) => String(w.label || '').toLowerCase() === String(value).toLowerCase()) || null;
  }
  return null;
}

function parentPane(snap, workspaceId, fromPane) {
  if (fromPane) return fromPane;
  const panes = snap.panes.filter((p) => p.workspace_id === workspaceId);
  const env = panes.find((p) => p.pane_id === process.env.HERDR_PANE_ID);
  if (env) return env.pane_id;
  const focused = panes.find((p) => p.focused);
  return (focused || panes[panes.length - 1] || {}).pane_id || null;
}

// Open one session in a new pane of the chosen workspace. The conversation is
// carried by the agent's own resume flag, so nothing is copied.
async function resume(item, options = {}, deps = {}) {
  const h = deps.herdr || herdr;
  const kind = item && item.kind ? item.kind : 'opencode';
  if (!item || !item.id || !sessions.validSession(kind, item.id)) {
    return { error: 'no valid session id' };
  }
  const snap = await h.snapshot();
  const ws = resolveWorkspace(snap, options.workspace);
  if (!ws) return { error: `no workspace ${options.workspace || 'here'}` };
  const parent = parentPane(snap, ws.workspace_id, options.pane);
  if (!parent) return { error: `${ws.label || ws.workspace_id} has no pane to split from` };
  let paneId = null;
  try {
    paneId = await h.splitPane(parent, 'right', item.directory || null, true);
  } catch (e) {
    return { error: `split failed: ${e.message}` };
  }
  if (!paneId) return { error: 'Herdr gave no pane' };
  const taken = new Set(snap.agents.map((a) => a.name).filter(Boolean));
  const name = sessions.agentName(item.title || kind, taken);
  try {
    await h.startAgent(name, kind, paneId, sessions.agentArgs({ agent: kind, session: item.id }));
    await h.renamePane(paneId, item.title ? `${name} · ${item.title}` : name).catch(() => {});
  } catch (e) {
    await h.closePane(paneId).catch(() => {});
    return { error: `start ${name} (${kind}): ${e.message}` };
  }
  return { paneId, name, kind, session: item.id, cwd: item.directory || null, workspace: ws.label || ws.workspace_id, workspaceId: ws.workspace_id };
}

function ago(ms, now) {
  if (!Number.isFinite(ms)) return '?';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function line(item, now, width) {
  const when = ago(item.updated, now);
  const kind = item.kind || '?';
  const dir = (item.directory || '?').replace(os.homedir(), '~');
  const head = `${ui.padEnd(when, 7)} ${ui.padEnd(kind, 8)} ${ui.clean(item.title || item.id)}`;
  const tail = `  ${dir}`;
  return ui.truncate(`${head}${tail}`, width);
}

function lines(items, now = Date.now(), width = 100) {
  const list = Array.isArray(items) ? items : [];
  const out = [`${ui.bold(ui.C.title('log'))}  ${ui.dim('↑↓ session · enter resume · a here/all · esc close')}`];
  if (!list.length) {
    out.push(ui.dim('No sessions yet. A closed tab leaves its conversation in the agent store.'));
    return out;
  }
  for (let i = 0; i < list.length; i++) out.push(ui.truncate(line(list[i], now, width), width));
  return out;
}

async function main(argv, options = {}) {
  const o = parseArgs(argv);
  const out = options.stdout || process.stdout;
  const err = options.stderr || process.stderr;
  if (o.help) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  if (o.error) {
    err.write(`roostr log: ${o.error}\n${USAGE}\n`);
    return 2;
  }
  if (o.resume) {
    const items = await list({ kind: o.kind, all: true, noCache: true }, options);
    const item = items.find((s) => s.id === o.resume);
    if (!item) {
      err.write(`roostr log: no session ${o.resume}\n`);
      return 1;
    }
    const r = await resume(item, { workspace: o.workspace, pane: o.pane }, options);
    if (r.error) {
      err.write(`roostr log: ${r.error}\n`);
      return 1;
    }
    if (o.json) out.write(JSON.stringify(r, null, 2) + '\n');
    else out.write(`resumed ${r.name} (${r.kind}) in ${r.paneId} · ${r.session}\n`);
    return 0;
  }
  const items = await list({ kind: o.kind, dir: o.dir, all: o.all, noCache: true, bins: options.bins }, options);
  if (o.json) out.write(JSON.stringify(items, null, 2) + '\n');
  else out.write(lines(items, Date.now(), out.columns || 100).join('\n') + '\n');
  return 0;
}

module.exports = { KINDS, parseArgs, list, resume, line, lines, main, USAGE };
