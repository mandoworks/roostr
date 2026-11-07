'use strict';
// `crew-board report --pane <id> [--ctx N] [--tokens N] [--cost N] [--model S] [--effort E] [--task T] [--session ID] [--from claude|agy]`
//
// The exact usage path. An agent (usually its statusline script) reports its
// own numbers; the board prefers them over anything read from the screen.
// Flags given an empty value are ignored, so a statusline can pass a field it
// does not have without erasing what an earlier report said.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { stateDir, validPaneId, paneFile, eventFile, readJson, writeJson } = require('./state');
const rotate = require('./rotate');

// Reports older than this are ignored by the board (the pane may be gone and
// its id reused).
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

// Claude Code's reasoning effort levels, as its statusline names them, plus the
// short forms the board and the README use.
const EFFORT_ALIASES = {
  low: 'low', l: 'low', medium: 'medium', m: 'medium', high: 'high', h: 'high',
  xhigh: 'xhigh', xh: 'xhigh', max: 'max',
};

const USAGE = 'usage: crew-board report --pane <id> [--ctx N] [--tokens N] [--input N] [--output N] [--cost N] [--model S] [--effort E] [--task T] [--role S] [--about S] [--session ID] [--from claude|agy]';

const FLAG_HELP = [
  ['--pane <id>', 'Herdr pane id (required, for example w1:p2)'],
  ['--ctx N', 'context window used, in percent'],
  ['--tokens N', 'total tokens in the session'],
  ['--input N', 'input tokens in the session'],
  ['--output N', 'output tokens in the session'],
  ['--cost N', 'cost so far, in dollars'],
  ['--model S', 'model name'],
  ['--effort E', 'low, medium, high, xhigh or max (l, m, h, xh, max)'],
  ['--task T', 'what the agent is doing now'],
  ['--role S', 'the agent core job, up to 32 characters'],
  ['--about S', 'one line on what the agent does, up to 120 characters'],
  ['--session ID', 'agent session id'],
  ['--from claude|agy', 'read a statusline JSON document on stdin'],
  ['-h, --help', 'this help'],
];

const FIELDS = {
  '--ctx': ['ctx', (v) => num(v, 0, 100)],
  '--tokens': ['tokens', (v) => { const n = num(v, 0, Infinity); return n === undefined ? undefined : Math.round(n); }],
  '--input': ['input', (v) => { const n = num(v, 0, Infinity); return n === undefined ? undefined : Math.round(n); }],
  '--output': ['output', (v) => { const n = num(v, 0, Infinity); return n === undefined ? undefined : Math.round(n); }],
  '--cost': ['cost', (v) => num(v, 0, Infinity)],
  '--model': ['model', (v) => String(v).replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 64) || undefined],
  '--effort': ['effort', (v) => EFFORT_ALIASES[String(v).toLowerCase()]],
  '--session': ['session', (v) => (/^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : undefined)],
  '--task': ['task', (v) => line(v, 120)],
  '--role': ['role', (v) => line(v, 32)],
  '--about': ['about', (v) => line(v, 120)],
};

// One line of text: control characters become spaces, runs of space one.
function line(v, max) {
  return String(v).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || undefined;
}

function num(v, min, max) {
  // jq prints tiny numbers as 1.5e-05, so exponents are fine; signs are not.
  if (!/^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(String(v).trim())) return undefined;
  const n = Number(v);
  return n >= min && n <= max ? n : undefined;
}

// argv -> { pane, values } or { error }
function parseArgs(argv) {
  let pane = null;
  let from = null;
  let taskSource = null;
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '-h' || a === '--help') return { help: true };
    let v;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      v = a.slice(eq + 1);
      a = a.slice(0, eq);
    } else {
      v = argv[i + 1];
      if (v === undefined) return { error: `${a} needs a value` };
      i++;
    }
    if (a === '--pane') {
      pane = v;
      continue;
    }
    if (a === '--from') {
      if (!FROM[v]) return { error: `--from must be one of: ${Object.keys(FROM).join(', ')}` };
      from = v;
      continue;
    }
    if (a === '--task-source') {
      if (v !== 'agent' && v !== 'manual') return { error: '--task-source must be agent or manual' };
      taskSource = v;
      continue;
    }
    const f = FIELDS[a];
    if (!f) return { error: `unknown option ${a}` };
    if (v === '' || v === 'null') continue;
    const parsed = f[1](v);
    if (parsed === undefined) return { error: `bad value for ${a}: ${v}` };
    values[f[0]] = parsed;
  }
  if (!validPaneId(pane)) return { error: 'missing or bad --pane (expected a Herdr pane id like w1:p2)' };
  if (values.task !== undefined) values.taskSource = taskSource || 'manual';
  return { pane, values, from };
}

