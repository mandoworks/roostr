'use strict';
// The crew file: an optional `.crew-board.toml` in a project root.
//
// crew-board has zero dependencies, so this file carries a minimal TOML subset
// reader: comments, bare keys, [table], [[array of tables]], basic and literal
// strings, integers, floats, booleans, and single or multi line arrays of
// those. Anything else is a parse error with a line number, never a silent
// misread.
//
//   name = "example crew"          # shown in the board header
//   [board]
//   tags = "tokens"                # tokens | label | metadata | off
//   budget = 5                     # dollars per pane (default for every pane)
//   daily_budget = 40              # dollars per day, all agents (needs tokscale)
//   [[check]]                      # crew wide badge in the header
//   name = "Blender"
//   run  = "pgrep -x Blender"
//   [[pane]]                       # per pane extras, matched by label name
//   name   = "docs"
//   model  = "sonnet"
//   report = "agents/docs/report.md"
//   checks = ["TESTS GREEN: test -f .tests-passed"]
//   budget = 2                     # this pane's own cap, in dollars

const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ui = require('./ui');
const config = require('./config');

const FILE_NAMES = ['.roostr.toml', '.crew-board.toml'];
const FILE_NAME = '.roostr.toml';

class TomlError extends Error {
  constructor(msg, line) {
    super(`line ${line}: ${msg}`);
    this.line = line;
  }
}

function parseToml(text) {
  const root = Object.create(null);
  let cur = root;
  const lines = String(text).split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const lineNo = i + 1;
    const line = stripComment(lines[i]).trim();
    i++;
    if (line === '') continue;

    let m;
    if ((m = /^\[\[\s*([A-Za-z0-9_-]+)\s*\]\]$/.exec(line))) {
      const key = m[1];
      if (!Object.prototype.hasOwnProperty.call(root, key)) root[key] = [];
      if (!Array.isArray(root[key])) throw new TomlError(`"${key}" is not an array of tables`, lineNo);
      cur = Object.create(null);
      root[key].push(cur);
      continue;
    }
    if ((m = /^\[\s*([A-Za-z0-9_.-]+)\s*\]$/.exec(line))) {
      const name = m[1];
      const segments = name.split('.');
      if (segments.some((s) => s === '')) throw new TomlError('unsupported table header', lineNo);
      let node = root;
      for (let k = 0; k < segments.length; k++) {
        const seg = segments[k];
        const last = k === segments.length - 1;
        const has = Object.prototype.hasOwnProperty.call(node, seg);
        if (last) {
          if (has) {
            const v = node[seg];
            if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
              throw new TomlError(`table "${name}" defined twice`, lineNo);
            }
            throw new TomlError(`table "${name}" conflicts with an existing value`, lineNo);
          }
          cur = node[seg] = Object.create(null);
        } else {
          if (!has) node[seg] = Object.create(null);
          else if (node[seg] === null || typeof node[seg] !== 'object' || Array.isArray(node[seg])) {
            throw new TomlError(`table "${name}" conflicts with an existing value`, lineNo);
          }
          node = node[seg];
        }
      }
      continue;
    }
    if (line.startsWith('[')) throw new TomlError('unsupported table header', lineNo);

    m = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!m) throw new TomlError('expected key = value', lineNo);
    const key = m[1];
    let raw = m[2];
    // A multi line array keeps reading until its brackets balance.
    if (raw.startsWith('[')) {
      while (!bracketsClosed(raw)) {
        if (i >= lines.length) throw new TomlError('unterminated array', lineNo);
        raw += '\n' + stripComment(lines[i]);
        i++;
      }
    }
    if (Object.prototype.hasOwnProperty.call(cur, key)) throw new TomlError(`key "${key}" defined twice`, lineNo);
    const { value, rest } = parseValue(raw.trim(), lineNo);
    if (rest.trim() !== '') throw new TomlError(`unexpected text after value: ${rest.trim()}`, lineNo);
    cur[key] = value;
  }
  return root;
}

