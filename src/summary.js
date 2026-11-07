'use strict';
// `crew-board summary [--json] [--days 30] [--from <path>] [--no-write]`
//
// Joins spawn and outcome entries by run id and aggregates first try pass
// rates, cost and rework by archetype kind, effort, tier and model. Writes
// ~/.crew-board/summary.json (override CREW_BOARD_SUMMARY) unless --no-write.
//
// --from reads a JSONL file instead of the plugin ledger. It accepts both the
// plugin schema (spawn and outcome entries joined by run id) and the global
// team schema (`date`, `project`, `task`, `model`, `effort`, `kind`,
// `outcome`, `rework`, `cost_usd`, `notes`), normalizing both into one row.
// Sources are read only. The source ledger is never written.

const fs = require('fs');
const os = require('os');
const path = require('path');
const ledger = require('./ledger');
const state = require('./state');

const EFFORTS = ['low', 'medium', 'high'];
const TIERS = ['fast', 'balanced', 'reasoning'];
const EFFORT_TIER = { low: 'fast', medium: 'balanced', high: 'reasoning' };
const OUTCOME_ALIASES = { accepted: 'pass', abandoned: 'fail' };

function summaryPath() {
  if (process.env.ROOSTR_SUMMARY) return process.env.ROOSTR_SUMMARY;
  if (process.env.CREW_BOARD_SUMMARY) return process.env.CREW_BOARD_SUMMARY;
  const roostr = path.join(os.homedir(), '.roostr', 'summary.json');
  const legacy = path.join(os.homedir(), '.crew-board', 'summary.json');
  if (fs.existsSync(roostr) || !fs.existsSync(legacy)) return roostr;
  return legacy;
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function newStats() {
  return { count: 0, pass: 0, costSum: 0, costN: 0, durSum: 0, durN: 0, reworkSum: 0 };
}

function firstTry(run) {
  return run.outcome === 'pass' && (Number.isFinite(run.rework) ? run.rework : 0) === 0;
}

function add(stats, run) {
  stats.count++;
  if (firstTry(run)) stats.pass++;
  if (Number.isFinite(run.cost)) {
    stats.costSum += run.cost;
    stats.costN++;
  }
  if (Number.isFinite(run.durationMs)) {
    stats.durSum += run.durationMs;
    stats.durN++;
  }
  stats.reworkSum += Number.isFinite(run.rework) ? run.rework : 0;
}

function rate(stats) {
  return stats.count ? round((stats.pass / stats.count) * 100, 1) : null;
}

function finish(stats) {
  return {
    count: stats.count,
    first_try_pass_rate: rate(stats),
    avg_cost_usd: stats.costN ? round(stats.costSum / stats.costN, 4) : null,
    avg_duration_ms: stats.durN ? Math.round(stats.durSum / stats.durN) : null,
    avg_rework: stats.count ? round(stats.reworkSum / stats.count, 2) : null,
  };
}

function brief(stats) {
  return { count: stats.count, first_try_pass_rate: rate(stats) };
}

function bestModel(byModel) {
  let best = null;
  for (const [model, stats] of Object.entries(byModel)) {
    if (model === 'unknown' || !stats.count) continue;
    const passRate = Number.isFinite(stats.first_try_pass_rate) ? stats.first_try_pass_rate : 0;
    if (!best
      || passRate > best.passRate
      || (passRate === best.passRate && stats.count > best.count)) {
      best = { model, passRate, count: stats.count };
    }
  }
  return best ? best.model : 'unknown';
}

function effortOf(value) {
  return EFFORTS.includes(value) ? value : 'medium';
}

function tierOf(value, effort) {
  if (TIERS.includes(value)) return value;
  return EFFORT_TIER[effort] || 'unknown';
}

function finiteNumber(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function outcomeOf(value) {
  return OUTCOME_ALIASES[value] || value;
}

// Rework is usually a count, but older lines also carry text. A numeric value
// stays a count. "none" or empty text means no rework. Any other text means
// rework happened, so it counts as one rework unit and never crashes the sum.
function reworkOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : 0;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text || /^none$/i.test(text)) return 0;
    const n = Number(text);
    if (Number.isFinite(n)) return Math.max(0, n);
    return 1;
  }
  return 0;
}

