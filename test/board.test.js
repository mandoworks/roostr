'use strict';
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-state-'));
process.env.CREW_BOARD_STATE_DIR = stateDir;
const savedSummaryEnv = process.env.CREW_BOARD_SUMMARY;
process.env.CREW_BOARD_SUMMARY = path.join(stateDir, 'summary.json');
const board = require('../src/board');
const checks = require('../src/checks');
const config = require('../src/config');
const { parseToml, toCrew } = require('../src/crewfile');
const ui = require('../src/ui');
const { VERSION } = require('../src/version');
const tokscale = require('../src/tokscale');
const { decide } = require('../scripts/toggle');

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-proj-'));
fs.mkdirSync(path.join(proj, 'agents', 'docs'), { recursive: true });
fs.writeFileSync(path.join(proj, 'agents', 'docs', 'report.md'), 'done\n');
test.after(() => {
  if (savedSummaryEnv === undefined) delete process.env.CREW_BOARD_SUMMARY;
  else process.env.CREW_BOARD_SUMMARY = savedSummaryEnv;
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('parseLabel: name and task line, colour tag stripped', () => {
  assert.deepEqual(board.parseLabel('docs · write the API guide'), { name: 'docs', task: 'write the API guide' });
  assert.deepEqual(board.parseLabel('🟦 docs · write · twice'), { name: 'docs', task: 'write · twice' });
  assert.deepEqual(board.parseLabel('⬜ lead (opus)'), { name: 'lead (opus)', task: null });
  assert.deepEqual(board.parseLabel(''), { name: null, task: null });
  assert.deepEqual(board.parseLabel(undefined), { name: null, task: null });
  assert.equal(board.stripTag('🟩 api · x'), 'api · x');
});

test('colour tags: stable per pane, distinct while free squares remain', () => {
  const mem = { tags: {}, status: {} };
  const ids = ['w1:p1', 'w1:p2', 'w1:p3'];
  board.assignTags(mem, ids, new Set(ids));
  assert.deepEqual(ids.map((id) => mem.tags[id]), board.TAGS.slice(0, 3));
  // A closed pane frees its square; the others keep theirs.
  board.assignTags(mem, ['w1:p1', 'w1:p3', 'w1:p4'], new Set(['w1:p1', 'w1:p3', 'w1:p4']));
  assert.equal(mem.tags['w1:p1'], board.TAGS[0]);
  assert.equal(mem.tags['w1:p3'], board.TAGS[2]);
  assert.equal(mem.tags['w1:p4'], board.TAGS[1]);
  assert.equal(mem.tags['w1:p2'], undefined);
});

test('colour tags: a mark shared by two shown panes moves the later one', () => {
  const ids = ['w1:p1', 'w1:p2', 'w1:p3'];
  const mem = { tags: { 'w1:p1': board.TAGS[1], 'w1:p2': board.TAGS[1] }, status: {} };
  board.assignTags(mem, ids, new Set(ids));
  assert.equal(mem.tags['w1:p1'], board.TAGS[1]);
  assert.equal(new Set(ids.map((id) => mem.tags[id])).size, 3);
});

test('colour tags: high contrast palette, legacy marks strip but never assign', () => {
  assert.equal(board.TAGS.length, 18);
  for (const mark of ['⬜', '⬛', '⚪', '⚫', '🟫', '🟤']) assert.ok(!board.TAGS.includes(mark));
  assert.equal(board.stripTag('⬜ lead (opus)'), 'lead (opus)');
  assert.equal(board.stripTag('🟩 api · x'), 'api · x');
  const mem = { tags: { 'w1:p1': '⬛' }, status: {} };
  board.assignTags(mem, ['w1:p1'], new Set(['w1:p1']));
  assert.ok(board.TAGS.includes(mem.tags['w1:p1']));
  const ids = Array.from({ length: 18 }, (_, i) => `w1:p${i}`);
  const distinct = { tags: {}, status: {} };
  board.assignTags(distinct, ids, new Set(ids));
  assert.equal(new Set(ids.map((id) => distinct.tags[id])).size, 18);
  assert.equal(board.parseLabel('⬜ lead (opus)').name, 'lead (opus)');
  assert.deepEqual(board.parseLabel('a plain name'), { name: 'a plain name', task: null });
});

test('time in status: exact only when the board watched the change', () => {
  const mem = { tags: {}, status: {} };
  const a = { pane_id: 'w1:p1', agent_status: 'working', state_change_seq: 4 };
  let s = board.trackStatus(mem, a, 1000);
  assert.deepEqual([s.since, s.exact], [1000, false]);
  s = board.trackStatus(mem, a, 5000);
  assert.deepEqual([s.since, s.exact], [1000, false]);
  s = board.trackStatus(mem, { ...a, agent_status: 'idle', state_change_seq: 5 }, 8000);
  assert.deepEqual([s.since, s.exact], [8000, true]);
  // The board was away for an hour: the change time is only a lower bound.
  s = board.trackStatus(mem, { ...a, agent_status: 'working', state_change_seq: 6 }, 8000 + 3600e3);
  assert.equal(s.exact, false);
});

test('formats', () => {
  assert.equal(board.fmtDuration(40e3), '40s');
  assert.equal(board.fmtDuration(27 * 60e3 + 5e3), '27m');
  assert.equal(board.fmtDuration(65 * 60e3), '1h05');
  assert.equal(board.fmtTokens(950), '950');
  assert.equal(board.fmtTokens(34000), '34K');
  assert.equal(board.fmtTokens(136700), '136.7K');
  assert.equal(board.fmtTokens(1250000), '1.3M');
  assert.equal(board.fmtCost(2.0251), '$2.03');
  assert.equal(board.fmtCost(102.19), '$102');
});

const NOW = Date.UTC(2026, 9, 21, 14, 30);

function sample() {
  const snap = {
    workspaces: [{ workspace_id: 'w1', label: 'example-app' }, { workspace_id: 'w2', label: 'site' }],
    panes: [
      { pane_id: 'w1:p1', label: 'docs · write the API guide', cwd: proj },
      { pane_id: 'w1:p2', label: '🟩 api · fix the login timeout bug in the session middleware', cwd: proj },
      { pane_id: 'w1:p3', label: 'tests · flaky suite triage', cwd: proj },
      { pane_id: 'w1:p4', cwd: proj },
      { pane_id: 'w2:p1', label: 'copy · landing page draft', cwd: '/elsewhere' },
      { pane_id: 'w1:p9', label: 'a shell, not an agent', cwd: proj },
    ],
    agents: [
      { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'agy', agent_status: 'blocked', state_change_seq: 2, cwd: '/elsewhere' },
      { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', state_change_seq: 9, cwd: proj },
      { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude', agent_status: 'working', state_change_seq: 3, cwd: proj },
      { pane_id: 'w1:p3', workspace_id: 'w1', agent: 'opencode', agent_status: 'working', state_change_seq: 7, cwd: proj },
      { pane_id: 'w1:p4', workspace_id: 'w1', agent: 'kilo', name: 'helper', agent_status: 'done', state_change_seq: 1, cwd: proj },
    ],
  };
  const crew = toCrew(parseToml(`
name = "example crew"
[[check]]
name = "Always"
run = "true"
[[check]]
name = "Never"
run = "false"
[[pane]]
name = "docs"
model = "sonnet"
report = "agents/docs/report.md"
checks = ["GREEN: true", "RED: false"]
[[pane]]
name = "tests"
model = "from-crew"
`), path.join(proj, '.crew-board.toml'));
  crew.hash = 'allowed';
  const mem = {
    tags: {},
    status: {
      'w1:p1': { status: 'idle', seq: 9, since: NOW - 4 * 60e3, exact: true, seen: NOW - 1000 },
      'w1:p2': { status: 'working', seq: 3, since: NOW - 27 * 60e3, exact: true, seen: NOW - 1000 },
      'w1:p3': { status: 'working', seq: 7, since: NOW - 41 * 60e3, exact: false, seen: NOW - 1000 },
      'w1:p4': { status: 'done', seq: 1, since: NOW - 65 * 60e3, exact: true, seen: NOW - 1000 },
      'w2:p1': { status: 'blocked', seq: 2, since: NOW - 30e3, exact: true, seen: NOW - 1000 },
    },
  };
  return {
    snap,
    agents: board.selectAgents(snap, null),
    screens: { 'w1:p2': fx('claude-statusline.txt'), 'w1:p3': fx('opencode.txt'), 'w2:p1': fx('agy.txt') },
    reports: { 'w1:p1': { ctx: 17, tokens: 34000, cost: 2.03, model: 'opus', effort: 'medium' } },
    rss: { 'w1:p1': 1572864, 'w1:p2': 655360 },
    crewFor: (dir) => (dir === proj ? crew : null),
    trust: { [crew.file]: 'allowed' },
    mem,
    now: NOW,
  };
}

test('selectAgents: workspace order, filter by id or label', () => {
  const { snap } = sample();
  assert.deepEqual(board.selectAgents(snap, null).map((a) => a.pane_id), ['w1:p1', 'w1:p2', 'w1:p3', 'w1:p4', 'w2:p1']);
  assert.deepEqual(board.selectAgents(snap, 'site').map((a) => a.pane_id), ['w2:p1']);
  assert.deepEqual(board.selectAgents(snap, 'w2').map((a) => a.pane_id), ['w2:p1']);
});

test('selectAgents: excludes board panes and myPaneId', () => {
  const { snap } = sample();
  const boardAgent = { pane_id: 'w1:p99', terminal_title_stripped: 'crew-board', label: 'opencode', workspace_id: 'w1' };
  const roostrAgent = { pane_id: 'w1:p98', terminal_title_stripped: '🐓ROOSTR🐓', label: '🐓ROOSTR🐓', workspace_id: 'w1' };
  const extendedSnap = { ...snap, agents: [...snap.agents, boardAgent, roostrAgent] };
  const agents = board.selectAgents(extendedSnap, null, { myPaneId: 'w1:p1' });
  assert.ok(!agents.some((a) => a.pane_id === 'w1:p1'));
  assert.ok(!agents.some((a) => a.pane_id === 'w1:p99'));
  assert.ok(!agents.some((a) => a.pane_id === 'w1:p98'));
});

test('needsScreen: skip the screen read when a report covers everything', () => {
  const a = { agent: 'claude' };
  assert.equal(board.needsScreen(a, null), true);
  assert.equal(board.needsScreen(a, { ctx: 1, tokens: 1, cost: 1, model: 'x' }), false);
  assert.equal(board.needsScreen({ agent: 'codex' }, null), false);
});

test('buildModel: sources in order, ? when unknown, badges from the crew file', async () => {
  const input = sample();
  await checks.refresh(board.buildModel(input).checkList);
  const m = board.buildModel(sample());
  const row = (id) => m.rows.find((r) => r.paneId === id);

  const docs = row('w1:p1');
  assert.equal(docs.name, 'docs');
  assert.equal(docs.task, 'write the API guide');
  assert.deepEqual(docs.model, { v: 'opus', src: 'exact' });
  assert.deepEqual(docs.ctx, { v: 17, src: 'exact' });
  assert.deepEqual(docs.badges.map((b) => b.name), ['REPORT READY', 'GREEN']);

  const api = row('w1:p2');
  assert.equal(api.name, 'api');
  assert.deepEqual(api.ctx, { v: 18, src: 'screen' });
  assert.deepEqual(api.model, { v: null, src: 'unknown' });

  const tests = row('w1:p3');
  assert.deepEqual(tests.model, { v: 'from-crew', src: 'crew' });
  assert.deepEqual(tests.cost, { v: null, src: 'unknown' });

  const helper = row('w1:p4');
  assert.equal(helper.name, 'helper');
  assert.equal(helper.task, null);
  assert.deepEqual(helper.ctx, { v: null, src: 'unknown' });

  const copy = row('w2:p1');
  assert.equal(copy.workspace, 'site');
  assert.equal(copy.crew, null);
  assert.equal(copy.statusFor, 30e3);

  assert.equal(m.rows.length, 5);
  assert.deepEqual(m.crewChecks, [{ name: 'Always', state: true }, { name: 'Never', state: false }]);
  assert.ok(board.toJsonRows(m).every((r) => !('crew' in r)));
});

test('buildModel: Gemini cost is estimated from API prices, exact cost still wins', () => {
  const input = sample();
  const estimated = board.buildModel({
    ...input,
    reports: { ...input.reports, 'w2:p1': { model: 'Gemini 3.8 Flash', input: 100000, output: 10000, tokens: 110000 } },
  });
  const estimate = estimated.rows.find((r) => r.paneId === 'w2:p1');
  assert.deepEqual(estimate.cost, { v: 0.1125, src: 'estimate' });
  assert.deepEqual(estimate.price, { id: 'gemini-3.8-flash', input: 0.75, output: 3.75 });
  ui.setColor(false);
  assert.match(board.render(estimated, { width: 140 }), /~\$0\.11/);

  const exact = board.buildModel({
    ...input,
    reports: { ...input.reports, 'w2:p1': { model: 'Gemini 3.8 Flash', input: 100000, output: 10000, cost: 1.5 } },
  }).rows.find((r) => r.paneId === 'w2:p1');
  assert.deepEqual(exact.cost, { v: 1.5, src: 'exact' });
  assert.equal(exact.price, null);
});

test('render: snapshot of a full board', async () => {
  await checks.refresh(board.buildModel(sample()).checkList);
  const m = board.buildModel(sample());
  ui.setColor(false);
  const out = board.render(m, { width: 118, load: [1.5, 1.25, 1] });
  // The build in the corner changes with every commit, so the fixture keeps a
  // placeholder and the rest of the board stays byte exact.
  const stable = out.replace(/v\d+\.\d+\.\d+(@[0-9a-f]{4,40})?\*?/g, '<build>')
    .split('\n')
    .map((line, i) => (i === 0 ? line.replace(/\s+/g, ' ').trim() : line))
    .join('\n');
  const file = path.join(__dirname, 'fixtures', 'board.snapshot.txt');
  if (process.env.UPDATE_SNAPSHOTS) fs.writeFileSync(file, stable + '\n');
  assert.equal(stable + '\n', fs.readFileSync(file, 'utf8'));
  for (const line of out.split('\n')) assert.ok(ui.strWidth(line) <= 118, line);
});

test('render: narrow panes clip every line, colour on or off', () => {
  const m = board.buildModel(sample());
  for (const color of [false, true]) {
    ui.setColor(color);
    for (const line of board.render(m, { width: 60, height: 20 }).split('\n')) assert.ok(ui.strWidth(line) <= 60);
    assert.equal(board.render(m, { width: 60, height: 20 }).split('\n').length, 20);
  }
  ui.setColor(false);
});

test('render: line view drops low priority columns first, task line stays', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const head = (w) => board.render(m, { width: w, load: [1, 1, 1], view: 'line' }).split('\n').find((l) => /^ +name /.test(l));
  assert.match(head(118), /name +id +model +eff state +ctx +tokens +cost +ram task line/);
  // Narrower: the state word goes first, every column stays.
  assert.match(head(86), /name +id +model +eff state  ctx +tokens +cost +ram task line/);
  assert.ok(board.render(m, { width: 86, view: 'line' }).includes('○ 4m'));
  // Then ram, agent, id, tokens, cost, ctx give way.
  assert.match(head(76), /name +id +model +state  ctx +tokens +cost task line/);
  assert.doesNotMatch(head(72), /model/);
  assert.match(head(66), / id /);
  assert.doesNotMatch(head(60), / id /);
  assert.match(head(60), /tokens/);
  assert.doesNotMatch(head(55), /tokens/);
  assert.doesNotMatch(head(48), /cost/);
  assert.match(head(44), /^ +name +state +task line$/);
  for (const w of [44, 48, 55, 60, 70, 80]) {
    assert.ok(board.render(m, { width: w, view: 'line' }).includes('write the A'), `task line at width ${w}`);
  }
});

test('render: auto view puts a task under its row only when it does not fit', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const lines = board.render(m, { width: 100, view: 'auto' }).split('\n');
  const api = lines.findIndex((l) => / api /.test(l));
  assert.doesNotMatch(lines[api], /login/);
  assert.match(lines[api + 1], /^ {3}fix the login timeout bug/);
  const copy = lines.find((l) => / copy /.test(l) && !/BLOCKED/.test(l));
  assert.match(copy, /landing page draft$/);
});

test('render: wrap view puts every task line under its row', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const lines = board.render(m, { width: 80, view: 'wrap' }).split('\n');
  const i = lines.findIndex((l) => l.includes('docs '));
  assert.match(lines[i], /docs +w1:p1 +opus +med +○ idle 4m/);
  assert.equal(lines[i + 1], '   write the API guide  REPORT READY   GREEN ');
  assert.doesNotMatch(lines.find((l) => /^ +name /.test(l)), /task line/);
});

test('render: cards view renders multi-line agent cards with ctx bar and metrics', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const lines = board.render(m, { width: 100, view: 'cards' }).split('\n');
  assert.ok(lines.some((l) => /docs \(claude\) · w1:p1/.test(l)));
  assert.ok(lines.some((l) => /ctx.*tokens.*ram/.test(l)));
  assert.ok(lines.some((l) => /task:.*write the API guide/.test(l)));
});

