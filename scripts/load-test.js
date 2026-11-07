'use strict';
// Load test for the board: build a synthetic snapshot with 12 agents, then
// measure buildModel plus render at a wide and a narrow pane. It needs no
// Herdr install and no real crew.
//
// The gated p95 is CPU time, so a busy host or a parallel test file cannot
// turn a scheduler pause into a false failure. Wall clock p50 and p95 are
// printed beside it for context, and the CPU to wall ratio is reported.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  iterations: 30,
  warmup: 5,
  widths: [120, 100],
  p95Ms: 50,
  cpuMax: 0.01,
  enforceCpu: false,
};

const TASKS = [
  'plan the release',
  'build the endpoint',
  'write the guide',
  'review the diff',
  'fix the login timeout',
  'triage the flaky test',
  'update the pricing table',
  'audit the CI cache',
  'draft the changelog',
  'check the backup restore',
  'tune the narrow view',
  'profile the render path',
];

const KINDS = ['claude', 'opencode', 'agy', 'kilo'];

function numberOption(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[at];
}

function milliseconds(ns) {
  return Number(ns) / 1e6;
}

function syntheticSnapshot(cwd) {
  const workspaces = [
    { workspace_id: 'w1', label: 'example' },
    { workspace_id: 'w2', label: 'tools' },
  ];
  const panes = [];
  const agents = [];
  for (let i = 0; i < 12; i++) {
    const ws = i < 6 ? 'w1' : 'w2';
    const paneId = `${ws}:p${(i % 6) + 1}`;
    const name = `agent-${String(i + 1).padStart(2, '0')}`;
    const kind = KINDS[i % KINDS.length];
    panes.push({
      pane_id: paneId,
      workspace_id: ws,
      cwd,
      label: `${name} · ${TASKS[i]}`,
      terminal_id: `term-${i + 1}`,
    });
    agents.push({
      pane_id: paneId,
      workspace_id: ws,
      agent: kind,
      cwd,
      terminal_title_stripped: name,
      state_change_seq: 100 + i,
      terminal_id: `term-${i + 1}`,
      name,
      agent_status: i === 10 ? 'blocked' : i % 3 === 0 ? 'working' : 'idle',
    });
  }
  const tabs = [
    { tab_id: 'tab-1', workspace_id: 'w1', label: 'main' },
    { tab_id: 'tab-2', workspace_id: 'w2', label: 'main' },
  ];
  const layouts = [
    { tab_id: 'tab-1', panes: panes.slice(0, 6).map((p) => p.pane_id), splits: [] },
    { tab_id: 'tab-2', panes: panes.slice(6).map((p) => p.pane_id), splits: [] },
  ];
  return { workspaces, panes, agents, tabs, layouts };
}

