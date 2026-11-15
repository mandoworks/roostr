'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const handoff = require('../src/handoff');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roostr-handoff-'));

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function fixtureDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, 'docs', 'orchestration'), { recursive: true });
  return dir;
}

const FIXED_AT = new Date(2025, 0, 2, 3, 4, 5);

const TASKS = {
  version: 1,
  plan: 'docs/orchestration-plan.md',
  tasks: [
    { id: 'pkg-handoff', title: 'Add handoff writer', status: 'working', depends_on: [] },
    { id: 'pkg-backup', title: 'Add backups capture', status: 'pending', depends_on: ['pkg-handoff'] },
  ],
};

const REPORT = {
  role: 'orchestrator',
  task: 'writing the handoff brief',
  about: 'ships roostr handoff',
  session: 'sess-abc123',
  blocked: 'waiting on review',
};

test('buildBrief includes every section and the task ids', () => {
  const brief = handoff.buildBrief({
    slug: 'roosty',
    at: FIXED_AT,
    why: 'usage limit',
    report: REPORT,
    tasks: [
      { id: 'pkg-handoff', title: 'Add handoff writer', status: 'working', depends_on: [] },
      { id: 'pkg-backup', title: 'Add backups capture', status: 'pending', depends_on: ['pkg-handoff'] },
    ],
    tasksPath: 'docs/orchestration/tasks.json',
    planPath: 'docs/orchestration-plan.md',
    reports: [{ path: 'docs/orchestration/reports/pkg-handoff.md', last: 'HANDOFF_DONE' }],
  });

  assert.match(brief, /^# Handoff: roosty \(/);
  for (const section of ['## Role and reason', '## Plan and tasks', '## Blocked on', '## Last actions', '## File pointers', '## Session export']) {
    assert.ok(brief.includes(section), `missing section ${section}`);
  }
  assert.match(brief, /pkg-handoff/);
  assert.match(brief, /pkg-backup/);
  assert.match(brief, /waiting on review/);
  assert.match(brief, /sess-abc123/);
  assert.match(brief, /HANDOFF_DONE/);
  assert.match(brief, /usage limit/);
  assert.ok(!brief.includes(String.fromCharCode(0x2014)), 'no em dash');
});

test('stamp is YYYYMMDD-HHMMSS and slug validation rejects bad input', () => {
  assert.equal(handoff.stampOf(FIXED_AT), '20250102-030405');
  assert.ok(handoff.isValidSlug('roosty'));
  assert.ok(handoff.isValidSlug('la-guardiana'));
  assert.ok(!handoff.isValidSlug('Roosty'));
  assert.ok(!handoff.isValidSlug('-bad'));
  assert.ok(!handoff.isValidSlug('has_underscore'));
  assert.ok(!handoff.isValidSlug('x'.repeat(33)));
  assert.throws(() => handoff.writeHandoff({ dir: tmpRoot, slug: 'Bad Slug', now: FIXED_AT, report: REPORT }), /bad slug/);
});

test('writeHandoff writes a timestamped file and refreshes the latest pointer', () => {
  const dir = fixtureDir('write');
  const res = handoff.writeHandoff({
    dir,
    slug: 'roosty',
    at: FIXED_AT,
    now: FIXED_AT,
    why: 'usage limit',
    report: REPORT,
    tasks: TASKS.tasks,
    tasksPath: 'docs/orchestration/tasks.json',
    planPath: 'docs/orchestration-plan.md',
    reports: [],
  });
  assert.equal(res.slug, 'roosty');
  assert.equal(res.at, FIXED_AT.getTime());
  assert.ok(fs.existsSync(res.file));
  assert.ok(fs.existsSync(res.latest));
  assert.equal(path.basename(res.file), 'roosty-20250102-030405.md');
  assert.equal(path.basename(res.latest), 'latest-roosty.md');

  const latest = fs.readFileSync(res.latest, 'utf8');
  assert.ok(latest.includes('roosty-20250102-030405.md'), 'latest links the new file');
  assert.ok(latest.includes('## Session export'));
});

test('dry run writes nothing', () => {
  const dir = fixtureDir('dry');
  const res = handoff.writeHandoff({
    dir,
    slug: 'ghost',
    at: FIXED_AT,
    now: FIXED_AT,
    report: REPORT,
    tasks: TASKS.tasks,
    dryRun: true,
  });
  assert.ok(!fs.existsSync(res.file));
  assert.ok(!fs.existsSync(res.latest));
  assert.match(res.brief, /## Role and reason/);
});

test('missing tasks.json still produces a valid brief with no task list', () => {
  const dir = fixtureDir('notasks');
  const res = handoff.writeHandoff({
    dir,
    slug: 'solo',
    at: FIXED_AT,
    now: FIXED_AT,
    report: REPORT,
  });
  const brief = fs.readFileSync(res.file, 'utf8');
  assert.match(brief, /no task list/);
  assert.match(brief, /## Plan and tasks/);
  assert.match(brief, /## Session export/);
  assert.ok(!brief.includes(String.fromCharCode(0x2014)), 'no em dash');
});

test('writeHandoff reads a fixture tasks.json from disk', () => {
  const dir = fixtureDir('disk');
  fs.writeFileSync(
    path.join(dir, 'docs', 'orchestration', 'tasks.json'),
    JSON.stringify(TASKS)
  );
  const res = handoff.writeHandoff({ dir, slug: 'disky', now: FIXED_AT, report: REPORT });
  const brief = fs.readFileSync(res.file, 'utf8');
  assert.match(brief, /pkg-handoff/);
  assert.match(brief, /pkg-backup/);
});

test('main returns 0 and prints json on one line, 2 on a bad slug', () => {
  const dir = fixtureDir('cli');
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  const logs = [];
  const errs = [];
  process.stdout.write = (m) => { logs.push(String(m)); return true; };
  process.stderr.write = (m) => { errs.push(String(m)); return true; };
  try {
    const code = handoff.main(['--dir', dir, '--slug', 'clian', '--json', '--dry-run']);
    assert.equal(code, 0);
    const line = logs.join('\n').trim();
    const parsed = JSON.parse(line);
    assert.equal(parsed.slug, 'clian');
    assert.ok(parsed.file.endsWith('clian-' + handoff.stampOf(new Date(parsed.at)) + '.md'));

    logs.length = 0;
    const bad = handoff.main(['--dir', dir, '--slug', 'Bad Slug']);
    assert.equal(bad, 2);
    assert.match(errs.join('\n'), /bad slug/);
  } finally {
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
  }
});