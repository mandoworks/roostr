'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const surge = require('../src/surge');
const board = require('../src/board');

// Synthetic clocks in UTC:
// 2026-11-11 is a Wednesday (weekday = 3).
// 2026-11-14 is a Saturday (weekend = 6).
// 2026-11-15 is a Sunday (weekend = 0).

const WEDNESDAY_0230_UTC = Date.UTC(2026, 10, 11, 2, 30, 0); // Window 1: 01:00-04:00 UTC
const WEDNESDAY_0715_UTC = Date.UTC(2026, 10, 11, 7, 15, 0); // Window 2: 06:00-10:00 UTC
const WEDNESDAY_0500_UTC = Date.UTC(2026, 10, 11, 5, 0, 0);  // Outside windows (04:00-06:00)
const WEDNESDAY_1100_UTC = Date.UTC(2026, 10, 11, 11, 0, 0); // Outside windows (after 10:00)
const SATURDAY_0230_UTC  = Date.UTC(2026, 10, 14, 2, 30, 0); // Weekend during surge hours
const SUNDAY_0715_UTC    = Date.UTC(2026, 10, 15, 7, 15, 0); // Weekend during surge hours

function makeModel(now, panes) {
  const rows = panes.map((p, idx) => ({
    paneId: p.paneId || `pane-${idx}`,
    name: p.name || `worker-${idx}`,
    model: { v: p.model, src: 'exact' },
    status: p.status || 'working',
    statusFor: 12000,
    cost: { v: 1.0, src: 'exact' },
    budget: 10,
    surge: p.surge !== undefined ? p.surge : null,
    surgeMarker: p.surgeMarker !== undefined ? p.surgeMarker : null,
  }));

  return {
    rows,
    now,
    dailyBudget: null,
    tokscale: null,
  };
}

test('surge: S3 central window definitions and weekday logic', () => {
  assert.equal(surge.SURGE_MULTIPLIER, 2);
  assert.equal(surge.SURGE_WINDOWS_UTC.length, 2);

  // Window 1: 01:00-04:00 UTC
  assert.equal(surge.SURGE_WINDOWS_UTC[0].startHour, 1);
  assert.equal(surge.SURGE_WINDOWS_UTC[0].endHour, 4);

  // Window 2: 06:00-10:00 UTC
  assert.equal(surge.SURGE_WINDOWS_UTC[1].startHour, 6);
  assert.equal(surge.SURGE_WINDOWS_UTC[1].endHour, 10);

  // DeepSeek model detection
  assert.equal(surge.isDeepSeekModel('deepseek-v4.1-flash-1017'), true);
  assert.equal(surge.isDeepSeekModel('explabs/deepseek-chat'), true);
  assert.equal(surge.isDeepSeekModel('DeepSeek-V3'), true);
  assert.equal(surge.isDeepSeekModel('claude-3-7-sonnet'), false);
  assert.equal(surge.isDeepSeekModel('gemini-3.8-flash'), false);
  assert.equal(surge.isDeepSeekModel(null), false);
});

test('surge: Case 1 - inside surge window with DeepSeek pane (banner and marker present)', () => {
  const model = makeModel(WEDNESDAY_0230_UTC, [
    { paneId: 'p1', name: 'Diego', model: 'deepseek-v4.1-flash-1017' },
    { paneId: 'p2', name: 'Valeria', model: 'claude-3-7-sonnet' },
  ]);

  // Check surge banner segment
  const alerts = board.banner(model);
  const surgeAlert = alerts.find((a) => a.kind === 'surge');
  assert.ok(surgeAlert, 'surge banner segment present');
  assert.match(surgeAlert.text, /▲ 2× SURGE: Diego/);
  assert.match(surgeAlert.text, /\(ends \d{2}:\d{2}\)/);

  // Check per-pane marker
  const check = surge.checkSurge(WEDNESDAY_0230_UTC);
  assert.equal(check.inSurge, true);
  assert.equal(check.multiplier, 2);

  // Using buildModel simulation
  const input = {
    snap: {
      workspaces: [{ workspace_id: 'w1', label: 'ws' }],
      panes: [{ pane_id: 'p1', label: 'Diego', cwd: '/tmp' }],
      agents: [{ pane_id: 'p1', workspace_id: 'w1', agent: 'opencode', agent_status: 'working', state_change_seq: 1, cwd: '/tmp' }],
    },
    agents: [{ pane_id: 'p1', workspace_id: 'w1', agent: 'opencode', name: 'Diego', cwd: '/tmp' }],
    screens: {},
    reports: { p1: { model: 'deepseek-v4.1-flash-1017' } },
    events: {},
    rss: {},
    crewFor: () => null,
    mem: { tags: {}, status: {} },
    now: WEDNESDAY_0230_UTC,
  };
  const built = board.buildModel(input);
  const row = built.rows[0];
  assert.equal(row.surge, true);
  assert.equal(row.surgeMarker, '2×');

  // Second window: 07:15 UTC
  const model2 = makeModel(WEDNESDAY_0715_UTC, [
    { paneId: 'p1', name: 'Diego', model: 'deepseek-chat' },
  ]);
  const alerts2 = board.banner(model2);
  const surgeAlert2 = alerts2.find((a) => a.kind === 'surge');
  assert.ok(surgeAlert2, 'surge banner present in second window');
  assert.match(surgeAlert2.text, /Diego/);
});