function syntheticReports(agents) {
  const reports = {};
  const rss = {};
  agents.forEach((a, i) => {
    reports[a.pane_id] = {
      task: TASKS[i],
      model: i % 4 === 0 ? 'claude-sonnet-4' : i % 4 === 1 ? 'gpt-5-codex' : i % 4 === 2 ? 'Gemini 3.8 Flash' : 'kilo-pro',
      effort: ['low', 'medium', 'high'][i % 3],
      ctx: 18 + (i % 10) * 7,
      tokens: 12000 + i * 2400,
      cost: 0.4 + i * 0.13,
      session: `session-${i + 1}`,
    };
    rss[a.pane_id] = 24000 + i * 1200;
  });
  return { reports, rss };
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function runLoadTest(options = {}) {
  const iterations = options.iterations ?? DEFAULTS.iterations;
  const warmup = options.warmup ?? DEFAULTS.warmup;
  const widths = options.widths ?? DEFAULTS.widths;
  const p95Limit = numberOption(options.p95Ms ?? process.env.LOAD_P95_MS, DEFAULTS.p95Ms);
  const cpuMax = numberOption(options.cpuMax ?? process.env.LOAD_CPU_MAX, DEFAULTS.cpuMax);
  const enforceCpu = options.enforceCpu ?? process.env.LOAD_ENFORCE_CPU === '1';

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-load-'));
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex');
  const stateDir = path.join(root, 'state');
  const work = path.join(root, 'work');
  for (const dir of [home, codexHome, stateDir, work]) fs.mkdirSync(dir, { recursive: true });

  const keys = ['HOME', 'CODEX_HOME', 'CREW_BOARD_STATE_DIR', 'CREW_BOARD_CONFIG', 'CREW_BOARD_LEDGER', 'CREW_BOARD_SUMMARY', 'CREW_BOARD_PRICES', 'EXPLABS_ENABLED', 'EXPLABS_API_KEY', 'EXPLABS_KEY_FILE', 'EXPLABS_COOKIE', 'EXPLABS_COOKIE_FILE'];
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.CODEX_HOME = codexHome;
  process.env.CREW_BOARD_STATE_DIR = stateDir;
  delete process.env.CREW_BOARD_CONFIG;
  delete process.env.CREW_BOARD_LEDGER;
  delete process.env.CREW_BOARD_SUMMARY;
  delete process.env.CREW_BOARD_PRICES;
  delete process.env.EXPLABS_ENABLED;
  delete process.env.EXPLABS_API_KEY;
  delete process.env.EXPLABS_KEY_FILE;
  delete process.env.EXPLABS_COOKIE;
  delete process.env.EXPLABS_COOKIE_FILE;

  try {
    const board = require('../src/board');
    const snap = syntheticSnapshot(work);
    const { reports, rss } = syntheticReports(snap.agents);
    const mem = { tags: {}, status: {}, prefs: {} };
    const now = Date.now();

    const pass = () => {
      const model = board.buildModel({
        snap,
        agents: snap.agents,
        screens: {},
        reports,
        events: {},
        rss,
        crewFor: () => null,
        mem,
        now,
        budget: null,
        trust: {},
      });
      model.limits = [];
      model.tokscale = null;
      model.dailyBudget = null;
      return model;
    };

    for (let i = 0; i < warmup; i++) {
      const model = pass();
      for (const width of widths) board.render(model, { width, load: [0, 0, 0] });
    }

    const cpuSamples = new Map(widths.map((width) => [width, []]));
    const wallSamples = new Map(widths.map((width) => [width, []]));
    const passCpuSamples = [];
    const passWallSamples = [];
    const cpuStart = process.cpuUsage();
    const wallStart = process.hrtime.bigint();

    const cpuMsSince = (usage) => {
      const d = process.cpuUsage(usage);
      return (d.user + d.system) / 1000;
    };

    for (let i = 0; i < iterations; i++) {
      const buildCpuStart = process.cpuUsage();
      const buildWallStart = process.hrtime.bigint();
      const model = pass();
      const buildCpuMs = cpuMsSince(buildCpuStart);
      const buildWallMs = milliseconds(process.hrtime.bigint() - buildWallStart);
      let passCpuMs = buildCpuMs;
      let passWallMs = buildWallMs;
      for (const width of widths) {
        const renderCpuStart = process.cpuUsage();
        const renderWallStart = process.hrtime.bigint();
        board.render(model, { width, load: [0, 0, 0] });
        const renderCpuMs = cpuMsSince(renderCpuStart);
        const renderWallMs = milliseconds(process.hrtime.bigint() - renderWallStart);
        cpuSamples.get(width).push(buildCpuMs + renderCpuMs);
        wallSamples.get(width).push(buildWallMs + renderWallMs);
        passCpuMs += renderCpuMs;
        passWallMs += renderWallMs;
      }
      passCpuSamples.push(passCpuMs);
      passWallSamples.push(passWallMs);
    }

    const cpu = process.cpuUsage(cpuStart);
    const wallMs = milliseconds(process.hrtime.bigint() - wallStart);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const cpuRatio = wallMs > 0 ? cpuMs / wallMs : 0;

    const byWidth = widths.map((width) => {
      const cpuValues = cpuSamples.get(width);
      const wallValues = wallSamples.get(width);
      return {
        width,
        p50Ms: percentile(cpuValues, 50),
        p95Ms: percentile(cpuValues, 95),
        wallP50Ms: percentile(wallValues, 50),
        wallP95Ms: percentile(wallValues, 95),
      };
    });
    const passP95 = percentile(passCpuSamples, 95);
    const worstP95 = Math.max(passP95, ...byWidth.map((w) => w.p95Ms));
    const failedP95 = worstP95 > p95Limit;
    const failedCpu = enforceCpu && cpuRatio > cpuMax;

    return {
      paneCount: snap.agents.length,
      iterations,
      warmup,
      byWidth,
      pass: {
        p50Ms: percentile(passCpuSamples, 50),
        p95Ms: passP95,
        wallP50Ms: percentile(passWallSamples, 50),
        wallP95Ms: percentile(passWallSamples, 95),
      },
      p95LimitMs: p95Limit,
      cpuMs,
      wallMs,
      cpuRatio,
      cpuMax,
      enforceCpu,
      failedP95,
      failedCpu,
      failed: failedP95 || failedCpu,
    };
  } finally {
    restoreEnv(saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function print(result) {
  const ms = (n) => `${n.toFixed(2)} ms`;
  const cpus = os.cpus().length;
  process.stdout.write(`crew-board load: ${result.paneCount} panes, ${result.iterations} iterations, ${result.warmup} warmup\n`);
  process.stdout.write(`  host load ${os.loadavg()[0].toFixed(2)} on ${cpus} cpu\n`);
  for (const row of result.byWidth) {
    process.stdout.write(`  width ${String(row.width).padEnd(3)}  cpu p50 ${ms(row.p50Ms).padStart(9)}  cpu p95 ${ms(row.p95Ms).padStart(9)}  wall p95 ${ms(row.wallP95Ms).padStart(10)}\n`);
  }
  process.stdout.write(`  pass        cpu p50 ${ms(result.pass.p50Ms).padStart(9)}  cpu p95 ${ms(result.pass.p95Ms).padStart(9)}  wall p95 ${ms(result.pass.wallP95Ms).padStart(10)}\n`);
  process.stdout.write(`  cpu ${ms(result.cpuMs)} / wall ${ms(result.wallMs)} = ${result.cpuRatio.toFixed(4)}${result.enforceCpu ? ' (enforced)' : ' (informational)'}\n`);
  process.stdout.write(`  p95 limit ${ms(result.p95LimitMs)}: ${result.failedP95 ? 'FAIL' : 'ok'}\n`);
  if (result.enforceCpu) {
    process.stdout.write(`  cpu ratio limit ${result.cpuMax}: ${result.failedCpu ? 'FAIL' : 'ok'}\n`);
  }
}

if (require.main === module) {
  const result = runLoadTest();
  print(result);
  if (result.failed) process.exitCode = 1;
}

module.exports = { runLoadTest, print, percentile, syntheticSnapshot };
