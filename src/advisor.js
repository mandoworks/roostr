'use strict';
// `crew-board recommend "<task>" [--effort <eff>] [--model <mod>] [--json]`
//
// Zero-overhead task analyzer and recommendation engine. Suggests a neutral
// speed tier and reasoning effort based on task archetype and the empirical
// orchestration ledger stats.

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const crewfile = require('./crewfile');

const EFFORT_RANK = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };
const EFFORT_ORDER = ['low', 'medium', 'high'];
const TIER_BY_EFFORT = { low: 'fast', medium: 'balanced', high: 'reasoning' };
const TIERS = ['fast', 'balanced', 'reasoning'];

// Built-in seed archetypes used when no external orchestration summary is found.
const ARCHETYPES = {
  docs: {
    patterns: [/\b(docs?|documentation|readme|markdown|typos?|comments?|license|formatting|lint|css|style|copy|naming|rename)\b/i],
    tier: 'fast',
    effort: 'low',
    rationale: 'Rote work passes reliably on low effort; high effort wastes tokens without quality gains.',
  },
  review: {
    patterns: [/\b(review|audit|diff|inspect|analyze|analysis|check)\b/i],
    tier: 'balanced',
    effort: 'medium',
    rationale: 'Code reviews need structured inspection but rarely deep recursive generation.',
  },
  tests: {
    patterns: [/\b(tests?|spec|units?|fixtures?|triage|flaky|assert|e2e|coverage)\b/i],
    tier: 'balanced',
    effort: 'medium',
    rationale: 'Test cases require verifying branch conditions, fitting well within medium reasoning.',
  },
  tooling: {
    patterns: [/\b(tool|tooling|script|cli|pipeline|blender|automation|ci|cd|build)\b/i],
    tier: 'balanced',
    effort: 'medium',
    rationale: 'Scripts and pipelines have deterministic error outputs that resolve quickly on medium effort.',
  },
  complex: {
    patterns: [/\b(concurrency|race condition|deadlock|mutex|async|thread|memory leak|crash|rearchitect|refactor architecture|security|crypto|kernel|engine core|compiler)\b/i],
    tier: 'reasoning',
    effort: 'high',
    rationale: 'Complex state and architectural changes suffer high rework rates when under-provisioned.',
  },
  feature: {
    patterns: [/.*/],
    tier: 'balanced',
    effort: 'medium',
    rationale: 'Standard feature work balances code generation with moderate reasoning.',
  },
};

let cachedSummary = null;
let cachedSummaryMtime = null;
let cachedSummaryPath = null;

const modelMapCache = new Map();

function summaryPath() {
  if (process.env.ROOSTR_SUMMARY) return process.env.ROOSTR_SUMMARY;
  if (process.env.CREW_BOARD_SUMMARY) return process.env.CREW_BOARD_SUMMARY;
  const roostr = path.join(os.homedir(), '.roostr', 'summary.json');
  const legacy = path.join(os.homedir(), '.crew-board', 'summary.json');
  if (fs.existsSync(roostr) || !fs.existsSync(legacy)) return roostr;
  return legacy;
}

function modelMapPath() {
  if (process.env.ROOSTR_MODELS) return process.env.ROOSTR_MODELS;
  if (process.env.CREW_BOARD_MODELS) return process.env.CREW_BOARD_MODELS;
  const roostr = path.join(os.homedir(), '.roostr', 'models.json');
  const legacy = path.join(os.homedir(), '.crew-board', 'models.json');
  if (fs.existsSync(roostr) || !fs.existsSync(legacy)) return roostr;
  return legacy;
}

function loadSummary() {
  const p = summaryPath();
  try {
    const stat = fs.statSync(p);
    const mtime = stat.mtimeMs;
    if (cachedSummary && cachedSummaryPath === p && cachedSummaryMtime === mtime) {
      return cachedSummary;
    }
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data && typeof data === 'object') {
      cachedSummary = data;
      cachedSummaryMtime = mtime;
      cachedSummaryPath = p;
      return data;
    }
  } catch {
    cachedSummary = null;
    cachedSummaryMtime = null;
    cachedSummaryPath = null;
  }
  return null;
}

