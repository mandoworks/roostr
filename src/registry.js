'use strict';
// Standalone worker registry, heartbeat, token auth and closed-session log.
//
// This is the truth Roostr keeps about running agents even when herdr is
// stopped: who is running where, on which host, with which resume handle.
// Everything lives under ~/.roostr/ (registry.json, tokens.json,
// closed-sessions.jsonl) and is written atomically with mode 0600.
//
// Zero external dependencies. All writes go through a temp file + rename so a
// reader never sees half a file.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('node:crypto');
const stateDir = require('./state-dir');

const VALID_STATES = ['working', 'waiting-approval', 'idle', 'done', 'failed'];
const VALID_MODES = ['headless', 'pane'];

// Directory env overrides, checked before the default ~/.roostr/ dir.
const DIR_ENV_NAMES = ['ROOSTR_STATE_DIR', 'CREW_BOARD_STATE_DIR'];

// Fields a caller may patch through updateStatus.
const PATCH_FIELDS = [
  'state', 'task', 'session', 'rssKb', 'pid', 'command',
  'lastHeartbeat', 'updatedAt',
];

// Every field of a worker record, in schema order.
const RECORD_FIELDS = [
  'id', 'owner', 'orchestrator', 'host', 'task', 'session', 'kind', 'pid',
  'command', 'cwd', 'rssKb', 'state', 'mode', 'logFile', 'placement',
  'placementReason', 'model', 'effort', 'lastHeartbeat', 'startedAt',
  'updatedAt', 'source',
];

const USAGE = [
  'usage: roostr registry [--json]',
  '       roostr registry register --id <id> [--owner <name>] [--task <text>] [--host <host>] [--state <state>] [--mode <headless|pane>]',
  '       roostr registry status --id <id> --state <state> [--task <text>] [--session <id>] [--rss-kb <n>] [--pid <n>] [--command <cmd>]',
  '       roostr registry token --label <label>',
].join('\n');

// Resolve one state file. Explicit options win so tests and callers (the board,
// the web bridge, the governor) can point at an isolated dir without touching
// process.env:
//   options.file  an exact path
//   options.dir   a directory holding every file
//   options.env   an env object to read ROOSTR_*/CREW_BOARD_* overrides from
//   otherwise     src/state-dir.js resolvePath (process.env + ~/.roostr/)
function resolveFile(relPath, fileEnvNames, options = {}) {
  if (options.file) return options.file;
  if (options.dir) return path.join(options.dir, relPath);
  const env = options.env;
  if (env) {
    for (const name of fileEnvNames) {
      if (env[name]) return env[name];
    }
    for (const name of DIR_ENV_NAMES) {
      if (env[name]) return path.join(env[name], relPath);
    }
  }
  return stateDir.resolvePath(relPath, fileEnvNames, { dirEnvNames: DIR_ENV_NAMES });
}

function registryFile(options) {
  return resolveFile('registry.json', ['ROOSTR_REGISTRY'], options);
}

function tokensFile(options) {
  return resolveFile('tokens.json', ['ROOSTR_TOKENS'], options);
}

function closedSessionsFile(options) {
  return resolveFile('closed-sessions.jsonl', ['ROOSTR_CLOSED_SESSIONS'], options);
}

// Atomic, owner-only write: temp file in the same dir, chmod 0600, rename.
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* non-POSIX fs */ }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// registry.json is a plain JSON array of worker records. A versioned
// { workers: [...] } object is also understood, so a parallel writer that
// chose that shape is still readable.
function loadRegistry(options = {}) {
  const raw = readJsonFile(registryFile(options), []);
  if (Array.isArray(raw)) return raw.filter(isRecord);
  if (raw && Array.isArray(raw.workers)) return raw.workers.filter(isRecord);
  return [];
}

function saveRegistry(records, options = {}) {
  writeAtomic(registryFile(options), JSON.stringify(records, null, 2) + '\n');
}

