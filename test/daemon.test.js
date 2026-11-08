'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const daemon = require('../src/daemon');
const ledger = require('../src/ledger');
const statusEvent = require('../scripts/status-event');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-board-daemon-'));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// D1: Listener Core Acceptance Tests
// -----------------------------------------------------------------------------

test('D1: listener core drives pane through all 5 states and persists matching state', () => {
  const stateFile = path.join(tmpRoot, 'd1-state.json');
  let dState = daemon.createInitialState();

  const states = ['working', 'blocked', 'done', 'idle', 'unknown'];
  let time = 1000;

  for (const st of states) {
    const res = daemon.processEvent(dState, { pane: 'w1:p1', status: st, at: time }, { stateFile });
    assert.equal(res.changed, true);
    assert.equal(res.transition.to, st);
    dState = res.state;
    time += 1000;
  }

  // Verify on disk persistence
  const loaded = daemon.loadDaemonState(stateFile);
  assert.equal(loaded.panes['w1:p1'].status, 'unknown');
  assert.equal(loaded.panes['w1:p1'].previousStatus, 'idle');
  assert.equal(loaded.panes['w1:p1'].since, 5000);
});

test('D1: duplicate event delivery produces no duplicated transition', () => {
  const stateFile = path.join(tmpRoot, 'd1-dup.json');
  let dState = daemon.createInitialState();

  const res1 = daemon.processEvent(dState, { pane: 'w1:p2', status: 'working', at: 1000 }, { stateFile });
  assert.equal(res1.changed, true);

  // Deliver identical event again
  const res2 = daemon.processEvent(dState, { pane: 'w1:p2', status: 'working', at: 2000 }, { stateFile });
  assert.equal(res2.changed, false);
  assert.equal(res2.transition, null);
});

test('D1: daemon recovers last state on restart and reconciles missed transitions', () => {
  const stateFile = path.join(tmpRoot, 'd1-restart.json');
  let dState = daemon.createInitialState();

  daemon.processEvent(dState, { pane: 'w1:p3', status: 'idle', at: 1000 }, { stateFile });

  // Simulate transitions occurring while daemon was down
  const missedTransitions = [
    { pane: 'w1:p3', status: 'working', at: 2000 },
    { pane: 'w1:p3', status: 'blocked', at: 3000 },
  ];

  // Restart daemon by loading persisted state from disk
  const restartedState = daemon.loadDaemonState(stateFile);
  assert.equal(restartedState.panes['w1:p3'].status, 'idle');

  // Reconcile missed transitions
  const rec = daemon.reconcileFromTransitions(restartedState, missedTransitions, { stateFile });
  assert.equal(rec.replayedTransitions, 2);
  assert.equal(rec.state.panes['w1:p3'].status, 'blocked');
  assert.equal(rec.state.panes['w1:p3'].since, 3000);
});

// -----------------------------------------------------------------------------
// D2: Timer & Counter Engine Acceptance Tests
// -----------------------------------------------------------------------------

test('D2: timeout ladder fires at crew-file configured rungs with no code changes', () => {
  const dState = daemon.createInitialState();
  dState.panes['w1:p4'] = {
    pane: 'w1:p4',
    status: 'blocked',
    since: 0,
  };

  const crewConfigA = {
    daemon: {
      ladder: {
        nudgeSeconds: 60,
        recycleSeconds: 120,
        escalateSeconds: 300,
      },
    },
  };

  // At 70 seconds: nudge fires
  const sigs1 = daemon.checkTimers(dState, 70000, crewConfigA);
  assert.equal(sigs1.length, 1);
  assert.equal(sigs1[0].rung, 'nudge');

  // At 150 seconds: recycle fires
  const sigs2 = daemon.checkTimers(dState, 150000, crewConfigA);
  assert.equal(sigs2.length, 1);
  assert.equal(sigs2[0].rung, 'recycle');

  // At 350 seconds: escalate fires
  const sigs3 = daemon.checkTimers(dState, 350000, crewConfigA);
  assert.equal(sigs3.length, 1);
  assert.equal(sigs3[0].rung, 'escalate');

  // Reconfigure ladder via crew file: change nudge to 20s
  const crewConfigB = {
    daemon: {
      ladder: {
        nudgeSeconds: 20,
        recycleSeconds: 120,
        escalateSeconds: 300,
      },
    },
  };
  const sigsModified = daemon.checkTimers(dState, 30000, crewConfigB);
  assert.equal(sigsModified.length, 1);
  assert.equal(sigsModified[0].rung, 'nudge');
});

