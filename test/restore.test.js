'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const restore = require('../src/restore');
const sessions = require('../src/sessions');
const herdr = require('../src/herdr');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-restore-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function snapshot() {
  return {
    workspaces: [
      { workspace_id: 'w1', label: 'App' },
      { workspace_id: 'w2', label: 'Site' },
    ],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', cwd: '/tmp/a', label: 'docs · write it', focused: true },
      { pane_id: 'w2:p1', workspace_id: 'w2', cwd: '/tmp/b', label: 'copy' },
    ],
    agents: [
      { pane_id: 'w1:p1', workspace_id: 'w1', name: 'docs', agent: 'claude', cwd: '/tmp/a' },
    ],
  };
}

function savedList() {
  return [
    {
      paneId: 'w1:p9', workspace: 'App', workspaceId: 'w1', name: 'docs',
      cwd: '/tmp/a', agent: 'claude', model: 'Opus 5.5', modelSrc: 'screen',
      effort: 'high', status: 'idle', task: 'write it', session: 'ses-1',
    },
    {
      paneId: 'w2:p9', workspace: 'Site', workspaceId: 'w2', name: 'copy',
      cwd: '/tmp/b', agent: 'agy', model: null, modelSrc: null,
      effort: null, status: 'idle', task: null, session: null,
    },
  ];
}

test('parseArgs: every restore flag', () => {
  assert.deepEqual(restore.parseArgs([]), {
    workspace: null, yes: false, dryRun: false, json: false, file: null, focus: null, help: false,
  });
  const all = restore.parseArgs([
    '--workspace', 'w1', '--yes', '--dry-run', '--json', '--file', '/tmp/sessions.json', '--focus',
  ]);
  assert.equal(all.workspace, 'w1');
  assert.equal(all.yes, true);
  assert.equal(all.dryRun, true);
  assert.equal(all.json, true);
  assert.equal(all.file, '/tmp/sessions.json');
  assert.equal(all.focus, true);
  assert.equal(restore.parseArgs(['-w', 'App']).workspace, 'App');
  assert.equal(restore.parseArgs(['-y']).yes, true);
  assert.equal(restore.parseArgs(['--no-focus']).focus, false);
  assert.equal(restore.parseArgs(['--here']).workspace, 'here');
  assert.equal(restore.parseArgs(['-h']).help, true);
});

test('parseArgs: a missing value or unknown flag is an error', () => {
  assert.deepEqual(restore.parseArgs(['--workspace']), { error: '--workspace needs a value' });
  assert.deepEqual(restore.parseArgs(['--file']), { error: '--file needs a value' });
  assert.deepEqual(restore.parseArgs(['--bogus']), { error: 'unknown option --bogus' });
});

test('resolveWorkspace: id, label, here, all and unknown', () => {
  const snap = snapshot();
  assert.deepEqual(restore.resolveWorkspace('w1', snap), { id: 'w1', label: 'App' });
  assert.deepEqual(restore.resolveWorkspace('app', snap), { id: 'w1', label: 'App' });
  assert.equal(restore.resolveWorkspace('all', snap), null);
  assert.deepEqual(restore.resolveWorkspace('missing', snap), { id: null, label: 'missing' });

  const savedId = process.env.HERDR_WORKSPACE_ID;
  delete process.env.HERDR_WORKSPACE_ID;
  try {
    assert.deepEqual(restore.resolveWorkspace('here', snap), { id: 'w1', label: 'App' });
    assert.deepEqual(restore.resolveWorkspace(null, snap), { id: 'w1', label: 'App' });
    process.env.HERDR_WORKSPACE_ID = 'w2';
    assert.deepEqual(restore.resolveWorkspace('here', snap), { id: 'w2', label: 'Site' });
  } finally {
    if (savedId === undefined) delete process.env.HERDR_WORKSPACE_ID;
    else process.env.HERDR_WORKSPACE_ID = savedId;
  }
});

test('livePanes: joins panes with agent names and needs a workspace id', () => {
  const panes = restore.livePanes(snapshot(), { id: 'w1', label: 'App' });
  assert.deepEqual(panes, [{
    paneId: 'w1:p1', cwd: '/tmp/a', label: 'docs · write it', name: 'docs', agent: 'claude',
    tab: undefined, focused: true,
  }]);
  assert.deepEqual(restore.livePanes(snapshot(), null), []);
  assert.deepEqual(restore.livePanes(snapshot(), { id: null, label: 'App' }), []);
});

test('execute: success starts, renames and reports the restored pane', async () => {
  const calls = [];
  const fake = {
    snapshot: async () => snapshot(),
    splitPane: async (paneId, direction, cwd) => {
      calls.push({ fn: 'splitPane', paneId, direction, cwd });
      return 'w1:p2';
    },
    startAgent: async (name, kind, paneId, args) => {
      calls.push({ fn: 'startAgent', name, kind, paneId, args });
    },
    renamePane: async (paneId, label) => { calls.push({ fn: 'renamePane', paneId, label }); },
    closePane: async (paneId) => { calls.push({ fn: 'closePane', paneId }); },
  };
  const plan = {
    entries: [{ session: savedList()[0], action: 'open', reason: null }],
    live: [{ paneId: 'w1:p1', cwd: '/tmp/a', name: 'docs', agent: 'claude' }],
    taken: new Set(['docs']),
  };

  const run = await restore.execute(plan, { id: 'w1', label: 'App' }, { herdr: fake });
  assert.equal(run.code, 0);
  assert.equal(run.result.restored.length, 1);
  assert.equal(run.result.restored[0].started, true);
  assert.equal(run.result.restored[0].agent, 'claude');
  assert.ok(calls.some((c) => c.fn === 'splitPane' && c.paneId === 'w1:p1'));
  assert.ok(calls.some((c) => c.fn === 'startAgent' && c.name === 'docs-2'));
  assert.ok(calls.some((c) => c.fn === 'renamePane' && c.label.includes('write it')));
  assert.equal(calls.some((c) => c.fn === 'closePane'), false);
});

