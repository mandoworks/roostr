'use strict';
// `roostr respawn [--workspace <id|label|here>] [--yes] [--json] [--force] [--keep-old] [--layout <preset>]`
//
// Rebuilds one workspace from a snapshot taken right now and resumes every
// agent's conversation. The saved layout is rebuilt by backup.restoreBackup,
// so the new panes load the current plugin and CLI config instead of the one
// they started with. The old workspace is closed only after the snapshot is
// on disk and the rebuild reports no errors; --keep-old leaves it in place
// and keeps the "*restored" label.
//
// A pane whose agent kind can resume is not replaced when its session is
// unknown: losing the conversation is the one outcome a respawn must avoid.
// --force replaces it with a fresh session.

const backup = require('./backup');
const sessions = require('./sessions');

const USAGE = 'usage: roostr respawn [--workspace <id|label|here>] [--yes] [--json] [--force] [--keep-old] [--reopen-board] [--layout even|saved|columns|rows]';
const HAS_RESUME = new Set(['claude', 'opencode', 'kilo', 'agy', 'antigravity']);

function parseArgs(argv) {
  const o = { workspace: null, yes: false, json: false, force: false, keepOld: false, reopenBoard: false, layout: 'saved', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--json') o.json = true;
    else if (a === '--force') o.force = true;
    else if (a === '--keep-old') o.keepOld = true;
    else if (a === '--reopen-board') o.reopenBoard = true;
    else if (a === '--here') o.workspace = 'here';
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--workspace' || a === '-w') {
      const v = argv[++i];
      if (v === undefined) return { error: '--workspace needs a value' };
      o.workspace = v;
    } else if (a === '--layout') {
      const v = argv[++i];
      if (!backup.LAYOUTS.includes(v)) return { error: `--layout must be one of: ${backup.LAYOUTS.join(', ')}` };
      o.layout = v;
    } else return { error: `unknown option ${a}` };
  }
  return o;
}

