'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = require('../src/session-log');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-log-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

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
