'use strict';
// Shared helpers for starting the Head Honcho, and for the agent start args
// every role uses. Pure functions here; the board owns the live picker.

const fs = require('fs');
const path = require('path');
const config = require('./config');
const templates = require('./templates');
const names = require('./names');
const advisor = require('./advisor');
const herdr = require('./herdr');
const report = require('./report');
const ledger = require('./ledger');

const TASK = 'grilling the crew plan';
const ROLE = 'head-honcho';
const DEFAULT_HEAD_NAME = 'la-jefa';
const PLAN = 'docs/orchestration-plan.md';

function projectSlug(project) {
  const base = path.basename(String(project || '').replace(/\\/g, '/')) || 'crew';
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return slug || 'crew';
}

// The agent name is the chosen head name plus the project, then -2, -3 on a
// collision. The pane label uses the same name so the row, label and task line
// all agree.
function nextName(agents, headName, project) {
  const head = typeof headName === 'string' && headName.trim() ? headName.trim() : DEFAULT_HEAD_NAME;
  const slug = projectSlug(project);
  const base = `${head}-${slug}`;
  const used = new Set((agents || []).map((a) => (typeof a === 'string' ? a : a && a.name)).filter(Boolean));
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const name = `${base}-${n}`;
    if (!used.has(name)) return name;
  }
  return `${base}-999`;
}

// Panes in the home workspace that are not live agents.
function shellPanes(snapshot, agents, home) {
  if (!home || !snapshot || !Array.isArray(snapshot.panes)) return [];
  const live = new Set((agents || []).map((a) => a && a.pane_id).filter(Boolean));
  return snapshot.panes
    .filter((p) => p && p.pane_id && p.workspace_id === home && !live.has(p.pane_id))
    .map((p) => ({ paneId: p.pane_id, label: p.label || null, cwd: p.cwd || null }));
}

function projectName(snapshot, home, fallback) {
  const pane = snapshot && Array.isArray(snapshot.panes)
    ? snapshot.panes.find((p) => p && p.workspace_id === home && p.cwd)
    : null;
  return projectSlug(pane && pane.cwd ? pane.cwd : fallback);
}

function prompt(name) {
  return templates.render(ROLE, { name, plan: PLAN });
}

function resolveRole(cfg = null, roleKey = ROLE) {
  const c = cfg || config.loadConfig().config;
  const role = c.roles && c.roles[roleKey] ? c.roles[roleKey] : {};
  const fallbackEffort = roleKey === ROLE ? 'high' : 'medium';
  return {
    tool: role.tool || c.defaultTool || 'claude',
    model: role.model || '',
    effort: role.effort || fallbackEffort,
    args: Array.isArray(role.args) ? role.args.slice() : [],
  };
}

// Opencode accepts --model but not --variant. Any --variant the user put in
// the config is dropped here, because the TUI versions tested reject it. The
// effort is still recorded in the report, never claimed as an internal variant.
function roleArgs(role, kind) {
  const args = Array.isArray(role && role.args) ? role.args.slice() : [];
  if (kind !== 'opencode') return args;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--variant') {
      i++;
      continue;
    }
    if (String(args[i]).startsWith('--variant=')) continue;
    out.push(args[i]);
  }
  if (role && role.model && !out.includes('--model')) out.push('--model', role.model);
  return out;
}

function flagVal(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}

function parseSpawnArgs(argv) {
  const o = {
    pane: flagVal(argv, '--pane'),
    task: flagVal(argv, '--task'),
    role: flagVal(argv, '--role') || 'worker',
    name: flagVal(argv, '--name') || null,
    kind: flagVal(argv, '--kind') || flagVal(argv, '--tool') || null,
    tier: flagVal(argv, '--tier') || null,
    effort: flagVal(argv, '--effort') || null,
    model: flagVal(argv, '--model') || null,
    crew: flagVal(argv, '--crew') || null,
    reuse: flagVal(argv, '--reuse') || null,
    cwd: flagVal(argv, '--cwd') || null,
    direction: flagVal(argv, '--direction') || 'right',
    prompt: flagVal(argv, '--prompt') || null,
    briefFile: flagVal(argv, '--brief-file') || null,
    language: flagVal(argv, '--language') || 'en',
    execute: argv.includes('--execute'),
    json: argv.includes('--json'),
  };
  return o;
}