test('D2: interactive confirmation prompt is classified blocked (prompt class), never working or auto-confirmed', () => {
  const screenWithPrompt = 'Do you allow running git status? [y/N] (allow/deny)';
  const classification = daemon.classifyPrompt(screenWithPrompt);

  assert.equal(classification.isBlocked, true);
  assert.equal(classification.promptClass, 'allow');
  assert.equal(classification.safe, true);

  // Screen with unsafe prompt
  const unsafeScreen = 'Do you approve rm -rf *? (yes/no)';
  const unsafeClass = daemon.classifyPrompt(unsafeScreen);
  assert.equal(unsafeClass.isBlocked, true);
  assert.equal(unsafeClass.safe, false);

  // Normal terminal screen
  const normalScreen = 'Tests passed in 12ms\n$ ';
  const normalClass = daemon.classifyPrompt(normalScreen);
  assert.equal(normalClass.isBlocked, false);
});

test('D2: identical command failing 3x trips once; different failure resets count', () => {
  const dState = daemon.createInitialState();

  // Fail 1: no trip
  const r1 = daemon.recordCommandFailure(dState, 'w1:p5', 'npm test', 'E_TIMEOUT');
  assert.equal(r1.tripped, false);
  assert.equal(r1.count, 1);

  // Fail 2: same error, no trip
  const r2 = daemon.recordCommandFailure(dState, 'w1:p5', 'npm test', 'E_TIMEOUT');
  assert.equal(r2.tripped, false);
  assert.equal(r2.count, 2);

  // Different failure resets count
  const rDiff = daemon.recordCommandFailure(dState, 'w1:p5', 'npm build', 'SYNTAX_ERR');
  assert.equal(rDiff.tripped, false);
  assert.equal(rDiff.count, 1);

  // Fail 2 with same: count 2
  const rDiff2 = daemon.recordCommandFailure(dState, 'w1:p5', 'npm build', 'SYNTAX_ERR');
  assert.equal(rDiff2.tripped, false);
  assert.equal(rDiff2.count, 2);

  // Fail 3 with same: trips contamination signal!
  const rTrip = daemon.recordCommandFailure(dState, 'w1:p5', 'npm build', 'SYNTAX_ERR');
  assert.equal(rTrip.tripped, true);
  assert.equal(rTrip.signal, 'contamination_detected');

  // Subsequent call does not re-trip
  const rAfter = daemon.recordCommandFailure(dState, 'w1:p5', 'npm build', 'SYNTAX_ERR');
  assert.equal(rAfter.tripped, false);
});

test('D2: no numeric timeouts from research doc appear as code constants', () => {
  const daemonCode = fs.readFileSync(path.join(__dirname, '../src/daemon.js'), 'utf8');
  // Research doc flagged 120s kill and 180s inactivity triggers
  assert.ok(!daemonCode.includes('120000'));
  assert.ok(!daemonCode.includes('180000'));
  assert.ok(!daemonCode.includes('DEFAULT_KILL_SECONDS'));
});

// -----------------------------------------------------------------------------
// D3: Plan Executor Acceptance Tests
// -----------------------------------------------------------------------------

test('D3: executes 3 packages at 3 tiers matching crew-file tier table exactly', async () => {
  const ledgerFile = path.join(tmpRoot, 'd3-ledger.jsonl');
  const plan = {
    approved: true,
    tasks: [
      { id: 'T1', title: 'format markdown files', tier: 'fast', kind: 'docs' },
      { id: 'T2', title: 'implement profile modal', tier: 'balanced', kind: 'feature' },
      { id: 'T3', title: 'fix concurrency race condition', tier: 'reasoning', kind: 'complex' },
    ],
  };

  const crewConfig = {
    tiers: {
      fast: { model: 'gemini-3.8-flash', effort: 'low' },
      balanced: { model: 'deepseek-v4.1-flash-1017', effort: 'medium' },
      reasoning: { model: 'claude-3-7-sonnet', effort: 'high' },
    },
  };

  const res = await daemon.executePlan(plan, crewConfig, { ledgerFile });
  assert.equal(res.dispatches.length, 3);
  assert.equal(res.escalations.length, 0);

  assert.equal(res.dispatches[0].model, 'gemini-3.8-flash');
  assert.equal(res.dispatches[0].effort, 'low');

  assert.equal(res.dispatches[1].model, 'deepseek-v4.1-flash-1017');
  assert.equal(res.dispatches[1].effort, 'medium');

  assert.equal(res.dispatches[2].model, 'claude-3-7-sonnet');
  assert.equal(res.dispatches[2].effort, 'high');

  // Verify ledger entries match recommended == actual
  const entries = ledger.readEntries(ledgerFile);
  assert.equal(entries.length, 3);
  for (const e of entries) {
    assert.equal(e.tier, e.recommendedTier);
    assert.equal(e.effort, e.recommendedEffort);
  }
});

