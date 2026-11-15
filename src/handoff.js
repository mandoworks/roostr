'use strict';
// `roostr handoff [--pane <id>] [--slug <slug>] [--dir <project root>] [--why <text>] [--json] [--dry-run]`
//
// Writes a self contained orchestrator handoff brief so a successor tool or
// model with no session resume can pick the work back up. It reads the pane
// report through ./report, the machine readable task list, the plan pointer and
// the report files the task list names, then writes one timestamped brief plus a
// latest pointer under docs/orchestration/handoffs.
//
// It never calls herdr and never copies transcript content. Callers pass what
// they have; an injectable input object keeps the tests off the filesystem.

const fs = require('fs');
const path = require('path');
const reportMod = require('./report');

const TASKS_REL = path.join('docs', 'orchestration', 'tasks.json');
const PLAN_REL = path.join('docs', 'orchestration-plan.md');
const HANDOFFS_REL = path.join('docs', 'orchestration', 'handoffs');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

const USAGE = 'usage: roostr handoff [--pane <id>] [--slug <slug>] [--dir <project root>] [--why <text>] [--json] [--dry-run]';

const FLAG_HELP = [
  ['--pane <id>', 'Herdr pane id, defaults to HERDR_PANE_ID'],
  ['--slug <slug>', 'handoff slug, defaults to the pane or report name lowercased'],
  ['--dir <root>', 'project root, defaults to the pane cwd or process.cwd()'],
  ['--why <text>', 'why the handoff happened, defaults to manual'],
  ['--json', 'print { file, latest, slug, at } on one line'],
  ['--dry-run', 'print the path and the brief, write nothing'],
  ['-h, --help', 'this help'],
];

// One line of text: control characters become spaces, runs of space one.
function clean(v, max = 240) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function toDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') return new Date(v);
  return new Date();
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Local YYYYMMDD-HHMMSS, deterministic when the caller injects `at`.
function stampOf(at) {
  const d = toDate(at);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}

function validSession(v) {
  const s = clean(v, 128);
  return SESSION_RE.test(s) ? s : null;
}

function slugify(name) {
  return clean(name, 64).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function lastLine(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line.slice(0, 240);
  }
  return '';
}

function readTasksFile(dir) {
  const file = path.join(dir, TASKS_REL);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

function normalizeTasks(raw) {
  if (!raw || !Array.isArray(raw.tasks)) return null;
  const out = [];
  for (const t of raw.tasks) {
    if (!t || typeof t !== 'object') continue;
    const id = clean(t.id, 80);
    if (!id) continue;
    out.push({
      id,
      title: clean(t.title, 200) || id,
      status: clean(t.status, 32) || 'unknown',
      depends_on: Array.isArray(t.depends_on) ? t.depends_on.map((x) => clean(x, 80)).filter(Boolean) : [],
    });
  }
  return out.length ? out : null;
}

function readTaskReports(dir, raw) {
  const out = [];
  if (!raw || !Array.isArray(raw.tasks)) return out;
  for (const t of raw.tasks) {
    if (!t || typeof t !== 'object') continue;
    const rel = clean(t.report, 400);
    if (!rel) continue;
    const file = path.resolve(dir, rel);
    if (!fs.existsSync(file)) continue;
    out.push({ path: rel, last: lastLine(file) });
  }
  return out;
}

function defaultPlanPath(dir) {
  return fs.existsSync(path.join(dir, PLAN_REL)) ? PLAN_REL : null;
}

// Pure: assembles the brief markdown from an already collected input object.
function buildBrief(input) {
  const o = input || {};
  const at = toDate(o.at);
  const stamp = stampOf(at);
  const slug = clean(o.slug, 32);
  const why = clean(o.why, 240) || 'manual';
  const report = o.report && typeof o.report === 'object' ? o.report : {};
  const tasks = Array.isArray(o.tasks) ? o.tasks : null;
  const reports = Array.isArray(o.reports) ? o.reports : [];
  const planPath = clean(o.planPath, 400) || null;
  const tasksPath = clean(o.tasksPath, 400) || null;
  const role = clean(report.role, 64) || 'unknown';
  const session = validSession(o.session !== undefined ? o.session : report.session);
  const blocked = clean(report.blocked, 240) || clean(report.blockedOn, 240) || clean(report.blocked_on, 240) || 'unknown';

  const lines = [];
  lines.push(`# Handoff: ${slug} (${stamp})`);
  lines.push('');

  lines.push('## Role and reason');
  lines.push('');
  lines.push(`- Role: ${role}`);
  lines.push(`- Why: ${why}`);
  lines.push('');

  lines.push('## Plan and tasks');
  lines.push('');
  lines.push(`- Plan: ${planPath || 'no plan'}`);
  lines.push(`- Task list: ${tasksPath || 'no task list'}`);
  lines.push('');
  if (tasks && tasks.length) {
    lines.push('| id | title | status |');
    lines.push('| --- | --- | --- |');
    for (const t of tasks) {
      lines.push(`| ${t.id} | ${t.title} | ${t.status} |`);
    }
  } else {
    lines.push('no task list');
  }
  lines.push('');

  lines.push('## Blocked on');
  lines.push('');
  lines.push(blocked);
  lines.push('');

  lines.push('## Last actions');
  lines.push('');
  lines.push(`- Task: ${clean(report.task, 240) || 'unknown'}`);
  lines.push(`- About: ${clean(report.about, 240) || 'unknown'}`);
  lines.push(`- Session: ${clean(report.session, 128) || 'unknown'}`);
  lines.push('');

  lines.push('## File pointers');
  lines.push('');
  lines.push(`- Plan: ${planPath || 'none'}`);
  lines.push(`- Tasks: ${tasksPath || 'none'}`);
  if (reports.length) {
    lines.push('- Reports:');
    for (const r of reports) {
      lines.push(`  - ${r.path}: ${r.last || '(empty)'}`);
    }
  } else {
    lines.push('- Reports: none');
  }
  lines.push('');

  lines.push('## Session export');
  lines.push('');
  lines.push(`- Session id: ${session || 'none'}`);
  lines.push('- Transcript: not copied. Export it with `roostr sessions` and hand the file to the successor.');
  lines.push('');

  return lines.join('\n');
}

function assertInside(root, target) {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('refusing to write outside the handoffs folder');
  }
}

