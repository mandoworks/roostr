'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const recover = require('../src/recover');

test('recover: a plain allow prompt is safe', () => {
  const v = recover.classifyScreen('Allow this command? [Yes] [No]');
  assert.equal(v.action, 'allow');
  assert.equal(v.safe, true);
});

test('recover: a destructive prompt is refused', () => {
  for (const text of [
    'Allow command: git push origin main?',
    'Approve delete of 30 files?',
    'Permission: install package?',
    'Continue with DROP TABLE?',
  ]) {
    const v = recover.classifyScreen(text);
    assert.equal(v.safe, false, text);
    assert.match(v.reason, /destructive|privileged/);
  }
});

test('recover: a continue prompt is recognized', () => {
  const v = recover.classifyScreen('Session paused. Continue?');
  assert.equal(v.action, 'continue');
  assert.equal(v.safe, true);
});

test('recover: no prompt means no action', () => {
  const v = recover.classifyScreen('Build failed. See the log.');
  assert.equal(v.action, null);
  assert.equal(v.safe, false);
  assert.equal(recover.classifyScreen('').action, null);
});

test('recover: ANSI codes do not hide the prompt text', () => {
  const v = recover.classifyScreen('\x1b[31mAllow\x1b[0m this command?');
  assert.equal(v.action, 'allow');
  assert.equal(v.safe, true);
});
