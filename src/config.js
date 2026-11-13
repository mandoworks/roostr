'use strict';
// The user's setup: tools, preferred models, head name and role defaults. `~/.crew-board/config.json`, override with CREW_BOARD_CONFIG.
// JSON only. The crew file stays TOML.

const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('./state');

const TOOLS = ['claude', 'opencode', 'kilo', 'agy', 'codex', 'gemini'];
const ROLES = ['head-honcho', 'worker', 'reviewer'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const GRILL_MODES = ['recommended', 'none', 'custom'];
const LANGUAGES = ['en', 'es', 'pt', 'fr'];
const TASK_KINDS = ['docs', 'review', 'tests', 'tooling', 'complex', 'feature'];

const HEAD_NAMES = [
  { name: 'la-jefa', meaning: 'Spanish, the boss' },
  { name: 'el-patron', meaning: 'Spanish, the boss' },
  { name: 'il-capo', meaning: 'Italian, the boss' },
  { name: 'don', meaning: 'Italian and Spanish honorific' },
  { name: 'maharaja', meaning: 'Hindi, great king' },
  { name: 'shogun', meaning: 'Japanese, military ruler' },
  { name: 'pharaoh', meaning: 'Egyptian, great house' },
  { name: 'sultan', meaning: 'Arabic, ruler' },
  { name: 'cacique', meaning: 'Taino, chief' },
  { name: 'tlatoani', meaning: 'Nahuatl, speaker and ruler' },
];

const TIER_BY_EFFORT = { low: 'fast', medium: 'balanced', high: 'reasoning', xhigh: 'reasoning', max: 'reasoning' };

function defaultConfig() {
  return {
    version: 1,
    tools: ['claude'],
    customTools: [],
    disabledModels: [],
    defaultTool: 'claude',
    headName: 'auto',
    headLanguage: 'en',
    models: {},
    taskKinds: {
      docs: { tool: '', model: '', fallbacks: [], effort: '' },
      review: { tool: '', model: '', fallbacks: [], effort: '' },
      tests: { tool: '', model: '', fallbacks: [], effort: '' },
      tooling: { tool: '', model: '', fallbacks: [], effort: '' },
      complex: { tool: '', model: '', fallbacks: [], effort: '' },
      feature: { tool: '', model: '', fallbacks: [], effort: '' },
    },
    roles: {
      'head-honcho': { tool: 'claude', model: '', effort: 'high', args: [] },
      worker: { tool: 'claude', model: '', effort: 'medium', args: [] },
      reviewer: { tool: 'claude', model: '', effort: 'medium', args: [] },
    },
    grillSkill: { mode: 'recommended', command: '' },
    orchestration: { enabled: false },
  };
}

// Project overrides are merged field by field over the global task kinds.
function mergeTaskKinds(base = {}, overrides = {}) {
  const out = {};
  for (const kind of TASK_KINDS) {
    const b = (base && base[kind]) || {};
    const o = (overrides && overrides[kind]) || {};
    out[kind] = {
      tool: typeof o.tool === 'string' ? o.tool : (typeof b.tool === 'string' ? b.tool : ''),
      model: typeof o.model === 'string' ? o.model : (typeof b.model === 'string' ? b.model : ''),
      fallbacks: Array.isArray(o.fallbacks) ? o.fallbacks.slice() : (Array.isArray(b.fallbacks) ? b.fallbacks.slice() : []),
      effort: typeof o.effort === 'string' ? o.effort : (typeof b.effort === 'string' ? b.effort : ''),
    };
  }
  return out;
}

function configPath() {
  if (process.env.ROOSTR_CONFIG) return process.env.ROOSTR_CONFIG;
  if (process.env.CREW_BOARD_CONFIG) return process.env.CREW_BOARD_CONFIG;
  const roostr = path.join(os.homedir(), '.roostr', 'config.json');
  const legacy = path.join(os.homedir(), '.crew-board', 'config.json');
  if (fs.existsSync(roostr) || !fs.existsSync(legacy)) return roostr;
  return legacy;
}

function plainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function text(v, max = 120) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, max);
}

function list(v) {
  return Array.isArray(v) ? v.map((x) => text(x, 80)).filter(Boolean) : null;
}

function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

