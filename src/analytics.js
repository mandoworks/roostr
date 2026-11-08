'use strict';
// `crew-board analytics [--days N] [--by pane|model|kind|batch] [--tasks <path>] [--json]`
//
// Continuous usage time series, status transitions, and cost attribution.
// Joins usage samples, ledger attempts, and status transitions on pane,
// runId, and time window.
//
// Privacy line:
// samples store numbers and names, never prompts, transcripts or screens.

const fs = require('fs');
const path = require('path');
const ledger = require('./ledger');
const report = require('./report');
const statusEvent = require('../scripts/status-event');
const pricing = require('./pricing');
const tasks = require('./tasks');

const VIEWS = ['model', 'pane', 'kind', 'batch'];

function parseIso(ts) {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function round(n, digits = 2) {
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function confidenceForSamples(count) {
  if (count >= 10) return 'high';
  if (count >= 3) return 'medium';
  return 'low';
}

function normalizeSample(sample) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return null;
  const at = parseIso(sample.at);
  const pane = typeof sample.pane === 'string' ? sample.pane : null;
  if (!pane) return null;
  const model = sample.model ? String(sample.model).trim() : null;
  const effort = sample.effort ? String(sample.effort).trim() : null;
  const tokens = Number.isFinite(Number(sample.tokens)) ? Number(sample.tokens) : null;
  const input = Number.isFinite(Number(sample.input)) ? Number(sample.input) : null;
  const output = Number.isFinite(Number(sample.output)) ? Number(sample.output) : null;
  const ctx = Number.isFinite(Number(sample.ctx)) ? Number(sample.ctx) : null;
  const src = sample.src || 'report';

  let cost = null;
  let isEstimate = false;
  if (sample.cost !== null && sample.cost !== undefined && sample.cost !== '') {
    const parsedCost = Number(sample.cost);
    if (Number.isFinite(parsedCost)) cost = parsedCost;
  }

  // Derive cost via pricing if missing and input/output are available.
  if (cost === null && model && input !== null && output !== null) {
    const est = pricing.estimate(model, { input, output });
    if (est && Number.isFinite(est.cost)) {
      cost = est.cost;
      isEstimate = true;
    }
  }

  return {
    at,
    pane,
    model,
    effort,
    tokens,
    input,
    output,
    cost,
    isEstimate,
    ctx,
    src,
  };
}

function analyzeByModel(samples, ledgerEntries) {
  const models = new Map();

  for (const s of samples) {
    const name = s.model || 'unknown';
    if (!models.has(name)) {
      models.set(name, {
        model: name,
        samples: 0,
        tokens: 0,
        input: 0,
        output: 0,
        costSum: 0,
        hasCost: false,
        hasEstimates: false,
        panes: new Set(),
      });
    }
    const m = models.get(name);
    m.samples++;
    if (s.pane) m.panes.add(s.pane);
    if (s.tokens !== null) m.tokens += s.tokens;
    if (s.input !== null) m.input += s.input;
    if (s.output !== null) m.output += s.output;
    if (s.cost !== null) {
      m.costSum += s.cost;
      m.hasCost = true;
      if (s.isEstimate) m.hasEstimates = true;
    }
  }

  // Correlate with ledger attempts for outcomes.
  const ledgerByModel = new Map();
  for (const e of ledgerEntries) {
    const mName = e.model || 'unknown';
    if (!ledgerByModel.has(mName)) {
      ledgerByModel.set(mName, { count: 0, pass: 0, reworkSum: 0 });
    }
    const st = ledgerByModel.get(mName);
    st.count++;
    if (e.outcome === 'pass') st.pass++;
    st.reworkSum += Number.isFinite(e.rework) ? e.rework : 0;
  }

  const out = [];
  for (const [name, m] of models) {
    const ledgerStats = ledgerByModel.get(name) || { count: 0, pass: 0, reworkSum: 0 };
    const passRate = ledgerStats.count > 0 ? round((ledgerStats.pass / ledgerStats.count) * 100, 1) : null;
    out.push({
      model: name,
      samples: m.samples,
      confidence: confidenceForSamples(m.samples),
      tokens: m.tokens || null,
      input: m.input || null,
      output: m.output || null,
      cost: m.hasCost ? round(m.costSum, 4) : null,
      is_estimate: m.hasEstimates,
      panes: Array.from(m.panes).sort(),
      runs: ledgerStats.count,
      first_try_pass_rate: passRate,
    });
  }

  out.sort((a, b) => (b.cost || 0) - (a.cost || 0) || b.samples - a.samples);
  return out;
}

function analyzeByPane(samples, ledgerEntries) {
  const panes = new Map();

  for (const s of samples) {
    if (!panes.has(s.pane)) {
      panes.set(s.pane, {
        pane: s.pane,
        models: new Set(),
        samples: 0,
        tokens: 0,
        costSum: 0,
        hasCost: false,
        hasEstimates: false,
      });
    }
    const p = panes.get(s.pane);
    p.samples++;
    if (s.model) p.models.add(s.model);
    if (s.tokens !== null) p.tokens += s.tokens;
    if (s.cost !== null) {
      p.costSum += s.cost;
      p.hasCost = true;
      if (s.isEstimate) p.hasEstimates = true;
    }
  }

  const ledgerByPane = new Map();
  for (const e of ledgerEntries) {
    const pId = e.paneId || e.pane;
    if (!pId) continue;
    if (!ledgerByPane.has(pId)) {
      ledgerByPane.set(pId, { count: 0, pass: 0, fail: 0, blocked: 0, reworkSum: 0, durationSum: 0, durCount: 0 });
    }
    const lp = ledgerByPane.get(pId);
    lp.count++;
    if (e.outcome === 'pass') lp.pass++;
    else if (e.outcome === 'fail') lp.fail++;
    else if (e.outcome === 'blocked') lp.blocked++;
    lp.reworkSum += Number.isFinite(e.rework) ? e.rework : 0;
    if (Number.isFinite(e.durationMs)) {
      lp.durationSum += e.durationMs;
      lp.durCount++;
    }
  }

  const out = [];
  const allPaneIds = new Set([...panes.keys(), ...ledgerByPane.keys()]);
  for (const pId of allPaneIds) {
    const p = panes.get(pId) || {
      pane: pId,
      models: new Set(),
      samples: 0,
      tokens: 0,
      costSum: 0,
      hasCost: false,
      hasEstimates: false,
    };
    const lp = ledgerByPane.get(pId) || { count: 0, pass: 0, fail: 0, blocked: 0, reworkSum: 0, durationSum: 0, durCount: 0 };
    const passRate = lp.count > 0 ? round((lp.pass / lp.count) * 100, 1) : null;
    const avgDuration = lp.durCount > 0 ? Math.round(lp.durationSum / lp.durCount) : null;

    out.push({
      pane: pId,
      models: Array.from(p.models).sort(),
      samples: p.samples,
      tokens: p.tokens || null,
      cost: p.hasCost ? round(p.costSum, 4) : null,
      is_estimate: p.hasEstimates,
      runs: lp.count,
      pass: lp.pass,
      fail: lp.fail,
      blocked: lp.blocked,
      first_try_pass_rate: passRate,
      avg_duration_ms: avgDuration,
    });
  }

  out.sort((a, b) => (b.cost || 0) - (a.cost || 0) || b.samples - a.samples);
  return out;
}

function analyzeByKind(samples, ledgerEntries) {
  const kinds = new Map();

  for (const e of ledgerEntries) {
    const k = e.kind || 'unknown';
    if (!kinds.has(k)) {
      kinds.set(k, {
        kind: k,
        runs: 0,
        pass: 0,
        fail: 0,
        blocked: 0,
        reworkSum: 0,
        costSum: 0,
        hasCost: false,
      });
    }
    const item = kinds.get(k);
    item.runs++;
    if (e.outcome === 'pass') item.pass++;
    else if (e.outcome === 'fail') item.fail++;
    else if (e.outcome === 'blocked') item.blocked++;
    item.reworkSum += Number.isFinite(e.rework) ? e.rework : 0;
    if (Number.isFinite(e.cost)) {
      item.costSum += e.cost;
      item.hasCost = true;
    }
  }

  const out = [];
  for (const [k, item] of kinds) {
    out.push({
      kind: k,
      runs: item.runs,
      pass: item.pass,
      fail: item.fail,
      blocked: item.blocked,
      first_try_pass_rate: item.runs > 0 ? round((item.pass / item.runs) * 100, 1) : null,
      avg_rework: item.runs > 0 ? round(item.reworkSum / item.runs, 2) : 0,
      cost: item.hasCost ? round(item.costSum, 4) : null,
    });
  }

  out.sort((a, b) => b.runs - a.runs);
  return out;
}

function analyzeBatchTimeline(tasksData, ledgerEntries, transitions, samples) {
  const taskList = tasksData && Array.isArray(tasksData.tasks) ? tasksData.tasks : [];
  const timeline = [];

  for (const t of taskList) {
    const taskId = t.id;
    // Match spawn entry in ledger
    let spawn = null;
    let outcome = null;
    for (const e of ledgerEntries) {
      if (e.task === taskId || (e.task && e.task.includes(taskId))) {
        if (e.event === 'spawn' && !spawn) spawn = e;
        if (e.event === 'outcome' && !outcome) outcome = e;
      }
    }

    const pane = t.pane || (spawn && (spawn.paneId || spawn.pane)) || null;
    const startIso = (spawn && spawn.at) || null;
    const endIso = (outcome && outcome.at) || null;
    const startMs = startIso ? parseIso(startIso) : null;
    const endMs = endIso ? parseIso(endIso) : null;

    // Filter pane transitions within this window
    const paneTransitions = [];
    if (pane) {
      for (const tr of transitions) {
        if (tr.pane !== pane) continue;
        const trMs = parseIso(tr.at);
        if (startMs && trMs && trMs < startMs) continue;
        if (endMs && trMs && trMs > endMs) continue;
        paneTransitions.push({ at: tr.at, status: tr.status });
      }
    }

    // Filter pane samples within this window
    let taskTokens = 0;
    let taskCost = 0;
    let hasCost = false;
    let isEstimate = false;
    if (pane) {
      for (const s of samples) {
        if (s.pane !== pane) continue;
        if (startMs && s.at && s.at < startMs) continue;
        if (endMs && s.at && s.at > endMs) continue;
        if (s.tokens !== null) taskTokens += s.tokens;
        if (s.cost !== null) {
          taskCost += s.cost;
          hasCost = true;
          if (s.isEstimate) isEstimate = true;
        }
      }
    }

    timeline.push({
      id: taskId,
      title: t.title || '',
      kind: t.kind || 'feature',
      pane,
      status: (outcome && outcome.outcome) || t.status || 'pending',
      spawned_at: startIso,
      completed_at: endIso,
      duration_ms: (outcome && outcome.durationMs) || (startMs && endMs ? endMs - startMs : null),
      tokens: taskTokens || null,
      cost: hasCost ? round(taskCost, 4) : ((outcome && outcome.cost !== null) ? round(outcome.cost, 4) : null),
      is_estimate: isEstimate,
      transitions: paneTransitions,
    });
  }

  return timeline;
}

function query(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const isToday = Boolean(options.today);
  let cutoff;
  let days = 30;
  if (isToday) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    cutoff = d.getTime();
    days = 1;
  } else {
    days = Number.isFinite(options.days) && options.days > 0 ? options.days : 30;
    cutoff = now - days * 24 * 60 * 60 * 1000;
  }
  const by = options.by && VIEWS.includes(options.by) ? options.by : 'model';

  // Read usage samples
  const rawSamples = options.samples || report.readUsage();
  const samples = [];
  for (const s of rawSamples) {
    const norm = normalizeSample(s);
    if (!norm) continue;
    if (norm.at !== null && norm.at < cutoff) continue;
    samples.push(norm);
  }

  // Read ledger entries
  const rawLedger = options.ledger || ledger.readEntries();
  const ledgerEntries = [];
  for (const e of rawLedger) {
    if (!e || typeof e !== 'object') continue;
    const at = parseIso(e.at || e.date);
    if (at !== null && at < cutoff) continue;
    ledgerEntries.push(e);
  }

  // Read transitions
  const rawTransitions = options.transitions || statusEvent.readTransitions();
  const transitions = [];
  for (const tr of rawTransitions) {
    if (!tr || typeof tr !== 'object') continue;
    const at = parseIso(tr.at);
    if (at !== null && at < cutoff) continue;
    transitions.push(tr);
  }

  let data;
  if (by === 'pane') {
    data = analyzeByPane(samples, ledgerEntries);
  } else if (by === 'kind') {
    data = analyzeByKind(samples, ledgerEntries);
  } else if (by === 'batch') {
    let tasksData = options.tasks;
    if (!tasksData) {
      try {
        const tFile = options.tasksFile || tasks.taskFile();
        tasksData = tasks.load(tFile);
      } catch {
        tasksData = { tasks: [] };
      }
    }
    data = analyzeBatchTimeline(tasksData, ledgerEntries, transitions, samples);
  } else {
    data = analyzeByModel(samples, ledgerEntries);
  }

  let workerTokens = 0;
  let orchestratorTokens = 0;
  for (const s of samples) {
    if (s.tokens === null || !(s.tokens > 0)) continue;
    const isOrch = /^(head-honcho|orchestrator|lead|la-jefa)/i.test(s.pane) ||
      ledgerEntries.some((e) => (e.paneId === s.pane || e.pane === s.pane) && /^(head-honcho|orchestrator|lead)/i.test(e.role || ''));
    if (isOrch) orchestratorTokens += s.tokens;
    else workerTokens += s.tokens;
  }
  const totalTokens = workerTokens + orchestratorTokens;
  const subagentTokenSharePct = totalTokens > 0 ? round((workerTokens / totalTokens) * 100, 1) : null;

  return {
    generated_at: new Date(now).toISOString(),
    days,
    window: isToday ? 'today' : `${days}d`,
    today: isToday,
    by,
    subagent_token_share_pct: subagentTokenSharePct,
    data,
  };
}