function isRecord(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && typeof v.id === 'string' && v.id;
}

function nowMs(options) {
  if (typeof options.now === 'function') return options.now();
  if (typeof options.now === 'number' && Number.isFinite(options.now)) return options.now;
  return Date.now();
}

function finiteInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function textOrNull(v) {
  return typeof v === 'string' && v !== '' ? v : null;
}

function assertState(state) {
  if (state === null || state === undefined) return;
  if (!VALID_STATES.includes(state)) {
    throw new Error(`invalid state: ${String(state)} (expected ${VALID_STATES.join(' | ')})`);
  }
}

function assertMode(mode) {
  if (mode === null || mode === undefined) return;
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`invalid mode: ${String(mode)} (expected ${VALID_MODES.join(' | ')})`);
  }
}

// A short, filesystem-safe, collision-resistant id derived from the kind.
function generateId(payload = {}, now = Date.now()) {
  const base = String(payload.kind || 'worker')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'worker';
  const stamp = now.toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `${base}-${stamp}-${rand}`;
}

// Build a full record from a partial payload, preserving fields already set on
// `existing` when the payload leaves them out.
function normalizeRecord(payload, existing, now) {
  const src = { ...(existing || {}), ...payload };
  const state = src.state === undefined || src.state === null ? 'working' : src.state;
  const mode = src.mode === undefined || src.mode === null ? 'headless' : src.mode;
  assertState(state);
  assertMode(mode);

  const record = {
    id: String(src.id),
    owner: textOrNull(src.owner),
    orchestrator: textOrNull(src.orchestrator),
    host: textOrNull(src.host),
    task: textOrNull(src.task),
    session: textOrNull(src.session),
    kind: textOrNull(src.kind),
    pid: finiteInt(src.pid),
    command: textOrNull(src.command),
    cwd: textOrNull(src.cwd),
    rssKb: finiteInt(src.rssKb),
    state,
    mode,
    logFile: textOrNull(src.logFile),
    placement: textOrNull(src.placement),
    placementReason: textOrNull(src.placementReason),
    model: textOrNull(src.model),
    effort: textOrNull(src.effort),
    lastHeartbeat: textOrNull(src.lastHeartbeat) || new Date(now).toISOString(),
    startedAt: textOrNull((existing && existing.startedAt) || src.startedAt) || new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    source: 'reported',
  };
  // Keep the schema order stable in the file.
  const ordered = {};
  for (const field of RECORD_FIELDS) ordered[field] = record[field];
  return ordered;
}

// Register (or re-register) a worker. Generates an id when omitted, stamps
// startedAt + lastHeartbeat, and persists. Returns the stored record.
function registerWorker(payload = {}, options = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('registerWorker requires a payload object');
  }
  const now = nowMs(options);
  const records = loadRegistry(options);
  let id = textOrNull(payload.id);
  if (!id) {
    id = generateId(payload, now);
    while (records.some((r) => r.id === id)) id = generateId(payload, now + 1);
  }
  const index = records.findIndex((r) => r.id === id);
  const existing = index >= 0 ? records[index] : null;
  const record = normalizeRecord({ ...payload, id }, existing, now);
  if (index >= 0) records[index] = record;
  else records.push(record);
  saveRegistry(records, options);
  return record;
}

// Patch a live worker: state, task, session, rssKb, pid, command and the two
// heartbeat stamps. Unknown ids return null. Invalid states throw.
function updateStatus(id, patch = {}, options = {}) {
  const records = loadRegistry(options);
  const index = records.findIndex((r) => r.id === id);
  if (index < 0) return null;
  const now = nowMs(options);
  const next = { ...records[index] };
  for (const field of PATCH_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    if (patch[field] === undefined) continue;
    if (field === 'state') {
      assertState(patch.state);
      next.state = patch.state;
    } else if (field === 'pid' || field === 'rssKb') {
      next[field] = finiteInt(patch[field]);
    } else {
      next[field] = textOrNull(patch[field]);
    }
  }
  next.lastHeartbeat = textOrNull(patch.lastHeartbeat) || new Date(now).toISOString();
  next.updatedAt = textOrNull(patch.updatedAt) || new Date(now).toISOString();
  records[index] = next;
  saveRegistry(records, options);
  return next;
}