// `--from claude`: Claude Code's statusline JSON on stdin, so a statusline
// needs one process and no jq. Every value goes through the same checks as
// the flags; the 5 hour and 7 day windows are account wide usage limits.
function fromClaude(d) {
  const cw = d.context_window || {};
  const tokens = cw.total_input_tokens == null ? null : Number(cw.total_input_tokens) + Number(cw.total_output_tokens || 0);
  const values = checked({
    '--ctx': cw.used_percentage,
    '--tokens': tokens,
    '--input': cw.total_input_tokens,
    '--output': cw.total_output_tokens,
    '--cost': d.cost && d.cost.total_cost_usd,
    '--model': d.model && (d.model.id || d.model.display_name),
    '--effort': d.effort && d.effort.level,
    '--session': d.session_id,
  });
  const limits = {};
  for (const w of ['five_hour', 'seven_day']) {
    const x = d.rate_limits && d.rate_limits[w];
    const used = x && num(String(x.used_percentage), 0, 1000);
    const resets = x && num(String(x.resets_at), 0, Infinity);
    if (used !== undefined && used !== null) limits[w] = { used, resets: resets === undefined ? null : resets };
  }
  if (Object.keys(limits).length) values.limits = [{ source: 'claude', ...limits }];
  return values;
}

// `--from agy`: Antigravity's statusline JSON. Its model name carries the
// effort ("Gemini 3.8 Flash (Medium)"); its quotas come as remaining
// fractions per family ("gemini-5h", "gemini-weekly", "3p-5h", ...).
function fromAgy(d) {
  const cw = d.context_window || {};
  const m = d.model || {};
  const name = String(m.display_name || m.id || '').replace(/\s*\((?:low|medium|high|xhigh|max|minimal)\)\s*$/i, '');
  const values = checked({
    '--ctx': cw.used_percentage,
    '--tokens': cw.total_input_tokens == null ? null : Number(cw.total_input_tokens) + Number(cw.total_output_tokens || 0),
    '--input': cw.total_input_tokens,
    '--output': cw.total_output_tokens,
    '--model': name,
    '--effort': m.effort && String(m.effort).toLowerCase(),
    '--session': d.conversation_id || d.session_id,
  });
  const by = {};
  for (const [key, q] of Object.entries(d.quota || {})) {
    const k = /^(.+)-(5h|weekly)$/.exec(key);
    const left = q && num(String(q.remaining_fraction), 0, 1);
    if (!k || left === undefined) continue;
    const resets = Date.parse(q.reset_time);
    const source = k[1] === '3p' ? 'agy other' : `agy ${k[1]}`;
    by[source] = by[source] || { source };
    by[source][k[2] === '5h' ? 'five_hour' : 'seven_day'] = { used: Math.round((1 - left) * 1000) / 10, resets: Number.isNaN(resets) ? null : resets / 1000 };
  }
  if (Object.keys(by).length) values.limits = Object.values(by);
  return values;
}

// Raw values keyed by flag, through the flags' own checks; bad ones dropped.
function checked(raw) {
  const values = {};
  for (const [flag, v] of Object.entries(raw)) {
    if (v === null || v === undefined || v === '') continue;
    const parsed = FIELDS[flag][1](String(v));
    if (parsed !== undefined) values[FIELDS[flag][0]] = parsed;
  }
  return values;
}

const FROM = { claude: fromClaude, agy: fromAgy };

function usagePath() {
  if (process.env.ROOSTR_USAGE) return process.env.ROOSTR_USAGE;
  if (process.env.CREW_BOARD_USAGE) return process.env.CREW_BOARD_USAGE;
  const roostr = path.join(os.homedir(), '.roostr', 'usage.jsonl');
  const legacy = path.join(os.homedir(), '.crew-board', 'usage.jsonl');
  if (fs.existsSync(roostr) || !fs.existsSync(legacy)) return roostr;
  return legacy;
}

function readUsage(file = usagePath(), options = {}) {
  const files = [file];
  if (options && options.includeArchive) {
    const archive = file + (options.suffix || rotate.DEFAULT_ARCHIVE_SUFFIX);
    if (fs.existsSync(archive)) files.unshift(archive);
  }
  const out = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) out.push(entry);
      } catch {
        // Tolerant reader: skips malformed line.
      }
    }
  }
  return out;
}

