'use strict';
// Gemini API list prices, paid tier, in US dollars per 1M tokens. The board
// shows an API equivalent for Gemini panes because agy reports tokens but no
// dollar cost. Estimates are always labelled; an exact report still wins.
//
// Rates checked 2026-10-27. Prices change, so ~/.crew-board/prices.json (or
// CREW_BOARD_PRICES) can override them without touching code:
//   { "gemini-3.8-flash": { "input": 0.75, "output": 3.75 } }
// Keys match the model name after lowercasing and dropping spaces, hyphens and
// underscores. An override merges field by field.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_RATES = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-4-argon': { input: 2.00, output: 10.00 },
};

function normalize(name) {
  return String(name || '').toLowerCase().replace(/[\s_-]+/g, '');
}

function overrideFile() {
  if (process.env.ROOSTR_PRICES) return process.env.ROOSTR_PRICES;
  if (process.env.CREW_BOARD_PRICES) return process.env.CREW_BOARD_PRICES;
  const roostr = path.join(os.homedir(), '.roostr', 'prices.json');
  const legacy = path.join(os.homedir(), '.crew-board', 'prices.json');
  if (fs.existsSync(roostr) || !fs.existsSync(legacy)) return roostr;
  return legacy;
}

let overrideCache = null; // { file, key, value }

function overrides() {
  const file = overrideFile();
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    overrideCache = null;
    return {};
  }
  // The board asks for a price per row; reading the file once per mtime keeps
  // that cheap without going stale when the file changes.
  const key = `${st.mtimeMs}:${st.size}`;
  if (overrideCache && overrideCache.file === file && overrideCache.key === key) return overrideCache.value;
  let value = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const out = {};
      for (const [name, rate] of Object.entries(raw)) {
        if (!rate || typeof rate !== 'object') continue;
        const merged = {};
        if (Number.isFinite(Number(rate.input)) && Number(rate.input) >= 0) merged.input = Number(rate.input);
        if (Number.isFinite(Number(rate.output)) && Number(rate.output) >= 0) merged.output = Number(rate.output);
        if (Object.keys(merged).length) out[normalize(name)] = merged;
      }
      value = out;
    }
  } catch (e) {
    value = {};
  }
  overrideCache = { file, key, value };
  return value;
}

function rateFor(model) {
  const key = normalize(model);
  if (!key) return null;
  const custom = overrides()[key] || {};
  let base = null;
  for (const [id, rate] of Object.entries(DEFAULT_RATES)) {
    if (normalize(id) === key) {
      base = { id, ...rate };
      break;
    }
  }
  const merged = {
    id: (base && base.id) || key,
    input: custom.input === undefined ? (base ? base.input : undefined) : custom.input,
    output: custom.output === undefined ? (base ? base.output : undefined) : custom.output,
  };
  return merged.input === undefined || merged.output === undefined ? null : merged;
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// { input, output } token counts plus a model name -> { cost, rate } or null.
// Both counts must be known: a partial split would understate the spend.
function estimate(model, usage) {
  const rate = rateFor(model);
  if (!rate) return null;
  const input = count(usage && usage.input);
  const output = count(usage && usage.output);
  if (input === null || output === null) return null;
  if (input === 0 && output === 0) return null;
  const cost = (input * rate.input + output * rate.output) / 1e6;
  return { cost: Math.round(cost * 1e6) / 1e6, rate };
}

module.exports = { DEFAULT_RATES, normalize, rateFor, estimate };
