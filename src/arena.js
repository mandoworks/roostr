'use strict';
// `roostr arena [--share] | arena export [--days N] | arena import --from <file>`
//
// The Arena is the community-facing side of the orchestration ledger. Unlike a
// raw token counter, it records whether each (kind, tool, model, effort) tuple
// passed on the first try, how many rework cycles it needed and the cost per
// successful pass.
//
// Privacy invariant: the sanitized payload carries only aggregate counts keyed
// by kind, tool, model and effort plus a truncated salted host hash. Repo
// names, file paths, task titles, pane names and environment variables are
// never read into the payload, so they can never leak.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ledger = require('./ledger');
const state = require('./state');

const SCHEMA = 1;
const EFFORTS = ['low', 'medium', 'high'];
const MIN_COMMUNITY_RUNS = 5;
const OUTCOME_ALIASES = { accepted: 'pass', abandoned: 'fail' };

function round(n, digits = 2) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function finiteNumber(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function outcomeOf(value) {
  return OUTCOME_ALIASES[value] || value;
}

// Rework is usually a count, but older lines also carry text. "none" or empty
// text means no rework. Any other text counts as one rework unit.
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

function anonId() {
  return crypto
    .createHash('sha256')
    .update(os.hostname() + ':roostr-arena')
    .digest('hex')
    .slice(0, 12);
}

// One normalized run. Nothing here is identifying: kind, tool, model, effort
// and outcome numbers only.
function normalizeRow(entry) {
  const effort = typeof entry.effort === 'string' && entry.effort ? entry.effort : 'unknown';
  return {
    kind: entry.kind || 'feature',
    tool: entry.tool || 'unknown',
    model: entry.model || 'unknown',
    effort,
    outcome: outcomeOf(entry.outcome),
    rework: reworkOf(entry.rework),
    cost: finiteNumber(entry.cost_usd, finiteNumber(entry.cost, null)),
    durationMs: finiteNumber(entry.durationMs, null),
  };
}

// Plugin entries carry spawn and outcome rows joined by run id. Global lines
// carry the whole finished run on one line. Both normalize into one row.
function rowsFromEntries(entries, cutoff) {
  const spawns = new Map();
  const outcomes = new Map();
  const globals = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    if (e.event === 'spawn' && e.runId) {
      spawns.set(e.runId, e);
    } else if (e.event === 'outcome' && e.runId) {
      if (!outcomes.has(e.runId)) outcomes.set(e.runId, e);
    } else if (typeof e.outcome === 'string' && e.outcome) {
      globals.push(e);
    }
  }

  const rows = [];
  for (const [runId, spawn] of spawns) {
    const outcome = outcomes.get(runId);
    if (!outcome) continue;
    const at = Date.parse(spawn.at || '');
    if (Number.isFinite(at) && at < cutoff) continue;
    rows.push(normalizeRow({
      kind: spawn.kind,
      tool: spawn.tool || spawn.recommendedTool,
      model: spawn.model,
      effort: spawn.effort,
      outcome: outcome.outcome,
      rework: outcome.rework,
      cost: outcome.cost,
      durationMs: outcome.durationMs,
    }));
  }
  for (const e of globals) {
    const at = Date.parse(e.date || e.at || e.ts || '');
    if (Number.isFinite(at) && at < cutoff) continue;
    rows.push(normalizeRow(e));
  }
  return rows;
}