test('execute: a failed start closes the pane it was split into', async () => {
  const calls = [];
  const fake = {
    snapshot: async () => snapshot(),
    splitPane: async () => 'w1:p2',
    startAgent: async () => { throw new Error('start failed'); },
    renamePane: async () => { calls.push('renamePane'); },
    closePane: async (paneId) => { calls.push(`close:${paneId}`); },
  };
  const plan = {
    entries: [{ session: savedList()[0], action: 'open', reason: null }],
    live: [{ paneId: 'w1:p1', cwd: '/tmp/a' }],
    taken: new Set(['docs']),
  };

  const run = await restore.execute(plan, { id: 'w1', label: 'App' }, { herdr: fake });
  assert.equal(run.code, 1);
  assert.equal(run.result.restored.length, 0);
  assert.equal(run.result.failed.length, 1);
  assert.match(run.result.failed[0].error, /start failed/);
  assert.deepEqual(calls, ['close:w1:p2']);
});

test('execute: no live pane to split from fails without starting anything', async () => {
  const fake = {
    snapshot: async () => snapshot(),
    splitPane: async () => { throw new Error('should not split'); },
    startAgent: async () => { throw new Error('should not start'); },
    renamePane: async () => { throw new Error('should not rename'); },
  };
  const plan = { entries: [{ session: savedList()[0], action: 'open', reason: null }], live: [] };

  const run = await restore.execute(plan, { id: 'w1', label: 'App' }, { herdr: fake });
  assert.equal(run.code, 1);
  assert.equal(run.result.restored.length, 0);
  assert.equal(run.result.failed.length, 1);
  assert.match(run.result.failed[0].error, /no live pane in this workspace to split from/);
});

test('execute: nothing to open is a clean no-op', async () => {
  const calls = [];
  const fake = {
    snapshot: async () => { calls.push('snapshot'); return snapshot(); },
  };
  const plan = {
    entries: [{ session: savedList()[0], action: 'skip', reason: 'already open' }],
    live: [],
  };

  const run = await restore.execute(plan, { id: 'w1', label: 'App' }, { herdr: fake });
  assert.equal(run.code, 0);
  assert.equal(run.result.restored.length, 0);
  assert.equal(run.result.skipped.length, 1);
  assert.equal(run.result.failed.length, 0);
  assert.deepEqual(calls, []);
});

async function outsideWorkspace(fn) {
  const saved = process.env.HERDR_WORKSPACE_ID;
  delete process.env.HERDR_WORKSPACE_ID;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.HERDR_WORKSPACE_ID;
    else process.env.HERDR_WORKSPACE_ID = saved;
  }
}

async function capture(fn) {
  const out = [];
  const err = [];
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    const code = await fn();
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

test('main: --dry-run prints the plan from --file without a live Herdr call', async () => {
  const file = path.join(dir, 'sessions.json');
  fs.writeFileSync(file, JSON.stringify(savedList(), null, 2) + '\n');
  const real = herdr.snapshot;
  let snapped = 0;
  herdr.snapshot = async () => { snapped++; return snapshot(); };
  try {
    const run = await capture(() => outsideWorkspace(() => restore.main(['--dry-run', '--file', file])));
    assert.equal(run.code, 0);
    assert.match(run.out, /2 sessions in 2 workspaces/);
    assert.match(run.out, /Dry run: no panes were opened\./);
    assert.equal(snapped, 0);
  } finally {
    herdr.snapshot = real;
  }
});

test('main: --dry-run --json prints the entries from --file', async () => {
  const file = path.join(dir, 'sessions-json.json');
  fs.writeFileSync(file, JSON.stringify(savedList(), null, 2) + '\n');
  const real = herdr.snapshot;
  let snapped = 0;
  herdr.snapshot = async () => { snapped++; return snapshot(); };
  try {
    const run = await capture(() => outsideWorkspace(() => restore.main(['--dry-run', '--json', '--file', file])));
    assert.equal(run.code, 0);
    const parsed = JSON.parse(run.out);
    assert.equal(parsed.workspace, null);
    assert.equal(parsed.entries.length, 2);
    assert.ok(parsed.entries.every((e) => e.action === 'open'));
    assert.equal(snapped, 0);
  } finally {
    herdr.snapshot = real;
  }
});

test('main: an unknown flag exits 2 with the usage', async () => {
  const run = await capture(() => restore.main(['--bogus']));
  assert.equal(run.code, 2);
  assert.match(run.err, /unknown option --bogus/);
  assert.match(run.err, /usage: (roostr|crew-board) restore/);
});

test('execute: a pane saved under its pane id is restored under its agent kind', async () => {
  const started = [];
  const fake = {
    snapshot: async () => snapshot(),
    splitPane: async () => 'w1:p2',
    startAgent: async (name) => { started.push(name); },
    renamePane: async () => {},
    closePane: async () => {},
  };
  const plan = {
    entries: [
      { session: { ...savedList()[0], paneId: 'w1:p7', name: 'w1:p7', agent: 'opencode' }, action: 'open', reason: null },
      { session: { ...savedList()[0], paneId: 'w1:p8', name: 'w1e-p1', agent: 'agy' }, action: 'open', reason: null },
    ],
    live: [{ paneId: 'w1:p1', cwd: '/tmp/a', name: 'docs', agent: 'claude' }],
    taken: new Set(['docs']),
  };
  await restore.execute(plan, { id: 'w1', label: 'App' }, { herdr: fake });
  assert.deepEqual(started, ['opencode', 'agy']);
});
