'use strict';
// Saved sessions: a compact snapshot of every live agent pane, written on each
// board tick so a crash or restart still knows which workspaces, panes,
// directories, models and tasks were open. The file is small and disposable.
//
// Default location is ~/.crew-board/sessions.json. CREW_BOARD_STATE_DIR moves
// it into that directory instead. Writes go to a temp file and are then
// renamed, so a crash never leaves half a JSON document behind.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Per file memory: the last payload written, plus each pane's signature and
// updatedAt, so unchanged panes keep their original timestamp and unchanged
// snapshots never touch the disk.
const memory = new Map();

function sessionsFile(filePath) {
  if (filePath) return path.resolve(filePath);
  if (process.env.CREW_BOARD_STATE_DIR) {
    return path.join(process.env.CREW_BOARD_STATE_DIR, 'sessions.json');
  }
  return path.join(os.homedir(), '.crew-board', 'sessions.json');
}

function clean(value, max = 240) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function modelValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return clean(value.v);
  return clean(value);
}

// A session id only helps a restore when the agent's own CLI accepts it. A
// statusline written for Claude on an opencode pane, or a stale report from a
// reused pane id, must never reach --session/--resume: the agent would refuse
// to start, or resume an unrelated conversation.
const SESSION_ID = {
  opencode: /^ses_[A-Za-z0-9]+$/,
};

