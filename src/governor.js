'use strict';
// Resource governor: placement policy, the Mac pane budget, the idle reaper and
// the Swapy-safe worker kill. Everything here is pure and dependency-injected
// so it can be tested without herdr, without killing anything, and without a
// live process table.
//
// Rules come from docs/spawn-policy.md: headless by default, a Mac pane only
// with a named reason, at most 3 live panes on the Mac, and an idle pane at a
// prompt past the threshold is closed and logged (its session resumes from
// disk).

const DEFAULT_CONFIG = {
  macMaxLivePanes: 3,
  swapThresholdPct: 80,
  idleReapMinutes: 30,
};

// Pane agents that are infrastructure, never reap candidates.
const BOARD_AGENTS = new Set(['roostr', 'crew-board', 'board', 'orchestrator']);
const BOARD_LABEL_RE = /^(roostr|crew-board|board)\b/i;

const USAGE = [
  'usage: roostr governor [--json]',
  '       roostr governor reap [--dry-run] [--yes] [--minutes 30] [--json]',
].join('\n');

function resolveConfig(config) {
  return { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) };
}

function getRegistry(registry) {
  // Lazy require keeps governor.js loadable on its own (and testable with a
  // stub) without a hard dependency edge at module load.
  if (registry) return registry;
  return require('./registry');
}

function normalizeHost(host) {
  if (typeof host !== 'string') return '';
  const h = host.trim().toLowerCase();
  if (h === 'darwin' || h === 'osx' || h === 'macos') return 'mac';
  return h;
}

function isBoardPane(pane) {
  if (!pane || typeof pane !== 'object') return true;
  if (pane.is_board === true || pane.is_orchestrator === true) return true;
  const role = typeof pane.role === 'string' ? pane.role.toLowerCase() : '';
  if (role === 'board' || role === 'orchestrator') return true;
  const agent = typeof pane.agent === 'string' ? pane.agent.toLowerCase() : '';
  if (BOARD_AGENTS.has(agent)) return true;
  const label = typeof pane.label === 'string' ? pane.label : '';
  if (BOARD_LABEL_RE.test(label)) return true;
  return false;
}

// Decide whether a pane spawn is allowed. Default placement is ovh; a Mac
// placement needs a reason, and the Mac honors its pane budget and the swap
// threshold. A refusal names a fallback (ovh or headless) and says why.
function checkPaneSpawn(input = {}) {
  const config = resolveConfig(input.config);
  const placement = input.placement || 'ovh';
  const host = normalizeHost(input.host);

  if (placement === 'mac') {
    const reason = typeof input.placementReason === 'string' ? input.placementReason.trim() : '';
    if (!reason) {
      return { allowed: false, reason: 'mac placement requires placementReason', fallback: 'ovh' };
    }
  }

  const livePaneCount = Number.isFinite(Number(input.livePaneCount)) ? Number(input.livePaneCount) : 0;
  if ((host === 'mac') && livePaneCount >= config.macMaxLivePanes) {
    return {
      allowed: false,
      reason: `pane budget exceeded (${config.macMaxLivePanes}/${config.macMaxLivePanes} on mac)`,
      fallback: 'headless',
    };
  }

  if (typeof input.swapUsedPct === 'number' && input.swapUsedPct >= config.swapThresholdPct) {
    return { allowed: false, reason: 'swap pressure threshold exceeded', fallback: 'headless' };
  }

  return { allowed: true, reason: null };
}

