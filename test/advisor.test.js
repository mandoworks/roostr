'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const advisor = require('../src/advisor');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-advisor-'));
const defaultSummary = path.join(tmpRoot, 'missing-summary.json');
const defaultModels = path.join(tmpRoot, 'missing-models.json');
process.env.ROOSTR_CONFIG = path.join(tmpRoot, 'missing-config.json');
delete process.env.CREW_BOARD_CONFIG;
process.env.CREW_BOARD_SUMMARY = defaultSummary;
process.env.CREW_BOARD_MODELS = defaultModels;

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function configForTest() {
  return require('../src/config').defaultConfig();
}

function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('advisor: detectKind categorizes task patterns accurately', () => {
  assert.equal(advisor.detectKind('update README and fix formatting typos'), 'docs');
  assert.equal(advisor.detectKind('write unit tests and test fixtures'), 'tests');
  assert.equal(advisor.detectKind('build blender animation pipeline script'), 'tooling');
  assert.equal(advisor.detectKind('audit diff and security review'), 'review');
  assert.equal(advisor.detectKind('fix concurrency race condition in engine core'), 'complex');
  assert.equal(advisor.detectKind('implement user authentication profile modal'), 'feature');
});

test('advisor: every archetype returns its neutral tier and effort', () => {
  const expected = {
    docs: ['fast', 'low'],
    review: ['balanced', 'medium'],
    tests: ['balanced', 'medium'],
    tooling: ['balanced', 'medium'],
    complex: ['reasoning', 'high'],
    feature: ['balanced', 'medium'],
  };
  const tasks = {
    docs: 'update README and fix formatting typos',
    review: 'audit diff and security review',
    tests: 'write unit tests and test fixtures',
    tooling: 'build blender animation pipeline script',
    complex: 'fix concurrency race condition in engine core',
    feature: 'implement user authentication profile modal',
  };
  for (const [kind, [tier, effort]] of Object.entries(expected)) {
    const rec = advisor.recommend(tasks[kind]);
    assert.equal(rec.kind, kind);
    assert.equal(rec.recommendedTier, tier);
    assert.equal(rec.recommendedEffort, effort);
    assert.equal(rec.recommendedModel, null);
    assert.equal(rec.source, 'default');
    assert.equal(rec.samples, 0);
    assert.equal(rec.confidence, 'low');
  }
});

test('advisor: recommend flags over-provisioned effort on rote tasks', () => {
  const rec = advisor.recommend('clean up css comments and formatting', 'high', 'any-heavy-model');
  assert.equal(rec.kind, 'docs');
  assert.equal(rec.recommendedEffort, 'low');
  assert.match(rec.advisory, /reduce effort to low/);
});

test('advisor: recommend flags under-provisioned effort on complex tasks', () => {
  const rec = advisor.recommend('debug deadlock and concurrency race in state sync', 'low', 'any-model');
  assert.equal(rec.kind, 'complex');
  assert.equal(rec.recommendedEffort, 'high');
  assert.match(rec.advisory, /increase effort to high/);
});

test('advisor: model advisory is neutral and only uses a supplied map', () => {
  const mapFile = path.join(tmpRoot, 'models-advisory.json');
  fs.writeFileSync(mapFile, JSON.stringify({ fast: 'fast-model' }));
  withEnv({ CREW_BOARD_MODELS: mapFile }, () => {
    const rec = advisor.recommend('update README.md copy', 'low', 'heavy-model');
    assert.equal(rec.kind, 'docs');
    assert.match(rec.advisory, /switch to the fast tier/);
  });
  withEnv({ CREW_BOARD_MODELS: defaultModels }, () => {
    const rec = advisor.recommend('update README.md copy', 'low', 'heavy-model');
    assert.equal(rec.advisory, null);
  });
});

test('advisor: recommend produces null advisory when effort and model match well', () => {
  const rec = advisor.recommend('write unit tests for login session', 'medium', 'any-model');
  assert.equal(rec.advisory, null);
});

test('advisor: recommend never uses the ledger best model as the model choice', () => {
  const summaryFile = path.join(tmpRoot, 'summary-best-model.json');
  fs.writeFileSync(summaryFile, JSON.stringify({
    by_kind: {
      complex: { count: 3, first_try_pass_rate: 100, best_model: 'ledger-best', by_effort: {}, by_model: {} },
    },
  }));
  withEnv({ CREW_BOARD_SUMMARY: summaryFile, CREW_BOARD_MODELS: defaultModels }, () => {
    const rec = advisor.recommend('fix concurrency race condition');
    assert.equal(rec.kind, 'complex');
    assert.equal(rec.recommendedTier, 'reasoning');
    assert.equal(rec.recommendedModel, null);
    assert.equal(rec.empirical.bestModel, 'ledger-best');
    assert.equal(rec.modelStats.best.model, 'ledger-best');
  });
});

