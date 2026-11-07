'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../src/ui');

test('clip keeps SGR and drops every other escape, even when the line fits', () => {
  const dirty = 'a\x1b[2Jb\x1b]0;x\x07c';
  const out = ui.clip(dirty, 10);
  assert.equal(out, 'abc');
  assert.ok(!out.includes('\x1b[2J'));
  assert.ok(!out.includes('\x1b]'));

  const red = '\x1b[31mred\x1b[0m';
  assert.equal(ui.clip(red, 10), red);

  assert.equal(ui.clip('a\x1b[2Ab', 10), 'ab', 'cursor moves go too');
});

test('clean removes invisible format characters and keeps joiners', () => {
  assert.equal(ui.clean('a\u202eb\u2066c\u200bd'), 'abcd');
  assert.equal(ui.clean('\ufeffx\u200ey\u2060z'), 'xyz');
  assert.equal(ui.clean('👨\u200d👩'), '👨\u200d👩');
  assert.equal(ui.clean('a\u200cb'), 'a\u200cb');
});

test('strWidth counts zero width characters as zero', () => {
  assert.equal(ui.strWidth('a\u200bb'), 2);
  assert.equal(ui.strWidth('a\u200db'), 2);
  assert.equal(ui.strWidth('a\ufeffb'), 2);
});

test('strWidth: emoji drawn two cells wide count as two', () => {
  const ui = require('../src/ui');
  assert.equal(ui.strWidth('⚡'), 2);
  assert.equal(ui.strWidth('⚡ 7.8×'), 7);
  assert.equal(ui.strWidth('✅❌⭐'), 6);
  assert.equal(ui.strWidth('🚀'), 2);
  assert.equal(ui.strWidth('⚠'), 1, 'text presentation symbols stay one cell');
  assert.equal(ui.strWidth('◼✓'), 2);
});
