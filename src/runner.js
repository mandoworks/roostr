'use strict';
// roostr run: launch an agent detached and headless, capture everything it
// prints to a per-run log under ~/.roostr/logs/, and keep the run visible on
// the board through ~/.roostr/registry.json. No terminal pane is involved:
// sessions persist on disk and resume later from the stored session id.
//
// Placement follows docs/spawn-policy.md: OVH by default, the Mac only when the
// caller names a reason. Every command runs through spawn with an argv array.
// There is no shell anywhere in this file.

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { spawn } = require('child_process');

const stateDir = require('./state-dir');
const ram = require('./ram');

const KINDS = ['opencode', 'kilo', 'claude', 'agy', 'custom'];
const LOG_DIR_ENV = ['ROOSTR_STATE_DIR', 'CREW_BOARD_STATE_DIR'];
const REGISTRY_ENV = ['ROOSTR_REGISTRY', 'CREW_BOARD_REGISTRY'];
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const TERMINAL_STATES = new Set(['done', 'failed']);

const USAGE = [
  'usage: roostr run --kind <opencode|kilo|claude|agy|custom> --task <text> [--cwd <dir>] [--owner <name>] [--model <m>] [--effort <e>] [--session <id>] [--placement ovh|mac] [--mac-reason <why>] [--json]',
  '       roostr run logs <id> [--lines 40]',
  '       roostr run refresh [--json]',
].join('\n');

// The log directory is shared truth with the rest of Roostr, so it resolves
// through state-dir exactly like sessions and daemon state do.
function logsDir(options = {}) {
  if (options.logsDir) return options.logsDir;
  return stateDir.resolvePath('logs', [], { dirEnvNames: LOG_DIR_ENV });
}

function registryFile(options = {}) {
  if (options.registryFile) return options.registryFile;
  return stateDir.resolvePath('registry.json', REGISTRY_ENV, { dirEnvNames: LOG_DIR_ENV });
}

// Build the argv a headless kind runs under. OpenCode and Kilo use `run` and
// resume with their session id; Claude and Agy take the task positionally.
function buildRunnerCommand(kind, opts = {}) {
  const task = opts.task == null ? '' : String(opts.task);
  const session = opts.session || null;
  const model = opts.model || null;
  const effort = opts.effort || null;
  const args = [];
  let bin;
  switch (kind) {
    case 'opencode':
      bin = 'opencode';
      args.push('run', task);
      if (session) args.push('--session', session);
      if (model) args.push('--model', model);
      break;
    case 'kilo':
      bin = 'kilo';
      args.push('run', task);
      if (session) args.push('--session', session);
      if (model) args.push('--model', model);
      break;
    case 'claude':
      bin = 'claude';
      args.push('-p', task, '--output-format', 'json');
      if (session) args.push('--resume', session);
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);
      break;
    case 'agy':
      bin = 'agy';
      args.push(task);
      if (session) args.push('--conversation', session);
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);
      break;
    case 'custom':
      // A testing and custom-worker escape hatch: the caller already knows the
      // exact argv it wants (for example `node -e <script>`).
      bin = opts.bin;
      if (Array.isArray(opts.args)) args.push(...opts.args);
      break;
    default:
      throw new Error(`unknown kind: ${kind}`);
  }
  return { bin, args };
}

function parseVmRss(text) {
  const m = /^VmRSS:\s+(\d+)\s+kB\s*$/m.exec(String(text));
  return m ? Number(m[1]) : null;
}

// Resident size of a pid in KiB, or null once it has exited. On Linux the cheap
// path reads /proc/<pid>/status; anywhere else, or when that read fails, the
// `ps` census gives the summed RSS of the pid and everything under it.
async function samplePidRssKb(pid, options = {}) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) return null;
  const platform = options.platform || process.platform;
  const readFileSync = options.readFileSync || fs.readFileSync;
  if (platform === 'linux') {
    const procRoot = options.procRoot || '/proc';
    try {
      const status = readFileSync(path.join(procRoot, String(target), 'status'), 'utf8');
      const rss = parseVmRss(status);
      if (rss != null) return rss;
    } catch (e) {
      // A missing status file means the pid is gone; any other read error falls
      // through to the process table so a permission blip is not a death.
      if (e && e.code === 'ENOENT') return null;
    }
  }
  const processTable = options.processTable || ram.processTable;
  let table;
  try {
    table = await processTable();
  } catch {
    return null;
  }
  if (!table || typeof table.has !== 'function') return null;
  return ram.treeRss(table, target);
}

