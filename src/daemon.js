'use strict';
// `src/daemon.js`: Deterministic plugin daemon secretary for crew-board.
// Replaces the polling LLM stopgap with deterministic code bound to lifecycle events.
//
// D1: Listener core (lifecycle event intake, state tracking, persistence).
// D2: Timer & counter engine (prompt classification, configurable ladder, failure counters).
// D3: Plan executor (mechanical assignment, tier-table configuration, warm panes vs recycles).
// D4: Escalation queue & wake delivery (structured manifests, 12 wake/day cap, circuit breakers).
//
// Privacy line:
// samples store numbers and names, never prompts, transcripts or screens.

const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('./state');
const recover = require('./recover');
const ledger = require('./ledger');
const crewfile = require('./crewfile');

const LIFECYCLE_STATES = ['working', 'blocked', 'done', 'idle', 'unknown'];
const MAX_WAKES_PER_DAY = 12;

function daemonStateFile() {
  return process.env.CREW_BOARD_DAEMON_STATE || path.join(os.homedir(), '.crew-board', 'daemon-state.json');
}

function escalationsFile() {
  return process.env.CREW_BOARD_ESCALATIONS || path.join(os.homedir(), '.crew-board', 'escalations.json');
}

function createInitialState(now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  return {
    panes: Object.create(null),
    tasks: Object.create(null),
    counters: {
      commandFailures: Object.create(null),
      testFailures: Object.create(null),
    },
    escalations: [],
    wakes: {
      today,
      perEventCount: 0,
      perDigestCount: 0,
      history: [],
    },
    circuitBreaker: {
      status: 'normal',
      burnRatio: 0,
      poolRemainingRatio: 1.0,
    },
    lastReconciledAt: now,
  };
}

function loadDaemonState(file = daemonStateFile(), now = Date.now()) {
  const data = state.readJson(file);
  if (!data || typeof data !== 'object') return createInitialState(now);
  const today = new Date(now).toISOString().slice(0, 10);
  if (!data.wakes || data.wakes.today !== today) {
    data.wakes = {
      today,
      perEventCount: 0,
      perDigestCount: 0,
      history: [],
    };
  }
  if (!data.panes) data.panes = Object.create(null);
  if (!data.tasks) data.tasks = Object.create(null);
  if (!data.counters) {
    data.counters = { commandFailures: Object.create(null), testFailures: Object.create(null) };
  }
  if (!Array.isArray(data.escalations)) data.escalations = [];
  return data;
}

function saveDaemonState(dState, file = daemonStateFile()) {
  state.writeJson(file, dState);
  return dState;
}

// -----------------------------------------------------------------------------
// D1: Listener Core
// -----------------------------------------------------------------------------

function processEvent(dState, event, options = {}) {
  if (!event || typeof event !== 'object') return { changed: false, state: dState };
  const pane = event.pane;
  const rawStatus = String(event.status || '').toLowerCase();
  const status = LIFECYCLE_STATES.includes(rawStatus) ? rawStatus : 'unknown';
  const at = typeof event.at === 'number' ? event.at : (Date.parse(event.at) || Date.now());

  const prev = dState.panes[pane];
  // Deduplicate exact same event delivery
  if (prev && prev.status === status) {
    return { changed: false, transition: null, state: dState };
  }

  const oldStatus = prev ? prev.status : null;
  dState.panes[pane] = {
    pane,
    status,
    since: at,
    previousStatus: oldStatus,
    promptClass: null,
    lastEventAt: at,
  };

  // Check completion markers against tracked plan tasks
  const plan = options.plan;
  if (plan && Array.isArray(plan.tasks)) {
    for (const t of plan.tasks) {
      if (t.pane === pane || (t.id && pane.includes(t.id))) {
        if (!dState.tasks[t.id]) dState.tasks[t.id] = { id: t.id, status: 'working' };
        if (options.checkMarker) {
          const isDone = options.checkMarker(t);
          if (isDone) {
            dState.tasks[t.id].status = 'done';
            dState.tasks[t.id].doneAt = at;
          }
        }
      }
    }
  }

  dState.lastReconciledAt = Math.max(dState.lastReconciledAt || 0, at);
  saveDaemonState(dState, options.stateFile || daemonStateFile());

  return {
    changed: true,
    transition: { pane, from: oldStatus, to: status, at },
    state: dState,
  };
}

function reconcileFromTransitions(dState, transitions = [], options = {}) {
  const sorted = transitions.slice().sort((a, b) => {
    const aMs = typeof a.at === 'number' ? a.at : (Date.parse(a.at) || 0);
    const bMs = typeof b.at === 'number' ? b.at : (Date.parse(b.at) || 0);
    return aMs - bMs;
  });

  let count = 0;
  for (const tr of sorted) {
    const trMs = typeof tr.at === 'number' ? tr.at : (Date.parse(tr.at) || 0);
    const prev = dState.panes[tr.pane];
    if (!prev || trMs > (prev.lastEventAt || 0)) {
      const res = processEvent(dState, tr, options);
      if (res.changed) count++;
    }
  }

  return { state: dState, replayedTransitions: count };
}

