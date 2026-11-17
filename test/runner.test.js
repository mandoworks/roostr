'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runner = require('../src/runner');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function workersOf(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(doc) ? doc : doc.workers;
}

test('buildRunnerCommand: every kind, with and without resume flags', () => {
  assert.deepEqual(
    runner.buildRunnerCommand('opencode', { task: 'do it' }),
    { bin: 'opencode', args: ['run', 'do it'] },
  );
  assert.deepEqual(
    runner.buildRunnerCommand('opencode', { task: 'do it', session: 'ses_1', model: 'm1' }),
    { bin: 'opencode', args: ['run', 'do it', '--session', 'ses_1', '--model', 'm1'] },
  );
  assert.deepEqual(
    runner.buildRunnerCommand('kilo', { task: 't', session: 's', model: 'm' }),
    { bin: 'kilo', args: ['run', 't', '--session', 's', '--model', 'm'] },
  );
  assert.deepEqual(
    runner.buildRunnerCommand('claude', { task: 't' }),
    { bin: 'claude', args: ['-p', 't', '--output-format', 'json'] },
  );
  assert.deepEqual(
    runner.buildRunnerCommand('claude', { task: 't', session: 's', model: 'm', effort: 'high' }),
    { bin: 'claude', args: ['-p', 't', '--output-format', 'json', '--resume', 's', '--model', 'm', '--effort', 'high'] },
  );
  assert.deepEqual(
    runner.buildRunnerCommand('agy', { task: 't' }),
    { bin: 'agy', args: ['t'] },
  );
  assert.deepEqual(
    runner.buildRunnerCommand('agy', { task: 't', session: 'c', model: 'm', effort: 'low' }),
    { bin: 'agy', args: ['t', '--conversation', 'c', '--model', 'm', '--effort', 'low'] },
  );
  assert.deepEqual(
    runner.buildRunnerCommand('custom', { bin: 'node', args: ['-e', 'x'], task: 'ignored' }),
    { bin: 'node', args: ['-e', 'x'] },
  );
  assert.deepEqual(
    runner.buildRunnerCommand('custom', { bin: 'node' }),
    { bin: 'node', args: [] },
  );
  assert.throws(() => runner.buildRunnerCommand('nope', {}), /unknown kind/);
});

test('samplePidRssKb: reads VmRSS on linux, null when the pid is gone', async () => {
  assert.equal(runner.parseVmRss('Name:\tnode\nVmRSS:\t  12345 kB\nState:\tS\n'), 12345);
  assert.equal(runner.parseVmRss('Name:\tnode\nState:\tS\n'), null);

  const live = () => 'Name:\tnode\nVmRSS:\t  4096 kB\n';
  assert.equal(await runner.samplePidRssKb(1234, { platform: 'linux', readFileSync: live }), 4096);

  const enoent = () => {
    const e = new Error('no such file');
    e.code = 'ENOENT';
    throw e;
  };
  assert.equal(await runner.samplePidRssKb(1234, { platform: 'linux', readFileSync: enoent }), null);
  assert.equal(await runner.samplePidRssKb(0, { readFileSync: live }), null);
  assert.equal(await runner.samplePidRssKb('not-a-pid', { readFileSync: live }), null);
});

test('samplePidRssKb: falls back to the process table tree sum', async () => {
  const table = new Map([
    [10, { ppid: 1, rss: 100 }],
    [11, { ppid: 10, rss: 50 }],
    [12, { ppid: 11, rss: 25 }],
    [13, { ppid: 10, rss: 5 }],
  ]);
  assert.equal(await runner.samplePidRssKb(10, { platform: 'darwin', processTable: async () => table }), 180);
  assert.equal(await runner.samplePidRssKb(999, { platform: 'darwin', processTable: async () => table }), null);
});

test('spawnHeadless: mac placement without a reason is refused', async () => {
  const r = await runner.spawnHeadless({ kind: 'custom', bin: 'node', args: ['-e', ''], placement: 'mac' });
  assert.equal(r.error, 'mac placement requires placementReason');
  assert.equal(r.id, undefined);

  const bad = await runner.spawnHeadless({ kind: 'custom', bin: 'node', args: [], placement: 'lunar' });
  assert.match(bad.error, /placement must be ovh or mac/);

  const noBin = await runner.spawnHeadless({ kind: 'custom', placement: 'ovh' });
  assert.match(noBin.error, /has no binary/);
});

