'use strict';
// The board: one row per agent pane with its colour tag, name, agent kind and
// model, status and time in status, context / tokens / cost, task line, and
// check badges. Data sources, best first:
//   name              the pane label "name · task" (set by the lead)
//   task line         the label, else an exact report, else the terminal title
//   ctx, tokens, cost an exact `crew-board report`, else the agent's footer
//   model             exact report, else the crew file, else the footer
//   effort            exact report only
//   ram               the pane's process tree, from one `ps` call
//   today's spend     tokscale, when installed (optional)
//   anything else     "?" (never a guess)

const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');
const herdr = require('./herdr');
const { parseScreen, hasAdapter } = require('./adapters');
const crewfile = require('./crewfile');
const checks = require('./checks');
const ram = require('./ram');
const burn = require('./burn');
const tokscale = require('./tokscale');
const codex = require('./codex');
const experiential = require('./experiential');
const update = require('./update');
const { readReport, pruneReports, writeReport, appendUsage, USAGE: REPORT_USAGE } = require('./report');
const advisor = require('./advisor');
const config = require('./config');
const orchestrator = require('./orchestrator');
const { VERSION, COMMIT, label: buildLabel } = require('./version');
const pricing = require('./pricing');
const state = require('./state');
const sessions = require('./sessions');
const backup = require('./backup');
const sessionLog = require('./session-log');
const ledger = require('./ledger');
const ui = require('./ui');
const names = require('./names');
const recover = require('./recover');
const surge = require('./surge');
const tasks = require('./tasks');
const analytics = require('./analytics');
const daemon = require('./daemon');
const summary = require('./summary');

const { C, bold } = ui;

// This device's exact build: the release version, plus the commit when the
// plugin runs from a git checkout (the normal case while a branch is ahead of
// its last tag), plus a star for uncommitted edits. Two devices showing the
// same label run the same code.
const VERSION_LABEL = buildLabel();

// Squares first, then circles, so up to 18 panes get a mark of their own.
// The palette avoids black, white and brown, which vanish on some themes.
const TAGS = [
  '🟦', '🟩', '🟨', '🟪', '🟧', '🟥',
  '🔵', '🟢', '🟡', '🟣', '🟠', '🔴',
  '🔷', '🔶', '🔸', '🔹',
  '🔺', '🔻',
];
// Old marks are stripped so a label written before the palette change still
// parses; they are never assigned.
const LEGACY_TAGS = ['⬜', '⬛', '⚪', '⚫', '🟫', '🟤'];
const TAG_RE = new RegExp(`^(?:${[...TAGS, ...LEGACY_TAGS].join('|')})\\s*`, 'u');
const SEP = ' · ';
const STATUS_GLYPH = { working: '●', idle: '○', blocked: '◼', done: '✓', unknown: '?' };
const STATUS_PAINT = { working: C.green, idle: C.amber, blocked: C.red, done: C.cyan, unknown: C.dim };
// A status change seen within this gap of the previous look has an exact start.
const WATCH_GAP_MS = 30 * 1000;
const RENAME_COOLDOWN_MS = 10 * 1000;
const DOUBLE_CLICK_MS = 400;
const RECOVER_CONFIRM_MS = 4000;
const IDLE_CONTINUE_MS = 10 * 60 * 1000;
// Sidebar tokens are rewritten when they change or every 30 s, and fade 90 s
// after the last write.
const TOKEN_REFRESH_MS = 30 * 1000;
const TOKEN_TTL_MS = 90 * 1000;
const TOKEN_NAMES = ['tag', 'name', 'task', 'model', 'ctx', 'cost', 'ram'];

// ------------------------------------------------------------------ labels

// "🟦 look · ship A2 + outline" -> { name: "look", task: "ship A2 + outline" }
function parseLabel(label) {
  if (typeof label !== 'string' || label.trim() === '') return { name: null, task: null };
  const clean = stripTag(ui.clean(label));
  const i = clean.indexOf(SEP);
  if (i < 0) return { name: clean || null, task: null };
  return { name: clean.slice(0, i).trim() || null, task: clean.slice(i + SEP.length).trim() || null };
}

function stripTag(label) {
  return String(label).replace(TAG_RE, '').trim();
}

// A second click on the same row inside the window jumps to the pane. A single
// click only selects, so a stray click cannot take the terminal to another pane.
function isDoubleClick(last, paneId, now, gap = DOUBLE_CLICK_MS) {
  return Boolean(last && paneId && last.paneId === paneId && now - last.at <= gap);
}

// ------------------------------------------------------------------ memory

function memFile() {
  return path.join(state.stateDir(), 'board.json');
}

function plainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function loadMemory() {
  const m = state.readJson(memFile());
  const src = plainObject(m) ? m : {};
  return {
    tags: plainObject(src.tags) ? src.tags : {},
    status: plainObject(src.status) ? src.status : {},
    prefs: plainObject(src.prefs) ? src.prefs : {},
  };
}

// `seen` only feeds exactness while this process runs, so it is not part of a
// saved status record.
function persistedStatus(status) {
  const out = {};
  for (const [id, rec] of Object.entries(status)) {
    if (!plainObject(rec)) {
      out[id] = rec;
      continue;
    }
    const { seen, ...rest } = rec;
    out[id] = rest;
  }
  return out;
}

// Several boards can share this file (one per workspace). Merge by pane
// before writing: this board's own panes (`own`) take its values, every other
// live pane keeps what is on disk, and dead panes go. Prefs take only the keys
// this board changed. The merge comes back into `mem`, so a new pane's colour
// also avoids marks other boards hold. Nothing changed means no write.
function saveMemory(mem, own = new Set(), live = null, touched = new Set()) {
  try {
    const disk = loadMemory();
    const pick = (ours, theirs) => {
      const out = {};
      for (const [k, v] of Object.entries(theirs)) if (!own.has(k) && (!live || live.has(k))) out[k] = v;
      for (const [k, v] of Object.entries(ours)) if (own.has(k) || !(k in out)) out[k] = v;
      if (live) for (const k of Object.keys(out)) if (!live.has(k)) delete out[k];
      return out;
    };
    const prefs = { ...disk.prefs };
    for (const k of touched) prefs[k] = mem.prefs[k];
    const next = { tags: pick(mem.tags, disk.tags), status: pick(mem.status, disk.status), prefs };
    // `seen` only feeds exactness while this process runs; a write per tick
    // would rewrite board.json even when nothing changed.
    const persisted = { tags: next.tags, status: persistedStatus(next.status), prefs };
    const onDisk = { tags: disk.tags, status: persistedStatus(disk.status), prefs: disk.prefs };
    Object.assign(mem, next);
    if (JSON.stringify(persisted) !== JSON.stringify(onDisk)) state.writeJson(memFile(), persisted);
  } catch (e) {
    if (process.env.CREW_BOARD_DEBUG) debugLog('saveMemory error', e.message);
    // A read only home dir costs the board its memory, not its rows.
  }
}

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

function debugLog(...args) {
  if (process.env.CREW_BOARD_DEBUG) console.error('[crew-board]', ...args);
}

// A colour tag per pane id: kept for as long as the pane lives, and picked
// from the marks no live pane uses yet. If two shown panes share a mark (more
// panes than marks earlier), the later one moves to a free mark.
function assignTags(mem, ids, livePaneIds) {
  for (const id of Object.keys(mem.tags)) if (!livePaneIds.has(id)) delete mem.tags[id];
  const used = new Set(Object.values(mem.tags));
  const shown = new Set();
  for (const id of ids) {
    const t = mem.tags[id];
    if (t && TAGS.includes(t) && !(shown.has(t) && TAGS.some((x) => !used.has(x)))) {
      shown.add(t);
      continue;
    }
    const pick = TAGS.find((x) => !used.has(x)) || TAGS[hash(id) % TAGS.length];
    mem.tags[id] = pick;
    used.add(pick);
    shown.add(pick);
  }
}

// Herdr gives a status and a change counter but no timestamp, so the board
// timestamps changes itself. A start it did not watch is a lower bound.
// `event`, when Herdr's status event hook recorded one for this pane, says
// exactly when the current status began, even if no board was watching.
function trackStatus(mem, agent, now, event = null) {
  const id = agent.pane_id;
  const status = agent.agent_status || 'unknown';
  const seq = agent.state_change_seq;
  const rec = mem.status[id];
  if (!rec) {
    mem.status[id] = { status, seq, since: now, exact: false, seen: now };
  } else if (rec.status !== status || rec.seq !== seq) {
    mem.status[id] = { status, seq, since: now, exact: now - rec.seen <= WATCH_GAP_MS, seen: now };
  } else {
    rec.seen = now;
  }
  const r = mem.status[id];
  if (event && event.status === status && typeof event.at === 'number' && event.at <= now) {
    r.since = event.at;
    r.exact = true;
  }
  return r;
}

// ------------------------------------------------------------------ model

function isBoardAgent(a, myPaneId) {
  if (myPaneId && a.pane_id === myPaneId) return true;
  const title = (a.terminal_title_stripped || '').trim();
  if (title === 'crew-board' || title === '🐓ROOSTR🐓') return true;
  const stripped = (a.label || '').replace(/^[^\s\w]+/, '').trim();
  if (stripped === '🐓ROOSTR🐓' || stripped === 'crew-board') return true;
  return false;
}

function selectAgents(snap, workspace, opts = {}) {
  const wsLabel = new Map(snap.workspaces.map((w) => [w.workspace_id, w.label]));
  const myPaneId = (opts && opts.myPaneId) || null;
  let agents = snap.agents.filter((a) => a && a.pane_id && !isBoardAgent(a, myPaneId));
  if (workspace) agents = agents.filter((a) => a.workspace_id === workspace || wsLabel.get(a.workspace_id) === workspace);
  const order = new Map(snap.workspaces.map((w, i) => [w.workspace_id, i]));
  return agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (order.get(x.a.workspace_id) ?? 1e9) - (order.get(y.a.workspace_id) ?? 1e9) || x.i - y.i)
    .map((x) => x.a);
}

// Fields a report did not cover, so the screen is worth reading.
function needsScreen(agent, report) {
  if (!hasAdapter(agent.agent)) return false;
  return !report || report.ctx == null || report.tokens == null || report.cost == null || report.model == null;
}

// The terminal title as a task line. Claude Code and opencode keep it set to a
// short summary of the session; their default titles say nothing.
const DEFAULT_TITLES = /^(claude code|claude|opencode|oc|kilo|kilo code|agy|antigravity|gemini|codex|zsh|bash|fish|sh)$/i;
function titleTask(a) {
  const t = ui.clean(a.terminal_title_stripped).replace(/^[A-Za-z]{2,12} \| /, '').trim();
  return t && !DEFAULT_TITLES.test(t) ? t : null;
}

function pick(...candidates) {
  for (const [v, src] of candidates) if (v !== null && v !== undefined && v !== '') return { v, src };
  return { v: null, src: 'unknown' };
}

// Pure: Herdr snapshot + screens + reports + crew files -> board model.
// `budget` is the --budget default; `trust` maps crew files to the content
// hash you allowed (a crew file runs commands, so a new or changed one runs
// none until you allow it).
function buildModel({
  snap, agents, screens = {}, reports = {}, events = {}, rss = {}, crewFor = () => null, mem, now, budget = null, trust = {}, tagScope = null,
}) {
  const paneById = new Map(snap.panes.map((p) => [p.pane_id, p]));
  const wsLabel = new Map(snap.workspaces.map((w) => [w.workspace_id, ui.clean(w.label) || w.workspace_id]));
  const live = new Set([...snap.panes.map((p) => p.pane_id), ...snap.agents.map((a) => a.pane_id)]);
  assignTags(mem, agents.map((a) => a.pane_id), live);
  for (const id of Object.keys(mem.status)) if (!live.has(id)) delete mem.status[id];

  const crews = new Map();
  const checkList = [];
  const trusted = (crew) => Boolean(crew.hash) && trust[crew.file] === crew.hash;
  const advice = new Map();
  const inSurge = surge.isSurgeWindow(now);
  const recommend = (task, effort, model, crew = null) => {
    const key = JSON.stringify([task, effort, model, crew && crew.hash]);
    if (!advice.has(key)) advice.set(key, advisor.recommend(task, effort, model, { crew }));
    return advice.get(key);
  };
  const rows = agents.map((a) => {
    const pane = paneById.get(a.pane_id) || {};
    const label = typeof pane.label === 'string' ? pane.label : null;
    const parsed = parseLabel(label);
    const agentKind = (a.agent || '').toLowerCase();
    const cleanLabelName = parsed.name ? parsed.name.toLowerCase() : null;
    const isDefaultAgentLabel = cleanLabelName && (cleanLabelName === agentKind || ['claude', 'opencode', 'agy', 'kilo', 'gemini'].includes(cleanLabelName)) && !parsed.task;
    // The Herdr agent name is the lowercase machine name. The panel label is
    // the human name and wins when it is not just the agent kind.
    const agentName = ui.clean(a.name) || null;
    const humanName = !isDefaultAgentLabel && parsed.name ? parsed.name : null;
    const displayName = humanName || agentName || parsed.name || a.pane_id;
    const isNamed = Boolean(humanName || agentName);
    const name = displayName;
    const crew = crewFor(a.cwd || pane.cwd) || null;
    if (crew && !crews.has(crew.file)) {
      crews.set(crew.file, crew);
      if (trusted(crew)) for (const c of crew.checks) checkList.push({ run: c.run, cwd: crew.dir });
    }
    // An unallowed crew file runs nothing and supplies nothing but its name.
    const ok = crew ? trusted(crew) : false;
    const extra = ok ? crew.panes[parsed.name] || crew.panes[name] || null : null;
    const rep = reports[a.pane_id] || {};
    const scr = screens[a.pane_id] != null ? parseScreen(a.agent, screens[a.pane_id]) : {};
    const st = trackStatus(mem, a, now, events[a.pane_id]);
    const task = pick([parsed.task, 'label'], [rep.task, 'exact'], [titleTask(a), 'screen']);

    const badges = [];
    if (extra && extra.report && fs.existsSync(extra.report)) badges.push({ name: 'REPORT READY', kind: 'report' });
    if (extra) {
      for (const c of extra.checks) {
        checkList.push({ run: c.run, cwd: crew.dir });
        const state = checks.state(c.run, crew.dir);
        if (state === true) badges.push({ name: c.name, kind: 'check' });
        else if (state === null) badges.push({ name: c.name, kind: 'unknown' });
      }
    }

    const modelField = pick([rep.model, 'exact'], [extra && extra.model, 'crew'], [scr.model, 'screen']);
    const ctxField = pick([rep.ctx, 'exact'], [scr.ctx, 'screen']);
    if (ctxField.v !== null && typeof ctxField.v === 'number' && ctxField.v >= 50) {
      badges.push({ name: 'COMPACT', kind: 'compact', level: ctxField.v >= 85 ? 'critical' : (ctxField.v >= 75 ? 'high' : 'warn') });
    }
    const effortVal = rep.effort || (scr && scr.effort) || null;
    const apiEstimate = pricing.estimate(modelField.v, rep);
    const costField = pick([rep.cost, 'exact'], [scr.cost, 'screen'], [apiEstimate && apiEstimate.cost, 'estimate']);
    const rec = recommend(task.v, effortVal, modelField.v, ok ? crew : null);
    const isSurging = inSurge && surge.isDeepSeekModel(modelField.v);

    return {
      paneId: a.pane_id,
      workspaceId: a.workspace_id || null,
      workspace: wsLabel.get(a.workspace_id) || a.workspace_id || '?',
      tag: mem.tags[a.pane_id],
      displayAgent: a.display_agent || pane.display_agent || null,
      label,
      name,
      agentName,
      displayName,
      isNamed,
      labelName: parsed.name,
      role: rep.role || null,
      about: rep.about || null,
      task: task.v,
      taskSrc: task.src,
      kind: a.agent || '?',
      model: modelField,
      effort: effortVal,
      advisory: rec.advisory,
      advisoryKind: rec.kind,
      modelStats: rec.modelStats,
      status: st.status,
      statusFor: now - st.since,
      statusExact: st.exact,
      ctx: ctxField,
      tokens: pick([rep.tokens, 'exact'], [scr.tokens, 'screen']),
      cost: costField,
      price: costField.src === 'estimate' && apiEstimate ? apiEstimate.rate : null,
      ram: pick([rss[a.pane_id], 'exact']),
      budget: (extra && extra.budget) || budget || (ok && crew && crew.budget) || null,
      session: sessions.validSession(a.agent, rep.session) ? rep.session
        : (sessions.validSession(a.agent, a.session_id) ? a.session_id
          : (a.agent_session && sessions.validSession(a.agent, a.agent_session.value) ? a.agent_session.value : null)),
      cwd: a.cwd || pane.cwd || null,
      crewTags: ok && crew ? crew.tags : null,
      badges,
      crew,
      surge: isSurging,
      surgeMarker: isSurging ? '2×' : null,
    };
  });

  // Blocked panes first within their workspace; otherwise Herdr's order.
  const wsOrder = new Map();
  for (const r of rows) if (!wsOrder.has(r.workspace)) wsOrder.set(r.workspace, wsOrder.size);
  rows.sort((x, y) => wsOrder.get(x.workspace) - wsOrder.get(y.workspace) || (y.status === 'blocked') - (x.status === 'blocked'));

  const crewChecks = [];
  for (const crew of crews.values()) {
    if (!trusted(crew)) continue;
    for (const c of crew.checks) crewChecks.push({ name: c.name, state: checks.state(c.run, crew.dir) });
  }
  const all = [...crews.values()];
  const trustedCrews = all.filter(trusted);
  const daily = trustedCrews.map((c) => c.dailyBudget).filter(Boolean);
  const crewTagScope = trustedCrews.some((c) => c.tagScope === 'all') ? 'all' : 'here';
  const resolvedTagScope = tagScope === 'all' || tagScope === 'here' ? tagScope : crewTagScope;
  const primaryCrew = trustedCrews[0] || null;
  return {
    rows,
    crews: all,
    untrusted: all.filter((c) => !trusted(c) && (
      c.checks.length || Object.keys(c.panes).length || c.budget !== null || c.dailyBudget !== null || c.tags !== null
    )),
    dailyBudget: daily.length ? Math.min(...daily) : null,
    crewChecks,
    checkList,
    now,
    workspaces: wsLabel,
    live,
    tagScope: resolvedTagScope,
    checkConcurrency: primaryCrew ? primaryCrew.checkConcurrency : 3,
    checkTimeoutMs: primaryCrew ? primaryCrew.checkTimeoutMs : 2000,
    explabsEnabled: trustedCrews.some((c) => c.explabsEnabled),
  };
}

// A terminal chunk while a task is being edited. Enter, Escape and Backspace
// only count when the chunk is exactly that key; anything else is text, so a
// paste cannot press a board shortcut or quit.
function editChunk(chunk) {
  if (chunk === '\r' || chunk === '\n') return { action: 'save' };
  if (chunk === '\x1b' || chunk === '\x03') return { action: 'cancel' };
  if (chunk === '\x7f' || chunk === '\b') return { action: 'backspace' };
  if (chunk.startsWith('\x1b')) return { action: 'ignore' };
  return { action: 'text', text: String(chunk).replace(/[\x00-\x1f\x7f]/g, ' ') };
}

// The label the board writes when you edit a task line: the label's own name
// (or the pane name), the new task, and the row's current colour tag.
function editedLabel(r, task) {
  const name = r.labelName || r.name;
  const tag = r.tag ? `${r.tag} ` : '';
  const t = String(task).replace(/\s+/g, ' ').trim();
  return t ? `${tag}${name}${SEP}${t}` : `${tag}${name}`;
}

// ------------------------------------------------------------------ render

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