test('agent column: short model name and effort letter', () => {
  assert.equal(board.shortModel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(board.shortModel('claude-sonnet-5-5[1m]'), 'Sonnet 5.5');
  assert.equal(board.shortModel('claude-haiku-5-5-20261001'), 'Haiku 5.5');
  assert.equal(board.shortModel('claude-opus-5'), 'Opus 5');
  assert.equal(board.shortModel('anthropic/claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(board.shortModel('Claude Opus 5.5'), 'Opus 5.5');
  assert.equal(board.shortModel('openai/gpt-6-mini'), 'gpt-6-mini');
  assert.equal(board.shortModel('Example Model 2'), 'Example Model 2');
  const m = board.buildModel(sample());
  ui.setColor(false);
  const out = board.render(m, { width: 118, view: 'line' });
  assert.match(out, /docs +w1:p1 +opus +med +○/);
  assert.match(out, /helper +w1:p4 +\? +\? +✓/);
});

test('render: blocked panes lead their workspace, quiet unknowns, folded groups', () => {
  const snap = {
    workspaces: [{ workspace_id: 'w1', label: 'one' }, { workspace_id: 'w2', label: 'two' }],
    panes: [],
    agents: [
      { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle' },
      { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude', agent_status: 'blocked' },
      { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'agy', agent_status: 'working' },
    ],
  };
  const m = board.buildModel({ snap, agents: snap.agents, mem: { tags: {}, status: {} }, now: NOW });
  assert.deepEqual(m.rows.map((r) => r.paneId), ['w1:p2', 'w1:p1', 'w2:p1']);
  ui.setColor(false);
  const hits = [];
  const out = board.render(m, { width: 100, folded: new Set(['one']), hits }).split('\n');
  assert.ok(out.some((l) => /^▸ ━+ one ━+  2 panes  ◼ 1 blocked$/.test(l)));
  assert.ok(out.some((l) => /^▾ ━+ two ━+  1 pane$/.test(l)));
  assert.ok(!out.some((l) => l.includes('w1:p1')));
  const fold = hits.find((h) => h.action === 'fold' && h.workspace === 'two');
  assert.match(out[fold.y], /^▾ ━+ two/);
  ui.setColor(true);
  const q = board.render(m, { width: 100 });
  assert.ok(!q.includes('\x1b[1m\x1b[38;5;203m?'), 'unknowns are not bold red');
  ui.setColor(false);
});

test('task line: label, then an exact report, then the terminal title', () => {
  const snap = {
    workspaces: [{ workspace_id: 'w1', label: 'one' }],
    panes: [{ pane_id: 'w1:p1', label: 'docs · from the label' }],
    agents: [
      { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', terminal_title_stripped: 'Title loses' },
      { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', terminal_title_stripped: 'Title loses too' },
      { pane_id: 'w1:p3', workspace_id: 'w1', agent: 'opencode', agent_status: 'idle', terminal_title_stripped: 'OC | Fix the login bug' },
      { pane_id: 'w1:p4', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', terminal_title_stripped: 'Claude Code' },
      { pane_id: 'w1:p5', workspace_id: 'w1', agent: 'opencode', agent_status: 'idle', terminal_title_stripped: 'OpenCode' },
    ],
  };
  const m = board.buildModel({
    snap, agents: snap.agents, reports: { 'w1:p2': { task: 'reported task' } }, mem: { tags: {}, status: {} }, now: NOW,
  });
  assert.deepEqual(m.rows.map((r) => [r.task, r.taskSrc]), [
    ['from the label', 'label'], ['reported task', 'exact'], ['Fix the login bug', 'screen'], [null, 'unknown'], [null, 'unknown'],
  ]);
});

test('usage limits: newest report per source, bars above the footer, reset windows dropped', () => {
  const m = board.buildModel(sample());
  m.limits = [{ source: 'claude', windows: [{ name: '5h', used: 41, resets: NOW / 1000 + 3600 }, { name: '7d', used: 90, resets: null }] }];
  ui.setColor(false);
  const out = board.render(m, { width: 100, height: 30 }).split('\n');
  assert.equal(out.length, 30);
  assert.match(out[out.length - 2], /^claude  5h ████░░░░░░ 41% resets \d\d:\d\d   7d █████████░ 90%$/);
});

test('usage limits: a window with only a cap shows ?/cap, not a bar', () => {
  const m = board.buildModel(sample());
  m.limits = [{ source: 'explabs', windows: [{ name: '1h', used: null, cap: '2M', resets: null }] }];
  ui.setColor(false);
  const out = board.render(m, { width: 100, height: 30 }).split('\n');
  assert.equal(out[out.length - 2], 'explabs  1h ?/2M');
});

test('usage limits: one provider at a time, p names the next including off', () => {
  const m = board.buildModel(sample());
  m.limits = [
    { source: 'claude', windows: [{ name: '5h', used: 41, resets: null }] },
    { source: 'agy gemini', windows: [{ name: '5h', used: 16, resets: null }] },
    { source: 'agy other', windows: [{ name: '7d', used: 97, resets: null }] },
  ];
  ui.setColor(false);
  const tail = (provider) => board.render(m, { width: 100, height: 30, provider }).split('\n').slice(-4, -1);
  assert.match(tail(null)[2], /^claude  5h ████░░░░░░ 41%   p ▸ agy$/);
  assert.match(tail('nobody')[2], /^claude /, 'an unknown provider falls back to the first');
  const agy = tail('agy');
  assert.match(agy[1], /^agy gemini  5h ██░░░░░░░░ 16%   p ▸ off   P ▸ gemini$/);
  assert.match(agy[2], /^agy other  7d ██████████ 97%$/);
  const off = board.render(m, { width: 100, height: 30, provider: 'off' });
  assert.doesNotMatch(off, /claude  5h/);
  assert.doesNotMatch(off, /agy gemini/);
  m.limits = m.limits.slice(0, 1);
  assert.doesNotMatch(board.render(m, { width: 100, height: 30 }), /p ▸/, 'no switch hint with one provider');
});

test('render: pace multiplier on the usage line, only while burning', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  m.limits = [{ source: 'claude', windows: [{ name: '5h', used: 64, resets: 0, pace: 2.13, eta: m.now + 3600000 }, { name: '7d', used: 72, resets: 0, pace: 0.01 }] }];
  const hits = [];
  const line = board.render(m, { width: 200, height: 30, hits }).split('\n').find((l) => l.startsWith('claude'));
  assert.match(line, /5h ██████░░░░ 64% ⚡ 2\.1× ⚠ out in ~1h00 +7d ███████░░░ 72%$/);
  const paceHit = hits.find((h) => h.action === 'tooltip' && h.text && h.text.includes('⚡ burn pace'));
  assert.ok(paceHit, 'pace tooltip hit exists');
  assert.match(paceHit.text, /⚡ burn pace: 2\.1×/);
  const etaHit = hits.find((h) => h.action === 'tooltip' && h.text && h.text.includes('⚠ quota run-out'));
  assert.ok(etaHit, 'eta tooltip hit exists');
  assert.match(etaHit.text, /window exhausts in ~1h/);
  const barHit = hits.find((h) => h.action === 'tooltip' && h.text && h.text.includes('5h: 64% quota used'));
  assert.ok(barHit, 'usage bar tooltip hit exists');
});

test('render: line 0 is a four-zone live status bar with click regions', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  m.tokscale = { total: 3.45 };
  m.limits = [{ source: 'claude', windows: [{ name: '5h', used: 64, resets: 0, pace: 1.2 }] }];
  const hits = [];
  const out = board.render(m, { width: 200, height: 30, load: [2.14, 1.8, 1.1], hits }).split('\n');
  assert.ok(!out[0].includes('🐓ROOSTR🐓'), 'the pane header carries the name now');
  assert.ok(out[0].startsWith('example crew'), 'the crew title leads line 0');
  assert.match(out[0], /● 2 working · ○ 1 idle · ◼ 1 blocked · ✓ 1 done/);
  assert.match(out[0], /today \$3\.45 ⚡ 1\.2×/);
  assert.match(out[0], /14:30 {2}load 2\.14 1\.80 1\.10/);
  const pulse = hits.find((h) => h.action === 'tooltip' && h.text && h.text.includes('crew pulse'));
  assert.ok(pulse && pulse.y === 0, 'crew pulse tooltip on line 0');
  assert.match(pulse.text, /2 working, 1 idle, 1 blocked, 1 done/);
  const bolt = hits.find((h) => h.action === 'tooltip' && h.y === 0 && h.text && h.text.includes('⚡ burn pace: 1.2×'));
  assert.ok(bolt, 'burn pace tooltip on line 0');
  const load = hits.find((h) => h.action === 'tooltip' && h.y === 0 && h.text && h.text.includes('load 1m/5m/15m'));
  assert.ok(load, 'load tooltip on line 0');
  assert.match(load.text, /2\.14, 1\.80, 1\.10 across \d+ CPU cores/);
  assert.ok(hits.some((h) => h.action === 'today' && h.y === 0), 'today spend is clickable on line 0');
});

test('render: line 0 uses the short load form under 105 columns', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const out = board.render(m, { width: 90, load: [0.5, 0.5, 0.5] }).split('\n');
  assert.match(out[0], /14:30 · load 0\.50/);
  assert.ok(!/load 0\.50 0\.50 0\.50/.test(out[0]), 'the three load numbers collapse when narrow');
});

test('render: the build sits in the right corner so two devices can compare', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const hits = [];
  const out = board.render(m, { width: 140, height: 20, load: [0.5, 0.5, 0.5], hits }).split('\n');
  assert.match(out[0], new RegExp(`v${VERSION.replace(/\./g, '\\.')}(@[0-9a-f]{4,40})?\\*?$`), 'the version ends line 0');
  const ver = hits.find((h) => h.action === 'tooltip' && h.y === 0 && h.text && h.text.startsWith('roostr v'));
  assert.ok(ver, 'the build has a tooltip');
  assert.match(ver.text, /on this device/);

  const offered = board.render(m, {
    width: 140, load: [0.5, 0.5, 0.5], hits: [],
    menu: { tags: 'none', view: 'auto', scope: 'all', update: '0.2.1' },
  }).split('\n');
  assert.match(offered[0], /⬆\s*$/, 'an offered update marks the corner');
});

test('render: surge, ctx and crew check clicks flash tooltips', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const surging = m.rows.find((r) => r.paneId === 'w1:p1');
  surging.surge = true;
  surging.ctx = { v: 87, src: 'exact' };
  const hits = [];
  board.render(m, { width: 200, hits, view: 'line' });
  assert.ok(hits.some((h) => h.action === 'tooltip' && h.text && h.text.includes('▲ 2× peak hours')), 'surge badge tooltip');
  assert.ok(hits.some((h) => h.action === 'tooltip' && h.text && h.text.startsWith('ctx 87%: critical context ceiling')), 'ctx cell tooltip');
  assert.ok(hits.some((h) => h.action === 'tooltip' && h.text === 'check Always: passing'), 'passing check tooltip');
  assert.ok(hits.some((h) => h.action === 'tooltip' && h.text === 'check Never: failing'), 'failing check tooltip');
  const cards = [];
  board.render(m, { width: 200, hits: cards, view: 'cards' });
  assert.ok(cards.some((h) => h.action === 'tooltip' && h.text && h.text.includes('▲ 2× peak hours')), 'surge badge tooltip in cards');
  assert.ok(cards.some((h) => h.action === 'tooltip' && h.text && h.text.startsWith('ctx 87%')), 'ctx meter tooltip in cards');
});

test('render: detail box for the selected row, with its buttons', () => {
  const input = sample();
  const m = board.buildModel(input);
  ui.setColor(false);
  const i = m.rows.findIndex((r) => r.paneId === 'w1:p1');
  const hits = [];
  const out = board.render(m, { width: 120, height: 40, menu: { tags: 'off', view: 'auto', scope: 'all' }, selected: i, detail: true, hits }).split('\n');
  const top = out.findIndex((l) => l.startsWith('── docs '));
  assert.ok(top > 0, 'box header');
  assert.match(out[top], /\[f jump\] \[esc close\]$/);
  assert.match(out[top + 1], /^  task  write the API guide$/);
  assert.match(out[top + 2], /^  agent /);
  assert.match(out[top + 3], /^  role  \?$/);
  assert.match(out[top + 4], /^  about \?$/);
  assert.match(out[top + 5], /^  now   . \w+ .* · ctx 17% · .* tokens · \$2\.03 · ram /);
  for (const action of ['jump', 'close']) {
    const h = hits.find((x) => x.action === action && x.y === top);
    assert.ok(h, `button ${action} on detail box`);
    assert.equal(h.y, top);
    assert.ok(out[h.y].slice(h.x0, h.x1 + 1).startsWith('['), action);
  }
  assert.doesNotMatch(board.render(m, { width: 120, height: 40, selected: i }), /── docs /, 'closed without detail');
});

test('render: help lists the keys instead of the rows', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const menu = { tags: 'tokens', view: 'auto', scope: 'all' };
  const hits = [];
  const out = board.render(m, { width: 200, menu, help: true, hits });
  assert.match(out, /^keys +any key or click closes this$/m);
  assert.match(out, /^MOVE +VIEWS$/m, 'two columns when wide');
  assert.match(out, /^MORE +LEGEND$/m);
  assert.match(out, /^  t +colour tags \(tokens\) +/m);
  assert.match(out, /● working  ○ idle  ◼ blocked  ✓ done/);
  const narrow = board.render(m, { width: 60, menu, help: true });
  assert.ok(['MOVE', 'VIEWS', 'MORE', 'LEGEND'].every((t, i, a) => i === 0 || narrow.indexOf(`\n${t}\n`) > narrow.indexOf(`\n${a[i - 1]}\n`)), 'one column, in order, when narrow');
  assert.doesNotMatch(out, /^ +name /m, 'no column header under the help');
  assert.ok(!hits.some((h) => h.action === 'row'), 'no row regions under the help');
  m.limits = [{ source: 'claude', windows: [{ name: '5h', used: 10, resets: 0 }] }];
  assert.match(board.render(m, { width: 200, menu, help: true }), /usage bars \(only claude reports\)/);
  m.limits.push({ source: 'agy gemini', windows: [{ name: '5h', used: 10, resets: 0 }] });
  assert.match(board.render(m, { width: 200, menu, help: true }), /usage bars: claude ▸ agy/);
});

test('ram: process tree sums, shown in M then G', () => {
  const ram = require('../src/ram');
  const t = ram.parsePs('  10     1  1000\n  11    10  2000\n  12    11   500\n  13     1  9999\nbad line\n');
  assert.equal(ram.treeRss(t, 10), 3500);
  assert.equal(ram.treeRss(t, 12), 500);
  assert.equal(ram.treeRss(t, 99), null);
  assert.equal(board.fmtRam(655360), '640M');
  assert.equal(board.fmtRam(1572864), '1.5G');
});

test('saveMemory: boards sharing board.json keep panes of other boards, drop dead ones, skip unchanged writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-mem-'));
  const saved = process.env.CREW_BOARD_STATE_DIR;
  process.env.CREW_BOARD_STATE_DIR = dir;
  try {
    const live = new Set(['w1:p1', 'w2:p1']);
    const a = { tags: { 'w1:p1': '🟦' }, status: {}, prefs: { view: 'wrap' } };
    board.saveMemory(a, new Set(['w1:p1']), live, new Set(['view']));
    const b = { tags: { 'w2:p1': '🟩', 'w9:p9': '🟥' }, status: {}, prefs: {} };
    board.saveMemory(b, new Set(['w2:p1']), live);
    const disk = board.loadMemory();
    assert.deepEqual(disk.tags, { 'w1:p1': '🟦', 'w2:p1': '🟩' });
    assert.equal(disk.prefs.view, 'wrap', 'a board that did not touch a pref leaves it');
    assert.deepEqual(b.tags, disk.tags, 'the merge comes back so new marks avoid the other board');
    const file = path.join(dir, 'board.json');
    const t = fs.statSync(file).mtimeMs;
    board.saveMemory(b, new Set(['w2:p1']), live);
    assert.equal(fs.statSync(file).mtimeMs, t, 'no change, no write');
  } finally {
    if (saved === undefined) delete process.env.CREW_BOARD_STATE_DIR;
    else process.env.CREW_BOARD_STATE_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ui.clean: control characters from pane data never reach the terminal', () => {
  assert.equal(ui.clean('x\x1b]52;c;aGk=\x07y\x1b[2Jz\u009bq'), 'x]52;c;aGk=y[2Jzq');
  assert.deepEqual(board.parseLabel('api\x1b[2J · fix\nit'), { name: 'api[2J', task: 'fix it' });
  ui.setColor(false);
  assert.ok(!ui.cell('a\x1b[31mb', 10).includes('\x1b'));
});

