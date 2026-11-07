'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-prices-'));
const previous = process.env.CREW_BOARD_PRICES;
process.env.CREW_BOARD_PRICES = path.join(dir, 'prices.json');
const pricing = require('../src/pricing');

test.after(() => {
  if (previous === undefined) delete process.env.CREW_BOARD_PRICES;
  else process.env.CREW_BOARD_PRICES = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('estimate: Gemini 3.8 Flash uses input and output API rates', () => {
  const e = pricing.estimate('Gemini 3.8 Flash', { input: 100000, output: 10000 });
  assert.equal(e.cost, 0.1125);
  assert.equal(e.rate.input, 0.75);
  assert.equal(e.rate.output, 3.75);
});

test('estimate: Gemini 4 Argon rates', () => {
  const e = pricing.estimate('gemini-4-argon', { input: 1000000, output: 1000000 });
  assert.equal(e.cost, 12);
});

test('estimate: unknown model or partial token split returns null', () => {
  assert.equal(pricing.estimate('claude-opus-5-5', { input: 1, output: 1 }), null);
  assert.equal(pricing.estimate('Gemini 3.8 Flash', { input: 1000 }), null);
  assert.equal(pricing.estimate('Gemini 3.8 Flash', { input: 0, output: 0 }), null);
});

test('estimate: prices.json override merges over the default rate', () => {
  fs.writeFileSync(process.env.CREW_BOARD_PRICES, JSON.stringify({ 'Gemini 3.8 Flash': { output: 5 } }));
  const e = pricing.estimate('Gemini 3.8 Flash', { input: 1000000, output: 1000000 });
  assert.equal(e.cost, 5.75);
  fs.writeFileSync(process.env.CREW_BOARD_PRICES, '{bad json');
  assert.equal(pricing.estimate('Gemini 3.8 Flash', { input: 1000000, output: 0 }).cost, 0.75);
});

test('estimate: an unchanged prices file is read once, a change is picked up', () => {
  const file = process.env.CREW_BOARD_PRICES;
  fs.writeFileSync(file, JSON.stringify({ 'Gemini 3.8 Flash': { output: 5 } }));
  const read = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (name, ...args) {
    if (String(name) === file) reads++;
    return read.call(this, name, ...args);
  };
  try {
    assert.equal(pricing.estimate('Gemini 3.8 Flash', { input: 1000000, output: 1000000 }).cost, 5.75);
    const first = reads;
    assert.equal(pricing.estimate('Gemini 3.8 Flash', { input: 1000000, output: 1000000 }).cost, 5.75);
    assert.equal(reads, first, 'no second read for the same mtime');
    fs.writeFileSync(file, JSON.stringify({ 'Gemini 3.8 Flash': { output: 6, note: 'changed' } }));
    assert.equal(pricing.estimate('Gemini 3.8 Flash', { input: 1000000, output: 1000000 }).cost, 6.75);
    assert.ok(reads > first, 'a changed file is read again');
  } finally {
    fs.readFileSync = read;
  }
});