// -----------------------------------------------------------------------------
// D2: Timer & Counter Engine
// -----------------------------------------------------------------------------

function classifyPrompt(screenText) {
  const res = recover.classifyScreen(screenText);
  if (res.safe || res.action) {
    return {
      isBlocked: true,
      promptClass: res.action,
      safe: res.safe,
      reason: res.reason,
    };
  }
  return {
    isBlocked: false,
    promptClass: null,
    safe: false,
    reason: res.reason,
  };
}

function recordCommandFailure(dState, paneId, command, errorSig) {
  if (!dState.counters.commandFailures[paneId]) {
    dState.counters.commandFailures[paneId] = { command, errorSig, count: 0, tripped: false };
  }
  const cur = dState.counters.commandFailures[paneId];
  if (cur.command === command && cur.errorSig === errorSig) {
    cur.count++;
  } else {
    cur.command = command;
    cur.errorSig = errorSig;
    cur.count = 1;
    cur.tripped = false;
  }

  if (cur.count === 3 && !cur.tripped) {
    cur.tripped = true;
    return {
      tripped: true,
      counter: 'command_failed_3x',
      signal: 'contamination_detected',
      paneId,
      command,
      errorSig,
    };
  }

  return { tripped: false, count: cur.count };
}

function recordTestFailure(dState, paneId, testSuite, errorSig) {
  if (!dState.counters.testFailures[paneId]) {
    dState.counters.testFailures[paneId] = { testSuite, errorSig, count: 0, tripped: false };
  }
  const cur = dState.counters.testFailures[paneId];
  if (cur.testSuite === testSuite) {
    cur.count++;
  } else {
    cur.testSuite = testSuite;
    cur.errorSig = errorSig;
    cur.count = 1;
    cur.tripped = false;
  }

  if (cur.count === 2 && !cur.tripped) {
    cur.tripped = true;
    return {
      tripped: true,
      counter: 'test_failed_2x',
      signal: 'escalate_eligible',
      paneId,
      testSuite,
      errorSig,
    };
  }

  return { tripped: false, count: cur.count };
}

function checkTimers(dState, now = Date.now(), crewConfig = null) {
  const ladder = (crewConfig && crewConfig.daemon && crewConfig.daemon.ladder) || {};
  const nudgeSec = ladder.nudgeSeconds;
  const recycleSec = ladder.recycleSeconds;
  const escalateSec = ladder.escalateSeconds;

  const signals = [];
  for (const [paneId, p] of Object.entries(dState.panes)) {
    if (p.status !== 'blocked') continue;
    const durSec = (now - p.since) / 1000;

    if (escalateSec && durSec >= escalateSec) {
      signals.push({ paneId, signal: 'escalate_eligible', durationSec: durSec, rung: 'escalate' });
    } else if (recycleSec && durSec >= recycleSec) {
      signals.push({ paneId, signal: 'recycle_eligible', durationSec: durSec, rung: 'recycle' });
    } else if (nudgeSec && durSec >= nudgeSec) {
      signals.push({ paneId, signal: 'nudge_eligible', durationSec: durSec, rung: 'nudge' });
    }
  }

  return signals;
}

// -----------------------------------------------------------------------------
// D3: Plan Executor
// -----------------------------------------------------------------------------

