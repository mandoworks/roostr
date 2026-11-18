'use strict';

// Standalone worker registry bridge for the Roostr dashboard.
//
// Reads and writes the shared Roostr state under roostrStateDir:
//   registry.json         worker records (reported truth)
//   tokens.json           SHA-256 hashed X-Roostr-Token digests
//   closed-sessions.jsonl append-only reap/idle-close log
//   logs/<id>.log         per-worker headless output
//
// Zero external dependencies. Every write is atomic and mode 0600.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const SINGLE_LINE_CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/;

const VALID_STATES = new Set(['working', 'waiting-approval', 'idle', 'done', 'failed']);
const VALID_MODES = new Set(['headless', 'pane']);
const DEFAULT_STATE = 'working';
const DEFAULT_MODE = 'headless';

const DEFAULT_LOG_LINES = 40;
const MAX_LOG_LINES = 500;
const CLOSED_SESSIONS_READ_LIMIT = 100;
const MAX_CLOSED_SESSION_BYTES = 1024 * 1024;

// Field name to maximum length for single-line string fields.
const STRING_FIELDS = [
  ['owner', 64],
  ['orchestrator', 64],
  ['host', 64],
  ['task', 512],
  ['session', 256],
  ['kind', 32],
  ['command', 2048],
  ['logFile', 512],
  ['cwd', 512],
  ['placement', 32],
  ['placementReason', 256],
  ['model', 128],
  ['effort', 16],
  ['paneId', 128],
  ['workspaceId', 128],
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function registryPaths(roostrStateDir) {
  const dir = typeof roostrStateDir === 'string' ? roostrStateDir.trim() : '';
  return {
    dir,
    registryPath: dir ? path.join(dir, 'registry.json') : '',
    tokensPath: dir ? path.join(dir, 'tokens.json') : '',
    closedSessionsPath: dir ? path.join(dir, 'closed-sessions.jsonl') : '',
    logsDir: dir ? path.join(dir, 'logs') : '',
  };
}

function readJsonSafe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, doc, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`
  );
  const body = JSON.stringify(doc, null, 2) + '\n';
  try {
    fs.writeFileSync(tmpPath, body, { encoding: 'utf8', mode });
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors.
    }
    throw err;
  }
}

function appendLine(filePath, line, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const exists = fs.existsSync(filePath);
  fs.appendFileSync(filePath, line, { encoding: 'utf8', mode });
  if (!exists) {
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      // Ignore chmod errors on non-POSIX filesystems.
    }
  }
}

function normalizeId(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'id must be a string' };
  }
  const id = raw.trim();
  if (!ID_RE.test(id)) {
    return { ok: false, error: 'invalid worker id' };
  }
  return { ok: true, value: id };
}

function isValidWorkerId(raw) {
  return normalizeId(raw).ok;
}

function generateId() {
  return `w_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken), 'utf8').digest('hex');
}

function normalizeCommand(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (SINGLE_LINE_CONTROL_RE.test(trimmed)) return null;
  return trimmed;
}

function normalizeState(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string' || !VALID_STATES.has(raw.trim())) {
    return { ok: false, error: 'invalid state' };
  }
  return { ok: true, value: raw.trim() };
}

function normalizeMode(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string' || !VALID_MODES.has(raw.trim())) {
    return { ok: false, error: 'invalid mode' };
  }
  return { ok: true, value: raw.trim() };
}

function pickString(body, existing, key, maxLen) {
  const current = existing && existing[key] !== undefined ? existing[key] : null;
  if (body[key] === undefined || body[key] === null || body[key] === '') {
    return { ok: true, value: current };
  }
  if (typeof body[key] !== 'string') {
    return { ok: false, error: `${key} must be a string` };
  }
  const trimmed = body[key].trim();
  if (SINGLE_LINE_CONTROL_RE.test(trimmed)) {
    return { ok: false, error: `${key} contains disallowed control characters` };
  }
  if (trimmed.length > maxLen) {
    return { ok: false, error: `${key} exceeds ${maxLen} characters` };
  }
  return { ok: true, value: trimmed || null };
}

