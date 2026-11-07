'use strict';
// `crew-board restore [--workspace <id|label|here|all>] [--yes] [--dry-run]`
//
// Reads the auto saved session snapshot and reopens the agent panes of one
// workspace. Without --yes it only prints the plan. Panes keep their saved
// workspace, working directory, agent kind, name and task line. The model is
// passed only when a report supplied it exactly; a model read from the screen
// is a display name, not a CLI id, so it is left out. Effort is passed where
// the agent supports it, and the agent's own resume flag is passed when the
// snapshot had a session id.

const herdr = require('./herdr');
const sessions = require('./sessions');

const PANE_ID_NAME = /^w[0-9a-z]+[-:]p[0-9a-z]+$/i;

const USAGE = 'usage: crew-board restore [--workspace <id|label|here|all>] [--yes] [--dry-run] [--json] [--focus|--no-focus] [--file <path>]';

function parseArgs(argv) {
  const opts = {
    workspace: null, yes: false, dryRun: false, json: false, file: null, focus: null, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--focus') opts.focus = true;
    else if (a === '--no-focus') opts.focus = false;
    else if (a === '--here') opts.workspace = 'here';
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--workspace' || a === '-w') {
      const v = argv[++i];
      if (v === undefined) return { error: '--workspace needs a value' };
      opts.workspace = v;
    } else if (a === '--file') {
      const v = argv[++i];
      if (v === undefined) return { error: '--file needs a value' };
      opts.file = v;
    } else return { error: `unknown option ${a}` };
  }
  return opts;
}

