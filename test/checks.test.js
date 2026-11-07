'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { splitArgs, runOne, refresh, state, MAX_CONCURRENT, MIN_INTERVAL_MS } = require('../src/checks');

test('splitArgs: quotes and escapes, no shell meaning', () => {
  assert.deepEqual(splitArgs('pgrep -x Blender'), ['pgrep', '-x', 'Blender']);
  assert.deepEqual(splitArgs(`test -f 'my report.md'`), ['test', '-f', 'my report.md']);
  assert.deepEqual(splitArgs('echo "a \\"b\\" c" d\\ e'), ['echo', 'a "b" c', 'd e']);
  assert.deepEqual(splitArgs(`x ''`), ['x', '']);
  // Shell syntax is just text: no pipe, no substitution, no variable.
  assert.deepEqual(splitArgs('ls | rm -rf $HOME $(whoami)'), ['ls', '|', 'rm', '-rf', '$HOME', '$(whoami)']);
  assert.equal(splitArgs('echo "open'), null);
});

test('runOne: exit 0 passes, non zero fails, missing or timed out is unknown', async () => {
  const cwd = os.tmpdir();
  assert.equal(await runOne('true', cwd), true);
  assert.equal(await runOne('false', cwd), false);
  assert.equal(await runOne('test -d /', cwd), true);
  assert.equal(await runOne('no-such-program-crew-board', cwd), null);
  assert.equal(await runOne('sleep 5', cwd, 200), null);
  assert.equal(await runOne('', cwd), null);
});

test('refresh runs each check once per interval', async () => {
  const cwd = os.tmpdir();
  const list = [{ run: 'true', cwd }, { run: 'false', cwd }];
  assert.equal(state('true', cwd), null);
  await refresh(list, Date.now());
  assert.equal(state('true', cwd), true);
  assert.equal(state('false', cwd), false);
  // Too soon: nothing starts.
  const started = await refresh(list, Date.now() + 100);
  assert.equal(started.length, 0);
});

test('MAX_CONCURRENT defaults to 3', () => {
  assert.equal(MAX_CONCURRENT, 3);
});

test('refresh caps concurrent checks and picks the rest up next time', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-checks-cap-'));
  const list = [
    { run: 'true', cwd: path.join(cwd, 'a') },
    { run: 'true', cwd: path.join(cwd, 'b') },
    { run: 'true', cwd: path.join(cwd, 'c') },
    { run: 'true', cwd: path.join(cwd, 'd') },
    { run: 'true', cwd: path.join(cwd, 'e') },
  ];
  try {
    const first = await refresh(list, Date.now(), MIN_INTERVAL_MS, { maxConcurrent: 3 });
    assert.equal(first.length, 3);
    const second = await refresh(list, Date.now(), MIN_INTERVAL_MS, { maxConcurrent: 3 });
    assert.equal(second.length, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('refresh clamps maxConcurrent between 1 and 8', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-checks-clamp-'));
  const list = [
    { run: 'true', cwd: path.join(cwd, 'a') },
    { run: 'true', cwd: path.join(cwd, 'b') },
  ];
  try {
    const low = await refresh(list, Date.now(), MIN_INTERVAL_MS, { maxConcurrent: 0 });
    assert.equal(low.length, 1);
    const high = await refresh(list, Date.now() + 6000, MIN_INTERVAL_MS, { maxConcurrent: 99 });
    assert.equal(high.length, 2);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('refresh passes the timeout to runOne and resolves a timeout to null', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-checks-timeout-'));
  try {
    const started = await refresh([{ run: 'sleep 5', cwd }], Date.now(), MIN_INTERVAL_MS, { timeoutMs: 0 });
    assert.equal(started.length, 1);
    assert.equal(state('sleep 5', cwd), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('refresh prunes results for checks no longer in the list', async () => {
  const cwd = os.tmpdir();
  await refresh([{ run: 'true', cwd }], Date.now());
  assert.equal(state('true', cwd), true);
  await refresh([{ run: 'false', cwd }], Date.now() + 10000);
  assert.equal(state('true', cwd), null);
  assert.equal(state('false', cwd), false);
});