// All workers, sorted by startedAt then id for a stable listing.
function listWorkers(options = {}) {
  const records = loadRegistry(options).slice();
  const cmp = (a, b) => {
    const sa = a.startedAt || '';
    const sb = b.startedAt || '';
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  records.sort(cmp);
  return records;
}

function getWorker(id, options = {}) {
  if (typeof id !== 'string' || !id) return null;
  return loadRegistry(options).find((r) => r.id === id) || null;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function loadTokens(options = {}) {
  const raw = readJsonFile(tokensFile(options), []);
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.tokens)) return raw.tokens;
  return [];
}

function saveTokens(tokens, options = {}) {
  writeAtomic(tokensFile(options), JSON.stringify(tokens, null, 2) + '\n');
}

// Issue a token. Only the SHA-256 hex digest is stored; the raw value is
// returned once for the caller to hand to the agent. Re-issuing a label rotates
// it, so a leaked token can be replaced without a rename.
function issueToken(label, options = {}) {
  const name = textOrNull(label);
  if (!name) throw new Error('issueToken requires a label');
  const now = nowMs(options);
  const token = typeof options.token === 'string' && options.token
    ? options.token
    : crypto.randomBytes(24).toString('hex');
  const entry = { label: name, hash: sha256Hex(token), createdAt: new Date(now).toISOString() };
  const tokens = loadTokens(options).filter((t) => t && t.label !== name);
  tokens.push(entry);
  saveTokens(tokens, options);
  return { label: name, token, hash: entry.hash, createdAt: entry.createdAt };
}

// Constant-time verification of a raw X-Roostr-Token value against every
// stored digest.
function verifyToken(rawToken, options = {}) {
  if (typeof rawToken !== 'string' || rawToken === '') return false;
  const digest = Buffer.from(sha256Hex(rawToken), 'utf8');
  for (const entry of loadTokens(options)) {
    if (!entry || typeof entry.hash !== 'string') continue;
    const stored = Buffer.from(entry.hash, 'utf8');
    if (stored.length === digest.length && crypto.timingSafeEqual(stored, digest)) return true;
  }
  return false;
}

// Append one closed-session record to the jsonl log.
function appendClosedSession(entry = {}, options = {}) {
  const now = nowMs(options);
  const record = {
    at: textOrNull(entry.at) || new Date(now).toISOString(),
    id: textOrNull(entry.id),
    pid: finiteInt(entry.pid),
    command: textOrNull(entry.command),
    model: textOrNull(entry.model),
    ramKb: finiteInt(entry.ramKb),
    session: textOrNull(entry.session),
    paneId: textOrNull(entry.paneId),
    workspaceId: textOrNull(entry.workspaceId),
    reason: textOrNull(entry.reason),
  };
  const file = closedSessionsFile(options);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX fs */ }
  return record;
}

// Every closed-session record, oldest first. Bad lines are skipped.
function readClosedSessions(options = {}) {
  const file = closedSessionsFile(options);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip a torn line */ }
  }
  return out;
}

// --- CLI -------------------------------------------------------------------

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { flags.json = true; continue; }
    if (a === '-h' || a === '--help') { flags.help = true; continue; }
    if (a.startsWith('--')) {
      let key;
      let val;
      const eq = a.indexOf('=');
      if (eq > 0) {
        key = a.slice(2, eq);
        val = a.slice(eq + 1);
      } else {
        key = a.slice(2);
        val = argv[i + 1];
        if (val === undefined || val.startsWith('--')) return { error: `${a} needs a value` };
        i++;
      }
      flags[key] = val;
      continue;
    }
    flags._.push(a);
  }
  return flags;
}

