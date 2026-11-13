'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const summary = require('../src/summary');
const advisor = require('../src/advisor');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-summary-'));
const now = Date.parse('2026-11-03T12:00:00.000Z');

process.env.ROOSTR_CONFIG = path.join(tmpRoot, 'missing-config.json');
delete process.env.CREW_BOARD_CONFIG;

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const at = (h) => new Date(now - h * 60 * 60 * 1000).toISOString();

const spawn = (runId, kind, tier, effort, model, hours) => ({
  at: at(hours), event: 'spawn', runId, paneId: 'w1:p2', name: 'api', role: 'worker',
  kind, task: 'task', tier, effort, model, recommendedTier: tier, recommendedEffort: effort,
  outcome: null, rework: 0, cost: null, durationMs: null, note: null,
});

const outcome = (runId, result, cost, durationMs, rework, hours) => ({
  at: at(hours), event: 'outcome', runId, outcome: result, rework, cost, durationMs, note: null,
});

const ENTRIES = [
  spawn('r1', 'docs', 'fast', 'low', 'fast-model', 6),
  outcome('r1', 'pass', 0.1, 1000, 0, 5),
  spawn('r2', 'docs', 'fast', 'low', 'fast-model', 5),
  outcome('r2', 'pass', 0.2, 2000, 0, 4),
  spawn('r3', 'docs', 'balanced', 'medium', 'balanced-model', 4),
  outcome('r3', 'fail', 0.4, 3000, 2, 3),
  spawn('r4', 'tests', 'balanced', 'medium', 'balanced-model', 3),
  outcome('r4', 'pass', 0.3, 1500, 1, 2),
  spawn('r5', 'docs', 'fast', 'low', 'fast-model', 2),
  spawn('r6', 'docs', 'fast', 'low', 'fast-model', 1),
  outcome('r6', 'pass', 0.3, 3000, 0, 0.5),
];

test('summary: counts, rates, cost, duration and rework by kind', () => {
  const data = summary.summarize({ entries: ENTRIES, now, days: 30 });
  assert.equal(data.runs, 5);
  assert.equal(data.by_kind.docs.count, 4);
  assert.equal(data.by_kind.docs.first_try_pass_rate, 75);
  assert.equal(data.by_kind.docs.avg_cost_usd, 0.25);
  assert.equal(data.by_kind.docs.avg_duration_ms, 2250);
  assert.equal(data.by_kind.docs.avg_rework, 0.5);
  assert.equal(data.by_kind.tests.count, 1);
  assert.equal(data.by_kind.tests.first_try_pass_rate, 0);
});

test('summary: a spawn with no outcome is excluded', () => {
  const data = summary.summarize({ entries: ENTRIES, now, days: 30 });
  assert.equal(data.runs, 5);
  assert.equal(data.by_kind.docs.by_model['fast-model'].count, 3);
});

test('summary: by_effort, by_tier, by_model and by_kind_model', () => {
  const data = summary.summarize({ entries: ENTRIES, now, days: 30 });
  const docs = data.by_kind.docs;
  assert.deepEqual(docs.by_effort.low, { count: 3, first_try_pass_rate: 100 });
  assert.deepEqual(docs.by_effort.medium, { count: 1, first_try_pass_rate: 0 });
  assert.deepEqual(docs.by_effort.high, { count: 0, first_try_pass_rate: null });
  assert.deepEqual(docs.by_tier.fast, { count: 3, first_try_pass_rate: 100 });
  assert.deepEqual(docs.by_tier.balanced, { count: 1, first_try_pass_rate: 0 });
  assert.equal(docs.by_model['fast-model'].count, 3);
  assert.equal(docs.by_model['fast-model'].first_try_pass_rate, 100);
  assert.equal(docs.by_model['fast-model'].avg_cost_usd, 0.2);
  assert.equal(docs.by_model['balanced-model'].avg_rework, 2);
  assert.equal(docs.best_model, 'fast-model');
  assert.deepEqual(data.by_kind_model.docs['fast-model'], docs.by_model['fast-model']);
});

