'use strict';
// Burn rate forecast for the usage windows: when, at the current pace, a
// window reaches 100%. Boards sample each window's used% into a small state
// file, so the pace survives a board restart and every board shares it.

const path = require('path');
const state = require('./state');

const WINDOW_MS = { '1h': 3600 * 1000, '5h': 5 * 3600 * 1000, '24h': 24 * 3600 * 1000, '7d': 7 * 24 * 3600 * 1000 };
const MINUTE = 60 * 1000;

// A 7d window moves about 0.6 points an hour, so a 1 point tick over a few
// minutes says nothing. Keep more history, sample less often, and need a
// longer span before the slope replaces the window average.
const WINDOW_RULES = {
  '1h': { keep: 30 * MINUTE, gap: 1 * MINUTE, minSpan: 5 * MINUTE },
  '5h': { keep: 30 * MINUTE, gap: 1 * MINUTE, minSpan: 10 * MINUTE },
  '24h': { keep: 6 * 3600 * 1000, gap: 5 * MINUTE, minSpan: 30 * MINUTE },
  '7d': { keep: 6 * 3600 * 1000, gap: 5 * MINUTE, minSpan: 60 * MINUTE },
};
const DEFAULT_RULES = WINDOW_RULES['5h'];

function rules(name) {
  return WINDOW_RULES[name] || DEFAULT_RULES;
}

function burnFile() {
  return path.join(state.stateDir(), 'burn.json');
}

// Add this pass's usage to `samples` ({ "source window": [{ t, used, resets }] }),
// at the window's sample gap at most, dropping samples older than its keep or
// from an earlier window. `t` is when the report was written, not now.
function addSamples(samples, limits, now) {
  const out = {};
  for (const l of limits) {
    for (const w of l.windows) {
      if (w.used == null) continue;
      const key = `${l.source} ${w.name}`;
      const rule = rules(w.name);
      const t = l.at || now;
      const list = (Array.isArray(samples[key]) ? samples[key] : [])
        .filter((s) => s && s.resets === w.resets && now - s.t <= rule.keep);
      const lastT = list.length ? list[list.length - 1].t : -Infinity;
      if (now - t <= rule.keep && t - lastT >= rule.gap) list.push({ t, used: w.used, resets: w.resets });
      out[key] = list;
    }
  }
  return out;
}

// How fast window `w` fills, in percent per ms, or null when unknown: the
// slope over the samples once they span the window's minimum and either rose
// 2 points or span long enough to trust a smaller rise; before that, the
// average since the window opened.
function rate(list, w, now) {
  if (!w.resets) return null;
  const rule = rules(w.name);
  const span = list.length > 1 ? list[list.length - 1].t - list[0].t : 0;
  if (span >= rule.minSpan) {
    const rise = list[list.length - 1].used - list[0].used;
    // Usage comes in whole points. Under 2 points of rise, the slope only
    // counts once 2 points would already be the steady pace (6 minutes for
    // 5h, about 3.4 hours for 7d): then little or no rise means a slow burn.
    const sure = WINDOW_MS[w.name] ? 0.02 * WINDOW_MS[w.name] : 0.9 * rule.keep;
    if (rise >= 2 || span >= sure) return rise / span;
  }
  if (!WINDOW_MS[w.name]) return null;
  const elapsed = WINDOW_MS[w.name] - (w.resets * 1000 - now);
  return elapsed >= rule.minSpan ? w.used / elapsed : null;
}

// When window `w` reaches 100% at the current pace, as epoch ms, or null when
// that comes after its reset (or the pace is unknown, flat, or the window is
// already full).
function eta(list, w, now) {
  if (!(w.used < 100)) return null;
  const r = rate(list, w, now);
  if (!(r > 0)) return null;
  const at = now + (100 - w.used) / r;
  return at < w.resets * 1000 ? at : null;
}

// The pace as a multiple of the steady one that uses exactly 100% over the
// window: 2 means twice as fast as the window allows. Null when unknown or
// not burning.
function pace(list, w, now) {
  const r = rate(list, w, now);
  if (!(r > 0) || !WINDOW_MS[w.name]) return null;
  return r / (100 / WINDOW_MS[w.name]);
}

// Set `eta` and `pace` on every window of `limits`. With `save`, this pass's usage is
// also recorded (a one shot run reads the history but adds nothing).
function forecast(limits, now = Date.now(), { save = true } = {}) {
  const file = burnFile();
  const disk = state.readJson(file) || {};
  const samples = addSamples(disk, limits, now);
  try {
    if (save && JSON.stringify(samples) !== JSON.stringify(disk)) state.writeJson(file, samples);
  } catch (e) {
    // a read only state dir costs the forecast its history, nothing else
  }
  for (const l of limits) {
    for (const w of l.windows) {
      if (w.used == null) continue;
      const list = samples[`${l.source} ${w.name}`] || [];
      w.eta = eta(list, w, now);
      w.pace = pace(list, w, now);
    }
  }
  return limits;
}

module.exports = { addSamples, eta, pace, forecast, WINDOW_MS };
