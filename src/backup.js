'use strict';
// Workspace backups: one folder per workspace under ~/.crew-board/backups,
// holding the last few versions of its layout. A version records every tab,
// each tab's split tree (direction and ratio), every pane's directory and
// label, and for agent panes the kind, name, task, effort, exact model and
// session id. Restoring a version builds a new workspace named
// "<label> *restored" with the same tabs, splits and agents; the old
// workspace is never touched.
//
//   crew-board backups [--json]                         list the backups
//   crew-board backups show <label|id> [--version N]    print one version
//   crew-board backups restore <label|id> [--version N] [--yes]

const fs = require('fs');
const os = require('os');
const path = require('path');
const sessions = require('./sessions');
const ui = require('./ui');

const KEEP = 4;
const SUFFIX = ' *restored';
// How a restored tab is laid out. `even` aims for equal pane areas, `saved`
// rebuilds the recorded split tree, `columns` and `rows` put every pane in one
// line. Restoring defaults to `even` so a cramped backup does not come back
// cramped.
const LAYOUTS = ['even', 'saved', 'columns', 'rows'];
const USAGE = 'usage: roostr backups [--json] | backups show <label|id> [--version N] | backups restore <label|id> [--version N] [--layout even|saved|columns|rows] [--yes]';

function backupsDir(dir) {
  if (dir) return dir;
  if (process.env.ROOSTR_STATE_DIR) return path.join(process.env.ROOSTR_STATE_DIR, 'backups');
  if (process.env.CREW_BOARD_STATE_DIR) return path.join(process.env.CREW_BOARD_STATE_DIR, 'backups');
  const roostr = path.join(os.homedir(), '.roostr', 'backups');
  const legacy = path.join(os.homedir(), '.crew-board', 'backups');
  if (fs.existsSync(roostr) || !fs.existsSync(legacy)) return roostr;
  return legacy;
}

function str(v, max = 240) {
  return typeof v === 'string' && v.trim() ? ui.clean(v).trim().slice(0, max) : null;
}