test('summary: malformed entries are skipped and duplicate outcomes warned', () => {
  const warnings = [];
  const entries = [
    null,
    'not an entry',
    { at: at(0), event: 'spawn', runId: 'x', kind: 'docs', tier: 'fast', effort: 'low', model: 'm' },
    { at: at(0), event: 'outcome', runId: 'x', outcome: 'pass' },
    { at: at(0), event: 'outcome', runId: 'x', outcome: 'fail' },
  ];
  const data = summary.summarize({ entries, now, days: 30, onWarn: (m) => warnings.push(m) });
  assert.equal(data.runs, 1);
  assert.equal(data.by_kind.docs.first_try_pass_rate, 100);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /duplicate outcome/);
});

test('summary: no ledger returns zeros', () => {
  const data = summary.summarize({ entries: [], now, days: 30 });
  assert.equal(data.runs, 0);
  assert.deepEqual(data.by_kind, {});
});

test('summary: --days bounds the aggregation', () => {
  const data = summary.summarize({ entries: ENTRIES, now, days: 2 / 24 });
  assert.equal(data.runs, 1);
  assert.equal(data.by_kind.docs.count, 1);
});

test('summary: main writes the summary file with mode 0600 and --no-write skips it', () => {
  const ledgerFile = path.join(tmpRoot, 'summary-main.jsonl');
  fs.writeFileSync(ledgerFile, ENTRIES.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const outFile = path.join(tmpRoot, 'summary.json');
  const savedLedger = process.env.CREW_BOARD_LEDGER;
  const savedSummary = process.env.CREW_BOARD_SUMMARY;
  const savedLog = console.log;
  process.env.CREW_BOARD_LEDGER = ledgerFile;
  process.env.CREW_BOARD_SUMMARY = outFile;
  console.log = () => {};
  try {
    assert.equal(summary.main(['--json']), 0);
    assert.ok(fs.existsSync(outFile));
    assert.equal(fs.statSync(outFile).mode & 0o777, 0o600);
    const written = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(written.runs, 5);
  } finally {
    console.log = savedLog;
  }

  const noWrite = path.join(tmpRoot, 'summary-nowrite.json');
  process.env.CREW_BOARD_SUMMARY = noWrite;
  console.log = () => {};
  try {
    assert.equal(summary.main(['--json', '--no-write']), 0);
    assert.equal(fs.existsSync(noWrite), false);
  } finally {
    console.log = savedLog;
    if (savedLedger === undefined) delete process.env.CREW_BOARD_LEDGER;
    else process.env.CREW_BOARD_LEDGER = savedLedger;
    if (savedSummary === undefined) delete process.env.CREW_BOARD_SUMMARY;
    else process.env.CREW_BOARD_SUMMARY = savedSummary;
  }
});

test('summary: the written summary drives the advisor tier and effort', () => {
  const outFile = path.join(tmpRoot, 'summary-advisor.json');
  const entries = [];
  for (let i = 0; i < 5; i++) {
    const id = `a${i}`;
    entries.push({
      at: at(10 - i), event: 'spawn', runId: id, kind: 'docs', tier: 'fast', effort: 'low', model: 'fast-model',
    });
    entries.push({ at: at(9 - i), event: 'outcome', runId: id, outcome: 'pass', rework: 0, cost: 0.1, durationMs: 1000 });
  }
  summary.writeSummary(summary.summarize({ entries, now, days: 30 }), outFile);
  const savedSummary = process.env.CREW_BOARD_SUMMARY;
  const savedModels = process.env.CREW_BOARD_MODELS;
  process.env.CREW_BOARD_SUMMARY = outFile;
  process.env.CREW_BOARD_MODELS = path.join(tmpRoot, 'missing-models.json');
  try {
    const rec = advisor.recommend('format markdown files');
    assert.equal(rec.recommendedTier, 'fast');
    assert.equal(rec.recommendedEffort, 'low');
    assert.equal(rec.source, 'ledger');
    assert.equal(rec.samples, 5);
  } finally {
    if (savedSummary === undefined) delete process.env.CREW_BOARD_SUMMARY;
    else process.env.CREW_BOARD_SUMMARY = savedSummary;
    if (savedModels === undefined) delete process.env.CREW_BOARD_MODELS;
    else process.env.CREW_BOARD_MODELS = savedModels;
  }
});

const globalRow = (over) => ({
  date: '2026-11-03', project: 'example-app', task: 'task', model: 'sonnet',
  effort: 'high', kind: 'code', outcome: 'pass', rework: 0, cost_usd: null, notes: null,
  ...over,
});

const capture = (fn) => {
  const out = [];
  const err = [];
  const savedLog = console.log;
  const savedError = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = fn();
    return { code, out, err };
  } finally {
    console.log = savedLog;
    console.error = savedError;
  }
};