// Strip undefined keys so a merge never clobbers an existing value with null.
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function printWorkerLine(w) {
  return [
    w.id,
    `state=${w.state}`,
    `mode=${w.mode}`,
    `host=${w.host || '-'}`,
    `owner=${w.owner || '-'}`,
    `task=${w.task || '-'}`,
  ].join(' ');
}

function main(argv = [], deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const options = deps.dir ? { dir: deps.dir } : (deps.env ? { env: deps.env } : {});
  const args = Array.isArray(argv) ? argv : [];
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'list';
  const rest = sub === 'list' ? args : args.slice(1);
  const flags = parseFlags(rest);

  if (flags.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (flags.error) {
    stderr.write(`roostr registry: ${flags.error}\n`);
    return 2;
  }

  try {
    if (sub === 'list') {
      const workers = listWorkers(options);
      if (flags.json) {
        stdout.write(JSON.stringify(workers, null, 2) + '\n');
      } else if (workers.length === 0) {
        stdout.write('no registered workers\n');
      } else {
        stdout.write(workers.map(printWorkerLine).join('\n') + '\n');
      }
      return 0;
    }

    if (sub === 'register') {
      const payload = compact({
        id: flags.id,
        owner: flags.owner,
        orchestrator: flags.orchestrator,
        host: flags.host,
        task: flags.task,
        session: flags.session,
        kind: flags.kind,
        pid: flags.pid,
        command: flags.command,
        cwd: flags.cwd,
        rssKb: flags['rss-kb'],
        state: flags.state,
        mode: flags.mode,
        logFile: flags['log-file'],
        placement: flags.placement,
        placementReason: flags['placement-reason'],
        model: flags.model,
        effort: flags.effort,
      });
      const record = registerWorker(payload, options);
      if (flags.json) stdout.write(JSON.stringify(record, null, 2) + '\n');
      else stdout.write(`registered ${record.id} state=${record.state} mode=${record.mode}\n`);
      return 0;
    }

    if (sub === 'status') {
      if (!flags.id) {
        stderr.write('roostr registry: status needs --id\n');
        return 2;
      }
      if (!flags.state) {
        stderr.write('roostr registry: status needs --state\n');
        return 2;
      }
      const patch = compact({
        state: flags.state,
        task: flags.task,
        session: flags.session,
        pid: flags.pid,
        command: flags.command,
        rssKb: flags['rss-kb'],
      });
      const record = updateStatus(flags.id, patch, options);
      if (!record) {
        stderr.write(`roostr registry: unknown worker ${flags.id}\n`);
        return 1;
      }
      if (flags.json) stdout.write(JSON.stringify(record, null, 2) + '\n');
      else stdout.write(`updated ${record.id} state=${record.state}\n`);
      return 0;
    }

    if (sub === 'token') {
      if (!flags.label) {
        stderr.write('roostr registry: token needs --label\n');
        return 2;
      }
      const issued = issueToken(flags.label, options);
      if (flags.json) stdout.write(JSON.stringify({ label: issued.label, token: issued.token, createdAt: issued.createdAt }, null, 2) + '\n');
      else stdout.write(`token ${issued.label} ${issued.token}\n`);
      return 0;
    }

    stderr.write(`roostr registry: unknown subcommand ${sub}\n`);
    return 2;
  } catch (err) {
    stderr.write(`roostr registry: ${err.message}\n`);
    return 1;
  }
}

module.exports = {
  VALID_STATES,
  VALID_MODES,
  registerWorker,
  updateStatus,
  listWorkers,
  getWorker,
  issueToken,
  verifyToken,
  appendClosedSession,
  readClosedSessions,
  main,
  // Exposed for tests and sibling modules that need the resolved paths.
  registryFile,
  tokensFile,
  closedSessionsFile,
  USAGE,
};