// Drop a trailing # comment, ignoring # inside strings.
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (q === '"' && c === '\\') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function bracketsClosed(s) {
  let depth = 0;
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === '\\') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
  }
  return depth <= 0;
}

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

function parseValue(s, lineNo) {
  if (s.startsWith('"')) {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (c === '"') return { value: out, rest: s.slice(i + 1) };
      if (c === '\n') break;
      if (c === '\\') {
        const e = s[++i];
        if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) {
          out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
          i += 4;
        } else if (ESCAPES[e] !== undefined) out += ESCAPES[e];
        else throw new TomlError(`bad escape \\${e}`, lineNo);
      } else out += c;
    }
    throw new TomlError('unterminated string', lineNo);
  }
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1);
    if (end < 0 || s.slice(1, end).includes('\n')) throw new TomlError('unterminated string', lineNo);
    return { value: s.slice(1, end), rest: s.slice(end + 1) };
  }
  if (s.startsWith('[')) {
    const arr = [];
    let rest = s.slice(1);
    for (;;) {
      rest = rest.replace(/^[\s\n]+/, '');
      if (rest.startsWith(']')) return { value: arr, rest: rest.slice(1) };
      const v = parseValue(rest, lineNo);
      if (Array.isArray(v.value)) throw new TomlError('nested arrays are not supported', lineNo);
      arr.push(v.value);
      rest = v.rest.replace(/^[\s\n]+/, '');
      if (rest.startsWith(',')) rest = rest.slice(1);
      else if (!rest.startsWith(']')) throw new TomlError('expected , or ] in array', lineNo);
    }
  }
  let m;
  if ((m = /^(true|false)(?![A-Za-z0-9_])/.exec(s))) return { value: m[1] === 'true', rest: s.slice(m[0].length) };
  if ((m = /^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?(?![A-Za-z0-9_.])/.exec(s))) {
    return { value: Number(m[0].replace(/_/g, '')), rest: s.slice(m[0].length) };
  }
  throw new TomlError(`unsupported value: ${s.split('\n')[0]}`, lineNo);
}

// ------------------------------------------------------------- crew model

// "LABEL: command args" -> { name, run }. The label is what the badge shows.
function parseCheckString(s) {
  const m = /^\s*([^:]+?)\s*:\s*(.+?)\s*$/.exec(String(s));
  if (!m) return null;
  const name = cleanText(m[1]);
  return name ? { name, run: m[2] } : null;
}