test('render: menu bar and click regions', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const hits = [];
  const out = board.render(m, { width: 120, menu: { tags: 'off', view: 'auto', scope: 'all' }, selected: 1, hits }).split('\n');
  assert.match(out[1], /^\[tags: off\] \[view: auto\] \[scope: all\] \[edit task\] \[L log\] \[R backups\] \[X respawn\] \[o options\] \[d today\] \[\? keys\]/);
  const outOrch = board.render(m, { width: 160, menu: { tags: 'off', view: 'auto', scope: 'all', orchestration: true }, selected: 1 }).split('\n');
  assert.match(outOrch[1], /^\[tags: off\] \[view: auto\] \[scope: all\] \[edit task\] \[L log\] \[R backups\] \[X respawn\] \[o options\] \[O orchestrate\] \[d today\] \[\? keys\]/);
  assert.ok(!hits.some((h) => h.action === 'egm'));
  assert.ok(hits.some((h) => h.action === 'help'));
  const tags = hits.find((h) => h.action === 'tags');
  assert.deepEqual([tags.y, tags.x0, tags.x1], [1, 0, 10]);
  // Every row region points at the line its pane is drawn on.
  for (const h of hits.filter((x) => x.action === 'row')) {
    assert.ok(out[h.y].includes(m.rows[h.index].name) || out[h.y].startsWith('   '), out[h.y]);
  }
  // Clipped by height: no region for a line that is not drawn.
  const few = [];
  board.render(m, { width: 120, height: 8, menu: { tags: 'off', view: 'auto', scope: 'all' }, hits: few });
  assert.ok(few.filter((h) => h.action !== 'help').every((h) => h.y < 5));
  assert.deepEqual(few.filter((h) => h.action === 'help' && h.x1 === 119 && h.y > 1).map((h) => h.y), [7], 'the footer opens the help');
});

test('render: the log drawer lists a recent session', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const logView = {
    items: [{ id: 'ses_a', kind: 'opencode', title: 'Fix the log', directory: '/tmp/app', updated: NOW }],
    sel: 0, all: false, dirs: ['/tmp/app'], busy: false, status: null,
  };
  const out = board.render(m, { width: 120, logView }).split('\n').join('\n');
  assert.match(out, /log/);
  assert.match(out, /Fix the log/);
  assert.match(out, /opencode/);
});

test('EGM is gone from the model, the keys and the parser', () => {
  const m = board.buildModel(sample());
  assert.equal('specs' in m, false);
  assert.equal('sddPhase' in m, false);
  assert.throws(() => board.parseArgs(['--egm']), /unknown option/);
  ui.setColor(false);
  const out = board.render(m, { width: 200, menu: { tags: 'off', view: 'auto', scope: 'all' }, help: true });
  assert.doesNotMatch(out, /EGM/);
});

test('toJson: envelope has version, scope, summary and pane rows', () => {
  const m = board.buildModel(sample());
  m.scopeLabel = 'all';
  const j = board.toJson(m);
  assert.deepEqual(Object.keys(j), ['schema', 'version', 'commit', 'generatedAt', 'scope', 'workspace', 'summary', 'panes']);
  assert.equal(j.schema, 1);
  assert.match(j.version, /^\d+\.\d+\.\d+$/);
  assert.ok(j.commit === null || /^[0-9a-f]{4,40}$/.test(j.commit));
  assert.equal(j.generatedAt, new Date(NOW).toISOString());
  assert.equal(j.scope, 'all');
  assert.equal(j.workspace, null);
  assert.deepEqual(
    { ...j.summary, totalCost: undefined },
    { total: 5, working: 2, idle: 1, blocked: 1, done: 1, unknown: 0, totalCost: undefined },
  );
  assert.equal(typeof j.summary.totalCost, 'number');
  assert.ok(j.summary.totalCost > 0);
  assert.equal(j.panes.length, 5);
  assert.ok(j.panes.every((p) => p.paneId && 'crewFile' in p && !('crew' in p)));
  assert.ok(Array.isArray(board.toJsonRows(m)));
  assert.deepEqual(board.toJsonRows(m), j.panes);
});

test('toJson: totalCost is null when no cost is known', () => {
  const agent = { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'codex' };
  const m = board.buildModel({
    snap: { workspaces: [], panes: [{ pane_id: 'w1:p1' }], agents: [agent] },
    agents: [agent],
    mem: { tags: {}, status: {} },
    now: NOW,
  });
  m.scopeLabel = 'all';
  assert.equal(board.toJson(m).summary.totalCost, null);
});

test('buildModel: trusted crew check limits and the explabs opt in reach the model', () => {
  const crew = toCrew(parseToml('[checks]\nconcurrency = 5\ntimeout_seconds = 4\n[providers.explabs]\nenabled = true\n'), '/p/.crew-board.toml');
  crew.hash = 'h';
  const input = sample();
  const m = board.buildModel({ ...input, crewFor: () => crew, trust: { [crew.file]: 'h' } });
  assert.equal(m.checkConcurrency, 5);
  assert.equal(m.checkTimeoutMs, 4000);
  assert.equal(m.explabsEnabled, true);
  const off = board.buildModel({ ...input, crewFor: () => crew, trust: {} });
  assert.equal(off.checkConcurrency, 3);
  assert.equal(off.checkTimeoutMs, 2000);
  assert.equal(off.explabsEnabled, false);
});

test('detail box: a recorded model line appears only with three or more runs', () => {
  const m = board.buildModel(sample());
  const row = { ...m.rows[0], modelStats: { configured: null, best: { model: 'fast-model', count: 12, passRate: 83, avgCost: 0.12 } } };
  ui.setColor(false);
  const out = board.detailBox(row, 120).lines.join('\n');
  assert.match(out, /recorded\s+fast-model 12 runs, 83% first try, \$0\.12 avg/);
  const few = { ...m.rows[0], modelStats: { configured: null, best: { model: 'fast-model', count: 2, passRate: 50, avgCost: null } } };
  assert.doesNotMatch(board.detailBox(few, 120).lines.join('\n'), /recorded/);
});

test('applyTags: tag scope limits label and metadata mutations to the home workspace', async () => {
  const herdr = require('../src/herdr');
  const calls = [];
  const saved = {
    renamePane: herdr.renamePane, setDisplayAgent: herdr.setDisplayAgent,
    clearDisplayAgent: herdr.clearDisplayAgent, setTokens: herdr.setTokens, clearTokens: herdr.clearTokens,
  };
  herdr.renamePane = async (id, label) => calls.push(['rename', id, label]);
  herdr.setDisplayAgent = async (id, t) => calls.push(['display', id, t]);
  herdr.clearDisplayAgent = async (id) => calls.push(['clear-display', id]);
  herdr.setTokens = async (id) => calls.push(['tokens', id]);
  herdr.clearTokens = async (id) => calls.push(['clear-tokens', id]);
  const rows = [
    { paneId: 'w1:p1', workspaceId: 'w1', label: 'a · x', tag: '🟦', kind: 'claude', crew: null, model: { v: null }, ctx: { v: null }, cost: { v: null }, ram: { v: null } },
    { paneId: 'w2:p1', workspaceId: 'w2', label: 'b · y', tag: '🟩', kind: 'claude', crew: null, model: { v: null }, ctx: { v: null }, cost: { v: null }, ram: { v: null } },
  ];
  try {
    await board.applyTags({ rows, tagScope: 'here', home: 'w1' }, { tags: 'label' }, { renamed: {}, display: {} });
    assert.deepEqual(calls.filter((c) => c[0] === 'rename').map((c) => c[1]), ['w1:p1']);
    calls.length = 0;
    await board.applyTags({ rows, tagScope: 'here', home: 'w1' }, { tags: 'metadata' }, { renamed: {}, display: {} });
    assert.deepEqual(calls.filter((c) => c[0] === 'display').map((c) => c[1]), ['w1:p1']);
    calls.length = 0;
    await board.applyTags({ rows, tagScope: 'here', home: 'w1' }, { tags: 'tokens' }, { renamed: {}, display: {} });
    assert.deepEqual(calls.filter((c) => c[0] === 'tokens').map((c) => c[1]), ['w1:p1', 'w2:p1']);
    calls.length = 0;
    await board.applyTags({ rows, tagScope: 'all', home: 'w1' }, { tags: 'label' }, { renamed: {}, display: {} });
    assert.deepEqual(calls.filter((c) => c[0] === 'rename').map((c) => c[1]), ['w1:p1', 'w2:p1']);
    calls.length = 0;
    await board.applyTags({ rows, tagScope: 'here', home: null }, { tags: 'metadata' }, { renamed: {}, display: {} });
    assert.deepEqual(calls.filter((c) => c[0] !== 'tokens'), []);
  } finally {
    Object.assign(herdr, saved);
  }
});

test('applyTags: label mode is the default and puts the emoji in the pane name', async () => {
  const herdr = require('../src/herdr');
  const saved = {
    renamePane: herdr.renamePane, setDisplayAgent: herdr.setDisplayAgent, clearDisplayAgent: herdr.clearDisplayAgent,
    setTokens: herdr.setTokens, clearTokens: herdr.clearTokens,
  };
  const calls = [];
  herdr.renamePane = async (id, label) => calls.push(['rename', id, label]);
  herdr.setDisplayAgent = async () => {};
  herdr.clearDisplayAgent = async () => {};
  herdr.setTokens = async () => {};
  herdr.clearTokens = async () => {};
  const rows = [{ paneId: 'w1:p1', workspaceId: 'w1', label: 'Diego', tag: '🟦', kind: 'claude', crew: null }];
  try {
    await board.applyTags({ rows, tagScope: 'here', home: 'w1' }, {}, { renamed: {}, display: {} });
    assert.deepEqual(calls.filter((c) => c[0] === 'rename'), [['rename', 'w1:p1', '🟦 Diego']]);
  } finally {
    Object.assign(herdr, saved);
  }
});

test('refreshBackups: reloads, keeps the selected workspace and version, and shows the restore plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-bkp-'));
  const saved = process.env.CREW_BOARD_STATE_DIR;
  process.env.CREW_BOARD_STATE_DIR = dir;
  const backup = require('../src/backup');
  const make = (workspaceId, label, savedAt, session) => ({
    version: 1,
    workspaceId,
    label,
    savedAt,
    tabs: [{
      label: null,
      focused: true,
      tree: { pane: `${workspaceId}:p1` },
      panes: [{ paneId: `${workspaceId}:p1`, cwd: '/tmp/app', agent: { kind: 'claude', session } }],
    }],
  });
  try {
    ui.setColor(false);
    backup.saveBackups([make('w1', 'app', '2026-10-01T10:00:00.000Z', 's1')]);
    let st = board.refreshBackups({ list: [], sel: 0, ver: 0, confirm: false, status: null });
    assert.equal(st.list.length, 1);
    backup.saveBackups([make('w2', 'site', '2026-10-02T10:00:00.000Z', 's2')]);
    st = board.refreshBackups(st);
    assert.equal(st.list.length, 2);
    st.sel = st.list.findIndex((b) => b.workspaceId === 'w1');
    st.ver = 0;
    const savedAt = st.list[st.sel].versions[0].savedAt;
    backup.saveBackups([make('w1', 'app', '2026-10-03T10:00:00.000Z', 's3')]);
    st = board.refreshBackups(st);
    assert.equal(st.list[st.sel].workspaceId, 'w1');
    assert.equal(st.list[st.sel].versions[st.ver].savedAt, savedAt);
    const busy = { ...st, busy: true };
    assert.equal(board.refreshBackups(busy), busy);
    st.confirm = true;
    const out = board.render(board.buildModel(sample()), { width: 120, backups: st });
    assert.match(out, /restore app · 1 tabs, 1 panes, 1 agents · layout even · y to confirm, any other key cancels/);
  } finally {
    if (saved === undefined) delete process.env.CREW_BOARD_STATE_DIR;
    else process.env.CREW_BOARD_STATE_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('render: the edit prompt replaces the footer', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const out = board.render(m, { width: 100, selected: 0, edit: { text: 'new task' } }).split('\n');
  assert.match(out[out.length - 1], /^task for docs: new task█ +↵ save · esc cancel$/);
});

