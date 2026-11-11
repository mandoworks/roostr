'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const backup = require('../src/backup');
const board = require('../src/board');
const ui = require('../src/ui');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-backup-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshDir = () => path.join(tmp, `d${++n}`);

// Three panes across the top (the first narrow) over a full width strip, as
// Herdr reports it, plus a second tab with one agent pane.
function snapshot() {
  const r = (x, y, width, height) => ({ x, y, width, height });
  return {
    workspaces: [
      { workspace_id: 'w1', label: 'app', active_tab_id: 'w1:t1' },
      { workspace_id: 'w2', label: 'notes' },
    ],
    tabs: [
      { tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 1 },
      { tab_id: 'w1:t2', workspace_id: 'w1', label: 'review', number: 2 },
      { tab_id: 'w2:t1', workspace_id: 'w2', label: '1', number: 1 },
    ],
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp/app', label: 'logs' },
      { pane_id: 'w1:p2', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp/app', label: 'docs · write the guide' },
      { pane_id: 'w1:p3', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp/app', label: '' },
      { pane_id: 'w1:p4', workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/tmp/app/web', label: '' },
      { pane_id: 'w1:p5', workspace_id: 'w1', tab_id: 'w1:t2', cwd: '/tmp/app', label: '' },
      { pane_id: 'w2:p1', workspace_id: 'w2', tab_id: 'w2:t1', cwd: '/tmp/notes', label: '' },
    ],
    agents: [
      { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude', name: 'docs', cwd: '/tmp/app', session_id: 'sess-1' },
      { pane_id: 'w1:p5', workspace_id: 'w1', agent: 'opencode', name: '', cwd: '/tmp/app' },
    ],
    layouts: [
      {
        tab_id: 'w1:t1', workspace_id: 'w1', area: r(0, 0, 287, 89), zoomed: false,
        panes: [
          { pane_id: 'w1:p1', rect: r(0, 0, 34, 78) },
          { pane_id: 'w1:p2', rect: r(34, 0, 127, 78) },
          { pane_id: 'w1:p3', rect: r(161, 0, 126, 78) },
          { pane_id: 'w1:p4', rect: r(0, 78, 287, 11) },
        ],
        splits: [
          { direction: 'down', ratio: 0.87234044, rect: r(0, 0, 287, 89) },
          { direction: 'right', ratio: 0.11764706, rect: r(0, 0, 287, 78) },
          { direction: 'right', ratio: 0.5, rect: r(34, 0, 253, 78) },
        ],
      },
      { tab_id: 'w1:t2', workspace_id: 'w1', area: r(0, 0, 287, 89), panes: [{ pane_id: 'w1:p5', rect: r(0, 0, 287, 89) }], splits: [] },
      { tab_id: 'w2:t1', workspace_id: 'w2', area: r(0, 0, 287, 89), panes: [{ pane_id: 'w2:p1', rect: r(0, 0, 287, 89) }], splits: [] },
    ],
  };
}

const model = (snap = snapshot()) => ({ rows: [], snapshot: snap });

test('layoutTree: rebuilds the split tree with Herdr\'s own ratios', () => {
  const lay = snapshot().layouts[0];
  const t = backup.layoutTree(lay.panes, lay.area, lay.splits);
  assert.equal(t.dir, 'down');
  assert.equal(t.ratio, 0.872);
  assert.deepEqual(t.b, { pane: 'w1:p4' });
  assert.equal(t.a.dir, 'right');
  assert.equal(t.a.ratio, 0.118);
  assert.deepEqual(t.a.a, { pane: 'w1:p1' });
  assert.equal(t.a.b.ratio, 0.5);
  assert.deepEqual(backup.leaves(t), ['w1:p1', 'w1:p2', 'w1:p3', 'w1:p4']);
});

test('capture: backs up workspaces with an agent, shells included, and skips the rest', () => {
  const list = backup.capture(model(), Date.parse('2026-10-30T06:00:00Z'));
  assert.deepEqual(list.map((b) => b.workspaceId), ['w1']);
  const b = list[0];
  assert.equal(b.label, 'app');
  assert.deepEqual(backup.counts(b), { tabs: 2, panes: 5, agents: 2 });
  assert.equal(b.tabs[0].focused, true);
  assert.equal(b.tabs[1].label, 'review');
  const docs = b.tabs[0].panes.find((p) => p.paneId === 'w1:p2');
  assert.equal(docs.agent.kind, 'claude');
  assert.equal(docs.agent.session, 'sess-1');
  assert.equal(docs.agent.task, 'write the guide');
  assert.equal(b.tabs[0].panes[0].label, 'logs');
  assert.equal(b.tabs[0].panes[0].agent, undefined);
  // An unnamed agent is not saved under its pane id.
  assert.equal(b.tabs[1].panes[0].agent.name, null);
});

test('capture: saves a session Herdr reported as agent_session.value', () => {
  const snap = snapshot();
  delete snap.agents[0].session_id;
  snap.agents[0].agent_session = { value: 'sess-1' };
  const b = backup.capture(model(snap))[0];
  const docs = b.tabs[0].panes.find((p) => p.paneId === 'w1:p2');
  assert.equal(docs.agent.session, 'sess-1');
});

test('saveBackups: same content writes nothing, a new task refreshes the newest version', () => {
  const dir = freshDir();
  assert.equal(backup.saveBackups(backup.capture(model()), { dir, now: 1000 }), 1);
  assert.equal(backup.saveBackups(backup.capture(model()), { dir, now: 2000 }), 0);
  const snap = snapshot();
  snap.panes[1].label = 'docs · review the guide';
  assert.equal(backup.saveBackups(backup.capture(model(snap)), { dir, now: 3000 }), 1);
  const list = backup.listBackups(dir);
  assert.equal(list[0].versions.length, 1);
  assert.equal(list[0].versions[0].backup.tabs[0].panes[1].agent.task, 'review the guide');
});

test('saveBackups: a new layout is a new version, and only the last 4 are kept', () => {
  const dir = freshDir();
  for (let i = 0; i < 6; i++) {
    const snap = snapshot();
    snap.panes[3].cwd = `/tmp/app/v${i}`;
    backup.saveBackups(backup.capture(model(snap), 1000 + i), { dir, now: 1000 + i });
  }
  const v = backup.listBackups(dir)[0].versions;
  assert.equal(v.length, backup.KEEP);
  assert.equal(v[0].backup.tabs[0].panes[3].cwd, '/tmp/app/v5');
  assert.equal(v[3].backup.tabs[0].panes[3].cwd, '/tmp/app/v2');
});

test('saveBackups: a workspace Herdr brought back without its agents keeps its backup', () => {
  const dir = freshDir();
  backup.saveBackups(backup.capture(model()), { dir, now: 1000 });
  const empty = snapshot();
  empty.agents = [];
  assert.equal(backup.saveBackups(backup.capture(model(empty)), { dir, now: 2000 }), 0);
  assert.equal(backup.counts(backup.listBackups(dir)[0].versions[0].backup).agents, 2);
});

function fakeHerdr(calls) {
  let next = 0;
  return {
    createWorkspace: async (label, cwd) => { calls.push(['workspace', label, cwd]); return { workspaceId: 'w9', rootPaneId: 'w9:p1', tabId: 'w9:t1' }; },
    createTab: async (ws, cwd, label) => { calls.push(['tab', ws, cwd, label]); return { tabId: 'w9:t2', rootPaneId: 'w9:t2root' }; },
    renameTab: async (id, label) => { calls.push(['renameTab', id, label]); },
    splitPane: async (pane, dir, cwd, noFocus, ratio) => { calls.push(['split', pane, dir, cwd, ratio]); return `w9:n${++next}`; },
    startAgent: async (name, kind, pane, args) => { calls.push(['start', name, kind, pane, args]); },
    renamePane: async (pane, label) => { calls.push(['rename', pane, label]); },
  };
}

test('restoreBackup: builds a new "*restored" workspace with the same tabs, splits and agents', async () => {
  const calls = [];
  const b = backup.capture(model())[0];
  const r = await backup.restoreBackup(b, { herdr: fakeHerdr(calls), taken: ['docs'], layout: 'saved' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.label, 'app *restored');
  assert.equal(r.panes, 5);
  assert.equal(r.agents, 2);
  assert.deepEqual(calls[0], ['workspace', 'app *restored', '/tmp/app']);
  // Herdr's default tab name "1" is not copied; a real tab name is.
  assert.equal(calls.some((c) => c[0] === 'renameTab'), false);
  assert.deepEqual(calls.filter((c) => c[0] === 'split'), [
    ['split', 'w9:p1', 'down', '/tmp/app/web', 0.872],
    ['split', 'w9:p1', 'right', '/tmp/app', 0.118],
    ['split', 'w9:n2', 'right', '/tmp/app', 0.5],
  ]);
  assert.deepEqual(calls.find((c) => c[0] === 'tab'), ['tab', 'w9', '/tmp/app', 'review']);
  const docs = calls.find((c) => c[0] === 'start' && c[2] === 'claude');
  assert.deepEqual(docs, ['start', 'docs-2', 'claude', 'w9:n2', ['--resume', 'sess-1']]);
  assert.deepEqual(r.sessions, [{ paneId: 'w9:n2', name: 'docs-2', agent: 'claude', session: 'sess-1' }]);
  assert.deepEqual(calls.find((c) => c[0] === 'start' && c[2] === 'opencode').slice(1, 4), ['opencode', 'opencode', 'w9:t2root']);
  assert.ok(calls.some((c) => c[0] === 'rename' && c[1] === 'w9:p1' && c[2] === 'logs'));
  assert.ok(calls.some((c) => c[0] === 'rename' && c[1] === 'w9:n2' && c[2] === 'docs-2 · write the guide'));
});

test('restoreBackup: a failed agent start is reported and the rest still opens', async () => {
  const calls = [];
  const h = fakeHerdr(calls);
  h.startAgent = async (name, kind) => {
    if (kind === 'claude') throw new Error('no claude here');
    calls.push(['start', name, kind]);
  };
  const r = await backup.restoreBackup(backup.capture(model())[0], { herdr: h });
  assert.equal(r.agents, 1);
  assert.deepEqual(r.sessions, []);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /no claude here/);
});

test('previewLines: draws each tab and lists every pane', () => {
  const lines = backup.previewLines(backup.capture(model(), 0)[0], 100, 60000);
  const text = lines.join('\n');
  assert.match(lines[0], /^app \(w1\) · saved 1m ago · 2 tabs, 5 panes, 2 agents/);
  assert.match(text, /tab 1 · active/);
  assert.match(text, /tab 2 · review/);
  assert.match(text, /┌/);
  assert.match(text, /docs \(claude\)/);
  assert.match(text, / {2}● claude · docs · write the guide \[resumes\] \/tmp\/app/);
  assert.match(text, / {2}● opencode \/tmp\/app/);
  assert.match(text, /│\/tmp\/app\/web|│shell/);
  assert.match(text, /○ shell · logs/);
});

test('parseArgs: list, show and restore with a version', () => {
  assert.equal(backup.parseArgs([]).cmd, 'list');
  assert.deepEqual(
    (({ cmd, key, version, yes }) => ({ cmd, key, version, yes }))(backup.parseArgs(['restore', 'app', '--version', '2', '--yes'])),
    { cmd: 'restore', key: 'app', version: 2, yes: true },
  );
  assert.match(backup.parseArgs(['show']).error, /needs a workspace/);
  assert.match(backup.parseArgs(['show', 'app', '--version', '0']).error, /--version/);
  assert.equal(backup.parseArgs(['restore', 'app', '--layout', 'columns']).layout, 'columns');
  assert.match(backup.parseArgs(['restore', 'app', '--layout', 'diagonal']).error, /--layout/);
});

test('main: restore without --yes only prints the plan', async () => {
  const dir = freshDir();
  backup.saveBackups(backup.capture(model()), { dir, now: 1000 });
  let out = '';
  const stdout = { write: (s) => { out += s; }, columns: 100 };
  const herdr = { snapshot: async () => { throw new Error('must not be called'); } };
  const code = await backup.main(['restore', 'app', '--dir', dir], { stdout, herdr });
  assert.equal(code, 0);
  assert.match(out, /Run again with --yes to build "app \*restored"/);
});

test('board: the backups view shows each workspace, its versions and the preview', () => {
  const dir = freshDir();
  const at = Date.parse('2026-10-30T06:00:00Z');
  backup.saveBackups(backup.capture(model(), at), { dir, now: at });
  const m = { rows: [], crews: [], crewChecks: [], checkList: [], workspaces: new Map(), scopeLabel: 'all', now: Date.parse('2026-10-30T06:05:00Z') };
  ui.setColor(false);
  const st = { list: backup.listBackups(dir), sel: 0, ver: 0, confirm: true, status: null };
  const out = board.render(m, { width: 110, backups: st });
  assert.match(out, /backups {2}↑↓ workspace/);
  assert.match(out, /▸ app \(w1\) {2}2t 5p 2a {2}\[1:5m\]/);
  assert.match(out, /restore app · 2 tabs, 5 panes, 2 agents · layout even · y to confirm, any other key cancels/);
  assert.match(out, /docs \(claude\)/);
});

test('treeFor: every preset covers every pane; even balances the area', () => {
  const tab = { tree: null, panes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((paneId) => ({ paneId })) };
  for (const layout of backup.LAYOUTS.filter((l) => l !== 'saved')) {
    assert.deepEqual(new Set(backup.leaves(backup.treeFor(tab, layout))), new Set(tab.panes.map((p) => p.paneId)));
  }
  const g = backup.treeFor(tab, 'even');
  assert.equal(g.dir, 'down');
  assert.deepEqual(backup.leaves(g), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.equal(g.ratio, 0.4286);
  assert.equal(g.a.dir, 'right');
  assert.equal(g.a.ratio, 0.3333);
});

test('restoreBackup: the default even layout splits every pane to the same share', async () => {
  const calls = [];
  const r = await backup.restoreBackup(backup.capture(model())[0], { herdr: fakeHerdr(calls), resolveSessions: false });
  assert.deepEqual(r.errors, []);
  const splits = calls.filter((c) => c[0] === 'split');
  assert.equal(splits.length, 3);
  for (const s of splits) assert.equal(s[4], 0.5);
});

test('restoreBackup: a dead pane resolves its session from the store before it starts', async () => {
  const fake = path.join(tmp, 'fake-opencode-restore');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    'echo \'[{"id":"ses_recovered","title":"Review staging","directory":"/tmp/app","updated":100}]\'',
  ].join('\n'), { mode: 0o755 });
  const b = backup.capture(model())[0];
  const pane = b.tabs[1].panes[0];
  pane.agent.task = 'Review staging';
  pane.agent.session = null;
  const calls = [];
  const r = await backup.restoreBackup(b, { herdr: fakeHerdr(calls), opencodeBin: fake, noCache: true });
  assert.deepEqual(r.errors, []);
  const started = calls.find((c) => c[0] === 'start' && c[2] === 'opencode');
  assert.deepEqual(started[4], ['--session', 'ses_recovered']);
  assert.equal(r.sessions.find((s) => s.agent === 'opencode').session, 'ses_recovered');
});
