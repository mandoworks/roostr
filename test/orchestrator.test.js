'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const orchestrator = require('../src/orchestrator');
const config = require('../src/config');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-orch-'));
const savedConfig = process.env.CREW_BOARD_CONFIG;
process.env.CREW_BOARD_CONFIG = path.join(dir, 'config.json');

test.after(() => {
  if (savedConfig === undefined) delete process.env.CREW_BOARD_CONFIG;
  else process.env.CREW_BOARD_CONFIG = savedConfig;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nextName: head name plus project, then -2 and -3 on collision', () => {
  assert.equal(orchestrator.nextName([], 'la-jefa', 'crew-board'), 'la-jefa-crew-board');
  assert.equal(orchestrator.nextName([{ name: 'la-jefa-crew-board' }], 'la-jefa', '/tmp/crew-board'), 'la-jefa-crew-board-2');
  assert.equal(orchestrator.nextName([{ name: 'la-jefa-crew-board' }, { name: 'la-jefa-crew-board-2' }], 'la-jefa', 'crew-board'), 'la-jefa-crew-board-3');
});

test('shellPanes: shell panes in the home workspace only', () => {
  const snapshot = {
    panes: [
      { pane_id: 'w1:p1', workspace_id: 'w1', label: 'shell', cwd: '/tmp/app' },
      { pane_id: 'w1:p2', workspace_id: 'w1', cwd: '/tmp/app' },
      { pane_id: 'w2:p1', workspace_id: 'w2', cwd: '/tmp/other' },
    ],
  };
  const agents = [{ pane_id: 'w1:p2', name: 'api' }];
  assert.deepEqual(orchestrator.shellPanes(snapshot, agents, 'w1'), [
    { paneId: 'w1:p1', label: 'shell', cwd: '/tmp/app' },
  ]);
  assert.deepEqual(orchestrator.shellPanes(snapshot, agents, null), []);
});

test('prompt: the Head Honcho template, no workers on start', () => {
  const prompt = orchestrator.prompt('la-jefa-crew-board');
  assert.match(prompt, /docs\/orchestration-plan\.md/);
  assert.match(prompt, /Do not start/);
  assert.match(prompt, /la-jefa-crew-board/);
});

test('resolveRole: reads the head-honcho role, else the defaults', () => {
  const c = config.defaultConfig();
  c.defaultTool = 'claude';
  c.roles['head-honcho'] = { tool: 'opencode', model: 'reason-x', effort: 'high', args: ['--x'] };
  assert.deepEqual(orchestrator.resolveRole(c), { tool: 'opencode', model: 'reason-x', effort: 'high', args: ['--x'] });
  const empty = config.defaultConfig();
  assert.deepEqual(orchestrator.resolveRole(empty), { tool: 'claude', model: '', effort: 'high', args: [] });
});

test('roleArgs: opencode gets --model and never --variant', () => {
  const args = orchestrator.roleArgs({ model: 'fast-x', args: ['--variant', 'low', '--verbose'] }, 'opencode');
  assert.deepEqual(args, ['--verbose', '--model', 'fast-x']);
  assert.ok(!args.includes('--variant'));
  const kept = orchestrator.roleArgs({ model: 'fast-x', args: ['--variant=low', '--keep'] }, 'claude');
  assert.deepEqual(kept, ['--variant=low', '--keep']);
  assert.deepEqual(orchestrator.roleArgs({ model: 'fast-x', args: ['--model', 'other'] }, 'opencode'), ['--model', 'other']);
});

test('projectName: the home pane cwd basename, else the fallback', () => {
  const snapshot = { panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', cwd: '/tmp/My App' }] };
  assert.equal(orchestrator.projectName(snapshot, 'w1', '/fallback'), 'my-app');
  assert.equal(orchestrator.projectName({ panes: [] }, 'w1', '/tmp/fallback'), 'fallback');
});

test('resolveRole: the secretary role resolves independently', () => {
  const c = config.defaultConfig();
  c.roles.secretary = { tool: 'opencode', model: 'fast-x', effort: 'low', args: [] };
  assert.deepEqual(orchestrator.resolveRole(c, 'secretary'), {
    tool: 'opencode', model: 'fast-x', effort: 'low', args: [],
  });
});

test('secretaryPrompt: renders the secretary template with the drawn name', () => {
  const prompt = orchestrator.secretaryPrompt('valeria');
  assert.match(prompt, /valeria/);
  assert.match(prompt, /role is `secretary`/);
});

test('secretaryName: workspace scoped display and safe Herdr name', () => {
  assert.deepEqual(orchestrator.secretaryName('example-app'), {
    agent: 'secretary-example-app', display: 'Secretary - example-app',
  });
  assert.equal(orchestrator.secretaryName('example *restored').agent, 'secretary-example-restored');
  assert.ok(orchestrator.secretaryName('x'.repeat(80)).agent.length <= 32);
  assert.equal(orchestrator.secretaryName('example *restored').display, 'Secretary - example *restored');
});