test('mouse: one click selects, a second click on the same pane jumps', () => {
  const last = { paneId: 'w1:p1', at: 1000 };
  assert.equal(board.isDoubleClick(last, 'w1:p1', 1200), true);
  assert.equal(board.isDoubleClick(last, 'w1:p1', 1600), false);
  assert.equal(board.isDoubleClick(last, 'w1:p2', 1100), false);
  assert.equal(board.isDoubleClick(null, 'w1:p1', 1100), false);
});

test('mouse: SGR click sequences', () => {
  const found = [...'\x1b[<0;12;5M\x1b[<0;12;5m'.matchAll(board.MOUSE_RE)].map((x) => x.slice(1));
  assert.deepEqual(found, [['0', '12', '5', 'M'], ['0', '12', '5', 'm']]);
});

test('names: the label is the human name, the Herdr name is the machine name', () => {
  const input = sample();
  input.agents = input.agents.map((a) => (a.pane_id === 'w1:p1' ? { ...a, name: 'mateo' } : a));
  const m = board.buildModel(input);
  const docs = m.rows.find((r) => r.paneId === 'w1:p1');
  assert.equal(docs.agentName, 'mateo');
  assert.equal(docs.displayName, 'docs', 'the label human name wins');
  assert.equal(docs.name, 'docs', 'name stays the display name');
  assert.equal(docs.labelName, 'docs');
  // The crew file still matches the label name.
  assert.deepEqual(docs.model, { v: 'opus', src: 'exact' });
  assert.ok(docs.badges.some((b) => b.name === 'REPORT READY'));

  // No label: the Herdr agent name stands in.
  const bare = sample();
  bare.snap = { ...bare.snap, panes: bare.snap.panes.filter((p) => p.pane_id !== 'w1:p2') };
  bare.agents = bare.agents.map((a) => (a.pane_id === 'w1:p2' ? { ...a, name: 'mateo' } : a));
  const b = board.buildModel(bare);
  const api = b.rows.find((r) => r.paneId === 'w1:p2');
  assert.equal(api.agentName, 'mateo');
  assert.equal(api.displayName, 'mateo');
  assert.equal(api.name, 'mateo');
});

test('role and about: row suffix, detail lines and JSON fields', () => {
  const input = sample();
  input.reports = {
    ...input.reports,
    'w1:p1': { ...input.reports['w1:p1'], role: 'board core and CLI', about: 'Owns the board and the command line' },
  };
  const m = board.buildModel(input);
  ui.setColor(false);
  const docs = m.rows.find((r) => r.paneId === 'w1:p1');
  assert.equal(docs.role, 'board core and CLI');
  assert.equal(docs.about, 'Owns the board and the command line');

  const rowLine = board.render(m, { width: 140, menu: { tags: 'off', view: 'auto', scope: 'all' } })
    .split('\n').find((l) => l.includes('w1:p1'));
  assert.match(rowLine, /docs · board core and CLI/);

  const i = m.rows.findIndex((r) => r.paneId === 'w1:p1');
  const box = board.render(m, { width: 120, height: 40, selected: i, detail: true }).split('\n');
  assert.ok(box.some((l) => /^  role  board core and CLI$/.test(l)), 'role line');
  assert.ok(box.some((l) => /^  about Owns the board and the command line$/.test(l)), 'about line');

  const rows = board.toJsonRows(m);
  const jrow = rows.find((r) => r.paneId === 'w1:p1');
  assert.equal(jrow.agentName, null);
  assert.equal(jrow.displayName, 'docs');
  assert.equal(jrow.role, 'board core and CLI');
  assert.equal(jrow.about, 'Owns the board and the command line');
  assert.equal(board.toJson(m).panes.find((p) => p.paneId === 'w1:p1').role, 'board core and CLI');
});

test('role: missing role shows only the name and a detail role of ?', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const row = m.rows.find((r) => r.paneId === 'w1:p1');
  assert.equal(row.role, null);
  assert.equal(row.about, null);
  const i = m.rows.findIndex((r) => r.paneId === 'w1:p1');
  const box = board.render(m, { width: 120, height: 40, selected: i, detail: true }).split('\n');
  assert.ok(box.some((l) => /^  role  \?$/.test(l)));
  assert.ok(box.some((l) => /^  about \?$/.test(l)));
});

test('sidebar name: an unnamed agent never falls back to its pane id', () => {
  const tokens = board.sidebarTokens({ paneId: 'w1:p9', displayName: 'w1:p9', name: 'w1:p9', label: '🟨 opencode', kind: 'opencode', agentName: null, task: 'graph work' });
  assert.equal(tokens.name, 'opencode');
});

test('applyTags: tokens mode publishes sidebar tokens, leaves labels alone, clears on the way out', async () => {
  const herdr = require('../src/herdr');
  const calls = [];
  const saved = { renamePane: herdr.renamePane, setTokens: herdr.setTokens, clearTokens: herdr.clearTokens };
  herdr.renamePane = async (id, label) => calls.push(['rename', id, label]);
  herdr.setTokens = async (id, t, ttl) => calls.push(['tokens', id, t, ttl]);
  herdr.clearTokens = async (id, names) => calls.push(['clear', id, names]);
  try {
    const m = board.buildModel(sample());
    const memo = { renamed: {}, display: {}, tokens: {} };
    await board.applyTags(m, { tags: 'tokens' }, memo);
    assert.ok(!calls.some((c) => c[0] === 'rename' && /^🟦/.test(c[2])), 'no mark is written into an untagged label');
    const docs = calls.find((c) => c[0] === 'tokens' && c[1] === 'w1:p1');
    assert.deepEqual(docs[2], {
      tag: m.rows.find((r) => r.paneId === 'w1:p1').tag, name: 'docs', task: 'write the API guide', model: 'opus', ctx: '17%', cost: '$2.03', ram: '1.5G',
    });
    assert.equal(docs[3], 90000);
    assert.equal(calls.find((c) => c[0] === 'tokens' && c[1] === 'w1:p4')[2].cost, '', 'unknown values clear their token');
    calls.length = 0;
    await board.applyTags(m, { tags: 'tokens' }, memo);
    assert.deepEqual(calls.filter((c) => c[0] === 'tokens'), [], 'unchanged tokens are not rewritten');
    await board.applyTags(m, { tags: 'off' }, memo);
    assert.deepEqual(calls.filter((c) => c[0] === 'clear').map((c) => c[1]).sort(), m.rows.map((r) => r.paneId).sort());
  } finally {
    Object.assign(herdr, saved);
  }
});

test('status events: the hook records when a status began, the board shows it exactly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-ev-'));
  const saved = process.env.CREW_BOARD_STATE_DIR;
  process.env.CREW_BOARD_STATE_DIR = dir;
  try {
    const hook = require('../scripts/status-event');
    const json = (data) => ({ HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event: 'pane.agent_status_changed', data }) });
    assert.deepEqual(hook.main(json({ pane_id: 'w1:p1', agent_status: 'Blocked' }), NOW - 5 * 60e3), { pane: 'w1:p1', status: 'blocked', at: NOW - 5 * 60e3 });
    assert.equal(hook.main(json({ pane_id: '../x', agent_status: 'idle' })), null, 'a bad pane id writes nothing');
    assert.equal(hook.main({ HERDR_PLUGIN_EVENT_JSON: 'not json' }), null);
    assert.equal(hook.main({}), null);
    const ev = require('../src/state').readJson(require('../src/state').eventFile('w1:p1'));

    // A board that just started knows the exact start from the event.
    const mem = { tags: {}, status: {} };
    const a = { pane_id: 'w1:p1', agent_status: 'blocked', state_change_seq: 4 };
    assert.deepEqual(board.trackStatus(mem, a, NOW, ev), { status: 'blocked', seq: 4, since: NOW - 5 * 60e3, exact: true, seen: NOW });
    // An event for an older status is ignored.
    const b = board.trackStatus({ tags: {}, status: {} }, { ...a, agent_status: 'idle' }, NOW, ev);
    assert.equal(b.exact, false);

    // Pruning drops a closed pane's event after the grace.
    const { pruneReports } = require('../src/report');
    pruneReports(new Set(['w1:p1']), NOW + 120e3);
    assert.ok(fs.existsSync(require('../src/state').eventFile('w1:p1')), 'live pane keeps its event');
    pruneReports(new Set(), NOW + 120e3);
    assert.ok(!fs.existsSync(require('../src/state').eventFile('w1:p1')), 'closed pane loses it');
  } finally {
    if (saved === undefined) delete process.env.CREW_BOARD_STATE_DIR;
    else process.env.CREW_BOARD_STATE_DIR = saved;
  }
});

test('editedLabel keeps the label name and the row colour tag', () => {
  assert.equal(board.editedLabel({ label: '🟩 api · old', labelName: 'api', name: 'x', tag: '🟩' }, ' new  task '), '🟩 api · new task');
  assert.equal(board.editedLabel({ label: 'docs · old', labelName: 'docs', name: 'd', tag: '🟦' }, ''), '🟦 docs');
  assert.equal(board.editedLabel({ label: null, labelName: null, name: 'helper', tag: '🟨' }, 'first task'), '🟨 helper · first task');
  // A legacy mark in the label migrates to the row's assigned tag.
  assert.equal(board.editedLabel({ label: '⬛ api · old', labelName: 'api', name: 'api', tag: '🔷' }, 'new'), '🔷 api · new');
});

test('applyTags: label mode adds marks, other modes keep an existing mark', async () => {
  const herdr = require('../src/herdr');
  const calls = [];
  const saved = { renamePane: herdr.renamePane, setDisplayAgent: herdr.setDisplayAgent, clearDisplayAgent: herdr.clearDisplayAgent, setTokens: herdr.setTokens, clearTokens: herdr.clearTokens };
  herdr.renamePane = async (id, label) => calls.push(['rename', id, label]);
  herdr.setDisplayAgent = async (id, t) => calls.push(['display', id, t]);
  herdr.clearDisplayAgent = async (id) => calls.push(['clear', id]);
  herdr.setTokens = async () => {};
  herdr.clearTokens = async () => {};
  try {
    const rows = [
      { paneId: 'w1:p1', label: 'docs · x', tag: '🟦', kind: 'claude', crew: null },
      { paneId: 'w1:p2', label: '🟩 api · y', tag: '🟩', kind: 'claude', crew: null },
      { paneId: 'w1:p3', label: null, tag: '🟨', kind: 'agy', crew: null },
    ];
    const memo = { renamed: {}, display: {} };
    await board.applyTags({ rows, tagScope: 'all' }, { tags: 'label' }, memo);
    assert.deepEqual(calls, [['rename', 'w1:p1', '🟦 docs · x'], ['rename', 'w1:p3', '🟨 agy']]);
    calls.length = 0;
    await board.applyTags({ rows, tagScope: 'all' }, { tags: 'metadata' }, { renamed: {}, display: {} });
    assert.deepEqual(calls, [
      ['display', 'w1:p1', '🟦 claude'], ['display', 'w1:p2', '🟩 claude'], ['display', 'w1:p3', '🟨 agy'],
    ].sort((a, b) => a[1].localeCompare(b[1])));
    calls.length = 0;
    await board.applyTags({ rows, tagScope: 'all' }, { tags: 'off' }, { renamed: {}, display: { 'w1:p3': '🟨 agy' } });
    assert.deepEqual(calls, [['clear', 'w1:p3']]);
  } finally {
    Object.assign(herdr, saved);
  }
});

test('parseArgs', () => {
  assert.equal(board.parseArgs(['--tags', 'off']).tags, 'off');
  assert.throws(() => board.parseArgs(['--tags', 'rainbow']), /tags must be/);
  assert.equal(board.parseArgs(['--interval', '0.1']).interval, 2);
  assert.throws(() => board.parseArgs(['--nope']), /unknown option/);
  assert.equal(board.parseArgs(['--view', 'wrap']).view, 'wrap');
  assert.equal(board.parseArgs([]).view, 'auto');
  assert.equal(board.parseArgs([]).scope, 'all');
  assert.equal(board.parseArgs(['--here']).scope, 'here');
  assert.ok(board.parseArgs(['--tags', 'off']).set.has('tags'));
  assert.throws(() => board.parseArgs(['--view', 'grid']), /--view must be/);
  assert.equal(board.parseArgs(['--tags-scope', 'all']).tagScope, 'all');
  assert.throws(() => board.parseArgs(['--tags-scope', 'everything']), /--tags-scope must be/);
  assert.equal(board.parseArgs(['--json-rows']).jsonRows, true);
  assert.equal(board.parseArgs(['--json-rows']).json, false);
  assert.equal(board.parseArgs(['--json', '--json-rows']).json, false);
  assert.equal(board.parseArgs(['--json', '--json-rows']).jsonRows, true);
  assert.equal(board.parseArgs(['--json-rows', '--json']).json, true);
  assert.equal(board.parseArgs(['--json-rows', '--json']).jsonRows, false);
});

test('toggle: open, focus, or close the board in the current tab', () => {
  const agent = { pane_id: 'w1:p1', tab_id: 't1', agent: 'claude', focused: true };
  const boardPane = { pane_id: 'w1:p5', tab_id: 't1', label: '🐓ROOSTR🐓', terminal_title_stripped: '🐓ROOSTR🐓' };
  const other = { pane_id: 'w2:p5', tab_id: 't2', label: 'crew-board' };
  assert.deepEqual(decide([agent]), { action: 'open' });
  assert.deepEqual(decide([agent, other]), { action: 'open' });
  assert.deepEqual(decide([agent, boardPane]), { action: 'focus', pane: 'w1:p5' });
  assert.deepEqual(decide([{ ...agent, focused: false }, { ...boardPane, focused: true }]), { action: 'close', pane: 'w1:p5' });
  assert.deepEqual(decide([]), { action: 'open' });
  // An older board label still counts.
  assert.deepEqual(decide([{ ...boardPane, label: 'crew-board', terminal_title_stripped: 'crew-board' }]), { action: 'open' });
  // An agent pane someone labelled "crew-board" is not the board.
  assert.deepEqual(decide([{ ...agent, label: 'crew-board' }]), { action: 'open' });
});