function mapFrom(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const out = {};
  for (const tier of TIERS) {
    if (typeof data[tier] === 'string' && data[tier].trim()) out[tier] = data[tier].trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

function readModelMapFile(p) {
  try {
    const stat = fs.statSync(p);
    const mtime = stat.mtimeMs;
    const cached = modelMapCache.get(p);
    if (cached && cached.mtime === mtime) return cached.value;
    const value = mapFrom(JSON.parse(fs.readFileSync(p, 'utf8')));
    modelMapCache.set(p, { mtime, value });
    return value;
  } catch {
    modelMapCache.delete(p);
    return null;
  }
}

// Tier map order: an explicit path, then CREW_BOARD_MODELS, then the setup
// config, then the older models.json file. Any missing or broken tier is
// simply absent, never a crash.
function loadModelMap(p = null) {
  if (p) return readModelMapFile(p);
  if (process.env.CREW_BOARD_MODELS) return readModelMapFile(process.env.CREW_BOARD_MODELS);
  const fromConfig = mapFrom(config.loadConfig().config.models);
  if (fromConfig) return fromConfig;
  return readModelMapFile(path.join(os.homedir(), '.crew-board', 'models.json'));
}

function detectKind(task) {
  if (!task || typeof task !== 'string') return 'feature';
  for (const [kind, def] of Object.entries(ARCHETYPES)) {
    if (kind === 'feature') continue;
    for (const pat of def.patterns) {
      if (pat.test(task)) return kind;
    }
  }
  return 'feature';
}

function passRate(entry) {
  if (!entry || !entry.count) return null;
  const v = entry.first_try_pass_rate;
  return Number.isFinite(v) ? v : null;
}

function confidenceFor(samples) {
  if (samples >= 10) return 'high';
  if (samples >= 3) return 'medium';
  return 'low';
}

function modelStat(model, entry) {
  return {
    model,
    count: entry && Number.isFinite(entry.count) ? entry.count : 0,
    passRate: passRate(entry),
    avgCost: entry && Number.isFinite(entry.avg_cost_usd) ? entry.avg_cost_usd : null,
    avgRework: entry && Number.isFinite(entry.avg_rework) ? entry.avg_rework : null,
  };
}

function findKindStats(summary, kind) {
  if (!summary || !summary.by_kind) return null;
  if (summary.by_kind[kind]) return { kind, stats: summary.by_kind[kind] };
  const k = Object.keys(summary.by_kind).find((sk) => sk.includes(kind) || kind.includes(sk));
  return k && summary.by_kind[k] ? { kind: k, stats: summary.by_kind[k] } : null;
}

function kindSettings(cfg, kind, crew = null) {
  const merged = config.mergeTaskKinds((cfg && cfg.taskKinds) || {}, crew && crew.taskKinds);
  return merged[kind] || { tool: '', model: '', fallbacks: [], effort: '' };
}

function recommend(task, currentEffort = null, currentModel = null, options = {}) {
  const requestedKind = typeof options.kind === 'string' && options.kind.trim() ? options.kind.trim() : null;
  const kind = requestedKind || detectKind(task);
  const archetype = ARCHETYPES[kind] || ARCHETYPES.feature;
  const summary = loadSummary();
  const models = loadModelMap();
  const cfg = options.config || config.loadConfig().config;
  const settings = kindSettings(cfg, kind, options.crew);

  let recommendedTier = archetype.tier;
  let recommendedEffort = archetype.effort;
  let empirical = null;
  let samples = 0;
  let source = 'default';
  let kindStats = null;

  if (settings.effort && EFFORT_ORDER.includes(settings.effort)) {
    recommendedEffort = settings.effort;
    recommendedTier = TIER_BY_EFFORT[recommendedEffort];
    source = 'task-kind';
  }

  const found = findKindStats(summary, kind);
  if (found) {
    kindStats = found.stats;
    samples = Number.isFinite(kindStats.count) ? kindStats.count : 0;
    empirical = {
      kind: found.kind,
      tasks: samples,
      passRate: Number.isFinite(kindStats.first_try_pass_rate) ? kindStats.first_try_pass_rate : null,
      bestModel: kindStats.best_model || null,
      avgCost: Number.isFinite(kindStats.avg_cost_usd) ? kindStats.avg_cost_usd : null,
    };
    if (samples > 0 && source !== 'task-kind') source = 'ledger';
  }

  // The ledger may lower or raise the archetype default, one tier at a time.
  // An explicit task-kind effort is a pin and wins over the ledger.
  if (source !== 'task-kind' && kindStats && samples >= 5 && kindStats.by_effort) {
    const byEffort = kindStats.by_effort;
    let chosen = null;
    for (const eff of EFFORT_ORDER) {
      const entry = byEffort[eff];
      const rate = passRate(entry);
      if (entry && entry.count > 0 && rate !== null && rate >= 80) {
        chosen = eff;
        break;
      }
    }
    if (chosen) {
      recommendedEffort = chosen;
      recommendedTier = TIER_BY_EFFORT[chosen];
    }
    const entry = byEffort[recommendedEffort];
    const rate = passRate(entry);
    if (entry && entry.count >= 5 && rate !== null && rate < 60) {
      const i = EFFORT_ORDER.indexOf(recommendedEffort);
      if (i >= 0 && i < EFFORT_ORDER.length - 1) {
        recommendedEffort = EFFORT_ORDER[i + 1];
        recommendedTier = TIER_BY_EFFORT[recommendedEffort];
      }
    }
  }

  const preferredModel = settings.model || (models && models[recommendedTier]) || null;
  const fallbacks = Array.isArray(settings.fallbacks) ? settings.fallbacks.slice(0, 5) : [];
  const availableFallbacks = fallbacks.filter((m) => !cfg.disabledModels.includes(m));
  let recommendedModel = preferredModel;
  let modelWarning = null;
  let requiresModelChoice = false;
  if (recommendedModel && cfg.disabledModels.includes(recommendedModel)) {
    recommendedModel = null;
    modelWarning = 'configure an available model';
    requiresModelChoice = true;
  }
  const recommendedTool = settings.tool || (cfg.roles && cfg.roles.worker && cfg.roles.worker.tool) || cfg.defaultTool || null;
  const toolSource = settings.tool ? 'task-kind' : (cfg.roles && cfg.roles.worker && cfg.roles.worker.tool ? 'role' : 'global');
  const modelSource = settings.model ? 'task-kind' : (preferredModel ? 'tier' : null);
  const confidence = confidenceFor(samples);

  const byModel = (kindStats && kindStats.by_model) || {};
  const configured = recommendedModel ? modelStat(recommendedModel, byModel[recommendedModel]) : null;
  const bestName = kindStats && kindStats.best_model && kindStats.best_model !== 'unknown' ? kindStats.best_model : null;
  const bestEntry = bestName ? byModel[bestName] : null;
  const modelStats = {
    configured,
    best: bestName
      ? {
        model: bestName,
        count: bestEntry && Number.isFinite(bestEntry.count) ? bestEntry.count : 0,
        passRate: passRate(bestEntry),
        avgCost: bestEntry && Number.isFinite(bestEntry.avg_cost_usd) ? bestEntry.avg_cost_usd : null,
      }
      : null,
  };

  // Generate advisory if active effort or model diverges notably from recommended
  let advisory = null;
  const effNorm = currentEffort ? currentEffort.toLowerCase() : null;
  const curRank = effNorm ? EFFORT_RANK[effNorm] || 2 : null;
  const recRank = EFFORT_RANK[recommendedEffort] || 2;

  if (curRank !== null) {
    if (curRank >= 3 && recRank <= 1) {
      advisory = `⚡ reduce effort to low (rote task, saves ~75% tokens)`;
    } else if (curRank <= 1 && recRank >= 3) {
      advisory = `⚡ increase effort to high (prevents costly rework rounds)`;
    }
  }

  if (!advisory && currentModel && models && recommendedTier === 'fast' && models.fast && currentModel !== models.fast) {
    advisory = `⚡ switch to the fast tier (cheaper and passes rote tasks easily)`;
  }

  return {
    task: task || '',
    kind,
    recommendedTier,
    recommendedEffort,
    recommendedModel,
    recommendedTool,
    preferredModel,
    fallbacks,
    availableFallbacks,
    requiresModelChoice,
    settings,
    toolSource,
    modelSource,
    rationale: source === 'task-kind'
      ? `Task kind ${kind} is pinned in settings to ${recommendedEffort} effort.`
      : archetype.rationale,
    advisory,
    empirical,
    samples,
    confidence,
    source,
    modelWarning,
    modelStats,
  };
}

function parseArgs(args) {
  let task = '';
  let effort = null;
  let model = null;
  let kind = null;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') {
      json = true;
    } else if (a === '--effort' && i + 1 < args.length) {
      effort = args[++i];
    } else if (a === '--model' && i + 1 < args.length) {
      model = args[++i];
    } else if (a === '--kind' && i + 1 < args.length) {
      kind = args[++i];
    } else if (a === '-h' || a === '--help') {
      return { help: true };
    } else if (!a.startsWith('-') && !task) {
      task = a;
    }
  }
  return { task, effort, model, kind, json };
}

