'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseToml, parseCheckString, toCrew, findCrewFile, safeToRun, loadCrew, FILE_NAME } = require('../src/crewfile');

test('toml: keys, tables, arrays of tables, value types, comments', () => {
  const d = parseToml(`
# a comment
name = "example crew"   # trailing comment
count = 3
ratio = -0.5
big = 1_000
on = true
off = false
lit = 'C:\\no\\escapes'
esc = "tab\\there \\"quoted\\" \\u00e9 # not a comment"

[board]
tags = "off"

[[pane]]
name = "docs"
checks = ["A: test -f a", 'B: test -f b',]

[[pane]]
name = "api"
checks = [
  "C: pgrep -x node",  # comment inside an array
  "D: true",
]
nums = [1, 2.5, true]
empty = []
`);
  assert.equal(d.name, 'example crew');
  assert.equal(d.count, 3);
  assert.equal(d.ratio, -0.5);
  assert.equal(d.big, 1000);
  assert.equal(d.on, true);
  assert.equal(d.off, false);
  assert.equal(d.lit, 'C:\\no\\escapes');
  assert.equal(d.esc, 'tab\there "quoted" é # not a comment');
  assert.deepEqual(d.board, Object.assign(Object.create(null), { tags: 'off' }));
  assert.equal(d.pane.length, 2);
  assert.deepEqual(d.pane[0].checks, ['A: test -f a', 'B: test -f b']);
  assert.deepEqual(d.pane[1].checks, ['C: pgrep -x node', 'D: true']);
  assert.deepEqual(d.pane[1].nums, [1, 2.5, true]);
  assert.deepEqual(d.pane[1].empty, []);
});

test('toml: errors carry a line number', () => {
  const cases = [
    ['a = "open', /line 1: unterminated string/],
    ['\n\nx = [1, 2', /line 3: unterminated array/],
    ['a = 1\na = 2', /line 2: key "a" defined twice/],
    ['[t]\n[t]', /line 2: table "t" defined twice/],
    ['[a..b]', /line 1: unsupported table header/],
    ['[a.]', /line 1: unsupported table header/],
    ['a = {x = 1}', /line 1: unsupported value/],
    ['just text', /line 1: expected key = value/],
    ['a = 1 2', /line 1: unexpected text after value/],
    ['a = [[1]]', /line 1: nested arrays/],
    ['a = "bad \\q"', /line 1: bad escape/],
    ['x = 1\n[[x]]', /line 2: "x" is not an array of tables/],
  ];
  for (const [src, re] of cases) assert.throws(() => parseToml(src), re, src);
});

test('check strings: "LABEL: command"', () => {
  assert.deepEqual(parseCheckString('REPORT READY: test -f agents/docs/report.md'), {
    name: 'REPORT READY', run: 'test -f agents/docs/report.md',
  });
  assert.deepEqual(parseCheckString('Blender:pgrep -x Blender'), { name: 'Blender', run: 'pgrep -x Blender' });
  assert.equal(parseCheckString('no label here'), null);
  assert.equal(parseCheckString(': nothing'), null);
});

test('crew model: paths resolve against the crew file, bad entries become errors', () => {
  const crew = toCrew(parseToml(`
name = "example crew"
[board]
tags = "metadata"
[[check]]
name = "Node"
run = "pgrep -x node"
[[check]]
name = "missing run"
[[pane]]
name = "docs"
model = "sonnet"
report = "agents/docs/report.md"
checks = ["GREEN: test -f .ok", "no label"]
[[pane]]
model = "nameless"
`), '/proj/.crew-board.toml');
  assert.equal(crew.name, 'example crew');
  assert.equal(crew.tags, 'metadata');
  assert.deepEqual(crew.checks, [{ name: 'Node', run: 'pgrep -x node' }]);
  assert.deepEqual(crew.panes.docs, {
    name: 'docs', model: 'sonnet', report: '/proj/agents/docs/report.md', budget: null,
    checks: [{ name: 'GREEN', run: 'test -f .ok' }],
  });
  assert.equal(crew.errors.length, 3);
});