test('banner: blocked panes, panes over budget, today over the daily budget', () => {
  const input = sample();
  const m = board.buildModel({ ...input, reports: { ...input.reports, 'w1:p1': { ...input.reports['w1:p1'], cost: 6.5 } }, budget: 5 });
  assert.equal(m.rows.find((r) => r.paneId === 'w1:p1').budget, 5);
  assert.deepEqual(board.banner(m), [
    { kind: 'blocked', text: '◼ 1 BLOCKED: copy 30s' },
    { kind: 'budget', text: '$ 1 OVER BUDGET: docs $6.50/$5.00' },
  ]);
  m.dailyBudget = 40;
  m.tokscale = { total: 41.2, at: NOW, sessions: {} };
  assert.deepEqual(board.banner(m).map((a) => a.kind), ['blocked', 'budget', 'daily']);
  assert.equal(board.banner(m)[2].text, '$ TODAY $41.20/$40.00');
  ui.setColor(false);
  const out = board.render(m, { width: 118 });
  assert.match(out.split('\n')[2], /^◼ 1 BLOCKED: copy 30s │ \$ 1 OVER BUDGET: docs \$6\.50\/\$5\.00/);
  assert.match(out, /today \$41\.20 · via tokscale/);
  const calm = board.buildModel({ ...sample(), mem: { tags: {}, status: {} }, snap: { ...input.snap, agents: input.snap.agents.slice(1) } });
  assert.deepEqual(board.banner({ ...calm, rows: calm.rows.filter((r) => r.status !== 'blocked') }), []);
});

test('budgets: amber from 80%, red at 100%, crew pane budget wins', () => {
  assert.equal(board.budgetState(null, 5), null);
  assert.equal(board.budgetState(3.9, 5), null);
  assert.equal(board.budgetState(4, 5), 'near');
  assert.equal(board.budgetState(5, 5), 'over');
  assert.equal(board.budgetState(9, null), null);
  const crew = toCrew(parseToml('[board]\nbudget = 3\ndaily_budget = 40\n[[pane]]\nname = "docs"\nbudget = 1.5\n'), '/p/.crew-board.toml');
  assert.equal(crew.budget, 3);
  assert.equal(crew.dailyBudget, 40);
  assert.equal(crew.panes.docs.budget, 1.5);
  assert.equal(toCrew(parseToml('[board]\nbudget = -2\n'), '/p/x').budget, null);
  const input = sample();
  crew.hash = 'h';
  const m = board.buildModel({ ...input, crewFor: () => crew, trust: { [crew.file]: 'h' }, budget: 9 });
  const row = (id) => m.rows.find((r) => r.paneId === id);
  assert.equal(row('w1:p1').budget, 1.5, 'pane budget');
  assert.equal(row('w1:p2').budget, 9, '--budget before the crew default');
  assert.equal(m.dailyBudget, 40);
  assert.equal(board.buildModel({ ...input, crewFor: () => crew, trust: { [crew.file]: 'h' } }).rows.find((r) => r.paneId === 'w1:p2').budget, 3);
  assert.equal(board.buildModel({ ...input, crewFor: () => crew }).rows.find((r) => r.paneId === 'w1:p2').budget, null, 'untrusted crew budget is ignored');
  assert.throws(() => board.parseArgs(['--budget', '0']), /positive/);
  assert.equal(board.parseArgs(['--budget', '2.5']).budget, 2.5);
});

test('trust: a crew file you have not allowed runs no checks and says so', () => {
  const input = sample();
  const m = board.buildModel({ ...input, trust: {} });
  assert.deepEqual(m.checkList, []);
  assert.deepEqual(m.crewChecks, []);
  assert.equal(m.untrusted.length, 1);
  assert.ok(m.rows.find((r) => r.paneId === 'w1:p1').badges.every((b) => b.kind !== 'check'));
  ui.setColor(false);
  const hits = [];
  const out = board.render(m, { width: 160, menu: { tags: 'tokens', view: 'auto', scope: 'all', trust: true }, hits });
  assert.match(out, /^crew file new or changed, off until you allow it: press a \(or click\) to allow · \//m);
  assert.ok(hits.some((h) => h.action === 'trust'));
  assert.match(board.render(m, { width: 160 }), /open (roostr|crew-board) and press a to allow/);
  // A changed file has a new hash: the old grant no longer counts.
  assert.equal(board.buildModel({ ...input, trust: { [m.crews[0].file]: 'old' } }).untrusted.length, 1);
  // A crew file without checks has nothing to allow.
  const quiet = toCrew(parseToml('name = "q"\n'), '/q/.crew-board.toml');
  quiet.hash = 'x';
  assert.deepEqual(board.buildModel({ ...input, crewFor: () => quiet, trust: {} }).untrusted, []);
});

test('trustCrews: records the hash, loadCrew hashes the content', () => {
  const f = path.join(stateDir, 'proj', '.crew-board.toml');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '[[check]]\nname = "A"\nrun = "true"\n');
  const { loadCrew } = require('../src/crewfile');
  const c = loadCrew(f);
  assert.match(c.hash, /^[0-9a-f]{64}$/);
  fs.writeFileSync(path.join(stateDir, 'trust.json'), JSON.stringify({ '/gone/.crew-board.toml': 'x' }));
  board.trustCrews([c]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, 'trust.json'), 'utf8')), { [f]: c.hash }, 'grants for missing files go');
  fs.writeFileSync(f, '[[check]]\nname = "A"\nrun = "false"\n');
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  assert.notEqual(loadCrew(f).hash, c.hash);
});

test('render: the frame always fits the pane height', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const variants = [
    ['plain', {}],
    ['detail', { selected: 0, detail: true }],
    ['help', { menu: { tags: 'off', view: 'auto', scope: 'all' }, help: true }],
  ];
  for (const width of [40, 80]) {
    for (const height of [1, 2, 5, 8, 10, 12, 24]) {
      for (const [name, opts] of variants) {
        const hits = [];
        const out = board.render(m, { width, height, hits, ...opts });
        const lines = out.split('\n');
        const where = `${width}x${height} ${name}`;
        assert.ok(lines.length <= height, `${where}: ${lines.length} lines`);
        assert.match(lines[lines.length - 1], /panes/, `${where}: footer is last`);
        if (height >= 2) assert.ok(lines[0].startsWith('example crew'), `${where}: status bar is first`);
        for (const h of hits) {
          assert.ok(h.y < lines.length, `${where}: hit y ${h.y}`);
          assert.ok(h.x1 < width, `${where}: hit x1 ${h.x1}`);
        }
      }
    }
  }
  const hits = [];
  const out = board.render(m, { width: 80, height: 24, selected: 0, detail: true, hits }).split('\n');
  const top = out.findIndex((l) => l.startsWith('── docs '));
  assert.ok(top > 0, 'box header');
  const box = out.slice(top, top + 8);
  assert.ok(box.some((l) => /^  agent/.test(l)), 'agent stays');
  assert.ok(box.some((l) => /^  task  write the API guide$/.test(l)), 'task stays');
  assert.ok(box.some((l) => /^  now/.test(l)), 'now stays');
});

test('render: provider, help sources and crew check names cannot smuggle escapes', () => {
  const m = board.buildModel(sample());
  m.limits = [
    { source: 'claude', windows: [{ name: '5h', used: 10, resets: null }] },
    { source: 'agy \x1b[2Jx', windows: [{ name: '5h', used: 20, resets: null }] },
  ];
  m.crewChecks = [{ name: 'EVIL\x1b[2J\nX', state: true }];
  const clean = board.buildModel(sample());
  clean.limits = [
    { source: 'claude', windows: [{ name: '5h', used: 10, resets: null }] },
    { source: 'agy x', windows: [{ name: '5h', used: 20, resets: null }] },
  ];
  clean.crewChecks = [{ name: 'EVILX', state: true }];
  const menu = { tags: 'off', view: 'auto', scope: 'all', provider: 'agy \x1b[2Jx' };
  const goodMenu = { ...menu, provider: 'agy x' };
  ui.setColor(false);
  const plain = board.render(m, { width: 200, menu });
  const help = board.render(m, { width: 200, menu, help: true });
  assert.ok(!plain.includes('\x1b[2J'));
  assert.ok(!help.includes('\x1b[2J'));
  assert.equal(plain.split('\n').length, board.render(clean, { width: 200, menu: goodMenu }).split('\n').length);
  assert.equal(help.split('\n').length, board.render(clean, { width: 200, menu: goodMenu, help: true }).split('\n').length);
});

test('render: the selected row stays visible without colour', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const selected = board.render(m, { width: 118, selected: 1 }).split('\n').filter((l) => l.includes('\x1b[7m'));
  assert.equal(selected.length, 1);
  assert.match(ui.stripAnsi(selected[0]), / api /);
  assert.ok(!board.render(m, { width: 118, selected: -1 }).includes('\x1b[7m'));
});

test('trust: an unallowed crew contributes only its name', () => {
  const crew = toCrew(parseToml(`
name = "gated crew"
[board]
tags = "label"
budget = 4
daily_budget = 30
[[check]]
name = "CREW CHECK"
run = "true"
[[pane]]
name = "docs"
model = "crew-docs"
report = "agents/docs/report.md"
budget = 2
checks = ["GREEN: true"]
[[pane]]
name = "tests"
model = "crew-tests"
`), path.join(proj, '.crew-board.toml'));
  crew.hash = 'h';
  const input = { ...sample(), crewFor: () => crew, trust: {} };
  const m = board.buildModel(input);
  const row = (id) => m.rows.find((r) => r.paneId === id);
  assert.equal(row('w1:p1').budget, null);
  assert.equal(row('w1:p1').crewTags, null);
  assert.ok(!row('w1:p1').badges.some((b) => b.kind === 'report' || b.kind === 'check'));
  assert.notEqual(row('w1:p3').model.v, 'crew-tests', 'no crew model');
  assert.notEqual(row('w1:p3').model.src, 'crew');
  assert.equal(m.dailyBudget, null);
  assert.deepEqual(m.checkList, []);
  assert.equal(m.untrusted.length, 1);
  assert.equal(m.crews[0].name, 'gated crew', 'the name still shows');

  const t = board.buildModel({ ...input, trust: { [crew.file]: 'h' } });
  const trow = (id) => t.rows.find((r) => r.paneId === id);
  assert.equal(trow('w1:p1').budget, 2);
  assert.equal(trow('w1:p1').crewTags, 'label');
  assert.ok(trow('w1:p1').badges.some((b) => b.name === 'REPORT READY'));
  assert.deepEqual(trow('w1:p3').model, { v: 'crew-tests', src: 'crew' });
  assert.equal(t.dailyBudget, 30);
  assert.equal(t.untrusted.length, 0);

  // Only a name: there is nothing to allow.
  const quiet = toCrew(parseToml('name = "quiet"\n'), '/q/.crew-board.toml');
  quiet.hash = 'x';
  assert.deepEqual(board.buildModel({ ...input, crewFor: () => quiet, trust: {} }).untrusted, []);
});

test('--crew: a file others can write is refused before drawing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-crew-'));
  const file = path.join(dir, 'crew.toml');
  fs.writeFileSync(file, 'name = "x"\n', { mode: 0o644 });
  fs.chmodSync(file, 0o666);
  let err = '';
  const saved = process.stderr.write;
  process.stderr.write = (s) => {
    err += s;
    return true;
  };
  try {
    assert.equal(await board.main(['--crew', file]), 2);
  } finally {
    process.stderr.write = saved;
    fs.chmodSync(file, 0o666);
  }
  assert.match(err, /^(roostr|crew-board): .*crew\.toml must be owned by you and not writable by group or others \(chmod go-w .*crew\.toml\)$/m);
  const { safeToRun } = require('../src/crewfile');
  assert.equal(safeToRun(file), false);
  fs.chmodSync(file, 0o644);
  assert.equal(safeToRun(file), true, 'a private file loads as before');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pane checks with unknown state show a dim ? badge', async () => {
  const crew = toCrew(parseToml(`
[[pane]]
name = "docs"
checks = ["BUILD: node --version"]
`), path.join(proj, '.crew-board.toml'));
  crew.hash = 'h';
  const input = { ...sample(), crewFor: () => crew, trust: { [crew.file]: 'h' } };
  let m = board.buildModel(input);
  let row = m.rows.find((r) => r.paneId === 'w1:p1');
  assert.deepEqual(row.badges.find((b) => b.name === 'BUILD'), { name: 'BUILD', kind: 'unknown' });
  ui.setColor(false);
  assert.match(board.render(m, { width: 120 }), /\? BUILD/);

  await checks.refresh(m.checkList);
  m = board.buildModel(input);
  row = m.rows.find((r) => r.paneId === 'w1:p1');
  assert.deepEqual(row.badges.find((b) => b.name === 'BUILD'), { name: 'BUILD', kind: 'check' });
  assert.match(board.render(m, { width: 120 }), / BUILD /);
  assert.doesNotMatch(board.render(m, { width: 120 }), /\? BUILD/);
});

test('HELP uses the report command usage so the two cannot drift', () => {
  const report = require('../src/report');
  assert.ok(board.HELP.includes(report.USAGE.replace(/^usage: /, '')));
  assert.match(board.HELP, /--task T/);
});

test('today view: share bar, hours stacked by agent, agents and top sessions', () => {
  const tokscale = require('../src/tokscale');
  const m = board.buildModel(sample());
  ui.setColor(false);
  m.rows[0].session = 'sess-docs';
  m.now = new Date(2026, 9, 23, 3, 30).getTime();
  m.tokscale = tokscale.parse(JSON.stringify({
    totalCost: 4,
    entries: [
      { client: 'claude', sessionId: 'sess-docs', input: 100, output: 50, cacheRead: 600, cacheWrite: 0, cost: 3 },
      { client: 'opencode', sessionId: 'sess-other', input: 200, output: 50, cacheRead: 0, cacheWrite: 0, cost: 1 },
    ],
  }), m.now - 60000);
  m.hourly = { at: m.now, hours: { '02': { claude: { tokens: 750, cost: 3 }, opencode: { tokens: 250, cost: 1 } } } };
  const out = board.render(m, { width: 100, menu: { tags: 'off', view: 'auto', scope: 'all' }, today: true }).split('\n');
  const at = (re) => out.findIndex((l) => re.test(l));
  assert.match(out[at(/^today /)], /^today  1K tokens · \$4\.00 · 2 sessions +by tokens · via tokscale · 1m ago$/);
  const bar = out[at(/^today /) + 3];
  assert.equal((bar.match(/█/g) || []).length, 96, 'the share bar fills the width');
  assert.match(out[at(/■ claude 75%/)], /■ opencode 25%/);
  const labels = out[at(/^  00 /)];
  assert.match(labels, /^  00 01 02 03/, 'one column per hour so far');
  assert.ok(out.slice(at(/■ claude 75%/), at(/^  00 /)).join('\n').includes('█'), 'the 02 column has a bar');
  assert.match(out[at(/^  ■ claude +750/)], /750 +\$3\.00  1 session +in 100 · out 50 · cache 600$/);
  assert.match(out[at(/top sessions/) + 1], /^  docs +claude +750 +\$3\.00$/, 'a session named after its pane');
  assert.match(out[at(/top sessions/) + 2], /^  session sess-oth +opencode/);
  const cost = board.render(m, { width: 100, menu: { tags: 'off', view: 'auto', scope: 'all' }, today: true, metric: 'cost' });
  assert.match(cost, /by cost/);
  assert.doesNotMatch(board.render(m, { width: 100 }), /^today /m, 'off unless asked');
});