function formatHelp() {
  return [
    'usage: crew-board recommend "<task>" [--kind <kind>] [--effort <eff>] [--model <mod>] [--json]',
    '',
    'Suggests optimal speed tier and reasoning effort based on task pattern and orchestration history.',
    '',
    'options:',
    '  --kind <kind>                override the detected task kind',
    '  --effort <low|medium|high>   current effort to evaluate against the task',
    '  --model <name>               current model to evaluate against the task',
    '  --json                       output raw JSON recommendation',
    '  -h, --help                   display this help text',
  ].join('\n');
}

function main(args) {
  const opts = parseArgs(args);
  if (opts.help || !opts.task) {
    console.log(formatHelp());
    return opts.help ? 0 : 2;
  }

  const crewPath = crewfile.findCrewFile(process.cwd());
  const crew = crewPath ? crewfile.loadCrew(crewPath) : null;
  const rec = recommend(opts.task, opts.effort, opts.model, { kind: opts.kind, crew });

  if (opts.json) {
    console.log(JSON.stringify(rec, null, 2));
    return 0;
  }

  const recommended = `recommended: tier ${rec.recommendedTier} · effort ${rec.recommendedEffort}`
    + (rec.recommendedModel ? ` · model ${rec.recommendedModel}` : '');
  const out = [
    `task:        ${rec.task}`,
    `archetype:   ${rec.kind}`,
    recommended,
    `tool:        ${rec.recommendedTool || '?'}${rec.toolSource ? ` (${rec.toolSource})` : ''}`,
    `rationale:   ${rec.rationale}`,
  ];
  if (rec.fallbacks.length) out.push(`fallbacks:   ${rec.fallbacks.join(', ')}`);
  if (rec.requiresModelChoice) out.push('model choice: pick the preferred model or one fallback; nothing was substituted');
  if (rec.modelWarning) out.push(`model:       ${rec.modelWarning}`);

  if (rec.empirical) {
    out.push(`empirical:   ${rec.empirical.tasks} tasks (${rec.empirical.passRate ?? '?'}% first-try pass, best: ${rec.empirical.bestModel || '?'})`);
  }

  const recorded = rec.modelStats.best && rec.modelStats.best.count >= 3
    ? rec.modelStats.best
    : rec.modelStats.configured && rec.modelStats.configured.count >= 3 ? rec.modelStats.configured : null;
  if (recorded) {
    const cost = recorded.avgCost === null ? '' : `, $${recorded.avgCost} avg`;
    out.push(`recorded:    ${recorded.model} ${recorded.count} runs, ${recorded.passRate ?? '?'}% first try${cost}`);
  }

  if (rec.advisory) {
    out.push(`advisory:    ${rec.advisory}`);
  }

  console.log(out.join('\n'));
  return 0;
}

module.exports = {
  detectKind,
  kindSettings,
  recommend,
  loadSummary,
  loadModelMap,
  summaryPath,
  modelMapPath,
  parseArgs,
  main,
};
