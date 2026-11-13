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

test('resolveRole: the worker role resolves independently', () => {
  const c = config.defaultConfig();
  c.roles.worker = { tool: 'opencode', model: 'fast-x', effort: 'low', args: [] };
  assert.deepEqual(orchestrator.resolveRole(c, 'worker'), {
    tool: 'opencode', model: 'fast-x', effort: 'low', args: [],
  });
});

test('parseSpawnArgs: parses all flags for execution, reuse, and prompting', () => {
  const args = [
    '--task', 'implement oauth flow',
    '--execute',
    '--reuse', 'w1:p3',
    '--cwd', '/tmp/worktree',
    '--direction', 'down',
    '--prompt', 'Write the oauth handlers',
    '--role', 'worker',
    '--kind', 'opencode',
    '--model', 'nemotron',
    '--effort', 'high',
    '--json',
  ];
  const parsed = orchestrator.parseSpawnArgs(args);
  assert.equal(parsed.task, 'implement oauth flow');
  assert.equal(parsed.execute, true);
  assert.equal(parsed.reuse, 'w1:p3');
  assert.equal(parsed.cwd, '/tmp/worktree');
  assert.equal(parsed.direction, 'down');
  assert.equal(parsed.prompt, 'Write the oauth handlers');
  assert.equal(parsed.role, 'worker');
  assert.equal(parsed.kind, 'opencode');
  assert.equal(parsed.model, 'nemotron');
  assert.equal(parsed.effort, 'high');
  assert.equal(parsed.json, true);
});

test('planSpawn: fresh split plan contains pane split, start, rename, report, ledger steps', () => {
  const plan = orchestrator.planSpawn({
    task: 'audit auth tokens',
    role: 'security',
    kind: 'claude',
    model: 'sonnet-3.7',
    effort: 'high',
    cwd: '/tmp/repo',
    direction: 'right',
    prompt: 'Check token expiration',
  });
  assert.equal(plan.reuse, false);
  assert.equal(plan.role, 'security');
  assert.equal(plan.tool, 'claude');
  assert.equal(plan.model, 'sonnet-3.7');
  assert.equal(plan.direction, 'right');
  assert.equal(plan.prompt, 'Check token expiration');
  assert.ok(Array.isArray(plan.steps));
  const cmds = plan.steps.map((s) => s.cmd);
  assert.deepEqual(cmds, [
    'herdr pane split',
    'herdr agent start',
    'herdr pane rename',
    'roostr report',
    'ledger append',
    'herdr agent wait',
    'herdr agent prompt',
  ]);
});

test('planSpawn: reuse warm pane uses /clear for claude and /new for opencode', () => {
  const claudePlan = orchestrator.planSpawn({
    task: 'run migrations',
    reuse: 'w1:p2',
    name: 'worker-1',
    kind: 'claude',
    prompt: 'Run up migration',
  });
  assert.equal(claudePlan.reuse, true);
  assert.equal(claudePlan.paneId, 'w1:p2');
  assert.deepEqual(claudePlan.steps[0], { cmd: 'herdr agent prompt', args: ['worker-1', '/clear'] });

  const opencodePlan = orchestrator.planSpawn({
    task: 'run migrations',
    reuse: 'w1:p4',
    name: 'worker-2',
    kind: 'opencode',
    prompt: 'Run down migration',
  });
  assert.equal(opencodePlan.reuse, true);
  assert.deepEqual(opencodePlan.steps[0], { cmd: 'herdr agent prompt', args: ['worker-2', '/new'] });
});

test('planSpawn: reads prompt from briefFile when prompt flag is omitted', () => {
  const tmpFile = path.join(dir, 'brief.md');
  fs.writeFileSync(tmpFile, 'Brief content from file', 'utf8');
  const plan = orchestrator.planSpawn({
    task: 'brief task',
    briefFile: tmpFile,
  });
  assert.equal(plan.prompt, 'Brief content from file');
});