test('today view without tokscale: the open panes per agent kind, and a pointer', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  m.tokscale = null;
  const out = board.render(m, { width: 100, menu: { tags: 'off', view: 'auto', scope: 'all' }, today: true });
  assert.match(out, /open panes only/);
  assert.match(out, /need tokscale: github\.com\/junhoyeo\/tokscale/);
  assert.doesNotMatch(out, /top sessions/);
  assert.doesNotMatch(out, /^  model +agents +tokens/m, 'no model table without tokscale');
  assert.doesNotMatch(out, /Opus 5\.5|Sonnet 5\.5/, 'no model bar without tokscale');
});

test('detail box: today\'s in, out and cache from tokscale for a pane that reports its session', () => {
  const tokscale = require('../src/tokscale');
  const m = board.buildModel(sample());
  ui.setColor(false);
  m.rows[0].session = 'sess-docs';
  m.tokscale = tokscale.parse(JSON.stringify({ totalCost: 3, entries: [
    { client: 'claude', sessionId: 'sess-docs', input: 1200, output: 300, cacheRead: 50000, cacheWrite: 1000, cost: 3 },
  ] }), m.now);
  const out = board.render(m, { width: 120, height: 40, selected: 0, detail: true });
  assert.match(out, /^  today in 1\.2K · out 300 · cache 51K · \$3\.00  via tokscale$/m);
});

test('menu: a newer release shows as a clickable item with its key', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const hits = [];
  const out = board.render(m, { width: 220, menu: { tags: 'off', view: 'auto', scope: 'all', update: '⬆ v0.1.1 · u' }, hits }).split('\n');
  assert.match(out[1], /\[⬆ v0\.1\.1 · u\] \[\? keys\]/);
  assert.match(out[1], /u \? q$/);
  assert.ok(hits.some((h) => h.action === 'update'));
  assert.deepEqual(board.parseArgs(['--no-update-check']).noUpdateCheck, true);
});

test('today pace: last three clock hours, projected to midnight, with a budget', () => {
  const tokscale = require('../src/tokscale');
  const m = board.buildModel(sample());
  ui.setColor(false);
  m.now = new Date(2026, 9, 23, 15, 30).getTime();
  m.tokscale = tokscale.parse(JSON.stringify({
    totalCost: 40,
    entries: [{ client: 'claude', sessionId: 's1', model: 'claude-opus-5-5', input: 1, cost: 40 }],
  }), m.now);
  m.hourly = {
    at: m.now,
    hours: {
      13: { claude: { tokens: 100, cost: 3 } },
      14: { claude: { tokens: 100, cost: 3 } },
      15: { claude: { tokens: 100, cost: 3 } },
    },
  };
  m.dailyBudget = 100;
  const out = board.render(m, { width: 140, menu: { tags: 'off', view: 'auto', scope: 'all' }, today: true, metric: 'cost' });
  assert.match(out, /^  \$3\.60\/h over the last 3 hours · on pace for \$70\.60 by midnight · budget \$100$/m);
});

test('today pace: before 03:00 the window starts at midnight', () => {
  const tokscale = require('../src/tokscale');
  const m = board.buildModel(sample());
  ui.setColor(false);
  m.now = new Date(2026, 9, 23, 1, 30).getTime();
  m.tokscale = tokscale.parse(JSON.stringify({
    totalCost: 2,
    entries: [{ client: 'claude', sessionId: 's1', model: 'claude-opus-5-5', input: 1, cost: 2 }],
  }), m.now);
  m.hourly = {
    at: m.now,
    hours: {
      0: { claude: { tokens: 100, cost: 1 } },
      1: { claude: { tokens: 100, cost: 1 } },
    },
  };
  const out = board.render(m, { width: 120, menu: { tags: 'off', view: 'auto', scope: 'all' }, today: true, metric: 'cost' });
  assert.match(out, /since 00:00/);
  assert.doesNotMatch(out, /over the last 3 hours/);
});

test('today pace: a projection over the daily budget is amber', () => {
  const tokscale = require('../src/tokscale');
  const m = board.buildModel(sample());
  m.now = new Date(2026, 9, 23, 15, 30).getTime();
  m.tokscale = tokscale.parse(JSON.stringify({
    totalCost: 40,
    entries: [{ client: 'claude', sessionId: 's1', model: 'claude-opus-5-5', input: 1, cost: 40 }],
  }), m.now);
  m.hourly = {
    at: m.now,
    hours: {
      13: { claude: { tokens: 100, cost: 3 } },
      14: { claude: { tokens: 100, cost: 3 } },
      15: { claude: { tokens: 100, cost: 3 } },
    },
  };
  m.dailyBudget = 50;
  ui.setColor(true);
  const line = board.render(m, { width: 140, menu: { tags: 'off', view: 'auto', scope: 'all' }, today: true, metric: 'cost' })
    .split('\n').find((l) => /on pace for/.test(l));
  assert.ok(line.includes('\x1b[38;5;214m'));
  ui.setColor(false);
});

test('today pace: no hourly data yet means no pace line', () => {
  const tokscale = require('../src/tokscale');
  const m = board.buildModel(sample());
  ui.setColor(false);
  m.tokscale = tokscale.parse(JSON.stringify({
    totalCost: 2,
    entries: [{ client: 'claude', sessionId: 's1', model: 'claude-opus-5-5', input: 1, cost: 2 }],
  }), m.now);
  m.hourly = null;
  const out = board.render(m, { width: 120, menu: { tags: 'off', view: 'auto', scope: 'all' }, today: true, metric: 'cost' });
  assert.doesNotMatch(out, /on pace for|nothing over|nothing since/);
});

const MODELS_MENU = { tags: 'off', view: 'auto', scope: 'all' };

function modelsModel() {
  const tokscale = require('../src/tokscale');
  const m = board.buildModel(sample());
  ui.setColor(false);
  m.now = new Date(2026, 9, 23, 15, 30).getTime();
  m.tokscale = tokscale.parse(JSON.stringify({
    totalCost: 37.2,
    entries: [
      { client: 'claude', sessionId: 's1', model: 'claude-opus-5-5', input: 1000, output: 500, cacheRead: 4000, cost: 20 },
      { client: 'claude', sessionId: 's2', model: 'claude-opus-5-5', input: 500, cost: 11.2 },
      { client: 'opencode', sessionId: 's3', model: 'claude-opus-5-5', input: 2000, cost: 5 },
      { client: 'claude', sessionId: 's4', model: 'claude-sonnet-5-5', input: 50000, cost: 1 },
    ],
  }), m.now);
  m.hourly = null;
  return m;
}

test('today models: share bar and table follow the metric, clients and sessions per model', () => {
  const m = modelsModel();
  const out = board.render(m, { width: 100, menu: MODELS_MENU, today: true }).split('\n');
  const at = (re) => out.findIndex((l) => re.test(l));
  assert.match(out[at(/■ Sonnet 5\.5 86%/)], /■ Sonnet 5\.5 86%   ■ Opus 5\.5 14%/, 'models sorted by tokens');
  const head = at(/^  model +agents +tokens +cost +sessions +in +out +cache$/);
  assert.ok(head >= 0, 'the table has a header');
  assert.match(out[head + 1], /^  Sonnet 5\.5/, 'tokens: Sonnet first');
  assert.match(out[head + 2], /^  Opus 5\.5 +claude, opencode/, 'the clients that used a model');
  assert.match(out[head + 2], /  3 .*3\.5K/, 'sessions counted once per model');

  const cost = board.render(m, { width: 100, menu: MODELS_MENU, today: true, metric: 'cost' }).split('\n');
  const costAt = (re) => cost.findIndex((l) => re.test(l));
  assert.match(cost[costAt(/■ Opus 5\.5 97%/)], /■ Opus 5\.5 97%   ■ Sonnet 5\.5 3%/, 'models sorted by cost');
  const costHead = costAt(/^  model +agents +tokens +cost +sessions/);
  assert.match(cost[costHead + 1], /^  Opus 5\.5/, 'cost: Opus first');
  assert.match(cost[costHead + 2], /^  Sonnet 5\.5/, 'cost: Sonnet second');
});

test('today models: the table and legend fit narrow and wide panes', () => {
  const m = modelsModel();
  for (const width of [60, 120]) {
    const out = board.render(m, { width, menu: MODELS_MENU, today: true }).split('\n');
    for (const line of out) assert.ok(ui.strWidth(line) <= width, `${width}: ${ui.stripAnsi(line)}`);
    assert.ok(out.some((l) => /^  model +agents +tokens +cost +sessions/.test(l)), `${width}: table shown`);
    assert.ok(out.some((l) => /■ Sonnet 5\.5 86%/.test(l)), `${width}: legend shown`);
  }
});

test('today models: more than eight models ends with a dim +N more line', () => {
  const tokscale = require('../src/tokscale');
  const m = board.buildModel(sample());
  ui.setColor(false);
  m.now = new Date(2026, 9, 23, 15, 30).getTime();
  m.tokscale = tokscale.parse(JSON.stringify({
    totalCost: 66,
    entries: Array.from({ length: 11 }, (_, i) => ({
      client: 'claude', sessionId: `s${i}`, model: `m${i + 1}`, input: 100 * (i + 1), cost: 6,
    })),
  }), m.now);
  m.hourly = null;
  const out = board.render(m, { width: 120, menu: MODELS_MENU, today: true }).split('\n');
  const head = out.findIndex((l) => /^  model +agents +tokens/.test(l));
  assert.ok(head >= 0);
  const more = out.findIndex((l) => /^  \+3 more$/.test(l));
  assert.ok(more > head, 'three of eleven models are not in the table');
  assert.equal(more - head - 1, 8, 'the table shows eight models');
  assert.doesNotMatch(out.slice(head, more).join('\n'), /\bm1\b|\bm2\b|\bm3\b/);
});

test('today pace: an empty window says nothing in the last 3 hours', () => {
  const tokscale = require('../src/tokscale');
  const m = board.buildModel(sample());
  ui.setColor(false);
  m.now = new Date(2026, 9, 23, 15, 30).getTime();
  m.tokscale = tokscale.parse(JSON.stringify({
    totalCost: 40,
    entries: [{ client: 'claude', sessionId: 's1', model: 'claude-opus-5-5', input: 1, cost: 40 }],
  }), m.now);
  m.hourly = { at: m.now, hours: { 13: { claude: { tokens: 0, cost: 0 } } } };
  const out = board.render(m, { width: 140, menu: { tags: 'off', view: 'auto', scope: 'all' }, today: true, metric: 'cost' });
  assert.match(out, /^  nothing in the last 3 hours$/m);
});

test('render: clicking on id column registers copy-id hit region', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const hits = [];
  board.render(m, { width: 120, menu: { tags: 'off', view: 'auto', scope: 'all' }, hits });
  const copyHits = hits.filter((h) => h.action === 'copy-id');
  assert.equal(copyHits.length, m.rows.length);
  for (const h of copyHits) {
    assert.ok(h.paneId);
    assert.ok(h.x0 >= 0 && h.x1 >= h.x0);
  }

  // Name and state columns register jump hit regions
  const jumpHits = hits.filter((h) => h.action === 'jump');
  assert.ok(jumpHits.length >= m.rows.length * 2, 'at least name and state per row register jump');
  for (const h of jumpHits) {
    assert.ok(h.paneId);
    assert.equal(typeof h.index, 'number');
    assert.ok(h.x0 >= 0 && h.x1 >= h.x0);
  }
});

test('buildModel: unnamed agent uses pane id as handle and marks isNamed false', () => {
  const snap = {
    agents: [
      { pane_id: 'w1:p9', agent: 'claude', workspace_id: 'w1', tab_id: 't1' },
      { pane_id: 'w1:p8', agent: 'opencode', workspace_id: 'w1', tab_id: 't1' },
    ],
    panes: [
      { pane_id: 'w1:p9', cwd: '/tmp', workspace_id: 'w1', tab_id: 't1' },
      { pane_id: 'w1:p8', cwd: '/tmp', workspace_id: 'w1', tab_id: 't1', label: 'opencode' },
    ],
    tabs: [{ tab_id: 't1', workspace_id: 'w1' }],
    workspaces: [{ workspace_id: 'w1', label: 'w1' }],
  };
  const m = board.buildModel({
    snap,
    agents: snap.agents,
    screens: {},
    reports: {},
    events: {},
    rss: {},
    crewFor: () => null,
    trust: {},
    mem: { tags: {}, status: {} },
    now: 1000,
  });
  assert.equal(m.rows[0].name, 'w1:p9');
  assert.equal(m.rows[0].isNamed, false);
  assert.equal(m.rows[1].name, 'opencode');
  assert.equal(m.rows[1].isNamed, false);
});

test('detailBox: includes copy id button and hit region', () => {
  const r = {
    name: 'w1:p5',
    isNamed: false,
    paneId: 'w1:p5',
    kind: 'claude',
    model: { v: null },
    task: null,
    status: 'idle',
    ctx: { v: null },
    tokens: { v: null },
    cost: { v: null },
    ram: { v: null },
    badges: [],
  };
  const box = board.detailBox(r, 100);
  assert.match(box.lines[0], /\[y copy id\]/);
  const copyHit = box.hits.find((h) => h.action === 'copy-id');
  assert.ok(copyHit);
  assert.equal(copyHit.paneId, 'w1:p5');

  const copiedBox = board.detailBox(r, 100, null, 'copied w1:p5');
  assert.match(copiedBox.lines[0], /\[✓ copied\]/);
});

test('provider cycling: supports multiple providers and toggling off', () => {
  const m = board.buildModel(sample());
  m.limits = [
    { source: 'claude', windows: [{ name: '5h', used: 10 }] },
    { source: 'agy gemini', windows: [{ name: '5h', used: 20 }] },
    { source: 'codex', windows: [{ name: '5h', used: 30 }] },
  ];
  const list = board.providers(m.limits);
  assert.deepEqual(list, ['claude', 'agy', 'codex']);
  const choices = [...list, 'off'];
  assert.deepEqual(choices, ['claude', 'agy', 'codex', 'off']);

  assert.equal(board.parseArgs(['--provider', 'off']).provider, 'off');
  assert.equal(board.parseArgs(['--provider', 'agy']).provider, 'agy');

  const claudeOut = board.render(m, { width: 100, height: 30, provider: 'claude' });
  assert.match(claudeOut, /claude  5h/);
  assert.match(claudeOut, /p ▸ agy/);

  const agyOut = board.render(m, { width: 100, height: 30, provider: 'agy' });
  assert.match(agyOut, /agy gemini  5h/);
  assert.match(agyOut, /p ▸ codex/);

  const codexOut = board.render(m, { width: 100, height: 30, provider: 'codex' });
  assert.match(codexOut, /codex  5h/);
  assert.match(codexOut, /p ▸ off/);

  const offOut = board.render(m, { width: 100, height: 30, provider: 'off' });
  assert.doesNotMatch(offOut, /5h ██/);
});

