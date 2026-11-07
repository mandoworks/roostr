'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-sessions-'));
process.env.CREW_BOARD_STATE_DIR = dir;
const sessions = require('../src/sessions');

const bin = path.join(__dirname, '..', 'bin', 'crew-board');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function exampleModel() {
  return {
    workspaces: new Map([['w1', 'crew-board'], ['w2', 'site']]),
    rows: [
      {
        paneId: 'w1:pA', workspace: 'crew-board', name: 'crewboard', cwd: '/tmp/example-app',
        kind: 'agy', model: { v: 'Gemini 3.8 Flash', src: 'screen' }, effort: 'high',
        status: 'working', task: 'active task line', session: 'agent-session-id',
      },
      {
        paneId: 'w2:pB', workspace: 'site', name: 'copy', cwd: '/tmp/example-site',
        kind: 'claude', model: { v: null, src: 'unknown' }, effort: null,
        status: 'idle', task: null, session: null,
      },
    ],
  };
}

function fileFor(name) {
  return path.join(dir, `${name}.json`);
}

test('saveSessions: writes a session per agent pane, atomically', () => {
  const file = fileFor('atomic');
  const result = sessions.saveSessions(exampleModel(), file, { now: Date.parse('2026-10-26T20:00:00Z') });
  assert.equal(result.written, true);
  assert.equal(result.file, file);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('atomic')), ['atomic.json']);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.length, 2);
  const first = saved.find((s) => s.paneId === 'w1:pA');
  assert.deepEqual(first, {
    paneId: 'w1:pA', workspace: 'crew-board', workspaceId: 'w1', name: 'crewboard',
    cwd: '/tmp/example-app', agent: 'agy', model: 'Gemini 3.8 Flash', modelSrc: 'screen', effort: 'high',
    status: 'working', task: 'active task line', session: 'agent-session-id',
    updatedAt: '2026-10-26T20:00:00.000Z',
  });
  const second = saved.find((s) => s.paneId === 'w2:pB');
  assert.equal(second.model, null);
  assert.equal(second.modelSrc, 'unknown');
  assert.equal(second.effort, null);
  assert.equal(second.task, null);
});

test('saveSessions: unchanged state skips the write and keeps updatedAt', () => {
  const file = fileFor('skip');
  const model = exampleModel();
  const first = sessions.saveSessions(model, file, { now: Date.parse('2026-10-26T20:00:00Z') });
  assert.equal(first.written, true);
  const before = fs.readFileSync(file, 'utf8');
  const second = sessions.saveSessions(model, file, { now: Date.parse('2026-10-26T21:00:00Z') });
  assert.equal(second.written, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(second.sessions.find((s) => s.paneId === 'w1:pA').updatedAt, '2026-10-26T20:00:00.000Z');
});

test('saveSessions: a changed pane writes and gets a new updatedAt', () => {
  const file = fileFor('change');
  const model = exampleModel();
  sessions.saveSessions(model, file, { now: Date.parse('2026-10-26T20:00:00Z') });
  model.rows[0].task = 'a new task line';
  const result = sessions.saveSessions(model, file, { now: Date.parse('2026-10-26T20:05:00Z') });
  assert.equal(result.written, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.find((s) => s.paneId === 'w1:pA').task, 'a new task line');
  assert.equal(saved.find((s) => s.paneId === 'w1:pA').updatedAt, '2026-10-26T20:05:00.000Z');
  assert.equal(saved.find((s) => s.paneId === 'w2:pB').updatedAt, '2026-10-26T20:00:00.000Z');
});

test('saveSessions: keeps the previous snapshot as .bak before a change', () => {
  const file = fileFor('backup');
  const model = exampleModel();
  sessions.saveSessions(model, file, { now: Date.parse('2026-10-26T20:00:00Z') });
  const first = fs.readFileSync(file, 'utf8');
  model.rows[0].task = 'a changed task';
  const result = sessions.saveSessions(model, file, { now: Date.parse('2026-10-26T20:05:00Z') });
  assert.equal(result.written, true);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), first);
});