// Collects inputs from disk when not injected, builds the brief, writes the
// files and returns { file, latest, slug, at, brief }.
function writeHandoff(opts) {
  const o = opts || {};
  const now = toDate(o.now);
  const nowMs = now.getTime();
  const dir = path.resolve(o.dir || process.cwd());
  const pane = o.pane || process.env.HERDR_PANE_ID || null;

  let report = o.report;
  if (report === undefined) {
    report = pane ? reportMod.readReport(pane, nowMs) : null;
  }
  if (report === undefined) report = null;

  let slug = o.slug;
  if (!slug) {
    const name = (report && report.name) || pane || '';
    slug = slugify(name);
  }
  slug = clean(slug, 32);
  if (!isValidSlug(slug)) throw new Error(`bad slug: ${slug || '(empty)'}`);

  let tasks = o.tasks;
  let tasksPath = o.tasksPath;
  let planPath = o.planPath;
  let reports = o.reports;
  let raw = null;
  if (tasks === undefined || planPath === undefined || reports === undefined) {
    raw = readTasksFile(dir);
  }
  if (tasks === undefined) tasks = normalizeTasks(raw);
  if (tasksPath === undefined) tasksPath = tasks ? TASKS_REL : null;
  if (planPath === undefined) {
    planPath = raw && clean(raw.plan, 400) ? clean(raw.plan, 400) : defaultPlanPath(dir);
  }
  if (reports === undefined) reports = raw ? readTaskReports(dir, raw) : [];

  const input = {
    slug,
    at: nowMs,
    why: o.why,
    report,
    tasks,
    tasksPath,
    planPath,
    reports,
    session: o.session,
  };
  const brief = buildBrief(input);
  const stamp = stampOf(now);
  const handoffsDir = path.join(dir, HANDOFFS_REL);
  const file = path.join(handoffsDir, `${slug}-${stamp}.md`);
  const latest = path.join(handoffsDir, `latest-${slug}.md`);
  assertInside(handoffsDir, file);
  assertInside(handoffsDir, latest);

  if (!o.dryRun) {
    fs.mkdirSync(handoffsDir, { recursive: true });
    const rel = path.relative(dir, file) || path.basename(file);
    const latestText = `> Latest handoff for ${slug}: ${rel}\n\n${brief}`;
    fs.writeFileSync(file, brief);
    fs.writeFileSync(latest, latestText);
  }

  return { file, latest, slug, at: nowMs, brief };
}

function parseArgs(argv) {
  const out = { pane: null, slug: null, dir: null, why: null, json: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    let v;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      v = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--dry-run') { out.dryRun = true; continue; }
    if (a === '--pane' || a === '--slug' || a === '--dir' || a === '--why') {
      if (v === undefined) {
        v = argv[i + 1];
        if (v === undefined) return { error: `${a} needs a value` };
        i++;
      }
      if (a === '--pane') out.pane = v;
      else if (a === '--slug') out.slug = v;
      else if (a === '--dir') out.dir = v;
      else out.why = v;
      continue;
    }
    return { error: `unknown option ${a}` };
  }
  return out;
}

function helpText() {
  const lines = [USAGE, '', 'flags:'];
  for (const [flag, what] of FLAG_HELP) lines.push(`  ${flag.padEnd(12)} ${what}`);
  return lines.join('\n') + '\n';
}

function main(argv) {
  const p = parseArgs(argv);
  if (p.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (p.error) {
    process.stderr.write(`roostr handoff: ${p.error}\n${USAGE}\n`);
    return 2;
  }
  try {
    const res = writeHandoff({
      pane: p.pane,
      slug: p.slug,
      dir: p.dir,
      why: p.why,
      dryRun: p.dryRun,
      now: Date.now(),
    });
    if (p.json) {
      process.stdout.write(`${JSON.stringify({ file: res.file, latest: res.latest, slug: res.slug, at: res.at })}\n`);
    } else if (p.dryRun) {
      process.stdout.write(`dry-run: would write ${res.file}\n\n${res.brief}`);
    } else {
      process.stdout.write(`wrote ${res.file}\nlatest ${res.latest}\n`);
    }
    return 0;
  } catch (e) {
    process.stderr.write(`roostr handoff: ${e.message}\n`);
    return 2;
  }
}

module.exports = {
  buildBrief, writeHandoff, main, parseArgs,
  stampOf, isValidSlug, USAGE,
};