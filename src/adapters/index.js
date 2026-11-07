'use strict';
// Agent kind (as Herdr names it) -> screen adapter. Unknown kinds get nothing.

const { empty } = require('./util');

const ADAPTERS = {
  claude: require('./claude'),
  opencode: require('./opencode'),
  kilo: require('./kilo'),
  agy: require('./agy'),
};

function normalize(out) {
  const o = out || {};
  const res = { ctx: null, tokens: null, cost: null, model: null };
  if (typeof o.ctx === 'number' && !isNaN(o.ctx)) res.ctx = Math.max(0, Math.min(100, Math.round(o.ctx)));
  if (typeof o.tokens === 'number' && !isNaN(o.tokens)) res.tokens = Math.max(0, Math.round(o.tokens));
  if (typeof o.cost === 'number' && !isNaN(o.cost)) res.cost = Math.max(0, o.cost);
  if (typeof o.model === 'string' && o.model.trim()) res.model = o.model.trim().slice(0, 64);
  if (typeof o.effort === 'string') res.effort = o.effort;
  return res;
}

function parseScreen(kind, screen) {
  const a = ADAPTERS[kind];
  if (!a) return empty();
  try {
    return normalize(a.parse(screen));
  } catch (e) {
    if (process.env.CREW_BOARD_DEBUG) console.error(`adapter ${kind} parse error: ${e.message}`);
    return empty();
  }
}

// True when reading this kind's screen can give a value.
function hasAdapter(kind) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, kind) && ADAPTERS[kind].readsScreen !== false;
}

module.exports = { parseScreen, hasAdapter, normalize };
