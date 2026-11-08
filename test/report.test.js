'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-state-'));
process.env.CREW_BOARD_STATE_DIR = dir;
const { parseArgs, writeReport, readReport, MAX_AGE_MS } = require('../src/report');
const { validPaneId, paneFile, eventFile } = require('../src/state');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('parseArgs: task value cleaned', () => {
  const p = parseArgs(['--pane', 'w1:p2', '--task', 'ship  the\nguide']);
  assert.deepEqual(p.values, { task: 'ship the guide', taskSource: 'manual' });
});

test('parseArgs: values, empty values skipped, bad values rejected', () => {
  assert.deepEqual(parseArgs(['--pane', 'w1:p2', '--ctx', '17', '--tokens', '136700', '--input', '120000', '--output', '16700', '--cost', '2.02', '--model', 'sonnet']), {
    pane: 'w1:p2', values: { ctx: 17, tokens: 136700, input: 120000, output: 16700, cost: 2.02, model: 'sonnet' }, from: null,
  });
  assert.deepEqual(parseArgs(['--pane=w1:p2', '--ctx=', '--cost', '']), { pane: 'w1:p2', values: {}, from: null });
  assert.equal(parseArgs(['--pane', 'w1:p2', '--from', 'claude']).from, 'claude');
  assert.match(parseArgs(['--pane', 'w1:p2', '--from', 'vim']).error, /--from must be one of: claude/);
  assert.deepEqual(parseArgs(['--pane', 'w1:p2', '--cost', '1.5e-05', '--ctx', '17.5']).values, { cost: 0.000015, ctx: 17.5 });
  assert.match(parseArgs(['--pane', 'w1:p2', '--ctx', '140']).error, /bad value for --ctx/);
  assert.match(parseArgs(['--pane', 'w1:p2', '--cost', '-1']).error, /bad value for --cost/);
  assert.match(parseArgs(['--pane', 'w1:p2', '--tokens', 'lots']).error, /bad value/);
  assert.match(parseArgs(['--pane', 'w1:p2', '--wat', '1']).error, /unknown option/);
  assert.match(parseArgs(['--ctx', '1']).error, /--pane/);
  assert.match(parseArgs(['--pane', '../../etc/passwd']).error, /--pane/);
  assert.match(parseArgs(['--pane']).error, /needs a value/);
});

test('fromClaude: statusline JSON to report values, bad values dropped', () => {
  const { fromClaude } = require('../src/report');
  assert.deepEqual(fromClaude({
    model: { id: 'claude-opus-5-5', display_name: 'Opus' },
    effort: { level: 'high' },
    session_id: 'a1b2-c3',
    cost: { total_cost_usd: 1.5e-05 },
    context_window: { used_percentage: 12.5, total_input_tokens: 41000, total_output_tokens: 1200 },
    rate_limits: { five_hour: { used_percentage: 41, resets_at: 1792700000 }, seven_day: { used_percentage: 'lots' } },
  }), {
    ctx: 12.5, tokens: 42200, input: 41000, output: 1200, cost: 0.000015, model: 'claude-opus-5-5', effort: 'high', session: 'a1b2-c3',
    limits: [{ source: 'claude', five_hour: { used: 41, resets: 1792700000 } }],
  });
  assert.deepEqual(fromClaude({ effort: { level: 'turbo' }, context_window: { used_percentage: 400 }, session_id: '../x' }), {});
});

test('fromAgy: model without its effort suffix, quotas per family as limits', () => {
  const { fromAgy } = require('../src/report');
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'agy-statusline.json'), 'utf8'));
  const v = fromAgy(d);
  assert.equal(v.model, 'Gemini 3.8 Flash');
  assert.equal(v.effort, 'medium');
  assert.equal(v.tokens, d.context_window.total_input_tokens + d.context_window.total_output_tokens);
  assert.equal(v.input, d.context_window.total_input_tokens);
  assert.equal(v.output, d.context_window.total_output_tokens);
  assert.equal(v.session, d.conversation_id);
  assert.deepEqual(v.limits.map((l) => l.source), ['agy other', 'agy gemini', 'agy gemini-argon-wtu']);
  const g = v.limits.find((l) => l.source === 'agy gemini');
  assert.equal(g.five_hour.used, Math.round((1 - d.quota['gemini-5h'].remaining_fraction) * 1000) / 10);
  assert.equal(g.seven_day.resets, Date.parse(d.quota['gemini-weekly'].reset_time) / 1000);
  assert.deepEqual(fromAgy({}), {});
});