function fmtCost(n) {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

// How full a budget is: 'over' at 100%, 'near' from 80%, else null.
function budgetState(cost, budget) {
  if (cost === null || !budget) return null;
  if (cost >= budget) return 'over';
  return cost >= budget * 0.8 ? 'near' : null;
}
const BUDGET_PAINT = { over: C.red, near: C.amber };

function fmtCtx(n) {
  return `${Math.round(n)}%`;
}

// KiB as megabytes, or gigabytes from 1000M up.
function fmtRam(kb) {
  const mb = kb / 1024;
  return mb < 1000 ? `${Math.round(mb)}M` : `${(mb / 1024).toFixed(1)}G`;
}

// Table columns in display order. In a narrow pane the state column first
// drops its word (keeping glyph and time), then columns give way in `drop`
// order (lowest first). Tag, name, state, and the task line always stay.
const COLUMNS = [
  { key: 'tag', head: '' },
  { key: 'name', head: 'name', max: 28 },
  // The Herdr pane id, for commands (`herdr pane read`, `crew-board report`):
  // a renamed pane no longer shows it anywhere else.
  { key: 'id', head: 'id', drop: 2 },
  { key: 'agent', head: 'model', max: 20, drop: 1 },
  { key: 'effort', head: 'eff', drop: 0.8 },
  { key: 'state', head: 'state' },
  { key: 'ctx', head: 'ctx', right: true, drop: 5 },
  { key: 'tokens', head: 'tokens', right: true, drop: 3 },
  { key: 'cost', head: 'cost', right: true, drop: 4 },
  { key: 'ram', head: 'ram', right: true, drop: 0.5 },
];
// In "line" view the task line keeps at least this many cells before columns
// start to go. "auto" puts a task beside its row when it fits, else under it;
// "wrap" always puts it under.
const MIN_TASK = 24;
const VIEWS = ['auto', 'line', 'wrap', 'cards'];
const TAG_MODES = ['tokens', 'label', 'metadata', 'off'];

// Reasoning effort as it fits in the eff column.
const EFFORT = { low: 'low', medium: 'med', high: 'high', xhigh: 'xh', max: 'max' };

// A model name short enough for the agent column: "claude-opus-5-5" and
// "Claude Opus 5.5" become "Opus 5.5"; a provider prefix ("openai/...") goes.
function shortModel(m) {
  const s = String(m).replace(/\[.*?\]/g, '').trim().replace(/^[^/\s]+\//, '');
  const id = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(s);
  if (id) return `${id[1][0].toUpperCase()}${id[1].slice(1)} ${id[2]}${id[3] ? `.${id[3]}` : ''}`;
  return s.replace(/^claude\s+/i, '');
}

// The agent column: the model when known, else "?".
function agentCell(r) {
  if (!r.model || r.model.v === null) return { text: '?', paint: C.dim };
  const base = shortModel(r.model.v);
  const isSurging = Boolean(r.surge || r.surgeMarker || (r.now && surge.isSurgeWindow(r.now) && surge.isDeepSeekModel(r.model.v)));
  if (isSurging) {
    return { text: `${base} 2×`, paint: C.amber };
  }
  return { text: base, paint: r.model.src === 'screen' ? C.screen : C.text };
}

// Reasoning effort cell: "low", "med", "high", or "?" when unknown.
function effortCell(r) {
  if (!r.effort) return { text: '?', paint: C.dim };
  const label = EFFORT[r.effort] || r.effort;
  return { text: label, paint: C.text };
}

// Plain text and a painter for every cell of a row. Exact values in normal
// text, screen values tinted, "?" dim (red is kept for blocked panes).
function rowCells(r, shortState) {
  const paintStatus = STATUS_PAINT[r.status] || C.dim;
  const time = r.statusExact ? fmtDuration(r.statusFor) : `≥${fmtDuration(r.statusFor)}`;
  const glyph = STATUS_GLYPH[r.status] || '?';
  const label = shortState ? glyph : `${glyph} ${r.status}`;
  const val = (f, fmt) => (f.v === null
    ? { text: '?', paint: C.dim }
    : { text: fmt(f.v), paint: f.src === 'screen' ? C.screen : C.text });
  return {
    tag: { text: r.tag || '', paint: (s) => s },
    name: {
      // The human name, then the role in a dim suffix when it is set.
      text: r.role ? `${r.name} · ${r.role}` : r.name,
      paint: (s) => {
        const i = s.indexOf(SEP);
        const head = i >= 0 ? s.slice(0, i) : s;
        const tail = i >= 0 ? s.slice(i) : '';
        const base = r.status === 'blocked' ? C.red : (r.isNamed ? C.title : C.dim);
        return bold(base(head)) + (tail ? C.dim(tail) : '');
      },
    },
    id: { text: r.paneId, paint: C.dim },
    agent: agentCell(r),
    effort: effortCell(r),
    state: { text: `${label} ${time}`, paint: (s) => paintStatus(s.slice(0, label.length)) + C.dim(s.slice(label.length)) },
    ctx: ctxCell(r, val(r.ctx, fmtCtx)),
    tokens: val(r.tokens, fmtTokens),
    cost: costCell(r, estimatedCost(r, val(r.cost, fmtCost))),
    ram: val(r.ram, fmtRam),
  };
}

function ctxState(ctx) {
  if (ctx === null || typeof ctx !== 'number') return null;
  if (ctx >= 85) return 'critical';
  if (ctx >= 75) return 'high';
  if (ctx >= 50) return 'warn';
  if (ctx >= 30) return 'warm';
  return null;
}
const CTX_PAINT = {
  critical: (s) => bold(C.red(s)),
  high: (s) => bold(C.amber(s)),
  warn: (s) => C.amber(s),
  warm: (s) => C.cyan(s),
};

function ctxCell(r, cell) {
  const st = ctxState(r.ctx.v);
  return st ? { text: cell.text, paint: CTX_PAINT[st] } : cell;
}

// The line a click on a surge badge or a ctx cell flashes.
const SURGE_TOOLTIP = '▲ 2× peak hours (14:00 to 18:00 UTC): 5h rolling quota burns twice as fast';
function ctxTooltip(r) {
  const v = Math.round(r.ctx.v);
  const tail = r.ctx.v >= 85 ? 'critical context ceiling; hand off or split pane'
    : r.ctx.v >= 50 ? 'context dilution zone (>50k tokens); run /clear before next task'
      : 'healthy context window (<30% warm reuse threshold)';
  return `ctx ${v}%: ${tail}`;
}

// An API estimate is not a bill: it carries a tilde and the screen tint.
function estimatedCost(r, cell) {
  if (r.cost.src !== 'estimate' || r.cost.v === null) return cell;
  return { text: `~${cell.text}`, paint: C.screen };
}

// The cost cell turns amber near the pane's budget and red over it.
function costCell(r, cell) {
  const b = budgetState(r.cost.v, r.budget);
  return b ? { text: cell.text, paint: (s) => bold(BUDGET_PAINT[b](s)) } : cell;
}

function badgeTexts(r) {
  return r.badges.map((b) => (b.kind === 'unknown' ? ` ? ${b.name} ` : ` ${b.name} `));
}

function taskWidth(r) {
  const t = r.task === null ? 1 : ui.strWidth(r.task);
  return t + badgeTexts(r).reduce((n, b) => n + b.length + 1, 0);
}

// The task line with its badges. When space is short, badges give way (last
// first) before the task text drops below 12 cells.
function taskCell(r, width) {
  const texts = badgeTexts(r);
  const taskLen = r.task === null ? 1 : ui.strWidth(r.task);
  let n = texts.length;
  const badgeW = () => texts.slice(0, n).reduce((w, b) => w + b.length + 1, 0);
  while (n > 0 && width - badgeW() < Math.min(taskLen, 12)) n--;
  const paint = r.taskSrc === 'screen' ? C.screen : C.text;
  const task = r.task === null ? C.dim('?') : paint(ui.truncate(r.task, Math.max(4, width - badgeW())));
  const badges = r.badges.slice(0, n).map((b, i) => {
    if (b.kind === 'compact') {
      if (b.level === 'critical') return bold(C.red(texts[i]));
      if (b.level === 'high') return bold(C.amber(texts[i]));
      return C.amber(texts[i]);
    }
    if (b.kind === 'report') return bold(C.gold(texts[i]));
    if (b.kind === 'unknown') return C.dim(texts[i]);
    return C.green(texts[i]);
  }).join(' ');
  return task + (badges ? ` ${badges}` : '');
}

// Size every column to its widest cell, then give way until the row fits:
// in "line" view the task line needs MIN_TASK cells beside the columns; in
// "wrap" view it sits on its own line under them.
function fitColumns(rows, width, view) {
  const room = view === 'line' ? Math.min(MIN_TASK, Math.max(1, ...rows.map(taskWidth))) : 0;
  for (const shortState of [false, true]) {
    const cells = rows.map((r) => rowCells(r, shortState));
    let cols = COLUMNS.map((c) => ({
      ...c,
      w: Math.min(c.max || Infinity, Math.max(ui.strWidth(c.head), ...cells.map((x) => ui.strWidth(x[c.key].text)))),
    }));
    const used = () => cols.reduce((n, c) => n + c.w + 1, 0);
    if (!shortState && used() + room > width) continue;
    const order = cols.filter((c) => c.drop).sort((a, b) => a.drop - b.drop);
    while (used() + room > width && order.length) {
      const d = order.shift();
      cols = cols.filter((c) => c !== d);
    }
    return { cols, cells, taskW: Math.max(4, width - used()) };
  }
  return null;
}

function crewTitle(model) {
  const names = [...new Set(model.crews.map((c) => c.name).filter(Boolean))];
  if (names.length) return names.join(', ');
  const ws = [...new Set(model.rows.map((r) => r.workspace))];
  if (ws.length === 1) return ws[0];
  return ws.length ? `${ws.length} workspaces` : '';
}

function clock(now) {
  const d = new Date(now);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function spawnCopy(cmd, args, text, stdin) {
  try {
    const child = child_process.spawn(cmd, args, { stdio: [stdin ? 'pipe' : 'ignore', 'ignore', 'ignore'] });
    child.on('error', () => {});
    if (child.stdin) {
      child.stdin.on('error', () => {});
      if (stdin) child.stdin.end(text);
    }
    return child;
  } catch (_) {
    return null;
  }
}

function copyToClipboard(text) {
  if (!text) return;
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  try {
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
    process.stdout.write(`\x1b]52;c;${b64}\x1b\\`);
    process.stdout.write(`\x1b]52;p;${b64}\x07`);
    process.stdout.write(`\x1b]52;p;${b64}\x1b\\`);
    if (process.env.TMUX) {
      process.stdout.write(`\x1bPtmux;\x1b\x1b]52;c;${b64}\x07\x1b\\`);
    }
  } catch (_) {}
  try {
    const dir = state.stateDir();
    fs.writeFileSync(path.join(dir, 'copied-id'), String(text).trim() + '\n', 'utf8');
  } catch (_) {}
  // A missing tool is a no op: OSC 52 above already reached the clipboard.
  if (process.platform === 'darwin') {
    spawnCopy('pbcopy', [], text, true);
  } else if (process.platform === 'linux') {
    const child = spawnCopy('wl-copy', [text], text, false);
    if (child) child.on('error', () => spawnCopy('xclip', ['-selection', 'clipboard'], text, true));
  }
}

function orchestrationEnabled(cfg, opts) {
  if (process.env.ROOSTR_EXPERIMENTAL === '1' || process.env.ROOSTR_ORCHESTRATION === '1' || process.env.CREW_BOARD_EXPERIMENTAL === '1') {
    return true;
  }
  if (opts && (opts.orchestration || (opts.menu && opts.menu.orchestration))) {
    return true;
  }
  if (cfg && cfg.orchestration && cfg.orchestration.enabled) {
    return true;
  }
  return false;
}

// The clickable menu bar. Returns the line and its hit regions.
function menuBar(arg1, arg2, arg3, arg4, arg5, arg6) {
  let menu;
  let width;
  let hitsArg = null;
  let yArg = 0;
  let activeDrawer = null;

  if (typeof arg2 === 'number' && typeof arg1 === 'object' && arg1 && !arg1.rows) {
    menu = arg1;
    width = arg2;
    activeDrawer = arg3 || (menu && menu.activeDrawer) || null;
  } else if (typeof arg2 === 'number' && typeof arg3 === 'object' && arg3) {
    menu = arg3;
    width = arg2;
    hitsArg = arg4;
    yArg = typeof arg5 === 'number' ? arg5 : 0;
    activeDrawer = arg6 || (menu && menu.activeDrawer) || null;
  } else {
    menu = (typeof arg1 === 'object' && arg1 && !arg1.rows) ? arg1 : (arg3 || {});
    width = typeof arg2 === 'number' ? arg2 : 100;
    activeDrawer = arg3 || (menu && menu.activeDrawer) || null;
  }

  const provider = ui.clean(menu.provider);
  const items = [
    ['tags', `tags: ${menu.tags}`],
    ['view', `view: ${menu.view}`],
    ['scope', `scope: ${menu.scope}`],
    ['edit', 'edit task'],
    ['log', 'L log'],
    ['backups', 'R backups'],
    ['respawn', 'X respawn'],
    ['options', 'o options'],
  ];
  if (menu.orchestration) {
    items.push(
      ['orchestrate', 'O orchestrate']
    );
  }
  if (provider) {
    const sub = menu.subview && menu.subview !== 'all'
      ? (menu.subview.startsWith(provider + ' ') ? menu.subview.slice(provider.length + 1) : menu.subview)
      : null;
    items.push(['provider', sub ? `usage: ${provider} (${sub})` : `usage: ${provider}`]);
  }
  items.push(['today', 'd today']);
  if (menu.update) items.push(['update', menu.update]);
  items.push(['help', '? keys']);
  items.push(['refresh', 'r refresh']);
  let line = '';
  let x = 0;
  const hits = [];
  for (const [action, rawText] of items) {
    const isActive = Boolean(activeDrawer && activeDrawer === action);
    const text = isActive ? `▾ ${rawText}` : rawText;
    const t = `[${text}]`;
    if (x + ui.strWidth(t) > width) break;
    const h = { action, x0: x, x1: x + ui.strWidth(t) - 1 };
    hits.push(h);
    if (hitsArg && Array.isArray(hitsArg)) hitsArg.push({ ...h, y: yArg });
    line += (isActive ? bold(C.cyan(t)) : C.cyan(t)) + ' ';
    x += ui.strWidth(t) + 1;
  }
  const pKeys = provider ? (menu.hasSubviews ? ' p P' : ' p') : '';
  const orchKeys = menu.orchestration ? ' O C' : '';
  const hint = menu.notice
    ? bold(C.green(` ✓ ${menu.notice}`))
    : ` click to select · double click jump · ↑↓ ↵ f e t v w s R L X o d${orchKeys}${pKeys}${menu.trust ? ' a' : ''}${menu.update ? ' u' : ''} ? q`;
  if (x + ui.strWidth(hint) <= width) line += (menu.notice ? hint : C.dim(hint));
  return { line, hits };
}

// One colour per agent, the same in the share bar, the chart and the rows.
const AGENT_COLOUR = { opencode: 0, kilo: 2, codex: 3, antigravity: 4, 'antigravity-cli': 4, gemini: 4, claude: 5 };
function agentPaint(name, order) {
  if (name in AGENT_COLOUR) return ui.WS[AGENT_COLOUR[name]];
  const spare = [1, 6, 7];
  return ui.WS[spare[Math.max(0, order.indexOf(name)) % spare.length]];
}

function tokensOf(c) {
  return c.input + c.output + c.cacheRead + c.cacheWrite;
}

// Split `total` cells between `parts` by size, rounding so they add up.
function apportion(parts, total) {
  const sum = parts.reduce((n, p) => n + p, 0);
  if (!(sum > 0)) return parts.map(() => 0);
  const exact = parts.map((p) => (p / sum) * total);
  const out = exact.map(Math.floor);
  let left = total - out.reduce((n, p) => n + p, 0);
  const byRest = exact.map((e, i) => [e - Math.floor(e), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of byRest) if (left-- > 0) out[i]++;
  return out;
}

// A stable colour per model name, so the bar, the legend and the table agree
// even when the metric reorders them.
function modelPaint(name) {
  return ui.WS[hash(name) % ui.WS.length];
}

// Models merged under their short name, largest first for the active metric.
function collectModels(ts, metric) {
  const byName = new Map();
  for (const [name, c] of Object.entries((ts && ts.models) || {})) {
    const short = ui.clean(shortModel(name));
    const m = byName.get(short) || {
      name: short, tokens: 0, cost: 0, sessions: null, clients: new Set(),
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    };
    m.tokens += tokensOf(c);
    m.cost += Number.isFinite(c.cost) ? c.cost : 0;
    m.input += Number.isFinite(c.input) ? c.input : 0;
    m.output += Number.isFinite(c.output) ? c.output : 0;
    m.cacheRead += Number.isFinite(c.cacheRead) ? c.cacheRead : 0;
    m.cacheWrite += Number.isFinite(c.cacheWrite) ? c.cacheWrite : 0;
    if (Number.isFinite(c.sessions)) m.sessions = (m.sessions || 0) + c.sessions;
    if (Array.isArray(c.clients)) for (const client of c.clients) m.clients.add(ui.clean(client));
    byName.set(short, m);
  }
  return [...byName.values()]
    .map((m) => ({ ...m, clients: [...m.clients].sort() }))
    .sort((a, b) => (metric === 'cost' ? b.cost - a.cost : b.tokens - a.tokens) || a.name.localeCompare(b.name));
}

// The model share bar and its legend, in the active metric. Models that do not
// fit in the legend are dropped, with an ellipsis, never wrapped.
function modelShareLines(items, width, metric) {
  const val = (m) => (metric === 'cost' ? m.cost : m.tokens);
  const sum = items.reduce((n, m) => n + val(m), 0);
  const barW = Math.max(10, width - 4);
  const cells = apportion(items.map(val), barW);
  const bar = '  ' + (cells.some((x) => x > 0)
    ? items.map((m, i) => modelPaint(m.name)('█'.repeat(cells[i]))).join('')
    : C.dim('░'.repeat(barW)));
  const parts = items.map((m) => {
    const pct = sum > 0 ? Math.round((val(m) / sum) * 100) : 0;
    return {
      plain: `${m.name} ${pct}%`,
      painted: `${modelPaint(m.name)('■')} ${C.text(m.name)} ${C.dim(`${pct}%`)}`,
    };
  });
  let legend = '  ';
  let shown = 0;
  for (const p of parts) {
    const sep = shown ? '   ' : '';
    if (ui.strWidth(legend) + ui.strWidth(sep) + ui.strWidth(p.plain) > width) break;
    legend += sep + p.painted;
    shown++;
  }
  if (shown < parts.length) {
    const more = ' …';
    if (ui.strWidth(legend) + ui.strWidth(more) <= width) legend += C.dim(more);
  }
  return [bar, legend];
}

const MODEL_COLUMNS = [
  { key: 'model', head: 'model' },
  { key: 'agents', head: 'agents' },
  { key: 'tokens', head: 'tokens', right: true },
  { key: 'cost', head: 'cost', right: true },
  { key: 'sessions', head: 'sessions', right: true },
  { key: 'in', head: 'in', right: true, split: true },
  { key: 'out', head: 'out', right: true, split: true },
  { key: 'cache', head: 'cache', right: true, split: true },
];
const MODEL_LIMIT = 8;
const MODEL_NAME_MAX = 22;
const MODEL_GAP = '  ';

function modelCells(items) {
  return items.map((m) => ({
    model: m.name,
    agents: m.clients.length ? m.clients.join(', ') : '?',
    tokens: fmtTokens(m.tokens),
    cost: fmtCost(m.cost),
    sessions: m.sessions == null ? '?' : String(m.sessions),
    in: fmtTokens(m.input),
    out: fmtTokens(m.output),
    cache: fmtTokens(m.cacheRead + m.cacheWrite),
  }));
}

// Widths for one table shape. The model column is capped so a single long id
// cannot crowd out the numbers. Only the essential table (no agents, no split)
// shrinks the model column to fit; anything else gives a column up instead.
function modelLayout(rows, width, shape) {
  const cols = MODEL_COLUMNS.filter((c) => (c.split ? shape.split : true) && (c.key === 'agents' ? shape.agents : true));
  const widths = cols.map((c) => {
    const natural = Math.max(ui.strWidth(c.head), ...rows.map((r) => ui.strWidth(r[c.key])));
    return c.key === 'model' ? Math.min(natural, MODEL_NAME_MAX) : natural;
  });
  let total = 2 + widths.reduce((n, w) => n + w, 0) + MODEL_GAP.length * (cols.length - 1);
  if (total > width) {
    if (shape.split || shape.agents) return null;
    const rest = total - widths[0];
    widths[0] = width - rest;
    if (widths[0] < 4) return null;
    total = width;
  }
  return { cols, widths };
}

// A model table in the active order. Gives up the split columns first, then
// the agents column, then rows, so the pane never overflows.
function modelTableLines(items, width) {
  const all = modelCells(items);
  const shapes = [
    { split: true, agents: true },
    { split: false, agents: true },
    { split: false, agents: false },
  ];
  let chosen = null;
  for (const shape of shapes) {
    for (let n = Math.min(all.length, MODEL_LIMIT); n >= 1; n--) {
      const rows = all.slice(0, n);
      const layout = modelLayout(rows, width, shape);
      if (layout) {
        chosen = { rows, layout, shown: n };
        break;
      }
    }
    if (chosen) break;
  }
  if (!chosen) return [];
  const { rows, layout, shown } = chosen;
  const line = (vals, paint) => '  ' + layout.cols.map((c, i) => (
    c.right ? ui.cell(vals[c.key], layout.widths[i], paint, true) : ui.cell(vals[c.key], layout.widths[i], paint)
  )).join(MODEL_GAP);
  const head = Object.fromEntries(layout.cols.map((c) => [c.key, c.head]));
  const lines = [line(head, C.dim), ...rows.map((r) => line(r, C.text))];
  const more = items.length - shown;
  if (more > 0) lines.push(C.dim(`  +${more} more`));
  return lines;
}

const EIGHTHS = ' ▁▂▃▄▅▆▇█';

// Tokens (or cost) per hour, one column per hour so far today, each stacked
// in agent colours. `hours` is tokscale.hourly()'s { 'HH': { client: { tokens, cost } } }.
function hourChart(hours, names, paintOf, metric, now, width, rows = 5) {
  const upTo = new Date(now).getHours();
  const n = upTo + 1;
  const colW = Math.max(1, Math.min(3, Math.floor((width - 2) / n)));
  const barW = colW > 1 ? colW - 1 : 1;
  const cols = [];
  for (let h = 0; h <= upTo; h++) {
    const per = (hours && hours[String(h).padStart(2, '0')]) || {};
    cols.push(names.map((c) => (per[c] ? per[c][metric] || 0 : 0)));
  }
  const max = Math.max(0, ...cols.map((v) => v.reduce((a, b) => a + b, 0)));
  const lines = [];
  for (let row = rows - 1; row >= 0; row--) {
    let line = '  ';
    for (const v of cols) {
      // The column in eighths of a cell, stacked bottom up in agent order.
      const units = max > 0 ? v.map((x) => (x / max) * rows * 8) : v.map(() => 0);
      const top = units.reduce((a, b) => a + b, 0);
      const lo = row * 8;
      let ch = ' ';
      let who = -1;
      if (top >= lo + 8) {
        ch = '█';
        let acc = 0;
        for (let i = 0; i < units.length; i++) {
          acc += units[i];
          if (acc > lo + 4) {
            who = i;
            break;
          }
        }
      } else if (top > lo) {
        ch = EIGHTHS[Math.max(1, Math.round(top - lo))];
        who = units.reduce((last, u, i) => (u > 0 ? i : last), -1);
      }
      const cell = ch.repeat(barW);
      line += (who >= 0 ? paintOf(names[who])(cell) : cell) + ' '.repeat(colW - barW);
    }
    lines.push(line);
  }
  const step = Math.max(1, Math.ceil(3 / colW));
  let labels = '  ';
  for (let h = 0; h <= upTo; h++) {
    if (h % step === 0 && ui.strWidth(labels) <= 2 + h * colW) labels += String(h).padStart(2, '0').padEnd(colW * step).slice(0, colW * step);
  }
  lines.push(C.dim(labels));
  return lines;
}

// Spend pace over the last three clock hours, projected to local midnight.
// Returns null until tokscale's hourly report has something to show.
function paceLine(model, totalTokens, metric) {
  const ts = model.tokscale;
  const h = model.hourly;
  if (!ts || !h || !h.hours) return null;
  const now = model.now;
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const short = (now - midnight) / 3600000 < 3;
  const startHour = short ? 0 : d.getHours() - 2;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), startHour).getTime();
  const elapsed = (now - start) / 3600000;
  if (!(elapsed > 0)) return null;
  let used = 0;
  for (let hour = startHour; hour <= d.getHours(); hour++) {
    const per = h.hours[String(hour).padStart(2, '0')] || {};
    for (const c of Object.values(per)) used += (metric === 'cost' ? c.cost : c.tokens) || 0;
  }
  const rate = used / elapsed;
  if (!(rate > 0)) return C.dim(`  nothing ${short ? 'since 00:00' : 'in the last 3 hours'}`);
  const when = short ? 'since 00:00' : 'over the last 3 hours';
  const total = metric === 'cost' ? ts.total : totalTokens;
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  const projected = total + rate * ((end - now) / 3600000);
  const fmt = metric === 'cost' ? fmtCost : fmtTokens;
  let text = `  ${fmt(rate)}/h ${when} · on pace for ${fmt(projected)} by midnight`;
  if (metric === 'cost' && model.dailyBudget != null) {
    text += ` · budget ${fmtCost(model.dailyBudget)}`;
    return (projected > model.dailyBudget ? C.amber : C.dim)(text);
  }
  return C.dim(text);
}

// The today view: spend per agent from tokscale, a share bar, the hours so
// far stacked by agent, the agents and the top sessions. `metric` is
// 'tokens' or 'cost'.
function todayLines(model, width, metric = 'tokens') {
  const ts = model.tokscale;
  const now = model.now;
  const lines = [];
  let clients;
  let source;
  if (ts) {
    clients = Object.entries(ts.clients || {}).map(([name, c]) => ({ name, ...c, tokens: tokensOf(c) }));
    source = `via tokscale · ${fmtDuration(Math.max(0, now - ts.at))} ago`;
  } else {
    // Without tokscale: what the open panes say, per agent kind.
    const by = {};
    for (const r of model.rows) {
      const c = by[r.kind] || (by[r.kind] = { name: r.kind, tokens: 0, cost: 0, sessions: 0 });
      c.tokens += r.tokens.v || 0;
      c.cost += r.cost.v || 0;
      c.sessions++;
    }
    clients = Object.values(by);
    source = 'open panes only';
  }
  const val = (c) => (metric === 'cost' ? c.cost : c.tokens);
  clients.sort((a, b) => val(b) - val(a) || a.name.localeCompare(b.name));
  const names = clients.map((c) => c.name);
  const paintOf = (name) => agentPaint(name, names);
  const totalTokens = clients.reduce((n, c) => n + c.tokens, 0);
  const totalCost = ts ? ts.total : clients.reduce((n, c) => n + c.cost, 0);
  const sessions = clients.reduce((n, c) => n + c.sessions, 0);
  const models = ts ? collectModels(ts, metric) : [];
  const hits = [];

  const head = `${bold(C.title('today'))}  ${C.text(`${fmtTokens(totalTokens)} tokens · ${fmtCost(totalCost)} · ${sessions} session${sessions === 1 ? '' : 's'}`)}`;
  const metricLabel = metric === 'cost' ? 'by cost' : 'by tokens';
  const right = C.dim(`${metricLabel} · ${source}`);
  const gap = width - ui.strWidth(head) - ui.strWidth(right);
  if (gap >= 2) {
    const metricX0 = width - ui.strWidth(right);
    hits.push({ action: 'metric', y: lines.length, x0: metricX0, x1: metricX0 + ui.strWidth(metricLabel) - 1 });
    lines.push(head + ' '.repeat(gap) + right);
  } else {
    lines.push(head);
  }
  const pace = paceLine(model, totalTokens, metric);
  if (pace) lines.push(pace);
  lines.push('');

  // The share bar: one row split by each agent's part of the day.
  const barW = Math.max(10, width - 4);
  const cells = apportion(clients.map(val), barW);
  lines.push('  ' + (cells.some((x) => x > 0)
    ? clients.map((c, i) => paintOf(c.name)('█'.repeat(cells[i]))).join('')
    : C.dim('░'.repeat(barW))));
  const sum = clients.reduce((n, c) => n + val(c), 0);
  lines.push('  ' + clients.map((c) => `${paintOf(c.name)('■')} ${C.text(ui.clean(c.name))} ${C.dim(`${sum > 0 ? Math.round((val(c) / sum) * 100) : 0}%`)}`).join('   '));
  lines.push('');

  if (models.length) {
    lines.push(...modelShareLines(models, width, metric));
    lines.push('');
  }

  if (ts) {
    const h = model.hourly;
    if (h && h.hours) lines.push(...hourChart(h.hours, names, paintOf, metric, now, width));
    else lines.push(C.dim('  hours: tokscale is reading each agent\'s day in the background, about a minute'));
    lines.push('');
  }

  // One row per agent: tokens, cost, sessions, and the split when it fits.
  const nameW = Math.max(6, ...names.map((x) => ui.strWidth(ui.clean(x))));
  const countW = Math.max(1, ...clients.map((c) => String(c.sessions).length));
  for (const c of clients) {
    const count = `${String(c.sessions).padStart(countW)} session${c.sessions === 1 ? ' ' : 's'}`;
    let row = `  ${paintOf(c.name)('■')} ${C.text(ui.padEnd(ui.clean(c.name), nameW))} ${C.text(ui.padStart(fmtTokens(c.tokens), 7))} ${C.text(ui.padStart(fmtCost(c.cost), 8))}  ${C.dim(count)}`;
    if (ts && width >= 100) row += C.dim(`   in ${fmtTokens(c.input)} · out ${fmtTokens(c.output)} · cache ${fmtTokens(c.cacheRead + c.cacheWrite)}`);
    lines.push(row);
  }

  // The model table, in the same order as the share bar. Columns give way
  // before the text can reach the edge of the pane.
  if (models.length) {
    const table = modelTableLines(models, width);
    if (table.length) {
      lines.push('');
      lines.push(...table);
    }
  }

  // The busiest sessions, named after their pane when one reports the id.
  if (ts) {
    const paneBySession = new Map(model.rows.filter((r) => r.session).map((r) => [r.session, r.name]));
    const top = Object.entries(ts.sessions || {})
      .map(([id, x]) => ({ id, ...x, tokens: tokensOf(x) }))
      .sort((a, b) => val(b) - val(a))
      .slice(0, 5);
    if (top.length) {
      lines.push('');
      lines.push(C.dim('  top sessions'));
      const label = (x) => (paneBySession.has(x.id) ? ui.clean(paneBySession.get(x.id)) : `session ${ui.clean(x.id).slice(0, 8)}`);
      const labelW = Math.max(...top.map((x) => ui.strWidth(label(x))));
      for (const x of top) {
        const known = paneBySession.has(x.id);
        lines.push(`  ${(known ? C.text : C.dim)(ui.padEnd(label(x), labelW))}  ${paintOf(x.client)(ui.padEnd(ui.clean(x.client), nameW))} ${C.text(ui.padStart(fmtTokens(x.tokens), 7))} ${C.text(ui.padStart(fmtCost(x.cost), 8))}`);
      }
    }
  } else {
    lines.push('');
    lines.push(C.dim('  the whole day, closed sessions and every agent need tokscale: github.com/junhoyeo/tokscale'));
  }
  lines.push('');
  const closeY = lines.length;
  hits.push({ action: 'today', y: closeY, x0: 2, x1: 8 });
  const metricLabelBottom = `$ ${metric === 'cost' ? 'tokens' : 'cost'}`;
  hits.push({ action: 'metric', y: closeY, x0: 12, x1: 12 + ui.strWidth(metricLabelBottom) - 1 });
  lines.push(C.dim(`  d close · ${metricLabelBottom}${ts ? ' · data from tokscale by Junho Yeo' : ''}`));
  return { lines, hits };
}

// The help screen: the keys in four groups and a legend for the symbols, in
// two columns when the pane is wide enough. `sources` are the providers
// reporting usage.
function helpLines(menu, sources, width = 100) {
  const names = sources.map((s) => ui.clean(s));
  const usage = names.length > 1 ? `usage bars: ${[...names, 'off'].join(' ▸ ')}` : `usage bars (only ${names[0] || 'none'} reports)`;
  const groups = {
    move: ['MOVE', [
      ['↑↓ jk', 'select a pane'],
      ['click', 'select a row · double click jumps · id copies'],
      ['f y', 'jump · y copy pane id'],
      ['e', 'edit the task line'],
      ['click', 'a workspace header folds it'],
    ]],
    views: ['VIEWS', [
      ['d', 'today: spend per agent and hour'],
      ['$', 'tokens or cost (in today)'],
      ['v / w', `layout: ${VIEWS.join(' ▸ ')} (${menu.view}) · w cards`],
      ['s', `scope: here ▸ all (${menu.scope})`],
      ['p / P', usage],
    ]],
    more: ['MORE', [
      ...(menu && menu.orchestration ? [
        ['O / T', 'orchestrate: plan, tasks, advisor, analytics, setup'],
        ['S', 'setup: tools and preferred models'],
        ['C', 'allow or continue the selected stuck pane'],
      ] : []),
      ['t', `colour tags (${menu.tags})`],
      ['a', 'allow a new crew file'],
      ['u', 'install the offered update'],
      ['r', 'refresh now'],
      ['R', 'backups: check what is saved, rebuild a workspace'],
      ['X', 'respawn this workspace, resuming every session'],
      ['L', 'log: reopen a recent session after its tab closed'],
      ['o', 'options: tokscale, compaction, settings'],
      ['?', 'this help'],
      ['esc', 'close details, today, log, backups or options'],
      ['q', 'quit'],
    ]],
  };
  const st = (s) => (STATUS_PAINT[s] || C.dim)(STATUS_GLYPH[s]);
  // Symbol, its plain width, what it means.
  const sym = (painted, plain, what) => `${painted}${' '.repeat(Math.max(1, 9 - ui.strWidth(plain)))}${C.text(what)}`;
  const legend = ['LEGEND', [
    `${st('working')} working  ${st('idle')} idle  ${st('blocked')} blocked  ${st('done')} done`,
    sym(C.dim('?'), '?', 'no data (never guessed)'),
    sym(C.dim('≥'), '≥', 'at least (began before the board)'),
    sym(C.screen('tinted'), 'tinted', "read from the pane's screen"),
    sym(C.amber('⚡ 2.1×'), '⚡ 2.1×', 'burn vs the pace that lasts'),
    sym(C.amber('⚠ out'), '⚠ out', 'runs out before the reset'),
    sym(`${C.amber('$')} ${C.red('$')}`, '$ $', 'cost near, over budget'),
  ]];

  const colW = width >= 84 ? Math.floor((width - 4) / 2) : width - 2;
  const keyW = 9;
  const section = ([title, items], legendItems = false) => [
    bold(C.accent(title)),
    ...items.map((it) => (legendItems
      ? ui.clip(`  ${it}`, colW)
      : `  ${C.cyan(ui.padEnd(it[0], keyW))}${C.text(ui.truncate(it[1], Math.max(4, colW - keyW - 2)))}`)),
  ];
  const head = bold(C.title('keys')) + C.dim('   any key or click closes this');
  if (colW === width - 2) {
    return [head, '', ...section(groups.move), '', ...section(groups.views), '', ...section(groups.more), '', ...section(legend, true)];
  }
  const left = [...section(groups.move), '', ...section(groups.more)];
  const right = [...section(groups.views), '', ...section(legend, true)];
  const rows = [];
  for (let k = 0; k < Math.max(left.length, right.length); k++) {
    rows.push(`${ui.padEnd(left[k] || '', colW)}  ${right[k] || ''}`);
  }
  return [head, '', ...rows];
}

// The detail box for row `r`: who the agent is, what it is after, what it
// does next, and its numbers. Returns its lines and the click regions of its
// buttons (y counted from the box's first line).
function detailBox(r, width, ts = null, notice = null) {
  const hits = [];
  const title = ` ${r.name} `;
  const modelText = r.model.v ? shortModel(r.model.v) : '?';
  const who = r.isNamed || r.name !== r.paneId
    ? ` ${modelText} (${r.kind}) · ${r.paneId} `
    : ` ${modelText} (${r.kind}) `;
  const copied = Boolean(notice && notice.includes(r.paneId));
  const copyBtn = copied ? '[✓ copied]' : '[y copy id]';
  const buttons = [['copy-id', copyBtn], ['jump', '[f jump]'], ['close', '[esc close]']];
  const btnW = buttons.reduce((n, [, t]) => n + ui.strWidth(t) + 1, 0);
  const rule = Math.max(2, width - 2 - ui.strWidth(title) - ui.strWidth(who) - btnW);
  let head = C.dim('──') + (r.isNamed ? bold(C.title(ui.clean(title))) : C.dim(ui.clean(title))) + C.dim(ui.clean(who)) + C.dim('─'.repeat(rule));
  if (!r.isNamed && r.name === r.paneId) {
    hits.push({ action: 'copy-id', paneId: r.paneId, y: 0, x0: 2, x1: 2 + ui.strWidth(title) - 1 });
  } else {
    const idX0 = 2 + ui.strWidth(title) + ui.strWidth(who.slice(0, who.indexOf(r.paneId)));
    const idX1 = idX0 + ui.strWidth(r.paneId) - 1;
    if (idX1 < width) hits.push({ action: 'copy-id', paneId: r.paneId, y: 0, x0: idX0, x1: idX1 });
  }
  let x = 2 + ui.strWidth(title) + ui.strWidth(who) + rule;
  for (const [action, t] of buttons) {
    head += ' ' + (action === 'copy-id' && copied ? bold(C.green(t)) : C.cyan(t));
    // A button is only clickable when its whole text fits on the line.
    if (x + ui.strWidth(t) < width) hits.push({ action, paneId: r.paneId, y: 0, x0: x + 1, x1: x + ui.strWidth(t) });
    x += ui.strWidth(t) + 1;
  }
  const field = (k, v) => `  ${C.dim(ui.padEnd(k, 6))}${v}`;
  const room = Math.max(10, width - 8);
  const lines = [head];
  lines.push(field('task', r.task ? C.text(ui.truncate(ui.clean(r.task), room)) : C.dim('?')));
  if (r.model.v !== null || r.kind || r.effort) {
    const effStr = r.effort ? ` (${r.effort})` : '';
    const mStr = r.model.v ? `${shortModel(r.model.v)}${effStr}` : '?';
    lines.push(field('agent', C.text(`${r.kind || '?'} · ${mStr}`)));
  }
  lines.push(field('role', r.role ? C.text(ui.truncate(ui.clean(r.role), room)) : C.dim('?')));
  lines.push(field('about', r.about ? C.text(ui.truncate(ui.clean(r.about), room)) : C.dim('?')));
  if (r.advisory) {
    lines.push(field('advice', C.amber(ui.truncate(ui.clean(r.advisory), room))));
  }
  const stats = r.modelStats;
  const recorded = stats && stats.best && stats.best.count >= 3
    ? stats.best
    : stats && stats.configured && stats.configured.count >= 3 ? stats.configured : null;
  if (recorded) {
    const cost = recorded.avgCost === null || recorded.avgCost === undefined ? '' : `, $${recorded.avgCost} avg`;
    lines.push(field('recorded', C.dim(ui.truncate(` ${recorded.model} ${recorded.count} runs, ${recorded.passRate ?? '?'}% first try${cost}`, room))));
  }
  const c = rowCells(r, false);
  const budget = r.budget ? C.dim(` of ${fmtCost(r.budget)}`) : '';
  lines.push(field('now', [
    c.state.paint(c.state.text),
    `ctx ${c.ctx.paint(c.ctx.text)}`,
    `${c.tokens.paint(c.tokens.text)} tokens`,
    c.cost.paint(c.cost.text) + budget,
    `ram ${c.ram.paint(c.ram.text)}`,
  ].join(C.dim(' · '))));
  if (r.ctx && typeof r.ctx.v === 'number' && r.ctx.v >= 50) {
    const note = r.ctx.v >= 85 ? 'critical context' : (r.ctx.v >= 75 ? 'high context' : 'attention dilution risk');
    lines.push(field('advice', bold(C.amber(`${note} (${Math.round(r.ctx.v)}%) · /compact recommended`))));
  }
  if (r.price) {
    lines.push(field('price', C.text(`~${fmtCost(r.cost.v)} at API rates · ${fmtCost(r.price.input)} in / ${fmtCost(r.price.output)} out per 1M tokens`)));
  }
  // tokscale knows the session's split for today when the pane reports its
  // session id (Claude Code's statusline does).
  const s = ts && r.session ? ts.sessions[r.session] : null;
  const splitAt = s
    ? lines.push(field('today', C.text(`in ${fmtTokens(s.input)} · out ${fmtTokens(s.output)} · cache ${fmtTokens(s.cacheRead + s.cacheWrite)} · ${fmtCost(s.cost)}`) + C.dim('  via tokscale'))) - 1
    : null;
  const dirAt = typeof r.cwd === 'string' && r.cwd ? lines.push(field('dir', C.text(ui.truncate(ui.clean(r.cwd.replace(os.homedir(), '~')), room)))) - 1 : null;
  const dropOrder = [];
  if (dirAt !== null) dropOrder.push(dirAt);
  if (splitAt !== null) dropOrder.push(splitAt);
  return { lines: lines.map((l) => ui.clip(l, width)), hits, dropOrder };
}

// A workspace group header in the all workspaces view: the name framed by
// heavy rules in its workspace colour, then its pane count and any blocked
// panes. ▾ open, ▸ folded; clicking it toggles.
function wsHeader(name, rows, folded, paint) {
  const blocked = rows.filter((r) => r.status === 'blocked').length;
  const count = `${rows.length} pane${rows.length === 1 ? '' : 's'}`;
  const mark = folded ? '▸' : '▾';
  const rule = paint('━━━━━━');
  return `${paint(mark)} ${rule} ${bold(paint(name))} ${rule}  ${C.text(count)}${blocked ? `  ${C.red(`◼ ${blocked} blocked`)}` : ''}`;
}

// The alarm line at the top: blocked panes, panes over budget, and today's
// spend over the daily budget. Each alert keeps its kind so blocked reads
// differently from a budget warning. Empty when all is well.
function banner(model) {
  const parts = [];
  const blocked = model.rows.filter((r) => r.status === 'blocked');
  if (blocked.length) {
    const who = blocked.map((r) => `${r.name} ${fmtDuration(r.statusFor)}`).join(' · ');
    parts.push({ kind: 'blocked', text: `◼ ${blocked.length} BLOCKED: ${who}` });
  }
  const compact = model.rows.filter((r) => r.ctx && typeof r.ctx.v === 'number' && r.ctx.v >= 75);
  if (compact.length) {
    const who = compact.map((r) => `${r.name} ${Math.round(r.ctx.v)}%`).join(' · ');
    parts.push({ kind: 'compact', text: `⚡ ${compact.length} HIGH CTX: ${who} (compact recommended)` });
  }
  const over = model.rows.filter((r) => budgetState(r.cost.v, r.budget) === 'over');
  if (over.length) {
    const who = over.map((r) => `${r.name} ${fmtCost(r.cost.v)}/${fmtCost(r.budget)}`).join(' · ');
    parts.push({ kind: 'budget', text: `$ ${over.length} OVER BUDGET: ${who}` });
  }
  const ts = model.tokscale;
  if (ts && budgetState(ts.total, model.dailyBudget) === 'over') {
    parts.push({ kind: 'daily', text: `$ TODAY ${fmtCost(ts.total)}/${fmtCost(model.dailyBudget)}` });
  }
  const s = surge.surgeBanner(model);
  if (s) {
    parts.push({ kind: s.kind, text: s.text });
  }
  return parts;
}

// The provider behind a usage source: "agy gemini" belongs to agy.
function providerOf(source) {
  return String(source).split(' ')[0];
}

function providers(limits) {
  return [...new Set((limits || []).map((l) => providerOf(l.source)))];
}

// All limit sources belonging to a provider (e.g. ['agy other', 'agy gemini']).
function sourcesOf(limits, provider) {
  return [...new Set((limits || []).filter((l) => providerOf(l.source) === provider).map((l) => l.source))];
}

// One line per usage source: a bar per window, coloured by how full it is,
// and when it resets.
function limitsLine(l, now, hits = null, index = 0) {
  let x = 0;
  const src = ui.clean(l.source);
  x += ui.strWidth(src) + 2;

  const parts = l.windows.map((w, wi) => {
    if (wi > 0) x += 3;
    if (w.used == null) {
      if (w.name.startsWith('[')) {
        x += ui.strWidth(w.name);
        return bold(C.cyan(w.name));
      }
      const plain = w.cap ? `${w.name} ?/${w.cap}` : w.name;
      x += ui.strWidth(plain);
      return w.cap ? `${C.text(w.name)} ${C.dim(`?/${w.cap}`)}` : C.text(w.name);
    }
    const pct = Math.max(0, Math.min(100, w.used));
    const fill = Math.round(pct / 10);
    const paint = pct >= 85 ? C.red : pct >= 60 ? C.amber : C.green;
    const barWidth = ui.strWidth(w.name) + 1 + 10 + 1 + ui.strWidth(`${Math.round(w.used)}%`);
    if (hits) {
      hits.push({
        action: 'tooltip',
        text: `${w.name}: ${Math.round(w.used)}% quota used${w.resets ? ` (resets ${fmtReset(w.resets * 1000, now)})` : ''}`,
        x0: x,
        x1: x + barWidth - 1,
        index,
      });
    }
    x += barWidth;

    const cap = w.cap ? ` ${C.dim(`(${w.cap})`)}` : '';
    if (w.cap) x += ui.strWidth(` (${w.cap})`);

    const reset = w.resets ? ` ${C.dim(`resets ${fmtReset(w.resets * 1000, now)}`)}` : '';
    if (w.resets) x += ui.strWidth(` resets ${fmtReset(w.resets * 1000, now)}`);

    let pace = '';
    if (w.pace >= 0.05) {
      const p = w.pace;
      const paceVal = p >= 10 ? Math.round(p) : p.toFixed(1);
      const paceStr = ` ⚡ ${paceVal}×`;
      const paceWidth = ui.strWidth(paceStr);
      if (hits) {
        hits.push({
          action: 'tooltip',
          text: `⚡ burn pace: ${paceVal}× sustainable rate (${p >= 2 ? 'critically high burn' : p >= 1 ? 'faster than sustainable pace' : 'healthy pace'})`,
          x0: x + 1,
          x1: x + paceWidth - 1,
          index,
        });
      }
      x += paceWidth;
      const paintPace = p >= 2 ? C.red : p >= 1 ? C.amber : C.green;
      pace = ` ${bold(paintPace(`⚡ ${paceVal}×`))}`;
    }

    let eta = '';
    if (w.eta) {
      const etaStr = ` ⚠ out in ~${fmtDuration(w.eta - now)}`;
      const etaWidth = ui.strWidth(etaStr);
      if (hits) {
        hits.push({
          action: 'tooltip',
          text: `⚠ quota run-out: window exhausts in ~${fmtDuration(w.eta - now)} at current burn rate`,
          x0: x + 1,
          x1: x + etaWidth - 1,
          index,
        });
      }
      x += etaWidth;
      eta = ` ${bold(C.amber(`⚠ out in ~${fmtDuration(w.eta - now)}`))}`;
    }

    return `${C.text(w.name)} ${paint('█'.repeat(fill))}${C.dim('░'.repeat(10 - fill))} ${paint(`${Math.round(w.used)}%`)}${cap}${reset}${pace}${eta}`;
  });
  return `${bold(C.accent(ui.clean(l.source)))}  ${parts.join('   ')}`;
}

// How fast a window burns against the pace that lasts exactly until its
// reset: green under 1×, amber from 1×, red from 2×.
function paceCell(p) {
  if (!(p >= 0.05)) return '';
  const paint = p >= 2 ? C.red : p >= 1 ? C.amber : C.green;
  return ` ${bold(paint(`⚡ ${p >= 10 ? Math.round(p) : p.toFixed(1)}×`))}`;
}

function fmtReset(t, now) {
  const d = new Date(t);
  if (t - now < 24 * 3600 * 1000) return clock(t);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
}

// A background across the full width: grey for the selected row, dark red
// for a blocked one and the banner.
const BG = { selected: 237, alarm: 52 };
function bgLine(line, bg, width) {
  if (!bg) return line;
  const pad = ' '.repeat(Math.max(0, width - ui.strWidth(line)));
  if (!ui.colorOn()) {
    // Reverse video is an attribute, so a selection still reads with no colour.
    return bg === BG.selected ? `\x1b[7m${line}${pad}\x1b[27m` : line;
  }
  return `\x1b[48;5;${bg}m${line}${pad}\x1b[49m`;
}

// Reload the backups list without losing the user's place, keeping an open
// confirm and an in flight restore untouched.
function refreshBackups(st) {
  if (!st) return null;
  if (st.busy) return st;
  const list = backup.listBackups();
  const selId = st.list[st.sel] ? st.list[st.sel].workspaceId : null;
  const verAt = st.list[st.sel] && st.list[st.sel].versions[st.ver]
    ? st.list[st.sel].versions[st.ver].savedAt
    : null;
  let sel = selId ? list.findIndex((b) => b.workspaceId === selId) : -1;
  if (sel < 0) sel = Math.max(0, Math.min(st.sel || 0, list.length - 1));
  const versions = list[sel] ? list[sel].versions : [];
  let ver = verAt ? versions.findIndex((v) => v.savedAt === verAt) : -1;
  if (ver < 0) ver = Math.max(0, Math.min(st.ver || 0, versions.length - 1));
  return { list, sel, ver, confirm: st.confirm, status: st.status, busy: st.busy, layout: st.layout || 'even' };
}

// The backups view: every saved workspace, its versions, and the selected
// version drawn out (tabs, splits, panes, agents) so it can be checked by eye
// before anything is closed. r then y rebuilds it as "<label> *restored".
function backupLines(st, width, now = Date.now()) {
  const lines = [`${bold(C.title('backups'))}  ${C.dim('↑↓ workspace · ←→ version · p layout · r restore · esc close')}`];
  lines.push(C.dim(`layout: ${st.layout || 'even'} · panes share the space evenly unless you keep the saved shape`));
  if (!st.list.length) {
    lines.push(C.dim('No backups yet. The board saves one for every workspace with an agent, on each refresh.'));
    return lines;
  }
  st.list.forEach((b, i) => {
    const on = i === st.sel;
    const c = backup.counts(b.versions[0].backup);
    const vers = b.versions.map((v, j) => {
      const t = `${j + 1}:${ui.clean(backupAgo(v.savedAt, now))}`;
      return on && j === st.ver ? bold(C.cyan(`[${t}]`)) : C.dim(` ${t} `);
    }).join('');
    const name = `${on ? '▸' : ' '} ${ui.clean(b.label)} (${b.workspaceId})`;
    lines.push(`${on ? bold(C.text(name)) : C.text(name)}  ${C.dim(`${c.tabs}t ${c.panes}p ${c.agents}a`)}  ${vers}`);
  });
  const b = st.list[st.sel];
  const v = b && b.versions[st.ver];
  if (!v) return lines;
  lines.push(C.dim('─'.repeat(width)));
  if (st.confirm) {
    const c = backup.counts(v.backup);
    lines.push(bold(C.amber(ui.clean(`restore ${v.backup.label} · ${c.tabs} tabs, ${c.panes} panes, ${c.agents} agents · layout ${st.layout || 'even'} · y to confirm, any other key cancels`))));
  }
  if (st.status) lines.push(C.cyan(ui.clean(st.status)));
  // previewLines cleans every saved value itself; ui.clean here would squeeze the drawing.
  for (const l of backup.previewLines(v.backup, width, now, st.layout || 'even')) lines.push(C.text(l));
  return lines;
}

// The log view: recent conversations from the agent's own session store, so a
// closed tab can be reopened without a workspace backup. enter resumes one in
// the current workspace; a switches between that workspace and every directory.
function logViewLines(st, width, now = Date.now()) {
  const lines = [`${bold(C.title('log'))}  ${C.dim('↑↓ session · ↵ resume · a here/all · r refresh · esc close')}`];
  const n = st.items.length;
  const dirs = st.dirs.length;
  const scope = st.all ? 'every directory' : `${dirs} director${dirs === 1 ? 'y' : 'ies'} of this workspace`;
  lines.push(C.dim(`scope: ${scope} · ${n} session${n === 1 ? '' : 's'}`));
  if (st.status) lines.push(C.cyan(ui.clean(st.status)));
  if (!n) {
    lines.push(C.dim(st.busy ? 'reading the session stores…' : 'No sessions yet. A closed tab leaves its conversation in the agent store.'));
    return lines;
  }
  st.items.forEach((s, i) => {
    const on = i === st.sel;
    const text = sessionLog.line(s, now, width - 3);
    lines.push(`${on ? bold(C.cyan('▸')) : C.dim(' ')} ${on ? bold(C.text(text)) : C.text(text)}`);
  });
  return lines;
}

function backupAgo(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '?';
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)}d`;
}

// ---------------------------------------------------------------- options

function findTokscale() {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, `tokscale${ext}`);
      try {
        if (fs.existsSync(full)) return full;
      } catch {
        // Unreadable directory in PATH is skipped.
      }
    }
  }
  return null;
}

// The options view: tokscale status, compaction thresholds, active board
// settings, and storage locations. Toggle with 'o' or click [o options].
function optionsLines(model, menu, width = 100, metric = 'tokens') {
  const lines = [`${bold(C.title('options'))}  ${C.dim('o close · esc close · t tags · v view · s scope · $ metric · ? help')}`];
  lines.push('');

  const colW = Math.max(14, Math.min(18, Math.floor(width / 4)));
  const field = (k, v) => `  ${C.dim(ui.padEnd(k, colW))}${v}`;
  const section = (title) => bold(C.accent(title));

  // 1. Tokscale
  lines.push(section('TOKSCALE CONNECTION'));
  const tsBin = findTokscale();
  const ts = model.tokscale;
  if (ts) {
    lines.push(field('binary', C.green(`installed (${tsBin || 'on PATH'})`)));
    const ago = fmtDuration(Math.max(0, model.now - ts.at));
    const clients = Object.keys(ts.clients || {}).join(', ') || 'none';
    lines.push(field('status', C.text(`active · polled ${ago} ago · spend today: ${fmtCost(ts.total)}`)));
    lines.push(field('clients', C.dim(clients)));
  } else if (tsBin) {
    lines.push(field('binary', C.green(`installed (${tsBin})`)));
    lines.push(field('status', C.amber('background poll running (first run can take ~15s)')));
  } else {
    lines.push(field('binary', C.dim('not found on PATH')));
    lines.push(field('status', C.dim('optional · enables cross-agent spend tracking (github.com/junhoyeo/tokscale)')));
  }
  lines.push('');

  // 2. Compaction
  lines.push(section('CONTEXT COMPACTION'));
  lines.push(field('thresholds', C.text('≥30% notice (warm) · ≥50% warn (dilution) · ≥75% high · ≥85% critical')));
  lines.push(field('action', C.cyan('/compact recommended in high-context agent panes')));
  const over50 = model.rows.filter((r) => r.ctx && typeof r.ctx.v === 'number' && r.ctx.v >= 50);
  if (over50.length) {
    const list = over50.map((r) => `${r.name || r.paneId} (${Math.round(r.ctx.v)}%)`).join(', ');
    lines.push(field('high context', bold(C.amber(`${over50.length} pane(s): ${list}`))));
  } else {
    lines.push(field('status', C.green(`all ${model.rows.length} pane(s) within safe context (<50%)`)));
  }
  lines.push('');

  // 3. Board settings
  lines.push(section('BOARD SETTINGS'));
  const tagMode = menu ? menu.tags : 'off';
  const viewMode = menu ? menu.view : 'auto';
  const scopeMode = menu ? menu.scope : 'here';
  lines.push(field('tags (t)', C.text(`${tagMode}  ${C.dim('(cycle: label ▸ tokens ▸ metadata ▸ off)')}`)));
  lines.push(field('layout (v)', C.text(`${viewMode}  ${C.dim('(cycle: auto ▸ line ▸ wrap ▸ cards)')}`)));
  lines.push(field('scope (s)', C.text(`${scopeMode}  ${C.dim('(cycle: here ▸ all)')}`)));
  lines.push(field('metric ($)', C.text(`${metric}  ${C.dim('(cycle: tokens ▸ cost)')}`)));
  const budgetStr = model.dailyBudget ? fmtCost(model.dailyBudget) : 'none';
  const spendStr = ts ? fmtCost(ts.total) : (model.rows.some((r) => r.cost.v !== null) ? fmtCost(model.rows.reduce((acc, r) => acc + (r.cost.v || 0), 0)) : 'none');
  lines.push(field('daily budget', C.text(`${budgetStr}  ${C.dim(`(spent: ${spendStr})`)}`)));
  lines.push('');

  // 4. Paths & Storage
  lines.push(section('PATHS & STORAGE'));
  lines.push(field('config', C.dim(config.configPath())));
  lines.push(field('ledger', C.dim(ledger.ledgerPath())));
  lines.push(field('backups', C.dim(backup.backupsDir())));
  lines.push('');

  // 5. Community arena read path (explicit; never automatic)
  lines.push(section('COMMUNITY LEADERBOARDS'));
  lines.push(field('page', C.cyan('https://roostr.mando.works/leaderboards')));
  lines.push(field('summary', C.dim('https://roostr.mando.works/arena/global-summary.json')));
  lines.push(field('import', C.text('roostr arena import --from <file>')));
  lines.push(field('note', C.dim('download/save the file yourself; no auto fetch or import')));

  return lines;
}

// ------------------------------------------------------------------ setup

const TASK_KIND_ROWS = config.TASK_KINDS.map((kind) => `kind:${kind}`);
const SETUP_ROWS = [
  'tools', 'default', 'head', 'language', 'fast', 'balanced', 'reasoning',
  'head-honcho', 'worker', 'reviewer',
  ...TASK_KIND_ROWS,
  'grill', 'disabled', 'save',
];
const ROLE_EFFORTS = ['low', 'medium', 'high'];
const KIND_EFFORTS = ['', ...config.EFFORTS];

function taskKindOf(row) {
  return typeof row === 'string' && row.startsWith('kind:') ? row.slice(5) : null;
}

function isKnownTaskKind(kind) {
  return Boolean(kind) && config.TASK_KINDS.includes(kind);
}

function cycleValue(list, value) {
  return list[(list.indexOf(value) + 1 + list.length) % list.length];
}
const GRILL_MODES = ['recommended', 'none', 'custom'];

function cloneConfig(cfg) {
  return JSON.parse(JSON.stringify(cfg));
}

function summaryModelStats() {
  const data = state.readJson(advisor.summaryPath());
  const out = {};
  if (!data || typeof data.by_kind_model !== 'object' || data.by_kind_model === null) return out;
  for (const models of Object.values(data.by_kind_model)) {
    if (!models || typeof models !== 'object') continue;
    for (const [model, s] of Object.entries(models)) {
      if (!s || !s.count) continue;
      const cur = out[model] || { count: 0, pass: 0, costSum: 0, costN: 0 };
      cur.count += s.count;
      if (Number.isFinite(s.first_try_pass_rate)) cur.pass += (s.first_try_pass_rate * s.count) / 100;
      if (Number.isFinite(s.avg_cost_usd)) {
        cur.costSum += s.avg_cost_usd * s.count;
        cur.costN += s.count;
      }
      out[model] = cur;
    }
  }
  return out;
}

function modelStatLine(s) {
  if (!s || s.count < 3) return '';
  const rate = Math.round((s.pass / s.count) * 100);
  const cost = s.costN ? ` · $${(s.costSum / s.costN).toFixed(2)} avg` : '';
  return `  ${s.count} runs · ${rate}% first try${cost}`;
}

function setupState(cfg, warnings = []) {
  const c = cloneConfig(cfg);
  const headIndex = c.headName === 'auto' ? 0 : Math.max(0, config.HEAD_NAMES.findIndex((h) => h.name === c.headName));
  return { config: c, row: 0, toolIndex: 0, headIndex, disabledIndex: 0, edit: null, warnings: [...warnings], error: null, modelStats: summaryModelStats() };
}

function disabledCandidates(cfg) {
  return [...new Set(['fast', 'balanced', 'reasoning'].map((t) => cfg.models[t]).filter(Boolean))];
}

function setupLines(st, width) {
  const c = st.config;
  const at = (key) => st.row === SETUP_ROWS.indexOf(key);
  const mark = (key) => (at(key) ? C.cyan('› ') : '  ');
  const lines = [
    `${bold(C.title('setup'))}  ${C.dim('coding tools and preferred models')}`,
    '',
  ];
  const enabled = [...c.tools, ...c.customTools];
  const toolCell = (name, i) => {
    const on = c.tools.includes(name);
    const cursor = at('tools') && st.toolIndex === i ? '›' : ' ';
    return `${cursor}[${on ? 'x' : ' '}]${name}`;
  };
  lines.push(`${mark('tools')}${C.dim(ui.padEnd('tools', 12))}${config.TOOLS.map(toolCell).join(' ')}`);
  const field = (key, label, value) => lines.push(`${mark(key)}${C.dim(ui.padEnd(label, 12) + ' ')}${value}`);
  field('default', 'default', C.text(c.defaultTool));
  const head = config.HEAD_NAMES.find((h) => h.name === c.headName);
  field('head', 'head name', c.headName === 'auto'
    ? `${C.text('auto')}${C.dim(' (random boss title)')} ${C.dim('← →')}`
    : `${C.text(c.headName)}${head ? C.dim(` (${head.meaning})`) : ''} ${C.dim('← →')}`);
  field('language', 'language', `${C.text(c.headLanguage)} ${C.dim('← →')}`);
  for (const tier of ['fast', 'balanced', 'reasoning']) {
    const name = c.models[tier];
    const stat = name ? modelStatLine(st.modelStats[name]) : '';
    field(tier, tier, (name ? C.text(name) : C.dim('<unset>')) + (stat ? C.dim(stat) : ''));
  }
  for (const role of config.ROLES) {
    const r = c.roles[role];
    const models = c.models[config.TIER_BY_EFFORT[r.effort]] || '';
    const model = r.model || models;
    field(role, role, `${C.text(r.tool)} ${C.dim('·')} ${model ? C.text(model) : C.dim('<unset>')} ${C.dim('·')} ${C.text(r.effort)}`);
  }
  for (const kind of config.TASK_KINDS) {
    const t = c.taskKinds[kind] || {};
    const fallbacks = Array.isArray(t.fallbacks) && t.fallbacks.length ? t.fallbacks.join(',') : 'none';
    field(`kind:${kind}`, `task ${kind}`, `${t.tool ? C.text(t.tool) : C.dim('auto')} ${C.dim('·')} ${t.model ? C.text(t.model) : C.dim('auto')} ${C.dim('·')} ${t.effort ? C.text(t.effort) : C.dim('auto')} ${C.dim('·')} fb ${C.text(fallbacks)}`);
  }
  const grill = c.grillSkill.mode === 'recommended' ? 'recommended (grill-with-ui)' : c.grillSkill.mode;
  field('grill', 'grill skill', C.text(grill));
  const candidates = disabledCandidates(c);
  if (!candidates.length) {
    field('disabled', 'disabled', C.dim('no models configured'));
  } else {
    lines.push(`${mark('disabled')}${C.dim(ui.padEnd('disabled', 12))}${candidates.map((m, i) => {
      const on = c.disabledModels.includes(m);
      const cursor = at('disabled') && st.disabledIndex === i ? '›' : ' ';
      return `${cursor}[${on ? 'x' : ' '}] ${m}`;
    }).join('   ')}`);
  }
  field('save', '', at('save') ? bold(C.green('save')) : C.text('save'));
  if (st.edit) {
    lines.push('');
    lines.push(`${C.gold('editing: ')}${C.text(st.edit.text)}${C.gold('█')}${C.dim('  ↵ save · esc cancel')}`);
  }
  for (const w of st.warnings) lines.push(C.amber(ui.clean(`config: ${w}`)));
  if (st.error) lines.push(C.red(ui.clean(st.error)));
  return lines.map((l) => ui.clip(l, width));
}

function setupCycle(st, dir) {
  const c = st.config;
  const row = SETUP_ROWS[st.row];
  const cycle = (list, v) => list[(list.indexOf(v) + dir + list.length) % list.length];
  if (row === 'tools') st.toolIndex = (st.toolIndex + dir + config.TOOLS.length) % config.TOOLS.length;
  else if (row === 'head') {
    st.headIndex = (st.headIndex + dir + config.HEAD_NAMES.length) % config.HEAD_NAMES.length;
    c.headName = config.HEAD_NAMES[st.headIndex].name;
  } else if (row === 'language') c.headLanguage = cycle(config.LANGUAGES, c.headLanguage);
  else if (row === 'grill') c.grillSkill.mode = cycle(GRILL_MODES, c.grillSkill.mode);
  else if (row === 'disabled') {
    const n = disabledCandidates(c).length;
    if (n) st.disabledIndex = (st.disabledIndex + dir + n) % n;
  } else if (config.ROLES.includes(row)) {
    const tools = [...c.tools, ...c.customTools];
    if (tools.length) c.roles[row].tool = cycle(tools, c.roles[row].tool);
  } else if (isKnownTaskKind(taskKindOf(row))) {
    const kind = taskKindOf(row);
    const tools = [...c.tools, ...c.customTools, ''];
    if (!c.taskKinds[kind]) c.taskKinds[kind] = { tool: '', model: '', fallbacks: [], effort: '' };
    c.taskKinds[kind].tool = cycle(tools, c.taskKinds[kind].tool);
  }
  st.error = null;
  return null;
}

function setupSpace(st) {
  const c = st.config;
  const row = SETUP_ROWS[st.row];
  if (row === 'tools') {
    const tool = config.TOOLS[st.toolIndex];
    c.tools = c.tools.includes(tool) ? c.tools.filter((t) => t !== tool) : [...c.tools, tool];
  } else if (row === 'disabled') {
    const model = disabledCandidates(c)[st.disabledIndex];
    if (model) {
      c.disabledModels = c.disabledModels.includes(model)
        ? c.disabledModels.filter((m) => m !== model)
        : [...c.disabledModels, model];
    }
  } else if (row === 'grill') {
    c.grillSkill.mode = GRILL_MODES[(GRILL_MODES.indexOf(c.grillSkill.mode) + 1) % GRILL_MODES.length];
  } else if (config.ROLES.includes(row)) {
    const effort = c.roles[row].effort;
    c.roles[row].effort = ROLE_EFFORTS[(ROLE_EFFORTS.indexOf(effort) + 1) % ROLE_EFFORTS.length];
    c.roles[row].model = c.models[config.TIER_BY_EFFORT[c.roles[row].effort]] || c.roles[row].model;
  } else if (isKnownTaskKind(taskKindOf(row))) {
    const kind = taskKindOf(row);
    if (!c.taskKinds[kind]) c.taskKinds[kind] = { tool: '', model: '', fallbacks: [], effort: '' };
    const effort = c.taskKinds[kind].effort || '';
    c.taskKinds[kind].effort = cycleValue(KIND_EFFORTS, effort);
  } else if (row === 'save') {
    return { save: true };
  }
  st.error = null;
  return null;
}

function setupEnter(st) {
  const c = st.config;
  const row = SETUP_ROWS[st.row];
  const open = (field, text, extra = {}) => {
    st.edit = { field, text, ...extra };
    st.error = null;
  };
  if (row === 'save') return { save: true };
  if (row === 'default') open('default', c.defaultTool);
  else if (row === 'head') open('head', c.headName);
  else if (['fast', 'balanced', 'reasoning'].includes(row)) open('model', c.models[row] || '', { tier: row });
  else if (row === 'grill') {
    if (c.grillSkill.mode === 'custom') open('command', c.grillSkill.command || '');
    else c.grillSkill.mode = GRILL_MODES[(GRILL_MODES.indexOf(c.grillSkill.mode) + 1) % GRILL_MODES.length];
  } else if (config.ROLES.includes(row)) {
    const effort = c.roles[row].effort;
    c.roles[row].effort = ROLE_EFFORTS[(ROLE_EFFORTS.indexOf(effort) + 1) % ROLE_EFFORTS.length];
    c.roles[row].model = c.models[config.TIER_BY_EFFORT[c.roles[row].effort]] || c.roles[row].model;
  } else if (isKnownTaskKind(taskKindOf(row))) {
    const kind = taskKindOf(row);
    if (!c.taskKinds[kind]) c.taskKinds[kind] = { tool: '', model: '', fallbacks: [], effort: '' };
    open('task-model', c.taskKinds[kind].model || '', { kind });
  }
  return null;
}

function setupApplyEdit(st) {
  const { field, text, tier } = st.edit;
  const c = st.config;
  const v = String(text).trim();
  if (field === 'model') {
    if (v) c.models[tier] = v;
    else delete c.models[tier];
  } else if (field === 'default') c.defaultTool = v;
  else if (field === 'head') {
    const wanted = v.toLowerCase();
    if (wanted === 'auto' || config.HEAD_NAMES.some((h) => h.name === wanted)) {
      c.headName = wanted;
      st.headIndex = wanted === 'auto' ? 0 : Math.max(1, ['auto', ...config.HEAD_NAMES.map((h) => h.name)].indexOf(wanted));
    } else {
      st.error = 'head name must be auto or a known boss title; kept the old value';
    }
  } else if (field === 'command') c.grillSkill.command = v;
  else if (field === 'task-model' && config.TASK_KINDS.includes(st.edit.kind)) {
    if (!c.taskKinds[st.edit.kind]) c.taskKinds[st.edit.kind] = { tool: '', model: '', fallbacks: [], effort: '' };
    c.taskKinds[st.edit.kind].model = v;
  } else if (field === 'task-fallbacks' && config.TASK_KINDS.includes(st.edit.kind)) {
    if (!c.taskKinds[st.edit.kind]) c.taskKinds[st.edit.kind] = { tool: '', model: '', fallbacks: [], effort: '' };
    const seen = new Set();
    c.taskKinds[st.edit.kind].fallbacks = v.split(',').map((x) => x.trim()).filter((x) => {
      if (!x || seen.has(x)) return false;
      seen.add(x);
      return true;
    }).slice(0, 5);
  }
  st.edit = null;
  st.error = null;
}

function setupKey(st, key) {
  if (st.edit) {
    const e = editChunk(key);
    if (e.action === 'save') setupApplyEdit(st);
    else if (e.action === 'cancel') st.edit = null;
    else if (e.action === 'backspace') st.edit.text = Array.from(st.edit.text).slice(0, -1).join('');
    else if (e.action === 'ignore') return null;
    else st.edit.text += e.text;
    return null;
  }
  if (key === '\x1b' || key === '\x03') return { cancel: true };
  if (key === 'f' && isKnownTaskKind(taskKindOf(SETUP_ROWS[st.row]))) {
    const kind = taskKindOf(SETUP_ROWS[st.row]);
    if (!st.config.taskKinds[kind]) st.config.taskKinds[kind] = { tool: '', model: '', fallbacks: [], effort: '' };
    st.edit = { field: 'task-fallbacks', kind, text: st.config.taskKinds[kind].fallbacks.join(', ') };
    st.error = null;
    return null;
  }
  if (key === '\x1b[A' || key === 'k') st.row = (st.row - 1 + SETUP_ROWS.length) % SETUP_ROWS.length;
  else if (key === '\x1b[B' || key === 'j') st.row = (st.row + 1) % SETUP_ROWS.length;
  else if (key === '\x1b[D' || key === 'h') return setupCycle(st, -1);
  else if (key === '\x1b[C' || key === 'l') return setupCycle(st, 1);
  else if (key === ' ') return setupSpace(st);
  else if (key === '\r' || key === '\n') return setupEnter(st);
  return null;
}

function setupReady(st) {
  const c = st.config;
  if (!c.tools.length && !c.customTools.length) {
    st.error = 'select at least one tool';
    return false;
  }
  if (![...c.tools, ...c.customTools].includes(c.defaultTool)) c.defaultTool = [...c.tools, ...c.customTools][0];
  return true;
}

// ------------------------------------------------------------------ head picker

function headLines(st, width) {
  const title = st.title || 'head-honcho';
  const lines = [`${bold(C.title(title))}  ${C.dim('pick a shell pane in this workspace')}`];
  if (!st.panes.length) {
    lines.push(C.amber('no shell pane in this workspace; split one and try again'));
    return lines.map((l) => ui.clip(l, width));
  }
  st.panes.forEach((p, i) => {
    const on = i === st.index;
    const name = ui.clean(p.label || p.paneId);
    const dir = p.cwd ? ` ${C.dim(ui.truncate(ui.clean(p.cwd.replace(os.homedir(), '~')), Math.max(8, width - 30)))}` : '';
    lines.push(`${on ? bold(C.cyan('›')) : ' '} ${on ? bold(C.text(name)) : C.text(name)} ${C.dim(p.paneId)}${dir}`);
  });
  if (st.confirm) {
    const p = st.panes[st.index];
    lines.push(bold(C.amber(ui.clean(`start ${title} in ${p.label || p.paneId} (${p.paneId})? y to go, any other key cancels`))));
  }
  if (st.status) lines.push(C.cyan(ui.clean(st.status)));
  return lines.map((l) => ui.clip(l, width));
}

// ------------------------------------------------------------ orchestrate TUI

const ORCHESTRATE_TABS = ['tasks', 'analytics', 'daemon', 'setup'];
const ORCH_WINDOWS = [
  { label: '7d', days: 7, today: false },
  { label: 'today', days: 1, today: true },
  { label: '30d', days: 30, today: false },
];

function shortDir(dir) {
  if (!dir || typeof dir !== 'string') return '?';
  return ui.clean(dir.replace(os.homedir(), '~'));
}

function resolveRepoRoot(dir) {
  if (!dir || typeof dir !== 'string') return null;
  let cur = path.resolve(dir);
  for (let i = 0; i < 4; i++) {
    try {
      if (
        fs.existsSync(path.join(cur, 'docs', 'orchestration', 'tasks.json')) ||
        fs.existsSync(path.join(cur, 'docs', 'orchestration-plan.md')) ||
        fs.existsSync(path.join(cur, '.roostr.toml')) ||
        fs.existsSync(path.join(cur, '.crew-board.toml'))
      ) {
        return cur;
      }
    } catch {
      // ignore unreadable path
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(dir);
}

function discoverPlanDirs(model, preferredDir = null) {
  const seen = new Set();
  const candidates = [];
  const add = (d) => {
    const resolved = resolveRepoRoot(d);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push(resolved);
  };
  if (preferredDir) add(preferredDir);
  if (model && Array.isArray(model.rows)) {
    const home = model.home || null;
    for (const r of model.rows) {
      if ((!home || r.workspaceId === home) && r.cwd) add(r.cwd);
    }
    for (const r of model.rows) {
      if (r.cwd) add(r.cwd);
    }
  }
  if (model && Array.isArray(model.crews)) {
    for (const c of model.crews) if (c && c.dir) add(c.dir);
  }
  add(process.cwd());
  const score = (d) => {
    try {
      if (fs.existsSync(path.join(d, 'docs', 'orchestration', 'tasks.json'))) return 2;
      if (fs.existsSync(path.join(d, 'docs', 'orchestration-plan.md'))) return 1;
    } catch {}
    return 0;
  };
  return candidates.sort((a, b) => score(b) - score(a));
}

function loadPlanTasks(planDir, cfg, crew = null) {
  const dir = planDir || process.cwd();
  const tasksFile = path.join(dir, 'docs', 'orchestration', 'tasks.json');
  const planFile = path.join(dir, 'docs', 'orchestration-plan.md');
  const hasTasksFile = fs.existsSync(tasksFile);
  const hasPlanFile = fs.existsSync(planFile);
  if (!hasTasksFile) {
    return {
      planDir: dir,
      tasksFile,
      hasTasksFile: false,
      planFile,
      hasPlanFile,
      plan: hasPlanFile ? 'docs/orchestration-plan.md' : null,
      rows: [],
      errors: [],
    };
  }
  try {
    const raw = tasks.load(tasksFile);
    const checked = tasks.validate(raw);
    const rows = checked.tasks.length ? tasks.enrich(checked, { config: cfg, crew }) : [];
    return {
      planDir: dir,
      tasksFile,
      hasTasksFile: true,
      planFile,
      hasPlanFile,
      plan: checked.plan || (hasPlanFile ? 'docs/orchestration-plan.md' : 'docs/orchestration/tasks.json'),
      rows,
      errors: checked.errors,
    };
  } catch (e) {
    return {
      planDir: dir,
      tasksFile,
      hasTasksFile: true,
      planFile,
      hasPlanFile,
      plan: null,
      rows: [],
      errors: [(e && e.message) || String(e)],
    };
  }
}

function saveTaskOverride(tasksFile, taskId, patch) {
  const raw = tasks.load(tasksFile);
  if (!raw || !Array.isArray(raw.tasks)) throw new Error('invalid tasks.json');
  const item = raw.tasks.find((t) => t && t.id === taskId);
  if (!item) throw new Error(`task "${taskId}" not found`);
  for (const [k, v] of Object.entries(patch)) {
    if (v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0)) {
      delete item[k];
    } else {
      item[k] = v;
    }
  }
  fs.writeFileSync(tasksFile, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

function workspaceRows(model) {
  if (!model || !Array.isArray(model.rows)) return [];
  const home = model.home || null;
  const inHome = home ? model.rows.filter((r) => r.workspaceId === home) : [];
  return inHome.length ? inHome : model.rows;
}

function orchestrateState(model, cfg, warnings = [], initialTab = 'tasks', preferredDir = null) {
  const c = cfg || config.defaultConfig();
  const planDirs = discoverPlanDirs(model, preferredDir);
  const wsRows = workspaceRows(model);
  const headRow = wsRows.find((r) => r.role === 'head-honcho')
    || wsRows.find((r) => config.HEAD_NAMES.some((h) => String(r.name || '').toLowerCase().startsWith(h.name)))
    || wsRows[0]
    || null;
  return {
    tab: ORCHESTRATE_TABS.includes(initialTab) ? initialTab : 'tasks',
    planDirs,
    planIndex: 0,
    headPaneId: headRow ? headRow.paneId : null,
    taskRow: 0,
    kindRow: 0,
    edit: null,
    by: 'model',
    windowIndex: 0,
    setup: setupState(c, warnings),
    notice: null,
    error: null,
  };
}

// The daemon tab: what the deterministic supervisor knows, next to the plan
// it follows. Reads the same state file the daemon writes; with no file yet it
// says so instead of inventing activity.
function daemonLines(st, model, cfg, planDir, width) {
  const lines = [`${bold(C.title('daemon'))}  ${C.dim('event-driven · zero tokens · read only')}`, ''];
  const loaded = loadPlanTasks(planDir, cfg);
  const counts = { working: 0, pending: 0, done: 0, blocked: 0 };
  for (const r of loaded.rows) if (counts[r.status] !== undefined) counts[r.status]++;
  const planName = loaded.hasTasksFile ? 'tasks.json' : (loaded.hasPlanFile ? 'orchestration-plan.md' : 'no plan file yet');
  lines.push(`  ${bold(C.accent('PLAN'))}  ${C.text(planName)} ${C.dim(`· ${loaded.rows.length} tasks: ${counts.working} working, ${counts.pending} pending, ${counts.done} done${counts.blocked ? `, ${counts.blocked} blocked` : ''}`)}`);
  if (loaded.errors.length) {
    for (const e of loaded.errors) lines.push(C.red(ui.clean(`  tasks.json: ${e}`)));
  } else if (!loaded.rows.length) {
    lines.push(C.dim('  no tasks to show; the Head Honcho writes docs/orchestration/tasks.json'));
  } else {
    for (const r of loaded.rows.slice(0, Math.max(3, Math.min(12, Math.floor((width - 20) / 6))))) {
      const mark = r.status === 'done' ? C.green('✓') : r.status === 'working' ? C.cyan('●') : r.status === 'blocked' ? C.red('◼') : C.dim('○');
      lines.push(`  ${mark} ${C.dim(ui.padEnd(String(r.id || '?'), 12))} ${C.dim(ui.padEnd(String(r.kind || '?'), 9))} ${C.text(ui.truncate(ui.clean(r.title || ''), Math.max(12, width - 34)))}`);
    }
  }

  lines.push('');
  const stateFile = daemon.daemonStateFile();
  let dState = null;
  if (fs.existsSync(stateFile)) {
    try { dState = daemon.loadDaemonState(stateFile); } catch (e) { dState = null; }
  }
  if (!dState) {
    lines.push(`  ${bold(C.accent('DAEMON'))}  ${C.dim('no state yet · waiting for the first lifecycle event')}`);
    lines.push(C.dim('  start it with the crew file [daemon] ladder; it writes daemon-state.json'));
    return lines.map((l) => ui.clip(l, width));
  }
  const panes = Object.values(dState.panes || {});
  const wakes = (dState.wakes && (Number(dState.wakes.perEventCount) || 0) + (Number(dState.wakes.perDigestCount) || 0)) || 0;
  lines.push(`  ${bold(C.accent('DAEMON'))}  ${C.text(`${panes.length} panes tracked`)} ${C.dim(`· wakes ${wakes}/${daemon.MAX_WAKES_PER_DAY} today · breaker ${(dState.circuitBreaker && dState.circuitBreaker.status) || 'normal'}`)}`);
  const order = { blocked: 0, working: 1, idle: 2, done: 3, unknown: 4 };
  for (const p of panes.slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)).slice(0, 12)) {
    const colour = p.status === 'blocked' ? C.red : p.status === 'working' ? C.cyan : p.status === 'done' ? C.green : C.dim;
    const age = Number.isFinite(p.since) ? fmtDuration(Math.max(0, Date.now() - p.since)) : '?';
    lines.push(`  ${colour(ui.padEnd(String(p.status || '?'), 8))} ${C.dim(ui.padEnd(String(p.pane || '?'), 10))} ${C.dim(`${age}${p.promptClass ? ` · ${ui.clean(p.promptClass)}` : ''}`)}`);
  }
  let escalations = [];
  try { escalations = JSON.parse(fs.readFileSync(daemon.escalationsFile(), 'utf8')); } catch (e) { escalations = []; }
  if (Array.isArray(escalations) && escalations.length) {
    lines.push('');
    lines.push(`  ${bold(C.accent('ESCALATIONS'))}  ${C.dim(`${escalations.length} queued`)}`);
    for (const e of escalations.slice(-5)) {
      lines.push(`  ${C.amber(ui.clean(String(e.severity || 'routine')))} ${C.dim(ui.padEnd(String(e.type || '?'), 18))} ${C.text(ui.truncate(ui.clean(e.reason || ''), Math.max(12, width - 38)))}`);
    }
  }
  const ladders = new Set();
  for (const r of (model && model.rows) || []) {
    const l = r.crew && r.crew.daemon && r.crew.daemon.ladder;
    if (!l) continue;
    if (l.nudgeSeconds) ladders.add(`nudge ${l.nudgeSeconds}s`);
    if (l.recycleSeconds) ladders.add(`recycle ${l.recycleSeconds}s`);
    if (l.escalateSeconds) ladders.add(`escalate ${l.escalateSeconds}s`);
  }
  if (ladders.size) lines.push('', C.dim(`  ladder: ${[...ladders].join(' · ')}`));
  return lines.map((l) => ui.clip(l, width));
}

function orchestrateLines(stOrModel, modelOrWidth, widthOrSt = 100, hits = null, y0 = 0) {
  let st;
  let model;
  let width;
  let hitsArg;
  let y0Arg;

  if (stOrModel && Array.isArray(stOrModel.rows)) {
    model = stOrModel;
    width = typeof modelOrWidth === 'number' ? modelOrWidth : 100;
    st = widthOrSt;
    hitsArg = hits;
    y0Arg = typeof y0 === 'number' ? y0 : 0;
  } else {
    st = stOrModel;
    model = modelOrWidth;
    width = typeof widthOrSt === 'number' ? widthOrSt : 100;
    hitsArg = hits;
    y0Arg = typeof y0 === 'number' ? y0 : 0;
  }

  const localHits = [];
  const addHit = (h) => {
    localHits.push(h);
    if (hitsArg && Array.isArray(hitsArg)) {
      hitsArg.push({ ...h, y: y0Arg + h.y });
    }
  };

  const tabLabels = [
    ['tasks', '1 tasks · advisor'],
    ['analytics', '2 analytics · summary'],
    ['daemon', '3 daemon · plan'],
    ['setup', '4 setup'],
  ];
  let head = `${bold(C.title('orchestrate'))}  `;
  let x = ui.strWidth(head);
  for (const [key, label] of tabLabels) {
    const active = st.tab === key;
    const text = `[${label}]`;
    const w = ui.strWidth(text);
    if (x + w < width) {
      addHit({ action: 'orch-tab', tab: key, y: 0, x0: x, x1: x + w - 1 });
    }
    head += (active ? bold(C.cyan(text)) : C.dim(text)) + ' ';
    x += w + 1;
  }
  const closePill = '[esc close]';
  const cw = ui.strWidth(closePill);
  if (x + cw < width) {
    addHit({ action: 'orch-close', y: 0, x0: x, x1: x + cw - 1 });
    head += C.dim(closePill) + ' ';
    x += cw + 1;
  }
  const hint = 'tab/1-4 switch';
  if (x + ui.strWidth(hint) <= width) head += C.dim(hint);
  const lines = [head, ''];

  const cfg = st.setup ? st.setup.config : config.defaultConfig();
  const planDir = (st.planDirs && st.planDirs[st.planIndex]) || process.cwd();

  if (st.tab === 'setup') {
    const sub = setupLines(st.setup, width);
    return { lines: [...lines, ...sub].map((l) => ui.clip(l, width)), hits: localHits };
  }

  if (st.tab === 'daemon') {
    const sub = daemonLines(st, model, cfg, planDir, width);
    return { lines: [...lines, ...sub].map((l) => ui.clip(l, width)), hits: localHits };
  }

  if (st.tab === 'analytics') {
    const barY = lines.length;
    let byBar = '';
    let bx = ui.strWidth('  by (b/←→): ');
    for (const v of analytics.VIEWS) {
      const active = v === st.by;
      const pill = `[${v}]`;
      const w = ui.strWidth(pill);
      addHit({ action: 'orch-by', by: v, y: barY, x0: bx, x1: bx + w - 1 });
      byBar += (active ? bold(C.cyan(pill)) : C.dim(pill)) + ' ';
      bx += w + 1;
    }
    bx += ui.strWidth('  window (d): ');
    let winBar = '';
    for (let i = 0; i < ORCH_WINDOWS.length; i++) {
      const wnd = ORCH_WINDOWS[i];
      const active = i === st.windowIndex;
      const pill = `[${wnd.label}]`;
      const w = ui.strWidth(pill);
      addHit({ action: 'orch-window', index: i, y: barY, x0: bx, x1: bx + w - 1 });
      winBar += (active ? bold(C.cyan(pill)) : C.dim(pill)) + ' ';
      bx += w + 1;
    }
    const refPill = '[s refresh summary]';
    const rw = ui.strWidth(refPill);
    addHit({ action: 'orch-refresh-summary', y: barY, x0: bx, x1: bx + rw - 1 });
    lines.push(`  ${C.dim('by (b/←→):')} ${byBar}  ${C.dim('window (d):')} ${winBar}  ${C.dim(refPill)}`);

    const sumData = state.readJson(advisor.summaryPath());
    if (sumData && Number.isFinite(sumData.runs)) {
      const kindCount = Object.keys(sumData.by_kind || {}).length;
      lines.push(`  ${C.dim('summary.json:')} ${C.text(`${sumData.runs} finished runs across ${kindCount} task kind${kindCount === 1 ? '' : 's'}`)}`);
    } else {
      lines.push(`  ${C.dim('summary.json:')} ${C.amber('no summary yet · press s to build from ledger')}`);
    }

    let orchCost = 0;
    let workerCost = 0;
    let orchTokens = 0;
    let workerTokens = 0;
    if (model && Array.isArray(model.rows)) {
      for (const r of model.rows) {
        const isOrch = /^(head-honcho|orchestrator|lead)$/i.test(String(r.role || ''));
        const cost = r.cost && typeof r.cost.v === 'number' ? r.cost.v : (typeof r.cost === 'number' ? r.cost : 0);
        const tokens = r.tokens && typeof r.tokens.v === 'number' ? r.tokens.v : (typeof r.tokens === 'number' ? r.tokens : 0);
        if (isOrch) {
          if (cost > 0) orchCost += cost;
          if (tokens > 0) orchTokens += tokens;
        } else {
          if (cost > 0) workerCost += cost;
          if (tokens > 0) workerTokens += tokens;
        }
      }
    }
    const useCost = (orchCost + workerCost) > 0;
    const orchVal = useCost ? orchCost : orchTokens;
    const workerVal = useCost ? workerCost : workerTokens;
    const totalVal = orchVal + workerVal;
    if (totalVal > 0) {
      const workerPct = Math.round((workerVal / totalVal) * 100);
      const orchPct = 100 - workerPct;
      const workerBlocks = Math.max(0, Math.min(10, Math.round((workerPct / 100) * 10)));
      const bar = '█'.repeat(workerBlocks) + '░'.repeat(10 - workerBlocks);
      const pctPaint = workerPct >= 80 ? C.green : (workerPct >= 60 ? C.yellow : C.red);
      lines.push(`  ${C.dim('delegation share:')} ${C.cyan(bar)} ${pctPaint(`${workerPct}% workers`)} ${C.dim('·')} ${C.text(`${orchPct}% orchestrator`)}  ${C.dim('(target ≥80% workers)')}`);
    }
    lines.push('');
    const win = ORCH_WINDOWS[st.windowIndex] || ORCH_WINDOWS[0];
    const tasksFile = path.join(planDir, 'docs', 'orchestration', 'tasks.json');
    const res = analytics.query({ days: win.days, today: win.today, by: st.by, tasksFile });
    for (const l of analytics.formatText(res).split('\n')) {
      lines.push(`  ${C.text(ui.clean(l))}`);
    }
    if (st.notice) lines.push('', bold(C.green(`  ✓ ${ui.clean(st.notice)}`)));
    if (st.error) lines.push('', C.red(`  ${ui.clean(st.error)}`));
    return { lines: lines.map((l) => ui.clip(l, width)), hits: localHits };
  }

  // Tab 1: Launch & Plan Header + Tasks & Advisor Table
  const wsRows = workspaceRows(model);
  const headRow = wsRows.find((r) => r.paneId === st.headPaneId)
    || wsRows.find((r) => r.role === 'head-honcho')
    || wsRows[0]
    || null;
  const loaded = loadPlanTasks(planDir, cfg);
  const field = (k, v) => `  ${C.dim(ui.padEnd(k, 14))}${v}`;

  const headDesc = headRow
    ? `${bold(C.text(ui.clean(headRow.name)))} ${C.dim(`(${headRow.kind} · ${headRow.paneId})`)}${headRow.role === 'head-honcho' ? ` ${C.green('[head-honcho]')}` : ''}`
    : C.amber('<none>');
  lines.push(field('orchestrator', `${headDesc}   ${C.dim('o cycle pane · g assign head-honcho · N spawn shell')}`));

  const counts = {
    working: loaded.rows.filter((r) => r.status === 'working').length,
    pending: loaded.rows.filter((r) => r.status === 'pending').length,
    done: loaded.rows.filter((r) => r.status === 'done').length,
  };
  const planStatus = loaded.hasTasksFile
    ? `${C.green('tasks.json')} ${C.text(`(${loaded.rows.length} tasks: ${counts.working} working, ${counts.pending} pending, ${counts.done} done)`)}`
    : (loaded.hasPlanFile ? `${C.amber('orchestration-plan.md')} ${C.dim('(no tasks.json yet)')}` : C.dim('no plan file yet'));
  const repoIdx = st.planDirs && st.planDirs.length > 1 ? ` (${st.planIndex + 1}/${st.planDirs.length})` : '';
  lines.push(field('active plan', `${C.text(shortDir(planDir))}${C.dim(repoIdx)} · ${planStatus}   ${C.dim('p cycle repo · s summary')}`));

  lines.push(C.dim('  ' + '─'.repeat(Math.max(10, width - 4))));

  if (loaded.errors.length) {
    for (const e of loaded.errors) lines.push(C.red(`  tasks.json: ${ui.clean(e)}`));
  }

  if (loaded.hasTasksFile && loaded.rows.length > 0) {
    const selIdx = Math.max(0, Math.min(st.taskRow, loaded.rows.length - 1));
    lines.push(`  ${bold(C.accent('TASKS & ADVISOR'))}  ${C.dim('↑↓ task · ←→ tool · space effort · ↵ model · c copy · f fallbacks')}`);
    if (width < 92) {
      lines.push(C.dim(`    ${ui.padEnd('id', 8)} ${ui.padEnd('st', 7)} ${ui.padEnd('kind', 12)} ${ui.padEnd('eff', 4)} ${ui.padEnd('model', 18)} title`));
      loaded.rows.forEach((r, i) => {
        const on = i === selIdx;
        const rec = r.recommendation || {};
        const mark = on ? bold(C.cyan('  › ')) : '    ';
        const modelStr = rec.recommendedModel || (rec.requiresModelChoice ? '<choose>' : 'auto');
        const conf = String(rec.confidence || '').toLowerCase();
        const effPaint = conf === 'high' ? C.green : (conf === 'medium' ? C.yellow : C.dim);
        const effText = ui.padEnd(ui.truncate(rec.recommendedEffort || r.effort || '?', 4), 4);
        const cId = ui.padEnd(ui.truncate(r.id, 8), 8);
        const cSt = ui.padEnd(ui.truncate(r.status || '?', 7), 7);
        const cKind = ui.padEnd(ui.truncate(r.kind || '?', 12), 12);
        const cModel = ui.padEnd(ui.truncate(modelStr, 18), 18);
        const cTitle = ui.clean(r.title || '');
        const rowLine = `${mark}${C.text(cId)} ${C.text(cSt)} ${C.text(cKind)} ${effPaint(effText)} ${C.text(cModel)} ${C.text(cTitle)}`;
        const rowY = lines.length;
        lines.push(on ? bold(rowLine) : rowLine);
        addHit({ action: 'orch-task-row', index: i, y: rowY, x0: 0, x1: 33 });
        addHit({ action: 'orch-effort', index: i, y: rowY, x0: 34, x1: 38 });
        addHit({ action: 'orch-model', index: i, y: rowY, x0: 39, x1: 57 });
        addHit({ action: 'orch-task-row', index: i, y: rowY, x0: 58, x1: Math.max(58, width - 1) });
      });
    } else {
      lines.push(C.dim(`    ${ui.padEnd('id', 8)} ${ui.padEnd('st', 7)} ${ui.padEnd('kind', 12)} ${ui.padEnd('eff', 6)} ${ui.padEnd('tier', 8)} ${ui.padEnd('model', 18)} ${ui.padEnd('conf', 7)} title`));
      loaded.rows.forEach((r, i) => {
        const on = i === selIdx;
        const rec = r.recommendation || {};
        const mark = on ? bold(C.cyan('  › ')) : '    ';
        const modelStr = rec.recommendedModel || (rec.requiresModelChoice ? '<choose>' : 'auto');
        const cId = ui.padEnd(ui.truncate(r.id, 8), 8);
        const cSt = ui.padEnd(ui.truncate(r.status || '?', 7), 7);
        const cKind = ui.padEnd(ui.truncate(r.kind || '?', 12), 12);
        const cEff = ui.padEnd(ui.truncate(rec.recommendedEffort || r.effort || '?', 6), 6);
        const cTier = ui.padEnd(ui.truncate(rec.recommendedTier || '?', 8), 8);
        const cModel = ui.padEnd(ui.truncate(modelStr, 18), 18);
        const cConf = ui.padEnd(ui.truncate(rec.confidence || '?', 7), 7);
        const cTitle = ui.clean(r.title || '');
        const rowLine = `${mark}${C.text(cId)} ${C.text(cSt)} ${C.text(cKind)} ${C.text(cEff)} ${C.text(cTier)} ${C.text(cModel)} ${C.text(cConf)} ${C.text(cTitle)}`;
        const rowY = lines.length;
        lines.push(on ? bold(rowLine) : rowLine);
        addHit({ action: 'orch-task-row', index: i, y: rowY, x0: 0, x1: 33 });
        addHit({ action: 'orch-effort', index: i, y: rowY, x0: 34, x1: 40 });
        addHit({ action: 'orch-task-row', index: i, y: rowY, x0: 41, x1: 49 });
        addHit({ action: 'orch-model', index: i, y: rowY, x0: 50, x1: 68 });
        addHit({ action: 'orch-task-row', index: i, y: rowY, x0: 69, x1: Math.max(69, width - 1) });
      });
    }
    const sel = loaded.rows[selIdx];
    if (sel) {
      const fb = sel.recommendation && sel.recommendation.fallbacks && sel.recommendation.fallbacks.length ? sel.recommendation.fallbacks.join(', ') : 'none';
      lines.push(C.dim(`  title: ${ui.clean(sel.title)} · brief: ${ui.clean(sel.brief)} · fallbacks: ${ui.clean(fb)}`));
    }
  } else {
    const selIdx = Math.max(0, Math.min(st.kindRow, config.TASK_KINDS.length - 1));
    lines.push(`  ${bold(C.accent('ADVISOR MATRIX BY TASK KIND'))}  ${C.dim('(no tasks.json yet · ↑↓ kind · ←→ tool · space effort · ↵ model · f fallbacks)')}`);
    lines.push(C.dim(`    ${ui.padEnd('kind', 15)} ${ui.padEnd('tool', 9)} ${ui.padEnd('effort', 7)} ${ui.padEnd('tier', 10)} ${ui.padEnd('recommended model', 24)} ${ui.padEnd('conf', 7)} recorded`));
    config.TASK_KINDS.forEach((kind, i) => {
      const on = i === selIdx;
      const tk = (cfg.taskKinds && cfg.taskKinds[kind]) || {};
      const rec = advisor.recommend('', tk.effort || null, tk.model || null, { kind, config: cfg });
      const toolStr = tk.tool || rec.recommendedTool || cfg.defaultTool || 'auto';
      const modelStr = tk.model || rec.recommendedModel || '<unset>';
      const stat = st.setup && st.setup.modelStats && modelStr ? modelStatLine(st.setup.modelStats[modelStr]).trim() : '';
      const mark = on ? bold(C.cyan('  › ')) : '    ';
      const rowText = [
        ui.padEnd(kind, 15),
        ui.padEnd(ui.truncate(toolStr, 9), 9),
        ui.padEnd(ui.truncate(rec.recommendedEffort || '?', 7), 7),
        ui.padEnd(ui.truncate(rec.recommendedTier || '?', 10), 10),
        ui.padEnd(ui.truncate(modelStr, 24), 24),
        ui.padEnd(ui.truncate(rec.confidence || '?', 7), 7),
        stat || '-',
      ].join(' ');
      lines.push(mark + (on ? bold(C.text(rowText)) : C.text(rowText)));
    });
  }

  if (st.edit) {
    lines.push('');
    lines.push(`  ${C.gold(`editing ${st.edit.field}: `)}${C.text(st.edit.text)}${C.gold('█')}${C.dim('  ↵ save · esc cancel')}`);
  }
  if (st.notice) lines.push('', bold(C.green(`  ✓ ${ui.clean(st.notice)}`)));
  if (st.error) lines.push('', C.red(`  ${ui.clean(st.error)}`));
  return { lines: lines.map((l) => ui.clip(l, width)), hits: localHits };
}

function rebuildSummaryInPlace(st) {
  try {
    let data = summary.summarize();
    if (!data.runs && process.env.ROOSTR_LEDGER && fs.existsSync(process.env.ROOSTR_LEDGER)) {
      const ext = summary.readEntriesFromFile(process.env.ROOSTR_LEDGER);
      data = summary.summarize({ entries: ext });
    }
    summary.writeSummary(data);
    if (st.setup) st.setup.modelStats = summaryModelStats();
    st.notice = `summary rebuilt (${data.runs} runs)`;
    st.error = null;
  } catch (e) {
    st.error = (e && e.message) || String(e);
  }
}

function orchestrateKey(st, key, model = null) {
  if (st.tab === 'setup' && !st.edit) {
    if (key === '\t') {
      st.tab = ORCHESTRATE_TABS[(ORCHESTRATE_TABS.indexOf(st.tab) + 1) % ORCHESTRATE_TABS.length];
      return null;
    }
    if (key === '1' && !st.setup.edit) { st.tab = 'tasks'; return null; }
    if (key === '2' && !st.setup.edit) { st.tab = 'analytics'; return null; }
    const r = setupKey(st.setup, key);
    if (r && r.cancel) return { cancel: true };
    if (r && r.save) return { saveSetup: true };
    return null;
  }

  if (st.edit) {
    const e = editChunk(key);
    if (e.action === 'save') {
      const v = String(st.edit.text).trim();
      try {
        if (st.edit.target === 'task-file') {
          if (st.edit.field === 'model') saveTaskOverride(st.edit.tasksFile, st.edit.taskId, { model: v });
          else if (st.edit.field === 'fallbacks') {
            const list = v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 5);
            saveTaskOverride(st.edit.tasksFile, st.edit.taskId, { fallbacks: list });
          }
          st.notice = `saved ${st.edit.taskId} to tasks.json`;
        } else if (st.edit.target === 'kind-config') {
          const kind = st.edit.kind;
          const c = st.setup.config;
          if (!c.taskKinds[kind]) c.taskKinds[kind] = { tool: '', model: '', fallbacks: [], effort: '' };
          if (st.edit.field === 'model') c.taskKinds[kind].model = v;
          else if (st.edit.field === 'fallbacks') {
            c.taskKinds[kind].fallbacks = v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 5);
          }
          config.saveConfig(c);
          st.notice = `saved task kind ${kind}`;
        }
        st.error = null;
      } catch (err) {
        st.error = (err && err.message) || String(err);
      }
      st.edit = null;
    } else if (e.action === 'cancel') {
      st.edit = null;
    } else if (e.action === 'backspace') {
      st.edit.text = Array.from(st.edit.text).slice(0, -1).join('');
    } else if (e.action !== 'ignore') {
      st.edit.text += e.text;
    }
    return null;
  }

  if (key === '\x1b' || key === '\x03' || key === 'q') return { cancel: true };
  if (key === '\t') {
    st.tab = ORCHESTRATE_TABS[(ORCHESTRATE_TABS.indexOf(st.tab) + 1) % ORCHESTRATE_TABS.length];
    st.notice = null;
    st.error = null;
    return null;
  }
  if (key === '1') { st.tab = 'tasks'; return null; }
  if (key === '2') { st.tab = 'analytics'; return null; }
  if (key === '3') { st.tab = 'daemon'; return null; }
  if (key === '4' || key === 'S') { st.tab = 'setup'; return null; }
  if (key === 's') {
    rebuildSummaryInPlace(st);
    return null;
  }

  if (st.tab === 'daemon') return null;

  if (st.tab === 'analytics') {
    if (key === 'b' || key === '\x1b[C' || key === 'l') {
      st.by = cycleValue(analytics.VIEWS, st.by);
    } else if (key === '\x1b[D' || key === 'h') {
      st.by = analytics.VIEWS[(analytics.VIEWS.indexOf(st.by) - 1 + analytics.VIEWS.length) % analytics.VIEWS.length];
    } else if (key === 'd') {
      st.windowIndex = (st.windowIndex + 1) % ORCH_WINDOWS.length;
    }
    return null;
  }

  // Tab 1: tasks & launcher
  const cfg = st.setup ? st.setup.config : config.defaultConfig();
  const planDir = (st.planDirs && st.planDirs[st.planIndex]) || process.cwd();
  const loaded = loadPlanTasks(planDir, cfg);

  if (key === 'o') {
    const wsRows = workspaceRows(model);
    if (wsRows.length) {
      const idx = wsRows.findIndex((r) => r.paneId === st.headPaneId);
      const next = wsRows[(idx + 1) % wsRows.length];
      st.headPaneId = next.paneId;
      st.notice = `selected orchestrator pane ${next.name} (${next.paneId})`;
    }
    return null;
  }
  if (key === 'p') {
    if (st.planDirs && st.planDirs.length > 0) {
      st.planIndex = (st.planIndex + 1) % st.planDirs.length;
      st.taskRow = 0;
      const nextDir = st.planDirs[st.planIndex];
      st.notice = `bound active plan repo: ${shortDir(nextDir)}`;
      return { bindPlanDir: nextDir };
    }
    return null;
  }
  if (key === 'g') {
    return { assignOrchestrator: st.headPaneId, planDir };
  }
  if (key === 'N') {
    return { spawnHeadInShell: true };
  }

  const tools = ['', ...cfg.tools, ...cfg.customTools];
  if (loaded.hasTasksFile && loaded.rows.length > 0) {
    const n = loaded.rows.length;
    st.taskRow = Math.max(0, Math.min(st.taskRow, n - 1));
    const cur = loaded.rows[st.taskRow];
    if (key === '\x1b[A' || key === 'k') st.taskRow = (st.taskRow - 1 + n) % n;
    else if (key === '\x1b[B' || key === 'j') st.taskRow = (st.taskRow + 1) % n;
    else if (key === '\x1b[C' || key === 'l' || key === '\x1b[D' || key === 'h') {
      const dir = (key === '\x1b[D' || key === 'h') ? -1 : 1;
      const curTool = cur.tool || '';
      const nextTool = tools[(tools.indexOf(curTool) + dir + tools.length) % tools.length];
      try {
        saveTaskOverride(loaded.tasksFile, cur.id, { tool: nextTool });
        st.notice = `${cur.id} tool -> ${nextTool || 'auto'}`;
      } catch (e) {
        st.error = e.message;
      }
    } else if (key === ' ') {
      const curEff = cur.effort || '';
      const nextEff = cycleValue(KIND_EFFORTS, curEff);
      try {
        saveTaskOverride(loaded.tasksFile, cur.id, { effort: nextEff });
        st.notice = `${cur.id} effort -> ${nextEff || 'auto'}`;
      } catch (e) {
        st.error = e.message;
      }
    } else if (key === '\r' || key === '\n') {
      st.edit = { target: 'task-file', tasksFile: loaded.tasksFile, taskId: cur.id, field: 'model', text: cur.model || '' };
    } else if (key === 'c') {
      const eff = cur.effort || (cur.recommendation && cur.recommendation.recommendedEffort) || 'medium';
      const mod = cur.model || (cur.recommendation && cur.recommendation.recommendedModel) || '';
      const modelArg = mod && mod !== '<choose>' ? ` --model ${mod}` : '';
      const cmd = `roostr spawn --task "${cur.title}" --kind ${cur.kind} --effort ${eff}${modelArg}`.trim();
      copyToClipboard(cmd);
      st.notice = `copied spawn command for ${cur.id}`;
      st.error = null;
    } else if (key === 'f') {
      st.edit = { target: 'task-file', tasksFile: loaded.tasksFile, taskId: cur.id, field: 'fallbacks', text: (cur.fallbacks || []).join(', ') };
    }
  } else {
    const n = config.TASK_KINDS.length;
    st.kindRow = Math.max(0, Math.min(st.kindRow, n - 1));
    const kind = config.TASK_KINDS[st.kindRow];
    if (!cfg.taskKinds[kind]) cfg.taskKinds[kind] = { tool: '', model: '', fallbacks: [], effort: '' };
    const tk = cfg.taskKinds[kind];
    if (key === '\x1b[A') st.kindRow = (st.kindRow - 1 + n) % n;
    else if (key === '\x1b[B' || key === 'j') st.kindRow = (st.kindRow + 1) % n;
    else if (key === '\x1b[C' || key === 'l' || key === '\x1b[D' || key === 'h') {
      const dir = (key === '\x1b[D' || key === 'h') ? -1 : 1;
      tk.tool = tools[(tools.indexOf(tk.tool || '') + dir + tools.length) % tools.length];
      try { config.saveConfig(cfg); st.notice = `${kind} tool -> ${tk.tool || 'auto'}`; } catch (e) { st.error = e.message; }
    } else if (key === ' ') {
      tk.effort = cycleValue(KIND_EFFORTS, tk.effort || '');
      try { config.saveConfig(cfg); st.notice = `${kind} effort -> ${tk.effort || 'auto'}`; } catch (e) { st.error = e.message; }
    } else if (key === '\r' || key === '\n') {
      st.edit = { target: 'kind-config', kind, field: 'model', text: tk.model || '' };
    } else if (key === 'c') {
      const rec = advisor.recommend('', tk.effort || null, tk.model || null, { kind, config: cfg });
      const tkEff = tk.effort || (rec && rec.recommendedEffort) || 'medium';
      const tkMod = tk.model || (rec && rec.recommendedModel) || '';
      const modelArg = tkMod && tkMod !== '<choose>' ? ` --model ${tkMod}` : '';
      const cmd = `roostr spawn --task "${kind} task" --kind ${kind} --effort ${tkEff}${modelArg}`.trim();
      copyToClipboard(cmd);
      st.notice = `copied spawn command for ${kind}`;
      st.error = null;
    } else if (key === 'f') {
      st.edit = { target: 'kind-config', kind, field: 'fallbacks', text: (tk.fallbacks || []).join(', ') };
    }
  }
  return null;
}

// options: width, height, error, load, view, `provider` (whose usage bars
// show; the first one when unset), `subview` (specific source or 'all'),
// and for the live board `menu`
// ({ tags, view, scope, provider, subview }), `help` (show the keys instead of the
// rows), `selected` (row index), `detail` (show the selected row's detail
// box), `edit` ({ text }),
// `folded` (a Set of workspace names shown as one line) and `hits` (an array
// the click regions are pushed into).
function render(model, {
  width = 100, height = 0, error = null, load = os.loadavg(), view = 'auto', menu = null, selected = -1, edit = null, hits = null,
  folded = new Set(), provider = null, subview = null, help = false, detail = false, today = false, metric = 'tokens',
  backups = null, logView = null, setup = null, headPicker = null, options = false, orchestrate = null,
} = {}) {
  const lines = [];
  const regions = [];
  const wsList = [...new Set(model.rows.map((r) => r.workspace))];
  const wsPaint = (name) => ui.WS[Math.max(0, wsList.indexOf(name)) % ui.WS.length];
  // Line 0 is a four-zone live status bar: the crew, the crew pulse, today's
  // spend and burn pace, then the clock and load. The Herdr pane header already
  // carries the board name, so the line does not repeat it.
  const statusOf = (s) => model.rows.filter((r) => r.status === s).length;
  const working = statusOf('working');
  const idle = statusOf('idle');
  const blocked = statusOf('blocked');
  const done = statusOf('done');
  const z1 = bold((wsList.length === 1 ? wsPaint(wsList[0]) : C.accent)(ui.clean(crewTitle(model))));
  let z2 = `${C.green(`● ${working} working`)} · ${C.amber(`○ ${idle} idle`)}`;
  if (blocked > 0) z2 += ` · ${bold(C.red(`◼ ${blocked} blocked`))}`;
  if (done > 0) z2 += ` · ${C.cyan(`✓ ${done} done`)}`;
  const ts0 = model.tokscale;
  let z3 = ts0 ? C.text(`today ${fmtCost(ts0.total)}`) : '';
  let maxPace = 0;
  for (const l of (model.limits || [])) {
    for (const w of (l.windows || [])) if (typeof w.pace === 'number' && w.pace > maxPace) maxPace = w.pace;
  }
  const paceLabel = maxPace >= 10 ? String(Math.round(maxPace)) : maxPace.toFixed(1);
  if (maxPace >= 0.05) {
    const paintPace = maxPace >= 2 ? C.red : maxPace >= 1 ? C.amber : C.green;
    z3 += (z3 ? ' ' : '') + bold(paintPace(`⚡ ${paceLabel}×`));
  }
  const loads = load.map((n) => n.toFixed(2));
  const z4 = width < 105 ? `${clock(model.now)} · load ${loads[0]}` : `${clock(model.now)}  load ${loads.join(' ')}`;
  const offered = menu && menu.update ? menu.update : null;
  const versionText = offered ? `${VERSION_LABEL} ⬆` : VERSION_LABEL;
  const versionPaint = offered ? bold(C.amber(versionText)) : C.dim(versionText);
  const zRight = (z3 ? z3 + '   ' : '') + z4 + '   ' + versionPaint;
  const zLeft = `${z1}   ${z2}`;
  const gap = Math.max(1, width - ui.strWidth(zLeft) - ui.strWidth(zRight));
  lines.push(zLeft + ' '.repeat(gap) + zRight);
  // Click regions on line 0: crew pulse, today spend, burn pace, and load.
  const z2x = ui.strWidth(z1) + 3;
  regions.push({ action: 'tooltip', y: 0, x0: z2x, x1: z2x + ui.strWidth(z2) - 1, text: `crew pulse: ${working} working, ${idle} idle${blocked ? `, ${blocked} blocked` : ''}${done ? `, ${done} done` : ''}` });
  const z3x = ui.strWidth(zLeft) + gap;
  if (ts0) {
    regions.push({ action: 'today', y: 0, x0: z3x, x1: z3x + ui.strWidth(`today ${fmtCost(ts0.total)}`) - 1 });
  }
  if (maxPace >= 0.05) {
    const bolt = `⚡ ${paceLabel}×`;
    const boltX = z3x + ui.strWidth(z3) - ui.strWidth(bolt);
    regions.push({ action: 'tooltip', y: 0, x0: boltX, x1: boltX + ui.strWidth(bolt) - 1, text: `⚡ burn pace: ${paceLabel}× sustainable rate (${maxPace >= 2 ? 'critically high burn' : maxPace >= 1 ? 'faster than sustainable pace' : 'healthy pace'})` });
  }
  const z4x = z3x + (z3 ? ui.strWidth(z3) + 3 : 0);
  const loadAt = z4x + z4.indexOf('load ');
  const cores = os.cpus ? os.cpus().length : 0;
  regions.push({ action: 'tooltip', y: 0, x0: loadAt, x1: Math.min(width - 1, z4x + ui.strWidth(z4) - 1), text: `load 1m/5m/15m: ${loads.join(', ')} across ${cores} CPU core${cores === 1 ? '' : 's'}` });
  const verX = z4x + ui.strWidth(z4) + 3;
  regions.push({
    action: 'tooltip', y: 0, x0: verX, x1: Math.min(width - 1, verX + ui.strWidth(versionText) - 1),
    text: `roostr ${VERSION_LABEL} on this device${offered ? ` · v${offered} available, press u` : ' · run scripts/update.sh to match another device'}`,
  });
  if (menu) {
    const activeDrawer = orchestrate ? 'orchestrate' : (today ? 'today' : (logView ? 'log' : (backups ? 'backups' : (options ? 'options' : (help ? 'help' : null)))));
    const bar = menuBar(menu, width, activeDrawer);
    for (const h of bar.hits) regions.push({ ...h, y: lines.length });
    lines.push(bar.line);
  }

  if (model.crewChecks.length) {
    const pills = model.crewChecks.map((c) => {
      const name = ui.clean(c.name);
      if (c.state === true) return C.green(`● ${name}`);
      if (c.state === false) return C.dim(`○ ${name}`);
      return C.dim(`? ${name}`);
    });
    // Clicking a check pill flashes whether it is passing, failing, or not run.
    let cx = 0;
    model.crewChecks.forEach((c, i) => {
      const w = ui.strWidth(pills[i]);
      const state = c.state === true ? 'passing' : (c.state === false ? 'failing' : 'not yet evaluated');
      regions.push({ action: 'tooltip', y: lines.length, x0: cx, x1: cx + w - 1, text: `check ${ui.clean(c.name)}: ${state}` });
      cx += w + 2;
    });
    lines.push(pills.join('  '));
  }
  for (const crew of model.crews) {
    for (const e of crew.errors) lines.push(C.red(ui.clean(`crew file ${crew.file}: ${e}`)));
  }
  for (const crew of model.untrusted || []) {
    const how = menu ? 'press a (or click) to allow' : 'open roostr and press a to allow';
    regions.push({ action: 'trust', y: lines.length, x0: 0, x1: width - 1 });
    lines.push(C.amber(ui.clean(`crew file new or changed, off until you allow it: ${how} · ${crew.file}`)));
  }
  const alerts = banner(model);
  if (alerts.length) {
    const line = alerts.map((a) => (a.kind === 'blocked' ? bold(C.red(a.text)) : a.kind === 'compact' ? bold(C.amber(a.text)) : C.amber(a.text))).join(C.dim(' │ '));
    lines.push(ui.clip(line, width));
  }
  if (error) lines.push(C.red(ui.clean(`herdr: ${error}`)));
  for (const w of model.configWarnings || []) lines.push(C.amber(ui.clean(`config: ${w}`)));
  lines.push(C.dim('─'.repeat(width)));

  if (orchestrate) {
    const orch = orchestrateLines(orchestrate, model, width);
    for (const h of orch.hits) regions.push({ ...h, y: lines.length + h.y });
    lines.push(...orch.lines);
  } else if (setup) {
    lines.push(...setupLines(setup, width));
  } else if (help && menu) {
    lines.push(...helpLines(menu, providers(model.limits), width));
  } else if (headPicker) {
    lines.push(...headLines(headPicker, width));
  } else if (today) {
    const td = todayLines(model, width, metric);
    for (const h of td.hits) regions.push({ ...h, y: lines.length + h.y });
    lines.push(...td.lines);
  } else if (logView) {
    lines.push(...logViewLines(logView, width, model.now));
  } else if (backups) {
    lines.push(...backupLines(backups, width, model.now));
  } else if (options) {
    lines.push(...optionsLines(model, menu, width, metric));
  } else if (view === 'cards') {
    const multiWs = new Set(model.rows.map((r) => r.workspace)).size > 1;
    let lastWs = null;
    model.rows.forEach((r, i) => {
      if (multiWs && r.workspace !== lastWs) {
        regions.push({ action: 'fold', workspace: r.workspace, y: lines.length, x0: 0, x1: width - 1 });
        lines.push(wsHeader(r.workspace, model.rows.filter((x) => x.workspace === r.workspace), folded.has(r.workspace), wsPaint(r.workspace)));
        lastWs = r.workspace;
      }
      if (multiWs && folded.has(r.workspace)) return;

      const isSel = i === selected;
      const bg = isSel ? BG.selected : (r.status === 'blocked' ? BG.alarm : null);
      const c = rowCells(r, false);
      const tagStr = r.tag ? `${r.tag} ` : '';
      const nameText = c.name.paint(r.name);
      const effStr = r.effort ? ` (${r.effort})` : '';
      const modelStr = r.model.v ? `${shortModel(r.model.v)}${effStr}` : '?';
      const surgeBadge = (r.surge || r.surgeMarker) ? ` ${bold(C.amber('▲ 2× SURGE'))}` : '';
      const headLeft = `${tagStr}${nameText} ${C.dim(`(${r.kind})`)} · ${C.cyan(r.paneId)} · ${C.text(modelStr)}${surgeBadge}`;
      const headRight = c.state.paint(c.state.text);
      const gap1 = Math.max(2, width - 4 - ui.strWidth(headLeft) - ui.strWidth(headRight));
      const line1 = `  ${headLeft}${' '.repeat(gap1)}${headRight}`;

      let ctxMeter = '';
      if (r.ctx && typeof r.ctx.v === 'number') {
        const fill = Math.max(0, Math.min(10, Math.round(r.ctx.v / 10)));
        const paintCtx = r.ctx.v >= 85 ? C.red : (r.ctx.v >= 50 ? C.amber : C.green);
        ctxMeter = `ctx ${paintCtx('█'.repeat(fill))}${C.dim('░'.repeat(10 - fill))} ${paintCtx(`${Math.round(r.ctx.v)}%`)} · `;
      }
      const line2 = `    ${ctxMeter}${c.tokens.paint(c.tokens.text)} tokens · ${c.cost.paint(c.cost.text)} · ram ${c.ram.paint(c.ram.text)}`;

      const taskContent = r.task ? C.text(ui.clean(r.task)) : C.dim('no task assigned');
      const line3 = `    ${C.dim('task:')} ${taskContent}`;

      // Narrow regions first: they must win over the full-width row regions.
      if (surgeBadge) {
        const surgeX = 2 + ui.strWidth(headLeft) - ui.strWidth(surgeBadge);
        regions.push({ action: 'tooltip', index: i, y: lines.length, x0: surgeX, x1: surgeX + ui.strWidth(surgeBadge) - 1, text: SURGE_TOOLTIP });
      }
      regions.push({ action: 'copy-id', paneId: r.paneId, index: i, y: lines.length, x0: 0, x1: width - 1 });
      regions.push({ action: 'jump', paneId: r.paneId, index: i, y: lines.length, x0: 0, x1: width - 1 });
      regions.push({ action: 'row', index: i, y: lines.length, x0: 0, x1: width - 1 });
      lines.push(bgLine(ui.clip(line1, width), bg, width));

      if (ctxMeter) {
        regions.push({ action: 'tooltip', index: i, y: lines.length, x0: 4, x1: 4 + ui.strWidth(ctxMeter) - 1, text: ctxTooltip(r) });
      }
      regions.push({ action: 'detail', paneId: r.paneId, index: i, y: lines.length, x0: 0, x1: width - 1 });
      regions.push({ action: 'row', index: i, y: lines.length, x0: 0, x1: width - 1 });
      lines.push(bgLine(ui.clip(line2, width), bg, width));

      regions.push({ action: 'edit', paneId: r.paneId, index: i, y: lines.length, x0: 0, x1: width - 1 });
      regions.push({ action: 'row', index: i, y: lines.length, x0: 0, x1: width - 1 });
      lines.push(bgLine(ui.clip(line3, width), bg, width));

      lines.push('');
    });
    if (model.rows.length === 0) lines.push(C.dim('  no agent panes'));
  } else {
    const { cols, cells, taskW } = fitColumns(model.rows, width, view);
    const indent = 3;
    const head = cols.map((c) => (c.right ? ui.padStart(c.head, c.w) : ui.padEnd(c.head, c.w))).join(' ');
    lines.push(C.dim(view === 'wrap' || ui.strWidth(head) + 10 > width ? head : `${head} task line`));

    const multiWs = new Set(model.rows.map((r) => r.workspace)).size > 1;
    let lastWs = null;
    model.rows.forEach((r, i) => {
      if (multiWs && r.workspace !== lastWs) {
        regions.push({ action: 'fold', workspace: r.workspace, y: lines.length, x0: 0, x1: width - 1 });
        lines.push(wsHeader(r.workspace, model.rows.filter((x) => x.workspace === r.workspace), folded.has(r.workspace), wsPaint(r.workspace)));
        lastWs = r.workspace;
      }
      if (multiWs && folded.has(r.workspace)) return;
      const line = cols.map((c) => ui.cell(cells[i][c.key].text, c.w, cells[i][c.key].paint, c.right)).join(' ');
      const below = view === 'wrap' || (view === 'auto' && taskWidth(r) > taskW);
      const bg = i === selected ? BG.selected : r.status === 'blocked' ? BG.alarm : null;
      let colX = 0;
      for (const c of cols) {
        if (c.key === 'id' && colX < width) {
          regions.push({ action: 'copy-id', paneId: r.paneId, index: i, y: lines.length, x0: Math.max(0, colX - 1), x1: Math.min(width - 1, colX + c.w) });
        } else if (['tag', 'name'].includes(c.key) && colX < width) {
          regions.push({ action: 'jump', paneId: r.paneId, index: i, y: lines.length, x0: Math.max(0, colX - 1), x1: Math.min(width - 1, colX + c.w) });
        } else if (c.key === 'state' && colX < width) {
          const canRecover = r.status === 'blocked' && orchestrationEnabled(model.config, { menu });
          regions.push({ action: canRecover ? 'recover' : 'detail', paneId: r.paneId, index: i, y: lines.length, x0: Math.max(0, colX - 1), x1: Math.min(width - 1, colX + c.w) });
        } else if (c.key === 'agent' && (r.surge || r.surgeMarker) && colX < width) {
          regions.push({ action: 'tooltip', index: i, y: lines.length, x0: Math.max(0, colX - 1), x1: Math.min(width - 1, colX + c.w), text: SURGE_TOOLTIP });
        } else if (c.key === 'ctx' && r.ctx && typeof r.ctx.v === 'number' && colX < width) {
          regions.push({ action: 'tooltip', index: i, y: lines.length, x0: Math.max(0, colX - 1), x1: Math.min(width - 1, colX + c.w), text: ctxTooltip(r) });
        }
        colX += c.w + 1;
      }
      if (!below && colX < width) {
        regions.push({ action: 'edit', paneId: r.paneId, index: i, y: lines.length, x0: colX, x1: width - 1 });
      }
      regions.push({ action: 'row', index: i, y: lines.length, x0: 0, x1: width - 1 });
      if (below) {
        lines.push(bgLine(ui.clip(line, width), bg, width));
        regions.push({ action: 'edit', paneId: r.paneId, index: i, y: lines.length, x0: 0, x1: width - 1 });
        lines.push(bgLine(ui.clip(' '.repeat(indent) + taskCell(r, width - indent), width), bg, width));
      } else {
        lines.push(bgLine(ui.clip(`${line} ${taskCell(r, taskW)}`, width), bg, width));
      }
    });
    if (model.rows.length === 0) lines.push(C.dim('  no agent panes'));
  }

  const count = (s) => model.rows.filter((r) => r.status === s).length;
  const ts = model.tokscale;
  const spend = ts ? (BUDGET_PAINT[budgetState(ts.total, model.dailyBudget)] || C.text)(`today ${fmtCost(ts.total)}`) + C.dim(' · via tokscale') : '';
  let foot = [
    C.dim(`${model.rows.length} panes`),
    C.green(`● ${count('working')} working`),
    C.amber(`○ ${count('idle')} idle`),
    C.red(`◼ ${count('blocked')} blocked`),
    C.cyan(`✓ ${count('done')} done`),
    spend,
    C.dim('? unknown  ≥ since board saw it  tinted = read from screen'),
  ].filter(Boolean).join('  ');
  if (ui.strWidth(foot) > width) {
    foot = [
      C.dim(`${model.rows.length} panes`),
      C.green(`● ${count('working')}`),
      C.amber(`○ ${count('idle')}`),
      C.red(`◼ ${count('blocked')}`),
      C.cyan(`✓ ${count('done')}`),
      spend,
      C.dim('? unknown  ≥ lower bound'),
    ].filter(Boolean).join('  ');
  }
  if (orchestrate) foot = C.dim('tab/1-4 switch · o orchestrator · p plan repo · ↑↓ row · ←→ tool · space effort · ↵ model · f fallbacks · s summary · esc close');
  else if (setup) foot = C.dim('↑↓ row · space effort/toggle · ←→ tool · enter model · f fallbacks · esc cancel');
  else if (headPicker) foot = C.dim('↑↓ pick · enter confirm · y start · esc close');
  if (edit) {
    const r = model.rows[selected];
    const prompt = `task for ${r ? r.name : '?'}: `;
    const keys = '  ↵ save · esc cancel';
    const room = Math.max(4, width - prompt.length - keys.length - 1);
    const text = ui.strWidth(edit.text) > room ? `…${edit.text.slice(-(room - 1))}` : edit.text;
    foot = bold(C.gold(prompt)) + C.text(text) + C.gold('█') + C.dim(keys);
  }

  const all = providers(model.limits);
  const shown = provider === 'off' ? 'off' : (all.includes(provider) ? provider : all[0]);
  const choices = [...all, 'off'];
  const provLimits = shown === 'off' ? [] : (model.limits || []).filter((l) => providerOf(l.source) === shown);
  const sources = [...new Set(provLimits.map((l) => l.source))];
  const activeSub = (subview && sources.includes(subview)) ? subview : 'all';
  const visibleLimits = activeSub === 'all' ? provLimits : provLimits.filter((l) => l.source === activeSub);
  const subChoices = ['all', ...sources];
  const nextSub = subChoices[(subChoices.indexOf(activeSub) + 1) % subChoices.length];
  const nextSubLabel = nextSub === 'all' ? 'all' : (nextSub.startsWith(shown + ' ') ? nextSub.slice(shown.length + 1) : nextSub);
  const usageHits = hits ? [] : null;
  const usage = shown === 'off'
    ? []
    : visibleLimits.map((l, i) => {
        const nextProv = all.length > 1 && i === 0 ? `   p ▸ ${choices[(choices.indexOf(shown) + 1) % choices.length]}` : '';
        const nextSubHint = sources.length > 1 && i === 0 ? `   P ▸ ${nextSubLabel}` : '';
        const line = limitsLine(l, model.now, usageHits, i);
        let curX = ui.strWidth(line);
        if (usageHits && nextProv) {
          usageHits.push({ action: 'provider', x0: curX + 3, x1: curX + ui.strWidth(nextProv) - 1, index: i });
          curX += ui.strWidth(nextProv);
        }
        if (usageHits && nextSubHint) {
          usageHits.push({ action: 'subview', x0: curX + 3, x1: curX + ui.strWidth(nextSubHint) - 1, index: i });
        }
        const nextProvPaint = nextProv ? C.dim(nextProv) : '';
        const nextSubPaint = nextSubHint ? C.dim(nextSubHint) : '';
        return ui.clip(line + nextProvPaint + nextSubPaint, width);
      });
  const box = detail && !help && !today && !backups && !logView && !options && !orchestrate && model.rows[selected] ? detailBox(model.rows[selected], width, model.tokscale, menu && menu.notice) : null;
  const body = lines.map((l) => ui.clip(l, width));
  const footer = ui.clip(foot, width);

  if (height <= 0) {
    const out = [...body];
    if (hits) {
      for (const h of regions) if (h.x0 >= 0 && h.x0 < width && h.x1 < width) hits.push(h);
    }
    if (box) {
      if (hits) {
        for (const h of box.hits) {
          if (h.x0 >= 0 && h.x0 < width && h.x1 < width) hits.push({ ...h, y: body.length + h.y });
        }
      }
      out.push(...box.lines);
    }
    if (usageHits) {
      const usageBaseY = out.length;
      for (const h of usageHits) {
        if (h.x0 >= 0 && h.x0 < width && h.x1 < width) hits.push({ ...h, y: usageBaseY + h.index });
      }
    }
    out.push(...usage);
    out.push(footer);
    if (hits && menu) {
      if (spend) {
        const spendPlain = ui.clean(spend);
        const spendMatch = ui.clean(foot).indexOf(spendPlain);
        if (spendMatch >= 0) {
          hits.push({ action: 'today', y: out.length - 1, x0: spendMatch, x1: spendMatch + ui.strWidth(spendPlain) - 1 });
        }
      }
      hits.push({ action: 'help', y: out.length - 1, x0: 0, x1: width - 1 });
    }
    return out.join('\n');
  }

  if (height === 1) return footer;

  // The frame is title, body, box or separator, usage, footer. Lines give way
  // in this order: extra box lines, the box, usage, then body from the bottom.
  const title = body[0] || '';
  const rest = body.slice(1).map((line, i) => ({ line, index: i + 1 }));
  const room = Math.max(0, height - 2);
  let sep = box ? 0 : 1;
  if (room === 0) sep = 0;
  let boxPresent = Boolean(box);
  let boxKept = box ? box.lines.map(() => true) : [];
  const use = usage.slice();
  const total = () => rest.length + (boxPresent ? boxKept.filter(Boolean).length : sep) + use.length;

  if (boxPresent) {
    for (const at of box.dropOrder) {
      if (total() <= room) break;
      boxKept[at] = false;
    }
    if (total() > room) {
      boxPresent = false;
      boxKept = [];
      sep = room > 0 ? 1 : 0;
    }
  }
  while (use.length && total() > room) use.pop();

  let dropped = 0;
  if (total() > room) {
    // Reserve room for the summary and for the separator below the body.
    const keep = Math.max(0, room - (boxPresent ? 0 : sep) - 1);
    while (rest.length > keep) {
      rest.pop();
      dropped++;
    }
  }
  if (dropped > 0) {
    const summary = () => ui.clip(C.dim(`  … ${dropped} more lines`), width);
    if (total() + 1 <= room) rest.push({ line: summary(), index: null });
    else if (rest.length) {
      rest.pop();
      dropped++;
      rest.push({ line: summary(), index: null });
    }
  }

  const middle = rest.length + (boxPresent ? boxKept.filter(Boolean).length : sep) + use.length;
  const pad = Math.max(0, room - middle);
  const out = [title];
  const origin = [{ kind: 'body', index: 0 }];
  for (const r of rest) {
    out.push(r.line);
    origin.push(r.index === null ? null : { kind: 'body', index: r.index });
  }
  for (let i = 0; i < pad; i++) {
    out.push('');
    origin.push(null);
  }
  if (boxPresent) {
    box.lines.forEach((line, i) => {
      if (!boxKept[i]) return;
      out.push(line);
      origin.push({ kind: 'box', index: i });
    });
  } else if (sep) {
    out.push(C.dim('─'.repeat(width)));
    origin.push(null);
  }
  for (let i = 0; i < use.length; i++) {
    out.push(use[i]);
    origin.push({ kind: 'usage', index: i });
  }
  out.push(footer);
  origin.push(null);

  if (hits) {
    const at = (kind, index) => origin.findIndex((o) => o && o.kind === kind && o.index === index);
    for (const h of regions) {
      if (!(h.x0 >= 0 && h.x0 < width && h.x1 < width)) continue;
      const y = at('body', h.y);
      if (y >= 0) hits.push({ ...h, y });
    }
    if (boxPresent) {
      for (const h of box.hits) {
        if (!(h.x0 >= 0 && h.x0 < width && h.x1 < width)) continue;
        const y = at('box', h.y);
        if (y >= 0) hits.push({ ...h, y });
      }
    }
    if (usageHits) {
      for (const h of usageHits) {
        if (!(h.x0 >= 0 && h.x0 < width && h.x1 < width)) continue;
        const y = at('usage', h.index);
        if (y >= 0) hits.push({ ...h, y });
      }
    }
    // The footer explains ? and ≥; clicking it opens the help.
    if (menu) {
      if (spend) {
        const spendPlain = ui.clean(spend);
        const spendMatch = ui.clean(foot).indexOf(spendPlain);
        if (spendMatch >= 0) {
          hits.push({ action: 'today', y: out.length - 1, x0: spendMatch, x1: spendMatch + ui.strWidth(spendPlain) - 1 });
        }
      }
      hits.push({ action: 'help', y: out.length - 1, x0: 0, x1: width - 1 });
    }
  }
  return out.join('\n');
}

function toJsonRows(model) {
  return model.rows.map((r) => {
    const { crew, ...rest } = r;
    return { ...rest, crewFile: crew ? crew.file : null };
  });
}

function toJson(model) {
  const summary = { total: model.rows.length, working: 0, idle: 0, blocked: 0, done: 0, unknown: 0 };
  let totalCost = null;
  for (const r of model.rows) {
    if (['working', 'idle', 'blocked', 'done'].includes(r.status)) summary[r.status]++;
    else summary.unknown++;
    if (r.cost && Number.isFinite(r.cost.v)) {
      totalCost = (totalCost === null ? 0 : totalCost) + r.cost.v;
    }
  }
  summary.totalCost = totalCost;
  const scope = model.scopeLabel || 'all';
  return {
    schema: 1,
    version: VERSION,
    commit: COMMIT || null,
    generatedAt: new Date(Number.isFinite(model.now) ? model.now : Date.now()).toISOString(),
    scope,
    workspace: scope === 'all' ? null : scope,
    summary,
    panes: toJsonRows(model),
  };
}

// ------------------------------------------------------------------ runtime

const HELP = `roostr: a live board of the agent panes in this Herdr workspace (--all: every workspace)

usage: roostr [board] [options]
${REPORT_USAGE.replace(/^usage: /, '       ')}
       roostr recommend --task <text> [--json]
       roostr spawn [--pane <id>] [--task <text>] [--kind <tool>]
       roostr outcome --run <id> --result pass|fail
       roostr summary [--json]
       roostr tasks [--check]
       roostr template <role>
       roostr name [--language <lang>] [--count N]
       roostr backups [show|restore <label|id>] [--version N] [--layout even|saved|columns|rows] [--yes]
       roostr analytics [--days N | --today] [--by pane|model|kind|batch] [--json]
       roostr arena [--share] | arena export [--days N] | arena import --from <file>
       roostr init [--dir <path>] [--json]
       roostr sessions [--json]
       roostr log [--all] [--dir <path>] [--kind opencode|kilo|all] [--json] | log --resume <id> [--workspace <id|label>]
       roostr restore [--workspace <id|label|here|all>] [--yes] [--dry-run]
       roostr respawn [--workspace <id|label|here>] [--yes] [--force] [--keep-old] [--layout even|saved|columns|rows]

options:
  --workspace <id|label>  only show agent panes in this workspace
  --crew <file>           use this crew file for every pane (default: find
                          .roostr.toml or .crew-board.toml above each pane's cwd)
  --tags tokens|label|metadata|off
                          how panes get their colour tag (default:
                          $ROOSTR_TAGS, else $CREW_BOARD_TAGS, else crew file [board] tags,
                          else label)
  --tags-scope here|all   which panes a label or metadata tag may change
                          (default: crew file [board] tag_scope, else here)
  --budget <dollars>      warn when a pane's cost nears this (a crew file
                          pane budget wins)
  --view auto|line|wrap|cards
                          task line beside its row when it fits, else under
                          it (auto, the default); always beside (line); or
                          always under (wrap)
  --all                   show every workspace (default)
  --here                  only show the workspace the board runs in
  --provider <name|off>   whose usage bars show, or off to hide them
  --subview <name|all>    sub-view inside the active provider, or all
  --interval <seconds>    refresh period, at least 2 (default 3)
  --once                  print one frame and exit (no colour tags written)
  --backups               open on the backups view (the restore action uses this)
  --options               open on the options view (settings, tokscale, compaction)
  --orchestration         enable orchestration tools (or ROOSTR_ORCHESTRATION=1)
  --json                  print the JSON envelope (version, scope, summary, panes) and exit
  --json-rows             print only the pane rows array and exit (later flag wins)
  --no-update-check       never ask GitHub for a newer release (or ROOSTR_NO_UPDATE_CHECK=1)
  -v, --version           print the roostr version and exit
  -h, --help              this help
`;

function parseArgs(argv) {
  const o = {
    workspace: null, scope: 'all', crew: null, budget: null, tags: process.env.CREW_BOARD_TAGS || null, tagScope: null, view: 'auto',
    provider: null, subview: null, interval: 3, once: false, json: false, jsonRows: false, set: new Set(process.env.CREW_BOARD_TAGS ? ['tags'] : []),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a !== '--crew' && a.startsWith('--')) o.set.add(a.slice(2));
    if (a === '--workspace') o.workspace = val();
    else if (a === '--here') o.scope = 'here';
    else if (a === '--all') o.scope = 'all';
    else if (a === '--crew') o.crew = path.resolve(val());
    else if (a === '--tags') o.tags = val();
    else if (a === '--tags-scope') {
      o.tagScope = val();
      if (o.tagScope !== 'here' && o.tagScope !== 'all') throw new Error('--tags-scope must be here or all');
    }
    else if (a === '--provider') o.provider = val();
    else if (a === '--subview') o.subview = val();
    else if (a === '--view') {
      o.view = val();
      if (!VIEWS.includes(o.view)) throw new Error('--view must be auto, line, wrap or cards');
    }
    else if (a === '--budget') {
      o.budget = Number(val());
      if (!(o.budget > 0)) throw new Error('--budget must be a positive number of dollars');
    }
    else if (a === '--interval') o.interval = Math.max(2, Number(val()) || 3);
    else if (a === '--once') o.once = true;
    else if (a === '--backups') o.backups = true;
    else if (a === '--options') o.options = true;
    else if (a === '--orchestration' || a === '--experimental') o.orchestration = true;
    else if (a === '--json') { o.json = true; o.jsonRows = false; }
    else if (a === '--json-rows') { o.jsonRows = true; o.json = false; }
    else if (a === '--no-update-check') o.noUpdateCheck = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (o.tags && !TAG_MODES.includes(o.tags)) throw new Error('tags must be tokens, label, metadata or off');
  return o;
}

function crewResolver(opts) {
  const byDir = new Map();
  return (dir) => {
    // The file named with --crew is re-checked on every load: it may have been
    // made writable by group or others since the board started.
    if (opts.crew) return crewfile.safeToRun(opts.crew) ? crewfile.loadCrew(opts.crew) : null;
    if (!dir) return null;
    if (!byDir.has(dir)) byDir.set(dir, crewfile.findCrewFile(dir));
    const f = byDir.get(dir);
    return f ? crewfile.loadCrew(f) : null;
  };
}

// Usage limits are per account, so any pane's report will do: take the
// newest one per source, minus windows that have already reset.
function newestLimits(reports, now) {
  const by = {};
  for (const r of reports) {
    for (const l of (r && Array.isArray(r.limits) ? r.limits : [])) {
      if (!l || !l.source) continue;
      if (!by[l.source] || r.at > by[l.source].at) by[l.source] = { ...l, at: r.at };
    }
  }
  const out = [];
  for (const l of Object.values(by)) {
    if (l.windows && Array.isArray(l.windows)) {
      out.push({ source: l.source, at: l.at, windows: l.windows });
      continue;
    }
    const windows = ['five_hour', 'seven_day'].filter((w) => l[w] && !(l[w].resets && l[w].resets * 1000 < now));
    if (windows.length) out.push({ source: l.source, at: l.at, windows: windows.map((w) => ({ name: w === 'five_hour' ? '5h' : '7d', ...l[w] })) });
  }
  return out;
}

const SCREEN_TTL_MS = 15 * 1000;
const screenCache = new Map(); // pane id -> { seq, at, text }
const lastScreenSample = new Map(); // pane id -> timestamp
// A pane's shell pid lasts as long as its terminal; memory is read every 10 s.
const RAM_TTL_MS = 10 * 1000;
const shellPids = new Map(); // pane id -> { terminal, pid }
let ramCache = { at: 0, table: new Map() };

async function paneRss(agents, now) {
  for (const id of shellPids.keys()) if (!agents.some((a) => a.pane_id === id)) shellPids.delete(id);
  const todo = agents.filter((a) => (shellPids.get(a.pane_id) || {}).terminal !== a.terminal_id);
  const worker = async () => {
    for (let a = todo.shift(); a; a = todo.shift()) {
      const pid = await herdr.shellPid(a.pane_id).catch(() => null);
      shellPids.set(a.pane_id, { terminal: a.terminal_id, pid });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (now - ramCache.at >= RAM_TTL_MS) ramCache = { at: now, table: await ram.processTable() };
  const out = {};
  for (const a of agents) {
    const { pid } = shellPids.get(a.pane_id) || {};
    if (pid) out[a.pane_id] = ram.treeRss(ramCache.table, pid);
  }
  return out;
}

// One full data pass: Herdr snapshot, reports, screens where needed.
async function collect(opts, mem) {
  const now = Date.now();
  const snap = await herdr.snapshot();
  // Save the agent's real session id on the pane before anything reads the
  // snapshot, so backups and sessions.json can resume it later. Only a live
  // board writes metadata back; --json and --once stay read only.
  await sessions.resolveAgentSessions(snap, { herdr, writeBack: Boolean(opts.live), now }).catch(() => {});
  // A popup has no pane id of its own; Herdr still names its workspace.
  const home = (snap.panes.find((p) => p.pane_id === process.env.HERDR_PANE_ID) || {}).workspace_id
    || process.env.HERDR_WORKSPACE_ID || null;
  const ws = opts.workspace || (opts.scope === 'here' ? home : null);
  const myPaneId = process.env.HERDR_PANE_ID || null;
  const agents = selectAgents(snap, ws, { myPaneId });
  const reports = {};
  const screens = {};
  const events = {};
  for (const a of agents) {
    reports[a.pane_id] = readReport(a.pane_id, now);
    if (state.validPaneId(a.pane_id)) events[a.pane_id] = state.readJson(state.eventFile(a.pane_id));
  }
  const todo = agents.filter((a) => needsScreen(a, reports[a.pane_id]));
  // An idle screen does not change: reuse a read until the pane's status moves
  // or it is 15 s old. At most 3 reads at once, so a big crew is no burst.
  for (const id of screenCache.keys()) if (!snap.agents.some((a) => a.pane_id === id)) screenCache.delete(id);
  const fresh = (a) => {
    const c = screenCache.get(a.pane_id);
    return c && c.seq === a.state_change_seq && now - c.at < SCREEN_TTL_MS ? c : null;
  };
  const queue = todo.filter((a) => {
    const c = fresh(a);
    if (c) screens[a.pane_id] = c.text;
    return !c;
  });
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      try {
        const text = await herdr.readPane(a.pane_id);
        screens[a.pane_id] = text;
        screenCache.set(a.pane_id, { seq: a.state_change_seq, at: now, text });
      } catch (e) {
        // unreadable pane: its numbers stay "?"
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const rss = await paneRss(agents, now);
  const trust = { ...(state.readJson(trustFile()) || {}) };
  const crewFor = crewResolver(opts);
  // A crew file you named with --crew is trusted as it is, after another
  // ownership and permission check on this load.
  if (opts.crew && crewfile.safeToRun(opts.crew)) {
    const c = crewFor(null);
    if (c) trust[c.file] = c.hash;
  }
  const model = buildModel({ snap, agents, screens, reports, events, rss, crewFor, mem, now, budget: opts.budget, trust, tagScope: opts.tagScope });
  if (opts.live) {
    for (const a of agents) {
      if (!reports[a.pane_id] && screens[a.pane_id] != null) {
        const last = lastScreenSample.get(a.pane_id) || 0;
        if (now - last >= SCREEN_TTL_MS) {
          const scr = parseScreen(a.agent, screens[a.pane_id]);
          if (scr && (scr.tokens != null || scr.ctx != null || scr.cost != null || scr.model != null)) {
            try {
              appendUsage({
                at: new Date(now).toISOString(),
                pane: a.pane_id,
                model: scr.model || null,
                effort: scr.effort || null,
                tokens: scr.tokens !== undefined ? scr.tokens : null,
                input: scr.input !== undefined ? scr.input : null,
                output: scr.output !== undefined ? scr.output : null,
                cost: scr.cost !== undefined ? scr.cost : null,
                ctx: scr.ctx !== undefined ? scr.ctx : null,
                src: 'screen',
              });
              lastScreenSample.set(a.pane_id, now);
            } catch {
              // failure isolation
            }
          }
        }
      }
    }
  }
  const loadedConfig = config.loadConfig();
  model.snapshot = snap;
  model.home = home;
  model.scopeLabel = ws ? model.workspaces.get(ws) || ws : 'all';
  model.config = loadedConfig.config;
  model.configWarnings = loadedConfig.warnings;
  // Codex has no statusline: its limits come from its newest session file.
  const usageReports = snap.agents.map((a) => reports[a.pane_id] || readReport(a.pane_id, now, true))
    .concat(codex.limits(now) || [])
    .concat(experiential.limits(now, { enabled: model.explabsEnabled }) || []);
  const limits = newestLimits(usageReports, now);
  model.limits = burn.forecast(limits, now, { save: Boolean(opts.live) });
  // tokscale is slow, so only a live board starts it; --once would wait on it.
  model.tokscale = opts.live ? tokscale.today(now) : null;
  // The hourly chart costs a tokscale run per agent, so it starts only once
  // the today view has been opened.
  model.hourly = opts.live && opts.wantHourly && model.tokscale
    ? tokscale.hourly(now, Object.entries(model.tokscale.clients || {}).sort((x, y) => tokensOf(y[1]) - tokensOf(x[1])).map(([name]) => name))
    : null;
  model.update = opts.live ? update.check(now, { noUpdateCheck: opts.noUpdateCheck }) : null;
  return model;
}

function trustFile() {
  return path.join(state.stateDir(), 'trust.json');
}

// Allow the crew files as they are now: their checks start running. Grants
// for files that no longer exist go.
function trustCrews(crews) {
  const trust = state.readJson(trustFile()) || {};
  for (const f of Object.keys(trust)) if (!fs.existsSync(f)) delete trust[f];
  for (const c of crews) trust[c.file] = c.hash;
  state.writeJson(trustFile(), trust);
}

// What a row publishes to Herdr's sidebar in tokens mode. Unknown values are
// empty, which clears the token.
function sidebarTokens(r) {
  const value = (f) => (f && f.v !== undefined && f.v !== null ? f.v : null);
  const known = (f, fmt) => (value(f) === null ? '' : fmt(value(f)));
  const hasDisplayTag = Boolean((r.displayAgent && TAG_RE.test(r.displayAgent)) || (r.label && TAG_RE.test(r.label)));
  const model = value(r.model);
  const cost = value(r.cost);
  const labelName = r.label ? stripTag(r.label) : '';
  const displayName = r.displayName && r.displayName !== r.paneId ? r.displayName : null;
  return {
    tag: hasDisplayTag ? '' : (r.tag || ''),
    name: displayName || labelName || r.agentName || r.kind || '',
    task: r.task ? ui.truncate(r.task, 40) : '',
    model: model === null ? '' : ui.truncate(agentCell(r).text, 24),
    ctx: known(r.ctx, fmtCtx),
    cost: cost === null ? '' : (r.cost && r.cost.src === 'estimate' ? `~${fmtCost(cost)}` : fmtCost(cost)),
    ram: known(r.ram, fmtRam),
  };
}

// Colour tags outside the board. Tokens mode (the default) publishes $tag,
// $task, $model, $ctx, $cost, and $ram for Herdr's sidebar and never touches a
// label. Label mode prefixes the pane label with the
// mark, and puts it back after the lead renames the pane; it only writes when
// the prefix is missing, at most once per cooldown, so it never fights a
// rename or flickers. Metadata mode sets Herdr's display only agent text.
// Switching away from a mode takes its marks back off.
async function applyTags(model, opts, memo) {
  const now = Date.now();
  const myPaneId = process.env.HERDR_PANE_ID || null;
  const scope = model.tagScope === 'all' ? 'all' : 'here';
  const home = model.home || null;
  for (const r of model.rows) {
    if (myPaneId && r.paneId === myPaneId) continue;
    if (r.label && (r.label === '🐓ROOSTR🐓' || r.label.endsWith('🐓ROOSTR🐓') || r.label === 'crew-board')) continue;
    const inScope = scope === 'all' || Boolean(home && r.workspaceId === home);
    const mode = opts.tags || r.crewTags || 'label';
    // An unlabelled pane gets a label in label mode so its mark shows too.
    const tagged = Boolean(r.label && TAG_RE.test(r.label));
    const base = r.label ? stripTag(r.label) : (mode === 'label' ? (r.name && r.name !== r.paneId ? r.name : r.kind) : '');
    if (inScope && base && mode !== 'off') {
      // A pane created for a crew starts with its emoji. Keep that mark in the
      // label in every mode except off, so the pane header stays easy to match
      // to the board row even when the user chose tokens or metadata.
      const want = mode === 'label' || tagged ? `${r.tag} ${base}` : base;
      if (r.label !== want && want !== '' && now - (memo.renamed[r.paneId] || 0) >= RENAME_COOLDOWN_MS) {
        memo.renamed[r.paneId] = now;
        await herdr.renamePane(r.paneId, want).catch(() => {});
      }
    }
    if (mode === 'metadata') {
      const want = `${r.tag} ${r.kind}`;
      if (inScope && memo.display[r.paneId] !== want) {
        await herdr.setDisplayAgent(r.paneId, want).then(() => { memo.display[r.paneId] = want; }, () => {});
      }
    } else if (inScope && memo.display[r.paneId]) {
      delete memo.display[r.paneId];
      await herdr.clearDisplayAgent(r.paneId).catch(() => {});
    }
    const toks = memo.tokens || (memo.tokens = {});
    if (mode !== 'off') {
      const tokens = sidebarTokens(r);
      const want = JSON.stringify(tokens);
      const last = toks[r.paneId];
      if (!last || last.want !== want || now - last.at >= TOKEN_REFRESH_MS) {
        await herdr.setTokens(r.paneId, tokens, TOKEN_TTL_MS).then(() => { toks[r.paneId] = { want, at: now }; }, () => {});
      }
    } else if (toks[r.paneId]) {
      delete toks[r.paneId];
      await herdr.clearTokens(r.paneId, TOKEN_NAMES).catch(() => {});
    }
  }
}

async function runOnce(opts) {
  const mem = loadMemory();
  let model = await collect(opts, mem);
  await checks.refresh(model.checkList, Date.now(), checks.MIN_INTERVAL_MS, {
    maxConcurrent: model.checkConcurrency,
    timeoutMs: model.checkTimeoutMs,
  });
  model = await collect(opts, mem);
  if (opts.jsonRows) {
    process.stdout.write(JSON.stringify(toJsonRows(model), null, 2) + '\n');
  } else if (opts.json) {
    process.stdout.write(JSON.stringify(toJson(model), null, 2) + '\n');
  } else {
    ui.setColor(ui.defaultColor(process.stdout));
    const width = Number(process.env.COLUMNS) || process.stdout.columns || 120;
    process.stdout.write(render(model, { width, view: opts.view }) + '\n');
  }
  return 0;
}

// Mouse clicks arrive as SGR sequences: ESC [ < button ; x ; y M
const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

// Menu choices are remembered; a flag on the command line wins over them.
// Scope is not: every board starts on its own workspace.
function applyPrefs(opts, mem) {
  for (const k of ['tags', 'view', 'provider', 'subviews']) {
    // --subview is one provider's sub-view; do not let remembered per-provider
    // choices override an explicit flag.
    if (k === 'subviews' && opts.set.has('subview')) continue;
    if (!opts.set.has(k) && mem.prefs[k]) opts[k] = mem.prefs[k];
  }
}

function runLive(opts) {
  const out = process.stdout;
  ui.setColor(ui.defaultColor(out));
  // Keep the host terminal title in sync with the pane label.
  out.write('\x1b]0;🐓ROOSTR🐓\x07\x1b]2;🐓ROOSTR🐓\x07');
  const myPaneId = process.env.HERDR_PANE_ID || null;
  const ensurePaneName = () => {
    if (myPaneId) {
      herdr.renamePane(myPaneId, '🐓ROOSTR🐓').catch(() => {});
    }
  };
  ensurePaneName();
  const mem = loadMemory();
  applyPrefs(opts, mem);
  const memo = { renamed: {}, display: {}, tokens: {} };
  opts.live = true;
  let model = null;
  let error = null;
  let busy = false;
  let queued = false;
  let timer = null;
  let selected = 0;
  let selectedPane = null;
  let edit = null;
  let help = false;
  let detail = false;
  let today = false;
  let backups = null;
  let logView = null;
  let respawn = null;
  let options = Boolean(opts.options);
  let setup = null;
  let orchestrate = null;
  let activePlanDir = mem.prefs.planDir || null;
  let headPicker = null;
  let updating = null; // { version, state: 'installing' | 'done' }
  let metric = 'tokens';
  let hits = [];
  let notice = null;
  let noticeTimer = null;
  let lastRowClick = null;
  let recoverPending = null;
  const folded = new Set();

  const shownProvider = () => {
    const all = providers(model && model.limits);
    if (!all.length) return null;
    if (opts.provider === 'off') return 'off';
    return all.includes(opts.provider) ? opts.provider : all[0];
  };
  const shownSubview = (prov) => {
    if (!prov || prov === 'off') return 'all';
    const sub = (opts.subviews && opts.subviews[prov]) || opts.subview || 'all';
    const provLimits = (model && model.limits ? model.limits : []).filter((l) => providerOf(l.source) === prov);
    const sources = [...new Set(provLimits.map((l) => l.source))];
    return sources.includes(sub) ? sub : 'all';
  };
  const menu = () => {
    const prov = (model && providers(model.limits).length > 0) ? shownProvider() : null;
    const provLimits = (prov && model && model.limits) ? model.limits.filter((l) => providerOf(l.source) === prov) : [];
    const sources = [...new Set(provLimits.map((l) => l.source))];
    return {
      tags: opts.tags || 'label', view: opts.view, scope: model ? model.scopeLabel : 'all',
      orchestration: orchestrationEnabled(currentConfig(), opts),
      provider: prov,
      subview: prov ? shownSubview(prov) : null,
      hasSubviews: sources.length > 1,
      trust: Boolean(model && model.untrusted && model.untrusted.length),
      notice: notice || null,
      update: updating
        ? (updating.state === 'done' ? `✓ v${updating.version} installed · reopen` : `⬆ installing v${updating.version}…`)
        : (model && model.update ? `⬆ v${model.update} · u` : null),
    };
  };

  const draw = () => {
    if (!model) return;
    if (selectedPane) {
      const i = model.rows.findIndex((r) => r.paneId === selectedPane);
      if (i >= 0) selected = i;
    }
    selected = Math.max(0, Math.min(selected, model.rows.length - 1));
    selectedPane = model.rows[selected] ? model.rows[selected].paneId : null;
    hits = [];
    const prov = shownProvider();
    const frame = render(model, {
      width: out.columns || 100, height: out.rows || 0, error, view: opts.view, menu: menu(), selected, edit, hits, folded,
      provider: prov, subview: prov ? shownSubview(prov) : null, help, detail, today, metric, backups, logView, setup, headPicker, options, orchestrate,
    });
    // Erase each line before writing it: erasing after a full width line would
    // eat its last cell. Keep terminal and pane title locked to 🐓ROOSTR🐓.
    out.write('\x1b]0;🐓ROOSTR🐓\x07\x1b]2;🐓ROOSTR🐓\x07\x1b[H' + frame.split('\n').map((l) => '\x1b[2K' + l).join('\n') + '\x1b[J');
  };

  const tick = async () => {
    if (busy) {
      queued = true;
      return;
    }
    busy = true;
    try {
      ensurePaneName();
      model = await collect(opts, mem);
      error = null;
      checks.refresh(model.checkList, Date.now(), checks.MIN_INTERVAL_MS, {
        maxConcurrent: model.checkConcurrency,
        timeoutMs: model.checkTimeoutMs,
      }).then(() => {}, () => {});
      await applyTags(model, opts, memo);
      // Crash recovery: the newest pane snapshot is always on disk.
      try { sessions.saveSessions(model); } catch (e) { /* a full disk must not stop the board */ }
      try { backup.saveBackups(backup.capture(model)); } catch (e) { /* same for the workspace backups */ }
      if (backups) backups = refreshBackups(backups);
      if (logView && !logView.busy && Date.now() - logView.at > 15000) refreshLog();
      saveMemory(mem, new Set(model.rows.map((r) => r.paneId)), model.live, touched);
      // Herdr reuses pane ids: a closed pane's report must not dress up the next one.
      pruneReports(model.live);
    } catch (e) {
      error = (e && e.message ? e.message : String(e)).split('\n')[0];
      if (!model) model = { rows: [], crews: [], crewChecks: [], checkList: [], now: Date.now(), workspaces: new Map(), scopeLabel: 'all' };
    } finally {
      busy = false;
      if (queued) {
        queued = false;
        tick();
      }
    }
    draw();
  };

  const touched = new Set();
  const remember = (k, v) => {
    opts[k] = v;
    mem.prefs[k] = v;
    touched.add(k);
    saveMemory(mem, model ? new Set(model.rows.map((r) => r.paneId)) : new Set(), model ? model.live : null, touched);
  };
  const cycle = (list, v) => list[(list.indexOf(v) + 1) % list.length];

  const flash = (text, ms = 2500) => {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = null; draw(); }, ms);
  };

  const currentConfig = () => (model && model.config) || config.loadConfig().config;

  const openHeadPicker = () => {
    if (!model || !model.home) {
      flash('open the board in a workspace to start head-honcho');
      return;
    }
    const agents = model.snapshot && Array.isArray(model.snapshot.agents) ? model.snapshot.agents : [];
    const panes = orchestrator.shellPanes(model.snapshot, agents, model.home);
    if (!panes.length) {
      flash('no shell pane in this workspace; split one and try again');
      return;
    }
    headPicker = { role: 'head-honcho', title: 'head-honcho', panes, index: 0, confirm: false, starting: false, status: null };
    draw();
  };

  const startPickedRole = async (paneId) => {
    if (!headPicker || headPicker.starting) return;
    const roleKey = headPicker.role || 'head-honcho';
    headPicker.starting = true;
    headPicker.confirm = false;
    headPicker.status = `checking ${paneId}…`;
    draw();
    let snap;
    try {
      snap = await herdr.snapshot();
    } catch (e) {
      headPicker.status = `error: ${(e.message || String(e)).split('\n')[0]}`;
      headPicker.starting = false;
      draw();
      return;
    }
    const pane = snap.panes.find((p) => p.pane_id === paneId);
    if (!pane || pane.workspace_id !== (model && model.home)) {
      headPicker.status = 'error: pane is gone';
      headPicker.starting = false;
      draw();
      return;
    }
    if (snap.agents.some((a) => a.pane_id === paneId)) {
      headPicker.status = 'error: pane is already an agent';
      headPicker.starting = false;
      draw();
      return;
    }
    const cfg = currentConfig();
    const role = orchestrator.resolveRole(cfg, roleKey);
    const kind = role.tool || cfg.defaultTool || 'claude';
    const args = orchestrator.roleArgs(role, kind);
    const headTitle = cfg.headName === 'auto'
      ? names.pickTitle({ exclude: snap.agents.map((a) => a.name) })
      : cfg.headName;
    const name = orchestrator.nextName(snap.agents, headTitle, orchestrator.projectName(snap, model.home, process.cwd()));
    const displayName = name;
    const taskLine = orchestrator.TASK;
    headPicker.status = `starting head-honcho in ${paneId}…`;
    draw();
    try {
      await herdr.startAgent(name, kind, paneId, args);
    } catch (e) {
      headPicker.status = `error: ${(e.message || String(e)).split('\n')[0]}`;
      headPicker.starting = false;
      draw();
      return;
    }
    const warnings = [];
    const step = async (fn, label) => {
      try { await fn(); } catch (e) { warnings.push(`${label}: ${(e.message || String(e)).split('\n')[0]}`); }
    };
    await step(() => herdr.renameAgent(paneId, name), 'rename agent');
    const liveIds = [...(model && model.live ? model.live : []), paneId];
    const shownIds = [...(model ? model.rows.map((r) => r.paneId) : []), paneId];
    assignTags(mem, shownIds, new Set(liveIds));
    const tag = mem.tags[paneId] || '';
    await step(() => herdr.renamePane(paneId, `${tag ? `${tag} ` : ''}${displayName} · ${taskLine}`), 'rename pane');
    const values = { task: taskLine, taskSource: 'manual', effort: role.effort };
    if (role.model) values.model = role.model;
    await step(() => writeReport(paneId, values), 'report');
    await step(() => herdr.promptAgent(paneId, orchestrator.prompt(name)), 'prompt');
    const promptFailed = warnings.some((w) => w.startsWith('prompt:'));
    const hint = warnings.length ? ` (${warnings.join('; ')})` : '';
    headPicker = null;
    flash(promptFailed ? `agent started; press f to jump and prompt manually${hint}` : `started ${name} in ${paneId}${hint}`, 3000);
    tick();
  };

  const recoverPane = async () => {
    const row = model && model.rows[selected];
    if (!row) {
      flash('no pane selected');
      return;
    }
    const now = Date.now();
    if (recoverPending && recoverPending.paneId === row.paneId && now - recoverPending.at <= RECOVER_CONFIRM_MS) {
      const pending = recoverPending;
      recoverPending = null;
      try {
        if (pending.kind === 'allow') {
          await herdr.sendKeys(pending.paneId, ['Return']);
          flash(`sent allow to ${row.displayName || row.name}`, 3500);
        } else {
          await herdr.promptAgent(pending.paneId, 'Continue the current package. Re-read the brief if needed and report status in one line.');
          flash(`sent continue to ${row.displayName || row.name}`, 3500);
        }
      } catch (e) {
        flash(`recover failed: ${(e.message || String(e)).split('\n')[0]}`, 4000);
      }
      return;
    }
    if (row.status === 'working') {
      flash('pane is working; no recover action');
      return;
    }
    if (row.status === 'blocked') {
      let text = '';
      try { text = await herdr.readPane(row.paneId); } catch (e) {
        flash(`could not read the pane: ${(e.message || String(e)).split('\n')[0]}`);
        return;
      }
      const verdict = recover.classifyScreen(text);
      if (!verdict.action) {
        flash(`no allow or continue prompt: ${verdict.reason}`);
        return;
      }
      if (!verdict.safe) {
        flash(`refused: ${verdict.reason}; handle it by hand`);
        return;
      }
      recoverPending = { paneId: row.paneId, kind: verdict.action, at: now };
      flash(`press C again to ${verdict.action === 'allow' ? 'allow' : 'continue'} ${row.displayName || row.name}`, 4000);
      return;
    }
    if (row.status === 'idle' && row.statusFor >= IDLE_CONTINUE_MS) {
      recoverPending = { paneId: row.paneId, kind: 'continue', at: now };
      flash(`press C again to continue ${row.displayName || row.name}`, 4000);
      return;
    }
    flash(row.status === 'idle' ? 'idle for less than 10m; no action yet' : 'pane is not blocked or stuck');
  };

  const workspaceDirs = () => {
    const panes = model && model.snapshot && Array.isArray(model.snapshot.panes) ? model.snapshot.panes : [];
    return [...new Set(panes.filter((p) => p.workspace_id === model.home && p.cwd).map((p) => p.cwd))];
  };

  const refreshLog = () => {
    if (!logView || logView.busy) return;
    logView.busy = true;
    draw();
    sessionLog.list({ dirs: logView.all ? [] : logView.dirs, all: logView.all, noCache: true })
      .then((items) => {
        if (!logView) return;
        logView.items = items;
        logView.sel = Math.max(0, Math.min(logView.sel, items.length - 1));
        logView.at = Date.now();
        logView.status = null;
      }, (e) => {
        if (logView) logView.status = `log failed: ${(e.message || String(e)).split('\n')[0]}`;
      })
      .then(() => {
        if (logView) logView.busy = false;
        draw();
      });
  };

  const openLog = () => {
    if (logView) {
      logView = null;
      draw();
      return;
    }
    logView = { items: [], sel: 0, all: false, dirs: workspaceDirs(), busy: false, status: null, at: 0 };
    refreshLog();
  };

  const resumeLogged = () => {
    const item = logView && logView.items[logView.sel];
    if (!item || logView.busy) return;
    const home = model && model.home;
    const panes = (model && model.snapshot ? model.snapshot.panes : [])
      .filter((p) => p.workspace_id === home && p.pane_id !== myPaneId);
    const parent = panes.find((p) => p.focused) || panes[panes.length - 1];
    logView.busy = true;
    logView.status = `resuming ${ui.clean(item.title || item.id)}…`;
    draw();
    sessionLog.resume(item, { workspace: home, pane: parent && parent.pane_id }, { herdr }).then((r) => {
      if (logView) {
        logView.busy = false;
        logView.status = r.error ? `resume failed: ${r.error}` : `resumed ${r.name} in ${r.paneId}`;
      }
      draw();
      tick();
    }, (e) => {
      if (logView) {
        logView.busy = false;
        logView.status = `resume failed: ${(e.message || String(e)).split('\n')[0]}`;
      }
      draw();
    });
  };

  const respawnLabel = () => {
    const ws = model && model.snapshot && Array.isArray(model.snapshot.workspaces)
      ? model.snapshot.workspaces.find((w) => w.workspace_id === model.home) : null;
    return (ws && (ws.label || ws.workspace_id)) || (model && model.home) || '?';
  };

  // The workspace closes, so the board cannot run the respawn itself: a
  // detached child does it and reopens a board in the rebuilt workspace.
  const startRespawn = () => {
    const target = respawn;
    respawn = null;
    notice = null;
    if (!target) return;
    const env = { ...process.env };
    delete env.HERDR_PANE_ID;
    const child = child_process.spawn(
      process.execPath,
      [path.join(__dirname, '..', 'bin', 'roostr'), 'respawn', '--workspace', target.workspaceId, '--yes', '--reopen-board'],
      { detached: true, stdio: 'ignore', env },
    );
    child.on('error', () => {});
    child.unref();
    quit();
  };

  const askRespawn = () => {
    if (!model || !model.home) {
      flash('open the board in a workspace to respawn it');
      return;
    }
    respawn = { workspaceId: model.home, label: respawnLabel() };
    clearTimeout(noticeTimer);
    notice = `respawn ${respawn.label}? y confirm · any other key cancels`;
    draw();
  };

  const openBackups = () => {
    backups = backups ? null : refreshBackups({ list: [], sel: 0, ver: 0, confirm: false, status: null, layout: 'even' });
    draw();
  };

  const restoreBackup = () => {
    const b = backups.list[backups.sel];
    const v = b && b.versions[backups.ver];
    if (!v || backups.busy) return;
    backups.busy = true;
    backups.status = `building ${v.backup.label}${backup.SUFFIX}…`;
    draw();
    const taken = model && model.snapshot ? model.snapshot.agents.map((a) => a.name).filter(Boolean) : [];
    backup.restoreBackup(v.backup, { herdr, taken, layout: backups.layout || 'even' }).then((r) => {
      const failed = r.errors.length ? ` · ${r.errors.length} failed: ${r.errors[0]}` : '';
      if (backups) {
        backups.busy = false;
        backups.status = `built ${r.label}: ${r.panes} panes, ${r.agents} agents, ${r.sessions.length} resumed${failed}`;
      }
      if (r.workspaceId) herdr.focusWorkspace(r.workspaceId).catch(() => {});
      tick();
    }, (e) => {
      if (backups) {
        backups.busy = false;
        backups.status = `restore failed: ${e.message}`;
      }
      draw();
    });
  };

  const act = (action) => {
    const row = model && model.rows[selected];
    if (action === 'tags') remember('tags', cycle(TAG_MODES, opts.tags || 'label'));
    else if (action === 'view') remember('view', cycle(VIEWS, opts.view));
    else if (action === 'provider') {
      const all = providers(model && model.limits);
      if (all.length > 0) {
        const choices = [...all, 'off'];
        const current = shownProvider();
        const next = cycle(choices, current);
        remember('provider', next);
        draw();
      }
    }
    else if (action === 'subview') {
      const prov = shownProvider();
      if (prov && prov !== 'off') {
        const sources = sourcesOf(model && model.limits, prov);
        if (sources.length > 1) {
          const choices = ['all', ...sources];
          const cur = shownSubview(prov);
          const next = cycle(choices, cur);
          const nextSubviews = { ...(opts.subviews || {}), [prov]: next };
          remember('subviews', nextSubviews);
          draw();
        }
      }
    }
    else if (action === 'scope') {
      opts.workspace = null;
      opts.scope = opts.scope === 'here' ? 'all' : 'here';
    } else if (action === 'workspace') {
      if (opts.view === 'cards') {
        opts.view = mem.prefs.view && mem.prefs.view !== 'cards' ? mem.prefs.view : 'auto';
      } else {
        opts.view = 'cards';
        if (opts.scope !== 'here') {
          opts.workspace = null;
          opts.scope = 'here';
        }
      }
      remember('view', opts.view);
      tick();
    } else if (action === 'edit' && row) edit = { text: row.task || '' };
    else if (action === 'help') help = !help;
    else if (action === 'today') {
      today = !today;
      if (today && !opts.wantHourly) {
        opts.wantHourly = true;
        tick();
      }
    } else if (action === 'metric') metric = metric === 'tokens' ? 'cost' : 'tokens';
    else if (action === 'options') {
      options = !options;
      if (options) {
        detail = false;
        today = false;
        backups = null;
        help = false;
      }
    }
    else if (action === 'detail') detail = !detail;
    else if (action === 'close') detail = false;
    else if (action === 'jump' && row) herdr.focusAgent(row.paneId).catch(() => {});
    else if (action === 'trust' && model && model.untrusted && model.untrusted.length) {
      try {
        trustCrews(model.untrusted);
      } catch (e) {
        error = e.message;
      }
    }
    else if (action === 'copy-id' && row) {
      copyToClipboard(row.paneId);
      notice = `copied ${row.paneId}`;
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        notice = null;
        draw();
      }, 2000);
    }
    else if (action === 'log') openLog();
    else if (action === 'respawn') askRespawn();
    else if (action === 'backups') openBackups();
    else if (action === 'refresh') tick();
    else if (action && action.startsWith('orch-tab:') && orchestrate) {
      const nextTab = action.slice('orch-tab:'.length);
      if (ORCHESTRATE_TABS.includes(nextTab)) {
        orchestrate.tab = nextTab;
        orchestrate.notice = null;
        orchestrate.error = null;
      }
    }
    else if (['orchestrate', 'setup', 'head-honcho', 'recover'].includes(action)) {
      if (!orchestrationEnabled(currentConfig(), opts)) {
        flash('orchestration is gated for v0.3.0 (set ROOSTR_EXPERIMENTAL=1)');
        return;
      }
      if (action === 'orchestrate') {
        if (orchestrate) {
          orchestrate = null;
        } else {
          const loaded = config.loadConfig();
          orchestrate = orchestrateState(model, loaded.config, loaded.warnings, 'tasks', activePlanDir);
        }
      } else if (action === 'setup') {
        if (orchestrate && orchestrate.tab === 'setup') {
          orchestrate = null;
        } else {
          const loaded = config.loadConfig();
          orchestrate = orchestrateState(model, loaded.config, loaded.warnings, 'setup', activePlanDir);
        }
      } else if (action === 'head-honcho') openHeadPicker();
      else if (action === 'recover') recoverPane();
    }
    else if (action === 'update' && model && model.update && !updating) {
      // The new files land in place; this process keeps running the old code
      // until the board is reopened.
      updating = { version: model.update, state: 'installing' };
      herdr.installPlugin(update.REPO, updating.version).then(() => {
        updating.state = 'done';
        draw();
      }, (e) => {
        updating = null;
        error = `update failed: ${(e && e.message ? e.message : String(e)).split('\n')[0]}`;
        draw();
      });
    }
    if (['tags', 'scope', 'trust'].includes(action)) tick();
    draw();
  };

  const select = (i) => {
    selected = i;
    selectedPane = null;
    draw();
  };

  // Move the selection up or down, skipping rows in folded workspaces.
  const step = (dir) => {
    const rows = model ? model.rows : [];
    const multiWs = new Set(rows.map((r) => r.workspace)).size > 1;
    for (let i = selected + dir; i >= 0 && i < rows.length; i += dir) {
      if (!(multiWs && folded.has(rows[i].workspace))) return select(i);
    }
  };

  const saveEdit = async () => {
    const row = model.rows[selected];
    const text = edit.text;
    edit = null;
    if (row) await herdr.renamePane(row.paneId, editedLabel(row, text)).catch((e) => { error = e.message; });
    tick();
  };

  const onKey = (k) => {
    if (edit) {
      const e = editChunk(k);
      if (e.action === 'save') saveEdit();
      else if (e.action === 'cancel') edit = null;
      else if (e.action === 'backspace') edit.text = Array.from(edit.text).slice(0, -1).join('');
      else if (e.action === 'ignore') return; // arrows and other escapes do nothing while typing
      else edit.text += e.text;
      draw();
      return;
    }
    if (orchestrate) {
      const r = orchestrateKey(orchestrate, k, model);
      if (r && r.cancel) orchestrate = null;
      else if (r && r.saveSetup) {
        if (setupReady(orchestrate.setup)) {
          try {
            const saved = config.saveConfig(orchestrate.setup.config);
            if (model) {
              model.config = saved.config;
              model.configWarnings = saved.warnings;
            }
            orchestrate.setup.warnings = saved.warnings;
            orchestrate.setup.error = null;
            orchestrate.notice = 'setup saved';
            flash('setup saved');
          } catch (e) {
            orchestrate.setup.error = (e.message || String(e)).split('\n')[0];
          }
        }
      } else if (r && r.bindPlanDir) {
        activePlanDir = r.bindPlanDir;
        remember('planDir', activePlanDir);
      } else if (r && r.assignOrchestrator) {
        if (r.assignOrchestrator) {
          try {
            writeReport(r.assignOrchestrator, { role: 'head-honcho', about: 'Workspace orchestrator (roostr)' });
            orchestrate.notice = `assigned head-honcho role to ${r.assignOrchestrator}`;
            flash(`assigned head-honcho role to ${r.assignOrchestrator}`);
            tick();
          } catch (e) {
            orchestrate.error = (e.message || String(e)).split('\n')[0];
          }
        }
      } else if (r && r.spawnHeadInShell) {
        orchestrate = null;
        openHeadPicker();
        return;
      }
      draw();
      return;
    }
    if (setup) {
      const r = setupKey(setup, k);
      if (r && r.cancel) setup = null;
      else if (r && r.save) {
        if (setupReady(setup)) {
          try {
            const saved = config.saveConfig(setup.config);
            if (model) {
              model.config = saved.config;
              model.configWarnings = saved.warnings;
            }
            setup = null;
            flash('setup saved');
          } catch (e) {
            setup.error = (e.message || String(e)).split('\n')[0];
          }
        }
      }
      draw();
      return;
    }
    if (headPicker) {
      if (headPicker.starting) return;
      if (headPicker.confirm) {
        headPicker.confirm = false;
        if (k === 'y') { startPickedRole(headPicker.panes[headPicker.index].paneId); return; }
        draw();
        return;
      }
      const n = headPicker.panes.length;
      if (k === '\x1b') headPicker = null;
      else if (k === '\x1b[A' || k === 'k') headPicker.index = Math.max(0, headPicker.index - 1);
      else if (k === '\x1b[B' || k === 'j') headPicker.index = Math.min(Math.max(0, n - 1), headPicker.index + 1);
      else if ((k === '\r' || k === '\n') && n) headPicker.confirm = true;
      draw();
      return;
    }
    if (help && k !== '\x03') {
      help = false;
      draw();
      return;
    }
    if (respawn) {
      if (k === 'y') { startRespawn(); return; }
      respawn = null;
      notice = null;
      draw();
      return;
    }
    if (logView) {
      const n = logView.items.length;
      if (k === '\x1b' || k === 'L' || k === 'q') logView = null;
      else if (k === '\x03') return quit();
      else if (k === '\x1b[A' || k === 'k') logView.sel = Math.max(0, logView.sel - 1);
      else if (k === '\x1b[B' || k === 'j') logView.sel = Math.min(Math.max(0, n - 1), logView.sel + 1);
      else if (k === 'a') { logView.all = !logView.all; refreshLog(); return; }
      else if (k === 'r') { refreshLog(); return; }
      else if ((k === '\r' || k === '\n') && n) { resumeLogged(); return; }
      draw();
      return;
    }
    if (backups) {
      if (backups.confirm) {
        backups.confirm = false;
        if (k === 'y') restoreBackup();
        else draw();
        return;
      }
      const n = backups.list.length;
      const vers = n ? backups.list[backups.sel].versions.length : 0;
      if (k === '\x1b' || k === 'R' || k === 'q') backups = null;
      else if (k === '\x03') return quit();
      else if (k === '\x1b[A' || k === 'k') { backups.sel = Math.max(0, backups.sel - 1); backups.ver = 0; }
      else if (k === '\x1b[B' || k === 'j') { backups.sel = Math.min(Math.max(0, n - 1), backups.sel + 1); backups.ver = 0; }
      else if (k === '\x1b[D' || k === 'h') backups.ver = Math.max(0, backups.ver - 1);
      else if (k === '\x1b[C' || k === 'l') backups.ver = Math.min(Math.max(0, vers - 1), backups.ver + 1);
      else if (k === 'p') backups.layout = cycle(backup.LAYOUTS, backups.layout || 'even');
      else if ((k === 'r' || k === '\r') && n) backups.confirm = true;
      draw();
      return;
    }
    if (options) {
      if (k === '\x1b' || k === 'o' || k === 'q') options = false;
      else if (k === '\x03') return quit();
      else if (k === 't') act('tags');
      else if (k === 'v') act('view');
      else if (k === 'w') act('workspace');
      else if (k === 's') act('scope');
      else if (k === '$') act('metric');
      else if (k === 'r') tick();
      else if (k === '?') act('help');
      draw();
      return;
    }
    if (k === '\x1b' && today) act('today');
    else if (k === '\x1b' && detail) act('close');
    else if (k === 'q' || k === '\x03' || k === '\x1b') quit();
    else if (k === 'r') tick();
    else if (k === '\x1b[A' || k === 'k') step(-1);
    else if (k === '\x1b[B' || k === 'j') step(1);
    else if (k === '\r') act('detail');
    else if (k === 'f') act('jump');
    else if (k === 'e') act('edit');
    else if (k === 't') act('tags');
    else if (k === 'v') act('view');
    else if (k === 'w') act('workspace');
    else if (k === 's') act('scope');
    else if (k === 'p') act('provider');
    else if (k === 'P') act('subview');
    else if (k === 'a') act('trust');
    else if (k === '?') act('help');
    else if (k === 'd') act('today');
    else if (k === '$') act('metric');
    else if (k === 'u') act('update');
    else if (k === 'y') act('copy-id');
    else if (k === 'L') act('log');
    else if (k === 'X') act('respawn');
    else if (k === 'R') act('backups');
    else if (k === 'o') act('options');
    else if (k === 'S') act('setup');
    else if (k === 'O' || k === 'T') act('orchestrate');
    else if (k === 'C') act('recover');
  };

  const onClick = (x, y) => {
    const h = hits.find((r) => r.y === y - 1 && x - 1 >= r.x0 && x - 1 <= r.x1);
    if (help) {
      help = false;
      draw();
      return;
    }
    if (h && ['orchestrate', 'today', 'log', 'backups', 'respawn', 'options', 'help'].includes(h.action)) {
      if (h.action === 'orchestrate') {
        if (orchestrate) orchestrate = null;
        else act('orchestrate');
      } else if (h.action === 'today') {
        if (today) today = false;
        else act('today');
      } else if (h.action === 'log') {
        openLog();
      } else if (h.action === 'backups') {
        if (backups) backups = null;
        else openBackups();
      } else if (h.action === 'respawn') {
        askRespawn();
      } else if (h.action === 'options') {
        if (options) options = false;
        else act('options');
      } else if (h.action === 'help') {
        help = !help;
      }
      draw();
      return;
    }
    if (orchestrate && h) {
      if (h.action === 'orch-tab') {
        if (ORCHESTRATE_TABS.includes(h.tab)) {
          orchestrate.tab = h.tab;
          orchestrate.notice = null;
          orchestrate.error = null;
        }
      } else if (typeof h.action === 'string' && h.action.startsWith('orch-tab:')) {
        act(h.action);
      } else if (h.action === 'orch-close') {
        orchestrate = null;
      } else if (h.action === 'orch-task-row') {
        orchestrate.taskRow = h.index;
      } else if (h.action === 'orch-effort') {
        orchestrate.taskRow = h.index;
        orchestrateKey(orchestrate, ' ', model);
      } else if (h.action === 'orch-model') {
        orchestrate.taskRow = h.index;
        orchestrateKey(orchestrate, '\r', model);
      } else if (h.action === 'orch-copy-spawn') {
        orchestrate.taskRow = h.index;
        orchestrateKey(orchestrate, 'c', model);
      } else if (h.action === 'orch-by') {
        orchestrate.by = h.by;
      } else if (h.action === 'orch-window') {
        orchestrate.windowIndex = h.index;
      } else if (h.action === 'orch-refresh-summary') {
        rebuildSummaryInPlace(orchestrate);
      }
      draw();
      return;
    }
    if (!h || edit || setup || orchestrate || headPicker) return;
    if (h.action !== 'row' && h.action !== 'jump') lastRowClick = null;
    if (typeof h.index === 'number' && model && model.rows[h.index]) {
      selected = h.index;
      selectedPane = model.rows[h.index].paneId;
    }
    if (h.action === 'tooltip') {
      flash(h.text, 4000);
      return;
    }
    if (h.action === 'copy-id') {
      const paneId = h.paneId || (model && model.rows[selected] && model.rows[selected].paneId);
      if (paneId) {
        copyToClipboard(paneId);
        notice = `copied ${paneId}`;
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => {
          notice = null;
          draw();
        }, 2000);
        draw();
      }
      return;
    }
    if (h.action === 'jump' || h.action === 'row') {
      const index = typeof h.index === 'number' ? h.index : model.rows.findIndex((r) => r.paneId === h.paneId);
      const row = model && model.rows[index];
      if (!row) return;
      const now = Date.now();
      const double = isDoubleClick(lastRowClick, row.paneId, now);
      lastRowClick = { paneId: row.paneId, at: now };
      selected = index;
      selectedPane = row.paneId;
      draw();
      if (double) herdr.focusAgent(row.paneId).catch(() => {});
      return;
    }
    if (h.action === 'fold') {
      if (!folded.delete(h.workspace)) folded.add(h.workspace);
      // Keep the selection on a row you can see.
      const row = model.rows[selected];
      if (row && folded.has(row.workspace)) {
        step(1);
        if (folded.has(model.rows[selected].workspace)) step(-1);
      }
      draw();
    } else act(h.action);
  };

  const quit = () => {
    clearInterval(timer);
    // Let the terminal restore reach stdout before the process goes.
    out.write('\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?7h\x1b[?1049l', () => process.exit(0));
  };

  // Alt screen, hidden cursor, and mouse click reporting (SGR encoding).
  // Autowrap off: a line that comes out a cell too wide (a symbol the
  // terminal draws wider than we count) is cut instead of scrolling the frame.
  out.write('\x1b]0;🐓ROOSTR🐓\x07\x1b]2;🐓ROOSTR🐓\x07\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[H\x1b[2J');
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  process.on('SIGHUP', quit);
  out.on('resize', draw);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (d) => {
      let k = d.toString();
      k = k.replace(MOUSE_RE, (all, b, x, y, kind) => {
        const btn = Number(b);
        if (kind === 'M' && btn === 0) onClick(Number(x), Number(y));
        else if (kind === 'M' && btn === 64 && !edit) step(-1);
        else if (kind === 'M' && btn === 65 && !edit && model) step(1);
        return '';
      });
      if (k === '') return;
      // While editing, the whole chunk is text: a paste must not press keys.
      // Otherwise typed text and pastes arrive whole, and keys and escape
      // sequences one by one.
      if (edit) onKey(k);
      else for (const key of k.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|[\s\S]/g)) onKey(key);
    });
  }
  if (opts.backups) backups = refreshBackups({ list: [], sel: 0, ver: 0, confirm: false, status: null, layout: 'even' });
  tick();
  timer = setInterval(tick, opts.interval * 1000);
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`roostr: ${e.message}\n\n${HELP}`);
    return Promise.resolve(2);
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return Promise.resolve(0);
  }
  // --crew names a file the board will run, so it gets the same ownership and
  // permission check as a file found by walking up.
  if (opts.crew && fs.existsSync(opts.crew) && !crewfile.safeToRun(opts.crew)) {
    process.stderr.write(`roostr: ${opts.crew} must be owned by you and not writable by group or others (chmod go-w ${opts.crew})\n`);
    return Promise.resolve(2);
  }
  if (opts.once || opts.json || !process.stdout.isTTY) {
    return runOnce(opts).catch((e) => {
      process.stderr.write(`roostr: ${e.message}\n`);
      return 1;
    });
  }
  runLive(opts);
  return new Promise(() => {});
}

module.exports = {
  saveMemory, loadMemory, TAGS, parseLabel, stripTag, assignTags, trackStatus, selectAgents, needsScreen, buildModel,
  render, toJson, toJsonRows, shortModel, fmtRam, banner, budgetState, trustCrews, fmtDuration, fmtTokens, fmtCost, parseArgs, main, HELP, collect, applyTags, sidebarTokens, editedLabel, editChunk, applyPrefs, crewResolver, MOUSE_RE, isDoubleClick, copyToClipboard, detailBox, providers, sourcesOf, providerOf, refreshBackups, findTokscale, optionsLines,
  setupState, setupLines, setupKey, setupReady, SETUP_ROWS, TASK_KIND_ROWS, headLines, surge, orchestrationEnabled,
  orchestrateState, orchestrateLines, orchestrateKey, daemonLines, discoverPlanDirs, loadPlanTasks, saveTaskOverride, ORCHESTRATE_TABS,
};