test('spawnHeadless: detached run captures its log and registers in registry.json', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-runner-'));
  const state = path.join(root, 'state');
  fs.mkdirSync(state, { recursive: true });
  const prev = process.env.ROOSTR_STATE_DIR;
  process.env.ROOSTR_STATE_DIR = state;
  let pid = null;
  try {
    const script = "process.stdout.write('runner-hello\\n');setInterval(function () {}, 1000);";
    const r = await runner.spawnHeadless({
      kind: 'custom',
      bin: process.execPath,
      args: ['-e', script],
      task: 'smoke run',
      owner: 'enrique',
      placement: 'ovh',
      id: 'test-run-1',
    });
    assert.equal(r.error, undefined);
    assert.equal(r.id, 'test-run-1');
    assert.equal(r.state, 'working');
    assert.ok(r.pid > 0);
    pid = r.pid;
    assert.equal(r.logFile, path.join(state, 'logs', 'test-run-1.log'));

    // The log is created 0600 and fills with the child's output.
    assert.equal(fs.statSync(r.logFile).mode & 0o777, 0o600);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !/runner-hello/.test(readFileSafe(r.logFile))) {
      await delay(50);
    }
    assert.match(readFileSafe(r.logFile), /runner-hello/);

    const regFile = path.join(state, 'registry.json');
    const entry = workersOf(regFile).find((w) => w.id === 'test-run-1');
    assert.ok(entry, 'registry holds the run');
    assert.equal(entry.mode, 'headless');
    assert.equal(entry.state, 'working');
    assert.equal(entry.pid, pid);
    assert.equal(entry.kind, 'custom');
    assert.equal(entry.owner, 'enrique');
    assert.equal(entry.task, 'smoke run');
    assert.equal(entry.placement, 'ovh');
    assert.equal(entry.logFile, r.logFile);
    assert.ok(entry.command.startsWith(process.execPath));
    assert.equal(typeof entry.startedAt, 'string');

    // Tail reads the last lines back, and an unknown id is empty.
    assert.match(runner.tailLog('test-run-1', 5), /runner-hello/);
    assert.equal(runner.tailLog('no-such-run', 5), '');
    assert.equal(runner.tailLog('../../etc/passwd', 5), '');

    // A live pid refreshes as alive.
    const alive = await runner.refreshHeadless();
    assert.equal(alive.checked, 1);
    assert.equal(alive.alive, 1);

    // After the process exits, the run is closed out.
    process.kill(pid, 'SIGTERM');
    const gone = Date.now() + 5000;
    let refreshed = alive;
    while (Date.now() < gone && refreshed.done === 0) {
      await delay(100);
      refreshed = await runner.refreshHeadless();
    }
    assert.equal(refreshed.alive, 0);
    assert.equal(refreshed.done, 1);
    assert.equal(workersOf(regFile).find((w) => w.id === 'test-run-1').state, 'done');
  } finally {
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    if (prev === undefined) delete process.env.ROOSTR_STATE_DIR;
    else process.env.ROOSTR_STATE_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refreshHeadless: marks a dead pid done and a recorded failure failed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-runner-refresh-'));
  const prev = process.env.ROOSTR_STATE_DIR;
  process.env.ROOSTR_STATE_DIR = root;
  try {
    const regFile = path.join(root, 'registry.json');
    fs.writeFileSync(regFile, `${JSON.stringify({
      workers: [
        { id: 'ghost', mode: 'headless', state: 'working', pid: 2147483600, rssKb: null },
        { id: 'broke', mode: 'headless', state: 'working', pid: 2147483601, exitCode: 2, rssKb: null },
        { id: 'pane', mode: 'pane', state: 'working', pid: 2147483602, rssKb: null },
        { id: 'closed', mode: 'headless', state: 'done', pid: 2147483603, rssKb: null },
      ],
    }, null, 2)}\n`);

    const result = await runner.refreshHeadless();
    assert.equal(result.checked, 2);
    assert.equal(result.done, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.alive, 0);
    // Pane rows and terminal runs are left untouched.
    const byId = Object.fromEntries(workersOf(regFile).map((w) => [w.id, w]));
    assert.equal(byId.ghost.state, 'done');
    assert.equal(byId.broke.state, 'failed');
    assert.equal(byId.pane.state, 'working');
    assert.equal(byId.closed.state, 'done');
  } finally {
    if (prev === undefined) delete process.env.ROOSTR_STATE_DIR;
    else process.env.ROOSTR_STATE_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('registry round trip: reads a bare array, writes back the same container', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-runner-shape-'));
  try {
    const file = path.join(root, 'registry.json');
    fs.writeFileSync(file, `${JSON.stringify([{ id: 'a', mode: 'headless' }])}\n`);
    const read = runner.readRegistry(file);
    assert.equal(read.container, 'array');
    assert.equal(read.workers.length, 1);
    runner.writeRegistry(file, read.workers.concat({ id: 'b', mode: 'headless' }), read.container, read.extra);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(doc));
    assert.deepEqual(doc.map((w) => w.id), ['a', 'b']);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('main: help, usage errors, logs, and refresh --json', async () => {
  let out = '';
  let err = '';
  const io = {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
  };

  assert.equal(await runner.main(['--help'], io), 0);
  assert.match(out, /usage: roostr run/);

  out = ''; err = '';
  assert.equal(await runner.main(['--bogus'], io), 2);
  assert.match(err, /unknown option/);

  out = ''; err = '';
  assert.equal(await runner.main(['--kind', 'opencode'], io), 2);
  assert.match(err, /--task is required/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-runner-main-'));
  const prev = process.env.ROOSTR_STATE_DIR;
  process.env.ROOSTR_STATE_DIR = root;
  try {
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'logs', 'run-9.log'), 'one\ntwo\nthree\n');
    fs.writeFileSync(path.join(root, 'registry.json'), `${JSON.stringify({
      workers: [{ id: 'ghost', mode: 'headless', state: 'working', pid: 2147483600, rssKb: null }],
    })}\n`);

    out = ''; err = '';
    assert.equal(await runner.main(['logs', 'run-9', '--lines', '2'], io), 0);
    assert.equal(out, 'two\nthree\n');

    out = ''; err = '';
    assert.equal(await runner.main(['logs', 'run-9', '--json'], io), 0);
    assert.equal(JSON.parse(out).text, 'one\ntwo\nthree');

    out = ''; err = '';
    assert.equal(await runner.main(['refresh', '--json'], io), 0, err);
    const refreshed = JSON.parse(out);
    assert.equal(refreshed.checked, 1);
    assert.equal(refreshed.done, 1);
  } finally {
    if (prev === undefined) delete process.env.ROOSTR_STATE_DIR;
    else process.env.ROOSTR_STATE_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