function str(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

// Names are untrusted text: ui.clean drops control characters and
// invisible direction marks, so they cannot hide or reorder what the board shows.
function cleanText(v) {
  return ui.clean(v).trim();
}

// A budget in dollars: a positive number, else none.
function money(v) {
  return typeof v === 'number' && v > 0 ? v : null;
}

// Turn parsed TOML into the crew model, resolving paths against the crew file.
function toCrew(data, file) {
  const dir = path.dirname(file);
  const table = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const board = table(data.board);
  const checks = table(data.checks);
  const secretary = table(data.secretary);
  const explabs = table(table(data.providers).explabs);
  const analytics = table(data.analytics);
  const taskKinds = table(data.tasks);
  const daemon = table(data.daemon);
  const daemonLadder = table(daemon.ladder);
  const tiers = table(data.tiers);
  const grill = table(data.grill);
  const known = (v, allowed) => v === undefined || allowed.includes(v);

  const tagScope = board.tag_scope === 'here' || board.tag_scope === 'all' ? board.tag_scope : 'here';
  const concurrencyOk = Number.isInteger(checks.concurrency) && checks.concurrency >= 1 && checks.concurrency <= 8;
  const checkConcurrency = concurrencyOk ? checks.concurrency : 3;
  const timeoutOk = typeof checks.timeout_seconds === 'number'
    && Number.isFinite(checks.timeout_seconds)
    && checks.timeout_seconds >= 1
    && checks.timeout_seconds <= 10;
  const checkTimeoutMs = timeoutOk ? Math.round(checks.timeout_seconds * 1000) : 2000;
  const secretaryAuto = typeof secretary.auto === 'boolean' ? secretary.auto : null;
  const intervalOk = typeof secretary.interval_seconds === 'number'
    && Number.isFinite(secretary.interval_seconds)
    && secretary.interval_seconds >= 60
    && secretary.interval_seconds <= 3600;
  const secretaryIntervalMs = intervalOk ? Math.round(secretary.interval_seconds * 1000) : null;
  const secretaryScope = secretary.scope === 'workspace' || secretary.scope === 'all' ? secretary.scope : null;
  const explabsEnabled = typeof explabs.enabled === 'boolean' ? explabs.enabled : false;

  const rotationDaysOk = typeof analytics.rotation_days === 'number'
    && Number.isFinite(analytics.rotation_days)
    && analytics.rotation_days > 0;
  const rotationDays = rotationDaysOk ? analytics.rotation_days : null;

  const grillRunnerOk = ['recommended', 'none', 'custom'].includes(grill.runner);
  const grillRunner = grillRunnerOk ? grill.runner : null;
  const grillSkill = str(grill.skill) ? cleanText(grill.skill) : null;
  const grillCommand = str(grill.command) ? cleanText(grill.command) : null;

  const crew = {
    file,
    dir,
    name: str(data.name) ? cleanText(data.name) : null,
    tags: ['tokens', 'label', 'metadata', 'off'].includes(board.tags) ? board.tags : null,
    budget: money(board.budget),
    dailyBudget: money(board.daily_budget),
    tagScope,
    checkConcurrency,
    checkTimeoutMs,
    secretaryAuto,
    secretaryIntervalMs,
    secretaryScope,
    explabsEnabled,
    rotationDays,
    grill: {
      runner: grillRunner || 'none',
      skill: grillSkill,
      command: grillCommand,
    },
    daemon: {
      wakeCounting: ['per-event', 'per-digest'].includes(daemon.wake_counting) ? daemon.wake_counting : null,
      ladder: {
        nudgeSeconds: typeof daemonLadder.nudge_seconds === 'number' && daemonLadder.nudge_seconds > 0 ? daemonLadder.nudge_seconds : null,
        recycleSeconds: typeof daemonLadder.recycle_seconds === 'number' && daemonLadder.recycle_seconds > 0 ? daemonLadder.recycle_seconds : null,
        escalateSeconds: typeof daemonLadder.escalate_seconds === 'number' && daemonLadder.escalate_seconds > 0 ? daemonLadder.escalate_seconds : null,
      },
    },
    tiers: Object.create(null),
    checks: [],
    panes: Object.create(null),
    taskKinds: Object.create(null),
    errors: [],
  };
  if (!known(board.tag_scope, ['here', 'all'])) crew.errors.push('[board] tag_scope must be "here" or "all"');
  if (analytics.rotation_days !== undefined && !rotationDaysOk) {
    crew.errors.push('[analytics] rotation_days must be a positive number');
  }
  if (checks.concurrency !== undefined && !concurrencyOk) {
    crew.errors.push('[checks] concurrency must be 1..8');
  }
  if (checks.timeout_seconds !== undefined && !timeoutOk) {
    crew.errors.push('[checks] timeout_seconds must be 1..10');
  }
  if (secretary.auto !== undefined && typeof secretary.auto !== 'boolean') {
    crew.errors.push('[secretary] auto must be true or false');
  }
  if (secretary.interval_seconds !== undefined && secretaryIntervalMs === null) {
    crew.errors.push('[secretary] interval_seconds must be 60..3600');
  }
  if (secretary.scope !== undefined && secretaryScope === null) {
    crew.errors.push('[secretary] scope must be "workspace" or "all"');
  }
  if (explabs.enabled !== undefined && typeof explabs.enabled !== 'boolean') {
    crew.errors.push('[providers.explabs] enabled must be true or false');
  }
  if (grill.runner !== undefined && !grillRunnerOk) {
    crew.errors.push('[grill] runner must be "recommended", "none", or "custom"');
  }
  if (grillRunner === 'custom' && !grillSkill && !grillCommand) {
    crew.errors.push('[grill] custom runner requires skill or command');
  }
  for (const [tName, val] of Object.entries(tiers)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      crew.tiers[tName] = {
        model: str(val.model) ? cleanText(val.model) : null,
        effort: str(val.effort) ? cleanText(val.effort) : null,
        tool: str(val.tool) ? cleanText(val.tool) : null,
      };
    }
  }
  for (const [kind, value] of Object.entries(taskKinds)) {
    if (!config.TASK_KINDS.includes(kind)) {
      crew.errors.push(`[tasks.${kind}] unknown task kind; use ${config.TASK_KINDS.join(', ')}`);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      crew.errors.push(`[tasks.${kind}] must be a table`);
      continue;
    }
    const out = Object.create(null);
    if (value.tool !== undefined) {
      const tool = str(value.tool);
      if (!tool) crew.errors.push(`[tasks.${kind}] tool must be a non-empty string`);
      else out.tool = cleanText(tool);
    }
    if (value.model !== undefined) {
      const model = str(value.model);
      if (!model) crew.errors.push(`[tasks.${kind}] model must be a non-empty string`);
      else out.model = cleanText(model);
    }
    if (value.fallbacks !== undefined) {
      if (!Array.isArray(value.fallbacks)) crew.errors.push(`[tasks.${kind}] fallbacks must be an array`);
      else {
        const list = [];
        for (const item of value.fallbacks) {
          const model = str(item);
          if (!model) crew.errors.push(`[tasks.${kind}] fallback models must be non-empty strings`);
          else if (!list.includes(cleanText(model)) && list.length < 5) list.push(cleanText(model));
        }
        out.fallbacks = list;
      }
    }
    if (value.effort !== undefined) {
      const effort = str(value.effort);
      if (!config.EFFORTS.includes(effort)) crew.errors.push(`[tasks.${kind}] effort must be low, medium, high, xhigh or max`);
      else out.effort = effort;
    }
    crew.taskKinds[kind] = out;
  }
  for (const c of Array.isArray(data.check) ? data.check : []) {
    const name = str(c.name) ? cleanText(c.name) : '';
    if (name && str(c.run)) crew.checks.push({ name, run: c.run });
    else crew.errors.push('[[check]] needs name and run');
  }
  for (const p of Array.isArray(data.pane) ? data.pane : []) {
    if (!str(p.name)) {
      crew.errors.push('[[pane]] needs a name');
      continue;
    }
    const checks = [];
    for (const s of Array.isArray(p.checks) ? p.checks : []) {
      const c = parseCheckString(s);
      if (c) checks.push(c);
      else crew.errors.push(`pane "${p.name}": check "${s}" is not "LABEL: command"`);
    }
// A report path is only a note in the crew folder: a path outside it could
    // make the board reveal anything on disk.
    let report = null;
    if (str(p.report)) {
      const root = path.resolve(dir);
      try {
        const resolved = path.resolve(dir, p.report);
        const inside = (base, target) => target === base || target.startsWith(base + path.sep);
        // A report may not exist yet. Resolve the root when possible, and
        // resolve the target only when it exists, so a symlink cannot escape
        // the crew folder but a future report still validates.
        const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
        const exists = fs.existsSync(resolved);
        const realResolved = exists ? fs.realpathSync(resolved) : resolved;
        if (inside(realRoot, realResolved) || (!exists && inside(root, resolved))) {
          report = realResolved;
        } else {
          crew.errors.push(`pane "${p.name}": report must be inside the crew folder`);
        }
      } catch (e) {
        crew.errors.push(`pane "${p.name}": report path invalid or inaccessible`);
      }
    }
    crew.panes[p.name] = {
      name: p.name,
      model: str(p.model),
      report,
      budget: money(p.budget),
      checks,
    };
  }
  return crew;
}

