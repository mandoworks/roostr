'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('../src/state');
const ledger = require('../src/ledger');
const log = require('../src/log');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-reliability-'));

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('state: creates .bak copy on update and recovers from corrupted state.json', () => {
  const stateFile = path.join(tmpRoot, 'state.json');
  const bakFile = stateFile + '.bak';

  // Initial save
  const data1 = { version: 1, panes: { 'w1:p1': 'working' } };
  state.save(stateFile, data1);
  assert.deepEqual(state.load(stateFile), data1);
  assert.equal(fs.existsSync(bakFile), false);

  // Second save creates .bak of data1
  const data2 = { version: 2, panes: { 'w1:p1': 'done' } };
  state.save(stateFile, data2);
  assert.deepEqual(state.load(stateFile), data2);
  assert.ok(fs.existsSync(bakFile));
  assert.deepEqual(JSON.parse(fs.readFileSync(bakFile, 'utf8')), data1);

  // Corrupt state.json
  fs.writeFileSync(stateFile, 'CORRUPTED JSON { not valid', 'utf8');

  // Intercept log.warn
  const warnings = [];
  const origWarn = log.warn;
  log.warn = (msg) => warnings.push(msg);

  try {
    const recovered = state.load(stateFile);
    assert.deepEqual(recovered, data1);
    assert.ok(warnings.length > 0);
    assert.match(warnings[0], /corrupted state file/);
    assert.match(warnings[0], /\.bak/);
  } finally {
    log.warn = origWarn;
  }
});

test('state: returns null when both main and backup files are missing or unparseable', () => {
  const missingFile = path.join(tmpRoot, 'missing.json');
  assert.equal(state.load(missingFile), null);

  const badBoth = path.join(tmpRoot, 'bad-both.json');
  fs.writeFileSync(badBoth, '{ broken', 'utf8');
  fs.writeFileSync(badBoth + '.bak', '{ also broken', 'utf8');
  const origWarn = log.warn;
  log.warn = () => {};
  try {
    assert.equal(state.load(badBoth), null);
  } finally {
    log.warn = origWarn;
  }
});

test('ledger: readAll skips corrupted lines and logs warning with line number', () => {
  const ledgerFile = path.join(tmpRoot, 'ledger.jsonl');
  const content = [
    JSON.stringify({ runId: 'run-1', task: 'first task', outcome: 'pass' }),
    'INVALID NOT JSON',
    JSON.stringify({ runId: 'run-2', task: 'second task', outcome: 'fail' }),
    '{ incomplete json',
    JSON.stringify({ runId: 'run-3', task: 'third task', outcome: 'pass' }),
  ].join('\n') + '\n';

  fs.writeFileSync(ledgerFile, content, 'utf8');

  const warnings = [];
  const origWarn = log.warn;
  log.warn = (msg) => warnings.push(msg);

  try {
    const entries = ledger.readAll(ledgerFile);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].runId, 'run-1');
    assert.equal(entries[1].runId, 'run-2');
    assert.equal(entries[2].runId, 'run-3');

    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /skipping corrupted ledger line 2/);
    assert.match(warnings[1], /skipping corrupted ledger line 4/);
  } finally {
    log.warn = origWarn;
  }
});