test('advisor: no mapping means no recommended model', () => {
  const rec = advisor.recommend('format markdown files');
  assert.equal(rec.recommendedModel, null);
  assert.equal(rec.modelStats.configured, null);
});

test('advisor: a temp mapping file supplies a model per tier', () => {
  const mapFile = path.join(tmpRoot, 'models-all.json');
  fs.writeFileSync(mapFile, JSON.stringify({ fast: 'fast-model', balanced: 'balanced-model', reasoning: 'reasoning-model' }));
  withEnv({ CREW_BOARD_MODELS: mapFile }, () => {
    assert.equal(advisor.recommend('format markdown files').recommendedModel, 'fast-model');
    assert.equal(advisor.recommend('implement a profile modal').recommendedModel, 'balanced-model');
    assert.equal(advisor.recommend('fix concurrency race condition').recommendedModel, 'reasoning-model');
  });
});

test('advisor: a mapping with only balanced leaves the other tiers null', () => {
  const mapFile = path.join(tmpRoot, 'models-balanced.json');
  fs.writeFileSync(mapFile, JSON.stringify({ balanced: 'balanced-model' }));
  withEnv({ CREW_BOARD_MODELS: mapFile }, () => {
    assert.equal(advisor.recommend('format markdown files').recommendedModel, null);
    assert.equal(advisor.recommend('implement a profile modal').recommendedModel, 'balanced-model');
    assert.equal(advisor.recommend('fix concurrency race condition').recommendedModel, null);
  });
});

test('advisor: a broken or non object mapping yields null without a throw', () => {
  const broken = path.join(tmpRoot, 'models-broken.json');
  fs.writeFileSync(broken, '{not json');
  const array = path.join(tmpRoot, 'models-array.json');
  fs.writeFileSync(array, JSON.stringify(['fast-model']));
  const isNull = path.join(tmpRoot, 'models-null.json');
  fs.writeFileSync(isNull, 'null');
  for (const file of [broken, array, isNull]) {
    withEnv({ CREW_BOARD_MODELS: file }, () => {
      assert.doesNotThrow(() => advisor.recommend('format markdown files'));
      assert.equal(advisor.recommend('format markdown files').recommendedModel, null);
    });
  }
});

test('advisor: a mapping file change refreshes by mtime', () => {
  const mapFile = path.join(tmpRoot, 'models-mtime.json');
  fs.writeFileSync(mapFile, JSON.stringify({ fast: 'first-model' }));
  withEnv({ CREW_BOARD_MODELS: mapFile }, () => {
    assert.equal(advisor.recommend('format markdown files').recommendedModel, 'first-model');
    fs.writeFileSync(mapFile, JSON.stringify({ fast: 'second-model' }));
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(mapFile, future, future);
    assert.equal(advisor.recommend('format markdown files').recommendedModel, 'second-model');
  });
});

test('advisor: the ledger chooses the lowest effort with an 80 percent pass rate', () => {
  const summaryFile = path.join(tmpRoot, 'summary-effort.json');
  fs.writeFileSync(summaryFile, JSON.stringify({
    by_kind: {
      docs: {
        count: 5,
        first_try_pass_rate: 100,
        best_model: 'fast-model',
        by_effort: {
          low: { count: 0, first_try_pass_rate: null },
          medium: { count: 5, first_try_pass_rate: 100 },
          high: { count: 0, first_try_pass_rate: null },
        },
        by_model: { 'fast-model': { count: 5, first_try_pass_rate: 100, avg_cost_usd: 0.1, avg_rework: 0 } },
      },
    },
  }));
  withEnv({ CREW_BOARD_SUMMARY: summaryFile, CREW_BOARD_MODELS: defaultModels }, () => {
    const rec = advisor.recommend('format markdown files');
    assert.equal(rec.recommendedTier, 'balanced');
    assert.equal(rec.recommendedEffort, 'medium');
    assert.equal(rec.source, 'ledger');
    assert.equal(rec.samples, 5);
    assert.equal(rec.confidence, 'medium');
  });
});

test('advisor: a chosen effort under 60 percent bumps one level', () => {
  const summaryFile = path.join(tmpRoot, 'summary-bump.json');
  fs.writeFileSync(summaryFile, JSON.stringify({
    by_kind: {
      docs: {
        count: 5,
        first_try_pass_rate: 50,
        best_model: 'fast-model',
        by_effort: {
          low: { count: 5, first_try_pass_rate: 50 },
          medium: { count: 0, first_try_pass_rate: null },
          high: { count: 0, first_try_pass_rate: null },
        },
        by_model: {},
      },
    },
  }));
  withEnv({ CREW_BOARD_SUMMARY: summaryFile }, () => {
    const rec = advisor.recommend('format markdown files');
    assert.equal(rec.recommendedTier, 'balanced');
    assert.equal(rec.recommendedEffort, 'medium');
  });
});

