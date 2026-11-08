'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-tasks-'));
const savedSummary = process.env.CREW_BOARD_SUMMARY;
process.env.CREW_BOARD_SUMMARY = path.join(tmpRoot, 'missing-summary.json');

const tasks = require('../src/tasks');
const config = require('../src/config');

test.after(() => {
  if (savedSummary === undefined) delete process.env.CREW_BOARD_SUMMARY;
  else process.env.CREW_BOARD_SUMMARY = savedSummary;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('tasks: a valid list validates and keeps optional fields', () => {
  const out = tasks.validate({
    version: 1,
    plan: 'docs/orchestration-plan.md',
    tasks: [{
      id: 'board-settings',
      title: 'Add task settings',
      kind: 'feature',
      brief: 'docs/orchestration/tasks/board-settings.md',
      report: 'docs/orchestration/reports/board-settings.md',
      owns: ['src/board.js'],
      depends_on: [],
      status: 'pending',
      effort: 'medium',
      model: 'model-a',
      fallbacks: ['model-b'],
    }],
  });
  assert.deepEqual(out.errors, []);
  assert.equal(out.plan, 'docs/orchestration-plan.md');
  assert.equal(out.tasks[0].id, 'board-settings');
  assert.deepEqual(out.tasks[0].owns, ['src/board.js']);
  assert.deepEqual(out.tasks[0].fallbacks, ['model-b']);
});

test('tasks: schema, owners and dependsOn aliases are accepted', () => {
  const out = tasks.validate({
    schema: 1,
    tasks: [{
      id: 'a', title: 'x', kind: 'docs', brief: 'a', report: 'b', owners: ['tomas'], dependsOn: [],
    }],
  });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.tasks[0].owns, ['tomas']);
  assert.deepEqual(out.tasks[0].depends_on, []);
});

test('tasks: bad ids, kinds and dependencies are errors', () => {
  const out = tasks.validate({
    tasks: [
      { id: 'Bad ID', title: 'x', kind: 'nope', brief: 'a', report: 'b' },
      { id: 'ok', title: 'x', kind: 'docs', brief: 'a', report: 'b', depends_on: ['missing'] },
    ],
  });
  assert.ok(out.errors.some((e) => /lowercase letters/.test(e)));
  assert.ok(out.errors.some((e) => /kind must be one of/.test(e)));
  assert.ok(out.errors.some((e) => /unknown task/.test(e)));
});

test('tasks: enrich recommends per kind and task-file overrides win', () => {
  const checked = tasks.validate({
    plan: 'plan.md',
    tasks: [{
      id: 'look',
      title: 'fix the lighting and shadows',
      kind: 'complex',
      brief: 'b.md',
      report: 'r.md',
      tool: 'opencode',
      effort: 'low',
      model: 'primary',
      fallbacks: ['backup'],
    }],
  });
  const rows = tasks.enrich(checked, { config: config.defaultConfig() });
  const rec = rows[0].recommendation;
  assert.equal(rec.kind, 'complex');
  assert.equal(rec.recommendedEffort, 'low');
  assert.equal(rec.recommendedTier, 'fast');
  assert.equal(rec.source, 'task-file');
  assert.equal(rec.recommendedTool, 'opencode');
  assert.equal(rec.toolSource, 'task-file');
  assert.equal(rec.recommendedModel, 'primary');
  assert.deepEqual(rec.fallbacks, ['backup']);
});

test('tasks: the CLI prints a table and rejects a broken file', () => {
  const file = path.join(tmpRoot, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify({
    plan: 'plan.md',
    tasks: [{ id: 'docs-1', title: 'update the readme', kind: 'docs', brief: 'b.md', report: 'r.md' }],
  }));
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  const logs = [];
  const errs = [];
  process.stdout.write = (m) => { logs.push(String(m)); return true; };
  process.stderr.write = (m) => { errs.push(String(m)); return true; };
  try {
    assert.equal(tasks.main(['--file', file]), 0);
    assert.match(logs.join('\n'), /docs-1/);
    assert.match(logs.join('\n'), /effort/);
    fs.writeFileSync(file, '{not json');
    assert.equal(tasks.main(['--file', file]), 1);
    assert.match(errs.join('\n'), /(roostr|crew-board) tasks/);
  } finally {
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
  }
});
