'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const analytics = require('../src/analytics');
const report = require('../src/report');
const statusEvent = require('../scripts/status-event');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-analytics-'));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('analytics: confidenceForSamples thresholds', () => {
  assert.equal(analytics.confidenceForSamples(0), 'low');
  assert.equal(analytics.confidenceForSamples(2), 'low');
  assert.equal(analytics.confidenceForSamples(3), 'medium');
  assert.equal(analytics.confidenceForSamples(9), 'medium');
  assert.equal(analytics.confidenceForSamples(10), 'high');
  assert.equal(analytics.confidenceForSamples(50), 'high');
});

test('analytics: normalizeSample skips malformed items and preserves null cost', () => {
  assert.equal(analytics.normalizeSample(null), null);
  assert.equal(analytics.normalizeSample('bad'), null);
  assert.equal(analytics.normalizeSample({}), null); // Missing pane

  const s = analytics.normalizeSample({
    at: '2026-11-07T00:00:00Z',
    pane: 'w1:p1',
    model: 'unknown-model',
    tokens: 500,
    cost: null,
  });
  assert.equal(s.pane, 'w1:p1');
  assert.equal(s.cost, null);
  assert.equal(s.isEstimate, false);
});

test('analytics: derives cost from pricing when missing but inputs are present', () => {
  const s = analytics.normalizeSample({
    at: '2026-11-07T00:00:00Z',
    pane: 'w1:p1',
    model: 'gemini-3.8-flash',
    input: 1000000,
    output: 1000000,
    cost: null,
  });
  // gemini-3.8-flash default rate: input 0.75, output 3.75 -> 4.50
  assert.ok(s.cost !== null);
  assert.equal(s.cost, 4.5);
  assert.equal(s.isEstimate, true);
});

test('analytics: analyzeByModel groups, sums tokens, and preserves null costs', () => {
  const samples = [
    { at: 1000, pane: 'w1:p1', model: 'gemini-3.8-flash', tokens: 1000, cost: 0.05, isEstimate: false },
    { at: 2000, pane: 'w1:p2', model: 'gemini-3.8-flash', tokens: 2000, cost: 0.10, isEstimate: true },
    { at: 3000, pane: 'w1:p3', model: 'claude-3-5-sonnet', tokens: 500, cost: null, isEstimate: false },
  ];
  const ledgerEntries = [
    { model: 'gemini-3.8-flash', outcome: 'pass', rework: 0 },
    { model: 'gemini-3.8-flash', outcome: 'fail', rework: 1 },
  ];

  const result = analytics.analyzeByModel(samples, ledgerEntries);
  assert.equal(result.length, 2);

  const gemini = result.find((r) => r.model === 'gemini-3.8-flash');
  assert.ok(gemini);
  assert.equal(gemini.samples, 2);
  assert.equal(gemini.tokens, 3000);
  assert.equal(gemini.cost, 0.15);
  assert.equal(gemini.is_estimate, true);
  assert.equal(gemini.runs, 2);
  assert.equal(gemini.first_try_pass_rate, 50.0);

  const claude = result.find((r) => r.model === 'claude-3-5-sonnet');
  assert.ok(claude);
  assert.equal(claude.cost, null); // Missing cost stays null end to end
});

test('analytics: analyzeByKind tests archetype grouping, runs, pass/fail counts, rework, and cost sums', () => {
  const ledgerEntries = [
    { kind: 'feature', outcome: 'pass', rework: 0, cost: 0.25 },
    { kind: 'feature', outcome: 'fail', rework: 2, cost: 0.15 },
    { kind: 'feature', outcome: 'blocked', rework: 1, cost: 0.10 },
    { kind: 'docs', outcome: 'pass', rework: 0, cost: null },
    { kind: 'docs', outcome: 'pass', rework: 1, cost: 0.05 },
  ];

  const result = analytics.analyzeByKind([], ledgerEntries);
  assert.equal(result.length, 2);

  const feature = result.find((r) => r.kind === 'feature');
  assert.ok(feature);
  assert.equal(feature.runs, 3);
  assert.equal(feature.pass, 1);
  assert.equal(feature.fail, 1);
  assert.equal(feature.blocked, 1);
  assert.equal(feature.first_try_pass_rate, 33.3);
  assert.equal(feature.avg_rework, 1.0);
  assert.equal(feature.cost, 0.5);

  const docs = result.find((r) => r.kind === 'docs');
  assert.ok(docs);
  assert.equal(docs.runs, 2);
  assert.equal(docs.pass, 2);
  assert.equal(docs.fail, 0);
  assert.equal(docs.blocked, 0);
  assert.equal(docs.first_try_pass_rate, 100.0);
  assert.equal(docs.avg_rework, 0.5);
  assert.equal(docs.cost, 0.05);
});