function appendUsage(sample, file = usagePath()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(sample) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Backends without POSIX modes are fine.
  }
  rotate.maybeRotate(file);
  return sample;
}

function writeReport(pane, values, now = Date.now()) {
  const prev = readJson(paneFile(pane)) || {};
  const next = { ...prev, ...values, pane, at: now };
  if (values.task !== undefined) {
    const source = values.taskSource === 'manual' ? 'manual' : 'agent';
    const prevSource = prev.taskSource === 'manual' ? 'manual' : 'agent';
    // A manual task always wins. An agent task only replaces a missing or
    // agent-written one, so a session title cannot overwrite a typed task.
    if (source === 'agent' && prev.task && prevSource === 'manual') {
      next.task = prev.task;
      next.taskSource = 'manual';
    } else {
      next.taskSource = source;
    }
  }
  writeJson(paneFile(pane), next);
  try {
    appendUsage({
      at: new Date(now).toISOString(),
      pane,
      model: next.model || null,
      effort: next.effort || null,
      tokens: next.tokens !== undefined ? next.tokens : null,
      input: next.input !== undefined ? next.input : null,
      output: next.output !== undefined ? next.output : null,
      cost: next.cost !== undefined ? next.cost : null,
      ctx: next.ctx !== undefined ? next.ctx : null,
      src: 'report',
    });
  } catch {
    // Failure isolation: a failed append never breaks a report.
  }
  return next;
}

// The board's view of a report: null when missing or stale.
function readReport(pane, now = Date.now(), keepLimits = false) {
  if (!validPaneId(pane)) return null;
  const r = readJson(paneFile(pane));
  if (!r || typeof r.at !== 'number') return null;
  if (r.pane !== pane) return null;
  if (now - r.at > MAX_AGE_MS) {
    if (!keepLimits || !r.limits) return null;
    return { pane, at: r.at, limits: r.limits };
  }
  return r;
}

// Delete reports and status events for panes Herdr no longer has, after a 60
// second grace so a pane that reported just before the board's snapshot saw it
// is not lost.
function pruneReports(live, now = Date.now()) {
  const dir = stateDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  const deleted = [];
  for (const name of names) {
    if (name === 'board.json' || !/^[A-Za-z0-9_-]{1,64}\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    const r = readJson(file);
    if (!r || typeof r !== 'object' || !validPaneId(r.pane) || paneFile(r.pane) !== file) continue;
    if (live.has(r.pane)) continue;
    if (typeof r.at === 'number' && now - r.at <= 60000) continue;
    try {
      fs.unlinkSync(file);
      deleted.push(r.pane);
    } catch (e) {
      // another board may have removed it in between
    }
  }
  let events = [];
  try {
    events = fs.readdirSync(path.join(dir, 'events'));
  } catch (e) {
    // no status events yet
  }
  for (const name of events) {
    if (!/^[A-Za-z0-9_-]{1,64}\.json$/.test(name)) continue;
    const file = path.join(dir, 'events', name);
    const r = readJson(file);
    if (!r || typeof r !== 'object' || !validPaneId(r.pane) || eventFile(r.pane) !== file || live.has(r.pane)) continue;
    if (typeof r.at === 'number' && now - r.at <= 60000) continue;
    try {
      fs.unlinkSync(file);
    } catch (e) {
      // removed in between
    }
  }
  return deleted;
}

function helpText() {
  const lines = [USAGE, '', 'flags:'];
  for (const [flag, what] of FLAG_HELP) lines.push(`  ${flag.padEnd(20)} ${what}`);
  return lines.join('\n') + '\n';
}

function main(argv) {
  const p = parseArgs(argv);
  if (p.help) {
    process.stdout.write(helpText());
    return 0;
  }
  if (p.error) {
    process.stderr.write(`crew-board report: ${p.error}\n${USAGE}\n`);
    return 2;
  }
  let values = p.values;
  if (p.from) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch (e) {
      process.stderr.write(`crew-board report: --from ${p.from} needs its JSON on stdin\n`);
      return 2;
    }
    values = { ...FROM[p.from](d || {}), ...values };
  }
  writeReport(p.pane, values);
  return 0;
}

module.exports = {
  parseArgs, fromClaude, fromAgy, writeReport, readReport, pruneReports, main,
  MAX_AGE_MS, USAGE, usagePath, readUsage, appendUsage,
};