function sameText(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

async function snapshot() {
  try {
    return await herdr.snapshot();
  } catch (e) {
    return { agents: [], panes: [], workspaces: [] };
  }
}

function workspaceById(snap, id) {
  const w = snap.workspaces.find((x) => x.workspace_id === id);
  return w ? { id: w.workspace_id, label: w.label || w.workspace_id } : { id, label: null };
}

function currentWorkspace(snap) {
  const id = process.env.HERDR_WORKSPACE_ID;
  if (id) return workspaceById(snap, id);
  const focused = snap.panes.find((p) => p.focused);
  return focused ? workspaceById(snap, focused.workspace_id) : null;
}

function resolveWorkspace(value, snap) {
  if (!value || value === 'here') return currentWorkspace(snap);
  if (value === 'all') return null;
  const byId = snap.workspaces.find((w) => w.workspace_id === value);
  if (byId) return { id: byId.workspace_id, label: byId.label || byId.workspace_id };
  const byLabel = snap.workspaces.find((w) => sameText(w.label, value));
  if (byLabel) return { id: byLabel.workspace_id, label: byLabel.label || byLabel.workspace_id };
  return { id: null, label: value };
}

function livePanes(snap, workspace) {
  if (!workspace || !workspace.id) return [];
  const agents = new Map(snap.agents.map((a) => [a.pane_id, a]));
  return snap.panes
    .filter((p) => p.workspace_id === workspace.id)
    .map((p) => {
      const a = agents.get(p.pane_id) || {};
      return {
        paneId: p.pane_id, cwd: p.cwd, label: p.label, name: a.name, agent: a.agent,
        tab: p.tab_id, focused: Boolean(p.focused),
      };
    });
}



function summary(workspace, restored, skipped, failed) {
  const name = workspace ? `${workspace.label || workspace.id || '?'}${workspace.id ? ` (${workspace.id})` : ''}` : 'all workspaces';
  const lines = [`Restore in ${name}.`];
  if (restored.length) {
    lines.push(`Restored ${restored.length} pane${restored.length === 1 ? '' : 's'}:`);
    for (const r of restored) {
      const state = r.started ? `${r.agent} started` : (r.agent ? 'shell only' : 'shell');
      lines.push(`  ${r.paneId}  ${r.name || '?'} · ${state} · ${r.cwd || '?'}`);
      if (r.warning) lines.push(`    warning: ${r.warning}`);
    }
  }
  if (skipped.length) {
    lines.push(`Skipped ${skipped.length}:`);
    for (const s of skipped) lines.push(`  ${s.session.name || '?'} (${s.session.paneId}) · ${s.reason}`);
  }
  if (failed.length) {
    lines.push(`Failed ${failed.length}:`);
    for (const f of failed) lines.push(`  ${f.name || '?'} · ${f.error}`);
  }
  if (!restored.length && !skipped.length && !failed.length) lines.push('Nothing to open.');
  return lines.join('\n') + '\n';
}

async function execute(plan, workspace, opts) {
  const skipped = plan.entries.filter((e) => e.action === 'skip');
  const wanted = plan.entries.filter((e) => e.action === 'open');
  const result = { workspace, restored: [], skipped, failed: [] };
  if (!wanted.length) return { code: 0, result };
  const all = !workspace;
  const creates = workspace && workspace.label && !workspace.id;
  if (!plan.live.length && !all && !creates) {
    result.failed.push({ name: null, error: 'no live pane in this workspace to split from' });
    return { code: 1, result };
  }
  const taken = new Set(plan.taken || plan.live.filter((p) => p.name).map((p) => p.name));
  const selected = wanted.map(({ session }) => {
    // An unnamed pane was saved under its pane id (w1E:p1, or w1e-p1 after an
    // earlier restore). That id means nothing in the new session: use the kind.
    const unnamed = !session.name || session.name === session.paneId || PANE_ID_NAME.test(session.name);
    const name = sessions.agentName(unnamed ? session.agent : session.name, taken);
    taken.add(name);
    return {
      ...session,
      workspace: workspace && workspace.label ? workspace.label : session.workspace,
      workspaceId: workspace && workspace.id ? workspace.id : session.workspaceId,
      name,
    };
  });
  const runner = (opts && opts.herdr) || herdr;
  const run = await sessions.restoreSessions(selected, { herdr: runner });
  for (const item of run.items || []) {
    result.restored.push({ ...item, started: true, warning: null });
  }
  for (const error of run.errors || []) result.failed.push({ name: null, error });
  if (run.message) result.failed.push({ name: null, error: run.message });
  if (result.restored.length < selected.length && !result.failed.length) {
    result.skipped.push({ session: { name: null, paneId: null }, reason: `${selected.length - result.restored.length} already running` });
  }
  return { code: result.failed.length ? 1 : 0, result };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (opts.error) {
    process.stderr.write(`crew-board restore: ${opts.error}\n${USAGE}\n`);
    return 2;
  }
  const list = sessions.loadSessions(opts.file);
  const needsLive = opts.yes || (opts.workspace && opts.workspace !== 'all');
  const snap = needsLive ? await snapshot() : { agents: [], panes: [], workspaces: [] };
  const workspace = resolveWorkspace(opts.workspace, snap);
  // A plan without --yes may span every workspace; a real restore needs one.
  const all = opts.workspace === 'all';
  if (opts.yes && !workspace && !all) {
    process.stderr.write(`crew-board restore: cannot find the current workspace, pass --workspace <id|label> or --workspace all\n`);
    return 2;
  }
  const scoped = opts.yes || opts.workspace ? sessions.workspaceSessions(list, workspace) : list;
  const live = workspace ? livePanes(snap, workspace) : [];
  const taken = new Set((snap.agents || []).map((a) => a.name).filter(Boolean));
  const entries = sessions.planRestore(scoped, workspace, live);

  if (!opts.yes || opts.dryRun) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ workspace, entries: entries.map((e) => ({ ...e.session, action: e.action, reason: e.reason })) }, null, 2) + '\n');
    } else if (scoped.length) {
      process.stdout.write(sessions.formatRestorePlan(scoped));
      const skips = entries.filter((e) => e.action === 'skip');
      if (skips.length) process.stdout.write(`\n${skips.length} already open or not restorable; the plan above shows what would open.\n`);
      process.stdout.write(opts.dryRun ? '\nDry run: no panes were opened.\n' : '\nRun with --yes to open these panes.\n');
    } else {
      process.stdout.write('No saved sessions for this workspace. Nothing to restore.\n');
    }
    return 0;
  }

  const run = await execute({ entries, live, taken }, workspace, opts);
  const shouldFocus = opts.focus === null ? Boolean(workspace) : opts.focus;
  if (shouldFocus && run.result.restored.length) {
    const focusId = run.result.restored.find((r) => r.workspaceId) || null;
    if (focusId) await herdr.focusWorkspace(focusId.workspaceId).catch(() => {});
  }
  if (opts.json) process.stdout.write(JSON.stringify(run.result, null, 2) + '\n');
  else process.stdout.write(summary(workspace, run.result.restored, run.result.skipped, run.result.failed));
  return run.code;
}

module.exports = { parseArgs, resolveWorkspace, livePanes, execute, main, USAGE };