test('surge: Case 2 - inside surge window with NO DeepSeek pane (banner and marker absent)', () => {
  const model = makeModel(WEDNESDAY_0230_UTC, [
    { paneId: 'p1', name: 'Valeria', model: 'claude-3-7-sonnet' },
    { paneId: 'p2', name: 'Mateo', model: 'gemini-3.8-flash' },
  ]);

  const alerts = board.banner(model);
  const surgeAlert = alerts.find((a) => a.kind === 'surge');
  assert.equal(surgeAlert, undefined, 'no surge banner when no DeepSeek pane');

  const input = {
    snap: {
      workspaces: [{ workspace_id: 'w1', label: 'ws' }],
      panes: [{ pane_id: 'p1', label: 'Valeria', cwd: '/tmp' }],
      agents: [{ pane_id: 'p1', workspace_id: 'w1', agent: 'claude', agent_status: 'working', state_change_seq: 1, cwd: '/tmp' }],
    },
    agents: [{ pane_id: 'p1', workspace_id: 'w1', agent: 'claude', name: 'Valeria', cwd: '/tmp' }],
    screens: {},
    reports: { p1: { model: 'claude-3-7-sonnet' } },
    events: {},
    rss: {},
    crewFor: () => null,
    mem: { tags: {}, status: {} },
    now: WEDNESDAY_0230_UTC,
  };
  const built = board.buildModel(input);
  assert.equal(built.rows[0].surge, false);
  assert.equal(built.rows[0].surgeMarker, null);
});

test('surge: Case 3 - outside surge window with DeepSeek pane (banner and marker absent)', () => {
  const model1 = makeModel(WEDNESDAY_0500_UTC, [
    { paneId: 'p1', name: 'Diego', model: 'deepseek-v4.1-flash-1017' },
  ]);
  assert.equal(board.banner(model1).find((a) => a.kind === 'surge'), undefined);

  const model2 = makeModel(WEDNESDAY_1100_UTC, [
    { paneId: 'p1', name: 'Diego', model: 'deepseek-v4.1-flash-1017' },
  ]);
  assert.equal(board.banner(model2).find((a) => a.kind === 'surge'), undefined);

  const input = {
    snap: {
      workspaces: [{ workspace_id: 'w1', label: 'ws' }],
      panes: [{ pane_id: 'p1', label: 'Diego', cwd: '/tmp' }],
      agents: [{ pane_id: 'p1', workspace_id: 'w1', agent: 'opencode', agent_status: 'working', state_change_seq: 1, cwd: '/tmp' }],
    },
    agents: [{ pane_id: 'p1', workspace_id: 'w1', agent: 'opencode', name: 'Diego', cwd: '/tmp' }],
    screens: {},
    reports: { p1: { model: 'deepseek-v4.1-flash-1017' } },
    events: {},
    rss: {},
    crewFor: () => null,
    mem: { tags: {}, status: {} },
    now: WEDNESDAY_0500_UTC,
  };
  const built = board.buildModel(input);
  assert.equal(built.rows[0].surge, false);
  assert.equal(built.rows[0].surgeMarker, null);
});

test('surge: Case 4 - weekend with DeepSeek pane (banner and marker absent)', () => {
  // Saturday at 02:30 UTC
  const satModel = makeModel(SATURDAY_0230_UTC, [
    { paneId: 'p1', name: 'Diego', model: 'deepseek-v4.1-flash-1017' },
  ]);
  assert.equal(board.banner(satModel).find((a) => a.kind === 'surge'), undefined);

  // Sunday at 07:15 UTC
  const sunModel = makeModel(SUNDAY_0715_UTC, [
    { paneId: 'p1', name: 'Diego', model: 'deepseek-v4.1-flash-1017' },
  ]);
  assert.equal(board.banner(sunModel).find((a) => a.kind === 'surge'), undefined);

  const input = {
    snap: {
      workspaces: [{ workspace_id: 'w1', label: 'ws' }],
      panes: [{ pane_id: 'p1', label: 'Diego', cwd: '/tmp' }],
      agents: [{ pane_id: 'p1', workspace_id: 'w1', agent: 'opencode', agent_status: 'working', state_change_seq: 1, cwd: '/tmp' }],
    },
    agents: [{ pane_id: 'p1', workspace_id: 'w1', agent: 'opencode', name: 'Diego', cwd: '/tmp' }],
    screens: {},
    reports: { p1: { model: 'deepseek-v4.1-flash-1017' } },
    events: {},
    rss: {},
    crewFor: () => null,
    mem: { tags: {}, status: {} },
    now: SATURDAY_0230_UTC,
  };
  const built = board.buildModel(input);
  assert.equal(built.rows[0].surge, false);
  assert.equal(built.rows[0].surgeMarker, null);
});
