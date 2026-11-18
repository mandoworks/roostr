'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const governor = require('../src/governor');

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const MIN = 60 * 1000;

function fakeRegistry() {
  const closed = [];
  const workers = {};
  return {
    closed,
    workers,
    getWorker: (id) => workers[id] || null,
    updateStatus: (id, patch) => {
      workers[id] = { ...(workers[id] || { id }), ...patch };
      return workers[id];
    },
    appendClosedSession: (entry) => { closed.push(entry); return entry; },
    listWorkers: () => Object.values(workers),
    readClosedSessions: () => closed,
  };
}

test('checkPaneSpawn: ovh headless is allowed by default', () => {
  assert.deepEqual(governor.checkPaneSpawn({}), { allowed: true, reason: null });
  assert.deepEqual(governor.checkPaneSpawn({ placement: 'ovh', host: 'ovh', livePaneCount: 9 }), { allowed: true, reason: null });
});

test('checkPaneSpawn: a mac placement without a reason is refused back to ovh', () => {
  assert.deepEqual(
    governor.checkPaneSpawn({ placement: 'mac' }),
    { allowed: false, reason: 'mac placement requires placementReason', fallback: 'ovh' },
  );
  assert.deepEqual(
    governor.checkPaneSpawn({ placement: 'mac', placementReason: '   ' }),
    { allowed: false, reason: 'mac placement requires placementReason', fallback: 'ovh' },
  );
  // A named reason passes that gate.
  assert.deepEqual(
    governor.checkPaneSpawn({ placement: 'mac', placementReason: 'needs local Edits', host: 'ovh', livePaneCount: 0 }),
    { allowed: true, reason: null },
  );
});

test('checkPaneSpawn: the mac pane budget refuses the fourth pane, fallback headless', () => {
  const atBudget = governor.checkPaneSpawn({ placement: 'mac', placementReason: 'device work', host: 'mac', livePaneCount: 3 });
  assert.deepEqual(atBudget, { allowed: false, reason: 'pane budget exceeded (3/3 on mac)', fallback: 'headless' });
  // darwin is treated as mac.
  assert.equal(governor.checkPaneSpawn({ host: 'darwin', livePaneCount: 3 }).allowed, false);
  // Under budget passes.
  assert.equal(governor.checkPaneSpawn({ host: 'mac', livePaneCount: 2 }).allowed, true);
});

test('checkPaneSpawn: swap pressure refuses a spawn, fallback headless', () => {
  assert.deepEqual(
    governor.checkPaneSpawn({ host: 'ovh', swapUsedPct: 80 }),
    { allowed: false, reason: 'swap pressure threshold exceeded', fallback: 'headless' },
  );
  assert.equal(governor.checkPaneSpawn({ host: 'ovh', swapUsedPct: 79.9 }).allowed, true);
  // A custom threshold is honored.
  assert.equal(governor.checkPaneSpawn({ host: 'ovh', swapUsedPct: 50, config: { swapThresholdPct: 40 } }).allowed, false);
});

test('checkPaneSpawn: mac reason, then budget, then swap order', () => {
  const refused = governor.checkPaneSpawn({ placement: 'mac', host: 'mac', livePaneCount: 3, swapUsedPct: 99 });
  assert.equal(refused.reason, 'mac placement requires placementReason');
});

test('findIdlePanes: only idle or done past the threshold, skipping board panes', () => {
  const panes = [
    { pane_id: 'w1:p1', agent: 'opencode', label: 'worker' },
    { pane_id: 'w1:p2', agent: 'claude', label: 'worker' },
    { pane_id: 'w1:p3', agent: 'opencode', label: 'worker' },
    { pane_id: 'w1:p4', agent: 'roostr', label: 'crew-board' },
    { pane_id: 'w1:p5', agent: 'opencode', label: 'worker' },
  ];
  const statusMap = {
    'w1:p1': { status: 'idle', since: new Date(NOW - 31 * MIN).toISOString() },
    'w1:p2': { status: 'idle', since: new Date(NOW - 10 * MIN).toISOString() },
    'w1:p3': { status: 'done', since: NOW - 45 * MIN },
    'w1:p4': { status: 'idle', since: NOW - 99 * MIN },
    'w1:p5': { status: 'working', since: NOW - 99 * MIN },
  };
  const idle = governor.findIdlePanes(panes, statusMap, NOW, 30 * MIN);
  assert.deepEqual(idle.map((p) => p.pane_id), ['w1:p1', 'w1:p3']);
});