function sameRect(a, b) {
  return a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

// Pane rects -> split tree. Herdr layouts are guillotine cuts: at each level
// one straight line separates every pane into a first and a second part. The
// split Herdr reports for the same rect gives the exact direction and ratio.
// Returns { pane } | { dir, ratio, a, b }, or null for a shape it cannot cut.
function layoutTree(panes, rect, splits = []) {
  if (!panes.length) return null;
  if (panes.length === 1) return { pane: panes[0].pane_id };
  const known = splits.find((s) => sameRect(s.rect, rect));
  const dirs = known && known.direction === 'down' ? ['down', 'right'] : ['right', 'down'];
  for (const dir of dirs) {
    const pos = dir === 'right' ? 'x' : 'y';
    const size = dir === 'right' ? 'width' : 'height';
    const cuts = [...new Set(panes.map((p) => p.rect[pos]))].filter((v) => v > rect[pos]).sort((x, y) => x - y);
    for (const cut of cuts) {
      const a = panes.filter((p) => p.rect[pos] + p.rect[size] <= cut);
      const b = panes.filter((p) => p.rect[pos] >= cut);
      if (!a.length || !b.length || a.length + b.length !== panes.length) continue;
      const ra = { ...rect, [size]: cut - rect[pos] };
      const rb = { ...rect, [pos]: cut, [size]: rect[pos] + rect[size] - cut };
      const ta = layoutTree(a, ra, splits);
      const tb = layoutTree(b, rb, splits);
      if (!ta || !tb) continue;
      const ratio = known && known.direction === dir && typeof known.ratio === 'number'
        ? known.ratio
        : (cut - rect[pos]) / rect[size];
      return { dir, ratio: Math.round(ratio * 1000) / 1000, a: ta, b: tb };
    }
  }
  return null;
}

function leaves(node, out = []) {
  if (!node) return out;
  if (node.pane) out.push(node.pane);
  else {
    leaves(node.a, out);
    leaves(node.b, out);
  }
  return out;
}

// A layout Herdr reported without usable rects: the panes side by side.
function chain(ids) {
  if (ids.length === 1) return { pane: ids[0] };
  return { dir: 'right', ratio: Math.round(1000 / ids.length) / 1000, a: { pane: ids[0] }, b: chain(ids.slice(1)) };
}

// Equal split along one axis: each step takes 1/n of the space that is left,
// so every leaf ends with the same width (columns) or height (rows).
function relay(ids, dir) {
  if (ids.length === 1) return { pane: ids[0] };
  return {
    dir,
    ratio: Math.round((1 / ids.length) * 10000) / 10000,
    a: { pane: ids[0] },
    b: relay(ids.slice(1), dir),
  };
}

// Balanced grid. Rows are cut down the height in proportion to how many panes
// they hold, and each row is cut across in equal widths, so every pane gets
// about the same area whatever the pane count.
function grid(ids) {
  const n = ids.length;
  if (!n) return null;
  if (n === 1) return { pane: ids[0] };
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const base = Math.floor(n / rows);
  const extra = n % rows;
  const groups = [];
  let k = 0;
  for (let i = 0; i < rows; i++) {
    const size = base + (i < extra ? 1 : 0);
    groups.push(ids.slice(k, k + size));
    k += size;
  }
  const build = (arr) => {
    if (arr.length === 1) return relay(arr[0], 'right');
    const total = arr.reduce((sum, g) => sum + g.length, 0);
    return {
      dir: 'down',
      ratio: Math.round((arr[0].length / total) * 10000) / 10000,
      a: relay(arr[0], 'right'),
      b: build(arr.slice(1)),
    };
  };
  return build(groups);
}

// The tree a tab should be restored with. `saved` keeps the recorded shape,
// every other preset is generated from the saved pane order.
function treeFor(tab, layout = 'even') {
  const ids = tab.panes.map((p) => p.paneId);
  const saved = tab.tree ? leaves(tab.tree) : [];
  if (layout === 'saved' && tab.tree && saved.length === ids.length) return tab.tree;
  if (layout === 'columns') return relay(ids, 'right');
  if (layout === 'rows') return relay(ids, 'down');
  return grid(ids);
}

// Board model (with model.snapshot attached) -> one backup per workspace that
// has at least one agent pane. A workspace of plain shells is not backed up.
function capture(model, now = Date.now()) {
  const snap = model && model.snapshot;
  if (!snap || !Array.isArray(snap.panes)) return [];
  const agentsByPane = new Map(sessions.extractSessions(model).filter((s) => s.agent).map((s) => [s.paneId, s]));
  const layouts = new Map((snap.layouts || []).map((l) => [l.tab_id, l]));
  const out = [];
  for (const w of snap.workspaces || []) {
    const tabs = (snap.tabs || []).filter((t) => t.workspace_id === w.workspace_id)
      .sort((a, b) => (a.number || 0) - (b.number || 0));
    const panes = snap.panes.filter((p) => p.workspace_id === w.workspace_id);
    if (!panes.some((p) => agentsByPane.has(p.pane_id))) continue;
    const savedTabs = [];
    for (const t of tabs) {
      const tabPanes = panes.filter((p) => p.tab_id === t.tab_id);
      if (!tabPanes.length) continue;
      const lay = layouts.get(t.tab_id);
      const rects = lay && !lay.zoomed ? lay.panes.filter((p) => p && p.rect && tabPanes.some((x) => x.pane_id === p.pane_id)) : [];
      let tree = rects.length === tabPanes.length ? layoutTree(rects, lay.area || rects[0].rect, lay.splits) : null;
      if (!tree) tree = chain(tabPanes.map((p) => p.pane_id));
      const byId = new Map(tabPanes.map((p) => [p.pane_id, p]));
      savedTabs.push({
        label: str(t.label),
        focused: t.tab_id === w.active_tab_id,
        tree,
        panes: leaves(tree).map((id) => {
          const p = byId.get(id) || {};
          const a = agentsByPane.get(id);
          const pane = { paneId: id, cwd: str(p.cwd, 1024), label: str(p.label) };
          if (a) {
            pane.agent = {
              // An unnamed pane is saved under its pane id, which means nothing later.
              kind: a.agent, name: a.name && a.name !== id ? a.name : null, task: a.task, effort: a.effort,
              model: a.model, modelSrc: a.modelSrc, session: a.session,
            };
          }
          return pane;
        }),
      });
    }
    if (!savedTabs.length) continue;
    out.push({
      version: 1,
      workspaceId: w.workspace_id,
      label: str(w.label) || w.workspace_id,
      savedAt: new Date(now).toISOString(),
      tabs: savedTabs,
    });
  }
  return out;
}

// What makes a new version: the tabs, the split shape and each pane's
// directory, agent kind and session. A new task line or name only refreshes
// the newest version, so 4 versions are 4 real layouts, not 4 title changes.
function shapeKey(b) {
  const shape = (n) => (n.pane ? 'p' : [n.dir, Math.round(n.ratio * 20), shape(n.a), shape(n.b)]);
  return JSON.stringify(b.tabs.map((t) => [shape(t.tree), t.panes.map((p) => [p.cwd, p.agent ? p.agent.kind : null, p.agent ? p.agent.session : null])]));
}

function body(b) {
  const { savedAt, ...rest } = b;
  return JSON.stringify(rest);
}

function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}