function paneIdOf(pane) {
  if (!pane || typeof pane !== 'object') return null;
  return pane.pane_id || pane.paneId || pane.id || null;
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function firstTime(...values) {
  for (const v of values) {
    const ms = toMs(v);
    if (ms !== null) return ms;
  }
  return null;
}

// Panes that are idle (or done) at a prompt longer than the threshold.
// statusMap is keyed by pane id and may carry { status | agent_status, since }.
function findIdlePanes(panes, statusMap = {}, now = Date.now(), thresholdMs = DEFAULT_CONFIG.idleReapMinutes * 60 * 1000) {
  const out = [];
  for (const pane of Array.isArray(panes) ? panes : []) {
    if (!pane || isBoardPane(pane)) continue;
    const paneId = paneIdOf(pane);
    if (!paneId) continue;
    const st = (statusMap && statusMap[paneId]) || {};
    const status = st.status || st.agent_status || pane.agent_status || pane.status || null;
    if (status !== 'idle' && status !== 'done') continue;
    const since = firstTime(
      st.since,
      st.at,
      st.sinceMs,
      pane.agent_status_changed_at,
      pane.status_since,
      pane.since,
    );
    if (since === null) continue;
    if (now - since >= thresholdMs) out.push(pane);
  }
  return out;
}

// The resume handle for a pane, from the pane itself or a sessions map/module.
function resolveSession(pane, sessions) {
  const paneId = paneIdOf(pane);
  let raw = null;
  if (typeof pane.agent_session === 'string' && pane.agent_session) raw = pane.agent_session;
  else if (pane.agent_session && typeof pane.agent_session.value === 'string') raw = pane.agent_session.value;

  if (!raw && sessions) {
    if (typeof sessions === 'function') raw = sessions(paneId);
    else if (sessions instanceof Map) raw = sessions.get(paneId);
    else if (typeof sessions === 'object') {
      const v = sessions[paneId];
      if (typeof v === 'string') raw = v;
      else if (v && typeof v.session === 'string') raw = v.session;
    }
  }
  if (!raw || typeof raw !== 'string') return null;
  if (sessions && typeof sessions.validSession === 'function') {
    return sessions.validSession(pane.agent, raw) ? raw : null;
  }
  return raw;
}

// Close idle panes that have a resumable session, log each to
// closed-sessions.jsonl, and return { reaped, skipped, dryRun }.
// A pane without a saved session id is never closed: losing the pane must not
// lose the session.
async function reapIdlePanes(opts = {}) {
  const registry = getRegistry(opts.registry);
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const minutes = Number.isFinite(Number(opts.minutes)) ? Number(opts.minutes) : DEFAULT_CONFIG.idleReapMinutes;
  const thresholdMs = Number.isFinite(Number(opts.thresholdMs))
    ? Number(opts.thresholdMs)
    : minutes * 60 * 1000;
  const dryRun = opts.dryRun === true;
  const options = opts.registryDir ? { dir: opts.registryDir } : {};
  const panes = Array.isArray(opts.panes) ? opts.panes : [];
  const idle = findIdlePanes(panes, opts.statusMap || {}, now, thresholdMs);

  const reaped = [];
  const skipped = [];
  for (const pane of idle) {
    const paneId = paneIdOf(pane);
    const session = resolveSession(pane, opts.sessions);
    if (!session) {
      skipped.push({ paneId, reason: 'no resumable session' });
      continue;
    }
    const entry = {
      id: paneId,
      paneId,
      pid: pane.shell_pid || pane.pid || null,
      command: pane.command || pane.agent || null,
      model: pane.model || null,
      ramKb: pane.rssKb || pane.rss_kb || null,
      session,
      workspaceId: pane.workspace_id || pane.workspaceId || null,
      reason: 'idle-reap',
    };
    if (!dryRun) {
      if (opts.herdr && typeof opts.herdr.closePane === 'function') {
        await opts.herdr.closePane(paneId);
      }
      registry.appendClosedSession(entry, options);
    }
    reaped.push({ paneId, session, at: new Date(now).toISOString(), dryRun });
  }
  return { reaped, skipped, dryRun };
}

// Look a pid up in a process table. Accepts ram.processTable()'s Map
// (pid -> { ppid, rss }) or a plain object mapping pid -> command | { command }.
function lookupProcess(table, pid) {
  if (!table) return null;
  if (typeof table.has === 'function' && typeof table.get === 'function') {
    return table.has(pid) ? { command: null } : null;
  }
  if (typeof table === 'object') {
    const v = table[pid];
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') return { command: v };
    if (typeof v === 'object') return { command: typeof v.command === 'string' ? v.command : null };
  }
  return null;
}

// Swapy safety rule: verify the pid and command match the registry record and
// the live process table before sending SIGTERM. On a match, log the close and
// mark the worker failed.
function reapWorker(opts = {}) {
  const registry = getRegistry(opts.registry);
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const options = opts.registryDir ? { dir: opts.registryDir } : {};
  const id = opts.id;
  const pid = Number(opts.pid);
  const command = typeof opts.command === 'string' ? opts.command : null;

  let record = null;
  if (opts.record && typeof opts.record === 'object') record = opts.record;
  else if (registry && typeof registry.getWorker === 'function') record = registry.getWorker(id, options);

  if (!record) return { killed: false, reason: 'unknown worker', id };
  if (Number(record.pid) !== pid) return { killed: false, reason: 'pid/command mismatch', id };
  if ((record.command || null) !== command) return { killed: false, reason: 'pid/command mismatch', id };

  const live = lookupProcess(opts.processTable, pid);
  if (opts.processTable && !live) return { killed: false, reason: 'pid not running', id };
  if (live && live.command && command && live.command !== command) {
    return { killed: false, reason: 'pid/command mismatch', id };
  }

  const kill = typeof opts.killImpl === 'function' ? opts.killImpl : process.kill.bind(process);
  kill(pid, 'SIGTERM');

  registry.appendClosedSession({
    id,
    pid,
    command,
    model: record.model || null,
    ramKb: record.rssKb || null,
    session: record.session || null,
    at: new Date(now).toISOString(),
    reason: 'reap',
  }, options);

  if (typeof registry.updateStatus === 'function') {
    registry.updateStatus(id, { state: 'failed' }, options);
  }
  return { killed: true, id, pid };
}

// --- CLI -------------------------------------------------------------------

function parseReapArgs(argv) {
  const opts = { dryRun: false, yes: false, minutes: DEFAULT_CONFIG.idleReapMinutes, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--yes' || a === '-y') { opts.yes = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--minutes') {
      const v = argv[i + 1];
      if (v === undefined) return { error: '--minutes needs a value' };
      opts.minutes = Number(v);
      i++;
      continue;
    }
    if (a.startsWith('--minutes=')) { opts.minutes = Number(a.slice(10)); continue; }
    return { error: `unknown option ${a}` };
  }
  if (!Number.isFinite(opts.minutes) || opts.minutes < 0) return { error: 'invalid --minutes' };
  return opts;
}