test('saveSessions: an empty snapshot never replaces a non-empty one', () => {
  const file = fileFor('empty-guard');
  sessions.saveSessions(exampleModel(), file, { now: Date.parse('2026-10-26T20:00:00Z') });
  const before = fs.readFileSync(file, 'utf8');
  const result = sessions.saveSessions({ rows: [] }, file, { now: Date.parse('2026-10-26T20:05:00Z') });
  assert.equal(result.written, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  const fresh = fileFor('empty-fresh');
  const first = sessions.saveSessions({ rows: [] }, fresh, { now: Date.parse('2026-10-26T20:05:00Z') });
  assert.equal(first.written, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(fresh, 'utf8')), []);
});

test('extractSessions: a Herdr snapshot yields every agent pane', () => {
  const snap = {
    workspaces: [{ workspace_id: 'w1', label: 'crew-board' }, { workspace_id: 'w2', label: 'site' }],
    panes: [
      { pane_id: 'w1:pA', label: 'crewboard · active task line', cwd: '/tmp/example-app' },
      { pane_id: 'w2:pB', cwd: '/tmp/example-site' },
    ],
    agents: [
      { pane_id: 'w1:pA', workspace_id: 'w1', agent: 'agy', agent_status: 'working', cwd: '/tmp/example-app' },
      { pane_id: 'w2:pB', workspace_id: 'w2', agent: 'claude', agent_status: 'idle', cwd: '/tmp/example-site' },
    ],
  };
  const list = sessions.extractSessions(snap);
  assert.deepEqual(list.map((s) => s.paneId), ['w1:pA', 'w2:pB']);
  assert.equal(list[0].workspace, 'crew-board');
  assert.equal(list[0].workspaceId, 'w1');
  assert.equal(list[0].name, 'crewboard');
  assert.equal(list[0].task, 'active task line');
  assert.equal(list[1].agent, 'claude');
});

test('loadSessions: missing or corrupt files return an empty array', () => {
  assert.deepEqual(sessions.loadSessions(fileFor('missing')), []);
  const bad = fileFor('bad');
  fs.writeFileSync(bad, '{not json');
  assert.deepEqual(sessions.loadSessions(bad), []);
  fs.writeFileSync(bad, '{"rows":[]}');
  assert.deepEqual(sessions.loadSessions(bad), []);
});

test('loadSessions: round trips a saved snapshot', () => {
  const file = fileFor('roundtrip');
  sessions.saveSessions(exampleModel(), file);
  const list = sessions.loadSessions(file);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'crewboard');
});

test('formatRestorePlan: groups panes by workspace with directory, model and task', () => {
  const file = fileFor('plan');
  sessions.saveSessions(exampleModel(), file, { now: Date.parse('2026-10-26T20:00:00Z') });
  const plan = sessions.formatRestorePlan(sessions.loadSessions(file));
  assert.match(plan, /2 sessions in 2 workspaces/);
  assert.match(plan, /crew-board \(w1\)/);
  assert.match(plan, /site \(w2\)/);
  assert.match(plan, /crewboard \(w1:pA\) · agy · Gemini 3\.8 Flash · high · working/);
  assert.match(plan, /cwd: \/tmp\/example-app/);
  assert.match(plan, /task: active task line/);
  assert.match(plan, /session: agent-session-id/);
  assert.equal(sessions.formatRestorePlan([]), 'No saved sessions. Nothing to restore.\n');
});

