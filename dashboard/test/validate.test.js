'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ALLOWLIST_KEYS,
  validatePaneId,
  validateKeys,
  validatePrompt,
  validateLines,
  resolveStaticPath,
} = require('../src/validate');

describe('validatePaneId', () => {
  it('accepts valid pane ids', () => {
    for (const id of ['w1:p1', 'w1W:pA', 'ws_01:pane-99', 'a:b', 'A'.repeat(32) + ':' + '9'.repeat(32)]) {
      const res = validatePaneId(id);
      assert.equal(res.ok, true, `expected ${id} to be valid`);
      assert.equal(res.value, id);
    }
  });

  it('rejects traversal, extra colons, spaces, and bad types', () => {
    const bad = [
      '',
      null,
      undefined,
      123,
      'w1',
      'w1:p1:extra',
      'w1:p1:p2',
      '../w1:p1',
      'w1:../p1',
      'w1/p1:p2',
      'w1:p1;rm',
      'w1:p1 p2',
      ':p1',
      'w1:',
      'A'.repeat(33) + ':p1',
      'w1:' + 'p'.repeat(33),
    ];
    for (const id of bad) {
      const res = validatePaneId(id);
      assert.equal(res.ok, false, `expected ${String(id)} to be rejected`);
    }
  });
});

describe('validateKeys', () => {
  it('accepts every allowlisted key and up to 8 keys', () => {
    for (const key of ALLOWLIST_KEYS) {
      const res = validateKeys([key]);
      assert.equal(res.ok, true, `expected key ${key} to be valid`);
      assert.deepEqual(res.value, [key]);
    }
    const eight = validateKeys(['up', 'up', 'down', 'tab', '1', '9', 'ctrl-c', 'enter']);
    assert.equal(eight.ok, true);
    assert.equal(eight.value.length, 8);
  });

  it('rejects rm, ctrl-z, empty, non-arrays, and over 8 keys', () => {
    assert.equal(validateKeys(['rm']).ok, false);
    assert.equal(validateKeys(['ctrl-z']).ok, false);
    assert.equal(validateKeys(['']).ok, false);
    assert.equal(validateKeys([]).ok, false);
    assert.equal(validateKeys('enter').ok, false);
    assert.equal(validateKeys(null).ok, false);
    assert.equal(validateKeys(['enter', 'rm']).ok, false);
    assert.equal(validateKeys(new Array(9).fill('enter')).ok, false);
  });
});

describe('validatePrompt', () => {
  it('accepts valid prompts including newlines and tabs up to 4000 chars', () => {
    assert.equal(validatePrompt('hello world').ok, true);
    assert.equal(validatePrompt('line 1\n\tline 2\r\n').ok, true);
    assert.equal(validatePrompt('x'.repeat(4000)).ok, true);
  });

  it('rejects empty, over 4000 chars, non-strings, and control characters', () => {
    assert.equal(validatePrompt('').ok, false);
    assert.equal(validatePrompt('   \n\t  ').ok, false);
    assert.equal(validatePrompt(null).ok, false);
    assert.equal(validatePrompt(42).ok, false);
    assert.equal(validatePrompt('x'.repeat(4001)).ok, false);
    assert.equal(validatePrompt('abc\x00def').ok, false);
    assert.equal(validatePrompt('abc\x1b[31mred').ok, false);
    assert.equal(validatePrompt('abc\x07bell').ok, false);
    assert.equal(validatePrompt('abc\x7fdel').ok, false);
    assert.equal(validatePrompt('abc\x9bcsi').ok, false);
  });
});

describe('validateLines', () => {
  it('defaults to 40, caps at 120, and rejects non-positive inputs', () => {
    assert.deepEqual(validateLines(undefined), { ok: true, value: 40 });
    assert.deepEqual(validateLines(''), { ok: true, value: 40 });
    assert.deepEqual(validateLines('25'), { ok: true, value: 25 });
    assert.deepEqual(validateLines('120'), { ok: true, value: 120 });
    assert.deepEqual(validateLines('500'), { ok: true, value: 120 });
    assert.equal(validateLines('0').ok, false);
    assert.equal(validateLines('-5').ok, false);
    assert.equal(validateLines('abc').ok, false);
  });
});

describe('resolveStaticPath', () => {
  it('resolves valid files and refuses .., absolute paths, and symlink escapes', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-dash-static-'));
    try {
      const rootDir = path.join(tmpBase, 'site');
      const outsideDir = path.join(tmpBase, 'outside');
      fs.mkdirSync(path.join(rootDir, 'sub'), { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      const indexFile = path.join(rootDir, 'index.html');
      const subFile = path.join(rootDir, 'sub', 'app.js');
      const secretFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(indexFile, '<h1>ok</h1>');
      fs.writeFileSync(subFile, 'console.log(1);');
      fs.writeFileSync(secretFile, 'top-secret');

      fs.symlinkSync(secretFile, path.join(rootDir, 'escape-file.txt'));
      fs.symlinkSync(outsideDir, path.join(rootDir, 'escape-dir'));
      fs.symlinkSync(subFile, path.join(rootDir, 'inside-link.js'));

      assert.equal(resolveStaticPath(rootDir, ''), fs.realpathSync(indexFile));
      assert.equal(resolveStaticPath(rootDir, 'index.html'), fs.realpathSync(indexFile));
      assert.equal(resolveStaticPath(rootDir, 'sub/app.js'), fs.realpathSync(subFile));
      assert.equal(resolveStaticPath(rootDir, 'inside-link.js'), fs.realpathSync(subFile));

      // Refuses ..
      assert.equal(resolveStaticPath(rootDir, '../outside/secret.txt'), null);
      assert.equal(resolveStaticPath(rootDir, 'sub/../../outside/secret.txt'), null);
      assert.equal(resolveStaticPath(rootDir, '..'), null);

      // Refuses absolute paths
      assert.equal(resolveStaticPath(rootDir, '/etc/passwd'), null);
      assert.equal(resolveStaticPath(rootDir, secretFile), null);
      assert.equal(resolveStaticPath(rootDir, '/index.html'), null);

      // Refuses symlink escapes
      assert.equal(resolveStaticPath(rootDir, 'escape-file.txt'), null);
      assert.equal(resolveStaticPath(rootDir, 'escape-dir/secret.txt'), null);

      // Refuses null bytes and backslashes
      assert.equal(resolveStaticPath(rootDir, 'index.html\0.png'), null);
      assert.equal(resolveStaticPath(rootDir, 'sub\\app.js'), null);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
