'use strict';
// The orchestration ledger: one JSON object per line, append only.
// Default ~/.crew-board/orchestration.jsonl, override with CREW_BOARD_LEDGER.
//
// The ledger stores the effort recommendation, the effort actually used and the
// outcome. It never stores prompts, transcripts, pane screens or secrets.
// The file grows without bound and must be rotated by hand.

const crypto = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const advisor = require('./advisor');
const crewfile = require('./crewfile');
const rotate = require('./rotate');

const TIERS = ['fast', 'balanced', 'reasoning'];
const EFFORTS = ['low', 'medium', 'high'];
const RESULTS = ['pass', 'fail', 'blocked'];

function ledgerPath() {
  if (process.env.ROOSTR_LEDGER) return process.env.ROOSTR_LEDGER;
  if (process.env.CREW_BOARD_LEDGER) return process.env.CREW_BOARD_LEDGER;
  const roostr = path.join(os.homedir(), '.roostr', 'orchestration.jsonl');
  const legacy = path.join(os.homedir(), '.crew-board', 'orchestration.jsonl');
  if (fs.existsSync(roostr) || !fs.existsSync(legacy)) return roostr;
  return legacy;
}

function readEntries(file = ledgerPath()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) out.push(entry);
    } catch {
      // A partial or hand edited line is skipped, not fatal.
    }
  }
  return out;
}

function append(entry, file = ledgerPath()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Backends without POSIX modes are fine.
  }
  rotate.maybeRotate(file);
  return entry;
}

function findSpawn(runId, file = ledgerPath()) {
  const entries = readEntries(file);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.event === 'spawn' && e.runId === runId) return e;
  }
  return null;
}

function spawn(opts = {}, file = ledgerPath()) {
  const paneId = opts.paneId || opts.pane;
  const task = opts.task;
  if (!paneId) throw new Error('pane id is required');
  if (!task) throw new Error('task is required');
  if (opts.tier && !TIERS.includes(opts.tier)) throw new Error(`unknown tier: ${opts.tier}`);
  if (opts.effort && !EFFORTS.includes(opts.effort)) throw new Error(`unknown effort: ${opts.effort}`);

  const rec = advisor.recommend(task, opts.effort || null, opts.model || null, { kind: opts.kind || null, crew: opts.crew || null });
  const runId = crypto.randomUUID();
  const entry = {
    at: new Date().toISOString(),
    event: 'spawn',
    runId,
    paneId,
    name: opts.name || paneId,
    role: opts.role || 'worker',
    kind: rec.kind,
    task,
    tier: opts.tier || rec.recommendedTier,
    effort: opts.effort || rec.recommendedEffort,
    model: opts.model || rec.recommendedModel,
    recommendedTier: rec.recommendedTier,
    recommendedEffort: rec.recommendedEffort,
    outcome: null,
    rework: 0,
    cost: null,
    durationMs: null,
    note: null,
  };
  append(entry, file);
  return { entry, recommendation: rec };
}

function outcome(opts = {}, file = ledgerPath()) {
  const runId = opts.runId || opts.run;
  if (!runId) throw new Error('run id is required');
  if (!RESULTS.includes(opts.result)) throw new Error(`result must be one of ${RESULTS.join(', ')}`);
  const spawnEntry = findSpawn(runId, file);
  if (!spawnEntry) throw new Error(`unknown run id: ${runId}`);
  const entries = readEntries(file);
  if (entries.some((e) => e && e.event === 'outcome' && e.runId === runId)) {
    throw new Error(`run already has an outcome: ${runId}`);
  }
  const now = Date.now();
  const started = Date.parse(spawnEntry.at);
  const rework = Number.isFinite(Number(opts.rework)) ? Math.max(0, Number(opts.rework)) : 0;
  const cost = Number.isFinite(Number(opts.cost)) && opts.cost !== null && opts.cost !== '' ? Number(opts.cost) : null;
  const entry = {
    at: new Date(now).toISOString(),
    event: 'outcome',
    runId,
    outcome: opts.result,
    rework,
    cost,
    durationMs: Number.isFinite(started) ? Math.max(0, now - started) : null,
    note: opts.note || null,
  };
  append(entry, file);
  return entry;
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function formatSpawn({ entry, recommendation }) {
  return [
    `run:         ${entry.runId}`,
    `tier:        ${entry.tier} · effort ${entry.effort}`,
    `model:       ${entry.model || '?'}`,
    `tool:        ${recommendation.recommendedTool || '?'}`,
    `rationale:   ${recommendation.rationale}`,
    ...(recommendation.fallbacks.length ? [`fallbacks:   ${recommendation.fallbacks.join(', ')}`] : []),
    ...(recommendation.requiresModelChoice ? ['choice:      preferred model is disabled; pick one fallback'] : []),
  ].join('\n');
}

function main(args = []) {
  let argv = args.slice();
  let sub = null;
  if (argv[0] === 'spawn' || argv[0] === 'outcome') {
    sub = argv[0];
    argv = argv.slice(1);
  } else if (argv.includes('--run') || argv.includes('--result')) {
    sub = 'outcome';
  } else {
    sub = 'spawn';
  }

  try {
    const crewPath = flagValue(argv, '--crew') || crewfile.findCrewFile(process.cwd());
    const crew = crewPath ? crewfile.loadCrew(crewPath) : null;
    if (sub === 'spawn') {
      const paneId = flagValue(argv, '--pane');
      const task = flagValue(argv, '--task');
      if (!paneId || !task) {
        console.error('usage: crew-board spawn --pane <id> --task "<task>" [--role worker] [--kind <kind>] [--tier fast|balanced|reasoning] [--effort low|medium|high] [--model <name>] [--crew <file>]');
        return 2;
      }
      const result = spawn({
        paneId,
        task,
        role: flagValue(argv, '--role') || undefined,
        name: flagValue(argv, '--name') || undefined,
        tier: flagValue(argv, '--tier') || undefined,
        effort: flagValue(argv, '--effort') || undefined,
        model: flagValue(argv, '--model') || undefined,
        kind: flagValue(argv, '--kind') || undefined,
        crew,
      });
      console.log(formatSpawn(result));
      return 0;
    }

    const runId = flagValue(argv, '--run');
    const result = flagValue(argv, '--result');
    if (!runId || !result) {
      console.error('usage: crew-board outcome --run <runId> --result pass|fail|blocked [--rework N] [--cost N] [--note "<text>"]');
      return 2;
    }
    const entry = outcome({
      runId,
      result,
      rework: flagValue(argv, '--rework'),
      cost: flagValue(argv, '--cost'),
      note: flagValue(argv, '--note') || undefined,
    });
    console.log(`outcome:     ${entry.outcome} · run ${entry.runId}`);
    return 0;
  } catch (e) {
    console.error(`crew-board ${sub}: ${e.message}`);
    return 1;
  }
}

module.exports = {
  ledgerPath,
  readEntries,
  append,
  findSpawn,
  spawn,
  outcome,
  main,
};