test('D3: refusal on plan gap spawns nothing for gapped package and emits escalation item', async () => {
  const plan = {
    approved: true,
    tasks: [
      { id: 'valid-task', title: 'Valid', tier: 'fast' },
      { id: 'gapped-task', title: 'Gapped', tier: 'unregistered-tier' },
    ],
  };

  const crewConfig = {
    tiers: {
      fast: { model: 'gemini-3.8-flash', effort: 'low' },
    },
  };

  const res = await daemon.executePlan(plan, crewConfig, { recordLedger: false });
  assert.equal(res.dispatches.length, 1);
  assert.equal(res.dispatches[0].taskId, 'valid-task');

  assert.equal(res.escalations.length, 1);
  assert.equal(res.escalations[0].type, 'plan_gap');
  assert.equal(res.escalations[0].taskId, 'gapped-task');
  assert.ok(res.escalations[0].reason.includes('unregistered-tier'));
});

test('G2: spawn attempt before human approval is refused', async () => {
  const unapprovedPlan = {
    approved: false,
    tasks: [
      { id: 'T1', title: 'some task', tier: 'fast' },
    ],
  };

  const crewConfig = {
    tiers: {
      fast: { model: 'gemini-3.8-flash', effort: 'low' },
    },
  };

  const res = await daemon.executePlan(unapprovedPlan, crewConfig, { recordLedger: false });
  assert.equal(res.refused, true);
  assert.equal(res.dispatches.length, 0);
  assert.equal(res.escalations.length, 1);
  assert.equal(res.escalations[0].type, 'plan_unapproved');
});

test('D3: contamination signal triggers full recycle, normal completion resets context only', () => {
  const recycleAction = daemon.handleHygiene('contamination_detected');
  assert.equal(recycleAction.action, 'full_pane_recycle');
  assert.equal(recycleAction.preserveWorktree, false);

  const cleanAction = daemon.handleHygiene('clean_completion');
  assert.equal(cleanAction.action, 'context_reset_only');
  assert.equal(cleanAction.preserveWorktree, true);
});

// -----------------------------------------------------------------------------
// D4: Escalation Queue & Wake Delivery Acceptance Tests
// -----------------------------------------------------------------------------

test('D4: queue survives daemon restart with zero lost items', () => {
  const qFile = path.join(tmpRoot, 'd4-queue.json');
  let dState = daemon.createInitialState();

  daemon.queueEscalation(dState, { id: 'esc-1', reason: 'blocker one' }, { escalationsFile: qFile });
  daemon.queueEscalation(dState, { id: 'esc-2', reason: 'blocker two' }, { escalationsFile: qFile });

  // Reload state and queue
  const reloadedQueue = JSON.parse(fs.readFileSync(qFile, 'utf8'));
  assert.equal(reloadedQueue.length, 2);
  assert.equal(reloadedQueue[0].id, 'esc-1');
  assert.equal(reloadedQueue[1].id, 'esc-2');
});

test('D4: three non-urgent items queue as single batched digest, hard block wakes instantly', () => {
  let dState = daemon.createInitialState();

  daemon.queueEscalation(dState, { id: 'r1', severity: 'routine', reason: 'gap' });
  daemon.queueEscalation(dState, { id: 'r2', severity: 'routine', reason: 'stall' });
  daemon.queueEscalation(dState, { id: 'r3', severity: 'routine', reason: 'timeout' });
  daemon.queueEscalation(dState, { id: 'h1', severity: 'hard', reason: 'batch dead' });

  const wakes = daemon.deliverWakes(dState);
  assert.equal(wakes.delivered.length, 2);

  const hardWake = wakes.delivered.find((w) => w.kind === 'hard_block_wake');
  assert.ok(hardWake);
  assert.equal(hardWake.items[0].id, 'h1');

  const digestWake = wakes.delivered.find((w) => w.kind === 'digest_wake');
  assert.ok(digestWake);
  assert.equal(digestWake.items.length, 3);
});