async function executePlan(plan, crewConfig, options = {}) {
  // G2 Approval Gate: secretary spawns nothing until human approves the plan.
  if (!plan || plan.approved !== true) {
    return {
      dispatches: [],
      escalations: [
        {
          id: 'unapproved-plan',
          type: 'plan_unapproved',
          severity: 'routine',
          reason: 'plan requires human approval before spawning workers',
          at: new Date().toISOString(),
        },
      ],
      refused: true,
      reason: 'plan requires human approval before spawning workers',
    };
  }

  // D4 Circuit Breakers: gate dispatches on rolling burn projection and pool remaining.
  const burnRatio = options.burnRatio !== undefined
    ? options.burnRatio
    : (crewConfig && crewConfig.burnRatio !== undefined ? crewConfig.burnRatio : 0);
  const poolRemainingRatio = options.poolRemainingRatio !== undefined
    ? options.poolRemainingRatio
    : (crewConfig && crewConfig.poolRemainingRatio !== undefined ? crewConfig.poolRemainingRatio : 1.0);
  const breaker = evaluateCircuitBreakers(burnRatio, poolRemainingRatio);

  if (breaker.status === 'pause') {
    return {
      dispatches: [],
      escalations: [
        {
          id: 'breaker-pause',
          type: 'circuit_breaker_pause',
          severity: 'hard',
          reason: breaker.reason,
          at: new Date().toISOString(),
        },
      ],
      breaker,
      paused: true,
      reason: breaker.reason,
    };
  }

  const tasksList = plan && Array.isArray(plan.tasks) ? plan.tasks : [];
  const tierTable = (crewConfig && crewConfig.tiers) || Object.create(null);
  const ledgerFile = options.ledgerFile;

  const dispatches = [];
  const escalations = [];
  const maxDispatches = breaker.status === 'throttle' ? 1 : tasksList.length;

  for (let idx = 0; idx < tasksList.length; idx++) {
    const t = tasksList[idx];
    if (dispatches.length >= maxDispatches) {
      escalations.push({
        id: `throttle-held-${t.id}`,
        type: 'dispatch_throttled',
        severity: 'routine',
        taskId: t.id,
        reason: 'dispatch throttled due to rolling burn past 80%',
        at: new Date().toISOString(),
      });
      continue;
    }

    const tier = t.tier || 'balanced';
    const tierConfig = tierTable[tier];

    // Refusal is a feature: if tier is missing from tier table, escalate gap.
    if (!tierConfig || (!tierConfig.model && !tierConfig.effort)) {
      escalations.push({
        id: `gap-${t.id}`,
        type: 'plan_gap',
        severity: 'routine',
        taskId: t.id,
        reason: `missing tier-table row for tier "${tier}"`,
        at: new Date().toISOString(),
      });
      continue;
    }

    const assignedModel = tierConfig.model;
    const assignedEffort = tierConfig.effort || 'medium';
    const assignedTool = tierConfig.tool || 'agy';
    const assignedWorktree = path.join(options.worktreesRoot || os.tmpdir(), `wt-${t.id}`);

    // Record in ledger
    let ledgerEntry = null;
    if (options.recordLedger !== false) {
      try {
        const spawned = ledger.spawn(
          {
            pane: t.pane || `pane-${t.id}`,
            task: t.id,
            role: 'worker',
            kind: t.kind || 'feature',
            tier,
            model: assignedModel,
            effort: assignedEffort,
          },
          ledgerFile
        );
        ledgerEntry = spawned.entry;
      } catch {
        // test fixture safe
      }
    }

    const dispatch = {
      taskId: t.id,
      pane: t.pane || `pane-${t.id}`,
      worktree: assignedWorktree,
      model: assignedModel,
      effort: assignedEffort,
      tool: assignedTool,
      tier,
      ledgerEntry,
      hygiene: 'context_reset_only',
      spawned: false,
    };

    // Real spawning via herdr when provided
    if (options.spawn && options.herdr) {
      try {
        const basePane = options.basePane || 'root';
        const newPane = await options.herdr.splitPane(basePane, 'right', assignedWorktree);
        await options.herdr.startAgent(t.id, assignedTool, newPane, ['--model', assignedModel]);
        await options.herdr.renamePane(newPane, t.title);
        dispatch.pane = newPane;
        dispatch.spawned = true;
      } catch (err) {
        dispatch.spawned = false;
        dispatch.spawnError = err.message;
        escalations.push({
          id: `spawn-err-${t.id}`,
          type: 'spawn_error',
          severity: 'routine',
          taskId: t.id,
          reason: err.message,
          at: new Date().toISOString(),
        });
      }
    }

    dispatches.push(dispatch);
  }

  return {
    dispatches,
    escalations,
    breaker,
    throttled: breaker.status === 'throttle',
  };
}

function handleHygiene(signal) {
  if (signal === 'contamination_detected') {
    return { action: 'full_pane_recycle', preserveWorktree: false };
  }
  return { action: 'context_reset_only', preserveWorktree: true };
}

// -----------------------------------------------------------------------------
// D4: Escalation Queue & Wake Delivery
// -----------------------------------------------------------------------------