function formatText(result) {
  const windowLabel = result.today ? 'today (00:00 local to now)' : `${result.days} days`;
  const lines = [`analytics: by ${result.by} · ${windowLabel}`];
  if (result.subagent_token_share_pct !== null && result.subagent_token_share_pct !== undefined) {
    lines.push(`subagent token share: ${result.subagent_token_share_pct}% workers (target ≥80%)`);
  }
  const items = result.data;

  if (result.by === 'model') {
    if (!items.length) {
      lines.push('no model usage samples recorded in this window');
      return lines.join('\n');
    }
    lines.push('model'.padEnd(26) + 'samples'.padStart(8) + 'tokens'.padStart(12) + 'cost'.padStart(12) + '   confidence');
    lines.push('-'.repeat(68));
    for (const m of items) {
      const tokensStr = m.tokens !== null ? m.tokens.toLocaleString() : '?';
      const costPrefix = m.is_estimate ? '~$' : '$';
      const costStr = m.cost !== null ? `${costPrefix}${m.cost.toFixed(4)}` : '?';
      lines.push(
        m.model.slice(0, 25).padEnd(26) +
        String(m.samples).padStart(8) +
        tokensStr.padStart(12) +
        costStr.padStart(12) +
        `   ${m.confidence}`
      );
    }
  } else if (result.by === 'pane') {
    if (!items.length) {
      lines.push('no pane usage recorded in this window');
      return lines.join('\n');
    }
    lines.push('pane'.padEnd(12) + 'models'.padEnd(20) + 'samples'.padStart(8) + 'tokens'.padStart(12) + 'cost'.padStart(10) + 'runs'.padStart(6) + 'pass%'.padStart(8));
    lines.push('-'.repeat(76));
    for (const p of items) {
      const modelStr = p.models.join(', ').slice(0, 18) || '?';
      const tokensStr = p.tokens !== null ? p.tokens.toLocaleString() : '?';
      const costPrefix = p.is_estimate ? '~$' : '$';
      const costStr = p.cost !== null ? `${costPrefix}${p.cost.toFixed(4)}` : '?';
      const passRateStr = p.first_try_pass_rate !== null ? `${p.first_try_pass_rate}%` : '?';
      lines.push(
        p.pane.padEnd(12) +
        modelStr.padEnd(20) +
        String(p.samples).padStart(8) +
        tokensStr.padStart(12) +
        costStr.padStart(10) +
        String(p.runs).padStart(6) +
        passRateStr.padStart(8)
      );
    }
  } else if (result.by === 'kind') {
    if (!items.length) {
      lines.push('no task kind records found in this window');
      return lines.join('\n');
    }
    lines.push('kind'.padEnd(16) + 'runs'.padStart(6) + 'pass'.padStart(6) + 'fail'.padStart(6) + 'pass%'.padStart(8) + 'avg rework'.padStart(12) + 'cost'.padStart(12));
    lines.push('-'.repeat(66));
    for (const k of items) {
      const costStr = k.cost !== null ? `$${k.cost.toFixed(4)}` : '?';
      const passRateStr = k.first_try_pass_rate !== null ? `${k.first_try_pass_rate}%` : '?';
      lines.push(
        k.kind.padEnd(16) +
        String(k.runs).padStart(6) +
        String(k.pass).padStart(6) +
        String(k.fail).padStart(6) +
        passRateStr.padStart(8) +
        String(k.avg_rework).padStart(12) +
        costStr.padStart(12)
      );
    }
  } else if (result.by === 'batch') {
    if (!items.length) {
      lines.push('no tasks found in task list');
      return lines.join('\n');
    }
    for (const t of items) {
      const costStr = t.cost !== null ? `${t.is_estimate ? '~$' : '$'}${t.cost.toFixed(4)}` : '?';
      const durStr = t.duration_ms !== null ? `${Math.round(t.duration_ms / 1000)}s` : '?';
      lines.push(`• [${t.status.toUpperCase()}] ${t.id}: ${t.title}`);
      lines.push(`  pane: ${t.pane || '?'} · duration: ${durStr} · cost: ${costStr}`);
      if (t.transitions && t.transitions.length) {
        lines.push('  transitions:');
        for (const tr of t.transitions) {
          lines.push(`    ${tr.at} -> ${tr.status}`);
        }
      }
    }
  }

  return lines.join('\n');
}