test('executeSpawn: fresh pane split executes herdr runner, report and ledger calls', async () => {
  const calls = [];
  const fakeRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'split') {
      return JSON.stringify({ result: { pane_id: 'w1:p99' } });
    }
    return '';
  };
  const reports = [];
  const fakeReport = {
    writeReport: (paneId, data) => reports.push({ paneId, data }),
  };
  const ledgerEntries = [];
  const fakeLedger = {
    spawn: (data) => {
      ledgerEntries.push(data);
      return { runId: 'run-test-123' };
    },
  };

  const res = await orchestrator.executeSpawn(
    {
      task: 'verify build pipeline',
      name: 'builder',
      role: 'ci-worker',
      kind: 'claude',
      model: 'haiku-3.5',
      effort: 'low',
      cwd: '/tmp/build',
      direction: 'down',
      prompt: 'npm test',
    },
    {
      herdrRunner: fakeRunner,
      reportModule: fakeReport,
      ledgerModule: fakeLedger,
    }
  );

  assert.equal(res.success, true);
  assert.equal(res.reused, false);
  assert.equal(res.paneId, 'w1:p99');
  assert.equal(res.name, 'builder');
  assert.equal(res.runId, 'run-test-123');

  // Verify runner calls
  assert.deepEqual(calls[0], ['pane', 'split', '--current', '--direction', 'down', '--cwd', '/tmp/build', '--no-focus']);
  assert.deepEqual(calls[1], ['agent', 'start', 'builder', '--kind', 'claude', '--pane', 'w1:p99', '--']);
  assert.deepEqual(calls[2], ['pane', 'rename', 'w1:p99', 'builder · ci-worker']);
  assert.deepEqual(calls[3], ['agent', 'wait', 'builder', '--state', 'idle', '--timeout', '30']);
  assert.deepEqual(calls[4], ['agent', 'prompt', 'builder', 'npm test']);

  // Verify report and ledger calls
  assert.equal(reports.length, 1);
  assert.equal(reports[0].paneId, 'w1:p99');
  assert.equal(reports[0].data.task, 'verify build pipeline');
  assert.equal(ledgerEntries.length, 1);
  assert.equal(ledgerEntries[0].paneId, 'w1:p99');
});

test('executeSpawn: uses herdr.run when no runner is injected', async () => {
  const herdr = require('../src/herdr');
  const original = herdr.run;
  const calls = [];
  herdr.run = async (args) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'split') return JSON.stringify({ result: { pane_id: 'w1:p77' } });
    return '';
  };
  try {
    const res = await orchestrator.executeSpawn(
      { task: 'default runner', name: 'builder', role: 'worker', kind: 'claude' },
      { reportModule: { writeReport: () => {} }, ledgerModule: { spawn: () => ({ runId: 'r1' }) } },
    );
    assert.equal(res.success, true);
    assert.equal(res.paneId, 'w1:p77');
    assert.deepEqual(calls[0].slice(0, 2), ['pane', 'split']);
  } finally {
    herdr.run = original;
  }
});

test('executeSpawn: warm pane reuse sends resetCmd, waits for idle, prompts and records report', async () => {
  const calls = [];
  const fakeRunner = async (args) => {
    calls.push(args);
    return '';
  };
  const reports = [];
  const fakeReport = {
    writeReport: (paneId, data) => reports.push({ paneId, data }),
  };
  const ledgerEntries = [];
  const fakeLedger = {
    spawn: (data) => {
      ledgerEntries.push(data);
      return { runId: 'run-reuse-456' };
    },
  };

  const res = await orchestrator.executeSpawn(
    {
      task: 'quick check',
      reuse: 'w1:p5',
      name: 'worker-reuse',
      kind: 'opencode',
      prompt: 'git status',
    },
    {
      herdrRunner: fakeRunner,
      reportModule: fakeReport,
      ledgerModule: fakeLedger,
    }
  );

  assert.equal(res.success, true);
  assert.equal(res.reused, true);
  assert.equal(res.paneId, 'w1:p5');
  assert.deepEqual(calls[0], ['agent', 'prompt', 'worker-reuse', '/new']);
  assert.deepEqual(calls[1], ['agent', 'wait', 'worker-reuse', '--state', 'idle', '--timeout', '30']);
  assert.deepEqual(calls[2], ['agent', 'prompt', 'worker-reuse', 'git status']);
  assert.equal(reports[0].paneId, 'w1:p5');
  assert.equal(ledgerEntries[0].paneId, 'w1:p5');
});

test('mainSpawn: prints usage and exits 2 if neither task nor pane is supplied', async () => {
  let stderr = '';
  const origWrite = process.stderr.write;
  process.stderr.write = (chunk) => { stderr += chunk; return true; };
  try {
    const code = await orchestrator.mainSpawn([]);
    assert.equal(code, 2);
    assert.match(stderr, /usage: roostr spawn/);
  } finally {
    process.stderr.write = origWrite;
  }
});

test('mainSpawn: planning mode outputs plan JSON when --json passed without --execute', async () => {
  let stdout = '';
  const origWrite = process.stdout.write;
  process.stdout.write = (chunk) => { stdout += chunk; return true; };
  try {
    const code = await orchestrator.mainSpawn(['--task', 'write tests', '--json']);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.reuse, false);
    assert.ok(Array.isArray(parsed.steps));
  } finally {
    process.stdout.write = origWrite;
  }
});