test('reapIdlePanes: closes only panes with a resumable session and logs each close', async () => {
  const reg = fakeRegistry();
  const closed = [];
  const herdr = { closePane: (id) => { closed.push(id); return Promise.resolve(); } };
  const panes = [
    { pane_id: 'w1:p1', agent: 'opencode', shell_pid: 7, workspace_id: 'ws1' },
    { pane_id: 'w1:p2', agent: 'claude' },
  ];
  const statusMap = {
    'w1:p1': { status: 'idle', since: NOW - 40 * MIN },
    'w1:p2': { status: 'idle', since: NOW - 40 * MIN },
  };
  const sessions = { 'w1:p1': 'ses_a' };

  const result = await governor.reapIdlePanes({
    panes, statusMap, sessions, herdr, now: NOW, thresholdMs: 30 * MIN, registry: reg,
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.reaped.length, 1);
  assert.equal(result.reaped[0].paneId, 'w1:p1');
  assert.deepEqual(closed, ['w1:p1']);
  assert.equal(reg.closed.length, 1);
  assert.equal(reg.closed[0].session, 'ses_a');
  assert.equal(reg.closed[0].reason, 'idle-reap');
  assert.equal(reg.closed[0].workspaceId, 'ws1');
  assert.deepEqual(result.skipped, [{ paneId: 'w1:p2', reason: 'no resumable session' }]);
});

test('reapIdlePanes: dry run closes nothing and writes nothing', async () => {
  const reg = fakeRegistry();
  const closed = [];
  const herdr = { closePane: (id) => { closed.push(id); return Promise.resolve(); } };
  const panes = [{ pane_id: 'w1:p1', agent: 'opencode' }];
  const statusMap = { 'w1:p1': { status: 'idle', since: NOW - 90 * MIN } };

  const result = await governor.reapIdlePanes({
    panes, statusMap, sessions: { 'w1:p1': 'ses_a' }, herdr, now: NOW, thresholdMs: 30 * MIN, dryRun: true, registry: reg,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.reaped.length, 1);
  assert.equal(result.reaped[0].dryRun, true);
  assert.deepEqual(closed, []);
  assert.equal(reg.closed.length, 0);
});

test('reapWorker: verifies pid and command before SIGTERM, logs and marks failed', () => {
  const reg = fakeRegistry();
  reg.workers.w1 = { id: 'w1', pid: 4242, command: 'opencode run task', model: 'm', rssKb: 5000, session: 'ses_1' };
  const table = { 4242: 'opencode run task' };
  const kills = [];
  const killImpl = (pid, sig) => kills.push([pid, sig]);

  const ok = governor.reapWorker({ id: 'w1', pid: 4242, command: 'opencode run task', registry: reg, processTable: table, killImpl, now: NOW });
  assert.equal(ok.killed, true);
  assert.deepEqual(kills, [[4242, 'SIGTERM']]);
  assert.equal(reg.closed.length, 1);
  assert.equal(reg.closed[0].reason, 'reap');
  assert.equal(reg.closed[0].pid, 4242);
  assert.equal(reg.closed[0].session, 'ses_1');
  assert.equal(reg.workers.w1.state, 'failed');

  // Command mismatch at click time: no kill.
  const bad = governor.reapWorker({ id: 'w1', pid: 4242, command: 'rm -rf /', registry: reg, processTable: table, killImpl });
  assert.equal(bad.killed, false);
  assert.equal(bad.reason, 'pid/command mismatch');
  assert.equal(kills.length, 1);

  // Pid no longer running in the live table.
  const gone = governor.reapWorker({ id: 'w1', pid: 4242, command: 'opencode run task', registry: reg, processTable: {}, killImpl });
  assert.equal(gone.reason, 'pid not running');

  // Unknown worker is refused outright.
  const unknown = governor.reapWorker({ id: 'ghost', pid: 1, command: 'x', registry: reg, killImpl });
  assert.equal(unknown.killed, false);
  assert.equal(unknown.reason, 'unknown worker');
});

test('reapWorker: a ram.processTable-style Map counts as a live process', () => {
  const reg = fakeRegistry();
  reg.workers.w2 = { id: 'w2', pid: 99, command: 'node server.js' };
  const kills = [];
  const table = new Map([[99, { ppid: 1, rss: 2048 }]]);
  const ok = governor.reapWorker({ id: 'w2', pid: 99, command: 'node server.js', registry: reg, processTable: table, killImpl: (p, s) => kills.push([p, s]) });
  assert.equal(ok.killed, true);
  assert.deepEqual(kills, [[99, 'SIGTERM']]);
});

test('main: status prints the config and counts, reap previews without --yes and errors cleanly when herdr is down', async () => {
  const reg = fakeRegistry();
  reg.workers.a = { id: 'a', pid: 1, command: 'c' };

  let out = '';
  let code = await governor.main(['--json'], {
    registry: reg,
    stdout: { write: (s) => { out += s; } },
    stderr: { write: () => {} },
  });
  assert.equal(code, 0);
  const doc = JSON.parse(out);
  assert.equal(doc.config.macMaxLivePanes, 3);
  assert.equal(doc.config.swapThresholdPct, 80);
  assert.equal(doc.config.idleReapMinutes, 30);
  assert.equal(doc.workers, 1);

  const snap = {
    panes: [{ pane_id: 'w1:p1', agent: 'opencode' }],
    agents: [{ pane_id: 'w1:p1', agent: 'opencode', agent_status: 'idle', agent_status_changed_at: new Date(Date.now() - 40 * MIN).toISOString() }],
  };
  out = '';
  code = await governor.main(['reap', '--json'], {
    herdr: { snapshot: async () => snap, closePane: async () => {} },
    sessions: { 'w1:p1': 'ses_a' },
    registry: fakeRegistry(),
    now: () => Date.now(),
    stdout: { write: (s) => { out += s; } },
    stderr: { write: () => {} },
  });
  assert.equal(code, 0);
  const preview = JSON.parse(out);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.reaped.length, 1);

  let err = '';
  code = await governor.main(['reap'], {
    herdr: { snapshot: async () => { throw new Error('herdr down'); } },
    registry: reg,
    stdout: { write: () => {} },
    stderr: { write: (s) => { err += s; } },
  });
  assert.equal(code, 1);
  assert.match(err, /herdr unavailable/);
});