function buildArenaPayload(entries, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const days = Number.isFinite(opts.days) && opts.days > 0 ? opts.days : 30;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const source = Array.isArray(entries)
    ? entries
    : (opts.entries && Array.isArray(opts.entries) ? opts.entries : ledger.readEntries());
  const rows = rowsFromEntries(source, cutoff);

  const buckets = new Map();
  for (const r of rows) {
    const key = `${r.kind}\u0000${r.tool}\u0000${r.model}\u0000${r.effort}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        kind: r.kind,
        tool: r.tool,
        model: r.model,
        effort: r.effort,
        runs: 0,
        firstTryPasses: 0,
        reworkSum: 0,
        costUsdSum: 0,
        durationSecSum: 0,
      });
    }
    const b = buckets.get(key);
    b.runs++;
    if (r.outcome === 'pass' && r.rework === 0) b.firstTryPasses++;
    b.reworkSum += Number.isFinite(r.rework) ? r.rework : 0;
    if (Number.isFinite(r.cost)) b.costUsdSum += r.cost;
    if (Number.isFinite(r.durationMs)) b.durationSecSum += r.durationMs / 1000;
  }

  const out = [];
  for (const b of buckets.values()) {
    out.push({
      kind: b.kind,
      tool: b.tool,
      model: b.model,
      effort: b.effort,
      runs: b.runs,
      firstTryPasses: b.firstTryPasses,
      passRate: b.runs ? round((b.firstTryPasses / b.runs) * 100, 1) : null,
      reworkSum: round(b.reworkSum, 2),
      avgRework: b.runs ? round(b.reworkSum / b.runs, 2) : 0,
      costUsdSum: round(b.costUsdSum, 4),
      avgCostPerPassUsd: b.firstTryPasses ? round(b.costUsdSum / b.firstTryPasses, 4) : null,
      durationSecSum: round(b.durationSecSum, 1),
    });
  }
  out.sort((a, b) => b.runs - a.runs
    || a.kind.localeCompare(b.kind)
    || a.model.localeCompare(b.model)
    || a.effort.localeCompare(b.effort));

  return {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    days,
    anonId: anonId(),
    buckets: out,
  };
}

// Accept a payload, an analytics result, a merge output or a plain row array
// and reduce it to the few numbers the share card prints.
function costPerPassFrom(row) {
  if (Number.isFinite(row.avg_cost_per_pass_usd)) return row.avg_cost_per_pass_usd;
  const cost = Number(row.cost);
  const runs = Number(row.runs || row.count || 0);
  const rate = Number(row.first_try_pass_rate);
  if (Number.isFinite(cost) && Number.isFinite(rate) && rate > 0 && runs > 0) {
    return round(cost / (runs * (rate / 100)), 4);
  }
  return null;
}

function toCardRows(input) {
  if (!input) return [];
  const row = (b) => ({
    model: b.model || b.pane || '?',
    kind: b.kind || '',
    effort: typeof b.effort === 'string' ? b.effort : '',
    runs: Number(b.runs || b.count || b.samples || 0),
    passRate: Number.isFinite(b.passRate) ? b.passRate
      : (Number.isFinite(b.first_try_pass_rate) ? b.first_try_pass_rate : null),
    costPerPass: Number.isFinite(b.avgCostPerPassUsd) ? b.avgCostPerPassUsd
      : (Number.isFinite(b.avg_cost_per_pass_usd) ? b.avg_cost_per_pass_usd
        : (Number.isFinite(b.avgCostPerPass) ? b.avgCostPerPass : null)),
  });

  if (Array.isArray(input)) return input.map((b) => (b && typeof b === 'object' ? row(b) : null)).filter(Boolean);
  if (Array.isArray(input.buckets)) return input.buckets.map(row);
  if (Array.isArray(input.data)) {
    return input.data.map((d) => {
      const r = row(d);
      if (r.costPerPass === null) r.costPerPass = costPerPassFrom(d);
      return r;
    });
  }
  if (input.by_kind_model && typeof input.by_kind_model === 'object') {
    const out = [];
    for (const [kind, models] of Object.entries(input.by_kind_model)) {
      for (const [model, stats] of Object.entries(models || {})) {
        out.push({
          model,
          kind,
          effort: '',
          runs: Number((stats && stats.count) || 0),
          passRate: stats && Number.isFinite(stats.first_try_pass_rate) ? stats.first_try_pass_rate : null,
          costPerPass: stats && Number.isFinite(stats.avg_cost_per_pass_usd) ? stats.avg_cost_per_pass_usd : null,
        });
      }
    }
    return out;
  }
  return [];
}

function formatShareCard(summaryOrPayload, opts = {}) {
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 10;
  const rows = toCardRows(summaryOrPayload)
    .filter((r) => r.runs > 0 || r.passRate !== null)
    .sort((a, b) => {
      const pa = a.passRate === null ? -1 : a.passRate;
      const pb = b.passRate === null ? -1 : b.passRate;
      if (pb !== pa) return pb - pa;
      const ca = a.costPerPass === null ? Infinity : a.costPerPass;
      const cb = b.costPerPass === null ? Infinity : b.costPerPass;
      if (ca !== cb) return ca - cb;
      return b.runs - a.runs;
    })
    .slice(0, limit);

  const title = opts.title || 'Roostr Arena: first-try leaderboard';
  const lines = [
    title,
    '-'.repeat(title.length),
    'rank  ' + 'model'.padEnd(24) + 'effort'.padEnd(8) + 'runs'.padStart(6) + 'pass%'.padStart(8) + '$/pass'.padStart(10),
  ];
  if (!rows.length) {
    lines.push('(no finished runs recorded yet)');
  } else {
    rows.forEach((r, i) => {
      const model = r.model.slice(0, 23).padEnd(24);
      const effort = (r.effort || '-').slice(0, 7).padEnd(8);
      const runs = String(r.runs).padStart(6);
      const pass = (r.passRate === null ? '?' : `${r.passRate}%`).padStart(8);
      const cost = (r.costPerPass === null ? '-' : `$${r.costPerPass.toFixed(4)}`).padStart(10);
      lines.push(`${String(i + 1).padEnd(6)}${model}${effort}${runs}${pass}${cost}`);
    });
  }
  lines.push('');
  lines.push('Generated by roostr (github.com/mandoworks/roostr) · https://roostr.mando.works/leaderboards');
  return lines.join('\n');
}

function globalSummaryPath() {
  return process.env.ROOSTR_GLOBAL_SUMMARY || path.join(state.stateDir(), 'global-summary.json');
}

function readGlobalSummary(file = globalSummaryPath()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

// A (kind, model) bucket with fewer than 5 local runs falls back to the
// community summary, tagged so callers can show where the number came from.
function mergeGlobalSummary(localSummary, globalSummary) {
  const local = (localSummary && localSummary.by_kind_model) || {};
  const global = (globalSummary && globalSummary.by_kind_model) || {};
  const out = {};
  for (const [kind, models] of Object.entries(local)) {
    out[kind] = {};
    for (const [model, stats] of Object.entries(models || {})) {
      const count = Number.isFinite(stats && stats.count) ? stats.count : 0;
      const g = global[kind] && global[kind][model];
      if (count < MIN_COMMUNITY_RUNS && g && Number.isFinite(g.count) && g.count >= MIN_COMMUNITY_RUNS) {
        out[kind][model] = { ...g, source: 'community' };
      } else {
        out[kind][model] = { ...stats, source: 'local' };
      }
    }
  }
  return { ...(localSummary || {}), by_kind_model: out };
}

// Turn an uploaded file into a global summary. Accepts both the sanitized
// arena payload (buckets) and an already aggregated by_kind_model summary.
function summaryFromPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('not a JSON object');
  }
  if (raw.by_kind_model && typeof raw.by_kind_model === 'object' && !Array.isArray(raw.by_kind_model)) {
    return {
      schema: raw.schema || SCHEMA,
      generatedAt: raw.generatedAt || new Date().toISOString(),
      anonId: typeof raw.anonId === 'string' ? raw.anonId : null,
      by_kind_model: raw.by_kind_model,
    };
  }
  if (!Array.isArray(raw.buckets)) throw new Error('missing buckets or by_kind_model');

  const byKindModel = {};
  for (const b of raw.buckets) {
    if (!b || typeof b !== 'object' || !b.model) continue;
    const kind = b.kind || 'feature';
    if (!byKindModel[kind]) byKindModel[kind] = {};
    const runs = Number(b.runs) || 0;
    const passes = Number(b.firstTryPasses) || 0;
    const cost = Number(b.costUsdSum) || 0;
    const rework = Number(b.reworkSum) || 0;
    byKindModel[kind][b.model] = {
      count: runs,
      first_try_pass_rate: runs ? round((passes / runs) * 100, 1) : null,
      avg_cost_usd: runs ? round(cost / runs, 4) : null,
      avg_rework: runs ? round(rework / runs, 2) : null,
    };
  }
  return {
    schema: SCHEMA,
    generatedAt: raw.generatedAt || new Date().toISOString(),
    anonId: typeof raw.anonId === 'string' ? raw.anonId : null,
    by_kind_model: byKindModel,
  };
}

function copyToClipboard(text) {
  if (!text) return;
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  try {
    process.stdout.write(`\x1b]52;c;${b64}\x07`);
    if (process.env.TMUX) process.stdout.write(`\x1bPtmux;\x1b\x1b]52;c;${b64}\x07\x1b\\`);
  } catch {
    // A terminal without OSC 52 support simply loses the copy.
  }
  if (process.platform !== 'darwin') return;
  try {
    const child = require('node:child_process').spawn('pbcopy', []);
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  } catch {
    // pbcopy is best effort only.
  }
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function helpText() {
  return [
    'usage: roostr arena [--share]',
    '       roostr arena export [--days N]',
    '       roostr arena import --from <file>',
    '',
    'The shareable, anonymized first-try pass and cost-per-pass leaderboard.',
    '',
    'subcommands:',
    '  (default)        print the share card and copy it to the clipboard',
    '  export           print the sanitized community payload as JSON',
    '  import           validate and install a community global summary',
    '',
    'flags:',
    '  --share          print and copy the share card (same as the default)',
    '  --days N         lookback window in days (default: 30)',
    '  --from <file>    the arena payload or summary to import',
    '  -h, --help       show this help',
    '',
    'Community read path (explicit, never automatic):',
    '  https://roostr.mando.works/leaderboards',
    '  https://roostr.mando.works/arena/global-summary.json',
    '  roostr arena import --from <file>  (you download/save the file first)',
    '',
    'Privacy line: exported payloads carry counts and a truncated host hash,',
    'never repo names, paths, task titles, pane names or environment variables.',
  ].join('\n');
}

function cmdShare(argv) {
  const days = Number(flagValue(argv, '--days'));
  const payload = buildArenaPayload(undefined, { days: Number.isFinite(days) && days > 0 ? days : 30 });
  const card = formatShareCard(payload);
  process.stdout.write(card + '\n');
  copyToClipboard(card);
  return 0;
}

function cmdExport(argv) {
  const days = Number(flagValue(argv, '--days'));
  const payload = buildArenaPayload(undefined, { days: Number.isFinite(days) && days > 0 ? days : 30 });
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  return 0;
}

function cmdImport(argv) {
  const from = flagValue(argv, '--from');
  if (!from) {
    process.stderr.write('usage: roostr arena import --from <file>\n');
    return 2;
  }
  if (!fs.existsSync(from)) {
    process.stderr.write(`roostr arena: no such file: ${from}\n`);
    return 1;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(from, 'utf8'));
  } catch (e) {
    process.stderr.write(`roostr arena: ${e.message}\n`);
    return 1;
  }
  let summary;
  try {
    summary = summaryFromPayload(raw);
  } catch (e) {
    process.stderr.write(`roostr arena: invalid arena file: ${e.message}\n`);
    return 1;
  }
  const dest = globalSummaryPath();
  try {
    state.writeJson(dest, summary);
  } catch (e) {
    process.stderr.write(`roostr arena: ${e.message}\n`);
    return 1;
  }
  process.stdout.write(`roostr arena: wrote ${dest}\n`);
  process.stdout.write('roostr arena: explicit local import complete (no network fetch). Community page: https://roostr.mando.works/leaderboards\n');
  return 0;
}

function runCli(argv = []) {
  const args = argv.slice();
  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(helpText() + '\n');
    return 0;
  }
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : null;
  if (sub === 'export') return cmdExport(args.slice(1));
  if (sub === 'import') return cmdImport(args.slice(1));
  if (sub === 'share' || sub === null || args.includes('--share')) return cmdShare(args);
  process.stderr.write(`roostr arena: unknown subcommand ${sub}\n${helpText()}\n`);
  return 2;
}

module.exports = {
  SCHEMA,
  MIN_COMMUNITY_RUNS,
  buildArenaPayload,
  formatShareCard,
  globalSummaryPath,
  readGlobalSummary,
  mergeGlobalSummary,
  summaryFromPayload,
  copyToClipboard,
  helpText,
  runCli,
  main: runCli,
};