function pickNumber(body, existing, key, { integer = false } = {}) {
  const current = existing && existing[key] !== undefined ? existing[key] : null;
  if (body[key] === undefined || body[key] === null || body[key] === '') {
    return { ok: true, value: current };
  }
  const num = typeof body[key] === 'number' ? body[key] : Number(body[key]);
  if (!Number.isFinite(num) || num < 0) {
    return { ok: false, error: `${key} must be a non-negative number` };
  }
  if (integer && !Number.isInteger(num)) {
    return { ok: false, error: `${key} must be an integer` };
  }
  return { ok: true, value: num };
}

function readWorkers(registryPath) {
  const doc = readJsonSafe(registryPath);
  if (!doc) return [];
  if (Array.isArray(doc)) {
    return doc.filter(isPlainObject);
  }
  if (Array.isArray(doc.workers)) {
    return doc.workers.filter(isPlainObject);
  }
  if (Array.isArray(doc.entries)) {
    return doc.entries.filter(isPlainObject);
  }
  return [];
}

function writeRegistry(registryPath, workers) {
  const existing = readJsonSafe(registryPath);
  let doc;
  if (Array.isArray(existing)) {
    doc = workers;
  } else {
    doc = {
      schema: existing && Number.isFinite(existing.schema) ? existing.schema : 1,
      updatedAt: new Date().toISOString(),
      workers,
    };
  }
  writeJsonAtomic(registryPath, doc, 0o600);
}

function buildWorkerRecord(body, existing, nowIso) {
  const record = {
    id: '',
    owner: null,
    orchestrator: null,
    host: null,
    task: null,
    session: null,
    kind: null,
    pid: null,
    command: null,
    rssKb: null,
    state: (existing && existing.state) || DEFAULT_STATE,
    mode: (existing && existing.mode) || DEFAULT_MODE,
    logFile: null,
    source: 'reported',
    startedAt: (existing && existing.startedAt) || nowIso,
    lastHeartbeat: nowIso,
    updatedAt: nowIso,
  };

  for (const [key, maxLen] of STRING_FIELDS) {
    const picked = pickString(body, existing, key, maxLen);
    if (!picked.ok) return { ok: false, error: picked.error };
    record[key] = picked.value;
  }

  const pid = pickNumber(body, existing, 'pid', { integer: true });
  if (!pid.ok) return { ok: false, error: pid.error };
  record.pid = pid.value;

  const rssKb = pickNumber(body, existing, 'rssKb', { integer: false });
  if (!rssKb.ok) return { ok: false, error: rssKb.error };
  record.rssKb = rssKb.value;

  const state = normalizeState(body.state);
  if (!state.ok) return { ok: false, error: state.error };
  if (state.value) record.state = state.value;

  const mode = normalizeMode(body.mode);
  if (!mode.ok) return { ok: false, error: mode.error };
  if (mode.value) record.mode = mode.value;

  // There is no private key to carry; rebuild in a stable field order.
  for (const [key] of STRING_FIELDS) {
    if (record[key] === undefined) record[key] = null;
  }

  return { ok: true, value: record };
}

function upsertWorker(roostrStateDir, body, { requireExisting = false } = {}) {
  const paths = registryPaths(roostrStateDir);
  if (!paths.dir) {
    return { ok: false, status: 500, error: 'roostrStateDir not configured' };
  }
  if (!isPlainObject(body)) {
    return { ok: false, status: 400, error: 'body must be an object' };
  }

  let id = null;
  if (body.id !== undefined && body.id !== null && body.id !== '') {
    const idCheck = normalizeId(body.id);
    if (!idCheck.ok) {
      return { ok: false, status: 400, error: idCheck.error };
    }
    id = idCheck.value;
  } else if (requireExisting) {
    return { ok: false, status: 400, error: 'id is required' };
  } else {
    id = generateId();
  }

  const workers = readWorkers(paths.registryPath);
  const index = workers.findIndex((w) => w.id === id);
  const existing = index >= 0 ? workers[index] : null;

  if (requireExisting && !existing) {
    return { ok: false, status: 404, error: 'worker not found' };
  }

  const nowIso = new Date().toISOString();
  const built = buildWorkerRecord(body, existing, nowIso);
  if (!built.ok) {
    return { ok: false, status: 400, error: built.error };
  }

  const record = { ...built.value, id };
  if (existing) {
    record.startedAt = existing.startedAt || nowIso;
  }

  if (index >= 0) {
    workers[index] = record;
  } else {
    workers.push(record);
  }
  writeRegistry(paths.registryPath, workers);
  return { ok: true, worker: record };
}