function normalize(raw) {
  const warnings = [];
  const config = defaultConfig();
  if (!plainObject(raw)) {
    warnings.push('config is not a JSON object; using defaults');
    return { config, warnings };
  }

  const foundTools = list(raw.tools);
  const custom = new Set(list(raw.customTools) || []);
  const tools = [];
  if (foundTools) {
    for (const t of foundTools) {
      if (TOOLS.includes(t)) tools.push(t);
      else {
        custom.add(t);
        warnings.push(`unknown tool "${t}" moved to customTools`);
      }
    }
  }
  if (tools.length === 0) {
    if (foundTools && foundTools.length) warnings.push('no known tool selected; using claude');
    tools.push('claude');
  }
  config.tools = [...new Set(tools)];
  config.customTools = [...custom];

  const wantedDefault = text(raw.defaultTool, 40);
  if (wantedDefault && [...config.tools, ...config.customTools].includes(wantedDefault)) {
    config.defaultTool = wantedDefault;
  } else {
    config.defaultTool = config.tools[0];
    if (wantedDefault) warnings.push(`default tool "${wantedDefault}" is not selected; using ${config.defaultTool}`);
  }

  const wantedHead = text(raw.headName, 32).toLowerCase();
  if (wantedHead === 'auto' || HEAD_NAMES.some((h) => h.name === wantedHead)) config.headName = wantedHead;
  else if (wantedHead) warnings.push(`head name "${wantedHead}" is not auto or a known boss title; using auto`);

  const wantedLanguage = text(raw.headLanguage, 2).toLowerCase();
  if (LANGUAGES.includes(wantedLanguage)) config.headLanguage = wantedLanguage;
  else if (wantedLanguage) warnings.push('headLanguage must be en, es, pt or fr; using en');

  if (plainObject(raw.models)) {
    const models = {};
    for (const tier of ['fast', 'balanced', 'reasoning']) {
      const v = text(raw.models[tier], 120);
      if (v) models[tier] = v;
    }
    config.models = models;
  } else if (raw.models !== undefined) {
    warnings.push('models must be an object');
  }

  const disabled = list(raw.disabledModels);
  config.disabledModels = disabled ? [...new Set(disabled)] : [];

  if (plainObject(raw.taskKinds)) {
    for (const [kind, value] of Object.entries(raw.taskKinds)) {
      if (!TASK_KINDS.includes(kind)) {
        warnings.push(`unknown task kind "${kind}" ignored`);
        continue;
      }
      if (!plainObject(value)) {
        warnings.push(`[taskKinds.${kind}] must be an object`);
        continue;
      }
      const tool = text(value.tool, 40);
      if (tool && ![...config.tools, ...config.customTools].includes(tool)) {
        warnings.push(`[taskKinds.${kind}] tool "${tool}" is not selected; using auto`);
      } else if (tool) {
        config.taskKinds[kind].tool = tool;
      }
      const model = text(value.model, 120);
      if (model) config.taskKinds[kind].model = model;
      if (Array.isArray(value.fallbacks)) {
        const seen = new Set();
        for (const item of value.fallbacks) {
          const name = text(item, 120);
          if (!name || seen.has(name)) continue;
          seen.add(name);
          config.taskKinds[kind].fallbacks.push(name);
          if (config.taskKinds[kind].fallbacks.length >= 5) break;
        }
      } else if (value.fallbacks !== undefined) {
        warnings.push(`[taskKinds.${kind}] fallbacks must be an array`);
      }
      const effort = text(value.effort, 12);
      if (effort) {
        if (EFFORTS.includes(effort)) config.taskKinds[kind].effort = effort;
        else warnings.push(`[taskKinds.${kind}] effort must be low, medium, high, xhigh or max`);
      }
    }
  } else if (raw.taskKinds !== undefined) {
    warnings.push('taskKinds must be an object');
  }

  if (plainObject(raw.roles)) {
    for (const role of ROLES) {
      const r = raw.roles[role];
      if (!plainObject(r)) continue;
      const tool = text(r.tool, 40);
      const model = text(r.model, 120);
      const effort = text(r.effort, 12);
      const args = list(r.args);
      if (tool && [...config.tools, ...config.customTools].includes(tool)) config.roles[role].tool = tool;
      else if (tool) warnings.push(`[${role}] tool "${tool}" is not selected; using ${config.defaultTool}`);
      if (model) config.roles[role].model = model;
      if (EFFORTS.includes(effort)) config.roles[role].effort = effort;
      else if (effort) warnings.push(`[${role}] effort must be low, medium, high, xhigh or max`);
      if (args) config.roles[role].args = args;
      else if (r.args !== undefined) warnings.push(`[${role}] args must be an array; using []`);
    }
  } else if (raw.roles !== undefined) {
    warnings.push('roles must be an object');
  }
  // A role with no explicit model follows the tier its effort names.
  for (const role of ROLES) {
    const r = config.roles[role];
    if (!r.model) r.model = config.models[TIER_BY_EFFORT[r.effort]] || '';
  }

  const grill = plainObject(raw.grillSkill) ? raw.grillSkill : {};
  const mode = text(grill.mode, 20);
  if (mode) {
    if (GRILL_MODES.includes(mode)) config.grillSkill.mode = mode;
    else warnings.push('grillSkill.mode must be recommended, none or custom; using recommended');
  }
  config.grillSkill.command = text(grill.command, 240);

  const orchestration = plainObject(raw.orchestration) ? raw.orchestration : {};
  if (orchestration.enabled !== undefined && typeof orchestration.enabled !== 'boolean') {
    warnings.push('orchestration.enabled must be true or false; using false');
  }
  config.orchestration = { enabled: bool(orchestration.enabled, false) };

  return { config, warnings };
}

let cached = { path: null, mtime: null, value: null };

function loadConfig() {
  const p = configPath();
  try {
    const stat = fs.statSync(p);
    if (cached.path === p && cached.mtime === stat.mtimeMs) return cached.value;
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const value = { ...normalize(raw), path: p };
    cached = { path: p, mtime: stat.mtimeMs, value };
    return value;
  } catch (e) {
    cached = { path: null, mtime: null, value: null };
    if (e && e.code === 'ENOENT') return { config: defaultConfig(), warnings: [], path: p };
    const base = normalize(null);
    base.warnings.push(`config could not be read (${e.message}); using defaults`);
    return { ...base, path: p };
  }
}

function saveConfig(config) {
  const normalized = normalize(config);
  const p = configPath();
  state.writeJson(p, normalized.config);
  cached = { path: null, mtime: null, value: null };
  return { ...normalized, path: p };
}

module.exports = {
  TOOLS, ROLES, EFFORTS, GRILL_MODES, LANGUAGES, HEAD_NAMES, TIER_BY_EFFORT, TASK_KINDS,
  defaultConfig, configPath, normalize, loadConfig, saveConfig, mergeTaskKinds,
};
