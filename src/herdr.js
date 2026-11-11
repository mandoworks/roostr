'use strict';
// Every Herdr CLI call roostr makes lives in this file and nowhere else.
// Herdr's CLI is young, so keeping the surface in one place makes a breaking
// change a one file fix. Calls use execFile with an argv array (never a shell),
// so pane labels and ids are passed as data, not parsed as commands.

const { execFile } = require('child_process');

const TIMEOUT_MS = Number(process.env.HERDR_TIMEOUT_MS) || 10000;

function herdrBin() {
  return process.env.HERDR_BIN_PATH || 'herdr';
}

function run(args, timeout = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(herdrBin(), args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (!err) return resolve(stdout);
      if (err.code === 'ENOENT') {
        return reject(new Error('herdr not found on PATH (roostr runs inside Herdr)'));
      }
      reject(err);
    });
  });
}

async function runJson(args, timeout = TIMEOUT_MS) {
  const out = await run(args, timeout);
  const d = JSON.parse(out);
  if (d && d.error) throw new Error(d.error.message || 'herdr error');
  return d && d.result;
}

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function text(v) {
  return typeof v === 'string' ? v : null;
}

// One call returns agents, panes (with labels), and workspaces (with labels).
// Shape verified on herdr 0.9.1, protocol 22. Anything that is not a plain
// object with a string id is dropped, so a malformed snapshot cannot crash a
// row.
async function snapshot() {
  const r = await runJson(['api', 'snapshot']);
  const s = (r && r.snapshot) || {};
  const agents = (Array.isArray(s.agents) ? s.agents : [])
    .filter((a) => isObject(a) && typeof a.pane_id === 'string')
    .map((a) => ({ ...a, agent: text(a.agent) || '', cwd: text(a.cwd), terminal_id: text(a.terminal_id), pane_id: a.pane_id }));
  const panes = (Array.isArray(s.panes) ? s.panes : [])
    .filter((p) => isObject(p) && typeof p.pane_id === 'string')
    .map((p) => ({ ...p, cwd: text(p.cwd), label: text(p.label), terminal_id: text(p.terminal_id), pane_id: p.pane_id }));
  const workspaces = (Array.isArray(s.workspaces) ? s.workspaces : [])
    .filter((w) => isObject(w) && typeof w.workspace_id === 'string')
    .map((w) => ({ ...w, label: text(w.label), workspace_id: w.workspace_id }));
  // Tabs and each tab's split tree, for the workspace backups.
  const tabs = (Array.isArray(s.tabs) ? s.tabs : [])
    .filter((t) => isObject(t) && typeof t.tab_id === 'string')
    .map((t) => ({ ...t, label: text(t.label), tab_id: t.tab_id }));
  const layouts = (Array.isArray(s.layouts) ? s.layouts : [])
    .filter((l) => isObject(l) && typeof l.tab_id === 'string' && Array.isArray(l.panes))
    .map((l) => ({ ...l, splits: Array.isArray(l.splits) ? l.splits : [] }));
  return { agents, panes, workspaces, tabs, layouts };
}

// The visible screen of a pane as plain text. Adapters read its footer.
async function readPane(paneId) {
  return run(['pane', 'read', paneId, '--source', 'visible', '--format', 'text']);
}

// The pid of the shell a pane runs; everything the agent starts sits under it.
async function shellPid(paneId) {
  const r = await runJson(['pane', 'process-info', '--pane', paneId]);
  const pid = r && r.process_info && r.process_info.shell_pid;
  return Number.isInteger(pid) ? pid : null;
}

// Jump to an agent pane (switches workspace and tab if needed).
async function focusAgent(paneId) {
  await runJson(['agent', 'focus', paneId]);
}

async function focusWorkspace(workspaceId) {
  await runJson(['workspace', 'focus', workspaceId]);
}

async function renamePane(paneId, label) {
  await runJson(['pane', 'rename', paneId, label]);
}

// The agent's own name, separate from the pane label. The two are kept in
// step so the board row and the pane header agree.
async function renameAgent(target, name) {
  await runJson(['agent', 'rename', target, name]);
}

// The agent's own CLI session id, stored on the pane so a restore can resume
// the exact conversation. Herdr keeps it across a board restart.
async function reportAgentSession(paneId, kind, sessionId) {
  await run(['pane', 'report-agent-session', paneId, '--source', 'roostr', '--agent', kind, '--agent-session-id', sessionId]);
}

// Display only metadata. Herdr wants the pane id before the options.
async function setDisplayAgent(paneId, text) {
  await run(['pane', 'report-metadata', paneId, '--source', 'roostr', '--display-agent', text]);
}

async function clearDisplayAgent(paneId) {
  await run(['pane', 'report-metadata', paneId, '--source', 'roostr', '--clear-display-agent']);
}