test('restoreSessions: regenerates missing workspaces, splits panes, and starts agents', async () => {
  const calls = [];
  const mockHerdr = {
    snapshot: async () => ({
      workspaces: [{ workspace_id: 'w1', label: 'crew-board' }],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1' }],
      agents: [],
    }),
    createWorkspace: async (label, cwd) => {
      calls.push({ fn: 'createWorkspace', label, cwd });
      return { workspaceId: 'w2_new', rootPaneId: 'w2:p1' };
    },
    splitPane: async (paneId, dir, cwd) => {
      calls.push({ fn: 'splitPane', paneId, dir, cwd });
      return `${paneId}_split`;
    },
    startAgent: async (name, kind, paneId, args) => {
      calls.push({ fn: 'startAgent', name, kind, paneId, args });
    },
    renamePane: async (paneId, label) => {
      calls.push({ fn: 'renamePane', paneId, label });
    },
  };

  const list = [
    {
      paneId: 'w1:pA', workspace: 'crew-board', workspaceId: 'w1', name: 'crewboard',
      cwd: '/tmp/example-app', agent: 'agy', model: 'Gemini 3.8 Flash', task: 'active task',
    },
    {
      paneId: 'w2:pB', workspace: 'site', workspaceId: 'w2', name: 'copy',
      cwd: '/tmp/example-site', agent: 'claude', session: 'claude-sess-123', task: 'landing copy',
    },
  ];

  const result = await sessions.restoreSessions(list, { herdr: mockHerdr });
  assert.equal(result.dryRun, false);
  assert.equal(result.restored, 2);
  assert.equal(result.errors.length, 0);

  // w1 exists: split from w1:p1
  assert.ok(calls.some((c) => c.fn === 'splitPane' && c.paneId === 'w1:p1'));
  // site did not exist: created workspace
  assert.ok(calls.some((c) => c.fn === 'createWorkspace' && c.label === 'site'));
  // started agents, claude resumed with session id
  assert.ok(calls.some((c) => c.fn === 'startAgent' && c.name === 'copy' && c.kind === 'claude' && c.args.includes('--resume')));
  // renamed panes with tasks
  assert.ok(calls.some((c) => c.fn === 'renamePane' && c.label.includes('active task')));
  assert.ok(calls.some((c) => c.fn === 'renamePane' && c.label.includes('landing copy')));
});

test('restoreSessions: skips duplicate agents already running in workspace', async () => {
  const calls = [];
  const mockHerdr = {
    snapshot: async () => ({
      workspaces: [{ workspace_id: 'w1', label: 'crew-board' }],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1' }],
      agents: [{ workspace_id: 'w1', cwd: '/tmp/example-app', agent: 'agy' }],
    }),
    createWorkspace: async () => { throw new Error('should not create'); },
    splitPane: async () => { calls.push('splitPane'); return 'split'; },
    startAgent: async () => { calls.push('startAgent'); },
    renamePane: async () => { calls.push('renamePane'); },
  };

  const list = [
    {
      paneId: 'w1:pA', workspace: 'crew-board', workspaceId: 'w1', name: 'crewboard',
      cwd: '/tmp/example-app', agent: 'agy', task: 'active task',
    },
  ];

  const result = await sessions.restoreSessions(list, { herdr: mockHerdr });
  assert.equal(result.restored, 0, 'skipped duplicate agent');
  assert.equal(calls.length, 0);
});

test('restoreSessions: passes --model only when the model came from an exact report', async () => {
  const started = [];
  let splits = 0;
  const mockHerdr = {
    snapshot: async () => ({
      workspaces: [{ workspace_id: 'w1', label: 'crew-board' }],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1' }],
      agents: [],
    }),
    splitPane: async () => `w1:new${++splits}`,
    startAgent: async (name, kind, paneId, args) => { started.push({ name, args }); },
    renamePane: async () => {},
  };

  const list = [
    {
      paneId: 'w1:pA', workspace: 'crew-board', workspaceId: 'w1', name: 'screen',
      cwd: '/tmp/a', agent: 'claude', model: 'Opus 5.5', modelSrc: 'screen', session: 'claude-sess',
    },
    {
      paneId: 'w1:pB', workspace: 'crew-board', workspaceId: 'w1', name: 'exact',
      cwd: '/tmp/b', agent: 'opencode', model: 'deepseek-v4', modelSrc: 'exact', session: null,
    },
    {
      paneId: 'w1:pC', workspace: 'crew-board', workspaceId: 'w1', name: 'legacy',
      cwd: '/tmp/c', agent: 'kilo', model: 'Sonnet 5.5',
    },
  ];

  const result = await sessions.restoreSessions(list, { herdr: mockHerdr });
  assert.equal(result.restored, 3);
  const screen = started.find((s) => s.name === 'screen');
  assert.deepEqual(screen.args, ['--resume', 'claude-sess']);
  const exact = started.find((s) => s.name === 'exact');
  assert.deepEqual(exact.args, ['--model', 'deepseek-v4']);
  const legacy = started.find((s) => s.name === 'legacy');
  assert.deepEqual(legacy.args, []);
});