test('report: task is one clean line', () => {
  assert.deepEqual(parseArgs(['--pane', 'w1:p2', '--task', '  fix\nthe\tbug  ']).values, { task: 'fix the bug', taskSource: 'manual' });
  assert.equal(parseArgs(['--pane', 'w1:p2', '--task', 'x'.repeat(300)]).values.task.length, 120);
});

test('report: effort must be a Claude Code level', () => {
  assert.deepEqual(parseArgs(['--pane', 'w1:p2', '--effort', 'xhigh']).values, { effort: 'xhigh' });
  assert.match(parseArgs(['--pane', 'w1:p2', '--effort', 'turbo']).error, /bad value for --effort/);
  assert.deepEqual(parseArgs(['--pane', 'w1:p2', '--effort', '']).values, {});
});

test('report: --role and --about are cleaned, capped and optional', () => {
  const p = parseArgs(['--pane', 'w1:p2', '--role', '  C++\x07systems  ', '--about', 'x'.repeat(200)]);
  assert.equal(p.values.role, 'C++ systems');
  assert.equal(p.values.about.length, 120);
  assert.equal(parseArgs(['--pane', 'w1:p2', '--role', 'y'.repeat(40)]).values.role.length, 32);
  assert.deepEqual(parseArgs(['--pane', 'w1:p2', '--role', '', '--about', '']).values, {});
});

test('report: role and about persist, and an empty value does not erase them', () => {
  const t = Date.now();
  writeReport('w6:p1', { role: 'camera and UX', about: 'Owns the camera work' }, t);
  writeReport('w6:p1', {}, t + 1000);
  let r = readReport('w6:p1', t + 2000);
  assert.equal(r.role, 'camera and UX');
  assert.equal(r.about, 'Owns the camera work');
  writeReport('w6:p1', { role: 'docs and release' }, t + 2000);
  r = readReport('w6:p1', t + 3000);
  assert.equal(r.role, 'docs and release');
  assert.equal(r.about, 'Owns the camera work');
});

test('pane ids cannot leave the state dir and require exactly one colon', () => {
  assert.equal(validPaneId('w11:pY'), true);
  assert.equal(validPaneId('w1:p2'), true);
  assert.equal(validPaneId('w1_p2'), false);
  assert.equal(validPaneId('w1:p2:p3'), false);
  assert.equal(validPaneId('w1:'), false);
  assert.equal(validPaneId(':p2'), false);
  assert.equal(validPaneId('../x'), false);
  assert.equal(validPaneId('a/b'), false);
  assert.equal(validPaneId(''), false);
  assert.throws(() => eventFile('../x'), /bad pane id/);
});

test('paneFile encodes pane ids injectively without collisions', () => {
  assert.equal(path.basename(paneFile('w1:p2')), 'w1_p2.json');
  assert.equal(path.basename(paneFile('w1_p2')), 'w1__p2.json');
  assert.notEqual(paneFile('w1:p2'), paneFile('w1_p2'));
});

test('readReport returns null unless stored pane matches requested id', () => {
  const t = Date.now();
  // Write a spoofed file where file corresponds to w1:p2 but payload claims w9:p9
  const f = paneFile('w1:p2');
  fs.writeFileSync(f, JSON.stringify({ pane: 'w9:p9', at: t, ctx: 50 }));
  assert.equal(readReport('w1:p2', t), null);
  fs.unlinkSync(f);
});