// Sidebar tokens ($tag, $task, ...) for `ui.sidebar.agents.rows`. An empty
// value clears that token. They fade after ttlMs unless written again, so a
// board that stops leaves nothing stale behind.
async function setTokens(paneId, tokens, ttlMs) {
  const args = ['pane', 'report-metadata', paneId, '--source', 'roostr', '--ttl-ms', String(ttlMs)];
  for (const [k, v] of Object.entries(tokens)) args.push(...(v ? ['--token', `${k}=${v}`] : ['--clear-token', k]));
  await run(args);
}

async function clearTokens(paneId, names) {
  await run(['pane', 'report-metadata', paneId, '--source', 'roostr', ...names.flatMap((k) => ['--clear-token', k])]);
}

// ---- the toggle action: open, focus, or close the board's own pane

async function listPanes() {
  const r = await runJson(['pane', 'list']);
  return (r && Array.isArray(r.panes)) ? r.panes : [];
}

async function openBoard(entrypoint, split) {
  const pluginId = process.env.ROOSTR_PLUGIN_ID || process.env.CREW_BOARD_PLUGIN_ID || 'roostr';
  const args = ['plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', entrypoint, '--focus'];
  if (split) args.push('--placement', 'split', '--direction', 'right');
  try {
    await run(args);
  } catch (e) {
    if (pluginId === 'roostr') {
      const fallbackArgs = ['plugin', 'pane', 'open', '--plugin', 'crew-board', '--entrypoint', entrypoint, '--focus'];
      if (split) fallbackArgs.push('--placement', 'split', '--direction', 'right');
      await run(fallbackArgs);
    } else {
      throw e;
    }
  }
}

async function focusBoard(paneId) {
  await run(['plugin', 'pane', 'focus', paneId]);
}

async function closeBoard(paneId) {
  await run(['plugin', 'pane', 'close', paneId]);
}

// Close a pane. Used to remove a pane whose agent failed to start, so a
// failed restore leaves no empty split behind.
async function closePane(paneId) {
  await run(['pane', 'close', paneId]);
}

// Close a workspace and every pane in it.
async function closeWorkspace(workspaceId) {
  await run(['workspace', 'close', workspaceId]);
}

// Rename a workspace.
async function renameWorkspace(workspaceId, label) {
  await run(['workspace', 'rename', workspaceId, label]);
}

// Create a workspace.
async function createWorkspace(label, cwd, noFocus = true) {
  const args = ['workspace', 'create'];
  if (label) args.push('--label', label);
  if (cwd) args.push('--cwd', cwd);
  if (noFocus) args.push('--no-focus');
  const res = await runJson(args);
  const ws = res && res.workspace;
  const root = res && res.root_pane;
  const tab = res && res.tab;
  return {
    workspaceId: (ws && ws.workspace_id) || null,
    rootPaneId: (root && root.pane_id) || null,
    tabId: (tab && tab.tab_id) || null,
  };
}
async function createTab(workspaceId, cwd, label) {
  const args = ['tab', 'create', '--workspace', workspaceId, '--no-focus'];
  if (cwd) args.push('--cwd', cwd);
  if (label) args.push('--label', label);
  const res = await runJson(args);
  return {
    tabId: (res && res.tab && res.tab.tab_id) || null,
    rootPaneId: (res && res.root_pane && res.root_pane.pane_id) || null,
  };
}
async function renameTab(tabId, label) {
  await runJson(['tab', 'rename', tabId, label]);
}

// Split a pane.
async function splitPane(paneId, direction = 'right', cwd = null, noFocus = true, ratio = null) {
  const args = ['pane', 'split', paneId, '--direction', direction];
  if (typeof ratio === 'number' && ratio > 0 && ratio < 1) args.push('--ratio', String(ratio));
  if (cwd) args.push('--cwd', cwd);
  if (noFocus) args.push('--no-focus');
  const res = await runJson(args);
  const pane = res && res.pane;
  return (pane && pane.pane_id) || null;
}

// Start a supported agent in an existing pane. Startup waits for the agent to
// become ready, so it gets longer than a read call.
async function startAgent(name, kind, paneId, args = []) {
  const cmd = ['agent', 'start', name, '--kind', kind, '--pane', paneId];
  if (args && args.length) cmd.push('--', ...args);
  await run(cmd, 45 * 1000);
}

// Submit a prompt to an agent pane.
async function promptAgent(paneId, text) {
  await run(['agent', 'prompt', paneId, text]);
}

async function sendKeys(paneId, keys) {
  await run(['pane', 'send-keys', paneId, ...(Array.isArray(keys) ? keys : [keys])]);
}

// Install (or update to) a release of a plugin from GitHub. A clone takes a
// while, so this gets two minutes.
async function installPlugin(repo, version) {
  await run(['plugin', 'install', repo, '--ref', `v${version}`, '-y'], 2 * 60 * 1000);
}

module.exports = {
  run, installPlugin, snapshot, readPane, shellPid, focusAgent, renamePane, renameAgent, setDisplayAgent, clearDisplayAgent, reportAgentSession, setTokens, clearTokens, listPanes, openBoard, focusBoard, closeBoard, splitPane, startAgent, promptAgent, sendKeys, closePane, closeWorkspace, renameWorkspace, createWorkspace, createTab, renameTab, focusWorkspace,
};
