'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CLI_TIMEOUT_MS = 15000;
const WORKSPACE_RE = /^[A-Za-z0-9_ -]{1,64}$/;
const BACKUP_LAYOUTS = new Set(['even', 'saved', 'columns', 'rows']);

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readSavedSessions(roostrStateDir) {
  if (!roostrStateDir) return [];
  const raw = readJsonSafe(path.join(roostrStateDir, 'sessions.json'));
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
}

function collectTreePanes(node, out) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.pane === 'string' && node.pane) {
    out.push({ paneId: node.pane });
    return;
  }
  if (node.a) collectTreePanes(node.a, out);
  if (node.b) collectTreePanes(node.b, out);
}

function extractBackupPanes(doc) {
  if (Array.isArray(doc.panes)) {
    return doc.panes.filter((p) => p && typeof p === 'object');
  }
  const panes = [];
  if (Array.isArray(doc.tabs)) {
    for (const tab of doc.tabs) {
      if (tab && tab.tree) {
        collectTreePanes(tab.tree, panes);
      }
    }
  }
  return panes;
}

function parseVersionFromName(filename) {
  const vMatch = /^v(\d+)\.json$/.exec(filename);
  if (vMatch) return Number.parseInt(vMatch[1], 10);
  const tsMatch = /^(\d+)\.json$/.exec(filename);
  if (tsMatch) return Number.parseInt(tsMatch[1], 10);
  return null;
}

