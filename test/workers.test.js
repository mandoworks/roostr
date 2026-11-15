'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const workers = require('../src/workers');

const NOW = Date.parse('2026-11-15T05:00:00.000Z');

test('buildSnapshot: one entry per agent pane, skips non-agent panes, nulls when unknown', () => {
  const snap = {
    workspaces: [
      { workspace_id: 'ws1', label: 'sonia-nora' },
    ],
    panes: [
      { pane_id: 'wF:pG', workspace_id: 'ws1', label: 'La Guardiana · label task' },
      { pane_id: 'wF:pH', workspace_id: 'ws1', label: 'shell' },
      { pane_id: 'wF:pI', workspace_id: 'ws1', label: null },
    ],
    agents: [
      {
        pane_id: 'wF:pG',
        workspace_id: 'ws1',
        name: 'la-guardiana',
        agent: 'opencode',
        agent_status: 'working',
        session_id: 'ses_fromsnap123',
      },
      {
        pane_id: 'wF:pI',
        workspace_id: 'ws1',
        agent: 'claude',
        agent_status: '',
      },
    ],
  };

  const reports = {
    'wF:pG': {
      pane: 'wF:pG',
      task: 'FABLE fixes',
      model: 'explabs/deepseek-v4.1-flash-1017',
      tokens: 171500,
      cost: 0.12,
      session: 'ses_fromrep456',
    },
  };

  const doc = workers.buildSnapshot({ snapshot: snap, reports }, { host: 'ovh', now: NOW });

  assert.equal(doc.schema, 1);
  assert.equal(doc.host, 'ovh');
  assert.equal(doc.generated_epoch, Math.floor(NOW / 1000));
  assert.equal(doc.generated_at, '2026-11-15T05:00:00.000Z');
  assert.equal(doc.workers.length, 2);

  assert.deepEqual(doc.workers[0], {
    pane_id: 'wF:pG',
    workspace: 'sonia-nora',
    name: 'La Guardiana',
    agent: 'opencode',
    state: 'working',
    task: 'FABLE fixes',
    model: 'explabs/deepseek-v4.1-flash-1017',
    tokens: 171500,
    cost: 0.12,
    session: 'ses_fromrep456',
  });

  assert.deepEqual(doc.workers[1], {
    pane_id: 'wF:pI',
    workspace: 'sonia-nora',
    name: null,
    agent: 'claude',
    state: null,
    task: null,
    model: null,
    tokens: null,
    cost: null,
    session: null,
  });
});

test('buildSnapshot: truncates task longer than 160 chars with ellipsis character', () => {
  const longTask = 'x'.repeat(200);
  const snap = {
    workspaces: [{ workspace_id: 'ws1', label: 'alpha' }],
    panes: [{ pane_id: 'w1:p1', workspace_id: 'ws1', label: 'scout' }],
    agents: [{ pane_id: 'w1:p1', workspace_id: 'ws1', agent: 'claude', agent_status: 'working' }],
  };
  const reports = { 'w1:p1': { pane: 'w1:p1', task: longTask } };

  const doc = workers.buildSnapshot({ snapshot: snap, reports }, { host: 'box1', now: NOW });
  const task = doc.workers[0].task;
  assert.equal(task.length, 160);
  assert.ok(task.endsWith('…'));
  assert.ok(!task.endsWith('...'));
});