// One global ledger line becomes one row. Global lines carry no run id, so
// there is nothing to join: the line is the finished run.
function normalizeGlobal(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.outcome !== 'string' || !entry.outcome) return null;
  const effort = EFFORTS.includes(entry.effort) ? entry.effort : 'unknown';
  return {
    date: entry.date || entry.at || entry.ts || null,
    kind: entry.kind || 'feature',
    effort,
    tier: tierOf(entry.tier, effort),
    model: entry.model || 'unknown',
    outcome: outcomeOf(entry.outcome),
    cost: finiteNumber(entry.cost_usd, finiteNumber(entry.cost, null)),
    durationMs: finiteNumber(entry.durationMs, null),
    rework: reworkOf(entry.rework),
  };
}

function readEntriesFromFile(file, onWarn) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) out.push(entry);
      else if (onWarn) onWarn(`line ${i + 1}: not a JSON object`);
    } catch {
      if (onWarn) onWarn(`line ${i + 1}: malformed JSON`);
    }
  }
  return out;
}

function isPluginEntry(entry) {
  return entry.event === 'spawn' || entry.event === 'outcome';
}

function pluginRows(entries, cutoff, onWarn) {
  const spawns = new Map();
  for (const e of entries) {
    if (!e || e.event !== 'spawn' || !e.runId) continue;
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || at < cutoff) continue;
    spawns.set(e.runId, e);
  }

  const outcomes = new Map();
  for (const e of entries) {
    if (!e || e.event !== 'outcome' || !e.runId) continue;
    if (outcomes.has(e.runId)) {
      if (onWarn) onWarn(`ignoring duplicate outcome for run ${e.runId}`);
      continue;
    }
    outcomes.set(e.runId, e);
  }

  const rows = [];
  for (const [runId, spawnEntry] of spawns) {
    const outcomeEntry = outcomes.get(runId);
    if (!outcomeEntry) continue;
    const effort = effortOf(spawnEntry.effort);
    rows.push({
      date: spawnEntry.at || null,
      kind: spawnEntry.kind || 'feature',
      effort,
      tier: tierOf(spawnEntry.tier, effort),
      model: spawnEntry.model || 'unknown',
      outcome: outcomeOf(outcomeEntry.outcome),
      cost: finiteNumber(outcomeEntry.cost, null),
      durationMs: finiteNumber(outcomeEntry.durationMs, null),
      rework: reworkOf(outcomeEntry.rework),
    });
  }
  return rows;
}

function globalRows(entries, cutoff) {
  const rows = [];
  for (const e of entries) {
    const row = normalizeGlobal(e);
    if (!row) continue;
    const at = Date.parse(row.date || '');
    if (Number.isFinite(at) && at < cutoff) continue;
    rows.push(row);
  }
  return rows;
}