test('write merges with the previous report; read ignores stale reports', () => {
  const t0 = Date.now();
  writeReport('w1:p2', { ctx: 10, cost: 1 }, t0);
  writeReport('w1:p2', { ctx: 12 }, t0 + 1000);
  assert.deepEqual(readReport('w1:p2', t0 + 2000), { ctx: 12, cost: 1, pane: 'w1:p2', at: t0 + 1000 });
  assert.equal(readReport('w1:p2', t0 + 1000 + MAX_AGE_MS + 1), null);
  assert.equal(readReport('w9:p9', t0), null);
  assert.ok(fs.existsSync(path.join(dir, 'w1_p2.json')));
});

test('task source: a manual task survives an agent update', () => {
  const t = Date.now();
  writeReport('w5:p7', { task: 'typed task', taskSource: 'manual' }, t);
  writeReport('w5:p7', { task: 'session title', taskSource: 'agent' }, t + 1000);
  let r = readReport('w5:p7', t + 2000);
  assert.equal(r.task, 'typed task');
  assert.equal(r.taskSource, 'manual');
  writeReport('w5:p7', { task: 'new typed task', taskSource: 'manual' }, t + 2000);
  r = readReport('w5:p7', t + 3000);
  assert.equal(r.task, 'new typed task');
  assert.equal(r.taskSource, 'manual');
  // With no task yet, an agent task is accepted.
  writeReport('w5:p8', { task: 'agent first', taskSource: 'agent' }, t);
  assert.equal(readReport('w5:p8', t + 1000).task, 'agent first');
  // A later agent update may replace an agent task.
  writeReport('w5:p8', { task: 'agent second', taskSource: 'agent' }, t + 1000);
  assert.equal(readReport('w5:p8', t + 2000).task, 'agent second');
  // A report written before taskSource existed counts as agent.
  fs.writeFileSync(paneFile('w5:p9'), JSON.stringify({ pane: 'w5:p9', at: t, task: 'old task' }));
  writeReport('w5:p9', { task: 'agent update', taskSource: 'agent' }, t + 1000);
  assert.equal(readReport('w5:p9', t + 2000).task, 'agent update');
});

test('parseArgs: --task is manual unless the caller says agent', () => {
  assert.equal(parseArgs(['--pane', 'w1:p2', '--task', 'typed']).values.taskSource, 'manual');
  assert.equal(parseArgs(['--pane', 'w1:p2', '--task', 'title', '--task-source', 'agent']).values.taskSource, 'agent');
  assert.equal(parseArgs(['--pane', 'w1:p2', '--task-source', 'manual']).values.task, undefined);
  assert.match(parseArgs(['--pane', 'w1:p2', '--task-source', 'bot']).error, /--task-source must be agent or manual/);
});

test('pruneReports: deletes a dead pane report, keeps a live one', () => {
  const { pruneReports } = require('../src/report');
  const t = Date.now();
  writeReport('w7:p1', { ctx: 5 }, t - 120000);
  writeReport('w7:p2', { ctx: 6 }, t - 120000);
  assert.deepEqual(pruneReports(new Set(['w7:p2']), t), ['w7:p1']);
  assert.equal(fs.existsSync(path.join(dir, 'w7_p1.json')), false);
  assert.ok(fs.existsSync(path.join(dir, 'w7_p2.json')));
  fs.rmSync(path.join(dir, 'w7_p2.json'));
});

test('pruneReports: keeps a dead pane report younger than the grace', () => {
  const { pruneReports } = require('../src/report');
  const t = Date.now();
  writeReport('w7:p3', { ctx: 7 }, t - 30000);
  assert.deepEqual(pruneReports(new Set(), t), []);
  assert.ok(fs.existsSync(path.join(dir, 'w7_p3.json')));
});

test('pruneReports: ignores board state, temp files and mismatched reports', () => {
  const { pruneReports } = require('../src/report');
  const t = Date.now();
  const old = JSON.stringify({ pane: 'w7:p4', at: t - 120000 });
  fs.writeFileSync(path.join(dir, 'board.json'), old);
  fs.writeFileSync(path.join(dir, 'w7_p4.json.123.tmp'), old);
  fs.writeFileSync(path.join(dir, 'w7_p5.json'), JSON.stringify({ pane: 'w7:p6', at: t - 120000 }));
  assert.deepEqual(pruneReports(new Set(), t), []);
  assert.ok(fs.existsSync(path.join(dir, 'board.json')));
  assert.ok(fs.existsSync(path.join(dir, 'w7_p4.json.123.tmp')));
  assert.ok(fs.existsSync(path.join(dir, 'w7_p5.json')));
});