test('restoreSessions: a failed start closes the pane it was split into', async () => {
  const calls = [];
  const mockHerdr = {
    snapshot: async () => ({
      workspaces: [{ workspace_id: 'w1', label: 'crew-board' }],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1' }],
      agents: [],
    }),
    splitPane: async () => 'w1:new',
    startAgent: async () => { throw new Error('start failed'); },
    renamePane: async () => { calls.push('renamePane'); },
    closePane: async (paneId) => { calls.push(`close:${paneId}`); },
  };

  const list = [{ paneId: 'w1:pA', workspace: 'crew-board', workspaceId: 'w1', name: 'copy', cwd: '/tmp/a', agent: 'claude' }];
  const result = await sessions.restoreSessions(list, { herdr: mockHerdr });
  assert.equal(result.restored, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /start failed/);
  assert.deepEqual(calls, ['close:w1:new']);
});

test('planRestore: workspace filter, skip already open, open the rest', () => {
  const list = [
    { paneId: 'w1:pA', workspace: 'crew-board', workspaceId: 'w1', name: 'crewboard', cwd: '/tmp/example-app', agent: 'agy' },
    { paneId: 'w1:pB', workspace: 'crew-board', workspaceId: 'w1', name: 'copy', cwd: '/tmp/example-copy', agent: 'claude' },
    { paneId: 'w1:pC', workspace: 'crew-board', workspaceId: 'w1', name: 'docs', cwd: null, agent: 'claude' },
    { paneId: 'w2:pD', workspace: 'site', workspaceId: 'w2', name: 'site', cwd: '/tmp/example-site', agent: 'agy' },
  ];
  const plan = sessions.planRestore(list, { id: 'w1', label: 'crew-board' }, [
    { paneId: 'w1:pZ', cwd: '/tmp/example-app', label: 'crewboard · active task line' },
  ]);
  assert.deepEqual(plan.map((e) => [e.session.paneId, e.action, e.reason]), [
    ['w1:pA', 'skip', 'already open'],
    ['w1:pB', 'open', null],
    ['w1:pC', 'skip', 'no working directory'],
  ]);
});

test('planRestore: workspace label is the fallback after a restart', () => {
  const list = [{ paneId: 'w1:pA', workspace: 'crew-board', workspaceId: 'w1', name: 'a', cwd: '/tmp/a' }];
  assert.equal(sessions.workspaceSessions(list, { id: 'w9', label: 'crew-board' }).length, 1);
});

test('agentName: valid Herdr name, unique on collision', () => {
  const taken = new Set(['crewboard']);
  assert.equal(sessions.agentName('Crewboard', taken), 'crewboard-2');
  assert.equal(sessions.agentName('1 api worker!', new Set()), 'api-worker');
  assert.equal(sessions.agentName('', new Set()), 'restore');
});

test('CLI: sessions --json and restore --dry-run read the saved file', () => {
  const file = fileFor('cli');
  sessions.saveSessions(exampleModel(), file, { now: Date.parse('2026-10-26T20:00:00Z') });
  const listed = spawnSync(process.execPath, [bin, 'sessions', '--json', '--file', file], { encoding: 'utf8' });
  assert.equal(listed.status, 0);
  assert.equal(JSON.parse(listed.stdout).length, 2);
  const restored = spawnSync(process.execPath, [bin, 'restore', '--dry-run', '--file', file], { encoding: 'utf8' });
  assert.equal(restored.status, 0);
  assert.match(restored.stdout, /2 sessions in 2 workspaces/);
  assert.match(restored.stdout, /w1:pA/);
  assert.match(restored.stdout, /Dry run: no panes were opened\./);
});