test('summary: a global row is one finished run and first try needs a clean pass', () => {
  const entries = [
    globalRow({ cost_usd: 0.2 }),
    globalRow({ model: 'flash', outcome: 'pass', rework: 1, cost_usd: 0.1 }),
    globalRow({ model: 'flash', effort: 'low', outcome: 'partial' }),
    globalRow({ kind: 'docs', effort: 'medium', model: 'flash', outcome: 'pass', cost_usd: 0.05 }),
  ];
  const data = summary.summarize({ entries, now, days: 30 });
  assert.equal(data.runs, 4);
  assert.equal(data.by_kind.code.count, 3);
  assert.equal(data.by_kind.code.first_try_pass_rate, 33.3);
  assert.deepEqual(data.by_kind.code.by_effort.high, { count: 2, first_try_pass_rate: 50 });
  assert.deepEqual(data.by_kind.code.by_effort.low, { count: 1, first_try_pass_rate: 0 });
  assert.deepEqual(data.by_kind.code.by_tier.reasoning, { count: 2, first_try_pass_rate: 50 });
  assert.deepEqual(data.by_kind.code.by_tier.fast, { count: 1, first_try_pass_rate: 0 });
  assert.equal(data.by_kind.code.by_model.sonnet.first_try_pass_rate, 100);
  assert.equal(data.by_kind.code.by_model.flash.count, 2);
  assert.equal(data.by_kind.code.best_model, 'sonnet');
  assert.deepEqual(data.by_kind_effort.code.high, { count: 2, first_try_pass_rate: 50 });
  assert.equal(data.by_kind_model.code.sonnet.count, 1);
  assert.deepEqual(data.by_kind_model_effort.code.sonnet.high, { count: 1, first_try_pass_rate: 100 });
  assert.deepEqual(data.by_kind_model_effort.code.flash.high, { count: 1, first_try_pass_rate: 0 });
  assert.equal(data.by_model.sonnet.count, 1);
  assert.deepEqual(data.by_effort.high, { count: 2, first_try_pass_rate: 50 });
  assert.deepEqual(data.by_tier.reasoning, { count: 2, first_try_pass_rate: 50 });
});

test('summary: an unknown effort is kept honest instead of guessed', () => {
  const entries = [
    globalRow({ model: 'a', effort: 'default', kind: 'code' }),
    globalRow({ model: 'b', effort: 'med', kind: 'code' }),
    globalRow({ model: 'c', effort: 'high', kind: 'code' }),
  ];
  const data = summary.summarize({ entries, now, days: 30 });
  assert.equal(data.by_kind.code.count, 3);
  assert.equal(data.by_kind.code.by_effort.high.count, 1);
  assert.equal(data.by_kind.code.by_effort.medium.count, 0);
  assert.equal(data.by_kind.code.by_effort.unknown.count, 2);
});