test('loadMemory: tags, status and prefs must be plain objects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-mem-shape-'));
  const saved = process.env.CREW_BOARD_STATE_DIR;
  process.env.CREW_BOARD_STATE_DIR = dir;
  try {
    fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ tags: [], status: 'x', prefs: null }));
    assert.deepEqual(board.loadMemory(), { tags: {}, status: {}, prefs: {} });
    fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ tags: { 'w1:p1': '🟦' }, status: { 'w1:p1': { status: 'idle' } }, prefs: { view: 'line' } }));
    assert.deepEqual(board.loadMemory(), { tags: { 'w1:p1': '🟦' }, status: { 'w1:p1': { status: 'idle' } }, prefs: { view: 'line' } });
  } finally {
    if (saved === undefined) delete process.env.CREW_BOARD_STATE_DIR;
    else process.env.CREW_BOARD_STATE_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveMemory: seen stays in memory, so an unchanged status does not rewrite board.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-mem-seen-'));
  const saved = process.env.CREW_BOARD_STATE_DIR;
  process.env.CREW_BOARD_STATE_DIR = dir;
  try {
    const mem = { tags: {}, status: {}, prefs: {} };
    const a = { pane_id: 'w1:p1', agent_status: 'working', state_change_seq: 1 };
    const live = new Set(['w1:p1']);
    board.trackStatus(mem, a, 1000);
    board.saveMemory(mem, live, live);
    const file = path.join(dir, 'board.json');
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /"seen"/);
    const at = fs.statSync(file).mtimeMs;
    board.trackStatus(mem, a, 2000);
    assert.equal(mem.status['w1:p1'].seen, 2000);
    board.saveMemory(mem, live, live);
    assert.equal(fs.statSync(file).mtimeMs, at, 'only seen changed, so no write');
  } finally {
    if (saved === undefined) delete process.env.CREW_BOARD_STATE_DIR;
    else process.env.CREW_BOARD_STATE_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('crewResolver: --crew is checked again on every load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-crew-'));
  const file = path.join(dir, '.crew-board.toml');
  try {
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o600);
    const load = board.crewResolver({ crew: file });
    assert.ok(load(null), 'a private file loads');
    fs.chmodSync(file, 0o666);
    assert.equal(load(null), null, 'a file made writable by others is refused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildModel: rows carry workspaceId for workspace-safe dispatch', () => {
  const m = board.buildModel(sample());
  assert.equal(m.rows.find((r) => r.paneId === 'w1:p1').workspaceId, 'w1');
  assert.equal(m.rows.find((r) => r.paneId === 'w2:p1').workspaceId, 'w2');
});

test('buildModel: advisor runs once per distinct task, effort and model in a collect', () => {
  const advisor = require('../src/advisor');
  const saved = advisor.recommend;
  let calls = 0;
  advisor.recommend = (...args) => {
    calls++;
    return saved(...args);
  };
  try {
    const snap = {
      workspaces: [{ workspace_id: 'w1', label: 'app' }],
      panes: [
        { pane_id: 'w1:p1', label: 'same · write docs', cwd: proj },
        { pane_id: 'w1:p2', label: 'same · write docs', cwd: proj },
      ],
      agents: [
        { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude' },
        { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude' },
      ],
    };
    const m = board.buildModel({ snap, agents: snap.agents, mem: { tags: {}, status: {} }, now: NOW, crewFor: () => null, trust: {} });
    assert.equal(m.rows.length, 2);
    assert.equal(calls, 1);
  } finally {
    advisor.recommend = saved;
  }
});

test('copyToClipboard: a missing clipboard tool is a no op, not a crash', async () => {
  const child_process = require('child_process');
  const { EventEmitter } = require('node:events');
  const saved = child_process.spawn;
  child_process.spawn = () => {
    const child = new EventEmitter();
    child.stdin = { end() {}, on() {} };
    process.nextTick(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
    return child;
  };
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    assert.doesNotThrow(() => board.copyToClipboard('w1:p9'));
    process.stdout.write = write;
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.stdout.write = write;
    child_process.spawn = saved;
  }
});

test('editChunk: a paste is text, only an exact key is a command', () => {
  assert.deepEqual(board.editChunk('ship it\nnow\x7f'), { action: 'text', text: 'ship it now ' });
  assert.equal(board.editChunk('\r').action, 'save');
  assert.equal(board.editChunk('\n').action, 'save');
  assert.equal(board.editChunk('\x1b').action, 'cancel');
  assert.equal(board.editChunk('\x7f').action, 'backspace');
  assert.equal(board.editChunk('\x1b[A').action, 'ignore');
});

test('applyPrefs: an explicit --subview flag beats remembered sub-views', () => {
  const opts = board.parseArgs(['--subview', 'agy gemini']);
  const mem = { prefs: { subviews: { agy: 'agy other' }, view: 'wrap' } };
  board.applyPrefs(opts, mem);
  assert.equal(opts.subviews, undefined);
  assert.equal(opts.subview, 'agy gemini');
  assert.equal(opts.view, 'wrap', 'unrelated prefs still apply');
  const explicit = board.parseArgs(['--view', 'line']);
  board.applyPrefs(explicit, mem);
  assert.equal(explicit.view, 'line');
});

test('usage limits: Shift+P (P) toggles sub-views inside subscription, condensing to 1 line', () => {
  const m = board.buildModel(sample());
  m.limits = [
    { source: 'agy other', windows: [{ name: '7d', used: 97, resets: null }] },
    { source: 'agy gemini', windows: [{ name: '5h', used: 16, resets: null }] },
    { source: 'agy gemini-argon-wtu', windows: [{ name: '5h', used: 18, resets: null }] },
  ];
  ui.setColor(false);

  assert.deepEqual(board.sourcesOf(m.limits, 'agy'), ['agy other', 'agy gemini', 'agy gemini-argon-wtu']);
  assert.equal(board.parseArgs(['--subview', 'agy gemini']).subview, 'agy gemini');

  // 'all' shows all 3 lines
  const allOut = board.render(m, { width: 100, height: 30, provider: 'agy', subview: 'all' });
  assert.match(allOut, /agy other  7d/);
  assert.match(allOut, /agy gemini  5h/);
  assert.match(allOut, /agy gemini-argon-wtu  5h/);
  assert.match(allOut, /P ▸ other/);

  // Specific subview condenses to only 1 line
  const geminiOut = board.render(m, { width: 100, height: 30, provider: 'agy', subview: 'agy gemini' });
  assert.match(geminiOut, /agy gemini  5h/);
  assert.doesNotMatch(geminiOut, /agy other/);
  assert.doesNotMatch(geminiOut, /agy gemini-argon-wtu/);
  assert.match(geminiOut, /P ▸ gemini-argon-wtu/);

  // Third subview condenses to 1 line and cycles back to all
  const argonOut = board.render(m, { width: 100, height: 30, provider: 'agy', subview: 'agy gemini-argon-wtu' });
  assert.match(argonOut, /agy gemini-argon-wtu  5h/);
  assert.doesNotMatch(argonOut, /agy other/);
  assert.doesNotMatch(argonOut, /agy gemini  5h/);
  assert.match(argonOut, /P ▸ all/);

  // Menu bar reflects active subview
  const menuBarOut = board.render(m, {
    width: 240, height: 30, provider: 'agy', subview: 'agy gemini',
    menu: { tags: 'tokens', view: 'auto', scope: 'all', provider: 'agy', subview: 'agy gemini', hasSubviews: true },
  });
  assert.match(menuBarOut, /\[usage: agy \(gemini\)\]/);
  assert.match(menuBarOut, /p P/);
});

test('menu: orchestrate item has hit region when orchestration enabled', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const hits = [];
  const out = board.render(m, { width: 160, menu: { tags: 'off', view: 'auto', scope: 'all', orchestration: true }, hits }).split('\n');
  assert.match(out[1], /\[O orchestrate\]/);
  assert.ok(hits.some((h) => h.action === 'orchestrate'), 'orchestrate');
});

test('menu: orchestration items are hidden by default', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const hits = [];
  const out = board.render(m, { width: 160, menu: { tags: 'off', view: 'auto', scope: 'all' }, hits }).split('\n');
  assert.doesNotMatch(out[1], /\[O orchestrate\]/);
  assert.ok(!hits.some((h) => h.y === 1 && h.action === 'orchestrate'));
});

test('menu: backups item is visible on the main board and clickable', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const hits = [];
  const out = board.render(m, { width: 160, menu: { tags: 'off', view: 'auto', scope: 'all' }, hits }).split('\n');
  assert.match(out[1], /\[R backups\]/);
  assert.ok(hits.some((h) => h.action === 'backups'));
});

test('help: orchestrate and setup rows are listed when orchestration enabled', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const out = board.render(m, { width: 200, menu: { tags: 'off', view: 'auto', scope: 'all', orchestration: true }, help: true });
  assert.match(out, /  O \/ T +orchestrate: plan, tasks, advisor, analytics, setup/);
  assert.match(out, /  S +setup: tools and preferred models/);
  assert.match(out, /  C +allow or continue the selected stuck pane/);
});

test('help: orchestration rows are hidden by default', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const out = board.render(m, { width: 200, menu: { tags: 'off', view: 'auto', scope: 'all' }, help: true });
  assert.doesNotMatch(out, /  O \/ T +orchestrate:/);
  assert.doesNotMatch(out, /  S +setup:/);
  assert.doesNotMatch(out, /  C +allow or continue/);
});

test('orchestrationEnabled: checks env, options and config', () => {
  const origExp = process.env.ROOSTR_EXPERIMENTAL;
  const origOrch = process.env.ROOSTR_ORCHESTRATION;
  delete process.env.ROOSTR_EXPERIMENTAL;
  delete process.env.ROOSTR_ORCHESTRATION;
  try {
    assert.equal(board.orchestrationEnabled({}, {}), false);
    assert.equal(board.orchestrationEnabled({}, { orchestration: true }), true);
    assert.equal(board.orchestrationEnabled({}, { menu: { orchestration: true } }), true);
    assert.equal(board.orchestrationEnabled({ orchestration: { enabled: true } }, {}), true);
    process.env.ROOSTR_EXPERIMENTAL = '1';
    assert.equal(board.orchestrationEnabled({}, {}), true);
  } finally {
    if (origExp !== undefined) process.env.ROOSTR_EXPERIMENTAL = origExp;
    else delete process.env.ROOSTR_EXPERIMENTAL;
    if (origOrch !== undefined) process.env.ROOSTR_ORCHESTRATION = origOrch;
    else delete process.env.ROOSTR_ORCHESTRATION;
  }
});

test('setup: the screen renders at 80 columns and saves', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-setup-'));
  const saved = process.env.CREW_BOARD_CONFIG;
  const savedSummary = process.env.CREW_BOARD_SUMMARY;
  process.env.CREW_BOARD_CONFIG = path.join(dir, 'config.json');
  process.env.CREW_BOARD_SUMMARY = path.join(dir, 'summary.json');
  try {
    const st = board.setupState(config.defaultConfig());
    const lines = board.setupLines(st, 80);
    assert.ok(lines.length <= 24, `fits 24 rows, got ${lines.length}`);
    for (const line of lines) assert.ok(line.length <= 80);
    assert.ok(lines.some((l) => /\[x\]claude/.test(l)));
    assert.ok(lines.some((l) => /task docs/.test(l)));
    assert.ok(lines.some((l) => /head name/.test(l)));
    assert.ok(lines.some((l) => /language/.test(l)));
    st.row = 3;
    board.setupKey(st, '\x1b[C');
    assert.equal(st.config.headLanguage, 'es');
    board.setupKey(st, '\x1b[D');
    assert.equal(st.config.headLanguage, 'en');
    st.row = board.SETUP_ROWS.indexOf('save');
    assert.deepEqual(board.setupKey(st, '\r'), { save: true });
    assert.equal(board.setupReady(st), true);
    const saved2 = config.saveConfig(st.config);
    assert.equal(fs.existsSync(saved2.path), true);
  } finally {
    if (saved === undefined) delete process.env.CREW_BOARD_CONFIG;
    else process.env.CREW_BOARD_CONFIG = saved;
    if (savedSummary === undefined) delete process.env.CREW_BOARD_SUMMARY;
    else process.env.CREW_BOARD_SUMMARY = savedSummary;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setup: task kind rows edit tool, effort, model and fallbacks', () => {
  const st = board.setupState(config.defaultConfig());
  st.row = board.SETUP_ROWS.indexOf('kind:docs');
  board.setupKey(st, ' ');
  assert.equal(st.config.taskKinds.docs.effort, 'low');
  st.config.tools = ['claude', 'opencode'];
  board.setupKey(st, '\x1b[C');
  assert.equal(st.config.taskKinds.docs.tool, 'claude');
  board.setupKey(st, '\x1b[C');
  assert.equal(st.config.taskKinds.docs.tool, 'opencode');
  assert.equal(board.setupKey(st, 'f'), null);
  assert.equal(st.edit.field, 'task-fallbacks');
  st.edit.text = 'backup-a, backup-b, backup-a';
  board.setupKey(st, '\r');
  assert.deepEqual(st.config.taskKinds.docs.fallbacks, ['backup-a', 'backup-b']);
  board.setupKey(st, '\r');
  assert.equal(st.edit.field, 'task-model');
  st.edit.text = 'docs-primary';
  board.setupKey(st, '\r');
  assert.equal(st.config.taskKinds.docs.model, 'docs-primary');
});

test('setup: a save with no tool is refused', () => {
  const st = board.setupState(config.defaultConfig());
  st.config.tools = [];
  st.config.customTools = [];
  assert.equal(board.setupReady(st), false);
  assert.match(st.error, /select at least one tool/);
});

test('head picker: lists shell panes and asks to confirm', () => {
  const st = { panes: [{ paneId: 'w1:p9', label: 'shell', cwd: '/tmp/app' }], index: 0, confirm: true, starting: false, status: null };
  const out = board.headLines(st, 100).join('\n');
  assert.match(out, /w1:p9/);
  assert.match(out, /y to go/);
});

test('U1: menu bar registers backups and refresh hit regions', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const hits = [];
  board.render(m, { width: 140, menu: { tags: 'off', view: 'auto', scope: 'all' }, hits });
  const backupsHit = hits.find((h) => h.action === 'backups');
  assert.ok(backupsHit, 'backups action present in hits');
  assert.ok(backupsHit.x0 >= 0 && backupsHit.x1 > backupsHit.x0);

  const refreshHit = hits.find((h) => h.action === 'refresh');
  assert.ok(refreshHit, 'refresh action present in hits');
  assert.ok(refreshHit.x0 >= 0 && refreshHit.x1 > refreshHit.x0);
});