function queueEscalation(dState, item, options = {}) {
  const esc = {
    id: item.id || `esc-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    type: item.type || 'state_exception',
    severity: item.severity || 'routine',
    paneId: item.paneId || null,
    taskId: item.taskId || null,
    reason: item.reason || 'unclassified exception',
    at: item.at || new Date().toISOString(),
    details: item.details || null,
  };

  dState.escalations.push(esc);
  const queueFile = options.escalationsFile || escalationsFile();
  state.writeJson(queueFile, dState.escalations);

  return esc;
}

function evaluateCircuitBreakers(burnRatio, poolRemainingRatio) {
  if (poolRemainingRatio < 0.15) {
    return { status: 'pause', reason: 'remaining pool under 15%' };
  }
  if (burnRatio >= 0.80) {
    return { status: 'throttle', reason: 'rolling burn projection past 80%' };
  }
  return { status: 'normal', reason: 'within quota bounds' };
}

function deliverWakes(dState, options = {}) {
  const now = options.now !== undefined ? options.now : Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (dState.wakes.today !== today) {
    dState.wakes = { today, perEventCount: 0, perDigestCount: 0, history: [] };
  }

  const crew = options.crewConfig || {};
  const countingMode = (crew.daemon && crew.daemon.wakeCounting) || null;

  const hardBlocks = dState.escalations.filter((e) => e.severity === 'hard');
  const routineItems = dState.escalations.filter((e) => e.severity !== 'hard');

  const delivered = [];
  const held = [];

  // Hard blocks deliver immediately
  for (const h of hardBlocks) {
    const currentCount = countingMode === 'per-digest' ? dState.wakes.perDigestCount : dState.wakes.perEventCount;
    if (currentCount >= MAX_WAKES_PER_DAY) {
      held.push(h);
      continue;
    }
    dState.wakes.perEventCount++;
    if (countingMode === 'per-digest') dState.wakes.perDigestCount++;
    delivered.push({
      kind: 'hard_block_wake',
      items: [h],
      manifest: {
        wakeType: 'instant',
        severity: 'hard',
        items: [h],
        wakeCount: {
          perEvent: dState.wakes.perEventCount,
          perDigest: dState.wakes.perDigestCount,
          activeMode: countingMode,
        },
      },
    });
  }

  // Routine items deliver as single batched digest
  if (routineItems.length > 0) {
    const currentCount = countingMode === 'per-digest' ? dState.wakes.perDigestCount : dState.wakes.perEventCount;
    if (currentCount >= MAX_WAKES_PER_DAY) {
      held.push(...routineItems);
    } else {
      dState.wakes.perDigestCount++;
      dState.wakes.perEventCount += routineItems.length;
      delivered.push({
        kind: 'digest_wake',
        items: routineItems,
        manifest: {
          wakeType: 'batched_digest',
          severity: 'routine',
          count: routineItems.length,
          items: routineItems,
          wakeCount: {
            perEvent: dState.wakes.perEventCount,
            perDigest: dState.wakes.perDigestCount,
            activeMode: countingMode,
          },
        },
      });
    }
  }

  let holdReport = null;
  let holdReportForRoman = null;
  if (held.length > 0) {
    holdReport = {
      type: 'operator_hold_manifest',
      recipient: 'operator',
      reason: `daily wake cap reached (${MAX_WAKES_PER_DAY})`,
      heldCount: held.length,
      items: held,
      at: new Date(now).toISOString(),
    };
    holdReportForRoman = {
      recipient: 'roman',
      reason: `daily wake cap reached (${MAX_WAKES_PER_DAY})`,
      heldCount: held.length,
      items: held,
    };
    const operatorFile = options.operatorHoldFile
      || path.join(path.dirname(options.stateFile || daemonStateFile()), 'operator-hold.json');
    state.writeJson(operatorFile, holdReport);
  }

  // Clear delivered escalations
  dState.escalations = held;
  saveDaemonState(dState, options.stateFile || daemonStateFile());

  return {
    delivered,
    held,
    holdReport,
    holdReportForRoman,
    wakeCount: {
      perEvent: dState.wakes.perEventCount,
      perDigest: dState.wakes.perDigestCount,
    },
  };
}

const STRUCTURAL_NUDGES = {
  stalled_output: 'Nudge: Check your task brief and exit criteria. Commit no files and report progress.',
  repeated_error: 'Nudge: The last command failed repeatedly. Inspect the exact error string and choose an alternate path.',
  interactive_prompt: 'Nudge: You are waiting at an interactive prompt. Automated execution cannot confirm prompts; proceed or escalate.',
};

function sendNudge(paneId, templateKey, options = {}) {
  const text = STRUCTURAL_NUDGES[templateKey] || templateKey;
  const herdr = options.herdr || require('./herdr');
  if (herdr && typeof herdr.promptAgent === 'function') {
    herdr.promptAgent(paneId, text).catch(() => {});
  }
  return { paneId, text };
}

module.exports = {
  LIFECYCLE_STATES,
  MAX_WAKES_PER_DAY,
  STRUCTURAL_NUDGES,
  daemonStateFile,
  escalationsFile,
  createInitialState,
  loadDaemonState,
  saveDaemonState,
  processEvent,
  reconcileFromTransitions,
  classifyPrompt,
  recordCommandFailure,
  recordTestFailure,
  checkTimers,
  executePlan,
  handleHygiene,
  queueEscalation,
  evaluateCircuitBreakers,
  deliverWakes,
  sendNudge,
};