test('summary: --from reads a file, skips a malformed line with a warning and never writes it', () => {
  const file = path.join(tmpRoot, 'global.jsonl');
  const text = [JSON.stringify(globalRow({ cost_usd: 0.2 })), '{bad json', JSON.stringify(globalRow({ kind: 'docs' }))].join('\n') + '\n';
  fs.writeFileSync(file, text);
  const before = fs.readFileSync(file, 'utf8');
  const result = capture(() => summary.main(['--from', file, '--json', '--no-write']));
  assert.equal(result.code, 0);
  assert.match(result.err.join('\n'), /line 2: malformed JSON/);
  const data = JSON.parse(result.out.join('\n'));
  assert.equal(data.runs, 2);
  assert.ok(data.by_kind.code);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('summary: --from a missing path is an error and a missing value is a usage error', () => {
  const missing = path.join(tmpRoot, 'nope.jsonl');
  const bad = capture(() => summary.main(['--from', missing, '--no-write']));
  assert.equal(bad.code, 1);
  assert.match(bad.err.join('\n'), /no such file/);
  const usage = capture(() => summary.main(['--from', '--no-write']));
  assert.equal(usage.code, 2);
});

test('summary: --from writes the summary with mode 0600 unless --no-write', () => {
  const file = path.join(tmpRoot, 'global-write.jsonl');
  const outFile = path.join(tmpRoot, 'global-summary.json');
  fs.writeFileSync(file, JSON.stringify(globalRow()) + '\n');
  const savedSummary = process.env.CREW_BOARD_SUMMARY;
  process.env.CREW_BOARD_SUMMARY = outFile;
  try {
    const result = capture(() => summary.main(['--from', file, '--json']));
    assert.equal(result.code, 0);
    assert.ok(fs.existsSync(outFile));
    assert.equal(fs.statSync(outFile).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(outFile, 'utf8')).runs, 1);
  } finally {
    if (savedSummary === undefined) delete process.env.CREW_BOARD_SUMMARY;
    else process.env.CREW_BOARD_SUMMARY = savedSummary;
  }
});

test('summary: --days filters a global row by date when present', () => {
  const entries = [
    globalRow({ date: '2026-01-01', kind: 'old' }),
    globalRow({ date: '2026-11-02', kind: 'new' }),
    globalRow({ date: null, kind: 'undated' }),
  ];
  const data = summary.summarize({ entries, now, days: 30 });
  assert.equal(data.runs, 2);
  assert.equal(data.by_kind.old, undefined);
  assert.equal(data.by_kind.new.count, 1);
  assert.equal(data.by_kind.undated.count, 1);
});

test('summary: accepted is pass, abandoned is fail, and text rework never crashes', () => {
  const entries = [
    globalRow({ outcome: 'accepted', rework: 0 }),
    globalRow({ outcome: 'abandoned', rework: 0 }),
    globalRow({ outcome: 'accepted', rework: 'none' }),
    globalRow({ outcome: 'accepted', rework: 'lead: fixed comments' }),
    globalRow({ outcome: 'partial', rework: 0 }),
    globalRow({ outcome: 'rework', rework: 'lead: another pass needed' }),
  ];
  const data = summary.summarize({ entries, now, days: 30 });
  assert.equal(data.runs, 6);
  assert.equal(data.by_kind.code.first_try_pass_rate, 33.3);
  assert.equal(data.by_kind.code.avg_rework, 0.33);
  assert.deepEqual(data.by_model.sonnet, {
    count: 6,
    first_try_pass_rate: 33.3,
    avg_cost_usd: null,
    avg_duration_ms: null,
    avg_rework: 0.33,
  });
});

test('summary: the real batch shape reports 95.5% first try on 22 tasks', () => {
  const entries = Array.from({ length: 22 }, (_, i) => globalRow({
    model: 'explabs/deepseek-v4.1-flash-1017',
    kind: 'code',
    outcome: i === 21 ? 'abandoned' : 'accepted',
    rework: 0,
  }));
  const data = summary.summarize({ entries, now, days: 30 });
  const model = data.by_model['explabs/deepseek-v4.1-flash-1017'];
  assert.equal(model.count, 22);
  assert.equal(model.first_try_pass_rate, 95.5);
});
