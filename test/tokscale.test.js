'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/tokscale');

test('parse: total and per session counts, junk ignored', () => {
  const json = JSON.stringify({
    totalCost: 41.2,
    entries: [
      { client: 'claude', sessionId: 's1', model: 'a', input: 10, output: 5, cacheRead: 100, cacheWrite: 7, reasoning: 1, cost: 1.5 },
      { client: 'claude', sessionId: 's1', model: 'b', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0.5 },
      { client: 'opencode', sessionId: 's2', input: 'lots', cost: 2 },
      { model: 'no session' },
      null,
    ],
  });
  assert.deepEqual(parse(json, 5), {
    at: 5,
    total: 41.2,
    sessions: {
      s1: { client: 'claude', input: 11, output: 6, cacheRead: 100, cacheWrite: 7, reasoning: 1, cost: 2 },
      s2: { client: 'opencode', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 2 },
    },
    clients: {
      claude: { input: 11, output: 6, cacheRead: 100, cacheWrite: 7, reasoning: 1, cost: 2, sessions: 1 },
      opencode: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 2, sessions: 1 },
    },
    models: {
      a: { input: 10, output: 5, cacheRead: 100, cacheWrite: 7, reasoning: 1, cost: 1.5, sessions: 1, clients: ['claude'] },
      b: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0.5, sessions: 1, clients: ['claude'] },
    },
  });
  assert.equal(parse('not json', 5), null);
  assert.equal(parse('{"entries":[]}', 5), null);
});

test('parse: a warning line before the JSON is skipped', () => {
  assert.equal(parse('warning: cache rebuilt\n{"totalCost":3,"entries":[]}', 1).total, 3);
});

test('today: one run at a time, every 5 minutes, junk keeps the last good result, a new day starts empty', () => {
  const { today } = require('../src/tokscale');
  const calls = [];
  const run = (cmd, argv, opts, cb) => {
    calls.push({ cmd, argv, opts, cb });
    return null;
  };
  const day = new Date(2026, 9, 23, 10, 0, 0).getTime();
  assert.equal(today(day, run), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'nice');
  assert.deepEqual(calls[0].argv.slice(0, 3), ['-n', '10', 'tokscale']);
  assert.equal(calls[0].opts.timeout, 60000);
  today(day + 1000, run);
  assert.equal(calls.length, 1, 'still running');
  calls[0].cb(null, '{"totalCost":12.5,"entries":[]}');
  assert.equal(today(day + 2000, run).total, 12.5);
  assert.equal(calls.length, 1, 'not due for 5 minutes');
  today(day + 5 * 60 * 1000, run);
  assert.equal(calls.length, 2);
  calls[1].cb(null, 'garbage');
  assert.equal(today(day + 5 * 60 * 1000 + 1, run).total, 12.5, 'junk keeps the last result');
  calls.length = 0;
  const tomorrow = new Date(2026, 9, 24, 0, 1, 0).getTime();
  assert.equal(today(tomorrow, run), null, 'yesterday is not today');
  calls[0].cb(new Error('timeout'), '');
});

test('parseHourly: tokens and cost per hour, junk skipped', () => {
  const { parseHourly } = require('../src/tokscale');
  const json = JSON.stringify({ entries: [
    { hour: '2026-10-23 09:00', input: 10, output: 5, cacheRead: 80, cacheWrite: 5, cost: 1.25 },
    { hour: '2026-10-23 10:00', input: 1, cost: 'x' },
    { hour: 'soon' },
    null,
  ] });
  assert.deepEqual(parseHourly(json), { '09': { tokens: 100, cost: 1.25 }, 10: { tokens: 1, cost: 0 } });
  assert.equal(parseHourly('nope'), null);
});

test('hourly: one run per client, one after the other, every 30 minutes', () => {
  const { hourly } = require('../src/tokscale');
  const calls = [];
  const run = (cmd, argv, opts, cb) => {
    calls.push({ argv, cb });
    return null;
  };
  const day = new Date(2026, 9, 23, 11, 0, 0).getTime();
  assert.equal(hourly(day, [], run), null, 'nothing to run without clients');
  assert.equal(calls.length, 0);
  assert.equal(hourly(day, ['claude', 'bad name;', 'opencode'], run), null);
  assert.equal(calls.length, 1, 'clients run one at a time');
  assert.deepEqual(calls[0].argv.slice(2), ['tokscale', 'hourly', '--today', '--json', '--no-spinner', '-c', 'claude']);
  calls[0].cb(null, JSON.stringify({ entries: [{ hour: '2026-10-23 09:00', input: 100, cost: 2 }] }));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].argv.slice(-2), ['-c', 'opencode'], 'a name that is not a plain client is skipped');
  calls[1].cb(new Error('timeout'), '');
  const h = hourly(day + 1000, ['claude'], run);
  assert.deepEqual(h.hours, { '09': { claude: { tokens: 100, cost: 2 } } });
  assert.equal(calls.length, 2, 'not due for 30 minutes');
  hourly(day + 30 * 60 * 1000, ['claude'], run);
  assert.equal(calls.length, 3);
});

test('parse: model totals add up across entries, each session counted once, clients kept', () => {
  const json = JSON.stringify({
    totalCost: 6,
    entries: [
      { client: 'claude', sessionId: 's1', model: 'claude-opus-5-5', input: 10, output: 5, cacheRead: 100, cacheWrite: 7, reasoning: 1, cost: 2 },
      { client: 'claude', sessionId: 's1', model: 'claude-opus-5-5', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5, cost: 4 },
      { client: 'opencode', sessionId: 's2', model: 'claude-opus-5-5', input: 7, cost: 0 },
    ],
  });
  assert.deepEqual(parse(json, 1).models, {
    'claude-opus-5-5': {
      input: 18, output: 7, cacheRead: 103, cacheWrite: 11, reasoning: 6, cost: 6,
      sessions: 2, clients: ['claude', 'opencode'],
    },
  });
});