function versionFiles(folder) {
  try {
    return fs.readdirSync(folder).filter((f) => /^\d+\.json$/.test(f)).sort().reverse();
  } catch (e) {
    return [];
  }
}

function readJson(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d === 'object' && Array.isArray(d.tabs) ? d : null;
  } catch (e) {
    return null;
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Save each workspace backup. Returns the number of files written.
function saveBackups(list, options = {}) {
  const root = backupsDir(options.dir);
  const keep = options.keep || KEEP;
  const now = typeof options.now === 'number' ? options.now : Date.now();
  let written = 0;
  for (const b of list) {
    const folder = path.join(root, safeName(b.workspaceId));
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const files = versionFiles(folder);
    const latest = files.length ? readJson(path.join(folder, files[0])) : null;
    if (latest && body(latest) === body(b)) continue;
    const text = JSON.stringify(b, null, 2) + '\n';
    if (latest && shapeKey(latest) === shapeKey(b)) {
      writeAtomic(path.join(folder, files[0]), text);
    } else {
      let stamp = now;
      while (files.includes(`${stamp}.json`)) stamp++;
      writeAtomic(path.join(folder, `${stamp}.json`), text);
      for (const old of [`${stamp}.json`, ...files].slice(keep)) {
        try { fs.unlinkSync(path.join(folder, old)); } catch (e) { /* already gone */ }
      }
    }
    written++;
  }
  return written;
}

function counts(b) {
  const panes = b.tabs.reduce((n, t) => n + t.panes.length, 0);
  const agents = b.tabs.reduce((n, t) => n + t.panes.filter((p) => p.agent).length, 0);
  return { tabs: b.tabs.length, panes, agents };
}

// A backup with only the chosen pane ids. Tabs that lose every pane go away,
// so a partial restore does not open empty splits.
function subset(b, ids) {
  const keep = new Set(Array.isArray(ids) ? ids : []);
  const tabs = b.tabs
    .map((t) => ({ ...t, panes: t.panes.filter((p) => keep.has(p.paneId)) }))
    .filter((t) => t.panes.length);
  return { ...b, tabs };
}

// -> [{ workspaceId, label, versions: [{ file, savedAt, backup }] }], the
// workspace saved most recently first, each one's newest version first.
function listBackups(dir) {
  const root = backupsDir(dir);
  let folders = [];
  try {
    folders = fs.readdirSync(root);
  } catch (e) {
    return [];
  }
  const out = [];
  for (const f of folders) {
    const folder = path.join(root, f);
    const versions = versionFiles(folder)
      .map((file) => ({ file: path.join(folder, file), backup: readJson(path.join(folder, file)) }))
      .filter((v) => v.backup)
      .map((v) => ({ ...v, savedAt: v.backup.savedAt }));
    if (!versions.length) continue;
    out.push({ workspaceId: versions[0].backup.workspaceId, label: versions[0].backup.label, versions });
  }
  return out.sort((a, b) => String(b.versions[0].savedAt).localeCompare(String(a.versions[0].savedAt)));
}

function findBackup(list, key) {
  return list.find((b) => b.workspaceId === key)
    || list.find((b) => String(b.label).toLowerCase() === String(key).toLowerCase())
    || null;
}

function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '?';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Herdr names an unnamed tab by its number; that is not worth restoring.
function namedTab(label) {
  return Boolean(label) && !/^\d+$/.test(label);
}

function hasDown(n) {
  return Boolean(n && !n.pane && (n.dir === 'down' || hasDown(n.a) || hasDown(n.b)));
}

function paneTitle(p) {
  if (p.agent) return p.agent.name ? `${p.agent.name} (${p.agent.kind})` : String(p.agent.kind);
  return p.label || 'shell';
}

// Draw a tab's split tree into a w x h box of characters, each pane framed
// with its title inside, so the stored layout can be checked by eye.
function drawTree(tree, panes, w, h) {
  const grid = Array.from({ length: h }, () => Array(w).fill(' '));
  const byId = new Map(panes.map((p) => [p.paneId, p]));
  const box = (x, y, bw, bh, title) => {
    if (bw < 2 || bh < 2) return;
    for (let i = x; i < x + bw; i++) {
      grid[y][i] = '─';
      grid[y + bh - 1][i] = '─';
    }
    for (let j = y; j < y + bh; j++) {
      grid[j][x] = '│';
      grid[j][x + bw - 1] = '│';
    }
    grid[y][x] = '┌';
    grid[y][x + bw - 1] = '┐';
    grid[y + bh - 1][x] = '└';
    grid[y + bh - 1][x + bw - 1] = '┘';
    const text = Array.from(ui.truncate(title, Math.max(0, bw - 2)));
    if (bh > 2) text.forEach((ch, i) => { grid[y + Math.floor((bh - 1) / 2)][x + 1 + i] = ch; });
  };
  const walk = (n, x, y, bw, bh) => {
    if (n.pane) {
      box(x, y, bw, bh, paneTitle(byId.get(n.pane) || {}));
      return;
    }
    if (n.dir === 'right') {
      const aw = Math.max(3, Math.min(bw - 3, Math.round(bw * n.ratio)));
      walk(n.a, x, y, aw, bh);
      walk(n.b, x + aw, y, bw - aw, bh);
    } else {
      // At least 3 rows a pane, so even a thin strip shows its title.
      const ah = Math.max(3, Math.min(bh - 3, Math.round(bh * n.ratio)));
      walk(n.a, x, y, bw, ah);
      walk(n.b, x, y + ah, bw, bh - ah);
    }
  };
  walk(tree, 0, 0, w, h);
  return grid.map((r) => r.join(''));
}

// One version, as plain lines: per tab the drawn layout, then every pane. The
// drawing follows the layout preset the restore will use.
function previewLines(b, width = 100, now = Date.now(), layout = 'saved') {
  const c = counts(b);
  const lines = [`${b.label} (${b.workspaceId}) · saved ${ago(b.savedAt, now)} · ${c.tabs} tab${c.tabs === 1 ? '' : 's'}, ${c.panes} pane${c.panes === 1 ? '' : 's'}, ${c.agents} agent${c.agents === 1 ? '' : 's'}`];
  const home = os.homedir();
  b.tabs.forEach((t, i) => {
    lines.push('');
    lines.push(`tab ${i + 1}${namedTab(t.label) ? ` · ${t.label}` : ''}${t.focused ? ' · active' : ''}`);
    const w = Math.max(20, Math.min(width - 2, 100));
    const tree = treeFor(t, layout) || t.tree;
    const h = hasDown(tree) ? 13 : 5;
    for (const row of drawTree(tree, t.panes, w, h)) lines.push(`  ${row}`);
    for (const p of t.panes) {
      const dir = (p.cwd || '?').replace(home, '~');
      if (p.agent) {
        const a = p.agent;
        const bits = a.name ? [a.kind, a.name] : [a.kind];
        if (a.task) bits.push(a.task);
        const extra = [];
        if (a.session) extra.push(sessions.validSession(a.kind, a.session) ? 'resumes' : 'session ignored');
        if (a.model && a.modelSrc === 'exact') extra.push(a.model);
        if (a.effort) extra.push(`effort ${a.effort}`);
        lines.push(`  ${ui.truncate(`● ${bits.join(' · ')}${extra.length ? ` [${extra.join(', ')}]` : ''} ${dir}`, width - 2)}`);
      } else {
        lines.push(`  ${ui.truncate(`○ shell${p.label ? ` · ${p.label}` : ''} ${dir}`, width - 2)}`);
      }
    }
  });
  return lines;
}

// Build a new workspace from one version. Returns { workspaceId, label,
// panes, agents, sessions, errors }, where `sessions` lists the agents whose
// saved conversation was resumed. Every step that fails is reported and
// skipped; panes already made stay so nothing half built disappears silently.
async function restoreBackup(b, options = {}) {
  const herdr = options.herdr || require('./herdr');
  const taken = new Set(options.taken || []);
  const layout = LAYOUTS.includes(options.layout) ? options.layout : 'even';
  const errors = [];
  const label = `${b.label}${SUFFIX}`;
  const firstCwd = (t) => (t.panes[0] && t.panes[0].cwd) || null;
  const made = new Map(); // saved pane id -> new pane id
  let workspaceId = null;

  // A pane that died before its session was captured has no id. Ask the
  // agent's own session store before starting it, so a restore can still
  // resume the conversation instead of opening a blank one.
  if (options.resolveSessions !== false) {
    const pending = [];
    for (const t of b.tabs) {
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
    } catch (e) { /* resolution is best effort; a blank session still opens */ }
  }

  const build = async (node, paneId, byId) => {
    if (node.pane) {
      made.set(node.pane, paneId);
      return;
    }
    const first = leaves(node.b)[0];
    let next = null;
    try {
      next = await herdr.splitPane(paneId, node.dir, (byId.get(first) || {}).cwd || null, true, node.ratio);
    } catch (e) {
      errors.push(`split for ${paneTitle(byId.get(first) || {})}: ${e.message}`);
    }
    await build(node.a, paneId, byId);
    if (next) await build(node.b, next, byId);
  };

  for (let i = 0; i < b.tabs.length; i++) {
    const t = b.tabs[i];
    let root = null;
    let tabId = null;
    try {
      if (i === 0) {
        const ws = await herdr.createWorkspace(label, firstCwd(t), true);
        workspaceId = ws.workspaceId;
        root = ws.rootPaneId;
        tabId = ws.tabId;
        if (tabId && namedTab(t.label)) await herdr.renameTab(tabId, t.label).catch(() => {});
      } else {
        const tab = await herdr.createTab(workspaceId, firstCwd(t), namedTab(t.label) ? t.label : null);
        root = tab.rootPaneId;
      }
    } catch (e) {
      errors.push(i === 0 ? `create workspace ${label}: ${e.message}` : `create tab ${i + 1}: ${e.message}`);
      if (i === 0) return { workspaceId: null, label, layout, panes: 0, agents: 0, sessions: [], errors };
      continue;
    }
    if (!root) {
      errors.push(`tab ${i + 1}: Herdr gave no pane`);
      continue;
    }
    await build(treeFor(t, layout), root, new Map(t.panes.map((p) => [p.paneId, p])));
  }

  let agents = 0;
  const startedSessions = [];
  for (const t of b.tabs) {
    for (const p of t.panes) {
      const paneId = made.get(p.paneId);
      if (!paneId) continue;
      if (!p.agent) {
        if (p.label) await herdr.renamePane(paneId, p.label).catch(() => {});
        continue;
      }
      const a = p.agent;
      const name = sessions.agentName(a.name || a.kind, taken);
      taken.add(name);
      const session = sessions.validSession(a.kind, a.session) ? a.session : null;
      try {
        await herdr.startAgent(name, a.kind, paneId, sessions.agentArgs({ ...a, agent: a.kind }));
        agents++;
        if (session) startedSessions.push({ paneId, name, agent: a.kind, session });
        await herdr.renamePane(paneId, a.task ? `${name} · ${a.task}` : name).catch(() => {});
      } catch (e) {
        errors.push(`start ${name} (${a.kind}): ${e.message}`);
      }
    }
  }
  return { workspaceId, label, layout, panes: made.size, agents, sessions: startedSessions, errors };
}

function parseArgs(argv) {
  const o = { cmd: 'list', key: null, version: 1, yes: false, json: false, dir: null, layout: 'even' };
  const rest = [...argv];
  if (rest[0] === 'show' || rest[0] === 'restore' || rest[0] === 'list') o.cmd = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') o.json = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--version' || a === '-v') {
      const n = Number(rest[++i]);
      if (!Number.isInteger(n) || n < 1) return { error: '--version needs a number from 1 (newest)' };
      o.version = n;
    } else if (a === '--layout') {
      const v = rest[++i];
      if (!LAYOUTS.includes(v)) return { error: `--layout must be one of: ${LAYOUTS.join(', ')}` };
      o.layout = v;
    } else if (a === '--dir') {
      o.dir = rest[++i];
      if (!o.dir) return { error: '--dir needs a path' };
    } else if (!a.startsWith('-') && !o.key) o.key = a;
    else return { error: `unknown option ${a}` };
  }
  if (o.cmd !== 'list' && !o.key) return { error: `${o.cmd} needs a workspace label or id` };
  return o;
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
    err.write(`roostr backups: ${o.error}\n${USAGE}\n`);
    return 2;
  }
  const list = listBackups(o.dir);
  if (o.cmd === 'list') {
    if (o.json) {
      out.write(JSON.stringify(list.map((b) => ({
        workspaceId: b.workspaceId, label: b.label,
        versions: b.versions.map((v) => ({ savedAt: v.savedAt, ...counts(v.backup) })),
      })), null, 2) + '\n');
    } else if (!list.length) {
      out.write('No backups yet. A running board saves one for every workspace with an agent.\n');
    } else {
      for (const b of list) {
        const c = counts(b.versions[0].backup);
        out.write(`${b.label} (${b.workspaceId})  ${c.tabs} tabs, ${c.panes} panes, ${c.agents} agents  · ${b.versions.map((v) => ago(v.savedAt)).join(', ')}\n`);
      }
    }
    return 0;
  }
  const found = findBackup(list, o.key);
  if (!found) {
    err.write(`roostr backups: no backup for ${o.key}\n`);
    return 1;
  }
  const v = found.versions[o.version - 1];
  if (!v) {
    err.write(`roostr backups: ${found.label} has ${found.versions.length} version${found.versions.length === 1 ? '' : 's'}\n`);
    return 1;
  }
  if (o.cmd === 'show' || !o.yes) {
    out.write(previewLines(v.backup, out.columns || 100, undefined, o.cmd === 'restore' ? o.layout : 'saved').join('\n') + '\n');
    if (o.cmd === 'restore') out.write(`\nRun again with --yes to build "${v.backup.label}${SUFFIX}" (layout: ${o.layout}).\n`);
    return 0;
  }
  const herdr = options.herdr || require('./herdr');
  let taken = [];
  try {
    taken = (await herdr.snapshot()).agents.map((a) => a.name).filter(Boolean);
  } catch (e) { /* names stay as saved */ }
  const r = await restoreBackup(v.backup, { herdr, taken, layout: o.layout, opencodeBin: o.opencodeBin });
  if (o.json) out.write(JSON.stringify(r, null, 2) + '\n');
  else {
    out.write(`Built ${r.label}${r.workspaceId ? ` (${r.workspaceId})` : ''}: ${r.panes} panes, ${r.agents} agents started, ${r.sessions.length} session${r.sessions.length === 1 ? '' : 's'} resumed.\n`);
    for (const s of r.sessions) out.write(`  resumed: ${s.name} (${s.agent}) · ${s.session}\n`);
    for (const e of r.errors) out.write(`  failed: ${e}\n`);
  }
  return r.errors.length ? 1 : 0;
}

module.exports = {
  KEEP, SUFFIX, LAYOUTS, USAGE, backupsDir, layoutTree, leaves, chain, relay, grid, treeFor,
  capture, shapeKey, saveBackups, listBackups, subset,
  findBackup, counts, drawTree, previewLines, restoreBackup, parseArgs, main,
};