function planSpawn(opts = {}) {
  const task = opts.task || 'unassigned task';
  const role = opts.role || 'worker';
  const rec = advisor.recommend(task, opts.effort || null, opts.model || null, {
    kind: opts.kind || null,
    crew: opts.crew || null,
  });

  const tool = opts.kind || rec.kind || 'claude';
  const model = opts.model || rec.recommendedModel || '';
  const effort = opts.effort || rec.recommendedEffort || 'medium';
  const tier = opts.tier || rec.recommendedTier || 'balanced';

  let name = opts.name;
  if (!name) {
    const drawn = names.draw({ count: 1, language: opts.language || 'en' });
    name = (drawn && drawn[0]) ? drawn[0] : 'worker';
  }

  const resetCmd = tool === 'opencode' ? '/new' : '/clear';
  let promptText = opts.prompt || null;
  if (!promptText && opts.briefFile && fs.existsSync(opts.briefFile)) {
    try {
      promptText = fs.readFileSync(opts.briefFile, 'utf8');
    } catch {}
  }

  const steps = [];
  if (opts.reuse) {
    const paneId = opts.reuse;
    steps.push({ cmd: 'herdr agent prompt', args: [name, resetCmd] });
    steps.push({ cmd: 'herdr agent wait', args: [name, '--state', 'idle', '--timeout', '30'] });
    steps.push({ cmd: 'roostr report', args: ['--pane', paneId, '--task', task, '--model', model, '--effort', effort] });
    if (promptText) {
      steps.push({ cmd: 'herdr agent prompt', args: [name, promptText] });
    }
    return {
      reuse: true,
      paneId,
      name,
      role,
      tool,
      model,
      effort,
      tier,
      prompt: promptText,
      steps,
    };
  }

  const dir = opts.direction || 'right';
  const cwd = opts.cwd || '.';
  const toolArgs = roleArgs({ model, effort, args: [] }, tool);

  steps.push({ cmd: 'herdr pane split', args: ['--current', '--direction', dir, '--cwd', cwd, '--no-focus'] });
  steps.push({ cmd: 'herdr agent start', args: [name, '--kind', tool, '--pane', '<pane_id>', '--', ...toolArgs] });
  steps.push({ cmd: 'herdr pane rename', args: ['<pane_id>', `${name} · ${role}`] });
  steps.push({ cmd: 'roostr report', args: ['--pane', '<pane_id>', '--task', task, '--model', model, '--effort', effort] });
  steps.push({ cmd: 'ledger append', args: ['spawn', '<pane_id>', task, role, tool, model, effort] });
  if (promptText) {
    steps.push({ cmd: 'herdr agent wait', args: [name, '--state', 'idle', '--timeout', '30'] });
    steps.push({ cmd: 'herdr agent prompt', args: [name, promptText] });
  }

  return {
    reuse: false,
    name,
    role,
    tool,
    model,
    effort,
    tier,
    cwd,
    direction: dir,
    prompt: promptText,
    steps,
  };
}