test('D4: daily wake cap of 12 delivers 12 and holds 13th for Roman', () => {
  let dState = daemon.createInitialState();

  for (let i = 1; i <= 13; i++) {
    daemon.queueEscalation(dState, { id: `item-${i}`, severity: 'hard', reason: `event ${i}` });
  }

  const wakes = daemon.deliverWakes(dState);
  assert.equal(wakes.delivered.length, 12);
  assert.equal(wakes.held.length, 1);
  assert.ok(wakes.holdReportForRoman);
  assert.equal(wakes.holdReportForRoman.recipient, 'roman');
  assert.equal(wakes.holdReportForRoman.heldCount, 1);
  assert.equal(wakes.holdReportForRoman.items[0].id, 'item-13');
});

test('D4: dual counting modes report according to crew file flag, or both if unset', () => {
  let dStateUnset = daemon.createInitialState();
  daemon.queueEscalation(dStateUnset, { id: 'e1', severity: 'routine' });
  const wUnset = daemon.deliverWakes(dStateUnset, { crewConfig: {} });
  assert.equal(wUnset.delivered[0].manifest.wakeCount.activeMode, null);
  assert.equal(typeof wUnset.delivered[0].manifest.wakeCount.perEvent, 'number');
  assert.equal(typeof wUnset.delivered[0].manifest.wakeCount.perDigest, 'number');

  let dStatePerDigest = daemon.createInitialState();
  daemon.queueEscalation(dStatePerDigest, { id: 'e2', severity: 'routine' });
  const wPerDigest = daemon.deliverWakes(dStatePerDigest, {
    crewConfig: { daemon: { wakeCounting: 'per-digest' } },
  });
  assert.equal(wPerDigest.delivered[0].manifest.wakeCount.activeMode, 'per-digest');
});

test('D4: circuit breakers flip between normal, throttle, and pause', () => {
  assert.equal(daemon.evaluateCircuitBreakers(0.50, 0.80).status, 'normal');
  assert.equal(daemon.evaluateCircuitBreakers(0.85, 0.50).status, 'throttle');
  assert.equal(daemon.evaluateCircuitBreakers(0.90, 0.10).status, 'pause');
  assert.equal(daemon.evaluateCircuitBreakers(0.40, 0.05).status, 'pause');
});

test('D1: live feed wiring proof - status-event.js processes event and persists daemon state', () => {
  const dStateFile = path.join(tmpRoot, 'd1-live-state.json');
  const transFile = path.join(tmpRoot, 'd1-live-transitions.jsonl');
  const evFile = path.join(tmpRoot, 'd1-live-ev.json');

  const env = {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: 'pane.agent_status_changed',
      data: { pane_id: 'w1:p88', agent_status: 'working' },
    }),
  };

  const rec = statusEvent.main(env, 1700000000000, {
    daemonStateFile: dStateFile,
    transitionsFile: transFile,
    eventFile: evFile,
  });
  assert.ok(rec);
  assert.equal(rec.pane, 'w1:p88');
  assert.equal(rec.status, 'working');

  // Verify daemon state on disk
  const loaded = daemon.loadDaemonState(dStateFile);
  assert.ok(loaded.panes['w1:p88']);
  assert.equal(loaded.panes['w1:p88'].status, 'working');

  // Send next event
  const env2 = {
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
      event: 'pane.agent_status_changed',
      data: { pane_id: 'w1:p88', agent_status: 'blocked' },
    }),
  };
  statusEvent.main(env2, 1700000005000, {
    daemonStateFile: dStateFile,
    transitionsFile: transFile,
    eventFile: evFile,
  });
  const loaded2 = daemon.loadDaemonState(dStateFile);
  assert.equal(loaded2.panes['w1:p88'].status, 'blocked');
});