test('buildSnapshot: stable sort by workspace then pane_id and stable JSON', () => {
  const mkSnap = (order) => {
    const agents = [
      { pane_id: 'w2:p10', workspace_id: 'ws_b', agent: 'claude', agent_status: 'idle' },
      { pane_id: 'w1:p2', workspace_id: 'ws_a', agent: 'opencode', agent_status: 'working' },
      { pane_id: 'w1:p1', workspace_id: 'ws_a', agent: 'claude', agent_status: 'blocked' },
    ];
    return {
      workspaces: [
        { workspace_id: 'ws_b', label: 'beta' },
        { workspace_id: 'ws_a', label: 'alpha' },
      ],
      panes: [],
      agents: order.map((i) => agents[i]),
    };
  };

  const a = workers.buildSnapshot({ snapshot: mkSnap([0, 1, 2]), reports: {} }, { host: 'ovh', now: NOW });
  const b = workers.buildSnapshot({ snapshot: mkSnap([2, 0, 1]), reports: {} }, { host: 'ovh', now: NOW });

  assert.deepEqual(a.workers.map((w) => [w.workspace, w.pane_id]), [
    ['alpha', 'w1:p1'],
    ['alpha', 'w1:p2'],
    ['beta', 'w2:p10'],
  ]);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('writeSnapshot: writes atomically with mode 0644 and leaves no temp file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-workers-'));
  try {
    const doc = workers.buildSnapshot({ snapshot: { agents: [], panes: [], workspaces: [] }, reports: {} }, { host: 'ovh', now: NOW });
    const outPath = workers.writeSnapshot(doc, dir);

    assert.equal(outPath, path.join(dir, 'workers.ovh.json'));
    const entries = fs.readdirSync(dir);
    assert.deepEqual(entries, ['workers.ovh.json']);

    const mode = fs.statSync(outPath).mode & 0o777;
    assert.equal(mode, 0o644);

    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.deepEqual(parsed, doc);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('host sanitizing and invalid host rejection', async () => {
  assert.equal(workers.sanitizeHost('My-Host_01.local'), 'my-host-01.local');
  assert.equal(workers.sanitizeHost('...Leading-Dots'), 'leading-dots');
  assert.equal(workers.sanitizeHost('a'.repeat(80)).length, 63);
  assert.equal(workers.sanitizeHost('!!!'), null);

  for (const bad of ['', '-bad', '.bad', 'bad/host', 'BAD', 'bad host', 'a'.repeat(64)]) {
    assert.throws(() => workers.buildSnapshot({ agents: [] }, { host: bad, now: NOW }), /invalid host/);
    let err = '';
    const code = await workers.main(['--json', '--host', bad], {
      snapshot: async () => ({ agents: [], panes: [], workspaces: [] }),
      stdout: { write: () => {} },
      stderr: { write: (s) => { err += s; } },
    });
    assert.equal(code, 2, `bad host ${JSON.stringify(bad)} should exit 2`);
    assert.match(err, /invalid host/);
  }
});

test('main: missing out dir is a clean error, --json prints without out dir, ROOSTR_WORKERS_DIR works', async () => {
  let out = '';
  let err = '';
  const codeMissing = await workers.main(['--host', 'ovh'], {
    env: {},
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    snapshot: async () => { throw new Error('should not call snapshot'); },
  });
  assert.equal(codeMissing, 2);
  assert.equal(out, '');
  assert.match(err, /missing output dir/);
  assert.equal(err.trim().split('\n').length, 1);

  let jsonOut = '';
  let jsonErr = '';
  const codeJson = await workers.main(['--json', '--host', 'ovh'], {
    env: {},
    now: () => NOW,
    stdout: { write: (s) => { jsonOut += s; } },
    stderr: { write: (s) => { jsonErr += s; } },
    snapshot: async () => ({
      workspaces: [{ workspace_id: 'w1', label: 'core' }],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', label: 'worker' }],
      agents: [{ pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'working' }],
    }),
    readReport: () => ({ pane: 'w1:p1', tokens: 42 }),
  });
  assert.equal(codeJson, 0, jsonErr);
  assert.equal(jsonErr, '');
  const doc = JSON.parse(jsonOut);
  assert.equal(doc.host, 'ovh');
  assert.equal(doc.workers.length, 1);
  assert.equal(doc.workers[0].tokens, 42);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-workers-env-'));
  try {
    let envErr = '';
    const codeEnv = await workers.main(['--host', 'ovh'], {
      env: { ROOSTR_WORKERS_DIR: dir },
      now: () => NOW,
      stdout: { write: () => {} },
      stderr: { write: (s) => { envErr += s; } },
      snapshot: async () => ({ agents: [], panes: [], workspaces: [] }),
      readReport: () => null,
    });
    assert.equal(codeEnv, 0, envErr);
    assert.ok(fs.existsSync(path.join(dir, 'workers.ovh.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
