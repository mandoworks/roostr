'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-burn-'));
process.env.CREW_BOARD_STATE_DIR = dir;
const { addSamples, eta, pace, forecast } = require('../src/burn');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const MIN = 60 * 1000;
const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const RESETS = (NOW + 3 * 60 * MIN) / 1000; // 5h window opened 2h ago, resets in 3h
const limits = (used, at = NOW, resets = RESETS) => [{ source: 'claude', at, windows: [{ name: '5h', used, resets }] }];

test('addSamples: one per minute, old and earlier window samples dropped', () => {
  let s = addSamples({}, limits(10, NOW - 40 * MIN), NOW);
  assert.equal(s['claude 5h'].length, 0, 'a report older than 30 minutes is no sample');
  s = addSamples({}, limits(10, NOW - 20 * MIN), NOW);
  s = addSamples(s, limits(11, NOW - 19.5 * MIN), NOW);
  assert.equal(s['claude 5h'].length, 1, 'under a minute apart');
  s = addSamples(s, limits(12, NOW - 10 * MIN), NOW);
  assert.deepEqual(s['claude 5h'].map((x) => x.used), [10, 12]);
  s = addSamples(s, limits(1, NOW, RESETS + 5 * 3600), NOW);
  assert.deepEqual(s['claude 5h'].map((x) => x.used), [1], 'a new window starts fresh');
});

test('eta: slope over the samples, warning only before the reset', () => {
  const w = { name: '5h', used: 60, resets: RESETS };
  // 20 points in 20 minutes: 1 point a minute, 40 left, out in 40 minutes.
  const fast = [{ t: NOW - 20 * MIN, used: 40, resets: RESETS }, { t: NOW, used: 60, resets: RESETS }];
  assert.equal(eta(fast, w, NOW), NOW + 40 * MIN);
  // 2 points in 20 minutes: out in 400 minutes, after the reset in 180.
  const slow = [{ t: NOW - 20 * MIN, used: 58, resets: RESETS }, { t: NOW, used: 60, resets: RESETS }];
  assert.equal(eta(slow, w, NOW), null);
  // Flat or falling: no forecast.
  assert.equal(eta([{ t: NOW - 20 * MIN, used: 60 }, { t: NOW, used: 60 }], w, NOW), null);
  assert.equal(eta(fast, { ...w, used: 100 }, NOW), null);
  assert.equal(eta(fast, { ...w, resets: null }, NOW), null);
});

test('eta: window average when samples span under 10 minutes', () => {
  // 80% in the 2 hours since the window opened: 20% left takes 30 minutes.
  assert.equal(eta([], { name: '5h', used: 80, resets: RESETS }, NOW), NOW + 30 * MIN);
  // 20% in 2 hours: out in 8 hours, after the reset.
  assert.equal(eta([], { name: '5h', used: 20, resets: RESETS }, NOW), null);
  // A window opened 5 minutes ago says nothing yet.
  const fresh = (NOW + (5 * 60 - 5) * MIN) / 1000;
  assert.equal(eta([], { name: '5h', used: 30, resets: fresh }, NOW), null);
  // Unknown window length, no average.
  assert.equal(eta([], { name: '1d', used: 80, resets: RESETS }, NOW), null);
});

test('pace: the burn rate against the steady pace of the window', () => {
  const w = { name: '5h', used: 60, resets: RESETS };
  // 1 point a minute is 60% an hour; the 5h window lasts at 20% an hour.
  const fast = [{ t: NOW - 20 * MIN, used: 40, resets: RESETS }, { t: NOW, used: 60, resets: RESETS }];
  assert.ok(Math.abs(pace(fast, w, NOW) - 3) < 1e-9);
  // Window average: 80% in 2 hours is 40% an hour.
  assert.ok(Math.abs(pace([], { ...w, used: 80 }, NOW) - 2) < 1e-9);
  assert.equal(pace([{ t: NOW - 20 * MIN, used: 60 }, { t: NOW, used: 60 }], w, NOW), null, 'flat');
  assert.equal(pace([], { name: '1d', used: 80, resets: RESETS }, NOW), null, 'unknown window length');
});

test('forecast: samples persist across calls and set eta on each window', () => {
  forecast(limits(40, NOW - 20 * MIN), NOW - 20 * MIN);
  const out = forecast(limits(60, NOW), NOW);
  assert.equal(out[0].windows[0].eta, NOW + 40 * MIN);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'burn.json'), 'utf8'))['claude 5h'].length, 2);
});