function validSession(kind, id) {
  if (typeof id !== 'string' || !id) return false;
  const pattern = SESSION_ID[String(kind || '').toLowerCase()];
  return pattern ? pattern.test(id) : /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function labelParts(label) {
  if (typeof label !== 'string') return { name: null, task: null };
  const text = label.replace(/^[^\p{L}\p{N}]+/u, '').trim();
  if (!text) return { name: null, task: null };
  const i = text.indexOf(' · ');
  if (i < 0) return { name: clean(text), task: null };
  return { name: clean(text.slice(0, i)), task: clean(text.slice(i + 3)) };
}

// A board row, plus the snapshot when the caller attached one, so a board
// scoped to one workspace still saves every live agent pane.
function rowsFromModel(model) {
  if (!model || typeof model !== 'object') return [];
  if (Array.isArray(model.rows)) {
    const rowById = new Map(model.rows.map((r) => [r.paneId, r]));
    const snap = model.snapshot && Array.isArray(model.snapshot.agents) ? model.snapshot : null;
    const snapAgents = new Map((snap ? snap.agents : []).filter((a) => a && a.pane_id).map((a) => [a.pane_id, a]));
    const byId = new Map();
    for (const r of model.rows) byId.set(r.paneId, fromRow(r, model, snapAgents.get(r.paneId)));
    if (snap) {
      const panes = new Map((snap.panes || []).map((p) => [p.pane_id, p]));
      const workspaces = new Map((snap.workspaces || []).map((w) => [w.workspace_id, w]));
      for (const a of snap.agents) {
        if (!a || !a.pane_id || rowById.has(a.pane_id)) continue;
        byId.set(a.pane_id, fromAgent(a, panes.get(a.pane_id) || {}, workspaces.get(a.workspace_id) || {}));
      }
    }
    return [...byId.values()];
  }
  // A caller may pass a snapshot alone, or the snapshot attached to a model.
  const snap = model.snapshot && typeof model.snapshot === 'object' ? model.snapshot : null;
  const agents = Array.isArray(model.agents) ? model.agents : (snap && snap.agents);
  if (Array.isArray(agents)) {
    const panes = new Map(((Array.isArray(model.panes) ? model.panes : (snap && snap.panes) || [])).map((p) => [p.pane_id, p]));
    const workspaces = new Map(((Array.isArray(model.workspaces) ? model.workspaces : (snap && snap.workspaces) || [])).map((w) => [w.workspace_id, w]));
    return agents.filter((a) => a && a.pane_id)
      .map((a) => fromAgent(a, panes.get(a.pane_id) || {}, workspaces.get(a.workspace_id) || {}));
  }
  return [];
}

function fromRow(row, model, agent) {
  const reverse = new Map();
  const workspaces = model.workspaces instanceof Map ? model.workspaces : new Map();
  for (const [id, label] of workspaces) if (!reverse.has(label)) reverse.set(label, id);
  const workspace = clean(row.workspace);
  const kind = clean(row.kind);
  // The report is authoritative for numbers, but a session id from a statusline
  // written for another agent (a UUID on an opencode pane) must not win.
  const reported = clean(row.session, 128);
  return {
    paneId: clean(row.paneId),
    workspace,
    workspaceId: clean(row.workspaceId) || reverse.get(workspace) || null,
    name: clean(row.name) || clean(row.paneId),
    cwd: clean(row.cwd),
    agent: kind,
    model: modelValue(row.model),
    modelSrc: row.model && typeof row.model === 'object' ? clean(row.model.src) : null,
    effort: clean(row.effort),
    status: clean(row.status),
    task: clean(row.task),
    session: validSession(kind, reported) ? reported : agentSession(kind, agent),
  };
}

// Herdr reports an agent's session as agent_session.value. Older snapshots
// only carry session_id, so both are read, newest form last.
function agentSession(kind, agent) {
  if (!agent) return null;
  const direct = clean(agent.session_id, 128);
  if (validSession(kind, direct)) return direct;
  const reported = clean(agent.agent_session && agent.agent_session.value, 128);
  return validSession(kind, reported) ? reported : null;
}

function fromAgent(agent, pane, workspace) {
  const parsed = labelParts(pane.label);
  return {
    paneId: clean(agent.pane_id),
    workspace: clean(workspace.label) || clean(agent.workspace_id),
    workspaceId: clean(agent.workspace_id) || clean(workspace.workspace_id),
    name: clean(agent.name) || parsed.name || clean(agent.pane_id),
    cwd: clean(agent.cwd) || clean(pane.cwd),
    agent: clean(agent.agent),
    model: null,
    modelSrc: null,
    effort: null,
    status: clean(agent.agent_status),
    task: parsed.task,
    session: agentSession(clean(agent.agent), agent),
  };
}

function signature(session) {
  return JSON.stringify([
    session.paneId, session.workspace, session.workspaceId, session.name, session.cwd,
    session.agent, session.model, session.modelSrc, session.effort, session.status, session.task, session.session,
  ]);
}

function compare(a, b) {
  return String(a.workspaceId || '').localeCompare(String(b.workspaceId || ''))
    || String(a.paneId || '').localeCompare(String(b.paneId || ''));
}

// Board model or Herdr snapshot -> sorted session array. updatedAt is added by
// saveSessions, which knows whether the pane actually changed.
function extractSessions(model) {
  return rowsFromModel(model)
    .filter((s) => s.paneId)
    .sort(compare);
}

function readExisting(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(saved)) return null;
    const byPane = new Map();
    for (const s of saved) {
      if (!s || typeof s !== 'object' || !s.paneId) continue;
      byPane.set(s.paneId, { sig: signature(s), updatedAt: clean(s.updatedAt) });
    }
    return { json: JSON.stringify(saved, null, 2) + '\n', byPane };
  } catch (e) {
    return null;
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  // Keep the snapshot from just before this write. After a restart a board
  // can see only a subset of the old panes; this copy still has all of them.
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.bak`);
      fs.chmodSync(`${file}.bak`, 0o600);
    }
  } catch (e) {
    // A failed backup must not stop the snapshot itself.
  }
  fs.renameSync(tmp, file);
}

// Save the model. Returns { written, file, sessions }. A snapshot whose panes
// all match the last save is skipped, so a live board is not a disk ticker.
function saveSessions(model, filePath, options = {}) {
  const file = sessionsFile(filePath);
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const extracted = extractSessions(model);
  let previous = memory.get(file);
  if (!previous) {
    previous = readExisting(file) || { json: null, byPane: new Map() };
    memory.set(file, previous);
  }
  // A board that starts before its agents come back sees an empty session.
  // Never replace a real snapshot with it.
  if (!extracted.length && previous.json && previous.json.trim() !== '[]') {
    return { written: false, file, sessions: [] };
  }
  const sessions = extracted.map((s) => {
    const sig = signature(s);
    const old = previous.byPane.get(s.paneId);
    const updatedAt = old && old.sig === sig ? old.updatedAt : new Date(now).toISOString();
    return { ...s, updatedAt };
  });
  const json = JSON.stringify(sessions, null, 2) + '\n';
  if (previous.json === json) {
    try {
      if (fs.readFileSync(file, 'utf8') === json) return { written: false, file, sessions };
    } catch (e) {
      // the file vanished, so write it again below
    }
  }
  writeAtomic(file, json);
  memory.set(file, {
    json,
    byPane: new Map(sessions.map((s) => [s.paneId, { sig: signature(s), updatedAt: s.updatedAt }])),
  });
  return { written: true, file, sessions };
}

function loadSessions(filePath) {
  const file = sessionsFile(filePath);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(saved)) return [];
    return saved.filter((s) => s && typeof s === 'object' && typeof s.paneId === 'string');
  } catch (e) {
    return [];
  }
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Plain text list, one line per saved pane.
function formatSessionList(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!list.length) return 'No saved sessions.\n';
  return list.map((s) => [
    s.workspace || '?',
    `${s.name || '?'} (${s.paneId})`,
    s.agent || '?',
    s.model || '?',
    s.status || '?',
    s.task || '?',
  ].join(' · ')).join('\n') + '\n';
}

// Human readable restore plan: workspaces, panes, directories, models, tasks.
function formatRestorePlan(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!list.length) return 'No saved sessions. Nothing to restore.\n';
  const groups = new Map();
  for (const s of [...list].sort(compare)) {
    const key = `${s.workspaceId || ''}\u0000${s.workspace || ''}`;
    if (!groups.has(key)) groups.set(key, { workspace: s.workspace, workspaceId: s.workspaceId, items: [] });
    groups.get(key).items.push(s);
  }
  const latest = list.map((s) => s.updatedAt).filter(Boolean).sort().pop() || '?';
  const lines = [`${plural(list.length, 'session')} in ${plural(groups.size, 'workspace')}, last saved ${latest}.`];
  for (const group of groups.values()) {
    lines.push('');
    lines.push(`${group.workspace || '?'} (${group.workspaceId || '?'})`);
    group.items.forEach((s, i) => {
      const details = [s.agent || '?', s.model || '?', s.effort || '?', s.status || '?'].join(' · ');
      lines.push(`  ${i + 1}. ${s.name || '?'} (${s.paneId}) · ${details}`);
      lines.push(`     cwd: ${s.cwd || '?'}`);
      lines.push(`     task: ${s.task || '?'}`);
      if (s.session) lines.push(`     session: ${s.session}`);
    });
  }
  return lines.join('\n') + '\n';
}

// Sessions that belong to a workspace: id first, label as the fallback after a
// restart gives the workspace a new id.
function workspaceSessions(list, workspace) {
  const sessions = Array.isArray(list) ? list : [];
  if (!workspace) return sessions;
  const id = workspace.id || null;
  const label = workspace.label || null;
  return sessions.filter((s) => (
    (id && s.workspaceId === id) || (label && s.workspace === label)
  ));
}

function sameText(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

// Pure restore plan. `live` is the current workspace's panes as
// { cwd, label, name, agent }. A saved pane is skipped when a live pane has
// the same directory and name, so pressing the key twice cannot double a crew.
function planRestore(list, workspace, live = []) {
  const entries = workspaceSessions(list, workspace).map((session) => {
    if (!session.cwd) return { session, action: 'skip', reason: 'no working directory' };
    const hit = live.some((p) => {
      const parsed = labelParts(p.label);
      const name = p.name || parsed.name;
      return p.cwd === session.cwd && (sameText(name, session.name)
        || (!session.name && sameText(p.agent, session.agent)));
    });
    if (hit) return { session, action: 'skip', reason: 'already open' };
    return { session, action: 'open', reason: null };
  });
  return entries;
}

// A Herdr agent name: [a-z][a-z0-9_-]{0,31}, unique among live agents.
function agentName(name, taken = new Set()) {
  let base = String(name || 'restore').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 28);
  if (!base) base = 'restore';
  let out = base;
  let n = 2;
  while (taken.has(out)) out = `${base.slice(0, 27)}-${n++}`;
  return out;
}

const USAGE = 'usage: roostr sessions [--json] [--file <path>]';

function parseArgs(argv) {
  const opts = { json: false, dryRun: false, yes: false, file: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-y' || a === '--yes') opts.yes = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--file') {
      const v = argv[++i];
      if (v === undefined) return { error: '--file needs a value' };
      opts.file = v;
    } else return { error: `unknown option ${a}` };
  }
  return opts;
}

// Before a restore, a saved pane may have no usable session id because it died
// before the board resolved it. Match the saved pane against the agent's own
// store by directory and the task or name in the title. A weak match is
// skipped: a blank session is better than someone else's conversation.
async function resolveSavedSessions(entries, options = {}) {
  const list = Array.isArray(entries) ? entries.filter((s) => s && s.agent && s.cwd) : [];
  const need = list.filter((s) => String(s.agent).toLowerCase() === 'opencode' && !validSession(s.agent, s.session));
  if (!need.length) return [];
  let store;
  try { store = await opencodeSessionList(options); } catch (e) { return []; }
  const claimed = new Set(list.filter((s) => validSession(s.agent, s.session)).map((s) => s.session));
  const out = [];
  for (const s of need) {
    const task = String(s.task || '').trim().toLowerCase();
    const name = String(s.name || '').trim().toLowerCase();
    const candidates = store.filter((x) => x && typeof x.id === 'string' && x.directory === s.cwd && !claimed.has(x.id));
    let best = null;
    let bestScore = 0;
    for (const x of candidates) {
      const title = String(x.title || '').trim().toLowerCase();
      let score = 0;
      if (title && task && title === task) score = 4;
      else if (title && task && (title.includes(task) || task.includes(title))) score = 3;
      else if (title && name && name.length > 2 && title.includes(name)) score = 2;
      if (score > bestScore || (score === bestScore && score > 0 && (x.updated || 0) > (best ? best.updated || 0 : 0))) {
        best = x;
        bestScore = score;
      }
    }
    if (!best || !bestScore) continue;
    claimed.add(best.id);
    s.session = best.id;
    out.push({ paneId: s.paneId, session: best.id, saved: s.saved || null });
  }
  return out;
}


// The agent's own CLI flags to reopen a saved session. A model read from a
// screen is a display name, not a CLI id, so it is passed only when a report
// supplied it exactly. Older snapshots have no source and count as a guess.
function agentArgs(s) {
  const exactModel = s.model && s.modelSrc === 'exact' ? s.model : null;
  const args = [];
  const session = validSession(s.agent, s.session) ? s.session : null;
  if (s.agent === 'claude') {
    if (session) args.push('--resume', session);
    if (exactModel) args.push('--model', exactModel);
    if (s.effort) args.push('--effort', s.effort);
  } else if (s.agent === 'opencode' || s.agent === 'kilo') {
    if (session) args.push('--session', session);
    if (exactModel) args.push('--model', exactModel);
  } else if (s.agent === 'agy' || s.agent === 'antigravity') {
    if (session) args.push('--conversation', session);
    if (s.effort) args.push('--effort', s.effort);
  }
  return args;
}

// The agent's own session store, cached briefly: a board tick is every 2 s and
// spawning the CLI on each one would cost more than the feature is worth.
const SESSION_LIST_TTL_MS = 10000;
const sessionListCache = new Map(); // kind:bin -> { at, list }

function execJson(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

// The CLI that owns a kind's session store. opencode and kilo expose the same
// `session list --format json` command.
function sessionBin(kind, options = {}) {
  if (options.bin) return options.bin;
  const k = String(kind || 'opencode').toLowerCase();
  if (k === 'kilo') return process.env.ROOSTR_KILO_BIN || 'kilo';
  return options.opencodeBin || process.env.ROOSTR_OPENCODE_BIN || process.env.CREW_BOARD_OPENCODE_BIN || 'opencode';
}

async function sessionList(kind, options = {}) {
  const now = options.now || Date.now();
  const k = String(kind || 'opencode').toLowerCase();
  const bin = sessionBin(k, options);
  const key = `${k}:${bin}`;
  const hit = sessionListCache.get(key);
  if (!options.noCache && hit && now - hit.at < SESSION_LIST_TTL_MS) return hit.list;
  const list = await execJson(bin, ['session', 'list', '--format', 'json', '-n', String(options.limit || 200)], options.timeout || 4000);
  const items = Array.isArray(list) ? list.filter((s) => s && typeof s.id === 'string') : [];
  sessionListCache.set(key, { at: now, list: items });
  return items;
}

function opencodeSessionList(options = {}) {
  return sessionList('opencode', options);
}

// opencode puts "<title>" in the terminal title as "OC | <title>".
function opencodeTitle(agent) {
  const raw = typeof agent.terminal_title_stripped === 'string' ? agent.terminal_title_stripped : agent.terminal_title;
  const m = typeof raw === 'string' ? /^OC\s*\|\s*(.+)$/i.exec(raw) : null;
  return m ? m[1].trim() : null;
}

// Fill a Herdr snapshot's agent.session_id from the agent's own session store.
// Herdr only knows a session id when something reported one and opencode does
// not, so backups would otherwise save null or a foreign id. Matching is
// conservative: same directory and the exact title opencode shows. No match
// stays unknown; a restore then starts fresh instead of resuming the wrong chat.
async function resolveAgentSessions(snap, options = {}) {
  const agents = snap && Array.isArray(snap.agents) ? snap.agents : [];
  // Herdr may already know the session id even when no report did. Promote it
  // before the store lookup, so a pane is never matched to a second session.
  for (const a of agents) {
    if (!a || !a.pane_id || validSession(a.agent, a.session_id)) continue;
    const known = clean(a.agent_session && a.agent_session.value, 128);
    if (validSession(a.agent, known)) a.session_id = known;
  }
  const unresolved = agents.filter((a) => a && a.pane_id && a.agent && !validSession(a.agent, a.session_id));
  if (!unresolved.some((a) => String(a.agent).toLowerCase() === 'opencode')) return [];
  let list;
  try { list = await opencodeSessionList(options); } catch (e) { return []; }
  const taken = new Set(agents.filter((a) => a && validSession(a.agent, a.session_id)).map((a) => a.session_id));
  const resolved = [];
  for (const a of unresolved) {
    if (String(a.agent).toLowerCase() !== 'opencode') continue;
    const title = opencodeTitle(a);
    if (!title) continue;
    const hit = list.find((s) => s && typeof s.id === 'string' && !taken.has(s.id)
      && s.directory === a.cwd && String(s.title || '').trim() === title);
    if (!hit) continue;
    taken.add(hit.id);
    a.session_id = hit.id;
    resolved.push({ paneId: a.pane_id, kind: 'opencode', session: hit.id });
    if (options.writeBack && options.herdr && typeof options.herdr.reportAgentSession === 'function') {
      try { await options.herdr.reportAgentSession(a.pane_id, 'opencode', hit.id); } catch (e) { /* metadata is best effort */ }
    }
  }
  return resolved;
}

async function restoreSessions(sessions, options = {}) {
  const herdr = options.herdr || require('./herdr');
  const dryRun = !!options.dryRun;
  const list = Array.isArray(sessions) ? sessions : [];

  if (dryRun) {
    return {
      dryRun: true,
      restored: 0,
      total: list.length,
      plan: formatRestorePlan(list),
    };
  }

  const valid = list.filter((s) => s && s.agent && s.cwd);
  if (!valid.length) {
    return { dryRun: false, restored: 0, total: 0, items: [], errors: [], message: 'No valid sessions to restore.' };
  }

  const selected = Array.isArray(options.selected) ? options.selected : valid;
  if (!selected.length) {
    return { dryRun: false, restored: 0, total: valid.length, items: [], errors: [], message: 'No sessions selected.' };
  }

  let live = { workspaces: [], panes: [], agents: [] };
  try {
    live = await herdr.snapshot();
  } catch (_) {}

  const liveWsById = new Map((live.workspaces || []).map((w) => [w.workspace_id, w]));
  // Labels repeat (two "co-co" workspaces), so a label only finds a workspace
  // when exactly one live workspace has it. The saved id always wins.
  const labelCount = new Map();
  for (const w of live.workspaces || []) labelCount.set(w.label, (labelCount.get(w.label) || 0) + 1);
  const liveWsByLabel = new Map((live.workspaces || []).filter((w) => labelCount.get(w.label) === 1).map((w) => [w.label, w]));
  const livePaneById = new Map((live.panes || []).map((p) => [p.pane_id, p]));
  const agentPanes = new Set((live.agents || []).map((a) => a.pane_id));

  const livePanesByWs = new Map();
  for (const p of live.panes || []) {
    if (!p.workspace_id) continue;
    if (!livePanesByWs.has(p.workspace_id)) livePanesByWs.set(p.workspace_id, []);
    livePanesByWs.get(p.workspace_id).push(p);
  }

  // Keyed by workspace, directory and agent kind. Empty name means the live
  // name was unknown, so any saved name of that shape is treated as running.
  const existingAgents = new Map();
  for (const a of live.agents || []) {
    const key = `${a.workspace_id || ''}:${a.cwd || ''}:${a.agent || ''}`;
    if (!existingAgents.has(key)) existingAgents.set(key, new Set());
    if (a.name) existingAgents.get(key).add(a.name);
  }

  const groups = new Map();
  for (const s of [...selected].sort(compare)) {
    const key = s.workspaceId && liveWsById.has(s.workspaceId) ? s.workspaceId : (s.workspace || s.workspaceId || 'workspace');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const restored = [];
  const errors = [];

  for (const [key, items] of groups) {
    const ws = liveWsById.get(key) || liveWsByLabel.get(key);
    const wsLabel = items[0].workspace || key;
    let targetWsId = ws ? ws.workspace_id : null;
    let availableRootPane = null;
    let lastPaneId = null;

    if (!ws) {
      try {
        const created = await herdr.createWorkspace(wsLabel, items[0].cwd, true);
        targetWsId = created.workspaceId;
        availableRootPane = created.rootPaneId;
        lastPaneId = created.rootPaneId;
      } catch (e) {
        errors.push(`failed to create workspace ${wsLabel}: ${e.message}`);
        continue;
      }
    } else {
      const existingPanes = livePanesByWs.get(targetWsId) || [];
      if (existingPanes.length > 0) {
        lastPaneId = existingPanes[existingPanes.length - 1].pane_id;
      }
    }

    for (const s of items) {
      const agentName = s.name || s.agent || 'agent';
      const key = `${targetWsId}:${s.cwd}:${s.agent}`;
      const running = existingAgents.get(key);
      if (running && (running.size === 0 || running.has(agentName))) {
        continue;
      }

      let paneId = null;
      let parentPaneId = null;
      let started = false;
      try {
        // Herdr brings back its own layout after a restart: the agent's old
        // pane is there again, as an empty shell. Start the agent in it
        // instead of splitting a new pane beside it.
        const old = livePaneById.get(s.paneId);
        if (old && old.workspace_id === targetWsId && !agentPanes.has(old.pane_id)
          && (!old.cwd || old.cwd === s.cwd)) {
          paneId = old.pane_id;
          agentPanes.add(paneId);
        } else if (availableRootPane) {
          paneId = availableRootPane;
          availableRootPane = null;
        } else if (lastPaneId) {
          parentPaneId = lastPaneId;
          paneId = await herdr.splitPane(lastPaneId, 'right', s.cwd, true);
          lastPaneId = paneId;
        }

        if (!paneId) {
          errors.push(`could not allocate pane for ${s.name || s.agent} in ${wsLabel}`);
          continue;
        }

        await herdr.startAgent(agentName, s.agent, paneId, agentArgs(s));
        started = true;

        const label = s.task ? `${agentName} · ${s.task}` : agentName;
        await herdr.renamePane(paneId, label);

        if (!existingAgents.has(key)) existingAgents.set(key, new Set());
        existingAgents.get(key).add(agentName);
        restored.push({ paneId, workspace: wsLabel, workspaceId: targetWsId, name: agentName, agent: s.agent, cwd: s.cwd });
      } catch (e) {
        // A pane split for this agent is empty now: close it instead of
        // leaving an orphan. A new workspace's root pane stays (the next
        // agent uses it), and a pane that already started an agent runs on.
        if (paneId && parentPaneId && !started) {
          try {
            await herdr.closePane(paneId);
          } catch (_) {}
          if (lastPaneId === paneId) lastPaneId = parentPaneId;
        }
        errors.push(`failed to restore ${s.name || s.agent}: ${e.message}`);
      }
    }
  }

  return {
    dryRun: false,
    restored: restored.length,
    total: selected.length,
    items: restored,
    errors,
  };
}

function mainSessions(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (opts.error) {
    process.stderr.write(`roostr sessions: ${opts.error}\n${USAGE}\n`);
    return 2;
  }
  const list = loadSessions(opts.file);
  process.stdout.write(opts.json ? JSON.stringify(list, null, 2) + '\n' : formatSessionList(list));
  return 0;
}

module.exports = {
  sessionsFile, extractSessions, saveSessions, loadSessions,
  formatRestorePlan, formatSessionList, mainSessions, restoreSessions, USAGE,
  workspaceSessions, planRestore, agentName, agentArgs, validSession, resolveAgentSessions, resolveSavedSessions,
  sessionList, sessionBin,
};