function summarize(options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const days = Number.isFinite(options.days) && options.days > 0 ? options.days : 30;
  const onWarn = typeof options.onWarn === 'function' ? options.onWarn : null;
  const entries = Array.isArray(options.entries) ? options.entries : ledger.readEntries();
  const cutoff = now - days * 24 * 60 * 60 * 1000;

  const plugin = entries.filter((e) => e && isPluginEntry(e));
  const global = entries.filter((e) => e && !isPluginEntry(e));
  const rows = [
    ...pluginRows(plugin, cutoff, onWarn),
    ...globalRows(global, cutoff),
  ];

  const kinds = new Map();
  const allEffort = new Map(EFFORTS.map((e) => [e, newStats()]));
  const allTier = new Map(TIERS.map((t) => [t, newStats()]));
  const allModel = new Map();

  const bucket = (map, key) => {
    if (!map.has(key)) map.set(key, newStats());
    return map.get(key);
  };

  for (const row of rows) {
    if (!kinds.has(row.kind)) {
      kinds.set(row.kind, {
        total: newStats(),
        effort: new Map(EFFORTS.map((e) => [e, newStats()])),
        tier: new Map(TIERS.map((t) => [t, newStats()])),
        model: new Map(),
        modelEffort: new Map(),
      });
    }
    const group = kinds.get(row.kind);
    add(group.total, row);
    add(bucket(group.effort, row.effort), row);
    add(bucket(group.tier, row.tier), row);
    add(bucket(group.model, row.model), row);
    if (!group.modelEffort.has(row.model)) group.modelEffort.set(row.model, new Map());
    add(bucket(group.modelEffort.get(row.model), row.effort), row);

    add(bucket(allEffort, row.effort), row);
    add(bucket(allTier, row.tier), row);
    add(bucket(allModel, row.model), row);
  }

  const byKind = {};
  const byKindModel = {};
  const byKindEffort = {};
  const byKindModelEffort = {};
  let runs = 0;
  for (const [kind, group] of kinds) {
    const stats = finish(group.total);
    const models = {};
    for (const [model, s] of group.model) models[model] = finish(s);
    const efforts = {};
    for (const [eff, s] of group.effort) efforts[eff] = brief(s);
    const tiers = {};
    for (const [tier, s] of group.tier) tiers[tier] = brief(s);
    const modelEfforts = {};
    for (const [model, byEffort] of group.modelEffort) {
      modelEfforts[model] = {};
      for (const [eff, s] of byEffort) modelEfforts[model][eff] = brief(s);
    }
    byKind[kind] = {
      ...stats,
      best_model: bestModel(models),
      by_effort: efforts,
      by_tier: tiers,
      by_model: models,
      by_kind_model: models,
      by_kind_model_effort: modelEfforts,
    };
    byKindModel[kind] = models;
    byKindEffort[kind] = efforts;
    byKindModelEffort[kind] = modelEfforts;
    runs += stats.count;
  }

  const byModel = {};
  for (const [model, s] of allModel) byModel[model] = finish(s);
  const byEffort = {};
  for (const [eff, s] of allEffort) byEffort[eff] = brief(s);
  const byTier = {};
  for (const [tier, s] of allTier) byTier[tier] = brief(s);

  return {
    generated_at: new Date(now).toISOString(),
    days,
    runs,
    by_kind: byKind,
    by_kind_model: byKindModel,
    by_kind_effort: byKindEffort,
    by_kind_model_effort: byKindModelEffort,
    by_model: byModel,
    by_effort: byEffort,
    by_tier: byTier,
  };
}

function writeSummary(data, file = summaryPath()) {
  state.writeJson(file, data);
  return file;
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function formatText(data) {
  const lines = [`summary:     ${data.runs} finished runs · ${data.days} days`];
  for (const [kind, s] of Object.entries(data.by_kind)) {
    const cost = s.avg_cost_usd === null ? '?' : `$${s.avg_cost_usd}`;
    lines.push(`${kind}:${' '.repeat(Math.max(1, 12 - kind.length))}${s.count} runs · ${s.first_try_pass_rate ?? '?'}% first try · ${cost} avg`);
  }
  if (!data.runs) lines.push('no finished runs yet');
  return lines.join('\n');
}

function main(args = []) {
  const json = args.includes('--json');
  const noWrite = args.includes('--no-write');
  const from = flagValue(args, '--from');
  const daysRaw = flagValue(args, '--days');
  const days = daysRaw === null ? 30 : Number(daysRaw);
  if (args.includes('--from') && (from === null || from.startsWith('--'))) {
    console.error('usage: crew-board summary [--json] [--days 30] [--from <path>] [--no-write]');
    return 2;
  }
  if (!Number.isFinite(days) || days <= 0) {
    console.error('usage: crew-board summary [--json] [--days 30] [--from <path>] [--no-write]');
    return 2;
  }

  const onWarn = (msg) => console.error(`summary: ${msg}`);
  let entries;
  if (from !== null) {
    if (!fs.existsSync(from)) {
      console.error(`crew-board summary: no such file: ${from}`);
      return 1;
    }
    try {
      entries = readEntriesFromFile(from, onWarn);
    } catch (e) {
      console.error(`crew-board summary: ${e.message}`);
      return 1;
    }
  }

  const data = summarize(entries === undefined ? { days, onWarn } : { entries, days, onWarn });
  if (!noWrite) {
    try {
      writeSummary(data);
    } catch (e) {
      console.error(`crew-board summary: ${e.message}`);
      return 1;
    }
  }

  if (json) console.log(JSON.stringify(data, null, 2));
  else console.log(formatText(data));
  return 0;
}

module.exports = {
  summaryPath,
  summarize,
  writeSummary,
  readEntriesFromFile,
  normalizeGlobal,
  main,
};