function registerWorker(roostrStateDir, body) {
  return upsertWorker(roostrStateDir, body, { requireExisting: false });
}

function updateWorkerStatus(roostrStateDir, body) {
  return upsertWorker(roostrStateDir, body, { requireExisting: true });
}

function listWorkers(roostrStateDir) {
  const paths = registryPaths(roostrStateDir);
  if (!paths.dir) return [];
  return readWorkers(paths.registryPath);
}

function parseMeminfo(text) {
  const map = {};
  for (const line of String(text).split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB/i.exec(line.trim());
    if (match) {
      map[match[1]] = Number.parseInt(match[2], 10);
    }
  }
  return map;
}

function readHostMem() {
  let host = 'unknown';
  try {
    host = os.hostname();
  } catch {
    // Keep the fallback host label.
  }
  const mem = {
    host,
    physFreeKb: null,
    physTotalKb: null,
    swapUsedKb: null,
    swapTotalKb: null,
  };
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const parsed = parseMeminfo(raw);
    const total = Number.isFinite(parsed.MemTotal) ? parsed.MemTotal : null;
    const free = Number.isFinite(parsed.MemAvailable)
      ? parsed.MemAvailable
      : (Number.isFinite(parsed.MemFree) ? parsed.MemFree : null);
    const swapTotal = Number.isFinite(parsed.SwapTotal) ? parsed.SwapTotal : null;
    const swapFree = Number.isFinite(parsed.SwapFree) ? parsed.SwapFree : 0;
    mem.physFreeKb = free;
    mem.physTotalKb = total;
    mem.swapTotalKb = swapTotal;
    mem.swapUsedKb = swapTotal === null ? null : Math.max(0, swapTotal - swapFree);
  } catch {
    // Not Linux or /proc is not readable; leave the nulls in place.
  }
  return mem;
}

function readClosedSessions(closedSessionsPath, limit = CLOSED_SESSIONS_READ_LIMIT) {
  let raw;
  try {
    if (!fs.existsSync(closedSessionsPath)) return [];
    const stat = fs.statSync(closedSessionsPath);
    if (!stat.isFile()) return [];
    if (stat.size > MAX_CLOSED_SESSION_BYTES) {
      const fd = fs.openSync(closedSessionsPath, 'r');
      try {
        const start = Math.max(0, stat.size - MAX_CLOSED_SESSION_BYTES);
        const buf = Buffer.alloc(MAX_CLOSED_SESSION_BYTES);
        const read = fs.readSync(fd, buf, 0, MAX_CLOSED_SESSION_BYTES, start);
        raw = buf.subarray(0, read).toString('utf8');
        const firstBreak = raw.indexOf('\n');
        if (start > 0 && firstBreak >= 0) raw = raw.slice(firstBreak + 1);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(closedSessionsPath, 'utf8');
    }
  } catch {
    return [];
  }

  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const slice = lines.slice(-Math.max(1, limit));
  const entries = [];
  for (const line of slice) {
    try {
      const parsed = JSON.parse(line);
      if (isPlainObject(parsed)) entries.push(parsed);
    } catch {
      // Skip corrupt lines.
    }
  }
  return entries;
}

function appendClosedSession(closedSessionsPath, entry) {
  if (!closedSessionsPath) return;
  const line = JSON.stringify(entry) + '\n';
  appendLine(closedSessionsPath, line, 0o600);
}

function getRegistrySnapshot(roostrStateDir) {
  const paths = registryPaths(roostrStateDir);
  const workers = paths.dir ? readWorkers(paths.registryPath) : [];
  const sorted = workers.slice().sort((a, b) => {
    const ta = Date.parse(a.lastHeartbeat || a.updatedAt || '') || 0;
    const tb = Date.parse(b.lastHeartbeat || b.updatedAt || '') || 0;
    return tb - ta;
  });
  return {
    workers: sorted,
    hostMem: readHostMem(),
    closedSessions: paths.dir ? readClosedSessions(paths.closedSessionsPath) : [],
  };
}

function normalizeLogLines(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: DEFAULT_LOG_LINES };
  }
  const str = String(raw).trim();
  if (!/^\d+$/.test(str)) {
    return { ok: false, error: 'lines must be a positive integer' };
  }
  const num = Number.parseInt(str, 10);
  if (!Number.isSafeInteger(num) || num < 1) {
    return { ok: false, error: 'lines must be at least 1' };
  }
  return { ok: true, value: Math.min(num, MAX_LOG_LINES) };
}