// Walk up from `dir` to find a crew file. The walk stops at the repo root (a
// directory holding .git) or the home directory, whichever comes first. With
// neither above it (say /tmp/x), only the pane's own directory counts, so a
// file dropped in /tmp or / is never picked up. The file must belong to you
// and not be writable by group or others: it runs commands.
function findCrewFile(dir) {
  const home = os.homedir();
  const start = path.resolve(dir || '.');
  let found = null;
  let d = start;
  for (;;) {
    for (const name of FILE_NAMES) {
      const f = path.join(d, name);
      if (!found && fs.existsSync(f)) {
        try {
          const realF = fs.realpathSync(f);
          const realD = fs.realpathSync(d);
          if (realF.startsWith(realD + path.sep) || realF === path.join(realD, name)) {
            found = realF;
            break;
          }
        } catch (e) {
          // skip if cannot resolve
        }
      }
    }
    if (d === home || fs.existsSync(path.join(d, '.git'))) break;
    const up = path.dirname(d);
    if (up === d) {
      if (found) {
        try {
          if (path.dirname(found) !== fs.realpathSync(start)) found = null;
        } catch (e) {
          if (path.dirname(found) !== start) found = null;
        }
      }
      break;
    }
    d = up;
  }
  return found && safeToRun(found) ? found : null;
}