test('analytics: analyzeByPane captures pane costs and outcome metrics', () => {
  const samples = [
    { at: 1000, pane: 'w1:p1', model: 'gemini-3.8-flash', tokens: 5000, cost: 0.05, isEstimate: false },
  ];
  const ledgerEntries = [
    { paneId: 'w1:p1', outcome: 'pass', rework: 0, durationMs: 4000 },
    { paneId: 'w1:p1', outcome: 'pass', rework: 1, durationMs: 6000 },
  ];

  const result = analytics.analyzeByPane(samples, ledgerEntries);
  const p1 = result.find((r) => r.pane === 'w1:p1');
  assert.ok(p1);
  assert.equal(p1.samples, 1);
  assert.equal(p1.tokens, 5000);
  assert.equal(p1.cost, 0.05);
  assert.equal(p1.runs, 2);
  assert.equal(p1.pass, 2);
  assert.equal(p1.first_try_pass_rate, 100.0);
  assert.equal(p1.avg_duration_ms, 5000);
});

test('analytics: analyzeBatchTimeline correlates task, spawn, transitions, and usage', () => {
  const tasksData = {
    tasks: [
      { id: 'T1', title: 'Task 1', kind: 'feature', pane: 'w1:p1' },
      { id: 'T2', title: 'Task 2', kind: 'test', pane: 'w1:p2' },
    ],
  };
  const ledgerEntries = [
    { event: 'spawn', task: 'T1', paneId: 'w1:p1', at: '2026-11-07T01:00:00Z' },
    { event: 'outcome', task: 'T1', paneId: 'w1:p1', at: '2026-11-07T01:10:00Z', outcome: 'pass', durationMs: 600000, cost: 0.12 },
  ];
  const transitions = [
    { pane: 'w1:p1', status: 'working', at: '2026-11-07T01:00:00Z' },
    { pane: 'w1:p1', status: 'blocked', at: '2026-11-07T01:05:00Z' },
    { pane: 'w1:p1', status: 'done', at: '2026-11-07T01:10:00Z' },
  ];
  const samples = [
    { pane: 'w1:p1', at: Date.parse('2026-11-07T01:05:00Z'), tokens: 12000, cost: 0.12, isEstimate: false },
  ];

  const timeline = analytics.analyzeBatchTimeline(tasksData, ledgerEntries, transitions, samples);
  assert.equal(timeline.length, 2);

  const t1 = timeline.find((t) => t.id === 'T1');
  assert.ok(t1);
  assert.equal(t1.status, 'pass');
  assert.equal(t1.duration_ms, 600000);
  assert.equal(t1.cost, 0.12);
  assert.equal(t1.transitions.length, 3);
  assert.equal(t1.transitions[1].status, 'blocked');

  const t2 = timeline.find((t) => t.id === 'T2');
  assert.ok(t2);
  assert.equal(t2.status, 'pending');
});

test('analytics: query and CLI formatText execute without throw', () => {
  const result = analytics.query({
    now: Date.parse('2026-11-07T12:00:00Z'),
    days: 7,
    by: 'model',
    samples: [
      { at: '2026-11-07T10:00:00Z', pane: 'w1:p1', model: 'gemini-3.8-flash', tokens: 100, cost: 0.01 },
    ],
    ledger: [],
    transitions: [],
  });

  assert.equal(result.by, 'model');
  assert.equal(result.data.length, 1);

  const textOutput = analytics.formatText(result);
  assert.ok(textOutput.includes('gemini-3.8-flash'));
  assert.ok(textOutput.includes('$0.0100'));
});

test('report: append failure isolation ensures writeReport does not throw on append error', () => {
  const badUsagePath = path.join(tmpRoot, 'unwritable-dir', 'sub', 'usage.jsonl');
  // Make parent an unwritable file so mkdir fails
  const blocker = path.join(tmpRoot, 'unwritable-dir');
  fs.writeFileSync(blocker, 'blocking file');

  const savedUsage = process.env.CREW_BOARD_USAGE;
  process.env.CREW_BOARD_USAGE = path.join(blocker, 'usage.jsonl');

  try {
    // writeReport must succeed even though appendUsage will throw
    const res = report.writeReport('w9:p9', { model: 'test-model', tokens: 123 });
    assert.equal(res.pane, 'w9:p9');
  } finally {
    process.env.CREW_BOARD_USAGE = savedUsage;
  }
});
