'use strict';

const fs = require('fs');
const path = require('path');

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

module.exports = {
  readSavedSessions,
  readBackups,
  readOrchestration,
  getRecoverySnapshot,
};