function safeToRun(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return false;
    const st2 = fs.statSync(file);
    const mine = typeof process.getuid !== 'function' || st2.uid === process.getuid();
    return mine && (st2.mode & 0o022) === 0;
  } catch (e) {
    return false;
  }
}

const cache = new Map(); // file -> { mtimeMs, crew }

// Load (and cache by mtime) a crew file. A broken file yields a crew with an
// error so the board can say so instead of crashing.
function loadCrew(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.crew;
  let crew;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
    crew = toCrew(parseToml(text), file);
  } catch (e) {
    crew = toCrew({}, file);
    crew.errors.push(e.message);
  }
  // What a trust grant pins: any edit to the file needs a new one.
  crew.hash = crypto.createHash('sha256').update(text).digest('hex');
  cache.set(file, { mtimeMs: st.mtimeMs, crew });
  return crew;
}

function canonicalizePath(p) {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) {
    return fs.realpathSync(abs);
  }
  const parent = path.dirname(abs);
  if (parent === abs) return abs;
  return path.join(canonicalizePath(parent), path.basename(abs));
}

function verifySafePath(targetPath, baseDir) {
  const realBase = canonicalizePath(baseDir);
  const targetDir = path.dirname(path.resolve(targetPath));
  const realTargetDir = canonicalizePath(targetDir);
  const safeDir = realTargetDir === realBase || realTargetDir.startsWith(realBase + path.sep);
  if (!safeDir) {
    throw new Error(`path escapes base directory: ${targetPath}`);
  }
  if (fs.existsSync(targetPath)) {
    const realFile = fs.realpathSync(targetPath);
    if (realFile !== realBase && !realFile.startsWith(realBase + path.sep)) {
      throw new Error(`path escapes base directory: ${targetPath}`);
    }
  }
  return true;
}

function writeCrewJson(workspaceDir, crewData) {
  const targetDir = path.join(workspaceDir, '.herdr');
  const targetFile = path.join(targetDir, 'crew.json');
  verifySafePath(targetFile, workspaceDir);
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(targetFile, JSON.stringify(crewData, null, 2) + '\n', { mode: 0o600 });
  return targetFile;
}

module.exports = { FILE_NAME, parseToml, parseCheckString, toCrew, findCrewFile, safeToRun, loadCrew, TomlError, verifySafePath, writeCrewJson };
