'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = require('../src/session-log');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-log-'));
const prevAgyDir = process.env.ROOSTR_AGY_BRAIN_DIR;
const prevClaudeDir = process.env.ROOSTR_CLAUDE_PROJECTS_DIR;
process.env.ROOSTR_AGY_BRAIN_DIR = path.join(dir, 'empty-agy');
process.env.ROOSTR_CLAUDE_PROJECTS_DIR = path.join(dir, 'empty-claude');
test.after(() => {
  if (prevAgyDir === undefined) delete process.env.ROOSTR_AGY_BRAIN_DIR;
  else process.env.ROOSTR_AGY_BRAIN_DIR = prevAgyDir;
  if (prevClaudeDir === undefined) delete process.env.ROOSTR_CLAUDE_PROJECTS_DIR;
  else process.env.ROOSTR_CLAUDE_PROJECTS_DIR = prevClaudeDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

function store(name, items) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `echo '${JSON.stringify(items)}'`,
  ].join('\n'), { mode: 0o755 });
  return file;
}

const items = [
  { id: 'ses_old', title: 'Old work', directory: '/tmp/a', updated: 10 },
  { id: 'ses_new', title: 'New work', directory: '/tmp/a', updated: 30 },
  { id: 'ses_other', title: 'Other', directory: '/tmp/b', updated: 20 },
];

test('log: merges stores newest first and tags each kind', async () => {
  const list = await log.list({
    noCache: true,
    bins: { opencode: store('oc', items), kilo: store('kilo', [{ id: 'ses_k', title: 'Kilo', directory: '/tmp/a', updated: 40 }]) },
  });
  assert.deepEqual(list.map((s) => s.id), ['ses_k', 'ses_new', 'ses_other', 'ses_old']);
  assert.equal(list[0].kind, 'kilo');
  assert.equal(list[1].kind, 'opencode');
});

test('log: a missing store is skipped, not an error', async () => {
  const list = await log.list({ noCache: true, bins: { opencode: '/nonexistent-opencode', kilo: store('kilo2', items) } });
  assert.equal(list.length, 3);
  assert.ok(list.every((s) => s.kind === 'kilo'));
});

test('log: dirs scope keeps this workspace, --all widens it', async () => {
  const bins = { opencode: store('oc3', items), kilo: '/nonexistent-kilo' };
  const here = await log.list({ noCache: true, bins, dirs: ['/tmp/a'] });
  assert.deepEqual(here.map((s) => s.id), ['ses_new', 'ses_old']);
  const all = await log.list({ noCache: true, bins, dirs: ['/tmp/a'], all: true });
  assert.equal(all.length, 3);
});

test('log: resume splits from the focused pane and passes the session id', async () => {
  const calls = [];
  const herdr = {
    snapshot: async () => ({
      workspaces: [{ workspace_id: 'w1', label: 'app' }],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', focused: true, cwd: '/tmp/a' }],
      agents: [{ pane_id: 'w1:p1', name: 'jefa', workspace_id: 'w1' }],
    }),
    splitPane: async (pane, direction, cwd) => { calls.push(['split', pane, direction, cwd]); return 'w1:p9'; },
    startAgent: async (name, kind, pane, args) => { calls.push(['start', name, kind, pane, args]); },
    renamePane: async (pane, label) => { calls.push(['rename', pane, label]); },
    closePane: async (pane) => { calls.push(['close', pane]); },
  };
  const r = await log.resume(
    { id: 'ses_new', kind: 'opencode', title: 'New work', directory: '/tmp/a' },
    { workspace: 'w1' },
    { herdr },
  );
  assert.deepEqual(r, {
    paneId: 'w1:p9', name: 'new-work', kind: 'opencode', session: 'ses_new', cwd: '/tmp/a', workspace: 'app', workspaceId: 'w1',
  });
  assert.deepEqual(calls[0], ['split', 'w1:p1', 'right', '/tmp/a']);
  assert.deepEqual(calls[1].slice(0, 4), ['start', 'new-work', 'opencode', 'w1:p9']);
  assert.deepEqual(calls[1][4], ['--session', 'ses_new']);
});

test('log: resume rejects an invalid id without touching herdr', async () => {
  const r = await log.resume({ id: 'nope', kind: 'opencode' }, {}, { herdr: { snapshot: async () => { throw new Error('should not run'); } } });
  assert.match(r.error, /no valid session id/);
});

test('log: --kind all includes agy and claude alongside opencode and kilo', async () => {
  assert.deepEqual(log.KINDS, ['opencode', 'kilo', 'claude', 'agy']);
  assert.match(log.USAGE, /opencode\|kilo\|claude\|agy\|all/);

  const agyDir = fs.mkdtempSync(path.join(dir, 'agy-'));
  const agyId = '11111111-1111-1111-1111-111111111111';
  const agyLogs = path.join(agyDir, agyId, '.system_generated', 'logs');
  fs.mkdirSync(agyLogs, { recursive: true });
  fs.writeFileSync(path.join(agyLogs, 'transcript.jsonl'), JSON.stringify({
    type: 'USER_INPUT',
    content: 'Command Working Directory: /tmp/a\nFix agy log',
  }) + '\n');

  const claudeDir = fs.mkdtempSync(path.join(dir, 'claude-'));
  const claudeProj = path.join(claudeDir, '-tmp-a');
  fs.mkdirSync(claudeProj, { recursive: true });
  const claudeId = '22222222-2222-2222-2222-222222222222';
  fs.writeFileSync(path.join(claudeProj, `${claudeId}.jsonl`), JSON.stringify({
    type: 'user',
    cwd: '/tmp/a',
    message: { role: 'user', content: 'Fix claude log' },
  }) + '\n');

  const list = await log.list({
    kind: 'all',
    noCache: true,
    agyBrainDir: agyDir,
    claudeProjectsDir: claudeDir,
    bins: {
      opencode: store('oc-all', [{ id: 'ses_oc', title: 'OC work', directory: '/tmp/a', updated: 10 }]),
      kilo: store('kilo-all', [{ id: 'ses_kl', title: 'Kilo work', directory: '/tmp/a', updated: 20 }]),
    },
  });
  const kinds = new Set(list.map((s) => s.kind));
  assert.deepEqual([...kinds].sort(), ['agy', 'claude', 'kilo', 'opencode']);
});

test('log: resume works for agy and claude', async () => {
  const calls = [];
  const herdr = {
    snapshot: async () => ({
      workspaces: [{ workspace_id: 'w1', label: 'app' }],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', focused: true, cwd: '/tmp/a' }],
      agents: [],
    }),
    splitPane: async () => 'w1:p2',
    startAgent: async (name, kind, pane, args) => { calls.push([name, kind, pane, args]); },
    renamePane: async () => {},
  };

  const agyId = '11111111-1111-1111-1111-111111111111';
  const rAgy = await log.resume({ id: agyId, kind: 'agy', title: 'Agy chat', directory: '/tmp/a' }, { workspace: 'w1' }, { herdr });
  assert.equal(rAgy.kind, 'agy');
  assert.equal(rAgy.session, agyId);
  assert.deepEqual(calls[0][3], ['--conversation', agyId]);

  const claudeId = '22222222-2222-2222-2222-222222222222';
  const rClaude = await log.resume({ id: claudeId, kind: 'claude', title: 'Claude chat', directory: '/tmp/a' }, { workspace: 'w1' }, { herdr });
  assert.equal(rClaude.kind, 'claude');
  assert.equal(rClaude.session, claudeId);
  assert.deepEqual(calls[1][3], ['--resume', claudeId]);
});