test('D3: real spawning via herdr client and structural nudges', async () => {
  const splitCalls = [];
  const startCalls = [];
  const renameCalls = [];
  const promptCalls = [];

  const fakeHerdr = {
    splitPane: async (base, dir, cwd) => {
      splitCalls.push({ base, dir, cwd });
      return 'pane-new-1';
    },
    startAgent: async (name, kind, paneId, args) => {
      startCalls.push({ name, kind, paneId, args });
    },
    renamePane: async (paneId, label) => {
      renameCalls.push({ paneId, label });
    },
    promptAgent: async (paneId, text) => {
      promptCalls.push({ paneId, text });
    },
  };

  const plan = {
    approved: true,
    tasks: [
      { id: 'task-real-spawn', title: 'Implement feature', tier: 'fast', kind: 'docs' },
    ],
  };

  const crewConfig = {
    tiers: {
      fast: { model: 'gemini-3.8-flash', effort: 'low', tool: 'agy' },
    },
  };

  const res = await daemon.executePlan(plan, crewConfig, {
    spawn: true,
    herdr: fakeHerdr,
    recordLedger: false,
  });

  assert.equal(res.dispatches.length, 1);
  assert.equal(res.dispatches[0].spawned, true);
  assert.equal(res.dispatches[0].pane, 'pane-new-1');
  assert.equal(splitCalls.length, 1);
  assert.equal(startCalls.length, 1);
  assert.equal(startCalls[0].name, 'task-real-spawn');
  assert.equal(renameCalls.length, 1);

  // Test structural nudge
  const nudge = daemon.sendNudge('pane-new-1', 'stalled_output', { herdr: fakeHerdr });
  assert.equal(nudge.paneId, 'pane-new-1');
  assert.match(nudge.text, /Check your task brief/);
});

test('D3: async spawn error caught and routed to spawn_error escalation', async () => {
  const failingHerdr = {
    splitPane: async () => {
      throw new Error('pane split failed');
    },
    startAgent: async () => {},
    renamePane: async () => {},
    promptAgent: async () => {},
  };

  const plan = {
    approved: true,
    tasks: [
      { id: 'task-fail', title: 'Fail task', tier: 'fast', kind: 'docs' },
    ],
  };

  const crewConfig = {
    tiers: {
      fast: { model: 'gemini-3.8-flash', effort: 'low', tool: 'agy' },
    },
  };

  const res = await daemon.executePlan(plan, crewConfig, {
    spawn: true,
    herdr: failingHerdr,
    recordLedger: false,
  });

  assert.equal(res.dispatches.length, 1);
  assert.equal(res.dispatches[0].spawned, false);
  assert.equal(res.dispatches[0].spawnError, 'pane split failed');
  assert.equal(res.escalations.length, 1);
  assert.equal(res.escalations[0].type, 'spawn_error');
  assert.equal(res.escalations[0].reason, 'pane split failed');
});

test('D4: circuit breakers gate executePlan dispatches (pause, throttle, normal)', async () => {
  const plan = {
    approved: true,
    tasks: [
      { id: 'T1', title: 'Task 1', tier: 'fast', kind: 'docs' },
      { id: 'T2', title: 'Task 2', tier: 'fast', kind: 'docs' },
    ],
  };

  const crewConfig = {
    tiers: { fast: { model: 'gemini-3.8-flash', effort: 'low' } },
  };

  // Case 1: Pool under 15% -> PAUSE (0 dispatches)
  const resPaused = await daemon.executePlan(plan, crewConfig, {
    burnRatio: 0.50,
    poolRemainingRatio: 0.10,
    recordLedger: false,
  });
  assert.equal(resPaused.paused, true);
  assert.equal(resPaused.dispatches.length, 0);
  assert.equal(resPaused.escalations[0].type, 'circuit_breaker_pause');

  // Case 2: Burn past 80% -> THROTTLE (exactly 1 dispatch allowed)
  const resThrottled = await daemon.executePlan(plan, crewConfig, {
    burnRatio: 0.85,
    poolRemainingRatio: 0.50,
    recordLedger: false,
  });
  assert.equal(resThrottled.throttled, true);
  assert.equal(resThrottled.dispatches.length, 1);
  assert.equal(resThrottled.dispatches[0].taskId, 'T1');
  assert.equal(resThrottled.escalations.length, 1);
  assert.equal(resThrottled.escalations[0].type, 'dispatch_throttled');

  // Case 3: Normal ratios -> NORMAL (both dispatches allowed)
  const resNormal = await daemon.executePlan(plan, crewConfig, {
    burnRatio: 0.40,
    poolRemainingRatio: 0.70,
    recordLedger: false,
  });
  assert.equal(resNormal.paused, undefined);
  assert.equal(resNormal.throttled, false);
  assert.equal(resNormal.dispatches.length, 2);
  assert.equal(resNormal.escalations.length, 0);
});