function helpText() {
  return [
    'usage: roostr analytics [--days N | --today] [--by pane|model|kind|batch] [--tasks <path>] [--json]',
    '',
    'Four analytical views over continuous usage, ledger attempts, and transitions:',
    '  (1) cost by model',
    '  (2) cost/outcome by pane',
    '  (3) cost/outcome by kind',
    '  (4) batch timeline for tasks.json',
    '',
    'flags:',
    '  --today         lookback window bounded to today (00:00 local to now, matches tokscale --today)',
    '  --days N        lookback window in days (default: 30)',
    '  --by VIEW       grouping: model (default), pane, kind, or batch',
    '  --tasks <path>  tasks.json path for batch view (default: docs/orchestration/tasks.json)',
    '  --json          emit clean machine-readable JSON',
    '  -h, --help      show this help',
    '',
    'Privacy line:',
    '  samples store numbers and names, never prompts, transcripts or screens.',
    '',
  ].join('\n');
}

function main(argv = []) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(helpText());
    return 0;
  }
  const json = argv.includes('--json');
  const today = argv.includes('--today');
  let days = 30;
  let by = 'model';
  let tasksFile = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--days' && i + 1 < argv.length) {
      days = Number(argv[++i]);
      if (!Number.isFinite(days) || days <= 0) {
        process.stderr.write('roostr analytics: --days must be a positive number\n');
        return 2;
      }
    } else if (a === '--by' && i + 1 < argv.length) {
      by = argv[++i];
      if (!VIEWS.includes(by)) {
        process.stderr.write(`roostr analytics: --by must be one of: ${VIEWS.join(', ')}\n`);
        return 2;
      }
    } else if (a === '--tasks' && i + 1 < argv.length) {
      tasksFile = argv[++i];
    }
  }

  const result = query({ days, today, by, tasksFile });
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(formatText(result) + '\n');
  }
  return 0;
}

module.exports = {
  VIEWS,
  parseIso,
  round,
  confidenceForSamples,
  normalizeSample,
  analyzeByModel,
  analyzeByPane,
  analyzeByKind,
  analyzeBatchTimeline,
  query,
  formatText,
  helpText,
  main,
};