async function main(argv = [], deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const args = Array.isArray(argv) ? argv : [];
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'status';
  const rest = sub === 'status' ? args : args.slice(1);

  if (rest.includes('-h') || rest.includes('--help')) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (sub === 'status') {
    const config = resolveConfig(deps.config);
    const json = rest.includes('--json');
    const registry = getRegistry(deps.registry);
    const options = deps.registryDir ? { dir: deps.registryDir } : {};
    let workers = [];
    let closed = [];
    try {
      workers = registry.listWorkers(options);
      closed = typeof registry.readClosedSessions === 'function' ? registry.readClosedSessions(options) : [];
    } catch { /* registry read is best effort */ }
    const doc = {
      config,
      policy: 'headless by default; mac pane requires a reason; ovh unless mac-bound',
      workers: workers.length,
      closedSessions: closed.length,
    };
    if (json) stdout.write(JSON.stringify(doc, null, 2) + '\n');
    else {
      stdout.write(`governor: macMaxLivePanes=${config.macMaxLivePanes} swapThresholdPct=${config.swapThresholdPct} idleReapMinutes=${config.idleReapMinutes}\n`);
      stdout.write(`workers=${doc.workers} closedSessions=${doc.closedSessions}\n`);
    }
    return 0;
  }

  if (sub === 'reap') {
    const parsed = parseReapArgs(rest);
    if (parsed.error) {
      stderr.write(`roostr governor: ${parsed.error}\n`);
      return 2;
    }
    // A real close needs an explicit --yes; otherwise this is a preview.
    const dryRun = parsed.dryRun || !parsed.yes;
    const herdr = deps.herdr || require('./herdr');
    const registry = getRegistry(deps.registry);
    const sessions = deps.sessions || require('./sessions');

    let snapshot;
    try {
      snapshot = await herdr.snapshot();
    } catch (err) {
      stderr.write(`roostr governor: herdr unavailable: ${err.message}\n`);
      return 1;
    }

    const statusMap = {};
    for (const agent of (snapshot && snapshot.agents) || []) {
      if (!agent || typeof agent.pane_id !== 'string') continue;
      statusMap[agent.pane_id] = {
        status: agent.agent_status,
        since: agent.agent_status_changed_at || agent.status_since || agent.since,
      };
    }

    const result = await reapIdlePanes({
      panes: (snapshot && snapshot.panes) || [],
      statusMap,
      sessions,
      herdr,
      now: typeof deps.now === 'function' ? deps.now() : Date.now(),
      minutes: parsed.minutes,
      dryRun,
      registry,
      registryDir: deps.registryDir,
    });

    if (parsed.json) {
      stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      const verb = dryRun ? 'would reap' : 'reaped';
      if (result.reaped.length === 0) stdout.write(`no idle panes to reap (threshold ${parsed.minutes}m)\n`);
      else stdout.write(`${verb} ${result.reaped.length} pane(s): ${result.reaped.map((r) => r.paneId).join(', ')}\n`);
      for (const s of result.skipped) stdout.write(`kept ${s.paneId}: ${s.reason}\n`);
    }
    return 0;
  }

  stderr.write(`roostr governor: unknown subcommand ${sub}\n`);
  return 2;
}

module.exports = {
  DEFAULT_CONFIG,
  resolveConfig,
  checkPaneSpawn,
  findIdlePanes,
  reapIdlePanes,
  reapWorker,
  isBoardPane,
  main,
  USAGE,
};
