'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const respawn = require('../src/respawn');

function snapshot() {
  return {
    workspaces: [{ workspace_id: 'w1', label: 'app' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 1 }],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp/app', label: 'alpha' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp/app', label: 'docs · write the guide' },
    ],
    agents: [
      {
        pane_id: 'w1:p1', workspace_id: 'w1', agent: 'opencode', name: 'alpha', cwd: '/tmp/app',
        agent_status: 'idle', agent_session: { value: 'ses_abc123' },
      },
      {
        pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude', name: 'docs', cwd: '/tmp/app',
        agent_status: 'idle', agent_session: { value: '669c7ff3-dff5-4366-b0e7-b4b0dba7dcae' },
      },
    ],
    layouts: [],
  };
}

function fakeHerdr(snap, calls) {
  let next = 0;
  return {
    snapshot: async () => snap,
    closeWorkspace: async (id) => { calls.push(['closeWorkspace', id]); },
    renameWorkspace: async (id, label) => { calls.push(['renameWorkspace', id, label]); },
    focusWorkspace: async (id) => { calls.push(['focusWorkspace', id]); },
    openBoard: async (entrypoint, split, workspaceId) => { calls.push(['openBoard', entrypoint, split, workspaceId]); },
    createWorkspace: async (label, cwd) => {
      calls.push(['createWorkspace', label, cwd]);
      return { workspaceId: 'w9', rootPaneId: 'w9:p1', tabId: 'w9:t1' };
    },
    createTab: async (ws, cwd, label) => { calls.push(['createTab', ws, cwd, label]); return { rootPaneId: 'w9:t2root' }; },
    renameTab: async () => {},
    splitPane: async (pane, dir, cwd, noFocus, ratio) => {
      calls.push(['splitPane', pane, dir, cwd, ratio]);
      return `w9:n${++next}`;
    },
    startAgent: async (name, kind, pane, args) => { calls.push(['startAgent', name, kind, pane, args]); },
    renamePane: async (pane, label) => { calls.push(['renamePane', pane, label]); },
  };
}

const base = { yes: true, keepOld: false, force: false, layout: 'saved', workspace: 'app' };

test('respawn: closes the workspace, rebuilds it, and resumes both sessions', async () => {
  const calls = [];
  const r = await respawn.run(base, { herdr: fakeHerdr(snapshot(), calls), save: false });
  assert.deepEqual(r.errors, []);
  assert.equal(r.oldWorkspaceId, 'w1');
  assert.equal(r.label, 'app');
  assert.equal(r.agents, 2);
  assert.deepEqual(r.sessions.map((s) => [s.agent, s.session]), [
    ['opencode', 'ses_abc123'],
    ['claude', '669c7ff3-dff5-4366-b0e7-b4b0dba7dcae'],
  ]);
  assert.deepEqual(calls.find((c) => c[0] === 'createWorkspace'), ['createWorkspace', 'app *restored', '/tmp/app']);
  assert.ok(calls.findIndex((c) => c[0] === 'closeWorkspace') < calls.findIndex((c) => c[0] === 'createWorkspace'));
  assert.deepEqual(calls.find((c) => c[0] === 'renameWorkspace'), ['renameWorkspace', 'w9', 'app']);
  const start = calls.filter((c) => c[0] === 'startAgent');
  assert.deepEqual(start[0][4], ['--session', 'ses_abc123']);
  assert.deepEqual(start[1][4], ['--resume', '669c7ff3-dff5-4366-b0e7-b4b0dba7dcae']);
});

test('respawn: --reopen-board opens a board in the rebuilt workspace', async () => {
  const calls = [];
  const r = await respawn.run({ ...base, reopenBoard: true }, { herdr: fakeHerdr(snapshot(), calls), save: false });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(calls.find((c) => c[0] === 'openBoard'), ['openBoard', 'board', true, 'w9']);
});

test('respawn: --keep-old leaves the old workspace and keeps the restored label', async () => {
  const calls = [];
  const r = await respawn.run({ ...base, keepOld: true }, { herdr: fakeHerdr(snapshot(), calls), save: false });
  assert.deepEqual(r.errors, []);
  assert.equal(r.oldWorkspaceId, null);
  assert.equal(r.label, 'app *restored');
  assert.equal(calls.some((c) => c[0] === 'closeWorkspace'), false);
  assert.equal(calls.some((c) => c[0] === 'renameWorkspace'), false);
  // Live names are taken, so the copies get a suffix.
  assert.deepEqual(calls.filter((c) => c[0] === 'startAgent').map((c) => c[1]), ['alpha-2', 'docs-2']);
});

test('respawn: refuses while an agent is working unless forced', async () => {
  const snap = snapshot();
  snap.agents[0].agent_status = 'working';
  const r = await respawn.run(base, { herdr: fakeHerdr(snap, []), save: false });
  assert.match(r.error, /still working/);
});

test('respawn: refuses when a resume capable pane has no session, and --force starts it fresh', async () => {
  const snap = snapshot();
  snap.agents[0].agent_session = null;
  const calls = [];
  const refused = await respawn.run(
    { ...base, workspace: 'w1' },
    { herdr: fakeHerdr(snap, calls), save: false, opencodeBin: '/nonexistent-opencode', noCache: true },
  );
  assert.match(refused.error, /no session for w1:p1/);
  assert.equal(calls.some((c) => c[0] === 'closeWorkspace'), false);

  const forced = await respawn.run(
    { ...base, force: true },
    { herdr: fakeHerdr(snap, calls), save: false, opencodeBin: '/nonexistent-opencode', noCache: true },
  );
  assert.deepEqual(forced.errors, []);
  const fresh = calls.find((c) => c[0] === 'startAgent' && c[2] === 'opencode');
  assert.deepEqual(fresh[4], []);
});

test('respawn: without --yes it prints the plan and touches nothing', async () => {
  const calls = [];
  const r = await respawn.run({ ...base, yes: false }, { herdr: fakeHerdr(snapshot(), calls), save: false });
  assert.equal(r.plan, true);
  assert.equal(r.resumed, 2);
  assert.equal(calls.length, 0);
});