function isWithin(parent, candidate) {
  const rel = path.relative(parent, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function tailWorkerLog(roostrStateDir, id, lines = DEFAULT_LOG_LINES) {
  const idCheck = normalizeId(id);
  if (!idCheck.ok) {
    return { ok: false, status: 400, error: idCheck.error };
  }
  const linesCheck = normalizeLogLines(lines);
  if (!linesCheck.ok) {
    return { ok: false, status: 400, error: linesCheck.error };
  }
  const paths = registryPaths(roostrStateDir);
  if (!paths.dir) {
    return { ok: false, status: 500, error: 'roostrStateDir not configured' };
  }

  const candidates = [path.join(paths.logsDir, `${idCheck.value}.log`)];
  const worker = readWorkers(paths.registryPath).find((w) => w && w.id === idCheck.value);
  if (worker && typeof worker.logFile === 'string' && worker.logFile.trim()) {
    const candidate = path.resolve(worker.logFile.trim());
    if (isWithin(paths.dir, candidate)) candidates.push(candidate);
  }

  for (const candidate of candidates) {
    if (!isWithin(paths.logsDir, candidate) && !isWithin(paths.dir, candidate)) continue;
    try {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      const raw = fs.readFileSync(candidate, 'utf8');
      const all = raw.split(/\r?\n/);
      if (all.length > 0 && all[all.length - 1] === '') all.pop();
      return { ok: true, id: idCheck.value, text: all.slice(-linesCheck.value).join('\n') };
    } catch {
      // Try the next candidate.
    }
  }
  return { ok: true, id: idCheck.value, text: '' };
}

function readProcTable() {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number.parseInt(entry.name, 10);
    let command = '';
    try {
      const raw = fs.readFileSync(path.join('/proc', entry.name, 'cmdline'), 'utf8');
      command = raw.split('\0').filter(Boolean).join(' ').trim();
    } catch {
      continue;
    }
    if (!command) continue;
    out.push({ pid, command });
  }
  return out;
}

function reapWorkerProcess(roostrStateDir, id, payload = {}, deps = {}) {
  const idCheck = normalizeId(id);
  if (!idCheck.ok) {
    return { ok: false, status: 400, error: idCheck.error };
  }

  const pidNum = Number(payload.pid);
  if (!Number.isInteger(pidNum) || pidNum <= 0) {
    return { ok: false, status: 400, error: 'pid must be a positive integer' };
  }
  if (typeof payload.command !== 'string' || !payload.command.trim()) {
    return { ok: false, status: 400, error: 'command is required' };
  }
  const wantedCommand = normalizeCommand(payload.command);

  const paths = registryPaths(roostrStateDir);
  if (!paths.dir) {
    return { ok: false, status: 500, error: 'roostrStateDir not configured' };
  }

  const workers = readWorkers(paths.registryPath);
  const index = workers.findIndex((w) => w && w.id === idCheck.value);
  if (index === -1) {
    return { ok: false, status: 404, error: 'worker not found' };
  }
  const entry = workers[index];

  if (Number(entry.pid) !== pidNum || normalizeCommand(entry.command) !== wantedCommand) {
    return { ok: false, status: 409, error: 'pid/command mismatch' };
  }

  const nowFn = typeof deps.now === 'function' ? deps.now : () => Date.now();
  let table;
  if (typeof deps.processTable === 'function') {
    try {
      table = deps.processTable();
    } catch {
      table = [];
    }
  } else if (Array.isArray(deps.processTable)) {
    table = deps.processTable;
  } else {
    table = readProcTable();
  }
  const live = Array.isArray(table)
    ? table.find((p) => p && Number(p.pid) === pidNum)
    : null;
  if (!live || normalizeCommand(live.command) !== wantedCommand) {
    return { ok: false, status: 409, error: 'live process does not match pid/command' };
  }

  const killImpl = typeof deps.killImpl === 'function'
    ? deps.killImpl
    : (pid, signal) => process.kill(pid, signal);
  try {
    killImpl(pidNum, 'SIGTERM');
  } catch (err) {
    const message = err && err.message ? err.message : 'unknown error';
    return { ok: false, status: 502, error: `kill failed: ${message}` };
  }

  const iso = new Date(nowFn()).toISOString();
  appendClosedSession(paths.closedSessionsPath, {
    at: iso,
    id: entry.id,
    pid: pidNum,
    command: entry.command || payload.command,
    model: entry.model || null,
    ramKb: Number.isFinite(entry.rssKb) ? entry.rssKb : null,
    session: entry.session || null,
    paneId: entry.paneId || null,
    workspaceId: entry.workspaceId || null,
    reason: 'reaped',
  });

  const updated = {
    ...entry,
    state: 'failed',
    lastHeartbeat: iso,
    updatedAt: iso,
    reapedAt: iso,
  };
  workers[index] = updated;
  writeRegistry(paths.registryPath, workers);

  return {
    ok: true,
    id: entry.id,
    pid: pidNum,
    command: entry.command || payload.command,
    closed: { at: iso },
  };
}

function extractTokenDigests(doc) {
  const out = [];
  const pushString = (value) => {
    if (typeof value === 'string' && SHA256_HEX_RE.test(value.trim())) {
      out.push(value.trim().toLowerCase());
    }
  };
  const considerEntry = (entry) => {
    if (typeof entry === 'string') {
      pushString(entry);
      return;
    }
    if (!isPlainObject(entry)) return;
    for (const key of ['hash', 'digest', 'sha256', 'tokenHash', 'token_hash', 'hash_sha256']) {
      pushString(entry[key]);
    }
  };

  if (Array.isArray(doc)) {
    for (const entry of doc) considerEntry(entry);
  } else if (isPlainObject(doc)) {
    for (const key of ['tokens', 'entries', 'digests']) {
      if (Array.isArray(doc[key])) {
        for (const entry of doc[key]) considerEntry(entry);
      }
    }
    // Also accept a hash-keyed or label-keyed map.
    for (const [key, value] of Object.entries(doc)) {
      if (key === 'schema' || key === 'updatedAt') continue;
      if (key === 'tokens' || key === 'entries' || key === 'digests') continue;
      pushString(key);
      considerEntry(value);
    }
  }
  return [...new Set(out)];
}

function authenticateToken(req, roostrStateDir) {
  if (!req || !req.headers) return false;
  const rawHeader = req.headers['x-roostr-token'];
  const token = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof token !== 'string' || !token.trim()) return false;

  const paths = registryPaths(roostrStateDir);
  if (!paths.tokensPath) return false;
  const doc = readJsonSafe(paths.tokensPath);
  const digests = extractTokenDigests(doc);
  if (digests.length === 0) return false;

  const candidate = crypto.createHash('sha256').update(token.trim(), 'utf8').digest();
  let matched = false;
  for (const hex of digests) {
    try {
      const expected = Buffer.from(hex, 'hex');
      if (expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected)) {
        matched = true;
      }
    } catch {
      // Ignore malformed digest entries.
    }
  }
  return matched;
}

module.exports = {
  ID_RE,
  VALID_STATES,
  VALID_MODES,
  DEFAULT_LOG_LINES,
  MAX_LOG_LINES,
  registryPaths,
  isValidWorkerId,
  hashToken,
  authenticateToken,
  registerWorker,
  updateWorkerStatus,
  listWorkers,
  getRegistrySnapshot,
  readHostMem,
  readClosedSessions,
  appendClosedSession,
  tailWorkerLog,
  reapWorkerProcess,
  readProcTable,
  normalizeCommand,
};