// registry.json is written directly so the runner stands on its own in its
// worktree and works whether or not src/registry.js is present. Reads accept
// both a bare array of workers and an object with a `workers` array, and writes
// preserve whichever container the file already used.
function readRegistry(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { workers: [], container: 'object', extra: {} };
  }
  if (Array.isArray(doc)) return { workers: doc, container: 'array', extra: {} };
  if (doc && Array.isArray(doc.workers)) {
    const extra = { ...doc };
    delete extra.workers;
    return { workers: doc.workers, container: 'object', extra };
  }
  return {
    workers: [],
    container: 'object',
    extra: doc && typeof doc === 'object' ? doc : {},
  };
}

function writeRegistry(file, workers, container = 'object', extra = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const doc = container === 'array' ? workers : { ...extra, workers };
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Non-POSIX filesystems have no chmod; the mode above still applied.
  }
}

function upsertWorker(entry, options = {}) {
  const file = registryFile(options);
  const { workers, container, extra } = readRegistry(file);
  const idx = workers.findIndex((w) => w && w.id === entry.id);
  if (idx >= 0) workers[idx] = { ...workers[idx], ...entry };
  else workers.push(entry);
  writeRegistry(file, workers, container, extra);
  return entry;
}

function newRunId(kind) {
  const base = String(kind || 'run').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 24) || 'run';
  return `${base}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

// A plain space-joined argv, the same shape `ps` prints, so the governor can
// match a live process against what the board shows.
function commandString(bin, args) {
  return [bin, ...args].map((p) => String(p)).join(' ');
}

// Open the log, spawn detached with stdin on /dev/null and stdout/stderr on the
// log, drop the parent's handle, and register the run.
async function spawnHeadless(opts = {}, deps = {}) {
  const placement = opts.placement || 'ovh';
  if (placement !== 'ovh' && placement !== 'mac') {
    return { error: `placement must be ovh or mac (got ${placement})` };
  }
  if (placement === 'mac' && !opts.placementReason) {
    return { error: 'mac placement requires placementReason' };
  }

  const kind = opts.kind;
  const now = deps.now ? deps.now() : new Date();
  const when = now.toISOString();
  const id = opts.id && ID_RE.test(String(opts.id)) ? String(opts.id) : newRunId(kind);

  let built;
  try {
    built = buildRunnerCommand(kind, opts);
  } catch (e) {
    return { error: e.message };
  }
  if (!built.bin) return { error: `kind ${kind} has no binary to run` };
  const { bin, args } = built;

  const dir = logsDir(opts);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const logFile = opts.logFile || path.join(dir, `${id}.log`);
  let logFd;
  try {
    logFd = fs.openSync(logFile, 'a', 0o600);
  } catch (e) {
    return { error: `cannot open log ${logFile}: ${e.message}` };
  }
  try {
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Non-POSIX filesystems have no chmod.
  }

  const spawnFn = deps.spawn || spawn;
  let child;
  try {
    child = spawnFn(bin, args, {
      cwd: opts.cwd || process.cwd(),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      shell: false,
    });
  } catch (e) {
    try {
      fs.closeSync(logFd);
    } catch {
      // The descriptor is already gone.
    }
    return { error: `spawn ${bin}: ${e.message}` };
  }
  // Attach a listener so an async spawn failure cannot crash the parent.
  child.on('error', () => {});
  // The child owns its own duplicate of the descriptor now.
  try {
    fs.closeSync(logFd);
  } catch {
    // Already closed.
  }
  if (!child || !child.pid) return { error: `spawn ${bin}: no pid` };
  child.unref();

  const sample = deps.samplePidRssKb || samplePidRssKb;
  let rssKb = null;
  try {
    rssKb = await sample(child.pid, opts);
  } catch {
    rssKb = null;
  }

  const command = commandString(bin, args);
  const entry = {
    id,
    owner: opts.owner || null,
    orchestrator: opts.orchestrator || null,
    host: opts.host || (placement === 'mac' ? 'mac' : 'ovh'),
    task: opts.task || null,
    session: opts.session || null,
    kind: kind || 'custom',
    pid: child.pid,
    command,
    cwd: opts.cwd || process.cwd(),
    rssKb,
    state: 'working',
    mode: 'headless',
    logFile,
    placement,
    placementReason: opts.placementReason || null,
    model: opts.model || null,
    effort: opts.effort || null,
    lastHeartbeat: when,
    startedAt: when,
    updatedAt: when,
    source: 'reported',
  };
  const write = deps.upsertWorker || upsertWorker;
  write(entry, opts);

  return { id, pid: child.pid, command, logFile, state: 'working' };
}

// The last `lines` lines of a run's log. Bounded to the tail so a noisy run
// never drags the whole file into memory.
function tailLog(id, lines = 40, options = {}) {
  if (!id || !ID_RE.test(String(id))) return '';
  const file = path.join(logsDir(options), `${id}.log`);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const size = fs.fstatSync(fd).size;
    const max = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 256 * 1024;
    const start = Math.max(0, size - max);
    const len = size - start;
    const buf = Buffer.alloc(len);
    if (len > 0) fs.readSync(fd, buf, 0, len, start);
    const rows = buf.toString('utf8').split('\n');
    if (rows.length && rows[rows.length - 1] === '') rows.pop();
    const n = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 40;
    return rows.slice(Math.max(0, rows.length - n)).join('\n');
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed.
    }
  }
}

// Heartbeat every running headless run against the live process table: refresh
// RSS while the pid lives, close it out once the pid is gone.
async function refreshHeadless(options = {}) {
  const file = registryFile(options);
  const { workers, container, extra } = readRegistry(file);
  const processTable = options.processTable || ram.processTable;
  let table;
  try {
    table = await processTable();
  } catch {
    table = new Map();
  }
  const now = options.now ? options.now() : new Date();
  const when = now.toISOString();
  const result = { checked: 0, alive: 0, done: 0, failed: 0, workers: [] };
  let changed = false;
  for (const w of workers) {
    if (!w || w.mode !== 'headless') continue;
    if (TERMINAL_STATES.has(w.state)) continue;
    result.checked += 1;
    const rss = w.pid ? ram.treeRss(table, w.pid) : null;
    if (rss != null) {
      w.rssKb = rss;
      w.lastHeartbeat = when;
      w.updatedAt = when;
      result.alive += 1;
    } else {
      const failed = typeof w.exitCode === 'number' && w.exitCode !== 0;
      w.state = failed ? 'failed' : 'done';
      w.rssKb = 0;
      w.updatedAt = when;
      if (failed) result.failed += 1;
      else result.done += 1;
    }
    changed = true;
    result.workers.push({ id: w.id, pid: w.pid || null, state: w.state, rssKb: w.rssKb });
  }
  if (changed) writeRegistry(file, workers, container, extra);
  return result;
}

function parseRunArgs(argv) {
  const o = {
    kind: null, cwd: null, task: null, owner: null, orchestrator: null, host: null,
    model: null, effort: null, session: null, placement: null, placementReason: null,
    id: null, logFile: null, json: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--kind') {
      o.kind = next();
      if (!o.kind) return { error: '--kind needs a value' };
    } else if (a === '--cwd') {
      o.cwd = next();
      if (!o.cwd) return { error: '--cwd needs a path' };
    } else if (a === '--task') {
      o.task = next();
      if (o.task == null) return { error: '--task needs text' };
    } else if (a === '--owner') {
      o.owner = next();
      if (!o.owner) return { error: '--owner needs a name' };
    } else if (a === '--orchestrator') {
      o.orchestrator = next();
      if (!o.orchestrator) return { error: '--orchestrator needs a name' };
    } else if (a === '--host') {
      o.host = next();
      if (!o.host) return { error: '--host needs a value' };
    } else if (a === '--model' || a === '-m') {
      o.model = next();
      if (!o.model) return { error: '--model needs a value' };
    } else if (a === '--effort' || a === '-e') {
      o.effort = next();
      if (!o.effort) return { error: '--effort needs a value' };
    } else if (a === '--session' || a === '-s') {
      o.session = next();
      if (!o.session) return { error: '--session needs an id' };
    } else if (a === '--placement') {
      o.placement = next();
      if (o.placement !== 'ovh' && o.placement !== 'mac') {
        return { error: '--placement must be ovh or mac' };
      }
    } else if (a === '--mac-reason' || a === '--placement-reason') {
      o.placementReason = next();
      if (!o.placementReason) return { error: `${a} needs a reason` };
    } else if (a === '--id') {
      o.id = next();
      if (!o.id || !ID_RE.test(o.id)) return { error: '--id must be 1-64 of A-Za-z0-9_.:-' };
    } else if (a === '--log-file') {
      o.logFile = next();
      if (!o.logFile) return { error: '--log-file needs a path' };
    } else if (a === '--bin') {
      o.bin = next();
      if (!o.bin) return { error: '--bin needs a path' };
    } else {
      return { error: `unknown option ${a}` };
    }
  }
  return o;
}

function runLogs(argv, options, out, err) {
  let id = null;
  let lines = 40;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lines' || a === '-n') {
      lines = Number(argv[++i]);
      if (!Number.isFinite(lines) || lines <= 0) {
        err.write('roostr run logs: --lines needs a positive number\n');
        return 2;
      }
    } else if (a === '--json') {
      json = true;
    } else if (a === '-h' || a === '--help') {
      out.write(`${USAGE}\n`);
      return 0;
    } else if (!id && !a.startsWith('-')) {
      id = a;
    } else {
      err.write(`roostr run logs: unknown option ${a}\n`);
      return 2;
    }
  }
  if (!id) {
    err.write(`roostr run logs: <id> is required\n${USAGE}\n`);
    return 2;
  }
  const text = tailLog(id, lines, options);
  if (json) out.write(`${JSON.stringify({ id, lines, text }, null, 2)}\n`);
  else out.write(text ? `${text}\n` : '');
  return 0;
}

async function runRefresh(argv, options, out, err) {
  let json = false;
  for (const a of argv) {
    if (a === '--json') json = true;
    else if (a === '-h' || a === '--help') {
      out.write(`${USAGE}\n`);
      return 0;
    } else {
      err.write(`roostr run refresh: unknown option ${a}\n`);
      return 2;
    }
  }
  const result = await refreshHeadless(options);
  if (json) out.write(`${JSON.stringify(result, null, 2)}\n`);
  else out.write(`checked ${result.checked} headless run(s): ${result.alive} alive, ${result.done} done, ${result.failed} failed\n`);
  return 0;
}

async function main(argv = [], options = {}) {
  const out = options.stdout || process.stdout;
  const err = options.stderr || process.stderr;
  const sub = argv[0];
  if (sub === 'logs') return runLogs(argv.slice(1), options, out, err);
  if (sub === 'refresh') return runRefresh(argv.slice(1), options, out, err);

  const o = parseRunArgs(argv);
  if (o.help) {
    out.write(`${USAGE}\n`);
    return 0;
  }
  if (o.error) {
    err.write(`roostr run: ${o.error}\n${USAGE}\n`);
    return 2;
  }
  if (!o.kind) {
    err.write(`roostr run: --kind is required\n${USAGE}\n`);
    return 2;
  }
  if (!KINDS.includes(o.kind)) {
    err.write(`roostr run: --kind must be one of: ${KINDS.join(', ')}\n`);
    return 2;
  }
  if (o.kind !== 'custom' && !o.task) {
    err.write(`roostr run: --task is required for ${o.kind}\n`);
    return 2;
  }

  const result = await spawnHeadless(o, options);
  if (result.error) {
    err.write(`roostr run: ${result.error}\n`);
    return 2;
  }
  if (o.json) out.write(`${JSON.stringify(result, null, 2)}\n`);
  else out.write(`started ${result.id} pid ${result.pid} (headless)\nlog: ${result.logFile}\n`);
  return 0;
}

module.exports = {
  KINDS,
  USAGE,
  logsDir,
  registryFile,
  buildRunnerCommand,
  parseVmRss,
  samplePidRssKb,
  readRegistry,
  writeRegistry,
  spawnHeadless,
  tailLog,
  refreshHeadless,
  main,
};