test('D4: operator hold manifest written to operator-hold.json', () => {
  const opFile = path.join(tmpRoot, 'd4-operator-hold.json');
  let dState = daemon.createInitialState();

  for (let i = 1; i <= 13; i++) {
    daemon.queueEscalation(dState, { id: `esc-${i}`, severity: 'hard', reason: `event ${i}` });
  }

  const wakes = daemon.deliverWakes(dState, { operatorHoldFile: opFile });
  assert.equal(wakes.held.length, 1);
  assert.ok(fs.existsSync(opFile));
  const opManifest = JSON.parse(fs.readFileSync(opFile, 'utf8'));
  assert.equal(opManifest.type, 'operator_hold_manifest');
  assert.equal(opManifest.heldCount, 1);
});

// -----------------------------------------------------------------------------
// Step 3.2: Procedural Escalation Triggers (evaluatePane)
// -----------------------------------------------------------------------------

test('evaluatePane: loop-3x detects 3 consecutive identical failing commands', () => {
  const history = {
    commands: [
      { command: 'git status', exitCode: 0 },
      { command: 'npm test', exitCode: 1, failed: true },
      { command: 'npm test', exitCode: 1, failed: true },
      { command: 'npm test', exitCode: 1, failed: true },
    ],
  };
  const res = daemon.evaluatePane({ status: 'working' }, {}, history);
  assert.ok(res);
  assert.equal(res.trigger, 'loop-3x');
  assert.equal(res.action, 'escalate');
});

test('evaluatePane: stalled-180s detects inactivity over 180s with zero output delta', () => {
  const now = 200000;
  const row = {
    status: 'working',
    since: 0,
    lastOutputAt: 0,
    statusFor: 190000,
  };
  const history = {
    outputDelta: 0,
  };
  const res = daemon.evaluatePane(row, {}, history, now);
  assert.ok(res);
  assert.equal(res.trigger, 'stalled-180s');
  assert.equal(res.action, 'escalate');
  assert.equal(res.durationSec, 190);
});

test('evaluatePane: blocked separates safe-continue from escalate-to-honcho', () => {
  const safeRes = daemon.evaluatePane(
    { status: 'blocked', permissionPrompt: { safe: true } },
    {},
    {}
  );
  assert.ok(safeRes);
  assert.equal(safeRes.trigger, 'blocked');
  assert.equal(safeRes.subtrigger, 'safe-continue');
  assert.equal(safeRes.action, 'safe-continue');

  const escalateRes = daemon.evaluatePane(
    { status: 'blocked', screenText: 'Do you want to drop database production (y/N)?' },
    {},
    { screenText: 'Do you want to drop database production (y/N)?' }
  );
  assert.ok(escalateRes);
  assert.equal(escalateRes.trigger, 'blocked');
  assert.equal(escalateRes.subtrigger, 'escalate-to-honcho');
  assert.equal(escalateRes.action, 'escalate');
});

test('evaluatePane: context-ceiling triggers at ctx >= 85% or turn budget exceeded', () => {
  const resCtx = daemon.evaluatePane({ status: 'working', ctx: 87 }, { ctx: 87 }, {});
  assert.ok(resCtx);
  assert.equal(resCtx.trigger, 'context-ceiling');
  assert.equal(resCtx.action, 'recycle');
  assert.equal(resCtx.ctx, 87);

  const resTurns = daemon.evaluatePane({ status: 'working', ctx: 40 }, {}, { turnsExceeded: true });
  assert.ok(resTurns);
  assert.equal(resTurns.trigger, 'context-ceiling');
  assert.equal(resTurns.action, 'recycle');
});

test('evaluatePane: test-regression-2x detects two consecutive failed test runs', () => {
  const history = {
    tests: [
      { run: 1, failed: true },
      { run: 2, failed: true },
    ],
  };
  const res = daemon.evaluatePane({ status: 'working' }, {}, history);
  assert.ok(res);
  assert.equal(res.trigger, 'test-regression-2x');
  assert.equal(res.action, 'escalate');
});
