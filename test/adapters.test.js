'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseScreen, hasAdapter } = require('../src/adapters');
const { parseCount, edgeLines } = require('../src/adapters/util');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('claude: statusline footer gives cost, ctx and tokens', () => {
  assert.deepEqual(parseScreen('claude', fx('claude-statusline.txt')), {
    ctx: 18, tokens: 207865 + 501, cost: 2.1655, model: null,
  });
});

test('claude: numbers in the transcript above the input box are ignored', () => {
  // The fixture has "$9.99 | ctx:99%" in the transcript; the footer says 18%.
  const r = parseScreen('claude', fx('claude-statusline.txt'));
  assert.equal(r.ctx, 18);
  assert.equal(r.cost, 2.1655);
});

test('claude: a footer cut by the pane edge stays unknown', () => {
  assert.deepEqual(parseScreen('claude', fx('claude-truncated.txt')), {
    ctx: null, tokens: null, cost: null, model: null,
  });
  assert.deepEqual(parseScreen('claude', fx('claude-narrow.txt')), {
    ctx: 18, tokens: null, cost: 2.1655, model: null,
  });
});

test('claude: stock footer without a statusline has no numbers', () => {
  assert.deepEqual(parseScreen('claude', fx('claude-stock.txt')), {
    ctx: null, tokens: null, cost: null, model: null,
  });
});

test('opencode: a finished message header drops its duration', () => {
  assert.equal(parseScreen('opencode', '     ▣  Build · Example Model 2 Free · 1h 15m\n').model, 'Example Model 2 Free');
});

test('opencode: footer tokens and ctx, model from the last message header', () => {
  assert.deepEqual(parseScreen('opencode', fx('opencode.txt')), {
    ctx: 34, tokens: 340900, cost: null, model: 'Example Model 2 Free',
  });
});

test('kilo reads the opencode footer', () => {
  assert.deepEqual(parseScreen('kilo', fx('opencode.txt')), parseScreen('opencode', fx('opencode.txt')));
});

test('opencode: a clipped percentage still yields tokens, with ctx unknown', () => {
  const screen = '  escctrl+t   90.4K ( ctrl+p\n  intvariants         commands\n';
  assert.deepEqual(parseScreen('kilo', screen), { ctx: null, tokens: 90400, cost: null, model: null });
});

test('opencode: a footer above a side panel still parses', () => {
  const screen = '  ▣  Build · Example Model 2 Free\n  340.9K (34%)\n  │  Subagents  Shell  Terminals\n  │  No active subagents\n';
  assert.deepEqual(parseScreen('opencode', screen), {
    ctx: 34, tokens: 340900, cost: null, model: 'Example Model 2 Free',
  });
});

test('opencode: a bare count in the transcript is ignored', () => {
  assert.equal(parseScreen('opencode', '  we passed 90.4K (\n  still writing\n').tokens, null);
  const prose = '  the wave 2 (pg-backend, contract-tests) is ready\n';
  assert.equal(parseScreen('opencode', prose).tokens, null);
});

test('agy: no usage numbers', () => {
  assert.deepEqual(parseScreen('agy', fx('agy.txt')), { ctx: null, tokens: null, cost: null, model: null });
});

test('agy: reads model from screen footer or banner', () => {
  const footer = '? for shortcuts                                                                 Gemini 3.8 Flash · high\n';
  assert.equal(parseScreen('agy', footer).model, 'Gemini 3.8 Flash');
  assert.equal(parseScreen('agy', footer).effort, 'high');
  const banner = '      ▀▀▀▀▀▀▀▀      Gemini 3.8 Flash (High)\n';
  assert.equal(parseScreen('agy', banner).model, 'Gemini 3.8 Flash');
  assert.equal(parseScreen('agy', banner).effort, 'high');
});

test('agy: a model named in the middle of the transcript is ignored', () => {
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(`assistant line ${i}`);
  rows.push('the transcript mentions Gemini 3.8 Flash in passing');
  for (let i = 0; i < 10; i++) rows.push(`assistant line ${i + 10}`);
  assert.deepEqual(parseScreen('agy', rows.join('\n')), {
    ctx: null, tokens: null, cost: null, model: null,
  });
});

test('agy: a cut footer with no model leaves it null and returns no usage', () => {
  const screen = '? for shortcuts\nGemini\n';
  assert.deepEqual(parseScreen('agy', screen), { ctx: null, tokens: null, cost: null, model: null });
});

test('edgeLines: first and last non empty lines, no duplicates on a short screen', () => {
  assert.equal(edgeLines('a\n\nb\nc\nd\ne\nf\n', 2), 'a\nb\ne\nf');
  assert.equal(edgeLines('a\nb\nc\n', 5), 'a\nb\nc');
  assert.equal(edgeLines('', 6), '');
});

test('unknown agent kinds and empty screens give unknowns', () => {
  assert.equal(hasAdapter('codex'), false);
  assert.deepEqual(parseScreen('codex', fx('opencode.txt')), { ctx: null, tokens: null, cost: null, model: null });
  for (const kind of ['claude', 'opencode', 'kilo', 'agy']) {
    assert.deepEqual(parseScreen(kind, ''), { ctx: null, tokens: null, cost: null, model: null });
  }
});

test('parseCount', () => {
  assert.equal(parseCount('136.7K'), 136700);
  assert.equal(parseCount('1.2M'), 1200000);
  assert.equal(parseCount('5321'), 5321);
  assert.equal(parseCount('12x'), null);
  assert.equal(parseCount(''), null);
});

test('opencode: a side panel on the header row is not part of the model', () => {
  const row = `     ▣  Build · Big Pickle${' '.repeat(80)}so you can start immediately.\n`;
  assert.equal(parseScreen('opencode', row).model, 'Big Pickle');
  assert.equal(parseScreen('opencode', '     ▣  Build · Example Model 2 Free  · 1h 15m\n').model, 'Example Model 2 Free');
});