function readBackups(roostrStateDir) {
  if (!roostrStateDir) return [];
  const backupsDir = path.join(roostrStateDir, 'backups');
  let entries;
  try {
    entries = fs.readdirSync(backupsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wsDir = path.join(backupsDir, entry.name);
    let files;
    try {
      files = fs.readdirSync(wsDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!/^(?:v\d+|\d+)\.json$/.test(file)) continue;
      const doc = readJsonSafe(path.join(wsDir, file));
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
      const panes = extractBackupPanes(doc);
      results.push({
        workspaceId: typeof doc.workspaceId === 'string' ? doc.workspaceId : entry.name,
        label: typeof doc.label === 'string' ? doc.label : null,
        version: Number.isFinite(doc.version) ? doc.version : parseVersionFromName(file),
        capturedAt: typeof doc.capturedAt === 'string'
          ? doc.capturedAt
          : (typeof doc.savedAt === 'string' ? doc.savedAt : null),
        paneCount: panes.length,
        panes,
      });
    }
  }

  results.sort((a, b) => {
    const ta = a.capturedAt ? Date.parse(a.capturedAt) || 0 : 0;
    const tb = b.capturedAt ? Date.parse(b.capturedAt) || 0 : 0;
    if (tb !== ta) return tb - ta;
    return (b.version || 0) - (a.version || 0);
  });

  return results;
}

function listMarkdownFiles(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const fullPath = path.join(dirPath, entry.name);
    let updatedAt = null;
    try {
      updatedAt = fs.statSync(fullPath).mtime.toISOString();
    } catch {
      updatedAt = null;
    }
    files.push({
      name: entry.name.replace(/\.md$/, ''),
      file: entry.name,
      updatedAt,
    });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return files;
}

function readOrchestration(roostrRepoDir) {
  if (!roostrRepoDir) {
    return { plan: null, tasks: [], handoffs: [], reports: [] };
  }
  const orchDir = path.join(roostrRepoDir, 'docs', 'orchestration');
  const tasksDoc = readJsonSafe(path.join(orchDir, 'tasks.json'));
  const plan = tasksDoc && typeof tasksDoc.plan === 'string' ? tasksDoc.plan : null;
  const tasks = tasksDoc && Array.isArray(tasksDoc.tasks) ? tasksDoc.tasks : [];
  const handoffs = listMarkdownFiles(path.join(orchDir, 'handoffs'));
  const reports = listMarkdownFiles(path.join(orchDir, 'reports'));
  return { plan, tasks, handoffs, reports };
}

function getRecoverySnapshot({ roostrStateDir, roostrRepoDir } = {}) {
  return {
    sessions: readSavedSessions(roostrStateDir),
    backups: readBackups(roostrStateDir),
    orchestration: readOrchestration(roostrRepoDir),
  };
}

function execFileAsync(execFileImpl, bin, args, opts) {
  const fn = execFileImpl || execFile;
  return new Promise((resolve) => {
    fn(bin, args, opts, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function extractErrorLine(err, stderr) {
  const line = String(stderr || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line || (err && err.message) || 'command failed';
}

async function captureBackups({ roostrRepoDir, roostrStateDir, execFileImpl } = {}) {
  if (!roostrRepoDir) {
    return { ok: false, status: 502, error: 'roostrRepoDir not configured' };
  }
  const binPath = path.join(roostrRepoDir, 'bin', 'roostr');
  const env = {
    ...process.env,
    ...(roostrStateDir ? { ROOSTR_STATE_DIR: roostrStateDir } : {}),
  };
  const { err, stdout, stderr } = await execFileAsync(
    execFileImpl,
    process.execPath,
    [binPath, 'backups', 'capture', '--json'],
    { timeout: CLI_TIMEOUT_MS, env }
  );
  if (err) {
    return { ok: false, status: 502, error: extractErrorLine(err, stderr) };
  }
  try {
    const parsed = JSON.parse(String(stdout || '').trim() || '{}');
    return { ok: true, captured: parsed };
  } catch {
    return { ok: false, status: 502, error: 'invalid JSON from roostr backups capture' };
  }
}

async function restoreWorkspace({
  roostrRepoDir,
  roostrStateDir,
  workspace,
  mode,
  version,
  layout,
  execFileImpl,
} = {}) {
  const ws = typeof workspace === 'string' ? workspace.trim() : '';
  if (!ws || !WORKSPACE_RE.test(ws) || ws.startsWith('-')) {
    return { ok: false, status: 400, error: 'invalid workspace' };
  }

  const resolvedMode = (mode === undefined || mode === null || mode === '') ? 'sessions' : mode;
  if (resolvedMode !== 'sessions' && resolvedMode !== 'backup') {
    return { ok: false, status: 400, error: 'invalid restore mode' };
  }

  let versionArg = null;
  let layoutArg = null;
  if (resolvedMode === 'backup') {
    if (version !== undefined && version !== null && version !== '') {
      const vStr = String(version).trim();
      if (!/^\d+$/.test(vStr) || Number.parseInt(vStr, 10) < 1) {
        return { ok: false, status: 400, error: 'invalid version' };
      }
      versionArg = vStr;
    }
    if (layout !== undefined && layout !== null && layout !== '') {
      if (typeof layout !== 'string' || !BACKUP_LAYOUTS.has(layout)) {
        return { ok: false, status: 400, error: 'invalid layout' };
      }
      layoutArg = layout;
    }
  }

  if (!roostrRepoDir) {
    return { ok: false, status: 502, error: 'roostrRepoDir not configured' };
  }

  const binPath = path.join(roostrRepoDir, 'bin', 'roostr');
  const env = {
    ...process.env,
    ...(roostrStateDir ? { ROOSTR_STATE_DIR: roostrStateDir } : {}),
  };

  if (resolvedMode === 'backup') {
    const args = [binPath, 'backups', 'restore', ws, '--yes'];
    if (versionArg) args.push('--version', versionArg);
    if (layoutArg) args.push('--layout', layoutArg);
    const { err, stdout, stderr } = await execFileAsync(
      execFileImpl,
      process.execPath,
      args,
      { timeout: CLI_TIMEOUT_MS, env }
    );
    if (err) {
      return { ok: false, status: 502, error: extractErrorLine(err, stderr) };
    }
    return { ok: true, mode: 'backup', output: String(stdout || '').trim() };
  }

  const { err, stdout, stderr } = await execFileAsync(
    execFileImpl,
    process.execPath,
    [binPath, 'restore', '--workspace', ws, '--yes', '--json'],
    { timeout: CLI_TIMEOUT_MS, env }
  );
  if (err) {
    return { ok: false, status: 502, error: extractErrorLine(err, stderr) };
  }
  const trimmed = String(stdout || '').trim();
  let result = {};
  if (trimmed) {
    try {
      result = JSON.parse(trimmed);
    } catch {
      return { ok: false, status: 502, error: 'invalid JSON from roostr restore' };
    }
  }
  return { ok: true, mode: 'sessions', result };
}

module.exports = {
  readSavedSessions,
  readBackups,
  readOrchestration,
  getRecoverySnapshot,
  captureBackups,
  restoreWorkspace,
};