async function executeSpawn(opts = {}, deps = {}) {
  const runner = deps.herdrRunner || herdr.run;
  const reportMod = deps.reportModule || report;
  const ledgerMod = deps.ledgerModule || ledger;
  const plan = planSpawn(opts);

  if (opts.reuse) {
    const paneId = opts.reuse;
    const name = opts.name || paneId;
    const resetCmd = plan.tool === 'opencode' ? '/new' : '/clear';

    await runner(['agent', 'prompt', name, resetCmd]);
    await runner(['agent', 'wait', name, '--state', 'idle', '--timeout', '30']);
    if (plan.prompt) {
      await runner(['agent', 'prompt', name, plan.prompt]);
    }
    reportMod.writeReport(paneId, {
      task: opts.task,
      model: plan.model,
      effort: plan.effort,
      role: plan.role,
    });
    const entry = ledgerMod.spawn({
      paneId,
      task: opts.task,
      role: plan.role,
      name,
      kind: plan.tool,
      model: plan.model,
      effort: plan.effort,
      tier: plan.tier,
    });

    return {
      success: true,
      reused: true,
      paneId,
      name,
      role: plan.role,
      tool: plan.tool,
      model: plan.model,
      effort: plan.effort,
      runId: entry ? entry.runId : null,
      steps: plan.steps,
    };
  }

  const splitOut = await runner([
    'pane', 'split',
    '--current',
    '--direction', opts.direction || 'right',
    '--cwd', opts.cwd || process.cwd(),
    '--no-focus',
  ]);

  let paneId = null;
  if (splitOut) {
    try {
      const parsed = JSON.parse(splitOut);
      paneId = parsed.pane_id || parsed.paneId || (parsed.result && parsed.result.pane_id) || null;
    } catch {}
    if (!paneId) {
      const match = String(splitOut).match(/w\d+:p\d+/);
      if (match) paneId = match[0];
    }
  }
  if (!paneId) paneId = 'w1:p_spawned';

  const toolArgs = roleArgs({ model: plan.model, effort: plan.effort, args: [] }, plan.tool);
  await runner(['agent', 'start', plan.name, '--kind', plan.tool, '--pane', paneId, '--', ...toolArgs]);
  await runner(['pane', 'rename', paneId, `${plan.name} · ${plan.role}`]);

  reportMod.writeReport(paneId, {
    task: opts.task,
    model: plan.model,
    effort: plan.effort,
    role: plan.role,
  });

  const entry = ledgerMod.spawn({
    paneId,
    task: opts.task,
    role: plan.role,
    name: plan.name,
    kind: plan.tool,
    model: plan.model,
    effort: plan.effort,
    tier: plan.tier,
  });

  if (plan.prompt) {
    await runner(['agent', 'wait', plan.name, '--state', 'idle', '--timeout', '30']);
    await runner(['agent', 'prompt', plan.name, plan.prompt]);
  }

  return {
    success: true,
    reused: false,
    paneId,
    name: plan.name,
    role: plan.role,
    tool: plan.tool,
    model: plan.model,
    effort: plan.effort,
    runId: entry ? entry.runId : null,
    steps: plan.steps,
  };
}

async function mainSpawn(argv, deps = {}) {
  const opts = parseSpawnArgs(argv);
  if (!opts.task && !opts.pane) {
    process.stderr.write('usage: roostr spawn --task "<task>" [--execute] [--reuse <id>] [--role <role>] [--kind <kind>] [--effort low|medium|high] [--model <name>]\n');
    return 2;
  }
  if (opts.execute) {
    try {
      const res = await executeSpawn(opts, deps);
      if (opts.json) {
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      } else {
        process.stdout.write(`spawned:     ${res.name} (${res.paneId})\n`);
        process.stdout.write(`role:        ${res.role}\n`);
        process.stdout.write(`tool:        ${res.tool} (${res.model || 'default'})\n`);
        process.stdout.write(`run:         ${res.runId}\n`);
      }
      return 0;
    } catch (e) {
      process.stderr.write(`roostr spawn: ${e.message}\n`);
      return 1;
    }
  }

  if (opts.pane && !opts.execute) {
    return ledger.main(['spawn', ...argv]);
  }

  const plan = planSpawn(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  } else {
    process.stdout.write(`plan spawn:  ${plan.name} (${plan.role})\n`);
    process.stdout.write(`tool:        ${plan.tool} · effort ${plan.effort} · model ${plan.model || 'default'}\n`);
    process.stdout.write('steps:\n');
    for (const s of plan.steps) {
      process.stdout.write(`  - ${s.cmd} ${s.args.join(' ')}\n`);
    }
  }
  return 0;
}

module.exports = {
  TASK, ROLE, DEFAULT_HEAD_NAME, PLAN,
  projectSlug, nextName, shellPanes, projectName, prompt, resolveRole, roleArgs,
  parseSpawnArgs, planSpawn, executeSpawn, mainSpawn,
};