test('pruneReports: returns [] when the state dir is missing', () => {
  const { pruneReports } = require('../src/report');
  const prev = process.env.CREW_BOARD_STATE_DIR;
  process.env.CREW_BOARD_STATE_DIR = path.join(dir, 'missing');
  try {
    assert.deepEqual(pruneReports(new Set()), []);
  } finally {
    process.env.CREW_BOARD_STATE_DIR = prev;
  }
});

test('the crew-board report command end to end', () => {
  const bin = fs.existsSync(path.join(__dirname, '..', 'bin', 'roostr'))
    ? path.join(__dirname, '..', 'bin', 'roostr')
    : path.join(__dirname, '..', 'bin', 'crew-board');
  execFileSync(process.execPath, [bin, 'report', '--pane', 'w3:p1', '--ctx', '17', '--tokens', '136700', '--cost', '2.02', '--model', 'opus'], { env: process.env });
  const r = readReport('w3:p1');
  assert.equal(r.ctx, 17);
  assert.equal(r.tokens, 136700);
  assert.equal(r.cost, 2.02);
  assert.equal(r.model, 'opus');
  const bad = spawnSync(process.execPath, [bin, 'report', '--ctx', '17'], { env: process.env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage: (roostr|crew-board) report/);
});

test('the example Claude statusline reports exactly', async () => {
  const script = path.join(__dirname, '..', 'examples', 'claude-statusline.sh');
  const input = JSON.stringify({
    model: { id: 'claude-example-5-5', display_name: 'Example Model' },
    effort: { level: 'xhigh' },
    rate_limits: { five_hour: { used_percentage: 41, resets_at: 1792700000 } },
    cost: { total_cost_usd: 1.5e-05 },
    context_window: { used_percentage: 12.5, total_input_tokens: 41000, total_output_tokens: 1200 },
  });
  const env = { ...process.env, HERDR_PANE_ID: 'w4:p7', PATH: `${path.join(__dirname, '..', 'bin')}:${process.env.PATH}` };
  const out = spawnSync('sh', [script], { input, env, encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Example Model \| ctx:12.5%/);
  let r = null;
  for (let i = 0; i < 300 && !r; i++) {
    await new Promise((res) => setTimeout(res, 100));
    r = readReport('w4:p7');
  }
  assert.ok(r, 'report written');
  assert.deepEqual(
    { ctx: r.ctx, tokens: r.tokens, cost: r.cost, model: r.model, effort: r.effort, limits: r.limits },
    {
      ctx: 12.5, tokens: 42200, cost: 0.000015, model: 'claude-example-5-5', effort: 'xhigh',
      limits: [{ source: 'claude', five_hour: { used: 41, resets: 1792700000 } }],
    },
  );
});

test('report: --help works anywhere and does not need a value', () => {
  const { main } = require('../src/report');
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.deepEqual(parseArgs(['--pane', 'w1:p1', '-h']), { help: true });
  let out = '';
  const saved = process.stdout.write;
  process.stdout.write = (s) => {
    out += s;
    return true;
  };
  try {
    assert.equal(main(['--help']), 0);
  } finally {
    process.stdout.write = saved;
  }
  assert.match(out, /^usage: (roostr|crew-board) report --pane /);
  assert.match(out, /--task T/);
});

test('report: effort accepts long and short names in any case', () => {
  const effort = (v) => parseArgs(['--pane', 'w1:p1', '--effort', v]).values.effort;
  assert.equal(effort('M'), 'medium');
  assert.equal(effort('xh'), 'xhigh');
  assert.equal(effort('High'), 'high');
  assert.equal(effort('L'), 'low');
  assert.equal(effort('max'), 'max');
  assert.match(parseArgs(['--pane', 'w1:p1', '--effort', 'huge']).error, /bad value for --effort/);
});