function sameText(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function resolveWorkspace(snap, value) {
  let id = !value || value === 'here' ? process.env.HERDR_WORKSPACE_ID : value;
  if (!id) {
    const focused = snap.panes.find((p) => p.focused);
    id = focused && focused.workspace_id;
  }
  if (id) {
    const byId = snap.workspaces.find((w) => w.workspace_id === id);
    if (byId) return { id: byId.workspace_id, label: byId.label || byId.workspace_id };
  }
  if (value && value !== 'here') {
    const byLabel = snap.workspaces.find((w) => sameText(w.label, value));
    if (byLabel) return { id: byLabel.workspace_id, label: byLabel.label || byLabel.workspace_id };
  }
  return null;
}

function working(agents) {
  return agents.filter((a) => /^(working|busy|running|streaming|active|pending|retry)$/i.test(String(a.agent_status || '')));
}

// Fill the session a pane will resume, reading Herdr's agent_session first and
// the opencode store as the last resort (same rules as a backup restore).
async function sessionsFor(workspaceBackup, options) {
  const pending = [];
  for (const t of workspaceBackup.tabs) {
    for (const p of t.panes) {
      if (!p.agent) continue;
      pending.push({
        paneId: p.paneId, cwd: p.cwd, name: p.agent.name, task: p.agent.task,
        agent: p.agent.kind, session: p.agent.session, saved: p.agent,
      });
    }
  }
  try {
    for (const hit of await sessions.resolveSavedSessions(pending, options)) {
      if (hit.saved) hit.saved.session = hit.session;
    }
  } catch (e) { /* best effort, a missing session is caught below */ }
  return pending;
}

async function run(opts, deps = {}) {
  const herdr = deps.herdr || require('./herdr');
  const snap = await herdr.snapshot();
  const ws = resolveWorkspace(snap, opts.workspace);
  if (!ws) return { error: `no workspace ${opts.workspace || 'here'}` };
  const here = process.env.HERDR_PANE_ID && snap.panes.find((p) => p.pane_id === process.env.HERDR_PANE_ID);
  if (here && here.workspace_id === ws.id) {
    return { error: 'refusing to respawn the workspace this command runs in' };
  }
  const agents = snap.agents.filter((a) => a.workspace_id === ws.id);
  if (!agents.length) return { error: `${ws.label} has no agent panes` };
  if (!opts.force) {
    const busy = working(agents);
    if (busy.length) {
      return { error: `${busy.map((a) => a.pane_id).join(', ')} still working; wait or pass --force` };
    }
  }
  const saved = backup.capture({ snapshot: snap }).find((b) => b.workspaceId === ws.id);
  if (!saved) return { error: `${ws.label} has no restorable panes` };
  const pending = await sessionsFor(saved, deps);
  const unknown = pending.filter((s) => HAS_RESUME.has(s.agent) && !sessions.validSession(s.agent, s.session));
  if (unknown.length && !opts.force) {
    return {
      error: `no session for ${unknown.map((s) => s.paneId).join(', ')}; pass --force to start them fresh`,
      pending: unknown.map((s) => s.paneId),
    };
  }
  if (!opts.yes) {
    return {
      plan: true,
      workspace: ws,
      agents: pending.length,
      resumed: pending.filter((s) => sessions.validSession(s.agent, s.session)).length,
      unknown: unknown.map((s) => s.paneId),
    };
  }

  const taken = snap.agents
    .filter((a) => opts.keepOld || a.workspace_id !== ws.id)
    .map((a) => a.name)
    .filter(Boolean);

  if (!opts.keepOld) {
    if (deps.save !== false) backup.saveBackups([saved]);
    await herdr.closeWorkspace(ws.id);
  }
  const r = await backup.restoreBackup(saved, {
    herdr, taken, layout: opts.layout, resolveSessions: true,
    opencodeBin: opts.opencodeBin, noCache: opts.noCache,
  });
  if (!r.workspaceId) return { error: `could not rebuild ${ws.label}`, errors: r.errors, backup: saved };
  if (!opts.keepOld) await herdr.renameWorkspace(r.workspaceId, ws.label).catch(() => {});
  await herdr.focusWorkspace(r.workspaceId).catch(() => {});
  if (opts.reopenBoard) {
    const after = await herdr.snapshot().catch(() => null);
    const panes = after ? after.panes.filter((p) => p.workspace_id === r.workspaceId) : [];
    const target = panes.length ? panes[panes.length - 1].pane_id : null;
    if (target) await herdr.openBoard('board', true, r.workspaceId, target).catch(() => {});
  }
  return {
    workspace: ws,
    workspaceId: r.workspaceId,
    oldWorkspaceId: opts.keepOld ? null : ws.id,
    label: opts.keepOld ? r.label : ws.label,
    panes: r.panes,
    agents: r.agents,
    sessions: r.sessions,
    errors: r.errors,
  };
}

async function main(argv, options = {}) {
  const opts = parseArgs(argv);
  const out = options.stdout || process.stdout;
  const err = options.stderr || process.stderr;
  if (opts.help) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  if (opts.error) {
    err.write(`roostr respawn: ${opts.error}\n${USAGE}\n`);
    return 2;
  }
  let r;
  try {
    r = await run(opts, options);
  } catch (e) {
    err.write(`roostr respawn: ${e.message}\n`);
    return 1;
  }
  if (r.error) {
    if (opts.json) out.write(JSON.stringify(r, null, 2) + '\n');
    else err.write(`roostr respawn: ${r.error}\n`);
    return 1;
  }
  if (r.plan) {
    if (opts.json) out.write(JSON.stringify(r, null, 2) + '\n');
    else {
      out.write(`Respawn ${r.workspace.label} (${r.workspace.id}): ${r.agents} agents, ${r.resumed} with a session.\n`);
      if (r.unknown.length) out.write(`No session for: ${r.unknown.join(', ')}\n`);
      out.write('\nRun again with --yes to close and rebuild this workspace.\n');
    }
    return 0;
  }
  if (opts.json) out.write(JSON.stringify(r, null, 2) + '\n');
  else {
    out.write(`Respawned ${r.label}${r.workspaceId ? ` (${r.workspaceId})` : ''}: ${r.panes} panes, ${r.agents} agents, ${r.sessions.length} sessions resumed.\n`);
    for (const s of r.sessions) out.write(`  resumed: ${s.name} (${s.agent}) · ${s.session}\n`);
    for (const e of r.errors) out.write(`  failed: ${e}\n`);
  }
  return r.errors.length ? 1 : 0;
}

module.exports = { parseArgs, resolveWorkspace, run, main, USAGE };
