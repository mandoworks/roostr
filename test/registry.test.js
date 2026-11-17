'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../src/registry');

const NOW = Date.parse('2026-11-17T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-registry-'));
const dir = path.join(root, 'state');
const tokenDir = path.join(root, 'tokens');
const closedDir = path.join(root, 'closed');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('registerWorker: generates an id, stamps the record, persists an array with mode 0600', () => {
  const rec = registry.registerWorker({
    owner: 'hermita',
    host: 'ovh',
    task: 'ship the registry',
    kind: 'opencode',
    pid: 4242,
    command: 'opencode run ship',
    rssKb: 123456,
    state: 'working',
  }, { dir, now: NOW });

  assert.ok(rec.id.startsWith('opencode-'), `id ${rec.id}`);
  assert.equal(rec.owner, 'hermita');
  assert.equal(rec.host, 'ovh');
  assert.equal(rec.task, 'ship the registry');
  assert.equal(rec.kind, 'opencode');
  assert.equal(rec.pid, 4242);
  assert.equal(rec.rssKb, 123456);
  assert.equal(rec.state, 'working');
  assert.equal(rec.mode, 'headless');
  assert.equal(rec.source, 'reported');
  assert.equal(rec.startedAt, iso(NOW));
  assert.equal(rec.lastHeartbeat, iso(NOW));
  assert.equal(rec.updatedAt, iso(NOW));

  const file = path.join(dir, 'registry.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('registerWorker: explicit id, re-register preserves startedAt, validates state and mode', () => {
  const first = registry.registerWorker({ id: 'fixed-w1', owner: 'hermita', kind: 'claude' }, { dir, now: NOW });
  assert.equal(first.id, 'fixed-w1');
  assert.equal(first.mode, 'headless');

  const later = NOW + 60000;
  const again = registry.registerWorker({ id: 'fixed-w1', state: 'idle' }, { dir, now: later });
  assert.equal(again.startedAt, iso(NOW));
  assert.equal(again.state, 'idle');
  assert.equal(again.owner, 'hermita');
  assert.equal(again.updatedAt, iso(later));

  assert.throws(() => registry.registerWorker({ state: 'nope' }, { dir }), /invalid state/);
  assert.throws(() => registry.registerWorker({ mode: 'weird' }, { dir }), /invalid mode/);
});

test('updateStatus: patches the allowed fields, refreshes stamps, rejects unknown ids and bad states', () => {
  const rec = registry.registerWorker({ id: 'upd-1', kind: 'opencode' }, { dir, now: NOW });
  const later = NOW + 5000;
  const updated = registry.updateStatus(rec.id, {
    state: 'done',
    task: 'finished',
    session: 'ses_abc',
    rssKb: '2048',
    pid: '999',
    command: 'opencode run done',
    ignored: 'nope',
  }, { dir, now: later });

  assert.equal(updated.state, 'done');
  assert.equal(updated.task, 'finished');
  assert.equal(updated.session, 'ses_abc');
  assert.equal(updated.rssKb, 2048);
  assert.equal(updated.pid, 999);
  assert.equal(updated.command, 'opencode run done');
  assert.equal(updated.lastHeartbeat, iso(later));
  assert.equal(updated.updatedAt, iso(later));
  assert.equal(updated.ignored, undefined);

  assert.equal(registry.updateStatus('missing-worker', { state: 'done' }, { dir }), null);
  assert.throws(() => registry.updateStatus(rec.id, { state: 'bogus' }, { dir }), /invalid state/);
});

test('listWorkers and getWorker: stable sorted listing and lookup', () => {
  const listingDir = path.join(root, 'listing');
  registry.registerWorker({ id: 'b-worker', kind: 'claude' }, { dir: listingDir, now: NOW + 1000 });
  registry.registerWorker({ id: 'a-worker', kind: 'claude' }, { dir: listingDir, now: NOW });

  const list = registry.listWorkers({ dir: listingDir });
  assert.deepEqual(list.map((w) => w.id), ['a-worker', 'b-worker']);

  assert.equal(registry.getWorker('a-worker', { dir: listingDir }).id, 'a-worker');
  assert.equal(registry.getWorker('nope', { dir: listingDir }), null);
});

test('tokens: stores only a SHA-256 digest, verifies in constant time, rotates per label', () => {
  const issued = registry.issueToken('hermita', { dir: tokenDir, token: 'super-secret-value', now: NOW });
  assert.equal(issued.label, 'hermita');
  assert.equal(issued.token, 'super-secret-value');
  assert.equal(issued.createdAt, iso(NOW));

  const raw = fs.readFileSync(path.join(tokenDir, 'tokens.json'), 'utf8');
  assert.ok(!raw.includes('super-secret-value'), 'raw token must never be stored');
  assert.match(raw, /"hash":/);
  assert.equal(fs.statSync(path.join(tokenDir, 'tokens.json')).mode & 0o777, 0o600);

  assert.equal(registry.verifyToken('super-secret-value', { dir: tokenDir }), true);
  assert.equal(registry.verifyToken('wrong', { dir: tokenDir }), false);
  assert.equal(registry.verifyToken('', { dir: tokenDir }), false);
  assert.equal(registry.verifyToken(null, { dir: tokenDir }), false);

  // Re-issuing the label rotates the token.
  registry.issueToken('hermita', { dir: tokenDir, token: 'rotated-value', now: NOW + 1 });
  assert.equal(registry.verifyToken('super-secret-value', { dir: tokenDir }), false);
  assert.equal(registry.verifyToken('rotated-value', { dir: tokenDir }), true);
});

test('closed sessions: append then read back the schema, mode 0600', () => {
  const first = registry.appendClosedSession({
    id: 'w1:p1', paneId: 'w1:p1', pid: 42, command: 'opencode run x', model: 'm1',
    ramKb: 100, session: 'ses_1', workspaceId: 'ws1', reason: 'idle-reap',
  }, { dir: closedDir, now: NOW });
  assert.equal(first.at, iso(NOW));
  registry.appendClosedSession({ id: 'w2:p2', reason: 'reap' }, { dir: closedDir, now: NOW + 1 });

  const all = registry.readClosedSessions({ dir: closedDir });
  assert.equal(all.length, 2);
  assert.equal(all[0].at, iso(NOW));
  assert.equal(all[0].paneId, 'w1:p1');
  assert.equal(all[0].ramKb, 100);
  assert.equal(all[0].session, 'ses_1');
  assert.equal(all[0].reason, 'idle-reap');
  assert.equal(all[1].reason, 'reap');
  assert.equal(all[1].paneId, null);

  const file = path.join(closedDir, 'closed-sessions.jsonl');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});

test('closed sessions: missing file reads as an empty list', () => {
  assert.deepEqual(registry.readClosedSessions({ dir: path.join(root, 'no-such-dir') }), []);
});

test('file resolution: options.dir, options.env and ROOSTR_REGISTRY / ROOSTR_STATE_DIR overrides', () => {
  const envDir = path.join(root, 'env-state');
  assert.equal(registry.registryFile({ env: { ROOSTR_STATE_DIR: envDir } }), path.join(envDir, 'registry.json'));
  assert.equal(registry.tokensFile({ env: { ROOSTR_STATE_DIR: envDir } }), path.join(envDir, 'tokens.json'));
  assert.equal(registry.closedSessionsFile({ env: { ROOSTR_STATE_DIR: envDir } }), path.join(envDir, 'closed-sessions.jsonl'));

  const custom = path.join(root, 'custom-registry.json');
  assert.equal(registry.registryFile({ env: { ROOSTR_REGISTRY: custom } }), custom);
  assert.equal(registry.registryFile({ dir: dir }), path.join(dir, 'registry.json'));
});

test('main: register, status, list and token subcommands via injected io', () => {
  const cliDir = path.join(root, 'cli');
  const io = () => {
    const buf = { out: '', err: '' };
    return {
      buf,
      deps: {
        dir: cliDir,
        stdout: { write: (s) => { buf.out += s; } },
        stderr: { write: (s) => { buf.err += s; } },
      },
    };
  };

  let h = io();
  let code = registry.main(['register', '--id', 'cli-w1', '--owner', 'hermita', '--task', 'x', '--json'], h.deps);
  assert.equal(code, 0, h.buf.err);
  assert.equal(JSON.parse(h.buf.out).id, 'cli-w1');

  h = io();
  code = registry.main(['status', '--id', 'cli-w1', '--state', 'done'], h.deps);
  assert.equal(code, 0, h.buf.err);
  assert.match(h.buf.out, /updated cli-w1 state=done/);

  h = io();
  code = registry.main(['list', '--json'], h.deps);
  assert.equal(code, 0, h.buf.err);
  assert.equal(JSON.parse(h.buf.out).length, 1);

  h = io();
  code = registry.main(['token', '--label', 'board', '--json'], h.deps);
  assert.equal(code, 0, h.buf.err);
  const token = JSON.parse(h.buf.out);
  assert.equal(token.label, 'board');
  assert.ok(token.token);
  assert.equal(registry.verifyToken(token.token, { dir: cliDir }), true);

  // Errors: missing flags exit 2, unknown worker exits 1.
  h = io();
  assert.equal(registry.main(['status', '--id', 'cli-w1'], h.deps), 2);
  assert.match(h.buf.err, /needs --state/);
  h = io();
  assert.equal(registry.main(['status', '--id', 'ghost', '--state', 'done'], h.deps), 1);
  assert.match(h.buf.err, /unknown worker/);
});
