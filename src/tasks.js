'use strict';
// `crew-board tasks [--file <path>] [--crew <file>] [--json]`
//
// Reads the machine readable task list the Head Honcho writes next to the plan.
// The list is the bridge between prose briefs and the board: one row per work
// package, with its kind, owners, brief, report, dependencies and any explicit
// effort or model override. The command validates it and runs the same advisor
// used at spawn time, so a plan can be checked before work starts.

const fs = require('fs');
const path = require('path');
const advisor = require('./advisor');
const config = require('./config');
const crewfile = require('./crewfile');

const TASK_FILE = path.join('docs', 'orchestration', 'tasks.json');
const STATUSES = ['pending', 'working', 'done', 'blocked'];
const USAGE = 'usage: crew-board tasks [--file <path>] [--crew <file>] [--json]';

function text(v, max = 200) {
  return typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, max) : '';
}

function stringList(v, max = 20) {
  if (!Array.isArray(v)) return null;
  return v.map((x) => text(x, 200)).filter(Boolean).slice(0, max);
}

function taskFile(cwd = process.cwd()) {
  return path.resolve(cwd, TASK_FILE);
}

function load(file = taskFile()) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('task list must be a JSON object');
  return raw;
}

function validate(raw) {
  const errors = [];
  const warnings = [];
  const tasks = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { plan: null, tasks, errors: ['task list must be a JSON object'], warnings };
  }
  const version = raw.version === undefined ? raw.schema : raw.version;
  if (version !== undefined && version !== 1) errors.push('version must be 1');
  const plan = text(raw.plan, 240);
  if (!Array.isArray(raw.tasks)) errors.push('tasks must be an array');
  const seen = new Set();
  for (const [i, t] of (Array.isArray(raw.tasks) ? raw.tasks : []).entries()) {
    const at = `tasks[${i}]`;
    if (!t || typeof t !== 'object' || Array.isArray(t)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const id = text(t.id, 80);
    if (!id) errors.push(`${at}.id is required`);
    else if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) errors.push(`${at}.id must be lowercase letters, numbers and hyphens`);
    else if (seen.has(id)) errors.push(`${at}.id "${id}" is duplicated`);
    else seen.add(id);
    const title = text(t.title, 200);
    if (!title) errors.push(`${at}.title is required`);
    const kind = text(t.kind, 40);
    if (!kind) errors.push(`${at}.kind is required`);
    else if (!config.TASK_KINDS.includes(kind)) errors.push(`${at}.kind must be one of ${config.TASK_KINDS.join(', ')}`);
    const brief = text(t.brief, 240);
    const report = text(t.report, 240);
    if (!brief) errors.push(`${at}.brief is required`);
    if (!report) errors.push(`${at}.report is required`);
    const status = text(t.status, 20) || 'pending';
    if (!STATUSES.includes(status)) errors.push(`${at}.status must be one of ${STATUSES.join(', ')}`);
    const tool = text(t.tool, 40);
    const effort = text(t.effort, 12);
    if (effort && !config.EFFORTS.includes(effort)) errors.push(`${at}.effort must be low, medium, high, xhigh or max`);
    const model = text(t.model, 120);
    const fallbacks = stringList(t.fallbacks, 5);
    if (t.fallbacks !== undefined && fallbacks === null) errors.push(`${at}.fallbacks must be an array`);
    const ownsRaw = t.owns === undefined ? t.owners : t.owns;
    const owns = stringList(ownsRaw, 40);
    if (ownsRaw !== undefined && owns === null) errors.push(`${at}.owns must be an array`);
    const dependsRaw = t.depends_on === undefined ? t.dependsOn : t.depends_on;
    const dependsOn = stringList(dependsRaw, 20);
    if (dependsRaw !== undefined && dependsOn === null) errors.push(`${at}.depends_on must be an array`);
    if (id && title && kind && brief && report) {
      tasks.push({ id, title, kind, brief, report, status, tool, effort, model, fallbacks: fallbacks || [], owns: owns || [], depends_on: dependsOn || [] });
    }
  }
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!seen.has(dep)) errors.push(`task "${t.id}" depends on unknown task "${dep}"`);
    }
  }
  // Detect dependency cycles (P0-4)
  const deps = new Map();
  for (const t of tasks) deps.set(t.id, t.depends_on || []);
  const visiting = new Set();
  const visited = new Set();
  function hasCycle(id, stack) {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return stack.includes(id);
    visiting.add(id);
    stack.push(id);
    for (const d of deps.get(id) || []) {
      if (hasCycle(d, stack)) return true;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  // Find cycles
  const cycles = [];
  for (const id of deps.keys()) {
    if (hasCycle(id, [])) {
      // Find which nodes form cycle
      if (!cycles.includes(id)) cycles.push(id);
    }
  }
  if (cycles.length) {
    errors.push(`dependency cycle detected involving: ${cycles.slice(0,5).join(', ')}`);
  }
  if (!tasks.length && !errors.length) errors.push('task list has no tasks');
  return { plan: plan || null, tasks, errors, warnings };
}

function applyOverrides(rec, task, cfg) {
  const out = { ...rec };
  if (task.tool) {
    out.recommendedTool = task.tool;
    out.toolSource = 'task-file';
  }
  if (task.effort && config.EFFORTS.includes(task.effort)) {
    out.recommendedEffort = task.effort;
    out.recommendedTier = config.TIER_BY_EFFORT[task.effort];
    out.source = 'task-file';
  }
  if (task.model) {
    out.preferredModel = task.model;
    out.modelSource = 'task-file';
    if (cfg.disabledModels.includes(task.model)) {
      out.recommendedModel = null;
      out.modelWarning = 'configure an available model';
      out.requiresModelChoice = true;
    } else {
      out.recommendedModel = task.model;
      out.requiresModelChoice = false;
      out.modelWarning = null;
    }
  }
  if (task.fallbacks && task.fallbacks.length) {
    out.fallbacks = task.fallbacks.slice(0, 5);
    out.availableFallbacks = out.fallbacks.filter((m) => !cfg.disabledModels.includes(m));
  }
  return out;
}

function enrich(list, { config: cfg = null, crew = null } = {}) {
  const c = cfg || config.loadConfig().config;
  return list.tasks.map((task) => ({
    ...task,
    recommendation: applyOverrides(advisor.recommend(task.title, null, task.model || null, { kind: task.kind, crew, config: c }), task, c),
  }));
}

function formatTable(rows) {
  const lines = ['id                kind      effort  tier       model                    conf    status'];
  for (const r of rows) {
    const rec = r.recommendation;
    const model = rec.recommendedModel || (rec.requiresModelChoice ? '<choose>' : '?');
    lines.push([
      r.id.padEnd(17),
      r.kind.padEnd(9),
      rec.recommendedEffort.padEnd(7),
      rec.recommendedTier.padEnd(10),
      model.padEnd(24),
      rec.confidence.padEnd(7),
      r.status,
    ].join(' '));
    if (rec.fallbacks.length) lines.push(`  fallbacks: ${rec.fallbacks.join(', ')}`);
    if (rec.requiresModelChoice) lines.push('  choice: preferred model is disabled, pick one fallback');
  }
  return lines.join('\n');
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function main(argv = []) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const json = argv.includes('--json');
  const file = flagValue(argv, '--file') || taskFile();
  let raw;
  try {
    raw = load(file);
  } catch (e) {
    process.stderr.write(`crew-board tasks: ${e.message}\n`);
    return 1;
  }
  const checked = validate(raw);
  if (checked.errors.length) {
    for (const e of checked.errors) process.stderr.write(`crew-board tasks: ${e}\n`);
    return 2;
  }
  const crewPath = flagValue(argv, '--crew') || crewfile.findCrewFile(process.cwd());
  const crew = crewPath ? crewfile.loadCrew(crewPath) : null;
  const rows = enrich(checked, { crew });
  if (json) {
    process.stdout.write(JSON.stringify({ plan: checked.plan, tasks: rows }, null, 2) + '\n');
  } else {
    process.stdout.write(`${checked.plan ? `plan: ${checked.plan}\n` : ''}${formatTable(rows)}\n`);
  }
  return 0;
}

module.exports = { TASK_FILE, STATUSES, USAGE, taskFile, load, validate, applyOverrides, enrich, formatTable, flagValue, main };