// After a Herdr restart the old layout is back as empty shells, under the same
// pane and workspace ids, and two workspaces can share a label.
function restartedHerdr(calls) {
  return {
    snapshot: async () => ({
      workspaces: [{ workspace_id: 'w3', label: 'app' }, { workspace_id: 'w4', label: 'app' }],
      panes: [
        { pane_id: 'w3:p1', workspace_id: 'w3', cwd: '/tmp/example-app' },
        { pane_id: 'w3:p2', workspace_id: 'w3', cwd: '/tmp/example-app' },
        { pane_id: 'w4:p1', workspace_id: 'w4', cwd: '/tmp/other' },
      ],
      agents: [],
    }),
    createWorkspace: async () => { calls.push({ fn: 'createWorkspace' }); return { workspaceId: 'w9', rootPaneId: 'w9:p1' }; },
    splitPane: async (paneId) => { calls.push({ fn: 'splitPane', paneId }); return `${paneId}_split`; },
    startAgent: async (name, kind, paneId) => { calls.push({ fn: 'startAgent', name, kind, paneId }); },
    renamePane: async () => {},
  };
}

test('restoreSessions: starts the agent in its old pane when Herdr brought it back empty', async () => {
  const calls = [];
  const list = [
    { paneId: 'w3:p2', workspace: 'app', workspaceId: 'w3', name: 'docs', cwd: '/tmp/example-app', agent: 'claude' },
  ];
  const result = await sessions.restoreSessions(list, { herdr: restartedHerdr(calls) });
  assert.equal(result.restored, 1);
  assert.equal(calls.some((c) => c.fn === 'splitPane'), false);
  assert.ok(calls.some((c) => c.fn === 'startAgent' && c.paneId === 'w3:p2'));
});

test('restoreSessions: the saved workspace id wins over a label two workspaces share', async () => {
  const calls = [];
  const list = [
    { paneId: 'w3:p9', workspace: 'app', workspaceId: 'w3', name: 'docs', cwd: '/tmp/example-app', agent: 'claude' },
  ];
  const result = await sessions.restoreSessions(list, { herdr: restartedHerdr(calls) });
  assert.equal(result.restored, 1);
  assert.equal(result.items[0].workspaceId, 'w3');
  assert.ok(calls.some((c) => c.fn === 'splitPane' && c.paneId.startsWith('w3:')));
  assert.equal(calls.some((c) => c.fn === 'createWorkspace'), false);
});

test('restoreSessions: a shared label with no saved id opens a new workspace', async () => {
  const calls = [];
  const list = [
    { paneId: 'w7:p1', workspace: 'app', workspaceId: 'w7', name: 'docs', cwd: '/tmp/example-app', agent: 'claude' },
  ];
  await sessions.restoreSessions(list, { herdr: restartedHerdr(calls) });
  assert.ok(calls.some((c) => c.fn === 'createWorkspace'));
});

test('validSession: opencode must be a ses_ id, so a foreign UUID is dropped', () => {
  assert.equal(sessions.validSession('opencode', 'ses_e5dc2a71effeE3G1RyaBXIA2Ye'), true);
  assert.equal(sessions.validSession('opencode', '5ad68bea-c9d4-449d-94f3-4f1e6f1be826'), false);
  assert.equal(sessions.validSession('claude', 'claude-sess-123'), true);
  assert.equal(sessions.validSession('opencode', null), false);
});

test('agentArgs: an invalid opencode session is not passed to --session', () => {
  assert.deepEqual(sessions.agentArgs({
    agent: 'opencode', session: '5ad68bea-c9d4-449d-94f3-4f1e6f1be826', model: 'deepseek-v4', modelSrc: 'exact',
  }), ['--model', 'deepseek-v4']);
  assert.deepEqual(sessions.agentArgs({
    agent: 'opencode', session: 'ses_abc123', model: null, modelSrc: null,
  }), ['--session', 'ses_abc123']);
});