test('advisor: parseArgs parses task and flags correctly', () => {
  assert.deepEqual(advisor.parseArgs(['fix bug', '--effort', 'high', '--model', 'model-x', '--json']), {
    task: 'fix bug',
    effort: 'high',
    model: 'model-x',
    kind: null,
    json: true,
  });
  assert.deepEqual(advisor.parseArgs(['--help']), { help: true });
});

test('advisor: main runs cleanly and returns 0 with the tier output', () => {
  const savedLog = console.log;
  const logs = [];
  console.log = (msg) => logs.push(msg);
  try {
    const code = advisor.main(['format markdown files', '--effort', 'high']);
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes('task:')));
    assert.ok(logs.some((l) => l.includes('tier fast · effort low')));
    assert.ok(logs.some((l) => l.includes('reduce effort')));
  } finally {
    console.log = savedLog;
  }
});

test('advisor: JSON output includes recommendedTier', () => {
  const mapFile = path.join(tmpRoot, 'models-json.json');
  fs.writeFileSync(mapFile, JSON.stringify({ balanced: 'balanced-model' }));
  const savedLog = console.log;
  const logs = [];
  console.log = (msg) => logs.push(msg);
  try {
    withEnv({ CREW_BOARD_MODELS: mapFile }, () => {
      const code = advisor.main(['implement a profile modal', '--json']);
      assert.equal(code, 0);
    });
    const rec = JSON.parse(logs[0]);
    assert.equal(rec.recommendedTier, 'balanced');
    assert.equal(rec.recommendedModel, 'balanced-model');
  } finally {
    console.log = savedLog;
  }
});

test('advisor: recommend with no task argument returns 2 (usage error)', () => {
  const savedLog = console.log;
  console.log = () => {};
  try {
    const code = advisor.main([]);
    assert.equal(code, 2);
  } finally {
    console.log = savedLog;
  }
});

test('advisor: loadSummary uses CREW_BOARD_SUMMARY and caches by mtime', () => {
  const summaryFile = path.join(tmpRoot, 'summary-cache.json');
  process.env.CREW_BOARD_SUMMARY = summaryFile;
  try {
    const initial = { by_kind: { docs: { count: 5, first_try_pass_rate: 90, best_model: 'fast-model' } } };
    fs.writeFileSync(summaryFile, JSON.stringify(initial));

    const s1 = advisor.loadSummary();
    assert.equal(s1.by_kind.docs.count, 5);

    const s2 = advisor.loadSummary();
    assert.equal(s2, s1);

    const updated = { by_kind: { docs: { count: 10, first_try_pass_rate: 95, best_model: 'fast-model' } } };
    const future = new Date(Date.now() + 2000);
    fs.writeFileSync(summaryFile, JSON.stringify(updated));
    fs.utimesSync(summaryFile, future, future);

    const s3 = advisor.loadSummary();
    assert.equal(s3.by_kind.docs.count, 10);
  } finally {
    process.env.ROOSTR_CONFIG = path.join(tmpRoot, 'missing-config.json');
delete process.env.CREW_BOARD_CONFIG;
process.env.CREW_BOARD_SUMMARY = defaultSummary;
  }
});

test('advisor: a task kind pins effort and model without silently substituting', () => {
  const c = configForTest();
  c.taskKinds.docs = { tool: 'opencode', model: 'docs-primary', fallbacks: ['docs-backup', 'docs-third'], effort: 'high' };
  c.disabledModels = ['docs-primary'];
  const rec = advisor.recommend('update the readme', 'low', 'old-model', { config: c });
  assert.equal(rec.kind, 'docs');
  assert.equal(rec.recommendedEffort, 'high');
  assert.equal(rec.recommendedTier, 'reasoning');
  assert.equal(rec.source, 'task-kind');
  assert.equal(rec.recommendedModel, null);
  assert.equal(rec.preferredModel, 'docs-primary');
  assert.equal(rec.requiresModelChoice, true);
  assert.equal(rec.modelWarning, 'configure an available model');
  assert.deepEqual(rec.fallbacks, ['docs-backup', 'docs-third']);
  assert.deepEqual(rec.availableFallbacks, ['docs-backup', 'docs-third']);
  assert.equal(rec.recommendedTool, 'opencode');
});

test('advisor: --kind overrides detection and project overrides merge over global', () => {
  const c = configForTest();
  c.taskKinds.tests = { tool: '', model: '', fallbacks: [], effort: 'low' };
  const rec = advisor.recommend('fix the login flow', null, null, {
    config: c,
    kind: 'tests',
    crew: { taskKinds: { tests: { effort: 'high', fallbacks: ['fallback-a'] } } },
  });
  assert.equal(rec.kind, 'tests');
  assert.equal(rec.recommendedEffort, 'high');
  assert.deepEqual(rec.fallbacks, ['fallback-a']);
});
