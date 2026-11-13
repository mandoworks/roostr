'use strict';
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-config-'));
const file = path.join(dir, 'config.json');
const savedConfig = process.env.CREW_BOARD_CONFIG;
const savedModels = process.env.CREW_BOARD_MODELS;
const savedSummary = process.env.CREW_BOARD_SUMMARY;
process.env.CREW_BOARD_CONFIG = file;
process.env.CREW_BOARD_SUMMARY = path.join(dir, 'summary.json');
delete process.env.CREW_BOARD_MODELS;

const config = require('../src/config');
const advisor = require('../src/advisor');
const board = require('../src/board');
const ui = require('../src/ui');
ui.setColor(false);

test.after(() => {
  if (savedConfig === undefined) delete process.env.CREW_BOARD_CONFIG;
  else process.env.CREW_BOARD_CONFIG = savedConfig;
  if (savedModels === undefined) delete process.env.CREW_BOARD_MODELS;
  else process.env.CREW_BOARD_MODELS = savedModels;
  if (savedSummary === undefined) delete process.env.CREW_BOARD_SUMMARY;
  else process.env.CREW_BOARD_SUMMARY = savedSummary;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('config: defaults when the file is missing', () => {
  const { config: c, warnings } = config.loadConfig();
  assert.deepEqual(warnings, []);
  assert.deepEqual(c.tools, ['claude']);
  assert.equal(c.defaultTool, 'claude');
  assert.equal(c.headName, 'auto');
  assert.equal(c.headLanguage, 'en');
  assert.deepEqual(c.models, {});
  assert.equal(c.roles['head-honcho'].effort, 'high');
  assert.deepEqual(c.taskKinds.docs, { tool: '', model: '', fallbacks: [], effort: '' });
});

test('config: round trip writes mode 0600 and reads back', () => {
  const next = config.defaultConfig();
  next.tools = ['claude', 'opencode'];
  next.defaultTool = 'opencode';
  next.headName = 'shogun';
  next.headLanguage = 'es';
  next.models = { fast: 'fast-x', balanced: 'balanced-x', reasoning: 'reason-x' };
  next.roles.worker.tool = 'opencode';
  const saved = config.saveConfig(next);
  assert.deepEqual(saved.warnings, []);
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
  const { config: back } = config.loadConfig();
  assert.deepEqual(back.tools, ['claude', 'opencode']);
  assert.equal(back.defaultTool, 'opencode');
  assert.equal(back.headName, 'shogun');
  assert.equal(back.headLanguage, 'es');
  assert.equal(back.models.fast, 'fast-x');
  assert.equal(back.roles.worker.tool, 'opencode');
  assert.equal(back.roles.worker.model, 'balanced-x', 'a role with no model follows its tier');
});

test('config: an unknown tool is dropped to customTools with a warning', () => {
  const { config: c, warnings } = config.normalize({ tools: ['claude', 'mytool'] });
  assert.deepEqual(c.tools, ['claude']);
  assert.deepEqual(c.customTools, ['mytool']);
  assert.ok(warnings.some((w) => /unknown tool "mytool"/.test(w)));
});

test('config: invalid values fall back with warnings', () => {
  const { config: c, warnings } = config.normalize({
    headName: 'Bad Name',
    headLanguage: 'xx',
    models: 'nope',
    roles: { worker: { tool: 'ghost', effort: 'turbo', args: 'no' } },
  });
  assert.equal(c.headName, 'auto');
  assert.equal(c.headLanguage, 'en');
  assert.deepEqual(c.models, {});
  assert.equal(c.roles.worker.tool, 'claude');
  assert.equal(c.roles.worker.effort, 'medium');
  assert.deepEqual(c.roles.worker.args, []);
  assert.ok(warnings.length >= 3);
});

test('config: advisor reads the tier map from config and honors disabledModels', () => {
  const next = config.defaultConfig();
  next.models = { fast: 'fast-x', balanced: 'balanced-x', reasoning: 'reason-x' };
  config.saveConfig(next);
  let rec = advisor.recommend('update the readme typos');
  assert.equal(rec.recommendedTier, 'fast');
  assert.equal(rec.recommendedModel, 'fast-x');
  assert.equal(rec.modelWarning, null);

  next.disabledModels = ['fast-x'];
  config.saveConfig(next);
  rec = advisor.recommend('update the readme typos');
  assert.equal(rec.recommendedModel, null);
  assert.equal(rec.modelWarning, 'configure an available model');
});

test('config: the setup screen renders at 80 columns and saves', () => {
  const st = board.setupState(config.defaultConfig());
  const lines = board.setupLines(st, 80);
  assert.ok(lines.length <= 24, `setup fits 24 rows, got ${lines.length}`);
  for (const line of lines) assert.ok(line.length <= 80);
  assert.ok(lines.some((l) => /\[x\]claude/.test(l)));
  assert.ok(lines.some((l) => /task docs/.test(l)));
  assert.ok(lines.some((l) => /task feature/.test(l)));
  assert.ok(lines.some((l) => /head name/.test(l)));
  assert.ok(lines.some((l) => /random boss title/.test(l)));
  assert.ok(lines.some((l) => /language/.test(l)));
  assert.ok(lines.some((l) => /save/.test(l)));
  // Walk to Save and press Enter.
  st.row = board.SETUP_ROWS.indexOf('save');
  assert.deepEqual(board.setupKey(st, '\r'), { save: true });
  assert.equal(board.setupReady(st), true);
  const saved = config.saveConfig(st.config);
  assert.equal(saved.config.tools.includes('claude'), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
});

test('config: task kind settings normalize, cap fallbacks and merge project overrides', () => {
  const { config: c, warnings } = config.normalize({
    tools: ['claude', 'opencode'],
    taskKinds: {
      docs: { tool: 'opencode', model: 'docs-model', fallbacks: ['a', 'a', 'b', 'c', 'd', 'e', 'f'], effort: 'high' },
      ghost: { effort: 'low' },
    },
  });
  assert.equal(c.taskKinds.docs.tool, 'opencode');
  assert.equal(c.taskKinds.docs.model, 'docs-model');
  assert.deepEqual(c.taskKinds.docs.fallbacks, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(c.taskKinds.docs.effort, 'high');
  assert.ok(warnings.some((w) => /unknown task kind \"ghost\"/.test(w)));

  const merged = config.mergeTaskKinds(c.taskKinds, { docs: { model: 'project-model', fallbacks: ['x'] } });
  assert.equal(merged.docs.tool, 'opencode');
  assert.equal(merged.docs.model, 'project-model');
  assert.deepEqual(merged.docs.fallbacks, ['x']);
  assert.equal(merged.docs.effort, 'high');
});