test('resolveAgentSessions: fills an opencode pane from the title opencode shows', async () => {
  const fake = path.join(dir, 'fake-opencode');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    'cat <<\'JSON\'',
    '[{"id":"ses_fromtitle","title":"Review the plan","directory":"/tmp/example-app","updated":100}]',
    'JSON',
  ].join('\n'), { mode: 0o755 });
  const snap = {
    agents: [{
      pane_id: 'w1:pA', agent: 'opencode', cwd: '/tmp/example-app',
      terminal_title: 'OC | Review the plan', session_id: undefined,
    }],
  };
  const reported = [];
  const resolved = await sessions.resolveAgentSessions(snap, {
    opencodeBin: fake, noCache: true,
    herdr: { reportAgentSession: async (pane, kind, id) => reported.push([pane, kind, id]) },
    writeBack: true,
  });
  assert.deepEqual(resolved, [{ paneId: 'w1:pA', kind: 'opencode', session: 'ses_fromtitle' }]);
  assert.equal(snap.agents[0].session_id, 'ses_fromtitle');
  assert.deepEqual(reported, [['w1:pA', 'opencode', 'ses_fromtitle']]);
});

test('resolveAgentSessions: no title means no guess', async () => {
  const fake = path.join(dir, 'fake-opencode-empty');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    'echo \'[{"id":"ses_a","title":"Something else","directory":"/tmp/example-app","updated":100}]\'',
  ].join('\n'), { mode: 0o755 });
  const snap = { agents: [{ pane_id: 'w1:pA', agent: 'opencode', cwd: '/tmp/example-app', terminal_title: null }] };
  const resolved = await sessions.resolveAgentSessions(snap, { opencodeBin: fake, noCache: true });
  assert.deepEqual(resolved, []);
  assert.equal(snap.agents[0].session_id, undefined);
});

test('resolveSavedSessions: a dead opencode pane gets its session back by directory and task', async () => {
  const fake = path.join(dir, 'fake-opencode-saved');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    'echo \'[{"id":"ses_dead","title":"Build the report","directory":"/tmp/example-app","updated":10},{"id":"ses_other","title":"Unrelated","directory":"/tmp/example-app","updated":20}]\'',
  ].join('\n'), { mode: 0o755 });
  const entries = [
    { paneId: 'w1:pA', cwd: '/tmp/example-app', name: 'writer', task: 'Build the report', agent: 'opencode', session: null },
  ];
  const found = await sessions.resolveSavedSessions(entries, { opencodeBin: fake, noCache: true });
  assert.deepEqual(found.map((x) => [x.paneId, x.session]), [['w1:pA', 'ses_dead']]);
  assert.equal(entries[0].session, 'ses_dead');
});

test('resolveSavedSessions: a weak title match is not a guess', async () => {
  const fake = path.join(dir, 'fake-opencode-weak');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    'echo \'[{"id":"ses_x","title":"Something unrelated","directory":"/tmp/example-app","updated":10}]\'',
  ].join('\n'), { mode: 0o755 });
  const entries = [
    { paneId: 'w1:pA', cwd: '/tmp/example-app', name: null, task: 'Build the report', agent: 'opencode', session: null },
  ];
  assert.deepEqual(await sessions.resolveSavedSessions(entries, { opencodeBin: fake, noCache: true }), []);
  assert.equal(entries[0].session, null);
});

test('resolveSavedSessions: a live claimed session is never handed to another pane', async () => {
  const fake = path.join(dir, 'fake-opencode-claimed');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    'echo \'[{"id":"ses_taken","title":"Build the report","directory":"/tmp/example-app","updated":10}]\'',
  ].join('\n'), { mode: 0o755 });
  const entries = [
    { paneId: 'w1:pA', cwd: '/tmp/example-app', task: 'Build the report', agent: 'opencode', session: 'ses_taken' },
    { paneId: 'w1:pB', cwd: '/tmp/example-app', task: 'Build the report', agent: 'opencode', session: null },
  ];
  assert.deepEqual(await sessions.resolveSavedSessions(entries, { opencodeBin: fake, noCache: true }), []);
  assert.equal(entries[1].session, null);
});
