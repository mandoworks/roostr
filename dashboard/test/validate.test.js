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
  validatePaneLabel,
  validateAgentName,
  validateAgentKind,
  validateOptionalModel,
  validateOptionalEffort,
  validateOptionalSessionId,
  validateSplitDirection,
  validateMuseMessage,
  resolveStaticPath,
} = require('../src/validate');

describe('validatePaneId', () => {
  it('accepts valid pane ids', () => {
    for (const id of ['w1:p1', 'w1W:pA', 'ws_01:pane-99', '_w1:p1', 'a:b', 'A'.repeat(32) + ':' + '9'.repeat(32)]) {
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
      '--help:p1',
      '-w1:p1',
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

  it('rejects rm, ctrl-z, empty, non-arrays, non-strings, and over 8 keys', () => {
    assert.equal(validateKeys(['rm']).ok, false);
    assert.equal(validateKeys(['ctrl-z']).ok, false);
    assert.equal(validateKeys(['']).ok, false);
    assert.equal(validateKeys([]).ok, false);
    assert.equal(validateKeys('enter').ok, false);
    assert.equal(validateKeys(null).ok, false);
    assert.equal(validateKeys(['enter', 123]).ok, false);
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
    assert.equal(validatePrompt('   \r\n\t  ').ok, false);
    assert.equal(validatePrompt(null).ok, false);
    assert.equal(validatePrompt(42).ok, false);
    assert.equal(validatePrompt('x'.repeat(4001)).ok, false);
    assert.equal(validatePrompt('abc\x00def').ok, false);
    assert.equal(validatePrompt('abc\x08bs').ok, false);
    assert.equal(validatePrompt('abc\x0bvt').ok, false);
    assert.equal(validatePrompt('abc\x0cff').ok, false);
    assert.equal(validatePrompt('abc\x1b[31mred').ok, false);
    assert.equal(validatePrompt('abc\x07bell').ok, false);
    assert.equal(validatePrompt('abc\x7fdel').ok, false);
    assert.equal(validatePrompt('abc\x9bcsi').ok, false);
  });
});

describe('validateLines', () => {
  it('defaults to 40, caps at 120, and rejects non-positive or overflow inputs', () => {
    assert.deepEqual(validateLines(undefined), { ok: true, value: 40 });
    assert.deepEqual(validateLines(null), { ok: true, value: 40 });
    assert.deepEqual(validateLines(''), { ok: true, value: 40 });
    assert.deepEqual(validateLines(15), { ok: true, value: 15 });
    assert.deepEqual(validateLines('25'), { ok: true, value: 25 });
    assert.deepEqual(validateLines('120'), { ok: true, value: 120 });
    assert.deepEqual(validateLines('500'), { ok: true, value: 120 });
    assert.equal(validateLines('   ').ok, false);
    assert.equal(validateLines('0').ok, false);
    assert.equal(validateLines('-5').ok, false);
    assert.equal(validateLines('12.5').ok, false);
    assert.equal(validateLines('9999999999999999999999').ok, false);
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

      // Refuses null bytes, backslashes, missing root, and non-strings
      assert.equal(resolveStaticPath(rootDir, 'index.html\0.png'), null);
      assert.equal(resolveStaticPath(rootDir, 'sub\\app.js'), null);
      assert.equal(resolveStaticPath(path.join(tmpBase, 'missing'), 'index.html'), null);
      assert.equal(resolveStaticPath(rootDir, null), null);
      assert.equal(resolveStaticPath(rootDir, 'sub/'), null);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

describe('validatePaneLabel, validateAgentName, validateAgentKind', () => {
  it('validates pane labels and clears on empty', () => {
    assert.deepEqual(validatePaneLabel('  nora · garden  '), { ok: true, value: 'nora · garden' });
    assert.deepEqual(validatePaneLabel('   '), { ok: true, value: '' });
    assert.deepEqual(validatePaneLabel(''), { ok: true, value: '' });
    assert.deepEqual(validatePaneLabel('x'.repeat(80)), { ok: true, value: 'x'.repeat(80) });
    assert.equal(validatePaneLabel(null).ok, false);
    assert.equal(validatePaneLabel(123).ok, false);
    assert.equal(validatePaneLabel('bad\nline').ok, false);
    assert.equal(validatePaneLabel('bad\rline').ok, false);
    assert.equal(validatePaneLabel('bad\tline').ok, false);
    assert.equal(validatePaneLabel('bad\x7fdel').ok, false);
    assert.equal(validatePaneLabel('-bad').ok, false);
    assert.equal(validatePaneLabel('--clear').ok, false);
    assert.equal(validatePaneLabel('  --clear  ').ok, false);
    assert.equal(validatePaneLabel('x'.repeat(81)).ok, false);
  });

  it('validates agent names and allowlisted kinds', () => {
    assert.deepEqual(validateAgentName('  nora-2_a  '), { ok: true, value: 'nora-2_a' });
    assert.deepEqual(validateAgentName('a'.repeat(32)), { ok: true, value: 'a'.repeat(32) });
    assert.equal(validateAgentName('').ok, false);
    assert.equal(validateAgentName(null).ok, false);
    assert.equal(validateAgentName('-bad').ok, false);
    assert.equal(validateAgentName('_bad').ok, false);
    assert.equal(validateAgentName('Nora').ok, false);
    assert.equal(validateAgentName('a'.repeat(33)).ok, false);
    for (const kind of ['claude', 'opencode', 'kilo', 'agy', 'codex', 'gemini']) {
      assert.deepEqual(validateAgentKind(` ${kind} `), { ok: true, value: kind });
    }
    assert.equal(validateAgentKind('').ok, false);
    assert.equal(validateAgentKind(null).ok, false);
    assert.equal(validateAgentKind('bash').ok, false);
  });
});

describe('validateOptionalModel, validateOptionalEffort, validateOptionalSessionId, validateSplitDirection', () => {
  it('validates optional model strings', () => {
    assert.deepEqual(validateOptionalModel(undefined), { ok: true, value: null });
    assert.deepEqual(validateOptionalModel(null), { ok: true, value: null });
    assert.deepEqual(validateOptionalModel('   '), { ok: true, value: null });
    assert.deepEqual(validateOptionalModel('  claude-sonnet-4-5:latest  '), {
      ok: true,
      value: 'claude-sonnet-4-5:latest',
    });
    assert.deepEqual(validateOptionalModel('ipnext/avocado-5.16-v1'), {
      ok: true,
      value: 'ipnext/avocado-5.16-v1',
    });
    assert.equal(validateOptionalModel(123).ok, false);
    assert.equal(validateOptionalModel('-bad').ok, false);
    assert.equal(validateOptionalModel('bad model').ok, false);
    assert.equal(validateOptionalModel('a'.repeat(81)).ok, false);
  });

  it('validates optional effort allowlist', () => {
    assert.deepEqual(validateOptionalEffort(undefined), { ok: true, value: null });
    assert.deepEqual(validateOptionalEffort(''), { ok: true, value: null });
    for (const eff of ['low', 'medium', 'high', 'xhigh']) {
      assert.deepEqual(validateOptionalEffort(` ${eff} `), { ok: true, value: eff });
    }
    assert.equal(validateOptionalEffort('ultra').ok, false);
    assert.equal(validateOptionalEffort(42).ok, false);
  });

  it('validates optional session id', () => {
    assert.deepEqual(validateOptionalSessionId(undefined), { ok: true, value: null });
    assert.deepEqual(validateOptionalSessionId(''), { ok: true, value: null });
    assert.deepEqual(validateOptionalSessionId(' 669c7ff3-dff5-4366-b0e7-b4b0dba7dcae '), {
      ok: true,
      value: '669c7ff3-dff5-4366-b0e7-b4b0dba7dcae',
    });
    assert.deepEqual(validateOptionalSessionId('sess_1:abc'), { ok: true, value: 'sess_1:abc' });
    assert.equal(validateOptionalSessionId('-bad').ok, false);
    assert.equal(validateOptionalSessionId('bad space').ok, false);
    assert.equal(validateOptionalSessionId('s'.repeat(129)).ok, false);
    assert.equal(validateOptionalSessionId(123).ok, false);
  });

  it('validates split direction with right default', () => {
    assert.deepEqual(validateSplitDirection(undefined), { ok: true, value: 'right' });
    assert.deepEqual(validateSplitDirection(null), { ok: true, value: 'right' });
    assert.deepEqual(validateSplitDirection(''), { ok: true, value: 'right' });
    assert.deepEqual(validateSplitDirection('right'), { ok: true, value: 'right' });
    assert.deepEqual(validateSplitDirection(' down '), { ok: true, value: 'down' });
    assert.equal(validateSplitDirection('left').ok, false);
    assert.equal(validateSplitDirection(123).ok, false);
  });
});

describe('validateMuseMessage', () => {
  it('accepts valid message payloads with default project', () => {
    const res = validateMuseMessage({
      to: 'engy',
      subject: 'Review RAVE copy',
      body: 'Please check slide 3\n\tThanks!',
    });
    assert.deepEqual(res, {
      ok: true,
      value: {
        to: 'engy',
        subject: 'Review RAVE copy',
        body: 'Please check slide 3\n\tThanks!',
        project: 'muse',
        threadId: null,
      },
    });
  });

  it('accepts custom project and threadId and rejects invalid fields', () => {
    const res = validateMuseMessage({
      to: 'buildy-1',
      subject: 'Deploy',
      body: 'Go ahead',
      project: 'roostr',
      threadId: 'thread-42',
    });
    assert.equal(res.ok, true);
    assert.equal(res.value.project, 'roostr');
    assert.equal(res.value.threadId, 'thread-42');

    assert.equal(validateMuseMessage(null).ok, false);
    assert.equal(validateMuseMessage({ to: 'Bad_Slug', subject: 's', body: 'b' }).ok, false);
    assert.equal(validateMuseMessage({ to: 'engy', subject: '', body: 'b' }).ok, false);
    assert.equal(validateMuseMessage({ to: 'engy', subject: 'bad\nsub', body: 'b' }).ok, false);
    assert.equal(validateMuseMessage({ to: 'engy', subject: 'x'.repeat(141), body: 'b' }).ok, false);
    assert.equal(validateMuseMessage({ to: 'engy', subject: 'ok', body: '' }).ok, false);
    assert.equal(validateMuseMessage({ to: 'engy', subject: 'ok', body: 'b'.repeat(16001) }).ok, false);
    assert.equal(validateMuseMessage({ to: 'engy', subject: 'ok', body: 'ok', project: 'BAD' }).ok, false);
    assert.equal(validateMuseMessage({ to: 'engy', subject: 'ok', body: 'ok', threadId: 't'.repeat(81) }).ok, false);
  });
});