test('U1: row status and task clicks register recover, detail, and edit hit regions', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const hits = [];
  board.render(m, { width: 140, menu: { tags: 'off', view: 'auto', scope: 'all', orchestration: true }, hits });

  // Blocked row registers recover action
  const recoverHit = hits.find((h) => h.action === 'recover' && h.paneId === 'w2:p1');
  assert.ok(recoverHit, 'blocked row registers recover hit region');
  assert.equal(typeof recoverHit.index, 'number');

  // Working/idle row registers detail action
  const detailHit = hits.find((h) => h.action === 'detail' && h.paneId === 'w1:p1');
  assert.ok(detailHit, 'active row status registers detail hit region');
  assert.equal(typeof detailHit.index, 'number');

  // Task column registers edit action
  const editHits = hits.filter((h) => h.action === 'edit' && h.paneId);
  assert.ok(editHits.length >= m.rows.length, 'every row task line registers edit hit region');
  for (const eh of editHits) {
    assert.equal(typeof eh.index, 'number');
  }
});

test('U2: today view registers clickable metric and close hit regions', () => {
  const m = board.buildModel(sample());
  m.tokscale = tokscale.parse(JSON.stringify({
    totalCost: 5,
    entries: [{ client: 'claude', sessionId: 's1', model: 'claude-3-5', input: 100, cost: 5 }],
  }), m.now);
  ui.setColor(false);
  const hits = [];
  board.render(m, { width: 120, menu: { tags: 'off', view: 'auto', scope: 'all' }, today: true, hits });

  const metricHits = hits.filter((h) => h.action === 'metric');
  assert.ok(metricHits.length >= 2, 'header and footer metric toggles registered');

  const closeHit = hits.find((h) => h.action === 'today');
  assert.ok(closeHit, 'close today hit region registered');
});

test('U2: footer spend registers clickable today hit region', () => {
  const m = board.buildModel(sample());
  m.tokscale = tokscale.parse(JSON.stringify({
    totalCost: 12.50,
    entries: [{ client: 'claude', sessionId: 's1', model: 'claude-3-5', input: 100, cost: 12.50 }],
  }), m.now);
  ui.setColor(false);
  const hits = [];
  board.render(m, { width: 140, menu: { tags: 'off', view: 'auto', scope: 'all' }, hits });

  const todaySpendHit = hits.find((h) => h.action === 'today');
  assert.ok(todaySpendHit, 'footer spend registers today hit region');
  assert.ok(todaySpendHit.x0 >= 0 && todaySpendHit.x1 > todaySpendHit.x0);
});

test('compaction: context over 50% triggers badge and advice, over 75% alerts in banner', () => {
  const input = sample();
  input.reports['w1:p1'] = { ctx: 52, tokens: 105000, cost: 1.1, model: 'opus' };
  const m50 = board.buildModel(input);
  const row50 = m50.rows.find((r) => r.paneId === 'w1:p1');
  assert.ok(row50.badges.some((b) => b.name === 'COMPACT' && b.level === 'warn'));
  const box50 = board.detailBox(row50, 120);
  assert.ok(box50.lines.some((l) => l.includes('attention dilution risk (52%)')));

  input.reports['w1:p1'] = { ctx: 82, tokens: 165000, cost: 2.1, model: 'opus' };
  const m80 = board.buildModel(input);
  const row80 = m80.rows.find((r) => r.paneId === 'w1:p1');
  assert.ok(row80.badges.some((b) => b.name === 'COMPACT' && b.level === 'high'));
  const alerts = board.banner(m80);
  assert.ok(alerts.some((a) => a.kind === 'compact' && a.text.includes('82%') && a.text.includes('compact recommended')));
  const box80 = board.detailBox(row80, 120);
  assert.ok(box80.lines.some((l) => l.includes('high context (82%)')));
});

test('menu: options item is visible on the main board and clickable', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const hits = [];
  const out = board.render(m, { width: 160, menu: { tags: 'off', view: 'auto', scope: 'all' }, hits }).split('\n');
  assert.match(out[1], /\[o options\]/);
  assert.ok(hits.some((h) => h.action === 'options'));
});

test('help: options row is listed in help screen', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);
  const out = board.render(m, { width: 200, menu: { tags: 'off', view: 'auto', scope: 'all' }, help: true });
  assert.match(out, /  o +options: tokscale, compaction, settings/);
});

test('render: options view shows tokscale, compaction, board settings and paths', () => {
  const input = sample();
  input.reports['w1:p1'] = { ctx: 55, tokens: 110000, cost: 1.2, model: 'claude' };
  const m = board.buildModel(input);
  m.tokscale = { at: Date.now() - 60000, total: 3.45, clients: { claude: {}, opencode: {} } };
  ui.setColor(false);
  const out = board.render(m, { width: 120, menu: { tags: 'tokens', view: 'line', scope: 'here' }, options: true });
  assert.match(out, /TOKSCALE CONNECTION/);
  assert.match(out, /spend today: \$3\.45/);
  assert.match(out, /claude, opencode/);
  assert.match(out, /CONTEXT COMPACTION/);
  assert.match(out, /≥30% notice \(warm\) · ≥50% warn \(dilution\) · ≥75% high · ≥85% critical/);
  assert.match(out, /1 pane\(s\):/);
  assert.match(out, /BOARD SETTINGS/);
  assert.match(out, /tags \(t\) +tokens/);
  assert.match(out, /layout \(v\) +line/);
  assert.match(out, /scope \(s\) +here/);
  assert.match(out, /PATHS & STORAGE/);
  assert.match(out, /backups/);
});

test('parseArgs: --options flag is accepted', () => {
  const o = board.parseArgs(['--options']);
  assert.equal(o.options, true);
});

test('orchestrate TUI: renders 4 tabs, edits tasks.json overrides, cycles analytics, daemon and setup', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-orch-tui-'));
  try {
    const orchDir = path.join(tmp, 'docs', 'orchestration');
    fs.mkdirSync(orchDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs', 'orchestration-plan.md'), '# Plan\n');
    const tasksFile = path.join(orchDir, 'tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify({
      version: 1,
      batchId: 'batch-tui-test',
      tasks: [
        { id: 't1', title: 'Build auth module', kind: 'feature', status: 'pending', brief: 'docs/orchestration/tasks/t1.md', report: 'docs/orchestration/reports/t1.md' },
        { id: 't2', title: 'Review diff', kind: 'review', status: 'pending', brief: 'docs/orchestration/tasks/t2.md', report: 'docs/orchestration/reports/t2.md' },
      ],
    }, null, 2));

    const input = sample();
    input.snap.panes[0].cwd = tmp;
    const m = board.buildModel(input);
    m.home = 'w1';
    ui.setColor(false);

    const st = board.orchestrateState(m, null, [], 'tasks', tmp);
    assert.equal(st.tab, 'tasks');
    assert.ok(st.planDirs.includes(tmp));

    // Render Tab 1 (tasks & advisor) with tasks.json present
    const out1 = board.render(m, { width: 140, orchestrate: st });
    assert.match(out1, /orchestrate +\[1 tasks · advisor\] \[2 analytics · summary\] \[3 daemon · plan\] \[4 setup\]/);
    assert.match(out1, /orchestrator/);
    assert.match(out1, /active plan/);
    assert.match(out1, /TASKS & ADVISOR/);
    assert.match(out1, /t1/);
    assert.match(out1, /feature/);

    // Override effort on t1 via spacebar and verify tasks.json is updated on disk
    board.orchestrateKey(st, ' ', m);
    const savedAfterEffort = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    assert.equal(savedAfterEffort.tasks[0].effort, 'low');

    // Override model on t1 via Enter -> type model -> Enter
    board.orchestrateKey(st, '\r', m);
    assert.ok(st.edit);
    board.orchestrateKey(st, 'claude-sonnet-4-6', m);
    board.orchestrateKey(st, '\r', m);
    assert.equal(st.edit, null);
    const savedAfterModel = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    assert.equal(savedAfterModel.tasks[0].model, 'claude-sonnet-4-6');

    // Switch to Tab 2 (analytics · summary) via '2'
    board.orchestrateKey(st, '2', m);
    assert.equal(st.tab, 'analytics');
    const out2 = board.render(m, { width: 140, orchestrate: st });
    assert.match(out2, /summary\.json:/);
    assert.match(out2, /by \(b\/←→\):/);
    board.orchestrateKey(st, 'b', m);
    assert.equal(st.by, 'pane');
    board.orchestrateKey(st, 'd', m);
    assert.equal(st.windowIndex, 1);

    // Switch to Tab 3 (daemon · plan) via Tab key
    board.orchestrateKey(st, '\t', m);
    assert.equal(st.tab, 'daemon');
    const out3 = board.render(m, { width: 140, orchestrate: st });
    assert.match(out3, /daemon +event-driven/);
    assert.match(out3, /Build auth module/);

    // Switch to Tab 4 (setup) via '4'
    board.orchestrateKey(st, '4', m);
    assert.equal(st.tab, 'setup');
    const out4 = board.render(m, { width: 140, orchestrate: st });
    assert.match(out4, /setup +coding tools and preferred models/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('orchestrate TUI: mouse hit regions for tabs, close, task rows, by and window', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-orch-hits-'));
  try {
    const orchDir = path.join(tmp, 'docs', 'orchestration');
    fs.mkdirSync(orchDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs', 'orchestration-plan.md'), '# Plan\n');
    const tasksFile = path.join(orchDir, 'tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify({
      version: 1,
      batchId: 'batch-hit-test',
      tasks: [
        { id: 't1', title: 'Task one', kind: 'feature', status: 'pending', brief: 'docs/b1.md', report: 'docs/r1.md' },
      ],
    }, null, 2));

    const input = sample();
    input.snap.panes[0].cwd = tmp;
    const m = board.buildModel(input);
    ui.setColor(false);

    const st = board.orchestrateState(m, null, [], 'tasks', tmp);
    const hits1 = [];
    board.render(m, { width: 120, orchestrate: st, hits: hits1 });

    const tabHit = hits1.find((h) => h.action === 'orch-tab' && h.tab === 'tasks');
    assert.ok(tabHit, 'must have orch-tab tasks hit');
    const closeHit = hits1.find((h) => h.action === 'orch-close');
    assert.ok(closeHit, 'must have orch-close hit');
    const rowHit = hits1.find((h) => h.action === 'orch-task-row' && h.index === 0);
    assert.ok(rowHit, 'must have orch-task-row hit');
    const effHit = hits1.find((h) => h.action === 'orch-effort' && h.index === 0);
    assert.ok(effHit, 'must have orch-effort hit');
    const modelHit = hits1.find((h) => h.action === 'orch-model' && h.index === 0);
    assert.ok(modelHit, 'must have orch-model hit');

    // Tab 2 analytics hits
    st.tab = 'analytics';
    const hits2 = [];
    board.render(m, { width: 140, orchestrate: st, hits: hits2 });
    const byHit = hits2.find((h) => h.action === 'orch-by' && h.by === 'model');
    assert.ok(byHit, 'must have orch-by hit');
    const winHit = hits2.find((h) => h.action === 'orch-window' && h.index === 0);
    assert.ok(winHit, 'must have orch-window hit');
    const refHit = hits2.find((h) => h.action === 'orch-refresh-summary');
    assert.ok(refHit, 'must have orch-refresh-summary hit');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('menu: active drawer highlight renders indicator and cyans label', () => {
  const m = board.buildModel(sample());
  ui.setColor(false);

  const outOrch = board.render(m, {
    width: 160,
    menu: { tags: 'off', view: 'auto', scope: 'all', orchestration: true },
    orchestrate: { tab: 'tasks', planDirs: [], planIndex: 0, setup: null },
  }).split('\n');
  assert.match(outOrch[1], /\[▾ O orchestrate\]/);

  const outToday = board.render(m, {
    width: 160,
    menu: { tags: 'off', view: 'auto', scope: 'all', orchestration: true },
    today: true,
  }).split('\n');
  assert.match(outToday[1], /\[▾ d today\]/);

  const outBackups = board.render(m, {
    width: 160,
    menu: { tags: 'off', view: 'auto', scope: 'all', orchestration: true },
    backups: { list: [], sel: 0, ver: 0, confirm: false, status: null, layout: 'even' },
  }).split('\n');
  assert.match(outBackups[1], /\[▾ R backups\]/);
});

test('orchestrate TUI: responsive narrow (80 cols) vs wide (140 cols) layout', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-orch-responsive-'));
  try {
    const orchDir = path.join(tmp, 'docs', 'orchestration');
    fs.mkdirSync(orchDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs', 'orchestration-plan.md'), '# Plan\n');
    const tasksFile = path.join(orchDir, 'tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify({
      version: 1,
      batchId: 'batch-resp-test',
      tasks: [
        { id: 't1', title: 'Implement narrow test', kind: 'feature', status: 'pending', brief: 'docs/b.md', report: 'docs/r.md' },
      ],
    }, null, 2));

    const input = sample();
    input.snap.panes[0].cwd = tmp;
    const m = board.buildModel(input);
    ui.setColor(false);
    const st = board.orchestrateState(m, null, [], 'tasks', tmp);

    // Wide layout: includes tier and conf columns
    const outWide = board.render(m, { width: 140, orchestrate: st });
    assert.match(outWide, /id +st +kind +eff +tier +model +conf +title/);

    // Narrow layout: omits tier and conf columns
    const outNarrow = board.render(m, { width: 80, orchestrate: st });
    assert.match(outNarrow, /id +st +kind +eff +model +title/);
    assert.doesNotMatch(outNarrow, /tier +model +conf/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('orchestrate TUI: delegation share bar in analytics tab', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-orch-gauge-'));
  try {
    const input = sample();
    input.snap.panes[0].cwd = tmp;
    const m = board.buildModel(input);
    // Assign head-honcho role to pane 0 and regular worker role to pane 1
    m.rows[0].role = 'head-honcho';
    m.rows[0].cost = { v: 2.0, src: 'exact' };
    m.rows[1].role = 'worker';
    m.rows[1].cost = { v: 8.0, src: 'exact' };
    ui.setColor(false);

    const st = board.orchestrateState(m, null, [], 'analytics', tmp);
    const out = board.render(m, { width: 140, orchestrate: st });
    assert.match(out, /delegation share: +[█░]+ +80% workers · 20% orchestrator +\(target ≥80% workers\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('orchestrate TUI: pressing c copies spawn command and sets notice', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-orch-copy-'));
  try {
    const orchDir = path.join(tmp, 'docs', 'orchestration');
    fs.mkdirSync(orchDir, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs', 'orchestration-plan.md'), '# Plan\n');
    const tasksFile = path.join(orchDir, 'tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify({
      version: 1,
      batchId: 'batch-copy-test',
      tasks: [
        { id: 't1', title: 'Build login flow', kind: 'feature', status: 'pending', brief: 'docs/b.md', report: 'docs/r.md' },
      ],
    }, null, 2));

    const input = sample();
    input.snap.panes[0].cwd = tmp;
    const m = board.buildModel(input);
    ui.setColor(false);

    const st = board.orchestrateState(m, null, [], 'tasks', tmp);
    assert.equal(st.notice, null);

    board.orchestrateKey(st, 'c', m);
    assert.equal(st.notice, 'copied spawn command for t1');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