test('forecast: save false reads history but writes nothing', () => {
  const file = path.join(dir, 'burn.json');
  const before = fs.readFileSync(file, 'utf8');
  forecast(limits(70, NOW + 2 * MIN), NOW + 2 * MIN, { save: false });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

const HOUR = 60 * MIN;

test('addSamples: 7d keeps 6 hours and needs 5 minutes between samples', () => {
  const r = NOW + 100 * HOUR;
  const l = (used, at) => [{ source: 'legacy', at, windows: [{ name: '7d', used, resets: r / 1000 }] }];
  let s = addSamples({}, l(10, NOW - 7 * HOUR), NOW);
  assert.equal(s['legacy 7d'].length, 0, 'older than 6 hours is no sample');
  s = addSamples(s, l(11, NOW - 6 * HOUR), NOW);
  s = addSamples(s, l(12, NOW - 6 * HOUR + 4 * MIN), NOW);
  assert.equal(s['legacy 7d'].length, 1, 'under 5 minutes apart');
  s = addSamples(s, l(13, NOW - 6 * HOUR + 5 * MIN), NOW);
  assert.equal(s['legacy 7d'].length, 2);
});

test('pace: a point a minute in the 5h window is still about 3x', () => {
  let s = {};
  for (let i = 0; i <= 20; i++) s = addSamples(s, limits(40 + i, NOW - (20 - i) * MIN), NOW);
  assert.equal(s['claude 5h'].length, 21);
  assert.ok(Math.abs(pace(s['claude 5h'], { name: '5h', used: 60, resets: RESETS }, NOW) - 3) < 1e-9);
});

test('pace: a 7d window on a steady burn never reads 3x or more', () => {
  const t0 = NOW - 6 * HOUR;
  const openedAt = t0 - 50 * HOUR;
  const resets = Math.round((openedAt + 7 * 24 * HOUR) / 1000);
  const list = [];
  for (let m = 0; m <= 6 * 60; m += 5) list.push({ t: t0 + m * MIN, used: 20 + Math.floor(0.6 * (m / 60)), resets });
  for (let i = 1; i < list.length; i++) {
    const now = list[i].t;
    if (now - list[0].t < HOUR) continue;
    const w = { name: '7d', used: list[i].used, resets };
    const p = pace(list.slice(0, i + 1), w, now);
    assert.ok(p >= 0.5 && p <= 1.5, `pace ${p} at ${(now - t0) / HOUR}h`);
    const e = eta(list.slice(0, i + 1), w, now);
    if (e != null) assert.ok(e < resets * 1000, 'eta only before the reset');
  }
});

test('pace: 7d under 60 minutes falls back to the window average', () => {
  const first = NOW - 40 * MIN;
  const list = Array.from({ length: 9 }, (_, i) => ({ t: first + i * 5 * MIN, used: 50 + (i === 8 ? 1 : 0) }));
  const w = { name: '7d', used: 51, resets: Math.round((NOW + 100 * HOUR) / 1000) };
  const elapsed = 7 * 24 * HOUR - (w.resets * 1000 - NOW);
  const average = (51 / elapsed) / (100 / (7 * 24 * HOUR));
  assert.ok(Math.abs(pace(list, w, NOW) - average) < 1e-9);
  assert.ok(pace(list, w, NOW) < 2, 'not the 1 point slope');
});

test('pace: a full 6 hour 7d history counts a 1 point rise as the slope', () => {
  const list = [{ t: NOW - 6 * HOUR, used: 50 }, { t: NOW, used: 51 }];
  const w = { name: '7d', used: 51, resets: Math.round((NOW + 100 * HOUR) / 1000) };
  const slope = (1 / (6 * HOUR)) / (100 / (7 * 24 * HOUR));
  assert.ok(Math.abs(pace(list, w, NOW) - slope) < 1e-9);
});

test('forecast: an old burn.json with 1 minute 7d samples still loads', () => {
  const file = path.join(dir, 'burn.json');
  const resets = Math.round((NOW + 100 * HOUR) / 1000);
  const old = { 'legacy 7d': [] };
  for (let i = 0; i <= 30; i++) old['legacy 7d'].push({ t: NOW - (30 - i) * MIN, used: 10 + i, resets });
  fs.writeFileSync(file, JSON.stringify(old));
  const out = forecast([{ source: 'legacy', at: NOW, windows: [{ name: '7d', used: 40, resets }] }], NOW);
  assert.ok(out[0].windows[0].pace > 0);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['legacy 7d'].length, 31);
});
