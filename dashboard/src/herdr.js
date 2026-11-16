'use strict';

const { execFile } = require('child_process');
const {
  validatePaneId,
  validateKeys,
  validatePrompt,
  validateLines,
  validatePaneLabel,
  validateAgentName,
  validateAgentKind,
} = require('./validate');

class HerdrError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HerdrError';
    this.statusCode = 502;
  }
}

function firstStderrLine(err, stderr) {
  if (typeof stderr === 'string') {
    const lines = stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length > 0) {
      return lines[0];
    }
  }
  if (err && err.killed) {
    return 'herdr command timed out';
  }
  if (err && err.code === 'ENOENT') {
    return 'herdr binary not found';
  }
  if (err && typeof err.message === 'string' && err.message.trim()) {
    return err.message.split(/\r?\n/)[0].trim();
  }
  return 'herdr execution failed';
}

const ALLOWED_VERBS = new Set([
  'api:snapshot',
  'pane:read',
  'pane:send-keys',
  'pane:rename',
  'agent:prompt',
  'agent:start',
  'pane:close',
]);

function createHerdrClient(opts = {}) {
  const bin = opts.herdrBin || 'herdr';
  const timeoutMs = opts.timeoutMs || 10000;
  const cacheTtlMs = opts.cacheTtlMs ?? 1000;
  const execFileFn = opts.execFile || execFile;
  const nowFn = opts.now || (() => Date.now());

  let cachedRaw = null;
  let cachedAt = 0;
  let inFlightSnapshot = null;

  function runVerb(verbKey, args) {
    if (!ALLOWED_VERBS.has(verbKey) || !Array.isArray(args)) {
      return Promise.reject(new HerdrError('disallowed herdr verb'));
    }
    return new Promise((resolve, reject) => {
      execFileFn(
        bin,
        args,
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) {
            return resolve(typeof stdout === 'string' ? stdout : String(stdout || ''));
          }
          reject(new HerdrError(firstStderrLine(err, stderr)));
        }
      );
    });
  }

  async function snapshotRaw() {
    const now = nowFn();
    if (cachedRaw !== null && now - cachedAt < cacheTtlMs) {
      return cachedRaw;
    }
    if (inFlightSnapshot) {
      return inFlightSnapshot;
    }
    inFlightSnapshot = runVerb('api:snapshot', ['api', 'snapshot'])
      .then((out) => {
        // Validate it is JSON before caching
        JSON.parse(out);
        cachedRaw = out;
        cachedAt = nowFn();
        return out;
      })
      .catch((err) => {
        if (err instanceof HerdrError) throw err;
        throw new HerdrError('invalid JSON from herdr api snapshot');
      })
      .finally(() => {
        inFlightSnapshot = null;
      });
    return inFlightSnapshot;
  }

  async function getSnapshotObject() {
    const raw = await snapshotRaw();
    return JSON.parse(raw);
  }

  function invalidateCache() {
    cachedRaw = null;
    cachedAt = 0;
  }

  async function readPane(paneId, linesRaw) {
    const pv = validatePaneId(paneId);
    if (!pv.ok) throw new Error(pv.error);
    const lv = validateLines(linesRaw);
    if (!lv.ok) throw new Error(lv.error);
    return runVerb('pane:read', [
      'pane',
      'read',
      pv.value,
      '--source',
      'visible',
      '--lines',
      String(lv.value),
    ]);
  }

  async function sendKeys(paneId, keys) {
    const pv = validatePaneId(paneId);
    if (!pv.ok) throw new Error(pv.error);
    const kv = validateKeys(keys);
    if (!kv.ok) throw new Error(kv.error);
    await runVerb('pane:send-keys', ['pane', 'send-keys', pv.value, ...kv.value]);
  }

  async function promptAgent(targetName, text) {
    const target = typeof targetName === 'string' ? targetName.trim() : '';
    if (!target || target.startsWith('-')) {
      throw new Error('invalid agent target');
    }
    const tv = validatePrompt(text);
    if (!tv.ok) throw new Error(tv.error);
    // herdr agent prompt does not support `--` option terminator; prefix leading `-` with a space.
    const safeText = tv.value.startsWith('-') ? ` ${tv.value}` : tv.value;
    await runVerb('agent:prompt', ['agent', 'prompt', target, safeText]);
  }

  async function closePane(paneId) {
    const pv = validatePaneId(paneId);
    if (!pv.ok) throw new Error(pv.error);
    await runVerb('pane:close', ['pane', 'close', pv.value]);
    invalidateCache();
  }

  async function renamePane(paneId, label) {
    const pv = validatePaneId(paneId);
    if (!pv.ok) throw new Error(pv.error);
    const lv = validatePaneLabel(label);
    if (!lv.ok) throw new Error(lv.error);
    const args = lv.value
      ? ['pane', 'rename', pv.value, lv.value]
      : ['pane', 'rename', pv.value, '--clear'];
    await runVerb('pane:rename', args);
    invalidateCache();
  }

  async function startAgent(paneId, name, kind) {
    const pv = validatePaneId(paneId);
    if (!pv.ok) throw new Error(pv.error);
    const nv = validateAgentName(name);
    if (!nv.ok) throw new Error(nv.error);
    const kv = validateAgentKind(kind);
    if (!kv.ok) throw new Error(kv.error);
    await runVerb('agent:start', ['agent', 'start', nv.value, '--kind', kv.value, '--pane', pv.value]);
    invalidateCache();
  }

  return {
    snapshotRaw,
    getSnapshotObject,
    invalidateCache,
    readPane,
    sendKeys,
    promptAgent,
    renamePane,
    startAgent,
    closePane,
  };
}

function resolveAgentTargetFromSnapshot(snapshotDoc, paneId) {
  const snap = (snapshotDoc && snapshotDoc.result && snapshotDoc.result.snapshot)
    || (snapshotDoc && snapshotDoc.snapshot)
    || snapshotDoc
    || {};
  const agents = Array.isArray(snap.agents) ? snap.agents : [];
  const match = agents.find((a) => a && a.pane_id === paneId);
  if (!match) {
    return null;
  }
  if (typeof match.name === 'string') {
    const name = match.name.trim();
    if (name && !name.startsWith('-')) {
      return name;
    }
  }
  return paneId;
}

module.exports = {
  HerdrError,
  firstStderrLine,
  createHerdrClient,
  resolveAgentTargetFromSnapshot,
};