test('find and load a crew file above a pane cwd; a broken file reports its error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-test-'));
  const deep = path.join(root, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findCrewFile(deep), null);
  const file = path.join(fs.realpathSync(root), FILE_NAME);
  fs.writeFileSync(file, 'name = "tmp crew"\n', { mode: 0o644 });
  // Outside home and outside any repo, only the pane's own directory counts.
  assert.equal(findCrewFile(deep), null);
  assert.equal(findCrewFile(root), file);
  // Inside a repo the walk reaches the repo root.
  fs.mkdirSync(path.join(root, '.git'));
  assert.equal(findCrewFile(deep), file);
  // A file others can write is never used: it would run their commands.
  fs.chmodSync(file, 0o666);
  assert.equal(findCrewFile(deep), null);
  fs.chmodSync(file, 0o644);
  assert.equal(loadCrew(file).name, 'tmp crew');
  fs.writeFileSync(file, 'name = "broken\n');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(file, t, t);
  const broken = loadCrew(file);
  assert.equal(broken.name, null);
  assert.match(broken.errors[0], /unterminated string/);
  assert.equal(loadCrew(path.join(root, 'nope.toml')), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('pane report stays inside the crew folder', () => {
  const crew = toCrew(parseToml(`
[[pane]]
name = "docs"
report = "/etc/passwd"
[[pane]]
name = "api"
report = "../x.md"
[[pane]]
name = "tests"
report = "agents/../done.md"
`), '/proj/.crew-board.toml');
  assert.equal(crew.panes.docs.report, null);
  assert.equal(crew.panes.api.report, null);
  assert.equal(crew.panes.tests.report, '/proj/done.md');
  assert.match(crew.errors[0], /pane "docs": report must be inside the crew folder/);
  assert.match(crew.errors[1], /pane "api": report must be inside the crew folder/);
});

test('crew names and check labels are cleaned at load', () => {
  const crew = toCrew(parseToml(`
name = "EVIL\\u001b[2J\\nX"
[[check]]
name = "EVIL\\u001b[2J\\nX"
run = "true"
[[pane]]
name = "docs"
checks = ["EVIL\\u001b[2J\\nX: true"]
`), '/proj/.crew-board.toml');
  assert.equal(crew.name, 'EVIL[2J X');
  assert.equal(crew.checks[0].name, 'EVIL[2J X');
  assert.deepEqual(crew.panes.docs.checks[0], { name: 'EVIL[2J X', run: 'true' });
  assert.ok(!crew.name.includes('\x1b'));
  assert.ok(!crew.name.includes('\n'));
});

test('safeToRun: owned and closed to group and others', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-safe-'));
  const file = path.join(root, 'crew.toml');
  fs.writeFileSync(file, 'name = "x"\n', { mode: 0o644 });
  try {
    assert.equal(safeToRun(file), true);
    fs.chmodSync(file, 0o666);
    assert.equal(safeToRun(file), false);
    assert.equal(safeToRun(path.join(root, 'missing.toml')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseToml: constructor and __proto__ tables do not collide or pollute prototype', () => {
  const parsed = parseToml(`
[constructor]
field = 42

[__proto__]
polluted = true
`);
  assert.equal(parsed.constructor.field, 42);
  assert.equal(Object.prototype.polluted, undefined);

  assert.throws(() => parseToml(`
[constructor]
a = 1
[constructor]
b = 2
`), /table "constructor" defined twice/);

  const crew = toCrew(parseToml(`
[[pane]]
name = "constructor"
model = "sonnet"
`), '/proj/.crew-board.toml');
  assert.equal(crew.panes.constructor.model, 'sonnet');
  assert.equal(Object.getPrototypeOf(crew.panes), null);
});

test('parseToml: dotted table headers build nested tables', () => {
  const d = parseToml(`
[providers.explabs]
enabled = true
[board]
tag_scope = "all"
`);
  assert.ok(d.providers);
  assert.ok(d.providers.explabs);
  assert.equal(d.providers.explabs.enabled, true);
  assert.equal(d.board.tag_scope, 'all');
  assert.equal(Object.getPrototypeOf(d.providers), null);
});

test('parseToml: dotted headers grow an existing table without redefining it', () => {
  const d = parseToml(`
[providers]
name = "x"
[providers.explabs]
enabled = true
`);
  assert.equal(d.providers.name, 'x');
  assert.equal(d.providers.explabs.enabled, true);
});

test('parseToml: a dotted table defined twice errors with a line number', () => {
  assert.throws(() => parseToml(`
[providers.explabs]
enabled = true
[providers.explabs]
enabled = false
`), /line 4: table "providers\.explabs" defined twice/);
});

test('parseToml: a dotted header cannot descend into a value', () => {
  assert.throws(() => parseToml(`
[providers]
explabs = true
[providers.explabs]
enabled = true
`), /line 4: table "providers\.explabs" conflicts with an existing value/);
});

test('parseToml: dotted __proto__ and constructor tables do not pollute', () => {
  parseToml(`
[__proto__.x]
polluted = true
[constructor.y]
field = 1
`);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.prototype.field, undefined);
  assert.equal({}.x, undefined);
  assert.equal({}.y, undefined);
});

test('crew model: new config keys and their defaults', () => {
  const defaults = toCrew(parseToml('name = "plain"\n'), '/proj/.crew-board.toml');
  assert.equal(defaults.tagScope, 'here');
  assert.equal(defaults.checkConcurrency, 3);
  assert.equal(defaults.checkTimeoutMs, 2000);
  assert.equal(defaults.secretaryAuto, null);
  assert.equal(defaults.secretaryIntervalMs, null);
  assert.equal(defaults.secretaryScope, null);
  assert.equal(defaults.explabsEnabled, false);
  assert.deepEqual(defaults.errors, []);
});

test('crew model: new config keys accept valid values', () => {
  const crew = toCrew(parseToml(`
[board]
tag_scope = "all"
[checks]
concurrency = 8
timeout_seconds = 10
[secretary]
auto = true
interval_seconds = 3600
scope = "workspace"
[providers.explabs]
enabled = true
`), '/proj/.crew-board.toml');
  assert.equal(crew.tagScope, 'all');
  assert.equal(crew.checkConcurrency, 8);
  assert.equal(crew.checkTimeoutMs, 10000);
  assert.equal(crew.secretaryAuto, true);
  assert.equal(crew.secretaryIntervalMs, 3600000);
  assert.equal(crew.secretaryScope, 'workspace');
  assert.equal(crew.explabsEnabled, true);
  assert.deepEqual(crew.errors, []);

  const low = toCrew(parseToml(`
[checks]
concurrency = 1
timeout_seconds = 1
[secretary]
auto = false
interval_seconds = 60
scope = "all"
[providers.explabs]
enabled = false
`), '/proj/.crew-board.toml');
  assert.equal(low.checkConcurrency, 1);
  assert.equal(low.checkTimeoutMs, 1000);
  assert.equal(low.secretaryAuto, false);
  assert.equal(low.secretaryIntervalMs, 60000);
  assert.equal(low.secretaryScope, 'all');
  assert.equal(low.explabsEnabled, false);
  assert.deepEqual(low.errors, []);
});

test('crew model: invalid config keys fall back and append an error', () => {
  const cases = [
    ['[board]\ntag_scope = "ALL"', '[board] tag_scope must be "here" or "all"'],
    ['[board]\ntag_scope = "session"', '[board] tag_scope must be "here" or "all"'],
    ['[checks]\nconcurrency = 0', '[checks] concurrency must be 1..8'],
    ['[checks]\nconcurrency = 9', '[checks] concurrency must be 1..8'],
    ['[checks]\nconcurrency = 3.5', '[checks] concurrency must be 1..8'],
    ['[checks]\ntimeout_seconds = 0', '[checks] timeout_seconds must be 1..10'],
    ['[checks]\ntimeout_seconds = 11', '[checks] timeout_seconds must be 1..10'],
    ['[secretary]\nauto = "yes"', '[secretary] auto must be true or false'],
    ['[secretary]\ninterval_seconds = 0', '[secretary] interval_seconds must be 60..3600'],
    ['[secretary]\ninterval_seconds = 3601', '[secretary] interval_seconds must be 60..3600'],
    ['[secretary]\nscope = "session"', '[secretary] scope must be "workspace" or "all"'],
    ['[providers.explabs]\nenabled = "yes"', '[providers.explabs] enabled must be true or false'],
  ];
  for (const [src, msg] of cases) {
    const crew = toCrew(parseToml(src), '/proj/.crew-board.toml');
    assert.ok(crew.errors.includes(msg), `${src}: expected ${msg}, got ${JSON.stringify(crew.errors)}`);
  }
  const crew = toCrew(parseToml('[providers]\nname = "x"\n'), '/proj/.crew-board.toml');
  assert.equal(crew.explabsEnabled, false);
  assert.deepEqual(crew.errors, []);
});

test('parseToml: [secretary] auto without a value is a parse error', () => {
  assert.throws(() => parseToml('[secretary]\nauto =\n'), /line 2: unsupported value/);
});

test('crew model: project task kind overrides are validated and kept', () => {
  const crew = toCrew(parseToml(`
[tasks.docs]
tool = "opencode"
model = "docs-model"
fallbacks = ["a", "a", "b"]
effort = "high"

[tasks.review]
model = "review-model"

[tasks.ghost]
effort = "low"
`), '/proj/.crew-board.toml');
  assert.deepEqual({ ...crew.taskKinds.docs }, { tool: 'opencode', model: 'docs-model', fallbacks: ['a', 'b'], effort: 'high' });
  assert.deepEqual({ ...crew.taskKinds.review }, { model: 'review-model' });
  assert.ok(crew.errors.some((e) => /unknown task kind/.test(e)));
});
